import type { ContractTrust } from "../../app/planning-summary.js";
import {
  parseAionisMemoryPacket,
  type AionisGuidePacket,
  type AionisLifecycleCandidateSignal,
  type AionisMemoryDomain,
  type AionisMemoryPacket,
  type AionisRecallSourceTrace,
} from "../product-output-contract.js";
import type { AionisGuidanceAuthority, AionisMemoryDecisionSurface, GovernanceDecisionV1 } from "../governance-contract.js";
import {
  decideGovernedMemory,
  type GovernanceRequestContext,
} from "../governance-decision.js";
import {
  authorityConsumptionStateFromValue,
} from "../authority-consumption.js";
import { normalizeExecutionOutcomeRoleFromValue } from "../execution-outcome-role.js";
import {
  resolveNodeAnchorKind,
  resolveNodeArchiveRelocationSurface,
  resolveNodeCompressionLayer,
  resolveNodeCredibilityState,
  resolveNodeExecutionContractTrust,
  resolveNodeExecutionKind,
  resolveNodeNextAction,
  resolveNodePolicyMemoryState,
  resolveNodeRehydrationDefaultMode,
  resolveNodeSemanticForgettingSurface,
  resolveNodeSummaryKind,
  resolveNodeTargetFiles,
  resolveNodeTaskFamily,
  resolveNodeTaskSignature,
  resolveNodeWorkflowSignature,
} from "../node-execution-surface.js";
import {
  adjudicateMemoryLifecycle,
  lifecycleDecisionInputForMemory,
  memoryLifecycleRelationsFromEdges,
  type AdjudicableMemoryEntry,
  type MemoryLifecycleEdgeInput,
  type MemoryLifecycleRelation,
} from "../memory-lifecycle-adjudicator.js";
import {
  lifecycleCandidateDirectUseUnsafe,
  lifecycleCandidateRuntimeOwnedProducer,
} from "../lifecycle-candidate-inference.js";

export type ProductTask = AionisGuidePacket["task"];

export type ProductActor = NonNullable<AionisGuidePacket["actor"]>;

export type MemoryPacketEntry = AionisMemoryPacket["relevant_memories"][number];

type MemoryPacketLifecycleState = MemoryPacketEntry["lifecycle_state"];

type MemoryPacketMemoryType = MemoryPacketEntry["memory_type"];

type ExecutionTransitionKind = NonNullable<NonNullable<MemoryPacketEntry["execution_state"]>["transition_kind"]>;

type MemoryPacketEvidenceTrailEntry = AionisMemoryPacket["evidence_trail"][number];

export type MemoryLifecycleRelationTraceEvidence = NonNullable<MemoryPacketEvidenceTrailEntry["lifecycle_relation"]>;

export type NormalizedAgentPromptExecutionScope = {
  task_signature: string | null;
  task_family: string | null;
  workflow_signature: string | null;
};

export type BuildAionisMemoryPacketArgs = {
  tenant_id: string;
  scope: string;
  actor?: ProductActor;
  query?: Partial<AionisMemoryPacket["query"]>;
  nodes: Array<{
    id: string;
    type: string;
    title: string | null;
    text_summary: string | null;
    tier?: string | null;
    slots?: unknown;
    raw_ref?: string | null;
    evidence_ref?: string | null;
    commit_id?: string | null;
    producer_agent_id?: string | null;
    owner_agent_id?: string | null;
    owner_team_id?: string | null;
    confidence?: number | null;
    salience?: number | null;
    created_at?: string | null;
    updated_at?: string | null;
  }>;
  context_items?: unknown[];
  ranked?: Array<{ id: string; score?: number | null; activation?: number | null }>;
  recall_sources_by_memory_id?: Record<string, unknown>;
  lifecycle_edges?: MemoryLifecycleEdgeInput[];
  source_map?: Partial<AionisMemoryPacket["source_map"]>;
};

export function compactStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nonNegativeIntegerValue(value: unknown): number {
  const parsed = numberValue(value);
  if (parsed === null) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return compactStrings(value.map((entry) => typeof entry === "string" ? entry : null));
}

export function boundedExecutionEvidenceStrings(values: string[], limit: number): string[] {
  return compactStrings(values)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((entry) => entry.slice(0, 512).trim());
}

function stringArrayFromSources(values: unknown[], limit: number): string[] {
  return boundedExecutionEvidenceStrings(values.flatMap((value) => stringArrayValue(value)), limit);
}

function recordArrayValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    return record ? [record] : [];
  });
}

function verificationSummaryValue(value: unknown): string[] {
  const direct = stringValue(value);
  if (direct) return [direct];
  const record = asRecord(value);
  if (!record) return stringArrayValue(value);
  const status = stringValue(record.status)
    ?? stringValue(record.verifier_status)
    ?? stringValue(record.result)
    ?? stringValue(record.outcome);
  const summaries = compactStrings([
    stringValue(record.summary),
    ...stringArrayValue(record.summary),
    ...stringArrayValue(record.verification_summary),
    stringValue(record.message),
    stringValue(record.reason),
    stringValue(record.failure_reason),
    stringValue(record.error),
  ]);
  const checks = recordArrayValue(record.checks)
    .flatMap((check) => compactStrings([
      stringValue(check.name),
      stringValue(check.status),
      stringValue(check.summary) ?? stringValue(check.message) ?? stringValue(check.reason),
    ]).join(": "));
  const failures = stringArrayValue(record.failures);
  return compactStrings([
    status && summaries[0] ? `${status}: ${summaries[0]}` : status,
    ...(status ? summaries.slice(1) : summaries),
    ...checks,
    ...failures,
  ]);
}

function artifactHintValue(value: unknown): string[] {
  const direct = stringValue(value);
  if (direct) return [direct];
  const record = asRecord(value);
  const records = record
    ? [record, ...recordArrayValue(record.artifacts)]
    : recordArrayValue(value);
  return compactStrings([
    ...stringArrayValue(value),
    ...(record ? stringArrayValue(record.artifact_hints) : []),
    ...(record ? stringArrayValue(record.paths) : []),
    ...records.map((entry) => compactStrings([
      stringValue(entry.path)
        ?? stringValue(entry.file_path)
        ?? stringValue(entry.uri)
        ?? stringValue(entry.name)
        ?? stringValue(entry.id),
      stringValue(entry.summary) ?? stringValue(entry.description),
    ]).join(": ")),
  ]);
}

