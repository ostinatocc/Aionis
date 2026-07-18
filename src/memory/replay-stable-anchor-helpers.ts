import type { EmbeddingProvider } from "../embeddings/types.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import type { ReplayNodeRow, ReplayVisibilityArgs } from "../store/replay-access.js";
import type { WriteStoreAccess } from "../store/write-access.js";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import { stableUuid } from "../util/uuid.js";
import stableStringify from "fast-json-stable-stringify";
import { runAppliedAuthorityMutationV2 } from "./applied-authority-mutation.js";
import { buildWorkflowMaintenanceMetadata, buildWorkflowPromotionMetadata } from "./evolution-operators.js";
import { resolveNodeLifecycleSignals } from "./lifecycle-signals.js";
import {
  NODE_AUTHORITY_UPDATE_SIDE_EFFECTS,
  applyNodeAuthorityPatchesV2,
  assertNodeDecisionRowMatchesAuthorityState,
  buildNodeAuthorityMutationV2,
  captureNodeAuthorityHeadFence,
  verifyNodeAuthorityPatchesV2,
  type NodeAuthorityPatchV2,
} from "./node-authority-mutation.js";
import { ExecutionNativeV1Schema, MemoryAnchorV1Schema } from "./schemas.js";
import type { ReplayMirrorNodeRecord, ReplayWriteMirror } from "./replay-write.js";
import {
  buildReplayProjectionExecutionContract,
  deriveReplayWorkflowContractFromSlots,
  type ReplayWorkflowContract,
} from "./replay-workflow-contract.js";
import {
  buildRuntimeAuthorityEffect,
  sealRuntimeAuthorityEffectReceipt,
} from "./authority-effect-broker.js";
import { downgradeAuthoritativeTrust } from "./authority-gate.js";
import { assertAuthorityWriteReceipts } from "./authority-write-guard.js";
import { resolveNodeDistillationSurface } from "./node-execution-surface.js";

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

type ReplayPlaybookWorkflowStatus = "draft" | "shadow" | "active";
type ReplayPlaybookWorkflowPromotionOrigin =
  | "replay_compile_from_run"
  | "replay_promote"
  | "replay_stable_normalization";
type ReplayPlaybookWorkflowNodeFields = {
  slots: Record<string, unknown>;
  embedding?: number[];
  embedding_model?: string;
};

function isStableReplayPlaybookStatus(status: string | null | undefined): status is "shadow" | "active" {
  return status === "shadow" || status === "active";
}

function requireLiteReplayWriteStore(writeAccess?: WriteStoreAccess | null): LiteWriteStore {
  if (
    !writeAccess
    || typeof (writeAccess as LiteWriteStore).findNodes !== "function"
    || typeof (writeAccess as LiteWriteStore).updateNodeAnchorState !== "function"
    || typeof (writeAccess as LiteWriteStore).setNodeEmbeddingReady !== "function"
  ) {
    throw new Error("aionis-lite replay promotion requires lite write-store anchor mutation support");
  }
  return writeAccess as LiteWriteStore;
}

function buildReplayMirrorRecordFromLiteNode(args: {
  scopeKey: string;
  playbookId: string;
  node: LiteFindNodeRow;
}): ReplayMirrorNodeRecord {
  const slots = asObject(args.node.slots) ?? {};
  return {
    node_id: args.node.id,
    scope: args.scopeKey,
    replay_kind: "playbook",
    run_id: toStringOrNull(slots.source_run_id),
    step_id: null,
    step_index: null,
    playbook_id: args.playbookId,
    version_num: Number(slots.version ?? 0) || null,
    playbook_status: toStringOrNull(slots.playbook_status ?? slots.status),
    node_type: args.node.type,
    title: args.node.title,
    text_summary: args.node.text_summary,
    slots_json: JSON.stringify(slots),
    memory_lane: args.node.memory_lane,
    producer_agent_id: args.node.producer_agent_id,
    owner_agent_id: args.node.owner_agent_id,
    owner_team_id: args.node.owner_team_id,
    created_at: args.node.created_at,
    updated_at: args.node.updated_at,
    commit_id: args.node.commit_id,
  };
}

