import stableStringify from "fast-json-stable-stringify";
import {
  ExecutionPacketV1Schema,
  ExecutionStateV1Schema,
  ServiceLifecycleConstraintV1Schema,
  type ExecutionPacketV1,
  type ExecutionStateV1,
} from "../execution/types.js";
import { ExecutionNativeV1Schema, MemoryAnchorV1Schema } from "./schemas.js";
import { buildExecutionContractFromProjection } from "./execution-contract.js";
import {
  resolveNodeAnchorKind,
  resolveNodeExecutionContract,
  resolveNodeExecutionContractTrust,
  resolveNodeExecutionKind,
  resolveNodeFilePath,
  resolveNodeNextAction,
  resolveNodePatternHints,
  resolveNodeServiceLifecycleConstraints,
  resolveNodeTaskFamily,
  resolveNodeTaskSignature,
  resolveNodeWorkflowSignature,
  resolveNodeWorkflowSteps,
  resolveNodeTargetFiles,
} from "./node-execution-surface.js";
import {
  buildDistillationMetadata,
  buildWorkflowMaintenanceMetadata,
  buildWorkflowPromotionMetadata,
} from "./evolution-operators.js";
import { sha256Hex } from "../util/crypto.js";
import { stableUuid } from "../util/uuid.js";
import type { PromoteMemoryLearningControlReviewProvider } from "./learning-control-provider-types.js";
import { buildPromotionEvidenceLedgerV1 } from "./promotion-evidence-ledger.js";
import { buildWorkflowPromotionLearningControlPreview } from "../kernel/learning-promotion-kernel.js";
import {
  adjudicatePolicyMutationV1,
  buildPolicyMutationFromWorkflowPromotion,
} from "../kernel/policy-mutation-loop.js";
import { buildOutcomeContractGate } from "./contract-trust.js";
import {
  buildRuntimeAuthorityEffect,
  sealRuntimeAuthorityEffectReceipt,
} from "./authority-effect-broker.js";

type WriteProjectionSourceNode = {
  id: string;
  client_id?: string;
  scope: string;
  type: string;
  memory_lane: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  title?: string;
  text_summary?: string;
  slots: Record<string, unknown>;
  embed_text?: string;
};

type WriteProjectionEdge = {
  id: string;
  scope: string;
  type: string;
  src_id: string;
  dst_id: string;
  weight?: number;
  confidence?: number;
  decay_rate?: number;
};

type LiteWorkflowProjectionStore = {
  findExecutionNativeNodes: (args: {
    scope: string;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
    executionKind?: "workflow_candidate" | "workflow_anchor" | null;
    workflowSignature?: string | null;
    limit: number;
    offset: number;
  }) => Promise<{ rows: Array<{ id: string; client_id?: string | null; slots?: Record<string, unknown> }>; has_more: boolean }>;
  findLatestNodeByClientId: (scope: string, type: string, clientId: string) => Promise<{ id: string } | null>;
  findNodes: (args: {
    scope: string;
    type?: string | null;
    clientId?: string | null;
    slotsContains?: Record<string, unknown> | null;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
    limit: number;
    offset: number;
  }) => Promise<{ rows: Array<{ id: string; client_id?: string | null; slots?: Record<string, unknown> }>; has_more: boolean }>;
};

type ProjectionResult = {
  nodes: WriteProjectionSourceNode[];
  edges: WriteProjectionEdge[];
};

type WorkflowProjectionAssessment =
  | { eligible: false; reason: "non_event" | "existing_workflow_memory" | "invalid_execution_state" | "invalid_execution_packet" | "missing_execution_continuity" }
  | {
      eligible: true;
      state: ExecutionStateV1 | null;
      packet: ExecutionPacketV1 | null;
      workflowSignature: string;
      projectionClientId: string;
      projectionObservationId: string;
      ownerAgentId: string | null;
      ownerTeamId: string | null;
    };

export type WorkflowProjectionExplainDecision =
  | "projected"
  | "skipped_existing_workflow_memory"
  | "skipped_invalid_execution_packet"
  | "skipped_invalid_execution_state"
  | "skipped_missing_execution_continuity"
  | "skipped_non_event"
  | "skipped_stable_exists"
  | "eligible_without_projection";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function normalizeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeFileList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))).sort();
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueLifecycleConstraints(
  values: unknown[],
  limit = 16,
): ExecutionStateV1["service_lifecycle_constraints"] {
  const out: ExecutionStateV1["service_lifecycle_constraints"] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const parsed = ServiceLifecycleConstraintV1Schema.safeParse(value);
    if (!parsed.success) continue;
    const key = [
      parsed.data.label,
      parsed.data.endpoint ?? "",
      parsed.data.launch_reference ?? "",
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
    if (out.length >= limit) break;
  }
  return out;
}

function readSourceExecutionContract(source: WriteProjectionSourceNode) {
  return resolveNodeExecutionContract({ slots: source.slots });
}

function collectWorkflowSteps(source: WriteProjectionSourceNode): string[] {
  return normalizeFileList([
    ...resolveNodeWorkflowSteps({ slots: source.slots }),
  ]);
}

function collectPatternHints(source: WriteProjectionSourceNode): string[] {
  return normalizeFileList([
    ...resolveNodePatternHints({ slots: source.slots }),
  ]);
}

function deriveContractTrustFromSource(source: WriteProjectionSourceNode): "authoritative" | "advisory" | "observational" | null {
  return resolveNodeExecutionContractTrust({ slots: source.slots });
}

function resolveWorkflowProjectionContractTrust(
  sourceTrust: "authoritative" | "advisory" | "observational" | null,
  executionContract: unknown,
): "authoritative" | "advisory" | "observational" | null {
  const requestedTrust = sourceTrust ?? "authoritative";
  const outcomeContractGate = buildOutcomeContractGate({
    executionContract,
    requestedTrust,
  });
  if (sourceTrust === "authoritative") {
    return outcomeContractGate.allows_authoritative ? "authoritative" : "advisory";
  }
  if (sourceTrust) return sourceTrust;
  return outcomeContractGate.status === "sufficient" ? "authoritative" : null;
}