function contractTrustValue(value: unknown): ContractTrust | null {
  return value === "authoritative" || value === "advisory" || value === "observational" ? value : null;
}

function clampConfidence(value: unknown, fallback: number): number {
  const parsed = numberValue(value);
  const next = parsed === null ? fallback : parsed;
  return Math.max(0, Math.min(1, Number(next.toFixed(6))));
}

const AIONIS_RECALL_SOURCE_KINDS = new Set<AionisRecallSourceTrace["kind"]>([
  "semantic",
  "lexical",
  "structured",
  "execution_native",
  "graph",
  "associative_shadow",
  "recent",
  "exact_recovery",
  "ann",
  "substrate",
]);

function recallSourceTraceValue(value: unknown): AionisRecallSourceTrace | null {
  const record = asRecord(value);
  const kind = stringValue(record?.kind);
  const reason = stringValue(record?.reason);
  if (!kind || !AIONIS_RECALL_SOURCE_KINDS.has(kind as AionisRecallSourceTrace["kind"]) || !reason) {
    return null;
  }
  const score = numberValue(record?.score);
  return {
    kind: kind as AionisRecallSourceTrace["kind"],
    ...(score === null ? {} : { score: clampConfidence(score, 0) }),
    reason,
    matched_fields: stringArrayValue(record?.matched_fields).slice(0, 16),
    ...(stringValue(record?.index_name) ? { index_name: stringValue(record?.index_name)! } : {}),
  };
}

function recallSourcesForMemory(
  recallSourcesByMemoryId: Map<string, AionisRecallSourceTrace[]>,
  memoryId: string,
): AionisRecallSourceTrace[] {
  return (recallSourcesByMemoryId.get(memoryId) ?? []).slice(0, 8);
}

function contextItemId(item: unknown): string | null {
  const record = asRecord(item);
  return stringValue(record?.node_id) ?? stringValue(record?.memory_id) ?? stringValue(record?.id);
}

export function asTask(task?: ProductTask): ProductTask {
  return {
    task_id: task?.task_id ?? null,
    run_id: task?.run_id ?? null,
    task_signature: task?.task_signature ?? null,
    task_family: task?.task_family ?? null,
  };
}

function memoryDomain(args: {
  type: string;
  slots: Record<string, unknown> | null;
  contextItem: Record<string, unknown> | null;
}): AionisMemoryDomain {
  const executionKind = resolveNodeExecutionKind(args.slots) ?? stringValue(args.contextItem?.execution_kind);
  const anchorKind = resolveNodeAnchorKind(args.slots) ?? stringValue(args.contextItem?.anchor_kind);
  return executionKind || anchorKind ? "execution" : "general";
}

function memoryType(args: {
  type: string;
  domain: AionisMemoryDomain;
}): MemoryPacketMemoryType {
  if (args.domain === "execution") return "execution_memory";
  if (args.type === "rule") return "preference";
  if (args.type === "topic") return "project_context";
  if (args.type === "entity") return "fact";
  if (args.type === "concept") return "fact";
  if (args.type === "procedure") return "procedure";
  if (args.type === "event") return "event";
  if (args.type === "evidence") return "evidence";
  if (args.type === "self_model") return "preference";
  return "unknown";
}

function memoryLifecycleState(args: {
  slots: Record<string, unknown> | null;
  contextItem: Record<string, unknown> | null;
  tier: string | null;
  confidence: number;
}): MemoryPacketLifecycleState {
  const semanticForgetting = resolveNodeSemanticForgettingSurface(args.slots);
  const archiveRelocation = resolveNodeArchiveRelocationSurface(args.slots);
  const lifecycle = stringValue(args.contextItem?.lifecycle_state) ?? stringValue(args.slots?.lifecycle_state);
  const weakCounterSignals = nonNegativeIntegerValue(args.slots?.weak_counter_signal_count);
  const strongCounterSignals = nonNegativeIntegerValue(args.slots?.strong_counter_signal_count);
  const feedbackLearningControlPosture = stringValue(args.slots?.feedback_learning_control_posture);
  const policyMemoryState = resolveNodePolicyMemoryState(args.slots);
  const credibilityState = resolveNodeCredibilityState(args.slots);
  const tier = args.tier ?? "";
  if (
    archiveRelocation.relocation_state === "cold_archive"
    || semanticForgetting.action === "archive"
    || lifecycle === "archived"
    || policyMemoryState === "retired"
    || tier === "archive"
  ) {
    return "archived";
  }
  if (lifecycle === "rehydration_candidate") return "rehydration_candidate";
  if (semanticForgetting.action === "demote") return "demoted";
  if (semanticForgetting.action === "review" || policyMemoryState === "contested" || credibilityState === "contested") return "contested";
  if (lifecycle === "suppressed" || lifecycle === "disabled") return "suppressed";
  if (strongCounterSignals > 0 || weakCounterSignals >= 2) return "contested";
  if (feedbackLearningControlPosture === "inspect_before_use") return "candidate";
  if (lifecycle === "contested") return "contested";
  if (lifecycle === "candidate" || args.confidence < 0.6) return "candidate";
  if (tier === "cold" && resolveNodeRehydrationDefaultMode(args.slots)) return "rehydration_candidate";
  return "active";
}

function memoryAuthority(args: {
  domain: AionisMemoryDomain;
  sourceLayer: MemoryPacketEntry["source_layer"];
  lifecycleState: MemoryPacketLifecycleState;
  confidence: number;
  contractTrust?: ContractTrust | null;
}): AionisGuidanceAuthority {
  if (args.lifecycleState === "suppressed" || args.lifecycleState === "archived") return "blocked";
  if (args.lifecycleState === "candidate" || args.lifecycleState === "contested" || args.lifecycleState === "demoted") {
    return "candidate";
  }
  if (args.domain === "execution") {
    if (args.contractTrust === "authoritative" && args.confidence >= 0.7) return "trusted";
    if (args.contractTrust === "advisory" && args.confidence >= 0.7) return "advisory";
    if (args.contractTrust === "observational") return "candidate";
    if (args.confidence >= 0.8 && (args.sourceLayer === "L3" || args.sourceLayer === "L4")) return "advisory";
    return "candidate";
  }
  if (args.confidence >= 0.7) return "advisory";
  return "candidate";
}