function distinctToolNamesFromSteps(stepsRaw: unknown): string[] {
  if (!Array.isArray(stepsRaw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const step of stepsRaw) {
    const toolName = toStringOrNull(asObject(step)?.tool_name);
    if (!toolName || seen.has(toolName)) continue;
    seen.add(toolName);
    out.push(toolName);
  }
  return out;
}

function deriveReplayWorkflowSignature(playbookId: string, stepsRaw: unknown): string {
  const steps = Array.isArray(stepsRaw)
    ? stepsRaw.map((step) => {
        const obj = asObject(step) ?? {};
        return {
          tool_name: toStringOrNull(obj.tool_name),
          safety_level: toStringOrNull(obj.safety_level),
          preconditions: Array.isArray(obj.preconditions) ? obj.preconditions.length : 0,
          postconditions: Array.isArray(obj.postconditions) ? obj.postconditions.length : 0,
        };
      })
    : [];
  return `replay_workflow:${sha256Hex(JSON.stringify({ playbook_id: playbookId, steps })).slice(0, 24)}`;
}

function replayWriteNodeId(scopeKey: string, clientId: string): string {
  return stableUuid(`${scopeKey}:node:${clientId.trim()}`);
}

function authorityGatedReplayWorkflowContract(args: {
  base: ReplayWorkflowContract;
  taskSignature: string;
  workflowSignature: string;
  sourceAnchor: string;
  filePath?: string | null;
  notes: string[];
  provenanceSourceKind?: "workflow_projection" | "replay_compile_from_run";
  slots: Record<string, unknown>;
}) {
  const initialExecutionContract = buildReplayProjectionExecutionContract({
    base: args.base,
    task_signature: args.taskSignature,
    workflow_signature: args.workflowSignature,
    source_anchor: args.sourceAnchor,
    file_path: args.filePath ?? null,
    notes: args.notes,
    provenance_source_kind: args.provenanceSourceKind,
  });
  const initialAuthority = buildRuntimeAuthorityEffect({
    effectKind: "stable_replay_playbook_anchor",
    executionContract: initialExecutionContract,
    requestedTrust: args.base.contract_trust,
    slots: args.slots,
  });
  const effectiveTrust = downgradeAuthoritativeTrust({
    requestedTrust: args.base.contract_trust,
    authorityGate: initialAuthority.authorityGate,
  });
  const workflowContract =
    effectiveTrust !== args.base.contract_trust
      ? {
          ...args.base,
          contract_trust: effectiveTrust,
        }
      : args.base;
  if (workflowContract === args.base) {
    return {
      workflowContract,
      executionContract: initialExecutionContract,
      ...initialAuthority,
    };
  }
  const executionContract = buildReplayProjectionExecutionContract({
    base: workflowContract,
    task_signature: args.taskSignature,
    workflow_signature: args.workflowSignature,
    source_anchor: args.sourceAnchor,
    file_path: args.filePath ?? null,
    notes: [...args.notes, "runtime_authority_gate_downgraded_authoritative_contract"],
    provenance_source_kind: args.provenanceSourceKind,
  });
  const finalAuthority = buildRuntimeAuthorityEffect({
    effectKind: "stable_replay_playbook_anchor",
    executionContract,
    requestedTrust: workflowContract.contract_trust,
    slots: args.slots,
  });
  return {
    workflowContract,
    executionContract,
    ...finalAuthority,
  };
}

function buildReplayPlaybookAnchor(args: {
  scopeKey: string;
  playbookId: string;
  version: number;
  status: ReplayPlaybookWorkflowStatus;
  promotionOrigin: ReplayPlaybookWorkflowPromotionOrigin;
  requiredObservations?: number | null;
  observedCount?: number | null;
  title: string | null;
  textSummary: string | null;
  clientId: string;
  commitId: string | null;
  sourceNodeId: string | null;
  sourceCommitId: string | null;
  slots: Record<string, unknown>;
  promotionAt?: string;
}) {
  const sourceRunId = toStringOrNull(args.slots.source_run_id);
  const createdFromRunIds = Array.isArray(args.slots.created_from_run_ids)
    ? args.slots.created_from_run_ids.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  const stepsTemplate = Array.isArray(args.slots.steps_template) ? args.slots.steps_template : [];
  const toolSet = distinctToolNamesFromSteps(stepsTemplate);
  const keySteps = stepsTemplate
    .map((step) => {
      const obj = asObject(step) ?? {};
      const stepIndex = Number(obj.step_index ?? 0) || null;
      const toolName = toStringOrNull(obj.tool_name);
      if (!toolName) return null;
      return stepIndex != null ? `step_${stepIndex}:${toolName}` : toolName;
    })
    .filter((value): value is string => !!value)
    .slice(0, 12);
  const sourceRunStatus = toStringOrNull(asObject(args.slots.compile_summary)?.source_run_status);
  const stepsTotal = stepsTemplate.length;
  const anchorNodeId = replayWriteNodeId(args.scopeKey, args.clientId);
  const summary = args.textSummary ?? args.title ?? `Replay playbook ${args.playbookId}`;
  const rawWorkflowContract = deriveReplayWorkflowContractFromSlots(args.slots);
  const taskSignature = `replay_playbook:${args.playbookId}`;
  const workflowSignature = deriveReplayWorkflowSignature(args.playbookId, stepsTemplate);
  const authority = authorityGatedReplayWorkflowContract({
    base: rawWorkflowContract,
    taskSignature,
    workflowSignature,
    sourceAnchor: args.clientId,
    filePath: rawWorkflowContract.execution_contract_v1?.file_path ?? rawWorkflowContract.target_files[0] ?? null,
    notes: ["replay_playbook_anchor_gate"],
    slots: args.slots,
  });
  const { workflowContract, outcomeContractGate } = authority;
  const allowsStableWorkflow =
    authority.authorityGate.allows_authoritative
    && authority.authorityGate.allows_stable_promotion;
  const promotionState = isStableReplayPlaybookStatus(args.status) && allowsStableWorkflow ? "stable" : "candidate";
  const payloadCostHint: "low" | "medium" | "high" =
    stepsTotal <= 4 ? "low" : stepsTotal <= 10 ? "medium" : "high";
  const promotionAt = args.promotionAt ?? new Date().toISOString();
  const successScore = args.status === "active" ? 0.95 : args.status === "shadow" ? 0.85 : 0.7;
  return MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: promotionState === "stable" ? "L2" : "L1",
    ...(workflowContract.contract_trust ? { contract_trust: workflowContract.contract_trust } : {}),
    task_signature: taskSignature,
    task_class: "replay_playbook",
    ...(workflowContract.task_family ? { task_family: workflowContract.task_family } : {}),
    workflow_signature: workflowSignature,
    summary,
    tool_set: toolSet,
    key_steps: workflowContract.workflow_steps.length > 0 ? workflowContract.workflow_steps : keySteps,
    ...(workflowContract.target_files.length > 0 ? { target_files: workflowContract.target_files } : {}),
    ...(workflowContract.next_action ? { next_action: workflowContract.next_action } : {}),
    ...(workflowContract.pattern_hints.length > 0 ? { pattern_hints: workflowContract.pattern_hints } : {}),
    ...(workflowContract.service_lifecycle_constraints.length > 0
      ? { service_lifecycle_constraints: workflowContract.service_lifecycle_constraints }
      : {}),
    outcome_contract_gate: outcomeContractGate,
    outcome: {
      status: "success",
      result_class: args.status,
      success_score: successScore,
    },
    source: {
      source_kind: "playbook",
      node_id: anchorNodeId,
      run_id: sourceRunId,
      playbook_id: args.playbookId,
      commit_id: args.commitId ?? args.sourceCommitId ?? null,
    },
    payload_refs: {
      node_ids: args.sourceNodeId ? [args.sourceNodeId] : [],
      decision_ids: [],
      run_ids: sourceRunId ? [sourceRunId, ...createdFromRunIds.filter((runId) => runId !== sourceRunId)] : createdFromRunIds,
      step_ids: [],
      commit_ids: [args.sourceCommitId, args.commitId].filter((value): value is string => !!value),
    },
    rehydration: {
      default_mode: "partial",
      payload_cost_hint: payloadCostHint,
      recommended_when: [
        "need_exact_steps_template",
        "workflow_summary_is_not_enough",
        "irreversible_action_requires_exact_sequence",
      ],
    },
    recall_features: {
      tool_tags: toolSet,
      outcome_tags: [args.status, sourceRunStatus ?? "unknown"],
      keywords: [args.title, summary, args.playbookId].filter((value): value is string => !!value).slice(0, 8),
    },
    metrics: {
      usage_count: 0,
      reuse_success_count: 0,
      reuse_failure_count: 0,
      last_used_at: null,
    },
    maintenance: buildWorkflowMaintenanceMetadata({
      promotion_state: promotionState,
      at: promotionAt,
    }),
    workflow_promotion: buildWorkflowPromotionMetadata({
      promotion_state: promotionState,
      promotion_origin: args.promotionOrigin,
      required_observations: promotionState === "candidate" ? args.requiredObservations ?? 2 : null,
      observed_count: promotionState === "candidate" ? args.observedCount ?? 1 : null,
      source_status: args.status,
      at: promotionAt,
    }),
    schema_version: "anchor_v1",
  });
}