function collectServiceLifecycleConstraints(
  source: WriteProjectionSourceNode,
  state: ExecutionStateV1 | null,
  packet: ExecutionPacketV1 | null,
): ExecutionStateV1["service_lifecycle_constraints"] {
  return uniqueLifecycleConstraints([
    ...resolveNodeServiceLifecycleConstraints({ slots: source.slots }),
    ...(state?.service_lifecycle_constraints ?? []),
    ...(packet?.service_lifecycle_constraints ?? []),
  ]);
}

function synthesizePacketFromLightweightHandoff(source: WriteProjectionSourceNode): ExecutionPacketV1 | null {
  const slots = asRecord(source.slots);
  const executionContract = readSourceExecutionContract(source);
  if (!slots) return null;
  if (firstString(slots.summary_kind) !== "handoff") return null;

  const handoffKind = firstString(slots.handoff_kind);
  const filePath = firstString(executionContract?.file_path, slots.file_path);
  const repoRoot = firstString(slots.repo_root);
  const symbol = firstString(slots.symbol);
  const explicitAnchor = firstString(slots.anchor);
  const anchor = explicitAnchor ?? (filePath ? `resume:${filePath}` : null);
  const taskBrief = firstString(slots.summary)
    ?? firstString(source.text_summary)
    ?? firstString(source.title);
  const targetFiles = normalizeFileList([
    ...(executionContract?.target_files ?? []),
    ...stringList(slots.target_files),
    ...(filePath ? [filePath] : []),
  ]);

  if (!handoffKind || !taskBrief || (!anchor && targetFiles.length === 0)) {
    return null;
  }

  const nextAction = firstString(executionContract?.next_action, slots.next_action)
    ?? firstString(slots.handoff_text)
    ?? taskBrief;
  const acceptanceChecks = normalizeFileList([
    ...(executionContract?.outcome.acceptance_checks ?? []),
    ...stringList(slots.acceptance_checks),
  ]);
  const mustChange = stringList(slots.must_change);
  const mustRemove = stringList(slots.must_remove);
  const mustKeep = stringList(slots.must_keep);
  const serviceLifecycleConstraints = uniqueLifecycleConstraints([
    ...(executionContract?.service_lifecycle_constraints ?? []),
    ...resolveNodeServiceLifecycleConstraints({ slots }),
  ]);
  const risk = firstString(slots.risk);
  const stateId = `handoff:${sha256Hex(stableStringify({
    source_node_id: source.id,
    handoff_kind: handoffKind,
    anchor,
    task_brief: taskBrief,
  })).slice(0, 24)}`;

  try {
    return ExecutionPacketV1Schema.parse({
      version: 1,
      state_id: stateId,
      current_stage: "resume",
      active_role: "resume",
      task_brief: taskBrief,
      target_files: targetFiles,
      next_action: nextAction,
      hard_constraints: mustChange,
      accepted_facts: [],
      rejected_paths: mustRemove,
      pending_validations: acceptanceChecks,
      unresolved_blockers: risk ? [risk] : [],
      rollback_notes: mustKeep,
      service_lifecycle_constraints: serviceLifecycleConstraints,
      review_contract: null,
      resume_anchor: anchor ? {
        anchor,
        file_path: filePath ?? null,
        symbol: symbol ?? null,
        repo_root: repoRoot ?? null,
      } : null,
      artifact_refs: [],
      evidence_refs: [],
    });
  } catch {
    return null;
  }
}

function taskBriefFromInputs(state: ExecutionStateV1 | null, packet: ExecutionPacketV1 | null): string | null {
  return firstString(state?.task_brief ?? null) ?? firstString(packet?.task_brief ?? null);
}

function collectTargetFiles(state: ExecutionStateV1, packet: ExecutionPacketV1 | null): string[] {
  const fromPacket = Array.isArray(packet?.target_files) ? packet.target_files : [];
  const fromState = state.owned_files.length > 0 ? state.owned_files : state.modified_files;
  return normalizeFileList([...(fromPacket ?? []), ...(fromState ?? [])]);
}

function collectTargetFilesFromInputs(state: ExecutionStateV1 | null, packet: ExecutionPacketV1 | null): string[] {
  if (state) return collectTargetFiles(state, packet);
  return normalizeFileList(Array.isArray(packet?.target_files) ? packet.target_files : []);
}

function collectAcceptanceChecks(state: ExecutionStateV1 | null, packet: ExecutionPacketV1 | null): string[] {
  return normalizeFileList([
    ...(state?.pending_validations ?? []),
    ...(state?.completed_validations ?? []),
    ...(state?.reviewer_contract?.acceptance_checks ?? []),
    ...(packet?.pending_validations ?? []),
    ...(packet?.review_contract?.acceptance_checks ?? []),
  ]);
}

function deriveWorkflowSignatureFromInputs(state: ExecutionStateV1 | null, packet: ExecutionPacketV1 | null): string {
  const resumeAnchor = state?.resume_anchor ?? packet?.resume_anchor ?? null;
  const payload = {
    task_brief: normalizeLabel(taskBriefFromInputs(state, packet)),
    target_files: collectTargetFilesFromInputs(state, packet),
    resume_anchor: resumeAnchor ? {
      anchor: normalizeLabel(resumeAnchor.anchor),
      file_path: normalizeLabel(resumeAnchor.file_path),
      symbol: normalizeLabel(resumeAnchor.symbol),
      repo_root: normalizeLabel(resumeAnchor.repo_root),
    } : null,
  };
  return `execution_workflow:${sha256Hex(stableStringify(payload)).slice(0, 24)}`;
}