function sourceLayer(args: {
  type: string;
  slots: Record<string, unknown> | null;
  contextItem: Record<string, unknown> | null;
}): MemoryPacketEntry["source_layer"] {
  const contextLayer = stringValue(args.contextItem?.compression_layer);
  if (
    contextLayer === "L0"
    || contextLayer === "L1"
    || contextLayer === "L2"
    || contextLayer === "L3"
    || contextLayer === "L4"
    || contextLayer === "L5"
  ) {
    return contextLayer;
  }
  return resolveNodeCompressionLayer({
    type: args.type,
    slots: args.slots,
  });
}

function memorySummary(args: {
  node: BuildAionisMemoryPacketArgs["nodes"][number];
  contextItem: Record<string, unknown> | null;
}): string {
  return compactStrings([
    stringValue(args.contextItem?.summary),
    stringValue(args.node.text_summary),
    stringValue(args.node.title),
    args.node.id,
  ])[0] ?? args.node.id;
}

function memoryTitle(args: {
  node: BuildAionisMemoryPacketArgs["nodes"][number];
  contextItem: Record<string, unknown> | null;
}): string | null {
  return stringValue(args.node.title) ?? stringValue(args.contextItem?.title);
}

function memoryEvidenceIds(args: {
  node: BuildAionisMemoryPacketArgs["nodes"][number];
  contextItem: Record<string, unknown> | null;
}): string[] {
  return compactStrings([
    stringValue(args.node.evidence_ref),
    stringValue(args.node.raw_ref),
    stringValue(args.node.commit_id),
    stringValue(args.contextItem?.commit_id),
  ]);
}

function memoryScopeHint(args: {
  domain: AionisMemoryDomain;
  sourceLayer: MemoryPacketEntry["source_layer"];
}): string {
  if (args.domain === "execution") return "execution memory; apply only within matching task or workflow scope";
  if (args.sourceLayer === "L0" || args.sourceLayer === "L1") return "low-level evidence; use as support, not stable preference";
  if (args.sourceLayer === "L3" || args.sourceLayer === "L4") return "compressed memory; apply as advisory context";
  return "general cognitive memory; apply inside the current tenant and scope";
}

type MemoryContractProjectionInput = Pick<
  MemoryPacketEntry,
  "authority"
  | "domain"
  | "evidence_ids"
  | "lifecycle_state"
  | "memory_type"
  | "source_layer"
>;

function memoryContractEvidenceOnly(entry: MemoryContractProjectionInput): boolean {
  return entry.domain === "general"
    && (entry.source_layer === "L0" || entry.source_layer === "L1")
    && (entry.memory_type === "event" || entry.memory_type === "evidence");
}

function memoryContractForEntry(entry: MemoryContractProjectionInput): MemoryPacketEntry["memory_contract"] {
  const blocked = memoryEntryBlocked(entry as MemoryPacketEntry);
  const inspect = !blocked && memoryEntryInspectBeforeUse(entry as MemoryPacketEntry);
  const evidenceOnly = !blocked && !inspect && memoryContractEvidenceOnly(entry);
  const usePolicy = blocked
    ? "do_not_use"
    : evidenceOnly
      ? "evidence_only"
      : inspect
        ? "inspect_before_use"
        : "direct_use";
  const evidenceRequirement = entry.evidence_ids.length > 0
    ? "satisfied"
    : entry.authority === "candidate" || entry.authority === "none" || entry.lifecycle_state === "unknown"
      ? "requires_more_evidence"
      : "node_evidence_only";
  const sourceTrust = blocked
    ? "blocked_or_suppressed"
    : entry.authority === "trusted"
      ? "authoritative_runtime"
      : entry.authority === "advisory"
        ? "scoped_advisory"
        : "external_or_unverified";
  const allowedScope = blocked
    ? "none"
    : evidenceOnly || entry.source_layer === "L0" || entry.source_layer === "L1"
      ? "supporting_evidence_only"
      : entry.domain === "execution"
        ? "task_or_workflow_scope"
        : "current_scope";
  const confirmationRequired = usePolicy !== "direct_use" || evidenceRequirement === "requires_more_evidence";
  return {
    source_trust: sourceTrust,
    allowed_scope: allowedScope,
    evidence_requirement: evidenceRequirement,
    use_policy: usePolicy,
    confirmation_required: confirmationRequired,
    reasons: compactStrings([
      `memory_contract_authority_${entry.authority}`,
      `memory_contract_lifecycle_${entry.lifecycle_state}`,
      usePolicy === "direct_use" ? "memory_contract_direct_use_allowed" : null,
      usePolicy === "inspect_before_use" ? "memory_contract_requires_inspection" : null,
      usePolicy === "do_not_use" ? "memory_contract_blocks_direct_use" : null,
      usePolicy === "evidence_only" ? "memory_contract_evidence_only" : null,
      evidenceRequirement === "requires_more_evidence" ? "memory_contract_requires_more_evidence" : null,
      allowedScope === "task_or_workflow_scope" ? "memory_contract_task_or_workflow_scope" : null,
      allowedScope === "supporting_evidence_only" ? "memory_contract_supporting_evidence_only" : null,
    ]).slice(0, 8),
  };
}

function structuredKindTokens(...values: Array<string | null>): string[] {
  return values
    .flatMap((value) => (value ?? "").toLowerCase().split(/[^a-z0-9]+/g))
    .filter(Boolean);
}

function structuredKindHasAffirmedToken(tokens: string[], candidates: Set<string>): boolean {
  return tokens.some((token, index) =>
    candidates.has(token)
    && tokens[index - 1] !== "not"
    && tokens[index - 1] !== "no"
    && tokens[index - 1] !== "non"
  );
}

function executionTransitionKind(args: {
  lifecycleState: MemoryPacketLifecycleState;
  summaryKind: string | null;
  executionKind: string | null;
  handoffTarget: string | null;
  nextActionHint: string | null;
}): ExecutionTransitionKind | null {
  const tokens = structuredKindTokens(args.summaryKind, args.executionKind);
  if (
    args.lifecycleState === "suppressed"
    || args.lifecycleState === "archived"
    || structuredKindHasAffirmedToken(tokens, new Set(["failed", "failure", "rejected", "invalidated", "stale"]))
  ) {
    return "avoid_failed_branch";
  }
  if (
    args.lifecycleState === "rehydration_candidate"
    || structuredKindHasAffirmedToken(tokens, new Set(["raw", "trace", "pointer", "rehydrate", "rehydration"]))
  ) {
    return "request_rehydrate";
  }
  if (args.handoffTarget) return "handoff_to_actor";
  if (args.lifecycleState === "candidate" || args.lifecycleState === "contested" || args.lifecycleState === "demoted") {
    return "inspect_before_use";
  }
  if (
    args.nextActionHint
    || structuredKindHasAffirmedToken(tokens, new Set(["current", "active", "resume", "handoff"]))
  ) {
    return "resume_current_state";
  }
  return null;
}