export async function buildReplayPlaybookWorkflowNodeFields(args: {
  embedder: EmbeddingProvider | null;
  scopeKey: string;
  playbookId: string;
  version: number;
  status: ReplayPlaybookWorkflowStatus;
  promotionOrigin: ReplayPlaybookWorkflowPromotionOrigin;
  requiredObservations?: number | null;
  observedCount?: number | null;
  title: string;
  textSummary: string;
  clientId: string;
  nodeId?: string;
  nodeType?: string;
  commitId: string | null;
  sourceNodeId: string | null;
  sourceCommitId: string | null;
  slots: Record<string, unknown>;
  promotionAt?: string;
  authorityIssuedAt?: string;
}): Promise<ReplayPlaybookWorkflowNodeFields> {
  const anchor = buildReplayPlaybookAnchor({
    scopeKey: args.scopeKey,
    playbookId: args.playbookId,
    version: args.version,
    status: args.status,
    promotionOrigin: args.promotionOrigin,
    requiredObservations: args.requiredObservations,
    observedCount: args.observedCount,
    title: args.title,
    textSummary: args.textSummary,
    clientId: args.clientId,
    commitId: args.commitId,
    sourceNodeId: args.sourceNodeId,
    sourceCommitId: args.sourceCommitId,
    slots: args.slots,
    promotionAt: args.promotionAt,
  });
  const existingDistillation = resolveNodeDistillationSurface(args.slots);
  const provenanceSourceKind =
    args.promotionOrigin === "replay_compile_from_run" ? "replay_compile_from_run" : "workflow_projection";
  const rawWorkflowContract = deriveReplayWorkflowContractFromSlots(args.slots, {
    source_kind: provenanceSourceKind,
    source_anchor: args.clientId,
    notes: ["replay_playbook_workflow_projection"],
  });
  const authority = authorityGatedReplayWorkflowContract({
    base: rawWorkflowContract,
    taskSignature: anchor.task_signature,
    workflowSignature: anchor.workflow_signature ?? args.playbookId,
    sourceAnchor: args.clientId,
    filePath: anchor.file_path ?? null,
    notes: [
      args.promotionOrigin === "replay_compile_from_run"
        ? "replay_compile_from_run_candidate_projection"
        : "replay_stable_playbook_projection",
    ],
    provenanceSourceKind,
    slots: args.slots,
  });
  const {
    workflowContract,
    executionContract,
    outcomeContractGate,
    executionEvidence,
    executionEvidenceAssessment,
    authorityGate,
  } = authority;
  const workflowPromotionState = anchor.workflow_promotion?.promotion_state ?? "stable";
  const summaryKind = workflowPromotionState === "stable" ? "workflow_anchor" : "workflow_candidate";
  const compressionLayer = workflowPromotionState === "stable" ? "L2" : "L1";
  const executionNative = ExecutionNativeV1Schema.parse({
    schema_version: "execution_native_v1",
    execution_kind: workflowPromotionState === "stable" ? "workflow_anchor" : "workflow_candidate",
    summary_kind: summaryKind,
    compression_layer: compressionLayer,
    ...(workflowContract.contract_trust ? { contract_trust: workflowContract.contract_trust } : {}),
    task_signature: anchor.task_signature,
    task_class: anchor.task_class,
    ...(anchor.task_family ? { task_family: anchor.task_family } : {}),
    workflow_signature: anchor.workflow_signature,
    anchor_kind: "workflow",
    anchor_level: anchor.anchor_level,
    tool_set: anchor.tool_set,
    ...(anchor.file_path !== undefined ? { file_path: anchor.file_path } : {}),
    ...(workflowContract.target_files.length > 0 ? { target_files: workflowContract.target_files } : {}),
    ...(workflowContract.next_action ? { next_action: workflowContract.next_action } : {}),
    ...(anchor.key_steps && anchor.key_steps.length > 0 ? { workflow_steps: anchor.key_steps } : {}),
    ...(workflowContract.pattern_hints.length > 0 ? { pattern_hints: workflowContract.pattern_hints } : {}),
    ...(workflowContract.service_lifecycle_constraints.length > 0
      ? { service_lifecycle_constraints: workflowContract.service_lifecycle_constraints }
      : {}),
    outcome_contract_gate: outcomeContractGate,
    workflow_promotion: anchor.workflow_promotion,
    maintenance: anchor.maintenance,
    rehydration: anchor.rehydration,
    ...(existingDistillation ? { distillation: existingDistillation } : {}),
  });
  const slots: Record<string, unknown> = {
    ...args.slots,
    summary_kind: summaryKind,
    compression_layer: compressionLayer,
    anchor_v1: anchor,
    execution_native_v1: executionNative,
    execution_contract_v1: executionContract,
    outcome_contract_gate: outcomeContractGate,
    ...(executionEvidence ? { execution_evidence_v1: executionEvidence } : {}),
    execution_evidence_assessment: executionEvidenceAssessment,
    authority_gate_v1: authorityGate,
  };
  sealRuntimeAuthorityEffectReceipt({
    effectKind: "stable_replay_playbook_anchor",
    node: {
      id: args.nodeId ?? replayWriteNodeId(args.scopeKey, args.clientId),
      client_id: args.clientId,
      scope: args.scopeKey,
      type: args.nodeType ?? "procedure",
      slots,
    },
    slots,
    authorityGate,
    issuedAt: args.authorityIssuedAt,
    mutate: true,
  });
  const embedText = `${args.title}\n${anchor.summary}\n${anchor.tool_set.join(" ")}\n${anchor.task_signature}`;
  if (!args.embedder) {
    return { slots };
  }
  const vectors = await args.embedder.embed([embedText]);
  return {
    slots,
    embedding: vectors[0],
    embedding_model: args.embedder.name,
  };
}