function deriveTaskSignatureFromInputs(state: ExecutionStateV1 | null, packet: ExecutionPacketV1 | null): string {
  const resumeAnchor = state?.resume_anchor ?? packet?.resume_anchor ?? null;
  const payload = {
    task_brief: normalizeLabel(taskBriefFromInputs(state, packet)),
    anchor: normalizeLabel(resumeAnchor?.anchor ?? null),
    file_path: normalizeLabel(resumeAnchor?.file_path ?? null),
    symbol: normalizeLabel(resumeAnchor?.symbol ?? null),
  };
  return `execution_task:${sha256Hex(stableStringify(payload)).slice(0, 24)}`;
}

function deriveTaskFamilyFromSource(source: WriteProjectionSourceNode): string | null {
  return resolveNodeTaskFamily({ slots: source.slots });
}

function resolveWorkflowProjectionDistillationSourceKind(
  source: WriteProjectionSourceNode,
): "execution_projection" | "handoff_carrier" | "session_event_carrier" | "session_carrier" {
  const slots = asRecord(source.slots);
  const summaryKind = firstString(slots?.summary_kind);
  // Only treat explicit handoff surfaces as handoff carriers. Generic execution-native
  // writes may use summary_kind=handoff without coming from the handoff route.
  if (summaryKind === "handoff" && firstString(slots?.handoff_kind)) return "handoff_carrier";

  const systemKind = firstString(slots?.system_kind);
  if (systemKind === "session_event") return "session_event_carrier";
  if (systemKind === "session") return "session_carrier";
  return "execution_projection";
}

function deriveWorkflowProjectionObservationId(
  source: WriteProjectionSourceNode,
  state: ExecutionStateV1 | null,
  packet: ExecutionPacketV1 | null,
): string {
  const sourceKind = resolveWorkflowProjectionDistillationSourceKind(source);
  if (sourceKind === "session_carrier") {
    return firstString(state?.state_id ?? null, packet?.state_id ?? null)
      ?? firstString(source.client_id)
      ?? source.id;
  }
  return firstString(source.client_id) ?? source.id;
}

function limitSchemaText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function deriveCandidateTitle(
  source: WriteProjectionSourceNode,
  state: ExecutionStateV1 | null,
  packet: ExecutionPacketV1 | null,
): string {
  return limitSchemaText(
    taskBriefFromInputs(state, packet) ?? firstString(source.title) ?? "Execution Workflow Candidate",
    200,
  );
}