function memoryExecutionStateProjection(args: {
  node: BuildAionisMemoryPacketArgs["nodes"][number];
  slots: Record<string, unknown> | null;
  contextItem: Record<string, unknown> | null;
  domain: AionisMemoryDomain;
  lifecycleState: MemoryPacketLifecycleState;
}): MemoryPacketEntry["execution_state"] | undefined {
  const nodeRecord = args.node as Record<string, unknown>;
  const executionNative = asRecord(args.slots?.execution_native_v1);
  const executionState = asRecord(args.slots?.execution_state);
  const executionObservation = asRecord(args.slots?.execution_observation_v1);
  const executionPacket = asRecord(args.slots?.execution_packet_v1);
  const executionPacketOutcome = asRecord(executionPacket?.outcome);
  const executionContract = asRecord(args.slots?.execution_contract_v1);
  const executionContractOutcome = asRecord(executionContract?.outcome);
  const summaryKind = resolveNodeSummaryKind(args.slots) ?? stringValue(args.contextItem?.summary_kind);
  const executionKind = resolveNodeExecutionKind(args.slots) ?? stringValue(args.contextItem?.execution_kind);
  const taskSignature = resolveNodeTaskSignature({ slots: args.slots })
    ?? stringValue(args.contextItem?.task_signature);
  const taskFamily = resolveNodeTaskFamily({ slots: args.slots })
    ?? stringValue(args.contextItem?.task_family);
  const workflowSignature = resolveNodeWorkflowSignature({ slots: args.slots })
    ?? stringValue(args.contextItem?.workflow_signature);
  const executionOutcomeRole =
    normalizeExecutionOutcomeRoleFromValue(executionNative?.execution_outcome_role)
    ?? normalizeExecutionOutcomeRoleFromValue(executionNative?.outcome)
    ?? normalizeExecutionOutcomeRoleFromValue(executionObservation?.execution_outcome_role)
    ?? normalizeExecutionOutcomeRoleFromValue(executionObservation?.outcome_role)
    ?? normalizeExecutionOutcomeRoleFromValue(executionObservation?.outcome)
    ?? normalizeExecutionOutcomeRoleFromValue(args.slots?.execution_outcome_role)
    ?? normalizeExecutionOutcomeRoleFromValue(args.slots?.outcome);
  const nextActionHint = resolveNodeNextAction({ slots: args.slots })
    ?? stringValue(args.contextItem?.next_action);
  const actorRole = stringValue(executionNative?.actor_role)
    ?? stringValue(executionState?.actor_role)
    ?? stringValue(args.slots?.actor_role)
    ?? stringValue(args.contextItem?.actor_role);
  const handoffTarget = stringValue(executionNative?.handoff_target)
    ?? stringValue(executionNative?.handoff_target_role)
    ?? stringValue(executionNative?.next_actor_role)
    ?? stringValue(executionState?.handoff_target)
    ?? stringValue(args.slots?.handoff_target)
    ?? stringValue(args.slots?.handoff_target_role)
    ?? stringValue(args.slots?.next_actor_role)
    ?? stringValue(args.contextItem?.handoff_target)
    ?? stringValue(args.contextItem?.handoff_target_role)
    ?? stringValue(args.contextItem?.next_actor_role);
  const sourceAgentId = stringValue(args.node.owner_agent_id)
    ?? stringValue(args.node.producer_agent_id)
    ?? stringValue(args.contextItem?.owner_agent_id)
    ?? stringValue(args.contextItem?.producer_agent_id);
  const sourceTeamId = stringValue(args.node.owner_team_id)
    ?? stringValue(args.contextItem?.owner_team_id);
  const workflowSteps = stringArrayFromSources([
    nodeRecord.workflow_steps,
    args.slots?.workflow_steps,
    args.contextItem?.workflow_steps,
    executionNative?.workflow_steps,
    executionState?.workflow_steps,
    executionPacket?.workflow_steps,
    executionContract?.workflow_steps,
  ], 8);
  const acceptanceChecks = stringArrayFromSources([
    nodeRecord.acceptance_checks,
    args.slots?.acceptance_checks,
    args.contextItem?.acceptance_checks,
    executionNative?.acceptance_checks,
    executionState?.acceptance_checks,
    executionObservation?.acceptance_checks,
    executionPacket?.acceptance_checks,
    executionPacketOutcome?.acceptance_checks,
    executionContract?.acceptance_checks,
    executionContractOutcome?.acceptance_checks,
  ], 8);
  const verificationSummary = boundedExecutionEvidenceStrings([
    ...verificationSummaryValue(nodeRecord.verification_summary),
    ...verificationSummaryValue(nodeRecord.verification),
    ...verificationSummaryValue(args.slots?.verification_summary),
    ...verificationSummaryValue(args.slots?.verification),
    ...verificationSummaryValue(args.contextItem?.verification_summary),
    ...verificationSummaryValue(args.contextItem?.verification),
    ...verificationSummaryValue(executionNative?.verification_summary),
    ...verificationSummaryValue(executionNative?.verification),
    ...verificationSummaryValue(executionState?.verification_summary),
    ...verificationSummaryValue(executionState?.verification),
    ...verificationSummaryValue(executionObservation?.verification_summary),
    ...verificationSummaryValue(executionObservation?.verification),
    ...verificationSummaryValue(executionPacket?.verification_summary),
    ...verificationSummaryValue(executionPacket?.verification),
    ...verificationSummaryValue(executionPacketOutcome?.verification),
    ...verificationSummaryValue(executionContract?.verification_summary),
    ...verificationSummaryValue(executionContract?.verification),
    ...verificationSummaryValue(executionContractOutcome?.verification),
  ], 6);
  const artifactHints = boundedExecutionEvidenceStrings([
    ...artifactHintValue(nodeRecord.artifacts),
    ...artifactHintValue(args.slots?.artifacts),
    ...artifactHintValue(args.contextItem?.artifacts),
    ...artifactHintValue(executionObservation?.artifacts),
    ...artifactHintValue(executionState?.artifacts),
    ...artifactHintValue(executionNative?.artifacts),
    ...artifactHintValue(executionPacket?.artifacts),
    ...artifactHintValue(executionContract?.artifacts),
    ...artifactHintValue(executionObservation?.verification),
    ...artifactHintValue(executionState?.verification),
    ...artifactHintValue(executionNative?.verification),
    ...artifactHintValue(executionPacket?.verification),
    ...artifactHintValue(executionContract?.verification),
    ...artifactHintValue(executionObservation?.artifact_hints),
    ...artifactHintValue(executionState?.artifact_hints),
    ...artifactHintValue(executionNative?.artifact_hints),
    ...artifactHintValue(executionPacket?.artifact_hints),
    ...artifactHintValue(executionContract?.artifact_hints),
    ...artifactHintValue(nodeRecord.artifact_hints),
    ...artifactHintValue(args.slots?.artifact_hints),
    ...artifactHintValue(args.contextItem?.artifact_hints),
  ], 6);
  const hasExecutionSurface =
    args.domain === "execution"
    || !!summaryKind
    || !!executionKind
    || !!taskSignature
    || !!taskFamily
    || !!workflowSignature
    || !!executionOutcomeRole
    || !!nextActionHint
    || !!actorRole
    || !!handoffTarget
    || workflowSteps.length > 0
    || acceptanceChecks.length > 0
    || verificationSummary.length > 0
    || artifactHints.length > 0;
  if (!hasExecutionSurface) return undefined;
  const transitionKind = executionTransitionKind({
    lifecycleState: args.lifecycleState,
    summaryKind,
    executionKind,
    handoffTarget,
    nextActionHint,
  });
  return {
    summary_kind: summaryKind,
    execution_kind: executionKind,
    task_signature: taskSignature,
    task_family: taskFamily,
    workflow_signature: workflowSignature,
    execution_outcome_role: executionOutcomeRole ?? null,
    next_action_hint: nextActionHint,
    transition_kind: transitionKind,
    actor_role: actorRole,
    handoff_target: handoffTarget,
    source_agent_id: sourceAgentId,
    source_team_id: sourceTeamId,
    workflow_steps: workflowSteps,
    acceptance_checks: acceptanceChecks,
    verification_summary: verificationSummary,
    artifact_hints: artifactHints,
  };
}