export async function buildStablePlaybookNodeFields(args: {
  embedder: EmbeddingProvider | null;
  scopeKey: string;
  playbookId: string;
  version: number;
  status: string;
  promotionOrigin: "replay_promote" | "replay_stable_normalization";
  title: string;
  textSummary: string;
  clientId: string;
  nodeId?: string;
  nodeType?: string;
  commitId: string | null;
  sourceNodeId: string | null;
  sourceCommitId: string | null;
  slots: Record<string, unknown>;
  promotionAt?: string;
  authorityIssuedAt?: string;
}): Promise<ReplayPlaybookWorkflowNodeFields> {
  if (!isStableReplayPlaybookStatus(args.status)) {
    return {
      slots: args.slots,
    };
  }
  return buildReplayPlaybookWorkflowNodeFields({
    ...args,
    status: args.status,
  });
}

function playbookClientId(playbookId: string, version: number): string {
  return `replay:playbook:${playbookId}:v${version}`;
}

function assertStableReplayPlaybookBusinessState(args: {
  row: LiteFindNodeRow;
  playbookId: string;
  version: number;
  status: string;
  scope: string;
  tenantId: string;
}): void {
  const slots = asObject(args.row.slots) ?? {};
  const matches =
    args.row.type === "procedure"
    && slots.replay_kind === "playbook"
    && slots.playbook_id === args.playbookId
    && Number(slots.version) === args.version
    && slots.status === args.status
    && isStableReplayPlaybookStatus(args.status);
  if (!matches) {
    throw new HttpError(
      409,
      "replay_playbook_changed",
      "latest playbook node no longer matches the stable version being normalized",
      {
        playbook_id: args.playbookId,
        playbook_node_id: args.row.id,
        expected_version: args.version,
        expected_status: args.status,
        scope: args.scope,
        tenant_id: args.tenantId,
      },
    );
  }
}