function buildCandidateSummary(state: ExecutionStateV1 | null, packet: ExecutionPacketV1 | null): string {
  const targetFiles = collectTargetFilesFromInputs(state, packet);
  const parts = [
    taskBriefFromInputs(state, packet),
    targetFiles.length > 0 ? `targets=${targetFiles.join(", ")}` : null,
    firstString(packet?.next_action ?? null),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return parts.join("; ").slice(0, 400) || taskBriefFromInputs(state, packet) || "Execution workflow candidate";
}

function buildCandidateEmbedText(title: string, summary: string): string {
  return `${title}; ${summary}`;
}

function deriveWorkflowToolSet(state: ExecutionStateV1 | null, packet: ExecutionPacketV1 | null): string[] {
  const tools: string[] = [];
  const targetFiles = collectTargetFilesFromInputs(state, packet);
  if (targetFiles.length > 0) tools.push("edit");
  if (
    (state?.pending_validations.length ?? 0) > 0
    || (state?.completed_validations.length ?? 0) > 0
    || (packet?.pending_validations.length ?? 0) > 0
  ) {
    tools.push("test");
  }
  return Array.from(new Set(tools));
}

function buildProjectionClientId(sourceNodeId: string, workflowSignature: string): string {
  return `workflow_projection:${sourceNodeId}:${workflowSignature}`;
}

function sourceAlreadyCarriesWorkflowMemory(node: WriteProjectionSourceNode): boolean {
  const executionKind = resolveNodeExecutionKind(node.slots);
  const anchorKind = resolveNodeAnchorKind(node.slots);
  return executionKind === "workflow_candidate"
    || executionKind === "workflow_anchor"
    || anchorKind === "workflow";
}

export function assessWorkflowProjectionSourceNode(source: WriteProjectionSourceNode): WorkflowProjectionAssessment {
  const systemKind = firstString(asRecord(source.slots)?.system_kind);
  const isSessionTopicCarrier = source.type === "topic" && systemKind === "session";
  if (source.type !== "event" && !isSessionTopicCarrier) {
    return { eligible: false, reason: "non_event" };
  }
  if (sourceAlreadyCarriesWorkflowMemory(source)) {
    return { eligible: false, reason: "existing_workflow_memory" };
  }

  const rawState = source.slots?.execution_state_v1;
  const stateParsed = rawState ? ExecutionStateV1Schema.safeParse(rawState) : null;
  if (stateParsed && !stateParsed.success) {
    return { eligible: false, reason: "invalid_execution_state" };
  }

  const packetParsed = source.slots?.execution_packet_v1
    ? ExecutionPacketV1Schema.safeParse(source.slots.execution_packet_v1)
    : null;
  if (packetParsed && !packetParsed.success) {
    return { eligible: false, reason: "invalid_execution_packet" };
  }

  const state = stateParsed?.success ? stateParsed.data : null;
  const packet = packetParsed?.success ? packetParsed.data : synthesizePacketFromLightweightHandoff(source);
  if (!state && !packet) {
    return { eligible: false, reason: "missing_execution_continuity" };
  }

  const sourceExecutionContract = readSourceExecutionContract(source);
  const workflowSignature = firstString(sourceExecutionContract?.workflow_signature)
    ?? resolveNodeWorkflowSignature({ slots: source.slots })
    ?? deriveWorkflowSignatureFromInputs(state, packet);
  const projectionObservationId = deriveWorkflowProjectionObservationId(source, state, packet);
  return {
    eligible: true,
    state,
    packet,
    workflowSignature,
    projectionClientId: buildProjectionClientId(projectionObservationId, workflowSignature),
    projectionObservationId,
    ownerAgentId: source.owner_agent_id ?? source.producer_agent_id ?? null,
    ownerTeamId: source.owner_team_id ?? null,
  };
}

function buildWorkflowProjectionExecutionContract(args: {
  source: WriteProjectionSourceNode;
  contractTrust: "authoritative" | "advisory" | "observational" | null;
  taskSignature: string;
  taskFamily: string | null;
  workflowSignature: string;
  filePath: string | null;
  targetFiles: string[];
  acceptanceChecks: string[];
  nextAction: string | null;
  workflowSteps: string[];
  patternHints: string[];
  serviceLifecycleConstraints: ExecutionStateV1["service_lifecycle_constraints"];
}){
  return buildExecutionContractFromProjection({
    contract_trust: args.contractTrust,
    task_family: args.taskFamily,
    task_signature: args.taskSignature,
    workflow_signature: args.workflowSignature,
    file_path: args.filePath,
    target_files: args.targetFiles,
    acceptance_checks: args.acceptanceChecks,
    next_action: args.nextAction,
    workflow_steps: args.workflowSteps,
    pattern_hints: args.patternHints,
    service_lifecycle_constraints: args.serviceLifecycleConstraints,
    provenance: {
      source_kind: "workflow_projection",
      source_summary_version: "execution_write_projection_v1",
      source_anchor: args.source.id,
      evidence_refs: [args.source.id],
      notes: [firstString(args.source.title, args.source.text_summary) ?? "workflow write projection"],
    },
  });
}

export function countDistinctWorkflowObservations(rows: Array<{ id: string; client_id?: string | null }>): number {
  return Array.from(new Set(rows.map((row) => deriveWorkflowObservationIdentity(row)))).length;
}

function deriveWorkflowObservationIdentity(row: {
  id: string;
  client_id?: string | null;
  slots?: Record<string, unknown> | null;
}): string {
  const projection = asRecord(asRecord(row.slots)?.workflow_write_projection);
  return firstString(projection?.source_observation_id)
    ?? firstString(projection?.source_client_id)
    ?? firstString(projection?.source_node_id)
    ?? firstString(row.client_id)
    ?? row.id;
}

async function findLinkedWorkflowProjection(args: {
  liteWriteStore: LiteWorkflowProjectionStore;
  scope: string;
  source: WriteProjectionSourceNode;
  projectionObservationId: string;
  consumerAgentId?: string | null;
  consumerTeamId?: string | null;
}): Promise<boolean> {
  const defaultObservationId = firstString(args.source.client_id) ?? args.source.id;
  const queries: Array<Record<string, unknown>> = [];
  if (args.projectionObservationId !== defaultObservationId) {
    queries.push({
      workflow_write_projection: {
        source_observation_id: args.projectionObservationId,
      },
    });
  } else if (args.source.client_id) {
    queries.push({
      workflow_write_projection: {
        source_client_id: args.source.client_id,
      },
    });
    queries.push({
      workflow_write_projection: {
        source_node_id: args.source.id,
      },
    });
  }

  for (const type of ["event", "procedure"] as const) {
    for (const slotsContains of queries) {
      const result = await args.liteWriteStore.findNodes({
        scope: args.scope,
        type,
        slotsContains,
        consumerAgentId: args.consumerAgentId,
        consumerTeamId: args.consumerTeamId,
        limit: 20,
        offset: 0,
      });
      if (result.rows.length > 0) return true;
    }
  }

  return false;
}

export async function explainWorkflowProjectionForSourceNode(args: {
  scope: string;
  source: WriteProjectionSourceNode;
  liteWriteStore: LiteWorkflowProjectionStore;
}): Promise<{
  decision: WorkflowProjectionExplainDecision;
  workflowSignature: string | null;
  projectionClientId: string | null;
}> {
  const assessment = assessWorkflowProjectionSourceNode(args.source);
  if (!assessment.eligible) {
    return {
      decision: ({
        non_event: "skipped_non_event",
        existing_workflow_memory: "skipped_existing_workflow_memory",
        invalid_execution_state: "skipped_invalid_execution_state",
        invalid_execution_packet: "skipped_invalid_execution_packet",
        missing_execution_continuity: "skipped_missing_execution_continuity",
      } as const)[assessment.reason],
      workflowSignature: null,
      projectionClientId: null,
    };
  }

  const { workflowSignature, projectionClientId, projectionObservationId, ownerAgentId, ownerTeamId } = assessment;
  const existingStable = await args.liteWriteStore.findExecutionNativeNodes({
    scope: args.scope,
    consumerAgentId: ownerAgentId,
    consumerTeamId: ownerTeamId,
    executionKind: "workflow_anchor",
    workflowSignature,
    limit: 20,
    offset: 0,
  });
  const existingProjection = await args.liteWriteStore.findLatestNodeByClientId(args.scope, "event", projectionClientId);
  const linkedProjection = await findLinkedWorkflowProjection({
    liteWriteStore: args.liteWriteStore,
    scope: args.scope,
    source: args.source,
    projectionObservationId,
    consumerAgentId: ownerAgentId,
    consumerTeamId: ownerTeamId,
  });

  if (existingProjection || linkedProjection) {
    return {
      decision: "projected",
      workflowSignature,
      projectionClientId,
    };
  }
  if (existingStable.rows.length > 0) {
    return {
      decision: "skipped_stable_exists",
      workflowSignature,
      projectionClientId,
    };
  }
  return {
    decision: "eligible_without_projection",
    workflowSignature,
    projectionClientId,
  };
}

function buildStableWorkflowAnchor(args: {
  scope: string;
  clientId: string;
  sourceNodeId: string;
  title: string;
  summary: string;
  taskSignature: string;
  taskFamily: string | null;
  workflowSignature: string;
  toolSet: string[];
  filePath: string | null;
  targetFiles: string[];
  nextAction: string | null;
  workflowSteps: string[];
  patternHints: string[];
  serviceLifecycleConstraints: ExecutionStateV1["service_lifecycle_constraints"];
  contractTrust: "authoritative" | "advisory" | "observational" | null;
  observedCount: number;
  supportingNodeIds: string[];
  promotedAt: string;
}) {
  return MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: "L2",
    ...(args.contractTrust ? { contract_trust: args.contractTrust } : {}),
    task_signature: args.taskSignature,
    task_class: "execution_write_projection",
    ...(args.taskFamily ? { task_family: args.taskFamily } : {}),
    workflow_signature: args.workflowSignature,
    summary: args.summary,
    tool_set: args.toolSet,
    file_path: args.filePath,
    target_files: args.targetFiles,
    next_action: args.nextAction,
    ...(args.workflowSteps.length > 0 ? { key_steps: args.workflowSteps } : {}),
    ...(args.patternHints.length > 0 ? { pattern_hints: args.patternHints } : {}),
    ...(args.serviceLifecycleConstraints.length > 0 ? { service_lifecycle_constraints: args.serviceLifecycleConstraints } : {}),
    outcome: {
      status: "success",
      result_class: "execution_write_stable",
      success_score: 0.82,
    },
    source: {
      source_kind: "execution_write",
      node_id: args.sourceNodeId,
      run_id: null,
      playbook_id: null,
      commit_id: null,
    },
    payload_refs: {
      node_ids: Array.from(new Set([args.sourceNodeId, ...args.supportingNodeIds])),
      decision_ids: [],
      run_ids: [],
      step_ids: [],
      commit_ids: [],
    },
    rehydration: {
      default_mode: "partial",
      payload_cost_hint: args.supportingNodeIds.length > 2 ? "medium" : "low",
      recommended_when: [
        "workflow_summary_is_not_enough",
        "resume_anchor_requires_detail",
      ],
    },
    recall_features: {
      tool_tags: args.toolSet,
      outcome_tags: ["execution_write", "stable"],
      keywords: [args.title, args.summary]
        .map((value) => limitSchemaText(value.trim(), 256))
        .filter((value) => value.length > 0)
        .slice(0, 8),
    },
    metrics: {
      usage_count: 0,
      reuse_success_count: 0,
      reuse_failure_count: 0,
      distinct_run_count: 0,
      last_used_at: null,
    },
    maintenance: {
      ...buildWorkflowMaintenanceMetadata({
        promotion_state: "stable",
        at: args.promotedAt,
      }),
    },
    workflow_promotion: buildWorkflowPromotionMetadata({
      promotion_state: "stable",
      promotion_origin: "execution_write_auto_promotion",
      required_observations: 2,
      observed_count: args.observedCount,
      source_status: null,
      at: args.promotedAt,
    }),
    schema_version: "anchor_v1",
  });
}