function buildMemoryPacketEntries(args: BuildAionisMemoryPacketArgs): {
  entries: MemoryPacketEntry[];
  lifecycleRelations: MemoryLifecycleRelation[];
  persistedLifecycleRelationCount: number;
} {
  const contextItems = new Map<string, Record<string, unknown>>();
  for (const item of args.context_items ?? []) {
    const id = contextItemId(item);
    const record = asRecord(item);
    if (id && record) contextItems.set(id, record);
  }
  const rankedScore = new Map<string, number>();
  for (const item of args.ranked ?? []) {
    const score = numberValue(item.score) ?? numberValue(item.activation);
    if (score !== null) rankedScore.set(item.id, score);
  }
  const recallSourcesByMemoryId = new Map<string, AionisRecallSourceTrace[]>();
  for (const [memoryId, rawSources] of Object.entries(args.recall_sources_by_memory_id ?? {})) {
    if (!memoryId || !Array.isArray(rawSources)) continue;
    const sources = rawSources
      .map(recallSourceTraceValue)
      .filter((entry): entry is AionisRecallSourceTrace => entry !== null)
      .slice(0, 8);
    if (sources.length > 0) recallSourcesByMemoryId.set(memoryId, sources);
  }
  const baseEntries: AdjudicableMemoryEntry[] = args.nodes.slice(0, 32).map((node, sourceIndex) => {
    const slots = asRecord(node.slots);
    const contextItem = contextItems.get(node.id) ?? null;
    const layer = sourceLayer({ type: node.type, slots, contextItem });
    const domain = memoryDomain({ type: node.type, slots, contextItem });
    const confidence = clampConfidence(node.confidence, 0.5);
    const salience = clampConfidence(rankedScore.get(node.id) ?? node.salience, 0.5);
    const contractTrust = resolveNodeExecutionContractTrust({ slots }) ?? contractTrustValue(contextItem?.contract_trust);
    const targetFiles = compactStrings([
      ...resolveNodeTargetFiles({ slots }),
      ...stringArrayValue(contextItem?.target_files),
    ]).slice(0, 16);
    const lifecycleState = memoryLifecycleState({
      slots,
      contextItem,
      tier: stringValue(node.tier),
      confidence,
    });
    const executionState = memoryExecutionStateProjection({
      node,
      slots,
      contextItem,
      domain,
      lifecycleState,
    });
    return {
      memory_id: node.id,
      title: memoryTitle({ node, contextItem }),
      summary: memorySummary({ node, contextItem }),
      memory_type: memoryType({ type: node.type, domain }),
      domain,
      source_layer: layer,
      authority: memoryAuthority({ domain, sourceLayer: layer, lifecycleState, confidence, contractTrust }),
      confidence,
      salience,
      lifecycle_state: lifecycleState,
      evidence_ids: memoryEvidenceIds({ node, contextItem }),
      observed_at: stringValue(node.updated_at)
        ?? stringValue(node.created_at)
        ?? stringValue(contextItem?.updated_at)
        ?? stringValue(contextItem?.created_at),
      target_files: targetFiles,
      recall_sources: recallSourcesForMemory(recallSourcesByMemoryId, node.id),
      scope_hint: memoryScopeHint({ domain, sourceLayer: layer }),
      ...(executionState ? { execution_state: executionState } : {}),
      source_index: sourceIndex,
    };
  });
  const persistedRelations = memoryLifecycleRelationsFromEdges(args.lifecycle_edges ?? []);
  const adjudicated = adjudicateMemoryLifecycle(baseEntries, {
    persisted_relations: persistedRelations,
  });
  return {
    lifecycleRelations: adjudicated.relations,
    persistedLifecycleRelationCount: persistedRelations.length,
    entries: adjudicated.entries.map(({ source_index: _sourceIndex, ...entry }) => {
      const memoryEntry = entry as MemoryPacketEntry;
      return {
        ...memoryEntry,
        memory_contract: memoryContractForEntry(memoryEntry),
      };
    }),
  };
}