function stableNormalizationProvenance(args: {
  slots: Record<string, unknown>;
  currentCommitId: string | null;
}): {
  promotionAt: string;
  authorityIssuedAt: string;
  sourceCommitId: string | null;
} {
  const anchor = asObject(args.slots.anchor_v1) ?? {};
  const promotion = asObject(anchor.workflow_promotion) ?? {};
  const normalized = promotion.promotion_origin === "replay_stable_normalization";
  const receipt = asObject(args.slots.authority_receipt_v1) ?? {};
  const maintenance = asObject(anchor.maintenance) ?? {};
  const source = asObject(anchor.source) ?? {};
  const now = new Date().toISOString();
  const promotionAt = normalized
    ? toStringOrNull(promotion.last_transition_at)
      ?? toStringOrNull(maintenance.last_maintenance_at)
      ?? toStringOrNull(receipt.issued_at)
      ?? now
    : now;
  return {
    promotionAt,
    authorityIssuedAt: normalized
      ? toStringOrNull(receipt.issued_at) ?? promotionAt
      : promotionAt,
    sourceCommitId: normalized
      ? toStringOrNull(source.commit_id) ?? args.currentCommitId
      : args.currentCommitId,
  };
}

function replayStablePatchMatchesCurrent(row: LiteFindNodeRow, patch: NodeAuthorityPatchV2): boolean {
  return stableStringify(row.slots ?? {}) === stableStringify(patch.slots)
    && (row.text_summary ?? null) === patch.textSummary
    && row.salience === patch.salience
    && row.importance === patch.importance
    && row.confidence === patch.confidence;
}