export async function projectWorkflowCandidatesFromPreparedWrite(args: {
  scope: string;
  nodes: WriteProjectionSourceNode[];
  liteWriteStore: LiteWorkflowProjectionStore;
  learningControlReviewProviders?: {
    promote_memory?: PromoteMemoryLearningControlReviewProvider | null;
  };
  now?: string;
}): Promise<ProjectionResult> {
  const nodes: WriteProjectionSourceNode[] = [];
  const edges: WriteProjectionEdge[] = [];
  const now = args.now ?? new Date().toISOString();
  const seenSignatures = new Set<string>();

  for (const source of args.nodes) {
    const assessment = assessWorkflowProjectionSourceNode(source);
    if (!assessment.eligible) continue;

    const {
      state,
      packet,
      workflowSignature,
      projectionClientId,
      projectionObservationId,
      ownerAgentId,
      ownerTeamId,
    } = assessment;
    if (seenSignatures.has(workflowSignature)) continue;
    seenSignatures.add(workflowSignature);

    const existingStable = await args.liteWriteStore.findExecutionNativeNodes({
      scope: args.scope,
      consumerAgentId: ownerAgentId,
      consumerTeamId: ownerTeamId,
      executionKind: "workflow_anchor",
      workflowSignature,
      limit: 20,
      offset: 0,
    });
    if (existingStable.rows.length > 0) continue;

    const existingProjection = await args.liteWriteStore.findLatestNodeByClientId(args.scope, "event", projectionClientId);
    if (existingProjection) continue;
    const linkedProjection = await findLinkedWorkflowProjection({
      liteWriteStore: args.liteWriteStore,
      scope: args.scope,
      source,
      projectionObservationId,
      consumerAgentId: ownerAgentId,
      consumerTeamId: ownerTeamId,
    });
    if (linkedProjection) continue;

    const existingCandidates = await args.liteWriteStore.findExecutionNativeNodes({
      scope: args.scope,
      consumerAgentId: ownerAgentId,
      consumerTeamId: ownerTeamId,
      executionKind: "workflow_candidate",
      workflowSignature,
      limit: 200,
      offset: 0,
    });
    const observedCount = countDistinctWorkflowObservations(existingCandidates.rows) + 1;
    const requiredObservations = 2;
    const sourceExecutionContract = readSourceExecutionContract(source);
    const title = deriveCandidateTitle(source, state, packet);
    const summary = buildCandidateSummary(state, packet);
    const taskSignature = resolveNodeTaskSignature({ slots: source.slots }) ?? deriveTaskSignatureFromInputs(state, packet);
    const taskFamily = deriveTaskFamilyFromSource(source);
    const sourceTargetFiles = resolveNodeTargetFiles({ slots: source.slots });
    const targetFiles = sourceTargetFiles.length > 0 ? sourceTargetFiles : collectTargetFilesFromInputs(state, packet);
    const acceptanceChecks = collectAcceptanceChecks(state, packet);
    const filePath = resolveNodeFilePath({ slots: source.slots })
      ?? firstString(packet?.resume_anchor?.file_path ?? null)
      ?? targetFiles[0]
      ?? null;
    const nextAction = resolveNodeNextAction({ slots: source.slots })
      ?? firstString(packet?.next_action ?? null);
    const workflowSteps = collectWorkflowSteps(source);
    const patternHints = collectPatternHints(source);
    const serviceLifecycleConstraints = collectServiceLifecycleConstraints(source, state, packet);
    const sourceContractTrust = deriveContractTrustFromSource(source);
    const toolSet = deriveWorkflowToolSet(state, packet);
    let executionContract = buildWorkflowProjectionExecutionContract({
      source,
      contractTrust: sourceContractTrust,
      taskSignature,
      taskFamily,
      workflowSignature,
      filePath,
      targetFiles,
      acceptanceChecks,
      nextAction,
      workflowSteps,
      patternHints,
      serviceLifecycleConstraints,
    });
    const contractTrust = resolveWorkflowProjectionContractTrust(sourceContractTrust, executionContract);
    if (contractTrust !== sourceContractTrust) {
      executionContract = buildWorkflowProjectionExecutionContract({
        source,
        contractTrust,
        taskSignature,
        taskFamily,
        workflowSignature,
        filePath,
        targetFiles,
        acceptanceChecks,
        nextAction,
        workflowSteps,
        patternHints,
        serviceLifecycleConstraints,
      });
    }
    const {
      authorityGate,
      outcomeContractGate,
      executionEvidence,
      executionEvidenceAssessment,
    } = buildRuntimeAuthorityEffect({
      effectKind: "workflow_candidate_projection",
      executionContract,
      requestedTrust: contractTrust,
      slots: source.slots,
    });
    const distillationSourceKind = resolveWorkflowProjectionDistillationSourceKind(source);

    const executionNative = ExecutionNativeV1Schema.parse({
      schema_version: "execution_native_v1",
      execution_kind: "workflow_candidate",
      summary_kind: "workflow_candidate",
      compression_layer: "L1",
      ...(contractTrust ? { contract_trust: contractTrust } : {}),
      task_signature: taskSignature,
      ...(taskFamily ? { task_family: taskFamily } : {}),
      workflow_signature: workflowSignature,
      anchor_kind: "workflow",
      anchor_level: "L1",
      workflow_promotion: buildWorkflowPromotionMetadata({
        promotion_state: "candidate",
        promotion_origin: "execution_write_projection",
        required_observations: requiredObservations,
        observed_count: observedCount,
        source_status: null,
        at: now,
      }),
      maintenance: buildWorkflowMaintenanceMetadata({
        promotion_state: "candidate",
        at: now,
      }),
      distillation: buildDistillationMetadata({
        source_kind: distillationSourceKind,
        distillation_kind: "workflow_candidate",
        at: now,
        source_node_id: source.id,
      }),
      file_path: filePath,
      target_files: targetFiles,
      next_action: nextAction,
      ...(workflowSteps.length > 0 ? { workflow_steps: workflowSteps } : {}),
      ...(patternHints.length > 0 ? { pattern_hints: patternHints } : {}),
      ...(serviceLifecycleConstraints.length > 0 ? { service_lifecycle_constraints: serviceLifecycleConstraints } : {}),
      outcome_contract_gate: outcomeContractGate,
    });

    const projectedNodeId = stableUuid(`${args.scope}:node:${projectionClientId}`);
    let learningControlPreview:
      | Awaited<ReturnType<typeof buildWorkflowPromotionLearningControlPreview>>
      | null = null;
    if (observedCount >= requiredObservations) {
      const learningControlContractTrust = sourceContractTrust === "authoritative" ? "authoritative" : contractTrust;
      const workflowPromotionLearningControlReview = asRecord(source.slots?.workflow_promotion_learning_control_review);
      const promoteMemoryLearningControlReview = asRecord(workflowPromotionLearningControlReview?.promote_memory);
      learningControlPreview = await buildWorkflowPromotionLearningControlPreview({
        candidateNodeIds: Array.from(new Set([projectedNodeId, ...existingCandidates.rows.map((row) => row.id)])),
        inputText: summary,
        inputSha256: sha256Hex(summary),
        candidateExamples: [
          {
            node_id: projectedNodeId,
            title,
            summary,
            task_signature: taskSignature,
            ...(taskFamily ? { task_family: taskFamily } : {}),
            workflow_signature: workflowSignature,
            outcome_status: "candidate",
            success_score: 0.5,
          },
        ],
        contractTrust: learningControlContractTrust,
        executionContract,
        executionEvidenceAssessment,
        reviewResult: (promoteMemoryLearningControlReview?.review_result ?? null) as any,
        reviewProvider: args.learningControlReviewProviders?.promote_memory ?? undefined,
      });
    }

    nodes.push({
      id: projectedNodeId,
      client_id: projectionClientId,
      scope: args.scope,
      type: "event",
      memory_lane: source.memory_lane,
      producer_agent_id: source.producer_agent_id,
      owner_agent_id: source.owner_agent_id,
      owner_team_id: source.owner_team_id,
      title,
      text_summary: summary,
      embed_text: buildCandidateEmbedText(title, summary),
      slots: {
        summary_kind: "workflow_candidate",
        compression_layer: "L1",
        lifecycle_state: "active",
        archive_candidate: true,
        ...(contractTrust ? { contract_trust: contractTrust } : {}),
        target_files: targetFiles,
        ...(workflowSteps.length > 0 ? { workflow_steps: workflowSteps } : {}),
        ...(patternHints.length > 0 ? { pattern_hints: patternHints } : {}),
        ...(serviceLifecycleConstraints.length > 0 ? { service_lifecycle_constraints: serviceLifecycleConstraints } : {}),
        execution_contract_v1: executionContract,
        outcome_contract_gate: outcomeContractGate,
        ...(executionEvidence ? { execution_evidence_v1: executionEvidence } : {}),
        execution_evidence_assessment: executionEvidenceAssessment,
        authority_gate_v1: authorityGate,
        execution_native_v1: executionNative,
        workflow_write_projection: {
          generated_by: "execution_write_projection_v1",
          source_node_id: source.id,
          source_client_id: source.client_id ?? null,
          source_observation_id: projectionObservationId,
          generated_at: now,
          workflow_signature: workflowSignature,
          ...(learningControlPreview ? {
            learning_control_preview: {
              promote_memory: learningControlPreview.promote_memory,
            },
          } : {}),
        },
      },
    });
    edges.push({
      id: stableUuid(`${args.scope}:edge:workflow_write_projection:derived_from:${projectedNodeId}:${source.id}`),
      scope: args.scope,
      type: "derived_from",
      src_id: projectedNodeId,
      dst_id: source.id,
    });

    if (
      observedCount >= requiredObservations
      && learningControlPreview?.runtime_apply.promotion_state_override === "stable"
      && contractTrust === "authoritative"
      && authorityGate.allows_authoritative
      && authorityGate.allows_stable_promotion
    ) {
      const stableClientId = `workflow_projection:stable:${workflowSignature}`;
      const stableNodeId = stableUuid(`${args.scope}:node:${stableClientId}`);
      const stableAnchor = buildStableWorkflowAnchor({
        scope: args.scope,
        clientId: stableClientId,
        sourceNodeId: source.id,
        title,
        summary,
        taskSignature,
        taskFamily,
        workflowSignature,
        toolSet,
        filePath,
        targetFiles,
        nextAction,
        workflowSteps,
        patternHints,
        serviceLifecycleConstraints,
        contractTrust,
        observedCount,
        supportingNodeIds: existingCandidates.rows.map((row) => row.id),
        promotedAt: now,
      });
      const stableExecutionContract = buildWorkflowProjectionExecutionContract({
        source,
        contractTrust,
        taskSignature: stableAnchor.task_signature,
        taskFamily: stableAnchor.task_family ?? null,
        workflowSignature: stableAnchor.workflow_signature ?? workflowSignature,
        filePath: stableAnchor.file_path ?? null,
        targetFiles: stableAnchor.target_files ?? [],
        acceptanceChecks,
        nextAction: stableAnchor.next_action ?? null,
        workflowSteps: stableAnchor.key_steps ?? [],
        patternHints: stableAnchor.pattern_hints ?? [],
        serviceLifecycleConstraints: stableAnchor.service_lifecycle_constraints ?? [],
      });
      const {
        authorityGate: stableAuthorityGate,
        outcomeContractGate: stableOutcomeContractGate,
        executionEvidence: stableExecutionEvidence,
        executionEvidenceAssessment: stableExecutionEvidenceAssessment,
      } = buildRuntimeAuthorityEffect({
        effectKind: "stable_workflow_projection",
        executionContract: stableExecutionContract,
        requestedTrust: contractTrust,
        slots: source.slots,
        evidence: executionEvidence,
      });
      const policyMutation = buildPolicyMutationFromWorkflowPromotion({
        scope: args.scope,
        workflow_memory_id: stableNodeId,
        workflow_signature: stableAnchor.workflow_signature ?? workflowSignature,
        task_signature: stableAnchor.task_signature,
        source_node_id: source.id,
        origin: "execution_write_projection",
        observed_count: observedCount,
        required_observations: 2,
        authority_gate_allows_stable_promotion: stableAuthorityGate.allows_stable_promotion,
        learning_control_admissible: learningControlPreview.promote_memory.admissibility?.admissible === true,
        runtime_apply_changed_promotion_state: learningControlPreview.runtime_apply.changed_promotion_state,
        execution_evidence_status: stableExecutionEvidenceAssessment.status,
        execution_evidence_refs: stableExecutionEvidence?.evidence_refs ?? [],
      });
      const policyMutationAdjudication = adjudicatePolicyMutationV1(policyMutation);
      const promotionEvidenceLedger = buildPromotionEvidenceLedgerV1({
        targetKind: "workflow",
        targetId: stableNodeId,
        sourceLayers: ["L1"],
        targetLayer: "L2",
        transition: "L1_to_L2",
        promotionState: "stable",
        promotionOrigin: "execution_write_projection",
        observedCount,
        requiredCount: 2,
        authorityGateAdmitted: stableAuthorityGate.allows_stable_promotion,
        learningControlAdmitted: learningControlPreview.promote_memory.admissibility?.admissible === true,
        verifierStatus: stableExecutionEvidenceAssessment.status,
        contractTrust,
        sourceNodeIds: [source.id, projectedNodeId, ...existingCandidates.rows.map((row) => row.id)],
        promotionEvidenceRefs: [
          ...(stableExecutionEvidence?.evidence_refs ?? []),
          ...policyMutation.promotion_evidence_refs,
        ],
        reasonCodes: ["workflow_write_projection_auto_promote", "learning_control_preview_admitted"],
        evidence: [
          {
            evidence_id: `${stableNodeId}:observation_gate`,
            evidence_kind: "distinct_observation",
            polarity: observedCount >= 2 ? "positive" : "neutral",
            source_ref: projectedNodeId,
            claim: `observed ${observedCount} of 2 required workflow observations`,
            confidence: 0.86,
          },
          {
            evidence_id: `${stableNodeId}:authority_gate`,
            evidence_kind: "authority_gate",
            polarity: stableAuthorityGate.allows_stable_promotion ? "positive" : "negative",
            source_ref: `${source.id}:authority_gate_v1`,
            claim: stableAuthorityGate.allows_stable_promotion
              ? "authority gate admits stable workflow promotion"
              : "authority gate blocks stable workflow promotion",
            confidence: 0.86,
          },
          {
            evidence_id: `${stableNodeId}:learning_control`,
            evidence_kind: "learning_control",
            polarity: learningControlPreview.promote_memory.admissibility?.admissible === true ? "positive" : "negative",
            source_ref: `${projectedNodeId}:learning_control_preview`,
            claim: learningControlPreview.promote_memory.admissibility?.admissible === true
              ? "learning control preview admitted stable workflow promotion"
              : "learning control preview did not admit stable workflow promotion",
            confidence: 0.86,
          },
          ...(stableExecutionEvidence?.evidence_refs?.[0]
            ? [{
                evidence_id: `${stableNodeId}:runtime_verifier`,
                evidence_kind: "runtime_verifier" as const,
                polarity: stableExecutionEvidenceAssessment.status === "succeeded" ? "positive" as const : "negative" as const,
                source_ref: stableExecutionEvidence.evidence_refs[0],
                claim: `execution evidence status ${stableExecutionEvidenceAssessment.status}`,
                confidence: stableExecutionEvidenceAssessment.status === "succeeded" ? 0.9 : 0.48,
              }]
            : []),
        ],
      });
      const stableAnchorWithPromotionLedger = MemoryAnchorV1Schema.parse({
        ...stableAnchor,
        promotion_evidence_ledger_v1: promotionEvidenceLedger,
      });
      const stableSlots: Record<string, unknown> = {
        summary_kind: "workflow_anchor",
        compression_layer: "L2",
        anchor_v1: stableAnchorWithPromotionLedger,
        execution_contract_v1: stableExecutionContract,
        outcome_contract_gate: stableOutcomeContractGate,
        ...(stableExecutionEvidence ? { execution_evidence_v1: stableExecutionEvidence } : {}),
        execution_evidence_assessment: stableExecutionEvidenceAssessment,
        authority_gate_v1: stableAuthorityGate,
        policy_mutation_v1: policyMutation,
        policy_mutation_adjudication_v1: policyMutationAdjudication,
        promotion_evidence_ledger_v1: promotionEvidenceLedger,
        execution_native_v1: {
          schema_version: "execution_native_v1",
          execution_kind: "workflow_anchor",
          summary_kind: "workflow_anchor",
          compression_layer: "L2",
          ...(contractTrust ? { contract_trust: contractTrust } : {}),
          task_signature: stableAnchor.task_signature,
          ...(stableAnchor.task_family ? { task_family: stableAnchor.task_family } : {}),
          workflow_signature: stableAnchor.workflow_signature,
          anchor_kind: "workflow",
          anchor_level: "L2",
          tool_set: stableAnchor.tool_set,
          file_path: stableAnchor.file_path ?? null,
          target_files: stableAnchor.target_files ?? [],
          next_action: stableAnchor.next_action ?? null,
          ...(stableAnchor.key_steps && stableAnchor.key_steps.length > 0 ? { workflow_steps: stableAnchor.key_steps } : {}),
          ...(stableAnchor.pattern_hints && stableAnchor.pattern_hints.length > 0 ? { pattern_hints: stableAnchor.pattern_hints } : {}),
          ...(stableAnchor.service_lifecycle_constraints && stableAnchor.service_lifecycle_constraints.length > 0
            ? { service_lifecycle_constraints: stableAnchor.service_lifecycle_constraints }
            : {}),
          outcome_contract_gate: stableOutcomeContractGate,
          workflow_promotion: stableAnchor.workflow_promotion,
          maintenance: stableAnchor.maintenance,
          rehydration: stableAnchor.rehydration,
          promotion_evidence_ledger_v1: promotionEvidenceLedger,
          distillation: buildDistillationMetadata({
            source_kind: distillationSourceKind,
            distillation_kind: "workflow_candidate",
            at: now,
            source_node_id: source.id,
          }),
        },
        workflow_write_projection: {
          generated_by: "execution_write_projection_v1",
          source_node_id: source.id,
          source_client_id: source.client_id ?? null,
          source_observation_id: projectionObservationId,
          generated_at: now,
          workflow_signature: workflowSignature,
          auto_promoted: true,
          observed_count: observedCount,
          ...(contractTrust ? { contract_trust: contractTrust } : {}),
          ...(learningControlPreview.runtime_apply.promotion_state_override
            ? { learning_control_promotion_state_override: learningControlPreview.runtime_apply.promotion_state_override }
            : {}),
          learning_control_preview: {
            promote_memory: learningControlPreview.promote_memory,
          },
        },
      };
      sealRuntimeAuthorityEffectReceipt({
        effectKind: "stable_workflow_projection",
        node: {
          id: stableNodeId,
          client_id: stableClientId,
          scope: args.scope,
          type: "procedure",
          slots: stableSlots,
        },
        slots: stableSlots,
        authorityGate: stableAuthorityGate,
        issuedAt: now,
        mutate: true,
        requireAuthorityClaims: true,
      });

      nodes.push({
        id: stableNodeId,
        client_id: stableClientId,
        scope: args.scope,
        type: "procedure",
        memory_lane: source.memory_lane,
        producer_agent_id: source.producer_agent_id,
        owner_agent_id: source.owner_agent_id,
        owner_team_id: source.owner_team_id,
        title,
        text_summary: stableAnchor.summary,
        embed_text: buildCandidateEmbedText(title, stableAnchor.summary),
        slots: stableSlots,
      });
      edges.push({
        id: stableUuid(`${args.scope}:edge:workflow_write_projection:derived_from:${stableNodeId}:${source.id}`),
        scope: args.scope,
        type: "derived_from",
        src_id: stableNodeId,
        dst_id: source.id,
      });
      edges.push({
        id: stableUuid(`${args.scope}:edge:workflow_write_projection:derived_from:${stableNodeId}:${projectedNodeId}`),
        scope: args.scope,
        type: "derived_from",
        src_id: stableNodeId,
        dst_id: projectedNodeId,
      });
    }
  }

  return { nodes, edges };
}