function memoryFamily(entries: MemoryPacketEntry[]): AionisMemoryPacket["memory_family"] {
  if (entries.length === 0) return "empty";
  const domains = new Set(entries.map((entry) => entry.domain));
  if (domains.size > 1) return "mixed";
  return domains.has("execution") ? "execution" : "general_cognitive";
}

function buildMemoryEvidenceTrail(
  entries: MemoryPacketEntry[],
  lifecycleRelations: MemoryLifecycleRelation[] = [],
): AionisMemoryPacket["evidence_trail"] {
  const directEvidence = entries.flatMap((entry) => {
    const direct = {
      evidence_id: `memory_node:${entry.memory_id}`,
      memory_id: entry.memory_id,
      source: "node" as const,
      relation: "direct_match" as const,
      reason: "Retrieved memory node contributed to the cognitive memory packet.",
    };
    const refs = entry.evidence_ids.slice(0, 3).map((evidenceId) => ({
      evidence_id: evidenceId,
      memory_id: entry.memory_id,
      source: "citation" as const,
      relation: "supports" as const,
      reason: "Stored reference supports this memory entry.",
    }));
    return [direct, ...refs];
  });
  const relationEvidence = lifecycleRelations.map((relation) => ({
    evidence_id: `memory_relation:${relation.source_memory_id}:${relation.target_memory_id}`,
    memory_id: relation.target_memory_id,
    source: "edge" as const,
    relation: "contradicts" as const,
    reason: `Newer related memory ${relation.source_memory_id} ${relation.relation} this memory; ${relation.reasons.join("; ")}.`,
    lifecycle_relation: lifecycleRelationTraceEvidence(relation),
  }));
  return [...directEvidence, ...relationEvidence].slice(0, 96);
}

function lifecycleRelationTraceEvidence(relation: MemoryLifecycleRelation): MemoryLifecycleRelationTraceEvidence {
  return {
    source_memory_id: relation.source_memory_id,
    target_memory_id: relation.target_memory_id,
    lifecycle_relation: relation.relation,
    confidence: relation.confidence,
    producer: relation.evidence.producer,
    candidate_confidence: relation.evidence.candidate_confidence,
    signals: relation.evidence.signals,
    gate: relation.evidence.gate,
    reasons: relation.evidence.reasons.length > 0 ? relation.evidence.reasons : relation.reasons,
  };
}

function buildMemoryContradictionWarnings(entries: MemoryPacketEntry[]): AionisMemoryPacket["contradiction_warnings"] {
  return entries
    .filter((entry) => entry.lifecycle_state === "contested" || entry.authority === "candidate")
    .slice(0, 24)
    .map((entry) => ({
      memory_id: entry.memory_id,
      severity: entry.lifecycle_state === "contested" ? "high" as const : "medium" as const,
      reason: entry.lifecycle_state === "contested"
        ? "Memory is contested or under review; inspect evidence before applying it."
        : "Memory has candidate authority and should not be treated as stable behavior.",
      suggested_action: entry.lifecycle_state === "contested" ? "inspect_before_use" as const : "keep_candidate" as const,
    }));
}

function expectedMemoryEffects(entries: MemoryPacketEntry[]): AionisMemoryPacket["behavior_impact"]["expected_effects"] {
  const effects = new Set<AionisMemoryPacket["behavior_impact"]["expected_effects"][number]>();
  for (const entry of entries) {
    if (entry.memory_type === "preference") effects.add("answer_style");
    if (entry.memory_type === "fact" || entry.memory_type === "evidence") effects.add("fact_recall");
    if (entry.memory_type === "project_context") effects.add("project_context");
    if (entry.domain === "execution" || entry.memory_type === "procedure") effects.add("tool_or_workflow_guidance");
    if (entry.lifecycle_state === "suppressed" || entry.lifecycle_state === "demoted" || entry.lifecycle_state === "archived") {
      effects.add("avoid_stale_memory");
    }
    if (entry.lifecycle_state === "rehydration_candidate") effects.add("requires_rehydration");
  }
  return Array.from(effects);
}

function buildMemoryLifecycle(entries: MemoryPacketEntry[]): AionisMemoryPacket["lifecycle"] {
  return {
    used_memory_ids: entries
      .filter((entry) => entry.authority !== "blocked")
      .map((entry) => entry.memory_id),
    candidate_memory_ids: entries
      .filter((entry) => entry.authority === "candidate")
      .map((entry) => entry.memory_id),
    suppressed_memory_ids: entries
      .filter((entry) => entry.lifecycle_state === "suppressed" || entry.authority === "blocked")
      .map((entry) => entry.memory_id),
    archived_memory_ids: entries
      .filter((entry) => entry.lifecycle_state === "archived")
      .map((entry) => entry.memory_id),
    rehydration_hints: entries
      .filter((entry) => entry.lifecycle_state === "rehydration_candidate")
      .map((entry) => ({
        memory_id: entry.memory_id,
        mode: "differential" as const,
        reason: "Cold memory was relevant enough to recall, but payload should be rehydrated only if needed.",
        required: false,
      })),
  };
}

