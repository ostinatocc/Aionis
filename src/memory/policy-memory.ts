import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import { buildAionisUri } from "./uri.js";
import {
  computeFeedbackUpdatedNodeState,
  type NodeFeedbackOutcome,
} from "./node-feedback-state.js";
import {
  buildPolicyEvolutionMetadata,
  buildPolicyMaintenanceMetadata,
} from "./evolution-operators.js";
import { buildPromotionEvidenceLedgerV1 } from "./promotion-evidence-ledger.js";
import {
  type ContractTrust,
  DerivedPolicySurfaceSchema,
  ExecutionNativeV1Schema,
  PolicyContractSchema,
  type DerivedPolicySurface,
  type PersistedPolicyMemory,
  type PolicyContract,
  type PolicyLearningControlApplyAction,
  type PolicyLearningControlContract,
} from "./schemas.js";
import {
  buildExecutionContractFromProjection,
} from "./execution-contract.js";
import {
  buildRuntimeAuthorityEffect,
  runtimeAuthorityGateFromValue,
  sealRuntimeAuthorityEffectReceipt,
} from "./authority-effect-broker.js";
import { assertAuthorityWriteReceipts } from "./authority-write-guard.js";
import { resolveNodeLifecycleSignals } from "./lifecycle-signals.js";
import {
  resolveNodeErrorSignature,
  resolveNodeExecutionContract,
  resolveNodeFilePath,
  resolveNodePolicyMemoryState,
  resolveNodeTargetFiles,
  resolveNodeTaskSignature,
  resolveNodeWorkflowSignature,
} from "./node-execution-surface.js";
import {
  completeLiteInlineEmbeddings,
  persistLitePreparedWrite,
  type LiteProjectedWriteStore,
} from "./lite-projected-write-commit.js";
import { applyPreparedMemoryWrite, prepareMemoryWrite, type PreparedWrite } from "./write.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { WriteStoreAccess } from "../store/write-access.js";

export type ExistingPolicyMemoryNode = {
  id: string;
  client_id: string | null;
  title: string | null;
  text_summary: string | null;
  slots: Record<string, unknown>;
  tier: string | null;
  salience: number;
  importance: number;
  confidence: number;
};

type PolicyMemoryLifecycleState = "active" | "contested" | "retired";

export type WritePolicyMemorySnapshotArgs = {
  tenant_id: string;
  scope: string;
  actor: string;
  input_text?: string | null;
  input_sha256: string;
  task_signature?: string | null;
  error_signature?: string | null;
  workflow_signature?: string | null;
  policy_contract: PolicyContract;
  derived_policy: DerivedPolicySurface;
  feedback_commit_id: string;
};

type WritePolicyMemorySnapshotOptions = {
  defaultScope: string;
  defaultTenantId: string;
  maxTextLen: number;
  piiRedaction: boolean;
  allowCrossScopeEdges?: boolean;
  embedder: EmbeddingProvider | null;
  writeAccess: WriteStoreAccess;
  liteWriteStore?: LiteWriteStore | null;
};

export type PolicyMemorySnapshotWriteResult = {
  node_id: string;
  client_id: string;
  policy_memory_signature: string;
  policy_contract: PolicyContract;
};

export type PreparedPolicyMemorySnapshot = {
  scope: string;
  feedback_commit_id: string;
  expected_existing_sha256: string | null;
  update: {
    id: string;
    client_id: string | null;
    slots: Record<string, unknown>;
    text_summary: string;
    salience: number;
    importance: number;
    confidence: number;
  } | null;
  prepared_write: PreparedWrite | null;
  prospective_node: ExistingPolicyMemoryNode;
  result: PolicyMemorySnapshotWriteResult;
};

export type PreparedPolicyMemoryFeedback = {
  scope: string;
  commit_id: string;
  expected_nodes: Array<{ id: string; sha256: string }>;
  updates: Array<{
    id: string;
    client_id: string | null;
    slots: Record<string, unknown>;
    text_summary: string;
    salience: number;
    importance: number;
    confidence: number;
  }>;
  result: PolicyMemoryFeedbackUpdateResult | null;
};

export type PolicyMemoryFeedbackUpdateArgs = {
  tenant_id: string;
  scope: string;
  selected_tool: string;
  task_signature?: string | null;
  error_signature?: string | null;
  workflow_signature?: string | null;
  outcome: NodeFeedbackOutcome;
  run_id?: string | null;
  reason?: string | null;
  input_sha256: string;
  commit_id: string;
  feedback_at: string;
};

export type PolicyMemoryFeedbackUpdateResult = PersistedPolicyMemory;

export type PolicyMemoryLearningControlApplyArgs = {
  tenant_id: string;
  scope: string;
  policy_memory_id: string;
  action: PolicyLearningControlApplyAction;
  actor?: string | null;
  reason?: string | null;
  learning_control_contract?: PolicyLearningControlContract | null;
  live_policy_contract?: PolicyContract | null;
  live_derived_policy?: DerivedPolicySurface | null;
  applied_at?: string | null;
  commit_id?: string | null;
};

export type PolicyMemoryLearningControlApplyResult = {
  policy_memory: PolicyMemoryFeedbackUpdateResult;
  previous_state: PolicyMemoryLifecycleState;
  next_state: PolicyMemoryLifecycleState;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function sealPolicyAuthoritySlots(args: {
  scope: string;
  id: string;
  clientId: string | null;
  slots: Record<string, unknown>;
  issuedAt?: string | null;
}): Record<string, unknown> {
  const sealed = { ...args.slots };
  const authorityGate = runtimeAuthorityGateFromValue(sealed.authority_gate_v1);
  if (authorityGate) {
    sealRuntimeAuthorityEffectReceipt({
      effectKind: "policy_memory_authority",
      node: {
        id: args.id,
        client_id: args.clientId ?? undefined,
        scope: args.scope,
        type: "concept",
        slots: sealed,
      },
      slots: sealed,
      authorityGate,
      issuedAt: firstString(args.issuedAt) ?? undefined,
      mutate: true,
    });
  }
  assertAuthorityWriteReceipts([{
    id: args.id,
    client_id: args.clientId ?? undefined,
    scope: args.scope,
    type: "concept",
    slots: sealed,
  }]);
  return sealed;
}

function normalizeContractTrust(value: unknown): ContractTrust | null {
  return value === "authoritative" || value === "advisory" || value === "observational"
    ? value
    : null;
}

function stringList(value: unknown, limit = 16): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const next = typeof item === "string" ? item.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function asNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return 0;
  return Math.max(0, Number(trimmed));
}

function asFeedbackQuality(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(-1, Math.min(1, value));
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(trimmed)) return 0;
  return Math.max(-1, Math.min(1, Number(trimmed)));
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function buildPolicyMemorySignature(args: {
  taskSignature: string | null;
  errorSignature: string | null;
  workflowSignature: string | null;
  selectedTool: string;
  filePath: string | null;
  targetFiles: string[];
}): string {
  return sha256Hex(
    stableStringify({
      schema: "policy_memory_v1",
      task_signature: args.taskSignature,
      error_signature: args.errorSignature,
      workflow_signature: args.workflowSignature,
      selected_tool: args.selectedTool,
      file_path: args.filePath,
      target_files: args.targetFiles,
    }),
  );
}

function buildPolicyMemoryTitle(args: {
  selectedTool: string;
  taskSignature: string | null;
  workflowSignature: string | null;
  filePath: string | null;
}): string {
  const cue = firstString(args.taskSignature, args.workflowSignature, args.filePath);
  if (!cue) return truncate(`Policy memory: default to ${args.selectedTool}`, 180);
  return truncate(`Policy memory: default to ${args.selectedTool} for ${cue}`, 180);
}