function replayStablePreparationState(row: LiteFindNodeRow): string {
  return stableStringify({
    id: row.id,
    type: row.type,
    client_id: row.client_id,
    title: row.title,
    text_summary: row.text_summary,
    slots: row.slots,
    tier: row.tier,
    memory_lane: row.memory_lane,
    producer_agent_id: row.producer_agent_id,
    owner_agent_id: row.owner_agent_id,
    owner_team_id: row.owner_team_id,
    raw_ref: row.raw_ref,
    evidence_ref: row.evidence_ref,
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
    commit_id: row.commit_id,
    created_at: row.created_at,
  });
}

export async function ensureStablePlaybookAnchorOnLatestNode(args: {
  embedder: EmbeddingProvider | null;
  writeAccess?: WriteStoreAccess | null;
  replayMirror?: ReplayWriteMirror | null;
  tenancy: { tenant_id: string; scope: string; scope_key: string };
  visibility: ReplayVisibilityArgs;
  playbookId: string;
  latest: ReplayNodeRow & { version_num: number; playbook_status: string | null };
}) {
  const stableStatus = args.latest.playbook_status;
  if (!isStableReplayPlaybookStatus(stableStatus)) {
    return null;
  }

  const liteWriteStore = requireLiteReplayWriteStore(args.writeAccess);
  const headFence = await captureNodeAuthorityHeadFence(liteWriteStore, args.tenancy.scope_key, {});
  const { rows } = await liteWriteStore.findNodes({
    scope: args.tenancy.scope_key,
    id: args.latest.id,
    consumerAgentId: args.visibility.consumerAgentId,
    consumerTeamId: args.visibility.consumerTeamId,
    limit: 1,
    offset: 0,
  });
  const latestNode = rows[0] ?? null;
  if (!latestNode) {
    throw new HttpError(404, "replay_playbook_not_found", "latest playbook node was not found in this scope/visibility", {
      playbook_id: args.playbookId,
      playbook_node_id: args.latest.id,
      scope: args.tenancy.scope,
      tenant_id: args.tenancy.tenant_id,
    });
  }
  assertStableReplayPlaybookBusinessState({
    row: latestNode,
    playbookId: args.playbookId,
    version: args.latest.version_num,
    status: stableStatus,
    scope: args.tenancy.scope,
    tenantId: args.tenancy.tenant_id,
  });

  const desiredTitle = latestNode.title ?? `replay_playbook_${args.playbookId.slice(0, 8)}`;
  const desiredTextSummary = latestNode.text_summary ?? `Replay playbook ${args.playbookId}`;
  const provenance = stableNormalizationProvenance({
    slots: asObject(latestNode.slots) ?? {},
    currentCommitId: latestNode.commit_id ?? null,
  });
  const desiredNodeFields = await buildStablePlaybookNodeFields({
    embedder: args.embedder,
    scopeKey: args.tenancy.scope_key,
    playbookId: args.playbookId,
    version: args.latest.version_num,
    status: stableStatus,
    promotionOrigin: "replay_stable_normalization",
    title: desiredTitle,
    textSummary: desiredTextSummary,
    clientId: playbookClientId(args.playbookId, args.latest.version_num),
    nodeId: latestNode.id,
    nodeType: latestNode.type,
    commitId: provenance.sourceCommitId,
    sourceNodeId: args.latest.id,
    sourceCommitId: provenance.sourceCommitId,
    slots: asObject(latestNode.slots) ?? {},
    promotionAt: provenance.promotionAt,
    authorityIssuedAt: provenance.authorityIssuedAt,
  });
  const preparedState = replayStablePreparationState(latestNode);
  const actor = args.visibility.consumerAgentId ?? "replay_stable_anchor_normalization";
  const authority = await runAppliedAuthorityMutationV2<NodeAuthorityPatchV2>({
    store: liteWriteStore,
    scope: args.tenancy.scope_key,
    inputSha256: sha256Hex(stableStringify({
      operation: "replay_stable_anchor_normalization_v2",
      scope: args.tenancy.scope_key,
      playbook_id: args.playbookId,
      playbook_node_id: latestNode.id,
      playbook_version: args.latest.version_num,
      playbook_status: stableStatus,
      prepared_commit_id: latestNode.commit_id ?? null,
      desired_text_summary: desiredTextSummary,
      desired_slots_sha256: sha256Hex(stableStringify(desiredNodeFields.slots)),
      embedding_model: desiredNodeFields.embedding_model ?? null,
      embedding_sha256: desiredNodeFields.embedding
        ? sha256Hex(stableStringify(desiredNodeFields.embedding))
        : null,
    })),
    actor,
    expectedHeadRevision: headFence.expectedHeadRevision,
    expectedHeadCommitId: headFence.expectedHeadCommitId,
    plan: async () => {
      const currentRows = await liteWriteStore.findNodes({
        scope: args.tenancy.scope_key,
        id: latestNode.id,
        consumerAgentId: args.visibility.consumerAgentId,
        consumerTeamId: args.visibility.consumerTeamId,
        limit: 1,
        offset: 0,
      });
      const current = currentRows.rows[0] ?? null;
      if (!current) {
        throw new HttpError(404, "replay_playbook_not_found", "latest playbook node disappeared during anchor normalization", {
          playbook_id: args.playbookId,
          playbook_node_id: latestNode.id,
          scope: args.tenancy.scope,
          tenant_id: args.tenancy.tenant_id,
        });
      }
      const before = (await liteWriteStore.nodeStatesByIds(
        args.tenancy.scope_key,
        [current.id],
      )).get(current.id);
      if (!before) throw new Error(`replay_stable_anchor_authority_target_missing:${current.id}`);
      assertNodeDecisionRowMatchesAuthorityState(
        current,
        before,
        "replay_stable_anchor_authority_state_changed",
      );
      if (replayStablePreparationState(current) !== preparedState) {
        throw new HttpError(
          409,
          "replay_playbook_changed",
          "latest playbook node changed after stable anchor preparation",
          {
            playbook_id: args.playbookId,
            playbook_node_id: current.id,
            scope: args.tenancy.scope,
            tenant_id: args.tenancy.tenant_id,
          },
        );
      }
      assertStableReplayPlaybookBusinessState({
        row: current,
        playbookId: args.playbookId,
        version: args.latest.version_num,
        status: stableStatus,
        scope: args.tenancy.scope,
        tenantId: args.tenancy.tenant_id,
      });

      const lifecycle = resolveNodeLifecycleSignals({
        type: current.type,
        tier: current.tier,
        title: current.title,
        text_summary: desiredTextSummary,
        slots: desiredNodeFields.slots,
        salience: current.salience,
        importance: current.importance,
        confidence: current.confidence,
        raw_ref: current.raw_ref ?? null,
        evidence_ref: current.evidence_ref ?? null,
        reference_time: provenance.promotionAt,
      });
      assertAuthorityWriteReceipts([{
        id: current.id,
        client_id: current.client_id ?? undefined,
        scope: args.tenancy.scope_key,
        type: current.type,
        slots: lifecycle.slots,
      }]);
      const patch: NodeAuthorityPatchV2 = {
        id: current.id,
        slots: lifecycle.slots,
        textSummary: desiredTextSummary,
        salience: lifecycle.salience,
        importance: lifecycle.importance,
        confidence: lifecycle.confidence,
      };
      if (replayStablePatchMatchesCurrent(current, patch)) {
        return { status: "no_op" as const, value: patch };
      }
      return {
        status: "mutate" as const,
        authorityKind: "replay_stable_anchor_normalization",
        mutations: [buildNodeAuthorityMutationV2({
          before,
          patch,
          requestedEvidence: {
            side_effects: NODE_AUTHORITY_UPDATE_SIDE_EFFECTS,
            derived_projections_after_commit: [
              "embedding_ready_and_ann",
              "replay_mirror",
            ],
            operation_context: {
              playbook_id: args.playbookId,
              playbook_node_id: current.id,
              playbook_version: args.latest.version_num,
              playbook_status: stableStatus,
              promotion_origin: "replay_stable_normalization",
            },
          },
        })],
        apply: async ({ commitId }) => {
          await applyNodeAuthorityPatchesV2({
            store: liteWriteStore,
            scope: args.tenancy.scope_key,
            patches: [patch],
            commitId,
          });
          return patch;
        },
        verify: async ({ commitId }) => verifyNodeAuthorityPatchesV2({
          store: liteWriteStore,
          scope: args.tenancy.scope_key,
          patches: [patch],
          commitId,
          errorLabel: "replay_stable_anchor",
        }),
      };
    },
  });

  const readCommittedNode = async (): Promise<LiteFindNodeRow> => {
    const committedRows = await liteWriteStore.findNodes({
      scope: args.tenancy.scope_key,
      id: latestNode.id,
      consumerAgentId: args.visibility.consumerAgentId,
      consumerTeamId: args.visibility.consumerTeamId,
      limit: 1,
      offset: 0,
    });
    const committed = committedRows.rows[0] ?? null;
    if (!committed) {
      throw new HttpError(404, "replay_playbook_not_found", "normalized playbook node is no longer visible", {
        playbook_id: args.playbookId,
        playbook_node_id: latestNode.id,
        scope: args.tenancy.scope,
        tenant_id: args.tenancy.tenant_id,
      });
    }
    return committed;
  };

  if (authority.status === "no_op") {
    return {
      mutated: false as const,
      node: await readCommittedNode(),
    };
  }

  if (desiredNodeFields.embedding && desiredNodeFields.embedding_model) {
    await liteWriteStore.setNodeEmbeddingReady({
      scope: args.tenancy.scope_key,
      id: latestNode.id,
      embedding: desiredNodeFields.embedding,
      embeddingModel: desiredNodeFields.embedding_model,
    });
  }

  const projectedNode = await readCommittedNode();
  if (args.replayMirror) {
    await args.replayMirror.upsertReplayNodes([
      buildReplayMirrorRecordFromLiteNode({
        scopeKey: args.tenancy.scope_key,
        playbookId: args.playbookId,
        node: projectedNode,
      }),
    ]);
  }

  return {
    mutated: true as const,
    node: projectedNode,
  };
}