export function buildAionisMemoryPacket(args: BuildAionisMemoryPacketArgs): AionisMemoryPacket {
  const { entries, lifecycleRelations, persistedLifecycleRelationCount } = buildMemoryPacketEntries(args);
  const lifecycle = buildMemoryLifecycle(entries);
  const contradictionWarnings = buildMemoryContradictionWarnings(entries);
  const expectedEffects = expectedMemoryEffects(entries);
  const lowConfidenceCount = entries.filter((entry) => entry.confidence < 0.6).length;
  const staleMemoryCount = entries.filter((entry) =>
    entry.lifecycle_state === "suppressed"
    || entry.lifecycle_state === "demoted"
    || entry.lifecycle_state === "archived"
  ).length;
  const riskReasons = compactStrings([
    contradictionWarnings.length > 0 ? "candidate or contested memories require evidence-aware use" : null,
    lowConfidenceCount > 0 ? "low-confidence memories are present" : null,
    staleMemoryCount > 0 ? "stale or forgotten memories are present" : null,
  ]);

  return parseAionisMemoryPacket({
    contract_version: "aionis_memory_packet_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor: args.actor,
    query: {
      source: args.query?.source ?? "embedding",
      intent: args.query?.intent ?? null,
      embedding_dims: args.query?.embedding_dims ?? null,
    },
    memory_family: memoryFamily(entries),
    relevant_memories: entries,
    evidence_trail: buildMemoryEvidenceTrail(entries, lifecycleRelations),
    lifecycle,
    contradiction_warnings: contradictionWarnings,
    forgetting_state: {
      stale_memory_count: staleMemoryCount,
      suppressed_count: lifecycle.suppressed_memory_ids.length,
      archived_count: entries.filter((entry) => entry.lifecycle_state === "archived").length,
      rehydration_candidate_count: lifecycle.rehydration_hints.length,
    },
    behavior_impact: {
      will_shape_behavior: entries.some((entry) => entry.authority === "advisory" || entry.authority === "trusted"),
      changed_fields: entries.length > 0
        ? compactStrings([
            "relevant_memories",
            expectedEffects.length > 0 ? "behavior_impact.expected_effects" : null,
            staleMemoryCount > 0 ? "forgetting_state" : null,
            contradictionWarnings.length > 0 ? "contradiction_warnings" : null,
          ])
        : [],
      expected_effects: expectedEffects,
      explanation: entries.length > 0
        ? "Recall produced evidence-scoped memories that can shape future behavior without granting source-code authority."
        : "No relevant memory was recovered for this query.",
    },
    risk: {
      negative_transfer_risk: contradictionWarnings.some((warning) => warning.severity === "high")
        ? "high"
        : riskReasons.length > 0
          ? "medium"
          : "low",
      contradiction_count: contradictionWarnings.length,
      low_confidence_count: lowConfidenceCount,
      stale_memory_count: staleMemoryCount,
      reasons: riskReasons,
    },
    source_map: {
      routes_used: args.source_map?.routes_used ?? [],
      internal_surfaces_used: args.source_map?.internal_surfaces_used ?? [
        "recall_ranked_nodes",
        "context_items",
        "memory_layer_policy",
        "memory_contract_projection",
        "semantic_forgetting_surface",
        ...(persistedLifecycleRelationCount > 0 ? ["memory_lifecycle_relation_graph"] : []),
        ...(lifecycleRelations.length > 0 ? ["memory_lifecycle_adjudicator"] : []),
      ],
      omitted_internal_surfaces: args.source_map?.omitted_internal_surfaces ?? [
        "raw_embedding_vectors",
        "raw_slots",
        "full_payloads",
      ],
    },
  });
}

function executionStateKind(entry: MemoryPacketEntry): string {
  return (entry.execution_state?.summary_kind ?? "").toLowerCase();
}

function executionStateText(entry: MemoryPacketEntry): string {
  return `${entry.title ?? ""} ${entry.summary}`.toLowerCase();
}

export function contractEntryIsCurrentState(entry: MemoryPacketEntry): boolean {
  const kind = executionStateKind(entry);
  if (
    kind.includes("current")
    || kind.includes("active_path")
    || kind.includes("active_state")
    || kind === "handoff"
  ) return true;
  if (entry.domain !== "execution") return false;
  const text = executionStateText(entry);
  return text.includes("current active path")
    || text.includes("active continuation")
    || /\bcurrent\b.{0,48}\b(?:state|path|continuation|handoff)\b/.test(text)
    || /\b(?:latest|accepted|approved)\b.{0,80}\b(?:state|handoff|continuation|path|point)\b/.test(text);
}

export function contractEntryIsProcedure(entry: MemoryPacketEntry): boolean {
  const kind = executionStateKind(entry);
  const text = executionStateText(entry);
  return entry.memory_type === "procedure"
    || kind.includes("procedure")
    || kind.includes("playbook")
    || kind.includes("pattern")
    || /\breusable\b.{0,40}\b(?:procedure|workflow|playbook|pattern)\b/.test(text)
    || /\b(?:procedure|playbook|pattern):/.test(text);
}

export function contractEntryIsHandoff(entry: MemoryPacketEntry): boolean {
  const kind = executionStateKind(entry);
  return kind.includes("handoff") || !!entry.execution_state?.handoff_target;
}

export function lifecycleDecisionForEntry(entry: MemoryPacketEntry) {
  return lifecycleDecisionInputForMemory({
    lifecycle_state: entry.lifecycle_state,
    execution_outcome_role: entry.execution_state?.execution_outcome_role,
    transition_kind: entry.execution_state?.transition_kind,
  });
}

export function memoryEntryBlocked(entry: MemoryPacketEntry): boolean {
  return entry.authority === "blocked" || lifecycleDecisionForEntry(entry).blocks_use;
}

export function memoryEntryInspectBeforeUse(entry: MemoryPacketEntry): boolean {
  return entry.authority === "candidate" || lifecycleDecisionForEntry(entry).requires_inspection;
}

function memoryEntryHasExecutionScopeSignals(entry: MemoryPacketEntry): boolean {
  return entry.domain === "execution"
    || entry.memory_type === "execution_memory"
    || !!entry.execution_state?.task_signature
    || !!entry.execution_state?.task_family
    || !!entry.execution_state?.workflow_signature;
}

export function governanceScopeMatchForEntry(args: {
  entry: MemoryPacketEntry;
  executionScope: NormalizedAgentPromptExecutionScope;
}): GovernanceRequestContext["scope_match"] {
  const state = args.entry.execution_state;
  if (!args.executionScope.task_signature && !args.executionScope.task_family && !args.executionScope.workflow_signature) return "unscoped";
  if (!memoryEntryHasExecutionScopeSignals(args.entry)) return "unscoped";
  if (args.executionScope.task_signature && state?.task_signature === args.executionScope.task_signature) return "exact_task";
  if (args.executionScope.workflow_signature && state?.workflow_signature === args.executionScope.workflow_signature) return "workflow";
  if (args.executionScope.task_family && state?.task_family === args.executionScope.task_family) return "task_family";
  return "unrelated";
}

function memoryEntryMatchTerms(entry: MemoryPacketEntry): string[] {
  return compactStrings([
    entry.title,
    entry.memory_id,
  ]).filter((term) => term.length >= 4);
}

export function textMatchesMemoryEntry(text: string, entry: MemoryPacketEntry): boolean {
  const lower = text.toLowerCase();
  return memoryEntryMatchTerms(entry).some((term) => lower.includes(term.toLowerCase()));
}