function buildPolicyMemorySummary(args: {
  contract: PolicyContract;
  taskSignature: string | null;
  errorSignature: string | null;
}): string {
  const scopeCue =
    firstString(args.taskSignature, args.contract.workflow_signature, args.contract.file_path, args.errorSignature)
    ?? args.contract.selected_tool;
  const targetText =
    args.contract.file_path
      ? ` on ${args.contract.file_path}`
      : args.contract.target_files.length > 0
        ? ` on ${args.contract.target_files.join(", ")}`
        : "";
  const activationText = args.contract.activation_mode === "default" ? "Default" : "Hint";
  const lifecycleText =
    args.contract.policy_memory_state === "retired"
      ? "Retired"
      : args.contract.policy_memory_state === "contested"
        ? "Contested"
        : activationText;
  return truncate(
    `${lifecycleText} policy memory: prefer ${args.contract.selected_tool}${targetText} for ${scopeCue}. ${args.contract.reason}`,
    400,
  );
}

function buildPolicyExecutionNative(args: {
  taskSignature: string | null;
  errorSignature: string | null;
  workflowSignature: string | null;
  contract: PolicyContract;
  at: string;
  source: "materialization" | "feedback" | "learning_control";
  learningControlAction?: PolicyLearningControlApplyAction | null;
}): Record<string, unknown> {
  return ExecutionNativeV1Schema.parse({
    schema_version: "execution_native_v1",
    execution_kind: "execution_native",
    summary_kind: "policy_memory",
    compression_layer: "L4",
    selected_tool: args.contract.selected_tool,
    ...(args.taskSignature ? { task_signature: args.taskSignature } : {}),
    ...(args.errorSignature ? { error_signature: args.errorSignature } : {}),
    ...(args.workflowSignature ? { workflow_signature: args.workflowSignature } : {}),
    ...(args.contract.outcome_contract_gate ? { outcome_contract_gate: args.contract.outcome_contract_gate } : {}),
    maintenance: buildPolicyMaintenanceMetadata({
      policy_memory_state: args.contract.policy_memory_state,
      activation_mode: args.contract.activation_mode,
      at: args.at,
      learning_control_action: args.learningControlAction ?? null,
    }),
    policy_evolution: buildPolicyEvolutionMetadata({
      policy_source_kind: args.contract.source_kind,
      policy_state: args.contract.policy_state,
      policy_memory_state: args.contract.policy_memory_state,
      activation_mode: args.contract.activation_mode,
      materialization_state: "persisted",
      source_anchor_count: args.contract.source_anchor_ids.length,
      at: args.at,
      source: args.source,
      learning_control_action: args.learningControlAction ?? null,
    }),
  });
}

function buildPolicyExecutionContract(args: {
  nodeId?: string | null;
  taskSignature: string | null;
  errorSignature: string | null;
  workflowSignature: string | null;
  contract: PolicyContract;
  source: "materialization" | "feedback" | "learning_control";
  learningControlAction?: PolicyLearningControlApplyAction | null;
}): Record<string, unknown> {
  const notes = [
    args.contract.reason,
    `policy_memory_source:${args.source}`,
    args.errorSignature ? `error_signature:${args.errorSignature}` : null,
    args.learningControlAction ? `learning_control_action:${args.learningControlAction}` : null,
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return buildExecutionContractFromProjection({
    contract_trust: args.contract.contract_trust ?? null,
    task_family: args.contract.task_family ?? null,
    task_signature: args.taskSignature,
    workflow_signature: args.workflowSignature,
    policy_memory_id: args.nodeId ?? null,
    selected_tool: args.contract.selected_tool,
    file_path: args.contract.file_path,
    target_files: args.contract.target_files,
    next_action: args.contract.next_action,
    workflow_steps: args.contract.workflow_steps,
    pattern_hints: args.contract.pattern_hints,
    service_lifecycle_constraints: args.contract.service_lifecycle_constraints,
    acceptance_checks: args.contract.acceptance_checks,
    success_invariants: args.contract.success_invariants,
    dependency_requirements: args.contract.dependency_requirements,
    environment_assumptions: args.contract.environment_assumptions,
    must_hold_after_exit: args.contract.must_hold_after_exit,
    external_visibility_requirements: args.contract.external_visibility_requirements,
    provenance: {
      source_kind: "policy_contract",
      source_summary_version: args.contract.summary_version,
      source_anchor: args.nodeId ?? null,
      evidence_refs: args.contract.source_anchor_ids,
      notes,
    },
  });
}

function buildPolicyAuthoritySurfaces(args: {
  contract: PolicyContract;
  executionContract: Record<string, unknown>;
}) {
  const authority = buildRuntimeAuthorityEffect({
    effectKind: "policy_memory_authority",
    executionContract: args.executionContract,
    requestedTrust: normalizeContractTrust(args.contract.contract_trust),
    slots: args.contract as unknown as Record<string, unknown>,
  });
  return {
    ...authority.slotsPatch,
  };
}

function buildPolicyMemorySlots(args: {
  taskSignature: string | null;
  errorSignature: string | null;
  workflowSignature: string | null;
  policyMemorySignature: string;
  contract: PolicyContract;
  derivedPolicy: DerivedPolicySurface;
  transitionAt: string;
  source: "materialization" | "feedback" | "learning_control";
  learningControlAction?: PolicyLearningControlApplyAction | null;
}): Record<string, unknown> {
  const executionNative = buildPolicyExecutionNative({
    taskSignature: args.taskSignature,
    errorSignature: args.errorSignature,
    workflowSignature: args.workflowSignature,
    contract: args.contract,
    at: args.transitionAt,
    source: args.source,
    learningControlAction: args.learningControlAction ?? null,
  });
  const executionContract = buildPolicyExecutionContract({
    nodeId: null,
    taskSignature: args.taskSignature,
    errorSignature: args.errorSignature,
    workflowSignature: args.workflowSignature,
    contract: args.contract,
    source: args.source,
    learningControlAction: args.learningControlAction ?? null,
  });
  const authoritySurfaces = buildPolicyAuthoritySurfaces({
    contract: args.contract,
    executionContract,
  });
  const authorityGate = authoritySurfaces.authority_gate_v1 as Record<string, unknown> | undefined;
  const evidenceAssessment = authoritySurfaces.execution_evidence_assessment as Record<string, unknown> | undefined;
  const promotionEvidenceLedger = buildPromotionEvidenceLedgerV1({
    targetKind: "policy",
    targetId: args.policyMemorySignature,
    sourceLayers: ["L3"],
    targetLayer: "L4",
    transition: "L3_to_L4",
    promotionState: args.contract.policy_memory_state,
    promotionOrigin: args.source,
    observedCount: args.contract.source_anchor_ids.length,
    requiredCount: args.contract.policy_memory_state === "active" ? 1 : 0,
    authorityGateAdmitted: typeof authorityGate?.allows_authoritative === "boolean"
      ? authorityGate.allows_authoritative
      : null,
    learningControlAdmitted: args.source === "learning_control" ? true : null,
    verifierStatus: typeof evidenceAssessment?.status === "string"
      && ["succeeded", "failed", "incomplete", "unknown"].includes(evidenceAssessment.status)
      ? evidenceAssessment.status as "succeeded" | "failed" | "incomplete" | "unknown"
      : null,
    contractTrust: args.contract.contract_trust ?? null,
    sourceNodeIds: args.contract.source_anchor_ids,
    promotionEvidenceRefs: args.contract.source_anchor_ids,
    counterEvidenceRefs: args.contract.policy_memory_state === "contested" || args.contract.policy_memory_state === "retired"
      ? args.contract.source_anchor_ids
      : [],
    reasonCodes: [
      `policy_memory_${args.source}`,
      `policy_memory_state_${args.contract.policy_memory_state}`,
      `policy_source_${args.contract.source_kind}`,
    ],
    evidence: [
      {
        evidence_id: `${args.policyMemorySignature}:source_anchors`,
        evidence_kind: "source_anchor",
        polarity: args.contract.policy_memory_state === "active" ? "positive" : "neutral",
        source_ref: args.contract.source_anchor_ids[0] ?? args.policyMemorySignature,
        claim: `${args.contract.source_anchor_ids.length} source anchors support policy memory`,
        confidence: args.contract.policy_memory_state === "active" ? 0.76 : 0.54,
      },
      {
        evidence_id: `${args.policyMemorySignature}:authority_gate`,
        evidence_kind: "authority_gate",
        polarity: authorityGate?.allows_authoritative === true ? "positive" : "neutral",
        source_ref: `${args.policyMemorySignature}:authority_gate_v1`,
        claim: authorityGate?.allows_authoritative === true
          ? "authority gate admits policy memory as authoritative"
          : "policy memory remains non-authoritative or advisory",
        confidence: authorityGate?.allows_authoritative === true ? 0.78 : 0.52,
      },
      ...(args.source === "learning_control"
        ? [{
            evidence_id: `${args.policyMemorySignature}:learning_control`,
            evidence_kind: "learning_control" as const,
            polarity: "positive" as const,
            source_ref: `${args.policyMemorySignature}:learning_control`,
            claim: "learning control committed policy memory lifecycle transition",
            confidence: 0.78,
          }]
        : []),
    ],
  });
  const executionNativeWithPromotionLedger = ExecutionNativeV1Schema.parse({
    ...executionNative,
    promotion_evidence_ledger_v1: promotionEvidenceLedger,
  });

  return {
    summary_kind: "policy_memory",
    compression_layer: "L4",
    materialization_state: "persisted",
    policy_memory_state: args.contract.policy_memory_state,
    last_materialized_at: args.transitionAt,
    policy_memory_signature: args.policyMemorySignature,
    task_signature: args.taskSignature,
    error_signature: args.errorSignature,
    workflow_signature: args.workflowSignature,
    selected_tool: args.contract.selected_tool,
    file_path: args.contract.file_path,
    target_files: args.contract.target_files,
    source_anchor_ids: args.contract.source_anchor_ids,
    execution_contract_v1: executionContract,
    ...authoritySurfaces,
    promotion_evidence_ledger_v1: promotionEvidenceLedger,
    policy_contract_v1: {
      ...args.contract,
      policy_memory_state: args.contract.policy_memory_state,
      materialization_state: "persisted",
      policy_memory_id: null,
    },
    derived_policy_v1: args.derivedPolicy,
    execution_native_v1: executionNativeWithPromotionLedger,
  };
}

async function findExistingPolicyMemoryLite(
  liteWriteStore: Pick<LiteWriteStore, "findNodes">,
  scope: string,
  clientId: string,
): Promise<ExistingPolicyMemoryNode | null> {
  const { rows } = await liteWriteStore.findNodes({
    scope,
    type: "concept",
    clientId,
    limit: 1,
    offset: 0,
  });
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    client_id: row.client_id,
    title: row.title,
    text_summary: row.text_summary,
    slots: row.slots,
    tier: row.tier,
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
  };
}

function existingPolicyMemorySha256(node: ExistingPolicyMemoryNode | null): string | null {
  return node ? sha256Hex(stableStringify(node)) : null;
}

async function loadPolicyMemoryNodeLite(
  liteWriteStore: Pick<LiteWriteStore, "findNodes">,
  args: { scope: string; id: string },
): Promise<ExistingPolicyMemoryNode> {
  const { rows } = await liteWriteStore.findNodes({
    scope: args.scope,
    id: args.id,
    type: "concept",
    limit: 1,
    offset: 0,
  });
  const row = rows[0];
  if (!row) {
    throw new HttpError(404, "policy_memory_not_found", "policy memory node not found", {
      policy_memory_id: args.id,
    });
  }
  const slots = asRecord(row.slots) ?? {};
  if (firstString(slots.summary_kind) !== "policy_memory") {
    throw new HttpError(400, "policy_memory_required", "target node is not a policy memory node", {
      policy_memory_id: args.id,
      summary_kind: firstString(slots.summary_kind),
    });
  }
  return {
    id: row.id,
    client_id: row.client_id,
    title: row.title,
    text_summary: row.text_summary,
    slots,
    tier: row.tier,
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
  };
}

async function listPolicyMemoryLite(
  liteWriteStore: Pick<LiteWriteStore, "findNodes">,
  scope: string,
  selectedTool: string,
): Promise<ExistingPolicyMemoryNode[]> {
  const { rows } = await liteWriteStore.findNodes({
    scope,
    type: "concept",
    limit: 32,
    offset: 0,
    slotsContains: {
      summary_kind: "policy_memory",
      selected_tool: selectedTool,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    client_id: row.client_id,
    title: row.title,
    text_summary: row.text_summary,
    slots: row.slots,
    tier: row.tier,
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
  }));
}

async function updateExistingPolicyMemoryLite(
  liteWriteStore: Pick<LiteWriteStore, "updateNodeAnchorState">,
  args: {
    scope: string;
    id: string;
    clientId?: string | null;
    slots: Record<string, unknown>;
    textSummary: string;
    salience: number;
    importance: number;
    confidence: number;
    commitId: string | null;
  },
): Promise<void> {
  const slots = sealPolicyAuthoritySlots({
    scope: args.scope,
    id: args.id,
    clientId: args.clientId ?? null,
    slots: args.slots,
  });
  await liteWriteStore.updateNodeAnchorState({
    scope: args.scope,
    id: args.id,
    slots,
    textSummary: args.textSummary,
    salience: args.salience,
    importance: args.importance,
    confidence: args.confidence,
    commitId: args.commitId,
  });
}

function derivePolicyMemoryStateFromSlots(slots: Record<string, unknown> | null | undefined): PolicyMemoryLifecycleState {
  const explicitState = resolveNodePolicyMemoryState(slots);
  if (explicitState) return explicitState;
  const positiveCount = asNonNegativeInt(slots?.feedback_positive);
  const negativeCount = asNonNegativeInt(slots?.feedback_negative);
  const feedbackQuality = asFeedbackQuality(slots?.feedback_quality);
  if (negativeCount >= Math.max(2, positiveCount + 1) || feedbackQuality <= -0.45) return "retired";
  if (negativeCount > positiveCount || (negativeCount > 0 && feedbackQuality < 0.2)) return "contested";
  return "active";
}

function normalizePersistedPolicyLifecycleState(args: {
  requestedState: PolicyMemoryLifecycleState;
  contractTrust: ContractTrust | null;
  outcomeAllowsAuthoritative: boolean;
}): PolicyMemoryLifecycleState {
  if (args.requestedState === "retired") return "retired";
  if (args.requestedState === "contested") return "contested";
  return args.contractTrust === "authoritative" && args.outcomeAllowsAuthoritative ? "active" : "contested";
}

function parseStoredPolicyContract(value: unknown, nodeId: string): PolicyContract | null {
  const parsed = PolicyContractSchema.safeParse({
    ...(asRecord(value) ?? {}),
    materialization_state: "persisted",
    policy_memory_id: nodeId,
  });
  return parsed.success ? parsed.data : null;
}