export function extractPathTargets(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pathPattern = /(?:^|[\s"'`([])([A-Za-z0-9_.@+-]+\/[A-Za-z0-9_./@+-]*(?:\.[A-Za-z0-9]+)?)/g;
  for (const match of text.matchAll(pathPattern)) {
    const value = match[1]?.replace(/[),.;:]+$/g, "");
    if (!value || value.startsWith("http") || value.length < 5 || seen.has(value)) continue;
    if (looksLikeRepositoryName(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.slice(0, 16);
}

const COMMON_CODE_PATH_ROOTS = new Set([
  "app",
  "apps",
  "bin",
  "cmd",
  "crates",
  "docs",
  "examples",
  "lib",
  "libs",
  "package",
  "packages",
  "pkg",
  "script",
  "scripts",
  "src",
  "test",
  "tests",
]);

function looksLikeRepositoryName(value: string): boolean {
  if (value.startsWith("./") || value.startsWith("/") || value.includes("../")) return false;
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  return !COMMON_CODE_PATH_ROOTS.has(parts[0] ?? "");
}

export function lifecycleCandidateSignalsByMemoryId(
  signals: AionisLifecycleCandidateSignal[],
): Map<string, AionisLifecycleCandidateSignal[]> {
  const byId = new Map<string, AionisLifecycleCandidateSignal[]>();
  for (const signal of signals) {
    const existing = byId.get(signal.memory_id) ?? [];
    existing.push(signal);
    byId.set(signal.memory_id, existing);
  }
  return byId;
}

function lifecycleCandidateProtectiveNegativeSignal(signal: AionisLifecycleCandidateSignal): boolean {
  if (signal.signal_type !== "negative") return false;
  const quote = signal.evidence_span.quote.toLowerCase();
  return /\b(?:do not|check before direct use|avoid|check)\s+(?:restart|rely|use)\b/.test(quote)
    || /\bpreserve\b.{0,80}\b(?:counter-evidence|failed|older|stale)\b/.test(quote)
    || /\b(?:failed|older|stale|non-current)\s+branches?\s+as\s+counter-evidence\b/.test(quote);
}

export function lifecycleCandidateMemoryDirectUseUnsafe(signals: AionisLifecycleCandidateSignal[]): boolean {
  const hasCurrentOrProcedure = signals.some((signal) =>
    signal.signal_type === "current" || signal.signal_type === "procedure"
  );
  const hasSelfStaleOrContested = signals.some((signal) =>
    signal.signal_type === "stale" || signal.signal_type === "contested"
  );
  return signals.some((signal) => {
    if (!lifecycleCandidateDirectUseUnsafe(signal)) return false;
    if (
      signal.signal_type === "negative"
      && hasCurrentOrProcedure
      && !hasSelfStaleOrContested
      && lifecycleCandidateProtectiveNegativeSignal(signal)
    ) {
      return false;
    }
    return true;
  });
}

export function lifecycleCandidateMemoryDirectUseAdmissible(args: {
  entry: MemoryPacketEntry;
  signals: AionisLifecycleCandidateSignal[];
}): boolean {
  if (args.entry.lifecycle_state !== "active") return false;
  if (args.entry.authority !== "candidate") return false;
  if (args.entry.domain !== "execution" && args.entry.memory_type !== "execution_memory" && args.entry.memory_type !== "procedure") {
    return false;
  }
  if (lifecycleCandidateMemoryDirectUseUnsafe(args.signals)) return false;
  return args.signals.some((signal) =>
    lifecycleCandidateRuntimeOwnedProducer(signal)
    && signal.confidence >= 0.76
    && (signal.signal_type === "current" || signal.signal_type === "procedure")
  );
}

function lifecycleCandidateRehydrateSignal(signal: AionisLifecycleCandidateSignal): boolean {
  return lifecycleCandidateRuntimeOwnedProducer(signal)
    && signal.signal_type === "rehydrate"
    && signal.confidence >= 0.78;
}

export function lifecycleCandidateRehydrateEligible(args: {
  entry: MemoryPacketEntry;
  signals: AionisLifecycleCandidateSignal[];
}): boolean {
  if (memoryEntryBlocked(args.entry)) return false;
  if (
    args.entry.domain !== "execution"
    && args.entry.memory_type !== "execution_memory"
    && args.entry.memory_type !== "procedure"
  ) {
    return false;
  }
  if (!args.signals.some(lifecycleCandidateRehydrateSignal)) return false;
  return !args.signals.some((signal) =>
    signal.signal_type === "negative"
    || signal.signal_type === "stale"
    || (signal.signal_type === "contested" && signal.evidence_span.source_field !== "slots")
  );
}

function governanceExecutionKind(
  entry: MemoryPacketEntry,
): "current_state" | "procedure" | "handoff" | "other" | null {
  if (entry.domain !== "execution") return null;
  if (contractEntryIsCurrentState(entry)) return "current_state";
  if (contractEntryIsProcedure(entry)) return "procedure";
  if (contractEntryIsHandoff(entry)) return "handoff";
  return "other";
}

export function governanceDecisionForMemoryEntry(args: {
  entry: MemoryPacketEntry; executionScope: NormalizedAgentPromptExecutionScope;
  premiseConflict?: GovernanceRequestContext["premise_conflict"]; trustedWorkflowConflict?: boolean;
  verifiedRecoveredHandoff?: boolean; rehydrateRequested?: boolean;
  lifecycleCandidate?: GovernanceRequestContext["lifecycle_candidate"]; projectedSurface?: AionisMemoryDecisionSurface | null;
}): GovernanceDecisionV1 {
  const entry = args.entry;
  return decideGovernedMemory({
    memory: {
      memory_id: entry.memory_id,
      authority: entry.authority,
      lifecycle_state: entry.lifecycle_state,
      domain: entry.domain,
      execution_kind: governanceExecutionKind(entry),
      memory_contract: entry.memory_contract.use_policy,
      target_files: entry.target_files,
    },
    request: {
      scope_match: governanceScopeMatchForEntry({ entry, executionScope: args.executionScope }),
      premise_conflict: args.premiseConflict ?? "none",
      trusted_workflow_conflict: args.trustedWorkflowConflict ?? false,
      verified_recovered_handoff: args.verifiedRecoveredHandoff ?? false,
      rehydrate_requested: args.rehydrateRequested ?? false,
      lifecycle_candidate: args.lifecycleCandidate ?? "none",
      projected_surface: args.projectedSurface ?? null,
    },
    lifecycle: lifecycleDecisionForEntry(entry),
    authority: authorityConsumptionStateFromValue({ authority_blocked: entry.authority === "blocked" }),
    feedback: { posture: "none" },
  });
}