function parseStoredDerivedPolicy(value: unknown): DerivedPolicySurface | null {
  const parsed = DerivedPolicySurfaceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizePolicyContractLifecycle(args: {
  contract: PolicyContract;
  nodeId: string | null;
  nextState: PolicyMemoryLifecycleState;
}): PolicyContract {
  const executionContract = buildPolicyExecutionContract({
    nodeId: args.nodeId,
    taskSignature: null,
    errorSignature: null,
    workflowSignature: firstString(args.contract.workflow_signature),
    contract: args.contract,
    source: "materialization",
  });
  const authority = buildRuntimeAuthorityEffect({
    effectKind: "policy_memory_authority",
    executionContract,
    requestedTrust: normalizeContractTrust(args.contract.contract_trust),
    slots: args.contract as unknown as Record<string, unknown>,
  });
  const effectiveState = normalizePersistedPolicyLifecycleState({
    requestedState: args.nextState,
    contractTrust: normalizeContractTrust(args.contract.contract_trust),
    outcomeAllowsAuthoritative: authority.authorityGate.allows_authoritative,
  });
  const shouldDegrade = effectiveState !== "active";
  return PolicyContractSchema.parse({
    ...args.contract,
    contract_trust: shouldDegrade && args.contract.contract_trust === "authoritative"
      ? "advisory"
      : args.contract.contract_trust,
    policy_state: shouldDegrade ? "candidate" : args.contract.policy_state,
    policy_memory_state: effectiveState,
    activation_mode: shouldDegrade ? "hint" : args.contract.activation_mode,
    materialization_state: "persisted",
    policy_memory_id: args.nodeId ?? null,
    ...authority.slotsPatch,
  });
}

function formatPolicyMemoryFeedbackResult(args: {
  tenantId: string;
  scope: string;
  node: ExistingPolicyMemoryNode;
  contract: PolicyContract;
  slots: Record<string, unknown>;
}): PolicyMemoryFeedbackUpdateResult {
  const targetFiles = resolveNodeTargetFiles({ slots: args.slots });
  const filePath = resolveNodeFilePath({ slots: args.slots })
    ?? firstString(args.contract.file_path, targetFiles[0] ?? null);
  const policyMemorySignature = firstString(args.slots.policy_memory_signature)
    ?? buildPolicyMemorySignature({
      taskSignature: resolveNodeTaskSignature({ slots: args.slots }),
      errorSignature: resolveNodeErrorSignature(args.slots),
      workflowSignature: resolveNodeWorkflowSignature({ slots: args.slots })
        ?? firstString(args.contract.workflow_signature),
      selectedTool: args.contract.selected_tool,
      filePath,
      targetFiles,
    });
  return {
    node_id: args.node.id,
    node_uri: buildAionisUri({
      tenant_id: args.tenantId,
      scope: args.scope,
      type: "concept",
      id: args.node.id,
    }),
    client_id: firstString(args.node.client_id) ?? `policy-memory:${policyMemorySignature}`,
    policy_memory_signature: policyMemorySignature,
    selected_tool: args.contract.selected_tool,
    policy_state: args.contract.policy_state,
    policy_memory_state: args.contract.policy_memory_state,
    activation_mode: args.contract.activation_mode,
    policy_contract: args.contract,
    promotion_evidence_ledger_v1: args.slots.promotion_evidence_ledger_v1,
  };
}

function scorePolicyMemoryMatch(
  node: ExistingPolicyMemoryNode,
  target: {
    selectedTool: string;
    taskSignature: string | null;
    errorSignature: string | null;
    workflowSignature: string | null;
  },
): number {
  const slots = asRecord(node.slots);
  const contract = asRecord(slots?.policy_contract_v1);
  const executionContract = resolveNodeExecutionContract({ slots });
  const selectedTool = firstString(executionContract?.selected_tool, slots?.selected_tool, contract?.selected_tool);
  if (selectedTool !== target.selectedTool) return -1;

  let matched = 0;
  let score = 0;
  const taskSignature = resolveNodeTaskSignature({ slots });
  const errorSignature = resolveNodeErrorSignature(slots);
  const workflowSignature = resolveNodeWorkflowSignature({ slots })
    ?? firstString(contract?.workflow_signature);

  if (target.workflowSignature && workflowSignature === target.workflowSignature) {
    matched += 1;
    score += 70;
  }
  if (target.taskSignature && taskSignature === target.taskSignature) {
    matched += 1;
    score += 45;
  }
  if (target.errorSignature && errorSignature === target.errorSignature) {
    matched += 1;
    score += 30;
  }

  return matched > 0 ? score : -1;
}

async function applyPolicyMemoryFeedbackToNodes(args: {
  tenantId: string;
  scope: string;
  nodes: ExistingPolicyMemoryNode[];
  outcome: NodeFeedbackOutcome;
  runId: string | null;
  reason: string | null;
  inputSha256: string;
  feedbackAt: string;
  updateNode: (node: ExistingPolicyMemoryNode, next: {
    slots: Record<string, unknown>;
    textSummary: string;
    salience: number;
    importance: number;
    confidence: number;
  }) => Promise<void>;
}): Promise<PolicyMemoryFeedbackUpdateResult | null> {
  let best: PolicyMemoryFeedbackUpdateResult | null = null;
  for (const node of args.nodes) {
    const slots = asRecord(node.slots) ?? {};
    const currentExecutionContract = resolveNodeExecutionContract({ slots });
    const currentContract = parseStoredPolicyContract(slots.policy_contract_v1, node.id);
    if (!currentContract) continue;
    const derivedPolicy = parseStoredDerivedPolicy(slots.derived_policy_v1);
    const nextState = computeFeedbackUpdatedNodeState({
      node: {
        id: node.id,
        type: "concept",
        title: node.title,
        text_summary: node.text_summary,
        slots,
        salience: node.salience,
        importance: node.importance,
        confidence: node.confidence,
      },
      feedback: {
        outcome: args.outcome,
        run_id: args.runId,
        reason: args.reason,
        input_sha256: args.inputSha256,
        source: "tools_feedback",
        timestamp: args.feedbackAt,
      },
    });
    const lifecycleState = derivePolicyMemoryStateFromSlots(nextState.slots);
    const nextContract = normalizePolicyContractLifecycle({
      contract: currentContract,
      nodeId: node.id,
      nextState: lifecycleState,
    });
    const taskSignature = resolveNodeTaskSignature({ slots: nextState.slots })
      ?? firstString(currentExecutionContract?.task_signature, slots.task_signature);
    const errorSignature = resolveNodeErrorSignature(nextState.slots)
      ?? firstString(slots.error_signature);
    const workflowSignature = firstString(
      nextContract.workflow_signature,
      resolveNodeWorkflowSignature({ slots: nextState.slots }),
      currentExecutionContract?.workflow_signature,
      slots.workflow_signature,
    );
    const nextExecutionNative = buildPolicyExecutionNative({
      taskSignature,
      errorSignature,
      workflowSignature,
      contract: nextContract,
      at: args.feedbackAt,
      source: "feedback",
    });
    const nextExecutionContract = buildPolicyExecutionContract({
      nodeId: node.id,
      taskSignature,
      errorSignature,
      workflowSignature,
      contract: nextContract,
      source: "feedback",
    });
    const authoritySurfaces = buildPolicyAuthoritySurfaces({
      contract: nextContract,
      executionContract: nextExecutionContract,
    });
    const authorityGate = authoritySurfaces.authority_gate_v1 as Record<string, unknown> | undefined;
    const evidenceAssessment = authoritySurfaces.execution_evidence_assessment as Record<string, unknown> | undefined;
    const policyMemorySignature = firstString(slots.policy_memory_signature) ?? node.id;
    const promotionEvidenceLedger = buildPromotionEvidenceLedgerV1({
      targetKind: "policy",
      targetId: node.id,
      sourceLayers: ["L3"],
      targetLayer: "L4",
      transition: "L3_to_L4",
      promotionState: nextContract.policy_memory_state,
      promotionOrigin: "feedback",
      observedCount: nextContract.source_anchor_ids.length,
      requiredCount: nextContract.policy_memory_state === "active" ? 1 : 0,
      authorityGateAdmitted: typeof authorityGate?.allows_authoritative === "boolean"
        ? authorityGate.allows_authoritative
        : null,
      learningControlAdmitted: null,
      verifierStatus: typeof evidenceAssessment?.status === "string"
        && ["succeeded", "failed", "incomplete", "unknown"].includes(evidenceAssessment.status)
        ? evidenceAssessment.status as "succeeded" | "failed" | "incomplete" | "unknown"
        : null,
      contractTrust: nextContract.contract_trust ?? null,
      sourceNodeIds: nextContract.source_anchor_ids,
      sourceRunIds: [args.runId],
      promotionEvidenceRefs: args.outcome === "positive" ? nextContract.source_anchor_ids : [],
      counterEvidenceRefs: args.outcome === "negative" ? [node.id] : [],
      reasonCodes: [
        `policy_feedback_${args.outcome}`,
        `policy_memory_state_${nextContract.policy_memory_state}`,
      ],
      evidence: [
        {
          evidence_id: `${policyMemorySignature}:feedback`,
          evidence_kind: args.outcome === "negative" ? "counter_evidence" : "operator_feedback",
          polarity: args.outcome === "negative" ? "negative" : "positive",
          source_ref: args.inputSha256,
          claim: `${args.outcome} feedback updated policy memory lifecycle evidence`,
          confidence: args.outcome === "negative" ? 0.78 : 0.7,
        },
        {
          evidence_id: `${policyMemorySignature}:source_anchors`,
          evidence_kind: "source_anchor",
          polarity: nextContract.source_anchor_ids.length > 0 ? "positive" : "neutral",
          source_ref: nextContract.source_anchor_ids[0] ?? node.id,
          claim: `${nextContract.source_anchor_ids.length} source anchors remain linked to policy memory`,
          confidence: nextContract.source_anchor_ids.length > 0 ? 0.72 : 0.48,
        },
      ],
    });
    const nextExecutionNativeWithPromotionLedger = ExecutionNativeV1Schema.parse({
      ...nextExecutionNative,
      promotion_evidence_ledger_v1: promotionEvidenceLedger,
    });
    const nextSlots: Record<string, unknown> = {
      ...nextState.slots,
      summary_kind: "policy_memory",
      compression_layer: "L4",
      materialization_state: "persisted",
      policy_memory_state: nextContract.policy_memory_state,
      policy_contract_v1: nextContract,
      selected_tool: nextContract.selected_tool,
      workflow_signature: workflowSignature,
      task_signature: taskSignature,
      error_signature: errorSignature,
      file_path: firstString(slots.file_path, nextContract.file_path),
      target_files: nextContract.target_files,
      source_anchor_ids: nextContract.source_anchor_ids,
      execution_contract_v1: nextExecutionContract,
      ...authoritySurfaces,
      promotion_evidence_ledger_v1: promotionEvidenceLedger,
      policy_memory_signature: firstString(slots.policy_memory_signature),
      last_materialized_at: firstString(slots.last_materialized_at),
      execution_native_v1: nextExecutionNativeWithPromotionLedger,
      ...(derivedPolicy ? { derived_policy_v1: derivedPolicy } : {}),
    };
    const nextSummary = buildPolicyMemorySummary({
      contract: nextContract,
      taskSignature: firstString(nextSlots.task_signature),
      errorSignature: firstString(nextSlots.error_signature),
    });
    const lifecycle = resolveNodeLifecycleSignals({
      type: "concept",
      tier: node.tier,
      title: node.title,
      text_summary: nextSummary,
      slots: nextSlots,
      salience: nextState.salience,
      importance: nextState.importance,
      confidence: nextState.confidence,
      reference_time: args.feedbackAt,
    });
    await args.updateNode(node, {
      slots: lifecycle.slots,
      textSummary: nextSummary,
      salience: lifecycle.salience,
      importance: lifecycle.importance,
      confidence: lifecycle.confidence,
    });
    const formatted = formatPolicyMemoryFeedbackResult({
      tenantId: args.tenantId,
      scope: args.scope,
      node,
      contract: nextContract,
      slots: lifecycle.slots,
    });
    if (!best || (best.policy_memory_state !== "active" && formatted.policy_memory_state === "active")) best = formatted;
  }
  return best;
}

export async function applyPolicyMemoryFeedbackLite(
  liteWriteStore: Pick<LiteWriteStore, "findNodes" | "updateNodeAnchorState">,
  args: PolicyMemoryFeedbackUpdateArgs,
): Promise<PolicyMemoryFeedbackUpdateResult | null> {
  const matched = (await listPolicyMemoryLite(liteWriteStore, args.scope, args.selected_tool))
    .map((node) => ({
      node,
      score: scorePolicyMemoryMatch(node, {
        selectedTool: args.selected_tool,
        taskSignature: firstString(args.task_signature),
        errorSignature: firstString(args.error_signature),
        workflowSignature: firstString(args.workflow_signature),
      }),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.node);
  if (matched.length === 0) return null;
  return applyPolicyMemoryFeedbackToNodes({
    tenantId: args.tenant_id,
    scope: args.scope,
    nodes: matched,
    outcome: args.outcome,
    runId: args.run_id ?? null,
    reason: args.reason ?? null,
    inputSha256: args.input_sha256,
    feedbackAt: args.feedback_at,
    updateNode: (node, next) => updateExistingPolicyMemoryLite(liteWriteStore, {
      scope: args.scope,
      id: node.id,
      clientId: node.client_id,
      slots: next.slots,
      textSummary: next.textSummary,
      salience: next.salience,
      importance: next.importance,
      confidence: next.confidence,
      commitId: args.commit_id,
    }),
  });
}

export async function preparePolicyMemoryFeedbackLite(
  liteWriteStore: Pick<LiteWriteStore, "findNodes">,
  args: PolicyMemoryFeedbackUpdateArgs,
  options: { materialized_snapshot?: PreparedPolicyMemorySnapshot | null } = {},
): Promise<PreparedPolicyMemoryFeedback> {
  const storedNodes = await listPolicyMemoryLite(liteWriteStore, args.scope, args.selected_tool);
  const prospectiveNode = options.materialized_snapshot?.prospective_node ?? null;
  const nodes = prospectiveNode
    ? [
        ...storedNodes.filter((node) => (
          node.id !== prospectiveNode.id
          && (!prospectiveNode.client_id || node.client_id !== prospectiveNode.client_id)
        )),
        prospectiveNode,
      ]
    : storedNodes;
  const matched = nodes
    .map((node) => ({
      node,
      score: scorePolicyMemoryMatch(node, {
        selectedTool: args.selected_tool,
        taskSignature: firstString(args.task_signature),
        errorSignature: firstString(args.error_signature),
        workflowSignature: firstString(args.workflow_signature),
      }),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.node);
  const updates: PreparedPolicyMemoryFeedback["updates"] = [];
  const result = matched.length === 0
    ? null
    : await applyPolicyMemoryFeedbackToNodes({
        tenantId: args.tenant_id,
        scope: args.scope,
        nodes: matched,
        outcome: args.outcome,
        runId: args.run_id ?? null,
        reason: args.reason ?? null,
        inputSha256: args.input_sha256,
        feedbackAt: args.feedback_at,
        updateNode: async (node, next) => {
          updates.push({
            id: node.id,
            client_id: node.client_id,
            slots: next.slots,
            text_summary: next.textSummary,
            salience: next.salience,
            importance: next.importance,
            confidence: next.confidence,
          });
        },
      });
  const prospectiveId = prospectiveNode?.id ?? null;
  const matchedIds = new Set(matched.map((node) => node.id));
  return {
    scope: args.scope,
    commit_id: args.commit_id,
    expected_nodes: storedNodes
      .filter((node) => matchedIds.has(node.id) && node.id !== prospectiveId)
      .map((node) => ({ id: node.id, sha256: existingPolicyMemorySha256(node)! })),
    updates,
    result,
  };
}

export async function persistPreparedPolicyMemoryFeedback(
  prepared: PreparedPolicyMemoryFeedback,
  liteWriteStore: Pick<LiteWriteStore, "findNodes" | "updateNodeAnchorState">,
): Promise<PolicyMemoryFeedbackUpdateResult | null> {
  for (const expected of prepared.expected_nodes) {
    const { rows } = await liteWriteStore.findNodes({
      scope: prepared.scope,
      id: expected.id,
      type: "concept",
      limit: 1,
      offset: 0,
    });
    const row = rows[0];
    const current: ExistingPolicyMemoryNode | null = row
      ? {
          id: row.id,
          client_id: row.client_id,
          title: row.title,
          text_summary: row.text_summary,
          slots: row.slots,
          tier: row.tier,
          salience: row.salience,
          importance: row.importance,
          confidence: row.confidence,
        }
      : null;
    if (existingPolicyMemorySha256(current) !== expected.sha256) {
      throw new Error("policy_memory_feedback_prepare_conflict");
    }
  }
  for (const update of prepared.updates) {
    await updateExistingPolicyMemoryLite(liteWriteStore, {
      scope: prepared.scope,
      id: update.id,
      clientId: update.client_id,
      slots: update.slots,
      textSummary: update.text_summary,
      salience: update.salience,
      importance: update.importance,
      confidence: update.confidence,
      commitId: prepared.commit_id,
    });
  }
  return prepared.result;
}

function requireMatchingLivePolicyContract(args: {
  action: PolicyLearningControlApplyAction;
  nodeId: string;
  currentContract: PolicyContract;
  livePolicyContract: PolicyContract | null | undefined;
}): PolicyContract {
  const liveContract = args.livePolicyContract ?? null;
  if (!liveContract) {
    throw new HttpError(
      409,
      "policy_learning_control_live_policy_required",
      `policy ${args.action} requires a matching live policy contract`,
      {
        policy_memory_id: args.nodeId,
        action: args.action,
      },
    );
  }
  if (liveContract.selected_tool !== args.currentContract.selected_tool) {
    throw new HttpError(
      409,
      "policy_learning_control_selected_tool_mismatch",
      "live policy contract selected tool does not match persisted policy memory",
      {
        policy_memory_id: args.nodeId,
        action: args.action,
        persisted_selected_tool: args.currentContract.selected_tool,
        live_selected_tool: liveContract.selected_tool,
      },
    );
  }
  return liveContract;
}

function buildPolicyLearningControlReviewReason(args: {
  action: PolicyLearningControlApplyAction;
  reason: string | null;
  learningControlContract: PolicyLearningControlContract | null;
}): string {
  const parts = [
    `policy_learning_control_apply:${args.action}`,
    firstString(args.reason),
    firstString(args.learningControlContract?.rationale),
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join(" | ");
}

function buildPolicyLearningControlActionSource(args: {
  learningControlContract: PolicyLearningControlContract | null;
}): "contract_apply" | "manual_apply" {
  if (!args.learningControlContract || args.learningControlContract.action === "none") return "manual_apply";
  return "contract_apply";
}

async function applyPolicyMemoryLearningControlToNode(args: {
  tenantId: string;
  scope: string;
  node: ExistingPolicyMemoryNode;
  action: PolicyLearningControlApplyAction;
  actor: string | null;
  reason: string | null;
  learningControlContract: PolicyLearningControlContract | null;
  livePolicyContract: PolicyContract | null;
  liveDerivedPolicy: DerivedPolicySurface | null;
  appliedAt: string;
  commitId: string | null;
  updateNode: (node: ExistingPolicyMemoryNode, next: {
    slots: Record<string, unknown>;
    textSummary: string;
    salience: number;
    importance: number;
    confidence: number;
  }) => Promise<void>;
}): Promise<PolicyMemoryLearningControlApplyResult> {
  const slots = asRecord(args.node.slots) ?? {};
  const currentContract = parseStoredPolicyContract(slots.policy_contract_v1, args.node.id);
  if (!currentContract) {
    throw new HttpError(400, "policy_memory_contract_missing", "policy memory contract is missing or invalid", {
      policy_memory_id: args.node.id,
    });
  }
  if (args.learningControlContract?.policy_memory_id && args.learningControlContract.policy_memory_id !== args.node.id) {
    throw new HttpError(409, "policy_learning_control_contract_target_mismatch", "learning_control contract targets a different policy memory", {
      policy_memory_id: args.node.id,
      learning_control_policy_memory_id: args.learningControlContract.policy_memory_id,
    });
  }
  if (
    args.action !== "retire"
    && args.learningControlContract
    && args.learningControlContract.action !== "none"
    && args.learningControlContract.action !== args.action
  ) {
    throw new HttpError(409, "policy_learning_control_action_mismatch", "requested action does not match learning_control contract", {
      policy_memory_id: args.node.id,
      requested_action: args.action,
      learning_control_action: args.learningControlContract.action,
    });
  }

  const previousState = currentContract.policy_memory_state;
  const liveContract =
    args.action === "refresh" || args.action === "reactivate"
      ? requireMatchingLivePolicyContract({
          action: args.action,
          nodeId: args.node.id,
          currentContract,
          livePolicyContract: args.livePolicyContract,
        })
      : null;

  if (
    liveContract
    && args.liveDerivedPolicy
    && args.liveDerivedPolicy.selected_tool !== liveContract.selected_tool
  ) {
    throw new HttpError(
      409,
      "policy_learning_control_live_policy_derivation_mismatch",
      "live derived policy selected tool does not match live policy contract",
      {
        policy_memory_id: args.node.id,
        live_contract_selected_tool: liveContract.selected_tool,
        live_derived_selected_tool: args.liveDerivedPolicy.selected_tool,
      },
    );
  }

  const nextState: PolicyMemoryLifecycleState =
    args.action === "retire"
      ? "retired"
      : args.action === "reactivate"
        ? "active"
        : previousState;
  const nextContract = normalizePolicyContractLifecycle({
    contract: liveContract ?? currentContract,
    nodeId: args.node.id,
    nextState,
  });
  const effectiveNextState = nextContract.policy_memory_state;
  const nextDerivedPolicy = args.liveDerivedPolicy ?? parseStoredDerivedPolicy(slots.derived_policy_v1);
  const currentExecutionContract = resolveNodeExecutionContract({ slots });
  const taskSignature = firstString(
    resolveNodeTaskSignature({ slots }),
    currentExecutionContract?.task_signature,
    slots.task_signature,
  );
  const errorSignature = firstString(resolveNodeErrorSignature(slots), slots.error_signature);
  const workflowSignature = firstString(
    nextContract.workflow_signature,
    resolveNodeWorkflowSignature({ slots }),
    currentExecutionContract?.workflow_signature,
    slots.workflow_signature,
  );
  const nextExecutionNative = buildPolicyExecutionNative({
    taskSignature,
    errorSignature,
    workflowSignature,
    contract: nextContract,
    at: args.appliedAt,
    source: "learning_control",
    learningControlAction: args.action,
  });
  const nextExecutionContract = buildPolicyExecutionContract({
    nodeId: args.node.id,
    taskSignature,
    errorSignature,
    workflowSignature,
    contract: nextContract,
    source: "learning_control",
    learningControlAction: args.action,
  });
  const authoritySurfaces = buildPolicyAuthoritySurfaces({
    contract: nextContract,
    executionContract: nextExecutionContract,
  });
  const authorityGate = authoritySurfaces.authority_gate_v1 as Record<string, unknown> | undefined;
  const evidenceAssessment = authoritySurfaces.execution_evidence_assessment as Record<string, unknown> | undefined;
  const policyMemorySignature = firstString(slots.policy_memory_signature) ?? args.node.id;
  const promotionEvidenceLedger = buildPromotionEvidenceLedgerV1({
    targetKind: "policy",
    targetId: args.node.id,
    sourceLayers: ["L3"],
    targetLayer: "L4",
    transition: "L3_to_L4",
    promotionState: nextContract.policy_memory_state,
    promotionOrigin: "learning_control",
    observedCount: nextContract.source_anchor_ids.length,
    requiredCount: nextContract.policy_memory_state === "active" ? 1 : 0,
    authorityGateAdmitted: typeof authorityGate?.allows_authoritative === "boolean"
      ? authorityGate.allows_authoritative
      : null,
    learningControlAdmitted: args.action !== "retire",
    verifierStatus: typeof evidenceAssessment?.status === "string"
      && ["succeeded", "failed", "incomplete", "unknown"].includes(evidenceAssessment.status)
      ? evidenceAssessment.status as "succeeded" | "failed" | "incomplete" | "unknown"
      : null,
    contractTrust: nextContract.contract_trust ?? null,
    sourceNodeIds: nextContract.source_anchor_ids,
    promotionEvidenceRefs: args.action === "retire" ? [] : nextContract.source_anchor_ids,
    counterEvidenceRefs: args.action === "retire" ? [args.node.id] : [],
    reasonCodes: [
      `policy_learning_control_${args.action}`,
      `policy_memory_state_${nextContract.policy_memory_state}`,
    ],
    evidence: [
      {
        evidence_id: `${policyMemorySignature}:learning_control`,
        evidence_kind: "learning_control",
        polarity: args.action === "retire" ? "negative" : "positive",
        source_ref: `${args.node.id}:learning_control`,
        claim: `learning control applied ${args.action} to policy memory`,
        confidence: args.action === "retire" ? 0.74 : 0.78,
      },
      {
        evidence_id: `${policyMemorySignature}:source_anchors`,
        evidence_kind: "source_anchor",
        polarity: nextContract.source_anchor_ids.length > 0 ? "positive" : "neutral",
        source_ref: nextContract.source_anchor_ids[0] ?? args.node.id,
        claim: `${nextContract.source_anchor_ids.length} source anchors remain linked to policy memory`,
        confidence: nextContract.source_anchor_ids.length > 0 ? 0.72 : 0.48,
      },
    ],
  });
  const nextExecutionNativeWithPromotionLedger = ExecutionNativeV1Schema.parse({
    ...nextExecutionNative,
    promotion_evidence_ledger_v1: promotionEvidenceLedger,
  });

  const nextSlots: Record<string, unknown> = {
    ...slots,
    summary_kind: "policy_memory",
    compression_layer: "L4",
    materialization_state: "persisted",
    policy_memory_state: nextContract.policy_memory_state,
    policy_contract_v1: nextContract,
    selected_tool: nextContract.selected_tool,
    workflow_signature: workflowSignature,
    task_signature: taskSignature,
    error_signature: errorSignature,
    file_path: firstString(nextContract.file_path, slots.file_path),
    target_files: nextContract.target_files,
    source_anchor_ids: nextContract.source_anchor_ids,
    execution_contract_v1: nextExecutionContract,
    ...authoritySurfaces,
    policy_last_review_at: args.appliedAt,
    policy_last_review_job: "policy_learning_control_apply",
    policy_last_review_reason: buildPolicyLearningControlReviewReason({
      action: args.action,
      reason: args.reason,
      learningControlContract: args.learningControlContract,
    }),
    policy_last_learning_control_action: args.action,
    policy_last_learning_control_actor: args.actor,
    policy_last_learning_control_reason: firstString(args.reason),
    policy_last_learning_control_rationale: firstString(args.learningControlContract?.rationale),
    policy_last_learning_control_source: buildPolicyLearningControlActionSource({
      learningControlContract: args.learningControlContract,
    }),
    policy_last_learning_control_applied_at: args.appliedAt,
    promotion_evidence_ledger_v1: promotionEvidenceLedger,
    execution_native_v1: nextExecutionNativeWithPromotionLedger,
    ...(args.learningControlContract ? { policy_last_learning_control_contract_v1: args.learningControlContract } : {}),
    ...(nextDerivedPolicy ? { derived_policy_v1: nextDerivedPolicy } : {}),
  };
  if (args.action !== "retire") nextSlots.last_materialized_at = args.appliedAt;
  if (effectiveNextState !== previousState) {
    nextSlots.policy_state_changed_at = args.appliedAt;
    nextSlots.policy_state_changed_by = firstString(args.actor) ?? "policy_learning_control_apply";
  }

  const nextSummary = buildPolicyMemorySummary({
    contract: nextContract,
    taskSignature,
    errorSignature,
  });
  const lifecycle = resolveNodeLifecycleSignals({
    type: "concept",
    tier: args.node.tier,
    title: args.node.title,
    text_summary: nextSummary,
    slots: nextSlots,
    reference_time: args.appliedAt,
  });
  await args.updateNode(args.node, {
    slots: lifecycle.slots,
    textSummary: nextSummary,
    salience: lifecycle.salience,
    importance: lifecycle.importance,
    confidence: lifecycle.confidence,
  });

  return {
    previous_state: previousState,
    next_state: effectiveNextState,
    policy_memory: formatPolicyMemoryFeedbackResult({
      tenantId: args.tenantId,
      scope: args.scope,
      node: args.node,
      contract: nextContract,
      slots: lifecycle.slots,
    }),
  };
}

export async function applyPolicyMemoryLearningControlLite(
  liteWriteStore: Pick<LiteWriteStore, "findNodes" | "updateNodeAnchorState">,
  args: PolicyMemoryLearningControlApplyArgs,
): Promise<PolicyMemoryLearningControlApplyResult> {
  const node = await loadPolicyMemoryNodeLite(liteWriteStore, {
    scope: args.scope,
    id: args.policy_memory_id,
  });
  return applyPolicyMemoryLearningControlToNode({
    tenantId: args.tenant_id,
    scope: args.scope,
    node,
    action: args.action,
    actor: args.actor ?? null,
    reason: args.reason ?? null,
    learningControlContract: args.learning_control_contract ?? null,
    livePolicyContract: args.live_policy_contract ?? null,
    liveDerivedPolicy: args.live_derived_policy ?? null,
    appliedAt: firstString(args.applied_at) ?? new Date().toISOString(),
    commitId: args.commit_id ?? null,
    updateNode: (currentNode, next) => updateExistingPolicyMemoryLite(liteWriteStore, {
      scope: args.scope,
      id: currentNode.id,
      clientId: currentNode.client_id,
      slots: next.slots,
      textSummary: next.textSummary,
      salience: next.salience,
      importance: next.importance,
      confidence: next.confidence,
      commitId: args.commit_id ?? null,
    }),
  });
}

export async function preparePolicyMemorySnapshot(
  args: WritePolicyMemorySnapshotArgs,
  opts: WritePolicyMemorySnapshotOptions,
): Promise<PreparedPolicyMemorySnapshot> {
  const parsedContract = PolicyContractSchema.parse({
    ...args.policy_contract,
    materialization_state: "persisted",
  });
  const parsedDerivedPolicy = DerivedPolicySurfaceSchema.parse(args.derived_policy);
  const taskSignature = firstString(args.task_signature);
  const errorSignature = firstString(args.error_signature);
  const workflowSignature = firstString(args.workflow_signature, parsedContract.workflow_signature);
  const filePath = firstString(parsedContract.file_path, parsedDerivedPolicy.file_path);
  const targetFiles = stringList(
    parsedContract.target_files.length > 0
      ? parsedContract.target_files
      : parsedDerivedPolicy.target_files,
    24,
  );
  const policyMemorySignature = buildPolicyMemorySignature({
    taskSignature,
    errorSignature,
    workflowSignature,
    selectedTool: parsedContract.selected_tool,
    filePath,
    targetFiles,
  });
  const clientId = `policy-memory:${policyMemorySignature}`;
  const title = buildPolicyMemoryTitle({
    selectedTool: parsedContract.selected_tool,
    taskSignature,
    workflowSignature,
    filePath,
  });

  const existingNode = opts.liteWriteStore
    ? await findExistingPolicyMemoryLite(opts.liteWriteStore, args.scope, clientId)
    : null;

  const nextContract = normalizePolicyContractLifecycle({
    contract: PolicyContractSchema.parse({
      ...parsedContract,
      materialization_state: "persisted",
      policy_memory_id: existingNode?.id ?? null,
    }),
    nodeId: existingNode?.id ?? null,
    nextState: "active",
  });
  const summary = buildPolicyMemorySummary({
    contract: nextContract,
    taskSignature,
    errorSignature,
  });
  const materializedAt = new Date().toISOString();
  const slots = buildPolicyMemorySlots({
    taskSignature,
    errorSignature,
    workflowSignature,
    policyMemorySignature,
    contract: nextContract,
    derivedPolicy: parsedDerivedPolicy,
    transitionAt: materializedAt,
    source: "materialization",
  });
  const mergedSlots = existingNode
    ? {
        ...(asRecord(existingNode.slots) ?? {}),
        ...slots,
      }
    : slots;
  const lifecycle = resolveNodeLifecycleSignals({
    type: "concept",
    tier: existingNode?.tier ?? "warm",
    title,
    text_summary: summary,
    slots: mergedSlots,
  });

  if (existingNode && opts.liteWriteStore) {
    return {
      scope: args.scope,
      feedback_commit_id: args.feedback_commit_id,
      expected_existing_sha256: existingPolicyMemorySha256(existingNode),
      update: {
        id: existingNode.id,
        client_id: existingNode.client_id,
        slots: lifecycle.slots,
        text_summary: summary,
        salience: lifecycle.salience,
        importance: lifecycle.importance,
        confidence: lifecycle.confidence,
      },
      prepared_write: null,
      prospective_node: {
        ...existingNode,
        text_summary: summary,
        slots: lifecycle.slots,
        salience: lifecycle.salience,
        importance: lifecycle.importance,
        confidence: lifecycle.confidence,
      },
      result: {
        node_id: existingNode.id,
        client_id: clientId,
        policy_memory_signature: policyMemorySignature,
        policy_contract: PolicyContractSchema.parse({
          ...nextContract,
          policy_memory_id: existingNode.id,
        }),
      },
    };
  }

  const prepared = await prepareMemoryWrite(
    {
      tenant_id: args.tenant_id,
      scope: args.scope,
      actor: args.actor,
      input_text: args.input_text ?? undefined,
      input_sha256: args.input_sha256,
      auto_embed: true,
      memory_lane: "shared",
      nodes: [
        {
          client_id: clientId,
          type: "concept",
          title,
          text_summary: summary,
          slots: lifecycle.slots,
          salience: lifecycle.salience,
          importance: lifecycle.importance,
          confidence: lifecycle.confidence,
        },
      ],
      edges: [],
    },
    opts.defaultScope,
    opts.defaultTenantId,
    {
      maxTextLen: opts.maxTextLen,
      piiRedaction: opts.piiRedaction,
      allowCrossScopeEdges: opts.allowCrossScopeEdges ?? false,
    },
    opts.embedder,
  );
  const preparedPolicyNode = prepared.nodes[0];
  if (preparedPolicyNode) {
    preparedPolicyNode.slots = sealPolicyAuthoritySlots({
      scope: preparedPolicyNode.scope,
      id: preparedPolicyNode.id,
      clientId: preparedPolicyNode.client_id ?? null,
      slots: preparedPolicyNode.slots,
      issuedAt: materializedAt,
    });
  }
  return {
    scope: args.scope,
    feedback_commit_id: args.feedback_commit_id,
    expected_existing_sha256: null,
    update: null,
    prepared_write: prepared,
    prospective_node: {
      id: prepared.nodes[0]!.id,
      client_id: prepared.nodes[0]!.client_id ?? null,
      title: prepared.nodes[0]!.title ?? null,
      text_summary: prepared.nodes[0]!.text_summary ?? null,
      slots: prepared.nodes[0]!.slots,
      tier: prepared.nodes[0]!.tier ?? "warm",
      salience: prepared.nodes[0]!.salience ?? lifecycle.salience,
      importance: prepared.nodes[0]!.importance ?? lifecycle.importance,
      confidence: prepared.nodes[0]!.confidence ?? lifecycle.confidence,
    },
    result: {
      node_id: prepared.nodes[0]!.id,
      client_id: clientId,
      policy_memory_signature: policyMemorySignature,
      policy_contract: PolicyContractSchema.parse({
        ...nextContract,
        policy_memory_id: prepared.nodes[0]!.id,
      }),
    },
  };
}

export async function persistPreparedPolicyMemorySnapshot(
  prepared: PreparedPolicyMemorySnapshot,
  opts: {
    liteWriteStore: LiteProjectedWriteStore & Pick<LiteWriteStore, "findNodes" | "updateNodeAnchorState">;
    maxTextLen: number;
    piiRedaction: boolean;
    allowCrossScopeEdges?: boolean;
  },
): Promise<PolicyMemorySnapshotWriteResult> {
  const current = await findExistingPolicyMemoryLite(
    opts.liteWriteStore,
    prepared.scope,
    prepared.result.client_id,
  );
  if (existingPolicyMemorySha256(current) !== prepared.expected_existing_sha256) {
    throw new Error("policy_memory_snapshot_prepare_conflict");
  }
  if (prepared.update) {
    await updateExistingPolicyMemoryLite(opts.liteWriteStore, {
      scope: prepared.scope,
      id: prepared.update.id,
      clientId: prepared.update.client_id,
      slots: prepared.update.slots,
      textSummary: prepared.update.text_summary,
      salience: prepared.update.salience,
      importance: prepared.update.importance,
      confidence: prepared.update.confidence,
      commitId: prepared.feedback_commit_id,
    });
  } else if (prepared.prepared_write) {
    await persistLitePreparedWrite({
      prepared: prepared.prepared_write,
      liteWriteStore: opts.liteWriteStore,
      writeOptions: {
        maxTextLen: opts.maxTextLen,
        piiRedaction: opts.piiRedaction,
        allowCrossScopeEdges: opts.allowCrossScopeEdges ?? false,
        associativeLinkOrigin: "memory_write",
      },
    });
  }
  return prepared.result;
}

export async function writePolicyMemorySnapshot(
  args: WritePolicyMemorySnapshotArgs,
  opts: WritePolicyMemorySnapshotOptions,
): Promise<PolicyMemorySnapshotWriteResult> {
  const liteWriteStore = opts.liteWriteStore ?? null;
  if (liteWriteStore && opts.writeAccess !== liteWriteStore) {
    throw new Error("policy memory write authorities must share one Lite store");
  }
  if (liteWriteStore?.transactionRunner().inTransaction()) {
    throw new Error("writePolicyMemorySnapshot must be entered outside a transaction");
  }
  const prepared = await preparePolicyMemorySnapshot(args, opts);
  if (!liteWriteStore) {
    const write = prepared.prepared_write;
    if (!write) throw new Error("policy memory generic write plan is missing");
    const planned = write.nodes.filter((node) => (
      !node.embedding && typeof node.embed_text === "string" && node.embed_text.trim().length > 0
    ));
    if (opts.embedder && planned.length > 0) {
      const vectors = await opts.embedder.embed(planned.map((node) => String(node.embed_text)));
      for (let index = 0; index < planned.length; index += 1) {
        planned[index]!.embedding = vectors[index] ?? planned[index]!.embedding;
        planned[index]!.embedding_model = opts.embedder.name;
      }
    }
    const out = await applyPreparedMemoryWrite(opts.writeAccess, write, {
      maxTextLen: opts.maxTextLen,
      piiRedaction: opts.piiRedaction,
      allowCrossScopeEdges: opts.allowCrossScopeEdges ?? false,
      associativeLinkOrigin: "memory_write",
    });
    const nodeId = out.nodes[0]!.id;
    return {
      ...prepared.result,
      node_id: nodeId,
      policy_contract: PolicyContractSchema.parse({
        ...prepared.result.policy_contract,
        policy_memory_id: nodeId,
      }),
    };
  }
  const result = await liteWriteStore.withTx(() => persistPreparedPolicyMemorySnapshot(prepared, {
    liteWriteStore,
    maxTextLen: opts.maxTextLen,
    piiRedaction: opts.piiRedaction,
    allowCrossScopeEdges: opts.allowCrossScopeEdges,
  }));
  if (prepared.prepared_write) {
    await completeLiteInlineEmbeddings({ prepared: prepared.prepared_write, embedder: opts.embedder, liteWriteStore });
  }
  return result;
}
