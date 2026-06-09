import type {
  AssemblySummary,
  ContractTrust,
  ExecutionSummary,
  ContinuityGuidance,
  PlanningSummary,
} from "../app/planning-summary.js";
import type {
  AionisEffectReport as KernelEffectReport,
  EffectKernelComparison,
} from "../kernel/effect-evaluator.js";
import {
  parseAionisAgentContext,
  parseAionisEffectReport,
  parseAionisGuidePacket,
  parseAionisLearningPacket,
  parseAionisMemoryDecisionAuditReport,
  parseAionisMemoryDecisionTrace,
  parseAionisMemoryPacket,
  type AionisAgentContext,
  type AionisEffectReport,
  type AionisGuidePacket,
  type AionisGuidanceAuthority,
  type AionisLearningPacket,
  type AionisMemoryDecisionAuditReport,
  type AionisMemoryDecisionSurface,
  type AionisMemoryDecisionTrace,
  type AionisMemoryDomain,
  type AionisMemoryPacket,
  type AionisRiskLevel,
} from "./product-output-contract.js";
import {
  AUTHORITY_STABLE_PROMOTION_BLOCKED_COUNT_FIELD,
  authorityConsumptionStablePromotionBlockedCount,
} from "./authority-consumption.js";
import {
  resolveNodeAnchorKind,
  resolveNodeArchiveRelocationSurface,
  resolveNodeCompressionLayer,
  resolveNodeExecutionContractTrust,
  resolveNodeExecutionKind,
  resolveNodeRehydrationDefaultMode,
  resolveNodeSemanticForgettingSurface,
  resolveNodeSummaryKind,
  resolveNodeTargetFiles,
} from "./node-execution-surface.js";
import {
  adjudicateMemoryLifecycle,
  memoryLifecycleRelationsFromEdges,
  type AdjudicableMemoryEntry,
  type MemoryLifecycleEdgeInput,
  type MemoryLifecycleRelation,
} from "./memory-lifecycle-adjudicator.js";

type ProductTask = AionisGuidePacket["task"];
type ProductActor = NonNullable<AionisGuidePacket["actor"]>;
type GuideAuthority = AionisGuidanceAuthority;
type WorkflowAuthority = AionisGuidePacket["guidance"]["workflow_candidates"][number]["authority"];
type ProductImpactDirection = AionisEffectReport["history_impact"]["impact_direction"];
type TrainingCandidateType = AionisEffectReport["training_candidates"][number]["candidate_type"];
type TrainingCandidateLabel = AionisEffectReport["training_candidates"][number]["label"];
type MemoryPacketEntry = AionisMemoryPacket["relevant_memories"][number];
type MemoryPacketLifecycleState = MemoryPacketEntry["lifecycle_state"];
type MemoryPacketMemoryType = MemoryPacketEntry["memory_type"];
type MemoryPacketEvidenceTrailEntry = AionisMemoryPacket["evidence_trail"][number];
type MemoryLifecycleRelationTraceEvidence = NonNullable<MemoryPacketEvidenceTrailEntry["lifecycle_relation"]>;
type LearningCandidate = AionisLearningPacket["candidates"][number];
type LearningPosture = AionisLearningPacket["posture"]["recommended_learning_posture"];
type LearningAuthority = AionisLearningPacket["posture"]["authority"];
type FeedbackAttributionDetail = NonNullable<AionisMemoryDecisionTrace["memory_decisions"][number]["feedback_detail"]>;
type FeedbackAttributionSummary = AionisMemoryDecisionTrace["feedback_attribution"];
type UnusedExposureObservationSummary = FeedbackAttributionSummary["unused_exposure_observation"];
type SparseFeedbackSignalSummary = FeedbackAttributionSummary["sparse_feedback_signal_summary"];
type CandidateLearningControlSummary = SparseFeedbackSignalSummary["candidate_learning_control_summary"];
type NeighborhoodDriftObservation = AionisMemoryDecisionTrace["neighborhood_drift_observation"];
type NeighborhoodDriftCandidate = NeighborhoodDriftObservation["candidates"][number];
type ConfidenceDecayCandidateSummary = AionisMemoryDecisionTrace["confidence_decay_candidate_summary"];
type InspectBeforeUseShadowDelta = AionisMemoryDecisionTrace["inspect_before_use_shadow_delta"];

const NEIGHBORHOOD_DRIFT_GROWTH_THRESHOLD = 2;
const NEIGHBORHOOD_DRIFT_DIRECTIONAL_THRESHOLD = 2;
const NEIGHBORHOOD_DRIFT_ISOLATION_THRESHOLD = 1;
export const AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const NEIGHBORHOOD_DRIFT_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "before",
  "current",
  "during",
  "early",
  "later",
  "memory",
  "notes",
  "project",
  "should",
  "source",
  "still",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "using",
  "where",
  "with",
  "work",
]);

export type BuildAionisAgentContextArgs = {
  tenant_id: string;
  scope: string;
  memory_packet?: AionisMemoryPacket | null;
  guide_packet?: AionisGuidePacket | null;
  context_char_budget?: number | null;
  context_compaction_profile?: "balanced" | "aggressive" | null;
};

export type ApplyAionisInspectBeforeUseActiveProjectionArgs = {
  agent_context: AionisAgentContext;
  memory_packet?: AionisMemoryPacket | null;
  candidate_memory_ids: string[];
  reason: string;
  context_char_budget?: number | null;
  context_compaction_profile?: "balanced" | "aggressive" | null;
};

export type BuildAionisGuidePacketArgs = {
  tenant_id: string;
  scope: string;
  actor?: ProductActor;
  task?: ProductTask;
  planning: PlanningSummary | AssemblySummary;
  execution_summary?: ExecutionSummary | null;
  source_map?: Partial<AionisGuidePacket["source_map"]>;
};

export type BuildAionisEffectReportArgs = {
  tenant_id: string;
  scope: string;
  task?: ProductTask;
  report: KernelEffectReport;
  comparison?: Partial<AionisEffectReport["comparison"]>;
  evidence_ids?: string[];
  feedback_signal_review?: AionisMemoryDecisionAuditReport["feedback_signal_review"] | null;
  neighborhood_drift_review?: AionisMemoryDecisionAuditReport["neighborhood_drift_review"] | null;
  confidence_decay_review?: AionisMemoryDecisionAuditReport["confidence_decay_candidate_review"] | null;
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
    confidence?: number | null;
    salience?: number | null;
    created_at?: string | null;
    updated_at?: string | null;
  }>;
  context_items?: unknown[];
  ranked?: Array<{ id: string; score?: number | null; activation?: number | null }>;
  lifecycle_edges?: MemoryLifecycleEdgeInput[];
  source_map?: Partial<AionisMemoryPacket["source_map"]>;
};

export type BuildAionisLearningPacketArgs = {
  tenant_id: string;
  scope: string;
  actor?: ProductActor;
  task?: ProductTask;
  planning: PlanningSummary | AssemblySummary;
  source_map?: Partial<AionisLearningPacket["source_map"]>;
};

type AionisDecisionTraceGuideSnapshot = {
  memory_packet?: AionisMemoryPacket | null;
  guide_packet?: AionisGuidePacket | null;
  agent_context?: AionisAgentContext | null;
};

export type BuildAionisMemoryDecisionTraceArgs = {
  tenant_id: string;
  scope: string;
  before_guide?: AionisDecisionTraceGuideSnapshot | null;
  after_guide: AionisDecisionTraceGuideSnapshot;
  forget_result?: unknown;
  source_map?: Partial<AionisMemoryDecisionTrace["source_map"]>;
};

export type BuildAionisMemoryDecisionAuditReportArgs = {
  trace: AionisMemoryDecisionTrace;
  source_map?: Partial<AionisMemoryDecisionAuditReport["source_map"]>;
};

function compactStrings(values: Array<string | null | undefined>): string[] {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeIntegerValue(value: unknown): number {
  const parsed = numberValue(value);
  if (parsed === null) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return compactStrings(value.map((entry) => typeof entry === "string" ? entry : null));
}

function contractTrustValue(value: unknown): ContractTrust | null {
  return value === "authoritative" || value === "advisory" || value === "observational" ? value : null;
}

function clampConfidence(value: unknown, fallback: number): number {
  const parsed = numberValue(value);
  const next = parsed === null ? fallback : parsed;
  return Math.max(0, Math.min(1, Number(next.toFixed(6))));
}

function contextItemId(item: unknown): string | null {
  const record = asRecord(item);
  return stringValue(record?.node_id) ?? stringValue(record?.memory_id) ?? stringValue(record?.id);
}

function asTask(task?: ProductTask): ProductTask {
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
  const tier = args.tier ?? "";
  if (archiveRelocation.relocation_state === "cold_archive" || semanticForgetting.action === "archive" || tier === "archive") {
    return "archived";
  }
  if (semanticForgetting.action === "demote") return "demoted";
  if (semanticForgetting.action === "review") return "contested";
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
      scope_hint: memoryScopeHint({ domain, sourceLayer: layer }),
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
    entries: adjudicated.entries.map(({ source_index: _sourceIndex, ...entry }) => entry as MemoryPacketEntry),
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

function mapAuthority(trust: ContractTrust | null | undefined, blocked: boolean): GuideAuthority {
  if (blocked) return "blocked";
  if (trust === "authoritative") return "trusted";
  if (trust === "advisory") return "advisory";
  if (trust === "observational") return "candidate";
  return "none";
}

function workflowAuthority(trust: ContractTrust | null | undefined, fallback: WorkflowAuthority): WorkflowAuthority {
  if (trust === "authoritative") return "trusted";
  if (trust === "advisory") return "advisory";
  if (trust === "observational") return "candidate";
  return fallback;
}

function recoverTargetFiles(args: {
  firstStep: ContinuityGuidance | null;
  executionSummary: ExecutionSummary | null | undefined;
}): string[] {
  return compactStrings([
    ...(args.firstStep?.continuity_signal_v1?.target_files ?? []),
    args.firstStep?.continuity_signal_v1?.file_path ?? null,
    args.firstStep?.file_path ?? null,
    ...(args.firstStep?.edit_boundary_v1?.allowed_edit_files ?? []),
    ...(args.executionSummary?.collaboration_routing_summary.target_files ?? []),
    ...(args.executionSummary?.continuity_snapshot_summary.working_set ?? []),
  ]);
}

function recoverAcceptanceChecks(args: {
  firstStep: ContinuityGuidance | null;
  executionSummary: ExecutionSummary | null | undefined;
}): string[] {
  return compactStrings([
    ...(args.firstStep?.edit_boundary_v1?.required_verifiers ?? []),
    ...(args.firstStep?.verification_repair_v1?.failed_commands ?? []),
    ...(args.executionSummary?.collaboration_routing_summary.acceptance_checks ?? []),
    ...(args.executionSummary?.continuity_snapshot_summary.validation_paths ?? []),
  ]);
}

function buildWorkflowCandidates(
  planning: PlanningSummary | AssemblySummary,
): AionisGuidePacket["guidance"]["workflow_candidates"] {
  const candidates: AionisGuidePacket["guidance"]["workflow_candidates"] = [];
  const stableIds = planning.action_packet_summary.workflow_anchor_ids;
  const stableTitles = planning.workflow_signal_summary.stable_workflow_titles;
  for (let index = 0; index < stableIds.length; index += 1) {
    const workflowId = stableIds[index];
    if (!workflowId) continue;
    candidates.push({
      workflow_id: workflowId,
      title: stableTitles[index] ?? workflowId,
      authority: "trusted",
      evidence_count: Math.max(1, planning.workflow_lifecycle_summary.stable_count),
      last_outcome: "success",
      reuse_reason: "Stable workflow memory is available for this scope.",
    });
  }

  const candidateIds = planning.action_packet_summary.candidate_workflow_anchor_ids;
  const candidateTitles = [
    ...planning.workflow_signal_summary.promotion_ready_workflow_titles,
    ...planning.workflow_signal_summary.observing_workflow_titles,
  ];
  for (let index = 0; index < candidateIds.length; index += 1) {
    const workflowId = candidateIds[index];
    if (!workflowId) continue;
    candidates.push({
      workflow_id: workflowId,
      title: candidateTitles[index] ?? workflowId,
      authority: workflowAuthority(planning.continuity_guidance?.contract_trust, "candidate"),
      evidence_count: Math.max(1, planning.workflow_lifecycle_summary.candidate_count),
      last_outcome: "unknown",
      reuse_reason: "Candidate workflow evidence is visible but not product-authoritative.",
    });
  }

  return candidates.slice(0, 12);
}

function buildToolPreferences(
  planning: PlanningSummary | AssemblySummary,
  continuitySignalAuthority: GuideAuthority,
): AionisGuidePacket["guidance"]["tool_preferences"] {
  const preferences: AionisGuidePacket["guidance"]["tool_preferences"] = [];
  const selectedTool = planning.selected_tool ?? planning.continuity_guidance?.selected_tool ?? null;
  if (selectedTool) {
    preferences.push({
      tool: selectedTool,
      preference: continuitySignalAuthority === "blocked" || continuitySignalAuthority === "candidate"
        ? "inspect_first"
        : "prefer",
      authority: continuitySignalAuthority === "none" ? "candidate" : continuitySignalAuthority,
      reason: "Selected by the current execution-memory planning summary.",
    });
  }
  for (const tool of planning.trusted_pattern_tools) {
    preferences.push({
      tool,
      preference: "prefer",
      authority: "trusted",
      reason: "Trusted pattern memory supports this tool.",
    });
  }
  for (const tool of planning.contested_pattern_tools) {
    preferences.push({
      tool,
      preference: "inspect_first",
      authority: "candidate",
      reason: "Contested pattern memory is visible but not trusted.",
    });
  }

  const seen = new Set<string>();
  return preferences.filter((entry) => {
    const key = `${entry.tool}:${entry.preference}:${entry.authority}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function buildRiskReasons(
  planning: PlanningSummary | AssemblySummary,
  executionSummary: ExecutionSummary | null | undefined,
): string[] {
  return compactStrings([
    ...planning.authority_visibility_summary.top_blockers,
    planning.action_intelligence_pre_action_gate?.primary_reason ?? null,
    planning.action_retrieval_gate?.primary_reason ?? null,
    planning.forgetting_summary.primary_forgetting_reason,
    executionSummary?.collaboration_summary.rollback_required
      ? "execution packet marks rollback as required"
      : null,
  ]).slice(0, 12);
}

function negativeTransferRisk(planning: PlanningSummary | AssemblySummary): AionisGuidePacket["risk"]["negative_transfer_risk"] {
  if (
    planning.authority_visibility_summary.authoritative_blocked_count > 0
    || planning.authority_visibility_summary.false_confidence_count > 0
    || planning.forgetting_summary.stale_signal_count > 2
  ) {
    return "high";
  }
  if (
    planning.contested_pattern_count > 0
    || planning.policy_lifecycle_summary.contested_count > 0
    || planning.workflow_signal_summary.observing_workflow_count > 0
    || planning.forgetting_summary.stale_signal_count > 0
  ) {
    return "medium";
  }
  return "low";
}

function buildGuideHistoryContributions(
  planning: PlanningSummary | AssemblySummary,
): AionisGuidePacket["history_contributions"] {
  const handoffSourceCount =
    planning.continuity_carrier_summary.handoff_count
    + planning.distillation_signal_summary.origin_counts.handoff_continuity_carrier;
  const replaySourceCount =
    planning.workflow_lifecycle_summary.replay_source_count
    + planning.distillation_signal_summary.origin_counts.replay_learning_episode;
  const replayWorkflowIds = replaySourceCount > 0
    ? compactStrings([
        ...planning.action_packet_summary.workflow_anchor_ids,
        ...planning.action_packet_summary.candidate_workflow_anchor_ids,
      ])
    : [];

  return {
    handoff: {
      used: handoffSourceCount > 0,
      source_count: handoffSourceCount,
      source_ids: [],
      changed_fields: handoffSourceCount > 0
        ? compactStrings(["recovered_state", "history_impact.continuity"])
        : [],
      reason: handoffSourceCount > 0
        ? "Handoff continuity carriers contributed to recovered state or next-run continuity."
        : "No handoff continuity carrier contributed to this packet.",
    },
    replay: {
      used: replaySourceCount > 0,
      source_count: replaySourceCount,
      source_ids: replayWorkflowIds,
      changed_fields: replaySourceCount > 0
        ? compactStrings(["guidance.workflow_candidates", "history_impact.learning"])
        : [],
      reason: replaySourceCount > 0
        ? "Replay-derived workflow evidence contributed to workflow reuse guidance."
        : "No replay-derived workflow evidence contributed to this packet.",
    },
  };
}

function guideBriefAuthority(args: {
  historyUsed: boolean;
  workflowCandidates: AionisGuidePacket["guidance"]["workflow_candidates"];
  toolPreferences: AionisGuidePacket["guidance"]["tool_preferences"];
  blockedAuthorityCount: number;
}): GuideAuthority {
  if (!args.historyUsed) return "none";
  const authorities = [
    ...args.workflowCandidates.map((entry) => entry.authority),
    ...args.toolPreferences.map((entry) => entry.authority),
  ];
  if (authorities.includes("trusted")) return "trusted";
  if (authorities.includes("advisory")) return "advisory";
  if (authorities.includes("candidate")) return "candidate";
  if (args.blockedAuthorityCount > 0 || authorities.includes("blocked")) return "blocked";
  return "candidate";
}

function guideBriefPosture(args: {
  historyUsed: boolean;
  requiredRehydrationCount: number;
  negativeTransferRisk: AionisGuidePacket["risk"]["negative_transfer_risk"];
  blockedAuthorityCount: number;
  authority: GuideAuthority;
}): AionisGuidePacket["guide_brief"]["recommended_posture"] {
  if (!args.historyUsed) return "ignore_history";
  if (args.requiredRehydrationCount > 0) return "rehydrate_before_use";
  if (args.negativeTransferRisk === "high" || args.blockedAuthorityCount > 0) return "inspect_before_use";
  if (args.authority === "trusted" || args.authority === "advisory") return "reuse_supported_history";
  return "use_as_context";
}

function guideBriefSummary(args: {
  posture: AionisGuidePacket["guide_brief"]["recommended_posture"];
  authority: GuideAuthority;
}): string {
  if (args.posture === "ignore_history") {
    return "No usable history was recovered for this query.";
  }
  if (args.posture === "rehydrate_before_use") {
    return "Relevant history exists, but compact payload rehydration is required before reuse.";
  }
  if (args.posture === "inspect_before_use") {
    return "Relevant history exists, but authority, stale-memory, or contradiction risk requires inspection before reuse.";
  }
  if (args.posture === "reuse_supported_history") {
    return args.authority === "trusted"
      ? "Trusted history can be reused to reduce repeated discovery and context replay."
      : "Advisory history can guide the run while leaving final reasoning to the Agent.";
  }
  return "History is available as context, but it is not strong enough to drive behavior directly.";
}

function buildAionisGuideBrief(args: {
  stateSummary: string | null;
  resumable: boolean;
  targetFiles: string[];
  acceptanceChecks: string[];
  workflowCandidates: AionisGuidePacket["guidance"]["workflow_candidates"];
  toolPreferences: AionisGuidePacket["guidance"]["tool_preferences"];
  historyContributions: AionisGuidePacket["history_contributions"];
  memoryLifecycle: AionisGuidePacket["memory_lifecycle"];
  negativeTransferRisk: AionisGuidePacket["risk"]["negative_transfer_risk"];
  blockedAuthorityCount: number;
  staleMemoryCount: number;
  riskReasons: string[];
}): AionisGuidePacket["guide_brief"] {
  const trustedOrAdvisoryWorkflows = args.workflowCandidates
    .filter((entry) => entry.authority === "trusted" || entry.authority === "advisory")
    .map((entry) => `Workflow ${entry.authority}: ${entry.title}`);
  const trustedOrAdvisoryTools = args.toolPreferences
    .filter((entry) => entry.authority === "trusted" || entry.authority === "advisory")
    .map((entry) => `Tool ${entry.preference}: ${entry.tool}`);
  const candidateSurfaces = [
    ...args.workflowCandidates
      .filter((entry) => entry.authority === "candidate")
      .map((entry) => `Candidate workflow: ${entry.title}`),
    ...args.toolPreferences
      .filter((entry) => entry.authority === "candidate")
      .map((entry) => `Candidate tool preference: ${entry.tool}`),
    ...args.acceptanceChecks.map((entry) => `Verify before relying on history: ${entry}`),
  ];
  const blockedSurfaces = [
    ...args.workflowCandidates
      .filter((entry) => entry.authority === "blocked")
      .map((entry) => `Blocked workflow authority: ${entry.title}`),
    ...args.toolPreferences
      .filter((entry) => entry.authority === "blocked")
      .map((entry) => `Blocked tool preference: ${entry.tool}`),
    ...args.memoryLifecycle.suppressed_memory_ids.map((memoryId) => `Suppressed memory: ${memoryId}`),
  ];
  const historyUsed =
    args.resumable
    || args.historyContributions.handoff.used
    || args.historyContributions.replay.used
    || args.workflowCandidates.length > 0
    || args.toolPreferences.length > 0
    || args.targetFiles.length > 0;
  const requiredRehydrationCount = args.memoryLifecycle.rehydration_hints
    .filter((entry) => entry.required).length;
  const authority = guideBriefAuthority({
    historyUsed,
    workflowCandidates: args.workflowCandidates,
    toolPreferences: args.toolPreferences,
    blockedAuthorityCount: args.blockedAuthorityCount,
  });
  const posture = guideBriefPosture({
    historyUsed,
    requiredRehydrationCount,
    negativeTransferRisk: args.negativeTransferRisk,
    blockedAuthorityCount: args.blockedAuthorityCount,
    authority,
  });
  const reducesRepeatedDiscovery =
    args.targetFiles.length > 0
    || args.workflowCandidates.length > 0
    || args.historyContributions.replay.used;
  const reducesContextReplay =
    args.resumable
    || args.historyContributions.handoff.used
    || args.memoryLifecycle.rehydration_hints.length > 0;
  const controlsNegativeTransfer =
    args.negativeTransferRisk !== "low"
    || args.blockedAuthorityCount > 0
    || args.staleMemoryCount > 0
    || blockedSurfaces.length > 0;

  return {
    summary: guideBriefSummary({ posture, authority }),
    history_used: historyUsed,
    recommended_posture: posture,
    authority,
    use_now: compactStrings([
      args.stateSummary ? `Recovered state: ${args.stateSummary}` : null,
      args.targetFiles.length > 0 ? `Relevant target files: ${args.targetFiles.slice(0, 6).join(", ")}` : null,
      ...trustedOrAdvisoryWorkflows,
      ...trustedOrAdvisoryTools,
    ]).slice(0, 8),
    inspect_before_use: compactStrings([
      ...candidateSurfaces,
      ...args.riskReasons,
    ]).slice(0, 8),
    do_not_use: compactStrings(blockedSurfaces).slice(0, 8),
    rehydrate: args.memoryLifecycle.rehydration_hints.slice(0, 8),
    expected_product_effects: {
      reduces_repeated_discovery: reducesRepeatedDiscovery,
      reduces_context_replay: reducesContextReplay,
      controls_negative_transfer: controlsNegativeTransfer,
      reason: compactStrings([
        reducesRepeatedDiscovery ? "Guide includes recovered targets or workflow evidence that can reduce repeated discovery." : null,
        reducesContextReplay ? "Guide includes resumable continuity or differential rehydration instead of full history replay." : null,
        controlsNegativeTransfer ? "Guide exposes stale, blocked, or candidate history instead of silently applying it." : null,
        !reducesRepeatedDiscovery && !reducesContextReplay && !controlsNegativeTransfer
          ? "No measurable product effect is visible in this guide packet."
          : null,
      ]).join(" "),
    },
  };
}

type AgentContextPromptProfile = {
  summaryChars: number;
  targetFileItems: number;
  targetFileChars: number;
  useNowItems: number;
  useNowChars: number;
  inspectItems: number;
  inspectChars: number;
  doNotUseItems: number;
  doNotUseChars: number;
  rehydrateItems: number;
  rehydrateChars: number;
  memoryIdItems: number;
};

const AGENT_CONTEXT_PROMPT_PROFILES: Record<"balanced" | "aggressive" | "tight" | "minimal" | "ids_only", AgentContextPromptProfile> = {
  balanced: {
    summaryChars: 140,
    targetFileItems: 6,
    targetFileChars: 120,
    useNowItems: 4,
    useNowChars: 220,
    inspectItems: 3,
    inspectChars: 140,
    doNotUseItems: 3,
    doNotUseChars: 140,
    rehydrateItems: 3,
    rehydrateChars: 100,
    memoryIdItems: 6,
  },
  aggressive: {
    summaryChars: 120,
    targetFileItems: 4,
    targetFileChars: 90,
    useNowItems: 3,
    useNowChars: 150,
    inspectItems: 2,
    inspectChars: 110,
    doNotUseItems: 2,
    doNotUseChars: 110,
    rehydrateItems: 2,
    rehydrateChars: 80,
    memoryIdItems: 5,
  },
  tight: {
    summaryChars: 96,
    targetFileItems: 3,
    targetFileChars: 70,
    useNowItems: 2,
    useNowChars: 110,
    inspectItems: 1,
    inspectChars: 90,
    doNotUseItems: 1,
    doNotUseChars: 90,
    rehydrateItems: 1,
    rehydrateChars: 70,
    memoryIdItems: 4,
  },
  minimal: {
    summaryChars: 80,
    targetFileItems: 2,
    targetFileChars: 50,
    useNowItems: 1,
    useNowChars: 80,
    inspectItems: 1,
    inspectChars: 70,
    doNotUseItems: 1,
    doNotUseChars: 70,
    rehydrateItems: 1,
    rehydrateChars: 60,
    memoryIdItems: 3,
  },
  ids_only: {
    summaryChars: 60,
    targetFileItems: 0,
    targetFileChars: 0,
    useNowItems: 0,
    useNowChars: 0,
    inspectItems: 0,
    inspectChars: 0,
    doNotUseItems: 0,
    doNotUseChars: 0,
    rehydrateItems: 0,
    rehydrateChars: 0,
    memoryIdItems: 3,
  },
};

function boundedPromptCharBudget(value: number | null | undefined): number | null {
  if (!Number.isFinite(value ?? NaN)) return null;
  return Math.max(1, Math.floor(Number(value)));
}

function promptProfilesFor(
  profile: "balanced" | "aggressive" | null | undefined,
  budget: number | null,
): AgentContextPromptProfile[] {
  if (budget === null) {
    return [AGENT_CONTEXT_PROMPT_PROFILES[profile === "aggressive" ? "aggressive" : "balanced"]];
  }
  return profile === "aggressive"
    ? [
        AGENT_CONTEXT_PROMPT_PROFILES.aggressive,
        AGENT_CONTEXT_PROMPT_PROFILES.tight,
        AGENT_CONTEXT_PROMPT_PROFILES.minimal,
        AGENT_CONTEXT_PROMPT_PROFILES.ids_only,
      ]
    : [
        AGENT_CONTEXT_PROMPT_PROFILES.balanced,
        AGENT_CONTEXT_PROMPT_PROFILES.aggressive,
        AGENT_CONTEXT_PROMPT_PROFILES.tight,
        AGENT_CONTEXT_PROMPT_PROFILES.minimal,
        AGENT_CONTEXT_PROMPT_PROFILES.ids_only,
      ];
}

function renderAgentContextPrompt(args: {
  summary: string;
  historyUsed: boolean;
  recommendedPosture: AionisAgentContext["recommended_posture"];
  authority: AionisAgentContext["authority"];
  negativeTransferRisk: AionisAgentContext["risk"]["negative_transfer_risk"];
  targetFiles: string[];
  useNow: string[];
  inspectBeforeUse: string[];
  doNotUse: string[];
  memoryIds: string[];
  rehydrateHints: AionisAgentContext["rehydrate_hints"];
  profile: AgentContextPromptProfile;
}): string {
  const inline = (label: string, values: string[], maxItems: number, maxChars: number): string | null => {
    if (maxItems <= 0 || maxChars <= 0) return null;
    const entries = values
      .slice(0, maxItems)
      .map((entry) => shortenPromptText(entry, maxChars));
    return entries.length > 0 ? `${label}: ${entries.join(" | ")}` : null;
  };
  const sections = compactStrings([
    `AIONIS_AGENT_CONTEXT v1`,
    `state: history=${args.historyUsed ? "yes" : "no"} posture=${args.recommendedPosture} authority=${args.authority} risk=${args.negativeTransferRisk}`,
    `summary: ${shortenPromptText(args.summary, args.profile.summaryChars)}`,
    inline("target_files", args.targetFiles, args.profile.targetFileItems, args.profile.targetFileChars),
    inline("use_now", args.useNow, args.profile.useNowItems, args.profile.useNowChars),
    inline("inspect_before_use", args.inspectBeforeUse, args.profile.inspectItems, args.profile.inspectChars),
    inline("do_not_use", args.doNotUse, args.profile.doNotUseItems, args.profile.doNotUseChars),
    args.rehydrateHints.length > 0 && args.profile.rehydrateItems > 0
      ? `rehydrate_if_needed: ${args.rehydrateHints
        .slice(0, args.profile.rehydrateItems)
        .map((entry) => `${entry.memory_id}${entry.required ? "!" : ""}:${shortenPromptText(entry.reason, args.profile.rehydrateChars)}`)
        .join(" | ")}`
      : null,
    args.memoryIds.length > 0 && args.profile.memoryIdItems > 0
      ? `memory_ids: ${args.memoryIds.slice(0, args.profile.memoryIdItems).join(",")}`
      : null,
  ]);
  return sections.join("\n");
}

function buildAgentContextPrompt(args: {
  summary: string;
  historyUsed: boolean;
  recommendedPosture: AionisAgentContext["recommended_posture"];
  authority: AionisAgentContext["authority"];
  negativeTransferRisk: AionisAgentContext["risk"]["negative_transfer_risk"];
  targetFiles: string[];
  useNow: string[];
  inspectBeforeUse: string[];
  doNotUse: string[];
  memoryIds: string[];
  rehydrateHints: AionisAgentContext["rehydrate_hints"];
  contextCharBudget?: number | null;
  contextCompactionProfile?: "balanced" | "aggressive" | null;
}): string {
  const budget = boundedPromptCharBudget(args.contextCharBudget);
  let lastPrompt = "";
  for (const profile of promptProfilesFor(args.contextCompactionProfile, budget)) {
    const prompt = renderAgentContextPrompt({ ...args, profile });
    lastPrompt = prompt;
    if (budget === null || prompt.length <= budget) return prompt;
  }
  return budget === null ? lastPrompt : shortenPromptText(lastPrompt, budget);
}

function shortenPromptText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function memoryEntryBlocked(entry: MemoryPacketEntry): boolean {
  return entry.authority === "blocked"
    || entry.lifecycle_state === "suppressed"
    || entry.lifecycle_state === "archived";
}

function memoryEntryInspectBeforeUse(entry: MemoryPacketEntry): boolean {
  return entry.authority === "candidate"
    || entry.lifecycle_state === "candidate"
    || entry.lifecycle_state === "contested"
    || entry.lifecycle_state === "demoted"
    || entry.lifecycle_state === "rehydration_candidate";
}

function memoryEntryUsable(entry: MemoryPacketEntry): boolean {
  return (entry.authority === "trusted" || entry.authority === "advisory")
    && entry.lifecycle_state === "active";
}

function memoryEntryLabel(entry: MemoryPacketEntry): string {
  return compactStrings([entry.title, entry.memory_id])[0] ?? entry.memory_id;
}

function memoryEntryUseNowLine(entry: MemoryPacketEntry, deniedPathTargets: Set<string> = new Set()): string | null {
  const prefix = entry.memory_type === "preference"
    ? "Preference"
    : entry.memory_type === "project_context"
      ? "Project memory"
      : entry.domain === "execution"
        ? "Execution memory"
        : "Memory";
  const summary = sanitizeAgentFacingSummary(entry.summary, deniedPathTargets);
  if (!summary) return null;
  return `${prefix}: ${summary}`.slice(0, 520);
}

function memoryEntryInspectLine(entry: MemoryPacketEntry): string {
  return `Inspect memory before use: ${memoryEntryLabel(entry)}`.slice(0, 220);
}

function memoryEntryMatchTerms(entry: MemoryPacketEntry): string[] {
  return compactStrings([
    entry.title,
    entry.memory_id,
  ]).filter((term) => term.length >= 4);
}

function textMatchesMemoryEntry(text: string, entry: MemoryPacketEntry): boolean {
  const lower = text.toLowerCase();
  return memoryEntryMatchTerms(entry).some((term) => lower.includes(term.toLowerCase()));
}

function workflowUseNowLine(text: string): boolean {
  return /^\s*Workflow\s+(trusted|advisory):/i.test(text);
}

function executionEvidenceUseNowLine(text: string): boolean {
  return /^\s*(Passed solution|Current active path):/i.test(text);
}

const TRUSTED_WORKFLOW_CONFLICT_WORDS = [
  "conflict",
  "conflicting",
  "contradict",
  "contradiction",
  "inconsistent",
  "incompatible",
  "stale",
  "outdated",
  "obsolete",
  "wrong",
  "invalid",
  "known-bad",
  "known bad",
  "false hypothesis",
  "false positive",
];

function workflowConflictSignals(entry: MemoryPacketEntry): string[] {
  const text = compactStrings([entry.title, entry.summary]).join("\n").toLowerCase();
  return TRUSTED_WORKFLOW_CONFLICT_WORDS.filter((word) => text.includes(word));
}

function extractPathTargets(text: string): string[] {
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

function sentenceChunks(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?;])\s+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

function containsDeniedPathTarget(text: string, deniedPathTargets: Set<string>): boolean {
  if (deniedPathTargets.size === 0) return false;
  return extractPathTargets(text).some((target) => deniedPathTargets.has(target));
}

function sanitizeAgentFacingSummary(summary: string, deniedPathTargets: Set<string>): string {
  const compacted = summary.replace(/\s+/g, " ").trim();
  if (!compacted || deniedPathTargets.size === 0) return compacted;
  const kept = sentenceChunks(compacted).filter((chunk) =>
    !containsDeniedPathTarget(chunk, deniedPathTargets)
  );
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

function deniedAgentActionPathTargets(entries: MemoryPacketEntry[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    if (!memoryEntryBlocked(entry) && !memoryEntryInspectBeforeUse(entry)) continue;
    for (const target of extractPathTargets(`${entry.title ?? ""}\n${entry.summary}`)) {
      out.add(target);
    }
  }
  return out;
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

function sameTargetSet(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const rightSet = new Set(right);
  return left.some((entry) => rightSet.has(entry));
}

function normalizePathTarget(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/[),.;:]+$/g, "")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
  return normalized.length > 0 ? normalized : null;
}

function memoryEntryPathTargets(entry: MemoryPacketEntry): string[] {
  const structuredTargets = compactStrings(entry.target_files.map(normalizePathTarget));
  if (structuredTargets.length > 0) return structuredTargets;
  return compactStrings(extractPathTargets(`${entry.title ?? ""}\n${entry.summary}`).map(normalizePathTarget));
}

function trustedWorkflowConflictAudit(entries: MemoryPacketEntry[]): {
  hasConflict: boolean;
  moveAllWorkflowUseNow: boolean;
  conflictedEntries: MemoryPacketEntry[];
  reasons: string[];
} {
  const workflowEntries = entries.filter((entry) =>
    memoryEntryUsable(entry)
    && entry.domain === "execution"
    && (entry.memory_type === "execution_memory" || entry.memory_type === "procedure")
    && entry.authority === "trusted",
  );
  if (workflowEntries.length < 2) {
    return { hasConflict: false, moveAllWorkflowUseNow: false, conflictedEntries: [], reasons: [] };
  }

  const selfDisclaimed = workflowEntries.filter((entry) => workflowConflictSignals(entry).length > 0);
  const entriesWithTargets = workflowEntries
    .map((entry) => ({ entry, targets: memoryEntryPathTargets(entry) }))
    .filter((item) => item.targets.length > 0);
  const targetConflictEntries = new Set<MemoryPacketEntry>();
  for (let index = 0; index < entriesWithTargets.length; index += 1) {
    for (let next = index + 1; next < entriesWithTargets.length; next += 1) {
      const left = entriesWithTargets[index];
      const right = entriesWithTargets[next];
      if (left && right && !sameTargetSet(left.targets, right.targets)) {
        targetConflictEntries.add(left.entry);
        targetConflictEntries.add(right.entry);
      }
    }
  }

  const conflictedEntries = [...new Set([...selfDisclaimed, ...targetConflictEntries])];
  const hasTargetConflict = targetConflictEntries.size > 0;
  const ambiguousMultipleWorkflows =
    workflowEntries.length > 1
    && selfDisclaimed.length === 0
    && !hasTargetConflict;
  const moveAllTrustedWorkflows = workflowEntries.length > 1;
  return {
    hasConflict: conflictedEntries.length > 0 || moveAllTrustedWorkflows,
    moveAllWorkflowUseNow: moveAllTrustedWorkflows,
    conflictedEntries: moveAllTrustedWorkflows ? workflowEntries : conflictedEntries,
    reasons: compactStrings([
      selfDisclaimed.length > 0 ? "trusted_workflow_self_disclaimed_conflict" : null,
      hasTargetConflict ? "trusted_workflow_target_conflict" : null,
      ambiguousMultipleWorkflows ? "multiple_trusted_workflows_require_inspection" : null,
      moveAllTrustedWorkflows && !ambiguousMultipleWorkflows ? "multiple_trusted_workflows_require_inspection" : null,
    ]),
  };
}

function riskAtLeast(current: AionisRiskLevel, minimum: AionisRiskLevel): AionisRiskLevel {
  const rank: Record<AionisRiskLevel, number> = { low: 0, medium: 1, high: 2 };
  return rank[current] >= rank[minimum] ? current : minimum;
}

function compileAgentContextSurfaces(args: {
  rawUseNow: string[];
  rawInspectBeforeUse: string[];
  rawDoNotUse: string[];
  rawTargetFiles: string[];
  memoryEntries: MemoryPacketEntry[];
  rawHistoryUsed: boolean;
  rawRecommendedPosture: AionisAgentContext["recommended_posture"];
  rawAuthority: AionisAgentContext["authority"];
  rawRisk: AionisAgentContext["risk"];
  rehydrateHints: AionisAgentContext["rehydrate_hints"];
}): {
  historyUsed: boolean;
  recommendedPosture: AionisAgentContext["recommended_posture"];
  authority: AionisAgentContext["authority"];
  targetFiles: string[];
  useNow: string[];
  inspectBeforeUse: string[];
  doNotUse: string[];
  useNowMemoryIds: string[];
  inspectBeforeUseMemoryIds: string[];
  doNotUseMemoryIds: string[];
  risk: AionisAgentContext["risk"];
} {
  const blockedEntries = args.memoryEntries.filter(memoryEntryBlocked);
  const inspectEntries = args.memoryEntries.filter((entry) => !memoryEntryBlocked(entry) && memoryEntryInspectBeforeUse(entry));
  const usableEntries = args.memoryEntries.filter(memoryEntryUsable);
  const deniedPathTargets = deniedAgentActionPathTargets(args.memoryEntries);
  const hasUsableMemory = usableEntries.length > 0;
  const hasRawGuideSurface =
    args.rawTargetFiles.length > 0
    || args.rawUseNow.length > 0
    || args.rawInspectBeforeUse.length > 0
    || args.rawDoNotUse.length > 0
    || args.rehydrateHints.length > 0;
  const trustedConflict = trustedWorkflowConflictAudit(args.memoryEntries);
  const trustedConflictIds = new Set(trustedConflict.conflictedEntries.map((entry) => entry.memory_id));
  const trustedWorkflowConflictInspectIds = new Set<string>();
  if (trustedConflict.hasConflict) {
    for (const entry of usableEntries) {
      const trustedWorkflow =
        entry.domain === "execution"
        && (entry.memory_type === "execution_memory" || entry.memory_type === "procedure")
        && entry.authority === "trusted";
      if (
        (trustedConflict.moveAllWorkflowUseNow && trustedWorkflow)
        || trustedConflictIds.has(entry.memory_id)
      ) {
        trustedWorkflowConflictInspectIds.add(entry.memory_id);
      }
    }
  }
  const directUseMemoryEntries = usableEntries.filter((entry) => !trustedWorkflowConflictInspectIds.has(entry.memory_id));
  const conflictInspectMemoryEntries = usableEntries.filter((entry) => trustedWorkflowConflictInspectIds.has(entry.memory_id));
  const memoryUseNow = compactStrings(directUseMemoryEntries.map((entry) => memoryEntryUseNowLine(entry, deniedPathTargets)));
  const memoryUseNowPathTargets = compactStrings(memoryUseNow.flatMap(extractPathTargets));
  const memoryUseNowPathTargetSet = new Set(memoryUseNowPathTargets);

  const movedToInspect: string[] = [];
  const movedToDoNotUse: string[] = [];
  const filteredUseNow = args.rawUseNow.filter((entry) => {
    const blocked = blockedEntries.find((memory) => textMatchesMemoryEntry(entry, memory));
    if (blocked) {
      movedToDoNotUse.push(`Blocked memory: ${memoryEntryLabel(blocked)}`);
      return false;
    }
    const inspect = inspectEntries.find((memory) => textMatchesMemoryEntry(entry, memory));
    if (inspect) {
      movedToInspect.push(`Inspect memory before use: ${memoryEntryLabel(inspect)}`);
      return false;
    }
    const conflicted = trustedConflict.conflictedEntries.find((memory) => textMatchesMemoryEntry(entry, memory));
    if (
      trustedConflict.hasConflict
      && workflowUseNowLine(entry)
      && (trustedConflict.moveAllWorkflowUseNow || conflicted)
    ) {
      movedToInspect.push(conflicted
        ? `Inspect conflicting trusted workflow: ${memoryEntryLabel(conflicted)}`
        : "Inspect trusted workflow conflict before reuse");
      return false;
    }
    if (executionEvidenceUseNowLine(entry)) return true;
    return hasUsableMemory || args.memoryEntries.length === 0;
  });

  const rawTargetFiles = args.rawTargetFiles.filter((target) =>
    !deniedPathTargets.has(target) || memoryUseNowPathTargetSet.has(target)
  );
  const targetFiles = hasUsableMemory || rawTargetFiles.length > 0
    ? compactStrings([
        ...rawTargetFiles,
        ...memoryUseNowPathTargets,
      ]).slice(0, 8)
    : [];
  const inspectBeforeUse = compactStrings([
    ...args.rawInspectBeforeUse,
    ...movedToInspect,
    ...inspectEntries.map(memoryEntryInspectLine),
    ...conflictInspectMemoryEntries.map((entry) => `Inspect conflicting trusted workflow: ${memoryEntryLabel(entry)}`),
  ]).slice(0, 5);
  const doNotUse = compactStrings([
    ...args.rawDoNotUse,
    ...movedToDoNotUse,
    ...blockedEntries.map((entry) => `Blocked memory: ${memoryEntryLabel(entry)}`),
  ]).slice(0, 5);

  const hasRiskSurface = inspectBeforeUse.length > args.rawInspectBeforeUse.length
    || doNotUse.length > args.rawDoNotUse.length
    || inspectEntries.length > 0
    || blockedEntries.length > 0
    || trustedConflict.hasConflict;
  const historyUsed = (args.rawHistoryUsed || hasUsableMemory || inspectEntries.length > 0 || blockedEntries.length > 0 || hasRawGuideSurface) && (
    hasUsableMemory
    || inspectEntries.length > 0
    || blockedEntries.length > 0
    || hasRawGuideSurface
  );
  let negativeTransferRisk = args.rawRisk.negative_transfer_risk;
  if (blockedEntries.length > 0) negativeTransferRisk = riskAtLeast(negativeTransferRisk, "high");
  else if (inspectEntries.length > 0) negativeTransferRisk = riskAtLeast(negativeTransferRisk, "medium");
  if (trustedConflict.hasConflict) negativeTransferRisk = riskAtLeast(negativeTransferRisk, "medium");

  const recommendedPosture: AionisAgentContext["recommended_posture"] = !historyUsed
    ? "ignore_history"
    : hasRiskSurface
      ? "inspect_before_use"
      : args.rawRecommendedPosture === "ignore_history"
        ? "use_as_context"
        : args.rawRecommendedPosture;

  const usableAuthority: AionisAgentContext["authority"] = args.rawAuthority === "trusted"
    ? "trusted"
    : args.rawAuthority === "advisory"
      ? "advisory"
      : usableEntries.some((entry) => entry.authority === "trusted")
    ? "trusted"
    : usableEntries.some((entry) => entry.authority === "advisory")
      ? "advisory"
      : args.rawAuthority;

  const authority: AionisAgentContext["authority"] = !historyUsed
    ? "none"
    : trustedConflict.hasConflict && hasUsableMemory
      ? "advisory"
      : hasUsableMemory
      ? usableAuthority === "none" ? "advisory" : usableAuthority
      : blockedEntries.length > 0
        ? "blocked"
        : inspectEntries.length > 0
          ? "candidate"
          : args.rawAuthority;

  return {
    historyUsed,
    recommendedPosture,
    authority,
    targetFiles,
    useNow: compactStrings([
      ...filteredUseNow,
      ...directUseMemoryEntries.map((entry) => memoryEntryUseNowLine(entry, deniedPathTargets)),
    ]).slice(0, 6),
    inspectBeforeUse,
    doNotUse,
    useNowMemoryIds: compactStrings(directUseMemoryEntries.map((entry) => entry.memory_id)).slice(0, 10),
    inspectBeforeUseMemoryIds: compactStrings([
      ...inspectEntries.map((entry) => entry.memory_id),
      ...conflictInspectMemoryEntries.map((entry) => entry.memory_id),
    ]).slice(0, 10),
    doNotUseMemoryIds: compactStrings(blockedEntries.map((entry) => entry.memory_id)).slice(0, 10),
    risk: {
      negative_transfer_risk: negativeTransferRisk,
      blocked_authority_count: args.rawRisk.blocked_authority_count + blockedEntries.length,
      stale_memory_count: args.rawRisk.stale_memory_count,
      reasons: compactStrings([
        trustedConflict.hasConflict ? "trusted_workflow_conflict_requires_inspection" : null,
        ...trustedConflict.reasons,
        inspectEntries.length > 0 ? "candidate_or_contested_memory_kept_out_of_use_now" : null,
        blockedEntries.length > 0 ? "blocked_or_suppressed_memory_kept_out_of_use_now" : null,
        ...args.rawRisk.reasons,
      ]).slice(0, 5),
    },
  };
}

export function buildAionisAgentContext(args: BuildAionisAgentContextArgs): AionisAgentContext {
  const guide = args.guide_packet ?? null;
  const memory = args.memory_packet ?? null;
  const guideBrief = guide?.guide_brief ?? null;
  const memoryEntryCount = memory?.relevant_memories.length ?? 0;
  const rawHistoryUsed = guideBrief?.history_used === true || memoryEntryCount > 0;
  const rawTargetFiles = compactStrings([
    ...(guide?.recovered_state.target_files ?? []),
  ]).slice(0, 8);
  const rehydrateHints = (guide?.memory_lifecycle.rehydration_hints ?? guideBrief?.rehydrate ?? []).slice(0, 6);
  const memoryIds = compactStrings([
    ...(guide?.memory_lifecycle.used_memory_ids ?? []),
    ...(memory?.lifecycle.used_memory_ids ?? []),
    ...rehydrateHints.map((entry) => entry.memory_id),
  ]).slice(0, 10);
  const workflowIds = compactStrings(
    guide?.guidance.workflow_candidates.map((entry) => entry.workflow_id) ?? [],
  ).slice(0, 10);
  const evidenceCount =
    (memory?.evidence_trail.length ?? 0)
    + (guide?.proven_facts.length ?? 0)
    + (guide?.guidance.workflow_candidates.reduce((sum, entry) => sum + entry.evidence_count, 0) ?? 0);
  const risk = {
    negative_transfer_risk:
      guide?.risk.negative_transfer_risk
      ?? memory?.risk.negative_transfer_risk
      ?? "low",
    blocked_authority_count: guide?.risk.blocked_authority_count ?? 0,
    stale_memory_count:
      guide?.risk.stale_memory_count
      ?? memory?.forgetting_state.stale_memory_count
      ?? memory?.risk.stale_memory_count
      ?? 0,
    reasons: compactStrings(guide?.risk.reasons ?? []).slice(0, 5),
  };
  const rawSummary =
    guideBrief?.history_used === true
      ? guideBrief.summary
      : memoryEntryCount > 0
        ? "Relevant Aionis memory is available as compact context."
        : "No usable Aionis history was recovered.";
  const rawRecommendedPosture =
    guideBrief?.recommended_posture
    ?? (rawHistoryUsed ? "use_as_context" : "ignore_history");
  const rawAuthority = guideBrief?.authority ?? "candidate";
  const surfaces = compileAgentContextSurfaces({
    rawUseNow: compactStrings(guideBrief?.use_now ?? []).slice(0, 8),
    rawInspectBeforeUse: compactStrings(guideBrief?.inspect_before_use ?? []).slice(0, 8),
    rawDoNotUse: compactStrings(guideBrief?.do_not_use ?? []).slice(0, 8),
    rawTargetFiles,
    memoryEntries: memory?.relevant_memories ?? [],
    rawHistoryUsed,
    rawRecommendedPosture,
    rawAuthority,
    rawRisk: risk,
    rehydrateHints,
  });
  const summary = surfaces.historyUsed
    ? rawSummary
    : "No usable Aionis history was recovered for the Agent context.";
  const promptText = buildAgentContextPrompt({
    summary,
    historyUsed: surfaces.historyUsed,
    recommendedPosture: surfaces.recommendedPosture,
    authority: surfaces.authority,
    negativeTransferRisk: surfaces.risk.negative_transfer_risk,
    targetFiles: surfaces.targetFiles,
    useNow: surfaces.useNow,
    inspectBeforeUse: surfaces.inspectBeforeUse,
    doNotUse: surfaces.doNotUse,
    memoryIds,
    rehydrateHints,
    contextCharBudget: args.context_char_budget,
    contextCompactionProfile: args.context_compaction_profile,
  });

  return parseAionisAgentContext({
    contract_version: "aionis_agent_context_v1",
    tenant_id: guide?.tenant_id ?? memory?.tenant_id ?? args.tenant_id,
    scope: guide?.scope ?? memory?.scope ?? args.scope,
    prompt_text: promptText,
    summary,
    history_used: surfaces.historyUsed,
    recommended_posture: surfaces.recommendedPosture,
    authority: surfaces.authority,
    target_files: surfaces.targetFiles,
    use_now: surfaces.useNow,
    inspect_before_use: surfaces.inspectBeforeUse,
    do_not_use: surfaces.doNotUse,
    memory_ids: memoryIds,
    use_now_memory_ids: surfaces.useNowMemoryIds,
    inspect_before_use_memory_ids: surfaces.inspectBeforeUseMemoryIds,
    do_not_use_memory_ids: surfaces.doNotUseMemoryIds,
    rehydrate_hints: rehydrateHints,
    risk: surfaces.risk,
    evidence_refs: {
      memory_ids: memoryIds,
      workflow_ids: workflowIds,
      evidence_count: evidenceCount,
    },
  });
}

export function applyAionisInspectBeforeUseActiveProjection(
  args: ApplyAionisInspectBeforeUseActiveProjectionArgs,
): AionisAgentContext {
  const memory = args.memory_packet ?? null;
  const currentUseNowIds = new Set(args.agent_context.use_now_memory_ids);
  const candidateIds = new Set(compactStrings(args.candidate_memory_ids));
  const memoryEntries = memory?.relevant_memories ?? [];
  const entriesToMove = memoryEntries.filter((entry) =>
    candidateIds.has(entry.memory_id)
    && currentUseNowIds.has(entry.memory_id)
  );
  if (entriesToMove.length === 0) return args.agent_context;

  const movingIds = new Set(entriesToMove.map((entry) => entry.memory_id));
  const deniedPathTargets = deniedAgentActionPathTargets(memoryEntries);
  const generatedUseNowLines = new Set(compactStrings(
    entriesToMove.map((entry) => memoryEntryUseNowLine(entry, deniedPathTargets)),
  ));
  const movedInspectLines = compactStrings(entriesToMove.map(memoryEntryInspectLine));
  const useNow = compactStrings(args.agent_context.use_now.filter((entry) =>
    !generatedUseNowLines.has(entry)
  )).slice(0, 6);
  const inspectBeforeUse = compactStrings([
    ...args.agent_context.inspect_before_use,
    ...movedInspectLines,
  ]).slice(0, 5);
  const useNowMemoryIds = compactStrings(args.agent_context.use_now_memory_ids.filter((memoryId) =>
    !movingIds.has(memoryId)
  )).slice(0, 10);
  const inspectBeforeUseMemoryIds = compactStrings([
    ...args.agent_context.inspect_before_use_memory_ids,
    ...entriesToMove.map((entry) => entry.memory_id),
  ]).slice(0, 10);
  const negativeTransferRisk = riskAtLeast(args.agent_context.risk.negative_transfer_risk, "medium");
  const risk = {
    ...args.agent_context.risk,
    negative_transfer_risk: negativeTransferRisk,
    reasons: compactStrings([
      ...args.agent_context.risk.reasons,
      args.reason,
    ]).slice(0, 5),
  };
  const authority: AionisAgentContext["authority"] = args.agent_context.authority === "trusted"
    ? "advisory"
    : args.agent_context.authority;
  const recommendedPosture: AionisAgentContext["recommended_posture"] = args.agent_context.history_used
    ? "inspect_before_use"
    : args.agent_context.recommended_posture;
  const promptText = buildAgentContextPrompt({
    summary: args.agent_context.summary,
    historyUsed: args.agent_context.history_used,
    recommendedPosture,
    authority,
    negativeTransferRisk: risk.negative_transfer_risk,
    targetFiles: args.agent_context.target_files,
    useNow,
    inspectBeforeUse,
    doNotUse: args.agent_context.do_not_use,
    memoryIds: args.agent_context.memory_ids,
    rehydrateHints: args.agent_context.rehydrate_hints,
    contextCharBudget: args.context_char_budget,
    contextCompactionProfile: args.context_compaction_profile,
  });

  return parseAionisAgentContext({
    ...args.agent_context,
    prompt_text: promptText,
    recommended_posture: recommendedPosture,
    authority,
    use_now: useNow,
    inspect_before_use: inspectBeforeUse,
    use_now_memory_ids: useNowMemoryIds,
    inspect_before_use_memory_ids: inspectBeforeUseMemoryIds,
    risk,
  });
}

function traceTextMatchesEntry(values: string[], entry: MemoryPacketEntry): boolean {
  return values.some((value) => textMatchesMemoryEntry(value, entry));
}

function traceSurfaceForMemory(args: {
  entry: MemoryPacketEntry;
  guide: AionisGuidePacket | null;
  agentContext: AionisAgentContext | null;
}): AionisMemoryDecisionSurface {
  const guideBrief = args.guide?.guide_brief ?? null;
  if (args.agentContext?.do_not_use_memory_ids.includes(args.entry.memory_id)) return "do_not_use";
  const rehydrateIds = new Set([
    ...(args.agentContext?.rehydrate_hints ?? []).map((hint) => hint.memory_id),
    ...(guideBrief?.rehydrate ?? []).map((hint) => hint.memory_id),
  ]);
  if (rehydrateIds.has(args.entry.memory_id) || args.entry.lifecycle_state === "rehydration_candidate") {
    return "rehydrate";
  }
  if (args.agentContext?.inspect_before_use_memory_ids.includes(args.entry.memory_id)) return "inspect_before_use";
  if (args.agentContext?.use_now_memory_ids.includes(args.entry.memory_id)) return "use_now";
  if (
    traceTextMatchesEntry(args.agentContext?.do_not_use ?? [], args.entry)
    || traceTextMatchesEntry(guideBrief?.do_not_use ?? [], args.entry)
    || memoryEntryBlocked(args.entry)
  ) {
    return "do_not_use";
  }
  if (
    traceTextMatchesEntry(args.agentContext?.inspect_before_use ?? [], args.entry)
    || traceTextMatchesEntry(guideBrief?.inspect_before_use ?? [], args.entry)
    || memoryEntryInspectBeforeUse(args.entry)
  ) {
    return "inspect_before_use";
  }
  if (
    traceTextMatchesEntry(args.agentContext?.use_now ?? [], args.entry)
    || traceTextMatchesEntry(guideBrief?.use_now ?? [], args.entry)
    || memoryEntryUsable(args.entry)
  ) {
    return "use_now";
  }
  return "not_agent_facing";
}

function traceReasonCodes(args: {
  entry: MemoryPacketEntry;
  surface: AionisMemoryDecisionSurface;
  memory: AionisMemoryPacket | null;
  guide: AionisGuidePacket | null;
  agentContext: AionisAgentContext | null;
}): string[] {
  const hasRelationEvidence = args.memory?.evidence_trail.some((evidence) =>
    evidence.source === "edge" && evidence.memory_id === args.entry.memory_id
  ) === true;
  const hasWarning = args.memory?.contradiction_warnings.some((warning) =>
    warning.memory_id === args.entry.memory_id
  ) === true;
  return compactStrings([
    args.entry.lifecycle_state === "active" ? "lifecycle_active" : `lifecycle_${args.entry.lifecycle_state}`,
    args.entry.authority === "trusted" || args.entry.authority === "advisory" ? `authority_${args.entry.authority}` : null,
    args.entry.authority === "candidate" ? "candidate_authority" : null,
    args.entry.authority === "blocked" ? "blocked_authority" : null,
    hasRelationEvidence ? "lifecycle_relation_evidence" : null,
    hasWarning ? "contradiction_warning" : null,
    args.surface === "use_now" ? "available_for_agent_use" : null,
    args.surface === "inspect_before_use" ? "kept_out_of_direct_use" : null,
    args.surface === "do_not_use" ? "blocked_from_agent_use" : null,
    args.surface === "rehydrate" ? "requires_differential_rehydration" : null,
    args.agentContext ? "agent_context_projection_checked" : null,
    args.guide?.guide_brief.history_used ? "guide_history_used" : null,
  ]);
}

function isForgetAction(value: string | null): value is AionisMemoryDecisionTrace["forget_decisions"][number]["action"] {
  return value === "suppress" || value === "unsuppress" || value === "rehydrate" || value === "activate";
}

function isForgetTarget(value: string | null): value is NonNullable<AionisMemoryDecisionTrace["forget_decisions"][number]["target"]> {
  return value === "pattern" || value === "archive" || value === "payload" || value === "memory";
}

function traceForgetDecisions(forgetResult: unknown): AionisMemoryDecisionTrace["forget_decisions"] {
  const root = asRecord(forgetResult);
  const effect = asRecord(root?.forget_effect);
  const action = stringValue(effect?.action) ?? stringValue(root?.operation);
  if (!isForgetAction(action)) return [];
  const target = stringValue(effect?.target) ?? stringValue(root?.target);
  const affected = Array.isArray(effect?.affected_memory_ids)
    ? compactStrings(effect.affected_memory_ids.map((entry) => typeof entry === "string" ? entry : null))
    : [];
  return [{
    action,
    target: isForgetTarget(target) ? target : null,
    changed_count: Math.max(0, numberValue(effect?.changed_count) ?? 0),
    affected_memory_ids: affected,
    reason: stringValue(root?.reason) ?? stringValue(effect?.reason),
  }];
}

type TraceFeedbackActivationSummary = {
  memory_id: string;
  run_id: string | null;
  outcome: FeedbackAttributionDetail["outcome"];
  used_surface: FeedbackAttributionDetail["used_surface"];
  verifier_status: FeedbackAttributionDetail["verifier_status"];
  tool_status: FeedbackAttributionDetail["tool_status"];
  runtime_signal_refs: string[];
  attribution_strength: FeedbackAttributionDetail["attribution_strength"];
  weak_counter_signal_count: number;
  strong_counter_signal_count: number;
};

type TraceFeedbackAttributionInput = {
  present: boolean;
  guide_trace_id: string | null;
  run_id: string | null;
  outcome: FeedbackAttributionDetail["outcome"];
  used_surface: FeedbackAttributionDetail["used_surface"];
  verifier_status: FeedbackAttributionDetail["verifier_status"];
  tool_status: FeedbackAttributionDetail["tool_status"];
  runtime_signal_refs: string[];
  affected_memory_ids: string[];
  exposed_memory_count: number;
  attributed_memory_count: number;
  unattributed_recalled_memory_count: number;
  unattributed_recalled_memory_ids: string[];
  unattributed_use_now_memory_ids: string[];
  unattributed_inspect_before_use_memory_ids: string[];
  unattributed_do_not_use_memory_ids: string[];
  unattributed_rehydrate_memory_ids: string[];
  unused_exposure_observation: UnusedExposureObservationSummary;
  summaries: Map<string, TraceFeedbackActivationSummary>;
};

function feedbackOutcomeValue(value: unknown): FeedbackAttributionDetail["outcome"] {
  return value === "positive" || value === "negative" || value === "neutral" ? value : null;
}

function feedbackUsedSurfaceValue(value: unknown): FeedbackAttributionDetail["used_surface"] {
  return value === "use_now"
    || value === "inspect_before_use"
    || value === "do_not_use"
    || value === "explicit_host_assertion"
    ? value
    : null;
}

function feedbackVerifierStatusValue(value: unknown): FeedbackAttributionDetail["verifier_status"] {
  return value === "passed" || value === "failed" || value === "not_run" || value === "unknown" ? value : null;
}

function feedbackToolStatusValue(value: unknown): FeedbackAttributionDetail["tool_status"] {
  return value === "succeeded" || value === "failed" || value === "not_run" || value === "unknown" ? value : null;
}

function feedbackAttributionStrengthValue(value: unknown): FeedbackAttributionDetail["attribution_strength"] {
  return value === "observed_feedback"
    || value === "positive_attribution"
    || value === "weak_counter_signal"
    || value === "strong_counter_signal"
    ? value
    : null;
}

function emptyUnusedExposureObservation(reason = "No guide exposure observation was supplied for this trace."): UnusedExposureObservationSummary {
  return {
    present: false,
    contract_version: null,
    mode: null,
    exposure_threshold: 0,
    guide_trace_count: 0,
    tracked_memory_count: 0,
    repeated_unattributed_memory_ids: [],
    repeated_unattributed_without_positive_memory_ids: [],
    memory_stats: [],
    reason,
  };
}

function emptySparseFeedbackSignalSummary(
  reason = "No activate feedback or unused exposure signal was supplied for this trace.",
): SparseFeedbackSignalSummary {
  return {
    present: false,
    mode: null,
    authority_mutation: false,
    positive_attributed_memory_ids: [],
    weak_counter_signal_memory_ids: [],
    strong_counter_signal_memory_ids: [],
    relation_counter_signal_memory_ids: [],
    contradiction_warning_memory_ids: [],
    repeated_unattributed_memory_ids: [],
    repeated_unattributed_without_positive_memory_ids: [],
    read_only_signal_memory_ids: [],
    candidate_learning_control_summary: emptyCandidateLearningControlSummary(),
    reason,
  };
}

function emptyCandidateLearningControlSummary(
  reason = "No sparse feedback signal crossed the candidate learning-control gate.",
): CandidateLearningControlSummary {
  return {
    present: false,
    contract_version: null,
    mode: null,
    authority_mutation: false,
    candidate_inspect_before_use_memory_ids: [],
    candidate_from_threshold_met_memory_ids: [],
    candidate_from_repeated_unused_without_positive_memory_ids: [],
    blocked_by_positive_attribution_memory_ids: [],
    reason,
  };
}

function buildCandidateLearningControlSummary(args: {
  thresholdMetMemoryIds: string[];
  unusedExposureObservation: UnusedExposureObservationSummary;
}): CandidateLearningControlSummary {
  const positiveAttributedUseMemoryIds = new Set(
    args.unusedExposureObservation.memory_stats
      .filter((entry) => entry.positive_attributed_use_count > 0)
      .map((entry) => entry.memory_id),
  );
  const repeatedWithoutPositive = args.unusedExposureObservation.repeated_unattributed_without_positive_memory_ids
    .filter((memoryId) => !positiveAttributedUseMemoryIds.has(memoryId));
  const blockedByPositiveAttribution = args.unusedExposureObservation.repeated_unattributed_memory_ids
    .filter((memoryId) => positiveAttributedUseMemoryIds.has(memoryId));
  const candidateFromThresholdMet = compactStrings(args.thresholdMetMemoryIds);
  const candidateFromUnusedExposure = compactStrings(repeatedWithoutPositive);
  const candidateInspect = compactStrings([
    ...candidateFromThresholdMet,
    ...candidateFromUnusedExposure,
  ]);
  const blockedByPositive = compactStrings(blockedByPositiveAttribution);

  if (candidateInspect.length === 0 && blockedByPositive.length === 0) {
    return emptyCandidateLearningControlSummary();
  }

  return {
    present: true,
    contract_version: "aionis_candidate_learning_control_summary_v1",
    mode: "candidate_only",
    authority_mutation: false,
    candidate_inspect_before_use_memory_ids: candidateInspect,
    candidate_from_threshold_met_memory_ids: candidateFromThresholdMet,
    candidate_from_repeated_unused_without_positive_memory_ids: candidateFromUnusedExposure,
    blocked_by_positive_attribution_memory_ids: blockedByPositive,
    reason: candidateInspect.length > 0
      ? "Threshold-met feedback and repeated unused exposure without positive attribution are candidate-only inspect-before-use signals; this summary does not mutate authority."
      : "Repeated unused exposure was observed, but positive attributed use blocks candidate learning-control.",
  };
}

function emptyConfidenceDecayCandidateSummary(
  reason = "No confidence decay shadow candidate crossed the read-only gate.",
): ConfidenceDecayCandidateSummary {
  return {
    present: false,
    contract_version: null,
    mode: null,
    authority_mutation: false,
    agent_prompt_included: false,
    time_decay_age_threshold_days: AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS,
    decay_candidate_memory_ids: [],
    candidate_from_learning_control_memory_ids: [],
    candidate_from_time_decay_memory_ids: [],
    supported_by_neighborhood_drift_memory_ids: [],
    drift_only_observation_memory_ids: [],
    blocked_by_positive_attribution_memory_ids: [],
    blocked_by_recent_validation_memory_ids: [],
    time_decay_candidate_details: [],
    reason,
  };
}

function buildConfidenceDecayCandidateSummary(args: {
  feedbackAttribution: FeedbackAttributionSummary;
  memory: AionisMemoryPacket | null;
  memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"];
  neighborhoodDriftObservation: NeighborhoodDriftObservation;
}): ConfidenceDecayCandidateSummary {
  const sparse = args.feedbackAttribution.sparse_feedback_signal_summary;
  const learningControl = sparse.candidate_learning_control_summary;
  const positiveMemoryIds = new Set(compactStrings(sparse.positive_attributed_memory_ids));
  const learningControlCandidates = compactStrings(learningControl.candidate_inspect_before_use_memory_ids);
  const memoryEntriesById = new Map((args.memory?.relevant_memories ?? []).map((entry) => [entry.memory_id, entry]));
  const decisionsById = new Map(args.memoryDecisions.map((entry) => [entry.memory_id, entry]));
  const observedTimes = (args.memory?.relevant_memories ?? [])
    .map((entry) => parseObservedTime(entry.observed_at))
    .filter((value): value is number => value !== null);
  const referenceObservedTime = observedTimes.length > 0 ? Math.max(...observedTimes) : null;
  const referenceObservedAt = referenceObservedTime === null ? null : new Date(referenceObservedTime).toISOString();
  const timeDecayDetails: ConfidenceDecayCandidateSummary["time_decay_candidate_details"] = [];
  const timeDecayBlockedByPositive: string[] = [];

  if (referenceObservedTime !== null && referenceObservedAt !== null) {
    for (const [memoryId, decision] of decisionsById) {
      if (decision.agent_surface !== "use_now" && decision.agent_surface !== "inspect_before_use") continue;
      if (decision.authority !== "trusted" && decision.authority !== "advisory") continue;
      if (decision.lifecycle_state !== "active") continue;
      const entry = memoryEntriesById.get(memoryId);
      const observedTime = parseObservedTime(entry?.observed_at);
      if (observedTime === null || observedTime >= referenceObservedTime) continue;
      const ageDays = Math.floor((referenceObservedTime - observedTime) / DAY_MS);
      if (ageDays < AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS) continue;
      const blockedByPositiveAttribution = positiveMemoryIds.has(memoryId) || hasPositiveAttribution(decision);
      if (blockedByPositiveAttribution) {
        timeDecayBlockedByPositive.push(memoryId);
      }
      timeDecayDetails.push({
        memory_id: memoryId,
        observed_at: new Date(observedTime).toISOString(),
        reference_observed_at: referenceObservedAt,
        age_days: ageDays,
        threshold_days: AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS,
        agent_surface: decision.agent_surface,
        authority: decision.authority,
        blocked_by_positive_attribution: blockedByPositiveAttribution,
        reason: blockedByPositiveAttribution
          ? "Temporal staleness was observed, but positive attribution in the current feedback window blocks confidence-decay candidacy."
          : "Memory is substantially older than the freshest scoped evidence while still exposed to the agent; this is a read-only confidence-decay candidate and does not mutate authority.",
      });
    }
  }

  const candidateFromLearningControl = learningControlCandidates.filter((memoryId) => !positiveMemoryIds.has(memoryId));
  const candidateFromTimeDecay = compactStrings(
    timeDecayDetails
      .filter((entry) => !entry.blocked_by_positive_attribution)
      .map((entry) => entry.memory_id),
  );
  const blockedByPositive = compactStrings([
    ...learningControl.blocked_by_positive_attribution_memory_ids,
    ...learningControlCandidates.filter((memoryId) => positiveMemoryIds.has(memoryId)),
    ...timeDecayBlockedByPositive,
  ]);
  const driftSignalMemoryIds = new Set(args.neighborhoodDriftObservation.signal_memory_ids);
  const candidateMemoryIds = compactStrings([
    ...candidateFromLearningControl,
    ...candidateFromTimeDecay,
  ]);
  const supportedByDrift = candidateMemoryIds.filter((memoryId) => driftSignalMemoryIds.has(memoryId));
  const driftOnlyObservation = args.neighborhoodDriftObservation.signal_memory_ids
    .filter((memoryId) => !candidateMemoryIds.includes(memoryId) && !blockedByPositive.includes(memoryId));
  const decayCandidates = compactStrings(candidateMemoryIds);

  if (
    decayCandidates.length === 0
    && blockedByPositive.length === 0
    && driftOnlyObservation.length === 0
    && timeDecayDetails.length === 0
  ) {
    return emptyConfidenceDecayCandidateSummary();
  }

  return {
    present: true,
    contract_version: "aionis_confidence_decay_candidate_summary_v1",
    mode: "shadow_candidate",
    authority_mutation: false,
    agent_prompt_included: false,
    time_decay_age_threshold_days: AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS,
    decay_candidate_memory_ids: decayCandidates,
    candidate_from_learning_control_memory_ids: candidateFromLearningControl,
    candidate_from_time_decay_memory_ids: candidateFromTimeDecay,
    supported_by_neighborhood_drift_memory_ids: supportedByDrift,
    drift_only_observation_memory_ids: compactStrings(driftOnlyObservation),
    blocked_by_positive_attribution_memory_ids: blockedByPositive,
    blocked_by_recent_validation_memory_ids: blockedByPositive,
    time_decay_candidate_details: timeDecayDetails.slice(0, 24),
    reason: decayCandidates.length > 0
      ? "Direction 1 candidate evidence or temporal staleness may become a confidence-decay shadow candidate, but this summary does not mutate authority."
      : "Positive attribution, recent validation, or drift-only evidence blocked confidence-decay candidacy.",
  };
}

function emptyInspectBeforeUseShadowDelta(
  reason = "Inspect-before-use shadow delta is disabled and no confidence-decay candidates were supplied.",
): InspectBeforeUseShadowDelta {
  return {
    present: false,
    contract_version: null,
    mode: null,
    enabled: false,
    authority_mutation: false,
    agent_prompt_included: false,
    simulated_surface: "inspect_before_use",
    candidate_memory_ids: [],
    would_move_to_inspect_before_use_memory_ids: [],
    already_inspect_before_use_memory_ids: [],
    blocked_by_positive_attribution_memory_ids: [],
    blocked_by_recent_validation_memory_ids: [],
    drift_only_observation_memory_ids: [],
    entries: [],
    reason,
  };
}

function buildInspectBeforeUseShadowDelta(args: {
  confidenceDecayCandidateSummary: ConfidenceDecayCandidateSummary;
  memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"];
}): InspectBeforeUseShadowDelta {
  const summary = args.confidenceDecayCandidateSummary;
  const candidateMemoryIds = compactStrings(summary.decay_candidate_memory_ids);
  const blockedByPositive = compactStrings(summary.blocked_by_positive_attribution_memory_ids);
  const blockedByRecentValidation = compactStrings(summary.blocked_by_recent_validation_memory_ids);
  const driftOnlyObservation = compactStrings(summary.drift_only_observation_memory_ids);
  if (
    candidateMemoryIds.length === 0
    && blockedByPositive.length === 0
    && blockedByRecentValidation.length === 0
    && driftOnlyObservation.length === 0
  ) {
    return emptyInspectBeforeUseShadowDelta();
  }

  const learningControlIds = new Set(summary.candidate_from_learning_control_memory_ids);
  const timeDecayIds = new Set(summary.candidate_from_time_decay_memory_ids);
  const decisionById = new Map(args.memoryDecisions.map((entry) => [entry.memory_id, entry]));
  const entries: InspectBeforeUseShadowDelta["entries"] = [];
  const wouldMove: string[] = [];
  const alreadyInspect: string[] = [];

  for (const memoryId of candidateMemoryIds) {
    const decision = decisionById.get(memoryId);
    if (!decision) continue;
    const sources = compactStrings([
      learningControlIds.has(memoryId) ? "learning_control" : null,
      timeDecayIds.has(memoryId) ? "time_decay" : null,
    ]) as InspectBeforeUseShadowDelta["entries"][number]["sources"];
    const wouldChangeSurface = decision.agent_surface !== "inspect_before_use";
    if (wouldChangeSurface) {
      wouldMove.push(memoryId);
    } else {
      alreadyInspect.push(memoryId);
    }
    entries.push({
      memory_id: memoryId,
      title: decision.title,
      current_surface: decision.agent_surface,
      proposed_surface: "inspect_before_use",
      would_change_surface: wouldChangeSurface,
      authority: decision.authority,
      lifecycle_state: decision.lifecycle_state,
      sources,
      reason: wouldChangeSurface
        ? "If the disabled product flag were enabled, this confidence-decay candidate would move from direct reuse to inspect-before-use."
        : "This confidence-decay candidate is already inspect-before-use under existing runtime evidence; the disabled preview would not change its surface.",
    });
  }

  return {
    present: true,
    contract_version: "aionis_inspect_before_use_shadow_delta_v1",
    mode: "disabled_preview",
    enabled: false,
    authority_mutation: false,
    agent_prompt_included: false,
    simulated_surface: "inspect_before_use",
    candidate_memory_ids: candidateMemoryIds,
    would_move_to_inspect_before_use_memory_ids: compactStrings(wouldMove),
    already_inspect_before_use_memory_ids: compactStrings(alreadyInspect),
    blocked_by_positive_attribution_memory_ids: blockedByPositive,
    blocked_by_recent_validation_memory_ids: blockedByRecentValidation,
    drift_only_observation_memory_ids: driftOnlyObservation,
    entries: entries.slice(0, 48),
    reason: candidateMemoryIds.length > 0
      ? "Disabled preview only: candidate memories are reported as an inspect-before-use delta without mutating authority or entering the Agent prompt."
      : "Disabled preview only: no memories would move; existing positive, recent-validation, or drift-only boundaries blocked the delta.",
  };
}

function unusedExposureObservationValue(value: unknown): UnusedExposureObservationSummary {
  const record = asRecord(value);
  if (!record || record.contract_version !== "aionis_unused_exposure_observation_v1") {
    return emptyUnusedExposureObservation();
  }
  const memoryStats = Array.isArray(record.memory_stats)
    ? record.memory_stats
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => !!entry)
      .map((entry) => ({
        memory_id: stringValue(entry.memory_id) ?? "unknown",
        current_unattributed: entry.current_unattributed === true,
        exposure_count: nonNegativeIntegerValue(entry.exposure_count),
        use_now_exposure_count: nonNegativeIntegerValue(entry.use_now_exposure_count),
        inspect_before_use_exposure_count: nonNegativeIntegerValue(entry.inspect_before_use_exposure_count),
        do_not_use_exposure_count: nonNegativeIntegerValue(entry.do_not_use_exposure_count),
        rehydrate_exposure_count: nonNegativeIntegerValue(entry.rehydrate_exposure_count),
        positive_attributed_use_count: nonNegativeIntegerValue(entry.positive_attributed_use_count),
        feedback_positive_count: nonNegativeIntegerValue(entry.feedback_positive_count),
        feedback_negative_count: nonNegativeIntegerValue(entry.feedback_negative_count),
        repeated_without_positive_attribution: entry.repeated_without_positive_attribution === true,
      }))
      .filter((entry) => entry.memory_id !== "unknown")
    : [];
  return {
    present: true,
    contract_version: "aionis_unused_exposure_observation_v1",
    mode: "read_only_measure",
    exposure_threshold: nonNegativeIntegerValue(record.exposure_threshold),
    guide_trace_count: nonNegativeIntegerValue(record.guide_trace_count),
    tracked_memory_count: nonNegativeIntegerValue(record.tracked_memory_count),
    repeated_unattributed_memory_ids: stringArrayValue(record.repeated_unattributed_memory_ids),
    repeated_unattributed_without_positive_memory_ids: stringArrayValue(record.repeated_unattributed_without_positive_memory_ids),
    memory_stats: memoryStats,
    reason: stringValue(record.reason) ?? "Repeated unused exposure is reported as read-only evidence.",
  };
}

function buildSparseFeedbackSignalSummary(args: {
  present: boolean;
  positiveAttributedMemoryIds: string[];
  weakCounterSignalMemoryIds: string[];
  strongCounterSignalMemoryIds: string[];
  thresholdMetMemoryIds: string[];
  relationCounterSignalMemoryIds: string[];
  contradictionWarningMemoryIds: string[];
  unusedExposureObservation: UnusedExposureObservationSummary;
}): SparseFeedbackSignalSummary {
  const repeatedUnattributed = args.unusedExposureObservation.repeated_unattributed_memory_ids;
  const repeatedWithoutPositive = args.unusedExposureObservation.repeated_unattributed_without_positive_memory_ids;
  const readOnlySignalMemoryIds = compactStrings([
    ...args.positiveAttributedMemoryIds,
    ...args.weakCounterSignalMemoryIds,
    ...args.strongCounterSignalMemoryIds,
    ...args.relationCounterSignalMemoryIds,
    ...args.contradictionWarningMemoryIds,
    ...repeatedUnattributed,
    ...repeatedWithoutPositive,
  ]);
  const candidateLearningControlSummary = buildCandidateLearningControlSummary({
    thresholdMetMemoryIds: args.thresholdMetMemoryIds,
    unusedExposureObservation: args.unusedExposureObservation,
  });
  if (readOnlySignalMemoryIds.length === 0) {
    return emptySparseFeedbackSignalSummary();
  }
  return {
    present: true,
    mode: "read_only_measure",
    authority_mutation: false,
    positive_attributed_memory_ids: args.positiveAttributedMemoryIds,
    weak_counter_signal_memory_ids: args.weakCounterSignalMemoryIds,
    strong_counter_signal_memory_ids: args.strongCounterSignalMemoryIds,
    relation_counter_signal_memory_ids: args.relationCounterSignalMemoryIds,
    contradiction_warning_memory_ids: args.contradictionWarningMemoryIds,
    repeated_unattributed_memory_ids: repeatedUnattributed,
    repeated_unattributed_without_positive_memory_ids: repeatedWithoutPositive,
    read_only_signal_memory_ids: readOnlySignalMemoryIds,
    candidate_learning_control_summary: candidateLearningControlSummary,
    reason: "Sparse feedback, repeated exposure, and relation-derived counter signals are summarized for measure/debug/audit only; this summary does not lower authority or suppress memory.",
  };
}

function traceFeedbackAttributionInput(forgetResult: unknown): TraceFeedbackAttributionInput {
  const root = asRecord(forgetResult);
  const effect = asRecord(root?.forget_effect);
  const action = stringValue(effect?.action) ?? stringValue(root?.operation);
  const affectedMemoryIds = Array.isArray(effect?.affected_memory_ids)
    ? compactStrings(effect.affected_memory_ids.map((entry) => typeof entry === "string" ? entry : null))
    : [];
  if (action !== "activate") {
    return {
      present: false,
      guide_trace_id: null,
      run_id: null,
      outcome: null,
      used_surface: null,
      verifier_status: null,
      tool_status: null,
      runtime_signal_refs: [],
      affected_memory_ids: [],
      exposed_memory_count: 0,
      attributed_memory_count: 0,
      unattributed_recalled_memory_count: 0,
      unattributed_recalled_memory_ids: [],
      unattributed_use_now_memory_ids: [],
      unattributed_inspect_before_use_memory_ids: [],
      unattributed_do_not_use_memory_ids: [],
      unattributed_rehydrate_memory_ids: [],
      unused_exposure_observation: emptyUnusedExposureObservation(),
      summaries: new Map(),
    };
  }

  const attribution = asRecord(effect?.attribution);
  const guideTrace = asRecord(effect?.guide_trace);
  const result = asRecord(root?.result);
  const activated = asRecord(result?.activated);
  const rawSummaries = Array.isArray(activated?.feedback_attributions) ? activated.feedback_attributions : [];
  const fallback = {
    run_id: stringValue(attribution?.run_id),
    outcome: feedbackOutcomeValue(attribution?.outcome),
    used_surface: feedbackUsedSurfaceValue(attribution?.used_surface),
    verifier_status: feedbackVerifierStatusValue(attribution?.verifier_status),
    tool_status: feedbackToolStatusValue(attribution?.tool_status),
    runtime_signal_refs: stringArrayValue(attribution?.runtime_signal_refs),
  };
  const summaries = new Map<string, TraceFeedbackActivationSummary>();
  for (const item of rawSummaries) {
    const record = asRecord(item);
    const memoryId = stringValue(record?.memory_id);
    if (!memoryId) continue;
    summaries.set(memoryId, {
      memory_id: memoryId,
      run_id: stringValue(record?.run_id) ?? fallback.run_id,
      outcome: feedbackOutcomeValue(record?.outcome) ?? fallback.outcome,
      used_surface: feedbackUsedSurfaceValue(record?.used_surface) ?? fallback.used_surface,
      verifier_status: feedbackVerifierStatusValue(record?.verifier_status) ?? fallback.verifier_status,
      tool_status: feedbackToolStatusValue(record?.tool_status) ?? fallback.tool_status,
      runtime_signal_refs: stringArrayValue(record?.runtime_signal_refs).length > 0
        ? stringArrayValue(record?.runtime_signal_refs)
        : fallback.runtime_signal_refs,
      attribution_strength: feedbackAttributionStrengthValue(record?.attribution_strength),
      weak_counter_signal_count: nonNegativeIntegerValue(record?.weak_counter_signal_count),
      strong_counter_signal_count: nonNegativeIntegerValue(record?.strong_counter_signal_count),
    });
  }
  for (const memoryId of affectedMemoryIds) {
    if (summaries.has(memoryId)) continue;
    summaries.set(memoryId, {
      memory_id: memoryId,
      ...fallback,
      attribution_strength: null,
      weak_counter_signal_count: 0,
      strong_counter_signal_count: 0,
    });
  }

  return {
    present: true,
    guide_trace_id: stringValue(guideTrace?.guide_trace_id),
    ...fallback,
    affected_memory_ids: affectedMemoryIds,
    exposed_memory_count: nonNegativeIntegerValue(guideTrace?.exposed_memory_count),
    attributed_memory_count: nonNegativeIntegerValue(guideTrace?.attributed_memory_count),
    unattributed_recalled_memory_count: nonNegativeIntegerValue(guideTrace?.unattributed_recalled_memory_count),
    unattributed_recalled_memory_ids: stringArrayValue(guideTrace?.unattributed_recalled_memory_ids),
    unattributed_use_now_memory_ids: stringArrayValue(guideTrace?.unattributed_use_now_memory_ids),
    unattributed_inspect_before_use_memory_ids: stringArrayValue(guideTrace?.unattributed_inspect_before_use_memory_ids),
    unattributed_do_not_use_memory_ids: stringArrayValue(guideTrace?.unattributed_do_not_use_memory_ids),
    unattributed_rehydrate_memory_ids: stringArrayValue(guideTrace?.unattributed_rehydrate_memory_ids),
    unused_exposure_observation: unusedExposureObservationValue(guideTrace?.unused_exposure_observation),
    summaries,
  };
}

function feedbackThresholdState(summary: TraceFeedbackActivationSummary): FeedbackAttributionDetail["threshold_state"] {
  if (summary.outcome === "positive") return "positive_attribution";
  if (summary.attribution_strength === "strong_counter_signal" || summary.strong_counter_signal_count > 0) {
    return "strong_signal_threshold_met";
  }
  if (summary.attribution_strength === "weak_counter_signal" || summary.weak_counter_signal_count > 0) {
    return summary.weak_counter_signal_count >= 2 ? "repeated_weak_threshold_met" : "weak_below_threshold";
  }
  if (summary.attribution_strength === "observed_feedback") return "observed_feedback_only";
  return "none";
}

function feedbackTraceReason(args: {
  summary: TraceFeedbackActivationSummary;
  thresholdState: FeedbackAttributionDetail["threshold_state"];
}): string {
  if (args.thresholdState === "strong_signal_threshold_met") {
    return "Negative feedback is aligned with verifier, tool, or runtime failure evidence, so the memory is kept out of direct use.";
  }
  if (args.thresholdState === "repeated_weak_threshold_met") {
    return "Repeated weak negative feedback reached the attribution threshold, so the memory is kept out of direct use.";
  }
  if (args.thresholdState === "weak_below_threshold") {
    return "A single weak negative feedback signal was recorded; authority remains direct-use until repeated or aligned evidence appears.";
  }
  if (args.thresholdState === "positive_attribution") {
    return "Positive host attribution supports continued direct use for this memory.";
  }
  return args.summary.used_surface
    ? "Host feedback was recorded, but it does not meet a counter-signal threshold."
    : "Feedback result did not include a direct host-used attribution surface.";
}

function traceFeedbackDetail(args: {
  entry: MemoryPacketEntry;
  feedbackInput: TraceFeedbackAttributionInput;
}): FeedbackAttributionDetail | null {
  const summary = args.feedbackInput.summaries.get(args.entry.memory_id);
  if (!summary) return null;
  const thresholdState = feedbackThresholdState(summary);
  const thresholdMet = thresholdState === "repeated_weak_threshold_met" || thresholdState === "strong_signal_threshold_met";
  const hostMarkedUsed = summary.used_surface === "use_now" || summary.used_surface === "explicit_host_assertion";
  return {
    run_id: summary.run_id,
    outcome: summary.outcome,
    used_surface: summary.used_surface,
    verifier_status: summary.verifier_status,
    tool_status: summary.tool_status,
    runtime_signal_refs: summary.runtime_signal_refs,
    attribution_strength: summary.attribution_strength,
    weak_counter_signal_count: summary.weak_counter_signal_count,
    strong_counter_signal_count: summary.strong_counter_signal_count,
    threshold_state: thresholdState,
    threshold_met: thresholdMet,
    host_marked_used: hostMarkedUsed,
    reason: feedbackTraceReason({ summary, thresholdState }),
  };
}

function buildTraceFeedbackAttribution(args: {
  feedbackInput: TraceFeedbackAttributionInput;
  memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"];
  agentContext: AionisAgentContext | null;
}): FeedbackAttributionSummary {
  const relationCounterSignalMemoryIds = args.memoryDecisions
    .filter((entry) => !!entry.downgraded_detail?.relation)
    .map((entry) => entry.memory_id);
  const contradictionWarningMemoryIds = args.memoryDecisions
    .filter((entry) => entry.reason_codes.includes("contradiction_warning"))
    .map((entry) => entry.memory_id);
  if (!args.feedbackInput.present) {
    const sparseFeedbackSignalSummary = buildSparseFeedbackSignalSummary({
      present: false,
      positiveAttributedMemoryIds: [],
      weakCounterSignalMemoryIds: [],
      strongCounterSignalMemoryIds: [],
      thresholdMetMemoryIds: [],
      relationCounterSignalMemoryIds,
      contradictionWarningMemoryIds,
      unusedExposureObservation: emptyUnusedExposureObservation(),
    });
    return {
      present: false,
      guide_trace_id: null,
      run_id: null,
      outcome: null,
      used_surface: null,
      verifier_status: null,
      tool_status: null,
      runtime_signal_refs: [],
      affected_memory_ids: [],
      exposed_memory_count: 0,
      attributed_memory_count: 0,
      unattributed_recalled_memory_count: args.agentContext?.memory_ids.length ?? 0,
      attributed_memory_ids: [],
      unattributed_recalled_memory_ids: args.agentContext?.memory_ids ?? [],
      unattributed_use_now_memory_ids: [],
      unattributed_inspect_before_use_memory_ids: [],
      unattributed_do_not_use_memory_ids: [],
      unattributed_rehydrate_memory_ids: [],
      unused_exposure_observation: emptyUnusedExposureObservation(),
      sparse_feedback_signal_summary: sparseFeedbackSignalSummary,
      weak_counter_signal_memory_ids: [],
      strong_counter_signal_memory_ids: [],
      threshold_met_memory_ids: [],
      reason: "No activate feedback attribution was supplied for this trace.",
    };
  }
  const details = args.memoryDecisions
    .map((entry) => ({ memory_id: entry.memory_id, detail: entry.feedback_detail }))
    .filter((entry): entry is { memory_id: string; detail: FeedbackAttributionDetail } => !!entry.detail);
  const affected = new Set(args.feedbackInput.affected_memory_ids);
  const recalled = args.agentContext?.memory_ids ?? args.memoryDecisions.map((entry) => entry.memory_id);
  const attributedMemoryIds = details
    .filter((entry) => entry.detail.host_marked_used)
    .map((entry) => entry.memory_id);
  const positiveAttributedMemoryIds = details
    .filter((entry) => entry.detail.attribution_strength === "positive_attribution")
    .map((entry) => entry.memory_id);
  const unattributedRecalledMemoryIds = args.feedbackInput.unattributed_recalled_memory_ids.length > 0
    ? args.feedbackInput.unattributed_recalled_memory_ids
    : recalled.filter((memoryId) => !affected.has(memoryId));
  const hasGuideTrace = !!args.feedbackInput.guide_trace_id;
  const weakCounterSignalMemoryIds = details
    .filter((entry) => entry.detail.attribution_strength === "weak_counter_signal")
    .map((entry) => entry.memory_id);
  const strongCounterSignalMemoryIds = details
    .filter((entry) => entry.detail.attribution_strength === "strong_counter_signal")
    .map((entry) => entry.memory_id);
  const thresholdMetMemoryIds = details
    .filter((entry) => entry.detail.threshold_met)
    .map((entry) => entry.memory_id);
  const sparseFeedbackSignalSummary = buildSparseFeedbackSignalSummary({
    present: args.feedbackInput.present,
    positiveAttributedMemoryIds,
    weakCounterSignalMemoryIds,
    strongCounterSignalMemoryIds,
    thresholdMetMemoryIds,
    relationCounterSignalMemoryIds,
    contradictionWarningMemoryIds,
    unusedExposureObservation: args.feedbackInput.unused_exposure_observation,
  });
  return {
    present: true,
    guide_trace_id: args.feedbackInput.guide_trace_id,
    run_id: args.feedbackInput.run_id,
    outcome: args.feedbackInput.outcome,
    used_surface: args.feedbackInput.used_surface,
    verifier_status: args.feedbackInput.verifier_status,
    tool_status: args.feedbackInput.tool_status,
    runtime_signal_refs: args.feedbackInput.runtime_signal_refs,
    affected_memory_ids: args.feedbackInput.affected_memory_ids,
    exposed_memory_count: hasGuideTrace ? args.feedbackInput.exposed_memory_count : 0,
    attributed_memory_count: hasGuideTrace ? args.feedbackInput.attributed_memory_count : attributedMemoryIds.length,
    unattributed_recalled_memory_count: hasGuideTrace
      ? args.feedbackInput.unattributed_recalled_memory_count
      : unattributedRecalledMemoryIds.length,
    attributed_memory_ids: attributedMemoryIds,
    unattributed_recalled_memory_ids: unattributedRecalledMemoryIds,
    unattributed_use_now_memory_ids: args.feedbackInput.unattributed_use_now_memory_ids,
    unattributed_inspect_before_use_memory_ids: args.feedbackInput.unattributed_inspect_before_use_memory_ids,
    unattributed_do_not_use_memory_ids: args.feedbackInput.unattributed_do_not_use_memory_ids,
    unattributed_rehydrate_memory_ids: args.feedbackInput.unattributed_rehydrate_memory_ids,
    unused_exposure_observation: args.feedbackInput.unused_exposure_observation,
    sparse_feedback_signal_summary: sparseFeedbackSignalSummary,
    weak_counter_signal_memory_ids: weakCounterSignalMemoryIds,
    strong_counter_signal_memory_ids: strongCounterSignalMemoryIds,
    threshold_met_memory_ids: thresholdMetMemoryIds,
    reason: "Activate feedback is attributed only to host-reported used memory ids; recalled but unreported memories remain unattributed.",
  };
}

function emptyNeighborhoodDriftObservation(
  reason = "No neighborhood drift signal was observed for this trace.",
): NeighborhoodDriftObservation {
  return {
    present: false,
    contract_version: null,
    mode: null,
    authority_mutation: false,
    growth_threshold: NEIGHBORHOOD_DRIFT_GROWTH_THRESHOLD,
    directional_drift_threshold: NEIGHBORHOOD_DRIFT_DIRECTIONAL_THRESHOLD,
    isolation_threshold: NEIGHBORHOOD_DRIFT_ISOLATION_THRESHOLD,
    signal_memory_ids: [],
    candidate_count: 0,
    candidates: [],
    reason,
  };
}

function parseObservedTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedDriftTokens(entry: MemoryPacketEntry): Set<string> {
  const text = compactStrings([entry.title, entry.summary]).join(" ").toLowerCase();
  const tokens = text
    .replace(/[/_.:-]+/g, " ")
    .match(/[a-z0-9]{4,}/g) ?? [];
  const out = new Set<string>();
  for (const token of tokens) {
    if (NEIGHBORHOOD_DRIFT_STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function memoryTargetFiles(entry: MemoryPacketEntry): string[] {
  return compactStrings([
    ...(entry.target_files ?? []),
    ...extractPathTargets(`${entry.title ?? ""}\n${entry.summary}`),
  ]).slice(0, 16);
}

function sharedPathCount(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  let count = 0;
  for (const value of right) {
    if (leftSet.has(value)) count += 1;
  }
  return count;
}

function hasPositiveAttribution(
  decision: AionisMemoryDecisionTrace["memory_decisions"][number] | undefined,
): boolean {
  return decision?.feedback_detail?.attribution_strength === "positive_attribution";
}

function buildNeighborhoodDriftObservation(args: {
  memory: AionisMemoryPacket | null;
  memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"];
}): NeighborhoodDriftObservation {
  const entries = (args.memory?.relevant_memories ?? []).slice(0, 96);
  if (entries.length < 3) {
    return emptyNeighborhoodDriftObservation("Neighborhood drift observation needs at least one older memory and two newer related memories.");
  }
  const decisionsById = new Map(args.memoryDecisions.map((entry) => [entry.memory_id, entry]));
  const metadata = entries.map((entry) => ({
    entry,
    observedTime: parseObservedTime(entry.observed_at),
    targetFiles: memoryTargetFiles(entry),
    tokens: normalizedDriftTokens(entry),
  }));
  const candidates: NeighborhoodDriftCandidate[] = [];

  for (const target of metadata) {
    if (target.observedTime === null) continue;
    const related: string[] = [];
    const directionalDrift: string[] = [];
    const sameDirection: string[] = [];

    for (const source of metadata) {
      if (source.entry.memory_id === target.entry.memory_id) continue;
      if (source.observedTime === null || source.observedTime <= target.observedTime) continue;
      const sharedPaths = sharedPathCount(target.targetFiles, source.targetFiles);
      const topicOverlap = intersectionSize(target.tokens, source.tokens);
      const isRelated = (sharedPaths > 0 && topicOverlap >= 2) || topicOverlap >= 5;
      if (!isRelated) continue;
      related.push(source.entry.memory_id);
      if (topicOverlap >= 6) {
        sameDirection.push(source.entry.memory_id);
      } else if (sharedPaths > 0 && topicOverlap >= 2) {
        directionalDrift.push(source.entry.memory_id);
      }
    }

    const isolationScore = hasPositiveAttribution(decisionsById.get(target.entry.memory_id)) ? 0 : 1;
    const signalPresent =
      related.length >= NEIGHBORHOOD_DRIFT_GROWTH_THRESHOLD
      && directionalDrift.length >= NEIGHBORHOOD_DRIFT_DIRECTIONAL_THRESHOLD
      && isolationScore >= NEIGHBORHOOD_DRIFT_ISOLATION_THRESHOLD;

    if (!signalPresent) continue;
    candidates.push({
      memory_id: target.entry.memory_id,
      title: target.entry.title,
      signal_present: true,
      neighborhood_growth_count: related.length,
      newer_related_memory_count: related.length,
      directional_drift_count: directionalDrift.length,
      same_direction_growth_count: sameDirection.length,
      isolation_score: isolationScore,
      related_memory_ids: related.slice(0, 12),
      directional_drift_memory_ids: directionalDrift.slice(0, 12),
      same_direction_memory_ids: sameDirection.slice(0, 12),
      reason: "Older memory has multiple newer related memories on the same target surface with directional drift and no positive attribution in this trace; this is read-only evidence for audit/measure, not authority mutation.",
    });
  }

  if (candidates.length === 0) {
    return emptyNeighborhoodDriftObservation("No isolated memory met the conservative growth, directional-drift, and isolation thresholds.");
  }
  const signalMemoryIds = candidates.map((entry) => entry.memory_id);
  return {
    present: true,
    contract_version: "aionis_neighborhood_drift_observation_v1",
    mode: "read_only_measure",
    authority_mutation: false,
    growth_threshold: NEIGHBORHOOD_DRIFT_GROWTH_THRESHOLD,
    directional_drift_threshold: NEIGHBORHOOD_DRIFT_DIRECTIONAL_THRESHOLD,
    isolation_threshold: NEIGHBORHOOD_DRIFT_ISOLATION_THRESHOLD,
    signal_memory_ids: signalMemoryIds,
    candidate_count: candidates.length,
    candidates: candidates.slice(0, 24),
    reason: "Neighborhood drift is reported as a read-only sparse feedback observation; it does not lower authority, change guide placement, suppress, archive, or delete memory.",
  };
}

function traceRelationDecisions(memory: AionisMemoryPacket | null): AionisMemoryDecisionTrace["relation_decisions"] {
  return (memory?.evidence_trail ?? [])
    .filter((entry) => entry.source === "edge" && !!entry.lifecycle_relation)
    .slice(0, 96)
    .map((entry) => ({
      evidence_id: entry.evidence_id,
      memory_id: entry.memory_id,
      relation: entry.relation,
      source_memory_id: entry.lifecycle_relation!.source_memory_id,
      target_memory_id: entry.lifecycle_relation!.target_memory_id,
      lifecycle_relation: entry.lifecycle_relation!.lifecycle_relation,
      confidence: entry.lifecycle_relation!.confidence,
      producer: entry.lifecycle_relation!.producer,
      candidate_confidence: entry.lifecycle_relation!.candidate_confidence,
      signals: entry.lifecycle_relation!.signals,
      gate: entry.lifecycle_relation!.gate,
      reason: entry.reason,
      reasons: entry.lifecycle_relation!.reasons,
    }));
}

function relationDecisionByTarget(
  relationDecisions: AionisMemoryDecisionTrace["relation_decisions"],
): Map<string, AionisMemoryDecisionTrace["relation_decisions"][number]> {
  return new Map(relationDecisions.map((entry) => [entry.target_memory_id, entry]));
}

function traceDecisionKind(args: {
  surface: AionisMemoryDecisionSurface;
}): AionisMemoryDecisionTrace["memory_decisions"][number]["decision_kind"] {
  if (args.surface === "use_now") return "used";
  if (args.surface === "inspect_before_use") return "downgraded";
  if (args.surface === "do_not_use") return "blocked";
  if (args.surface === "rehydrate") return "rehydrate";
  return "not_agent_facing";
}

function traceUsedDetail(args: {
  entry: MemoryPacketEntry;
  surface: AionisMemoryDecisionSurface;
  relationDecision: AionisMemoryDecisionTrace["relation_decisions"][number] | undefined;
}): AionisMemoryDecisionTrace["memory_decisions"][number]["used_detail"] {
  if (args.surface !== "use_now") return null;
  return {
    authority: args.entry.authority,
    confidence: args.entry.confidence,
    salience: args.entry.salience,
    source_layer: args.entry.source_layer,
    not_superseded: !args.relationDecision,
  };
}

function traceDowngradedDetail(args: {
  surface: AionisMemoryDecisionSurface;
  relationDecision: AionisMemoryDecisionTrace["relation_decisions"][number] | undefined;
}): AionisMemoryDecisionTrace["memory_decisions"][number]["downgraded_detail"] {
  if (args.surface !== "inspect_before_use" || !args.relationDecision) return null;
  return {
    by_memory_id: args.relationDecision.source_memory_id,
    evidence_id: args.relationDecision.evidence_id,
    relation: {
      source_memory_id: args.relationDecision.source_memory_id,
      target_memory_id: args.relationDecision.target_memory_id,
      lifecycle_relation: args.relationDecision.lifecycle_relation,
      confidence: args.relationDecision.confidence,
      producer: args.relationDecision.producer,
      candidate_confidence: args.relationDecision.candidate_confidence,
      signals: args.relationDecision.signals,
      gate: args.relationDecision.gate,
      reasons: args.relationDecision.reasons,
    },
  };
}

function traceBlockedBy(entry: MemoryPacketEntry): NonNullable<AionisMemoryDecisionTrace["memory_decisions"][number]["blocked_detail"]>["blocked_by"] {
  if (entry.lifecycle_state === "suppressed" || entry.lifecycle_state === "demoted") return "suppressed_lifecycle";
  if (entry.lifecycle_state === "archived") return "archived_lifecycle";
  if (entry.authority === "blocked") return "blocked_authority";
  if (entry.authority === "candidate" || entry.authority === "none") return "low_authority";
  return "agent_surface_projection";
}

function traceBlockedDetail(args: {
  entry: MemoryPacketEntry;
  surface: AionisMemoryDecisionSurface;
}): AionisMemoryDecisionTrace["memory_decisions"][number]["blocked_detail"] {
  if (args.surface !== "do_not_use") return null;
  const blockedBy = traceBlockedBy(args.entry);
  return {
    blocked_by: blockedBy,
    lifecycle_state: args.entry.lifecycle_state,
    authority: args.entry.authority,
    reason: `Memory is not exposed for direct agent use because ${blockedBy}.`,
  };
}

function traceRehydrateDetail(args: {
  entry: MemoryPacketEntry;
  surface: AionisMemoryDecisionSurface;
  memory: AionisMemoryPacket | null;
  guide: AionisGuidePacket | null;
  agentContext: AionisAgentContext | null;
}): AionisMemoryDecisionTrace["memory_decisions"][number]["rehydrate_detail"] {
  if (args.surface !== "rehydrate") return null;
  const memoryHint = args.memory?.lifecycle.rehydration_hints.find((hint) => hint.memory_id === args.entry.memory_id);
  const agentHint = args.agentContext?.rehydrate_hints.find((hint) => hint.memory_id === args.entry.memory_id);
  const guideHint = args.guide?.guide_brief.rehydrate.find((hint) => hint.memory_id === args.entry.memory_id);
  return {
    mode: memoryHint?.mode ?? "differential",
    reason: memoryHint?.reason ?? agentHint?.reason ?? guideHint?.reason ?? "Memory requires payload rehydration before use.",
    required: memoryHint?.required ?? agentHint?.required ?? guideHint?.required ?? false,
    payload_status: memoryHint ? "cold_payload" : "unknown",
  };
}

export function buildAionisMemoryDecisionTrace(args: BuildAionisMemoryDecisionTraceArgs): AionisMemoryDecisionTrace {
  const memory = args.after_guide.memory_packet ?? null;
  const guide = args.after_guide.guide_packet ?? null;
  const agentContext = args.after_guide.agent_context ?? null;
  const relationDecisions = traceRelationDecisions(memory);
  const relationByTarget = relationDecisionByTarget(relationDecisions);
  const forgetDecisions = traceForgetDecisions(args.forget_result);
  const feedbackInput = traceFeedbackAttributionInput(args.forget_result);
  const memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"] = (memory?.relevant_memories ?? [])
    .slice(0, 96)
    .map((entry) => {
      const surface = traceSurfaceForMemory({ entry, guide, agentContext });
      const relationDecision = relationByTarget.get(entry.memory_id);
      return {
        memory_id: entry.memory_id,
        title: entry.title,
        domain: entry.domain,
        memory_type: entry.memory_type,
        lifecycle_state: entry.lifecycle_state,
        authority: entry.authority,
        agent_surface: surface,
        decision_kind: traceDecisionKind({ surface }),
        reason_codes: traceReasonCodes({ entry, surface, memory, guide, agentContext }),
        evidence_ids: entry.evidence_ids,
        used_detail: traceUsedDetail({ entry, surface, relationDecision }),
        downgraded_detail: traceDowngradedDetail({ surface, relationDecision }),
        blocked_detail: traceBlockedDetail({ entry, surface }),
        feedback_detail: traceFeedbackDetail({ entry, feedbackInput }),
        rehydrate_detail: traceRehydrateDetail({ entry, surface, memory, guide, agentContext }),
      };
    });
  const feedbackAttribution = buildTraceFeedbackAttribution({
    feedbackInput,
    memoryDecisions,
    agentContext,
  });
  const neighborhoodDriftObservation = buildNeighborhoodDriftObservation({
    memory,
    memoryDecisions,
  });
  const confidenceDecayCandidateSummary = buildConfidenceDecayCandidateSummary({
    feedbackAttribution,
    memory,
    memoryDecisions,
    neighborhoodDriftObservation,
  });
  const inspectBeforeUseShadowDelta = buildInspectBeforeUseShadowDelta({
    confidenceDecayCandidateSummary,
    memoryDecisions,
  });
  const contextDecision = {
    prompt_char_count: agentContext?.prompt_text.length ?? 0,
    target_files: agentContext?.target_files ?? [],
    use_now_count: agentContext?.use_now.length ?? guide?.guide_brief.use_now.length ?? 0,
    inspect_before_use_count: agentContext?.inspect_before_use.length ?? guide?.guide_brief.inspect_before_use.length ?? 0,
    do_not_use_count: agentContext?.do_not_use.length ?? guide?.guide_brief.do_not_use.length ?? 0,
    rehydrate_hint_count: agentContext?.rehydrate_hints.length ?? guide?.guide_brief.rehydrate.length ?? 0,
    memory_ids: agentContext?.memory_ids ?? guide?.memory_lifecycle.used_memory_ids ?? [],
  };
  const directUseCount = memoryDecisions.filter((entry) => entry.agent_surface === "use_now").length;
  const inspectCount = memoryDecisions.filter((entry) => entry.agent_surface === "inspect_before_use").length;
  const doNotUseCount = memoryDecisions.filter((entry) => entry.agent_surface === "do_not_use").length;
  const rehydrateCount = memoryDecisions.filter((entry) => entry.agent_surface === "rehydrate").length;
  const feedbackAttributionCount = feedbackAttribution.attributed_memory_ids.length;
  const feedbackThresholdMetCount = feedbackAttribution.threshold_met_memory_ids.length;
  const historyUsed = agentContext?.history_used ?? guide?.guide_brief.history_used ?? memoryDecisions.length > 0;
  const recommendedPosture =
    agentContext?.recommended_posture
    ?? guide?.guide_brief.recommended_posture
    ?? (historyUsed ? "use_as_context" : "ignore_history");
  const authority =
    agentContext?.authority
    ?? guide?.guide_brief.authority
    ?? (memory?.behavior_impact.will_shape_behavior ? "advisory" : "none");
  const negativeTransferRisk =
    agentContext?.risk.negative_transfer_risk
    ?? guide?.risk.negative_transfer_risk
    ?? memory?.risk.negative_transfer_risk
    ?? "low";
  const contradictionWarningCount = memory?.contradiction_warnings.length ?? 0;
  const controlVisible =
    inspectCount > 0
    || doNotUseCount > 0
    || rehydrateCount > 0
    || relationDecisions.length > 0
    || contradictionWarningCount > 0
    || feedbackAttribution.present
    || confidenceDecayCandidateSummary.present
    || inspectBeforeUseShadowDelta.present
    || forgetDecisions.length > 0
    || negativeTransferRisk !== "low";

  return parseAionisMemoryDecisionTrace({
    contract_version: "aionis_memory_decision_trace_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    intended_use: "measure_debug_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    input: {
      before_guide_present: !!args.before_guide,
      after_guide_present: true,
      memory_packet_present: !!memory,
      guide_packet_present: !!guide,
      agent_context_present: !!agentContext,
      forget_result_present: !!args.forget_result,
    },
    summary: {
      total_memory_count: memoryDecisions.length,
      direct_use_count: directUseCount,
      inspect_before_use_count: inspectCount,
      do_not_use_count: doNotUseCount,
      rehydrate_count: rehydrateCount,
      relation_count: relationDecisions.length,
      contradiction_warning_count: contradictionWarningCount,
      feedback_attribution_count: feedbackAttributionCount,
      feedback_threshold_met_count: feedbackThresholdMetCount,
      unattributed_recalled_memory_count: feedbackAttribution.unattributed_recalled_memory_ids.length,
      prompt_char_count: contextDecision.prompt_char_count,
      history_used: historyUsed,
      recommended_posture: recommendedPosture,
      authority,
      negative_transfer_risk: negativeTransferRisk,
      learning_control_visible: controlVisible,
    },
    memory_decisions: memoryDecisions,
    relation_decisions: relationDecisions,
    feedback_attribution: feedbackAttribution,
    neighborhood_drift_observation: neighborhoodDriftObservation,
    confidence_decay_candidate_summary: confidenceDecayCandidateSummary,
    inspect_before_use_shadow_delta: inspectBeforeUseShadowDelta,
    context_decision: contextDecision,
    forget_decisions: forgetDecisions,
    source_map: {
      routes_used: args.source_map?.routes_used ?? [],
      internal_surfaces_used: args.source_map?.internal_surfaces_used ?? compactStrings([
        "memory_packet_lifecycle",
        "guide_packet_posture",
        agentContext ? "agent_context_surface_projection" : null,
        relationDecisions.length > 0 ? "memory_lifecycle_relation_graph" : null,
        feedbackAttribution.present ? "feedback_attribution_trace" : null,
        neighborhoodDriftObservation.present ? "neighborhood_drift_observation" : null,
        confidenceDecayCandidateSummary.present ? "confidence_decay_candidate_summary" : null,
        inspectBeforeUseShadowDelta.present ? "inspect_before_use_shadow_delta" : null,
        forgetDecisions.length > 0 ? "forget_result_projection" : null,
        "memory_decision_trace",
      ]),
      omitted_internal_surfaces: args.source_map?.omitted_internal_surfaces ?? [
        "raw_memory_rows",
        "raw_slots",
        "raw_embedding_vectors",
        "agent_prompt_injection",
      ],
    },
  });
}

function auditClaim(args: {
  claim: AionisMemoryDecisionAuditReport["claims"][number]["claim"];
  status: AionisMemoryDecisionAuditReport["claims"][number]["status"];
  evidence: string;
}): AionisMemoryDecisionAuditReport["claims"][number] {
  return args;
}

function auditFeedbackSignalMemories(args: {
  trace: AionisMemoryDecisionTrace;
  memoryIds: string[];
  reason: string;
}): AionisMemoryDecisionAuditReport["feedback_signal_review"]["positive_attributed_memories"] {
  const decisionById = new Map(args.trace.memory_decisions.map((entry) => [entry.memory_id, entry]));
  return args.memoryIds.slice(0, 48).map((memoryId) => {
    const decision = decisionById.get(memoryId);
    return {
      memory_id: memoryId,
      title: decision?.title ?? null,
      reason: args.reason,
    };
  });
}

function buildAuditFeedbackSignalReview(
  trace: AionisMemoryDecisionTrace,
): AionisMemoryDecisionAuditReport["feedback_signal_review"] {
  const summary = trace.feedback_attribution.sparse_feedback_signal_summary;
  return {
    present: summary.present,
    mode: summary.mode,
    authority_mutation: false,
    positive_attributed_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.positive_attributed_memory_ids,
      reason: "Host outcome positively attributed this memory as used evidence.",
    }),
    weak_counter_signal_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.weak_counter_signal_memory_ids,
      reason: "Host outcome produced a weak counter-signal; this remains read-only unless attribution thresholds are met elsewhere.",
    }),
    strong_counter_signal_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.strong_counter_signal_memory_ids,
      reason: "Host outcome produced verifier/tool/runtime-aligned counter-signal evidence.",
    }),
    relation_counter_signal_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.relation_counter_signal_memory_ids,
      reason: "Accepted lifecycle relation evidence points to newer related memory that supersedes, contradicts, or invalidates this memory.",
    }),
    contradiction_warning_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.contradiction_warning_memory_ids,
      reason: "Memory carried contradiction or contested-lifecycle warning evidence and should remain inspect-first.",
    }),
    repeated_unattributed_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.repeated_unattributed_memory_ids,
      reason: "Memory was repeatedly shown in guide traces without being host-marked as used in the current activation.",
    }),
    repeated_unattributed_without_positive_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.repeated_unattributed_without_positive_memory_ids,
      reason: "Memory was repeatedly shown without any recorded positive attributed use.",
    }),
    read_only_signal_memory_ids: summary.read_only_signal_memory_ids,
    candidate_learning_control_summary: summary.candidate_learning_control_summary,
    reason: summary.reason,
  };
}

function buildAuditDecisionReviews(
  trace: AionisMemoryDecisionTrace,
): AionisMemoryDecisionAuditReport["decision_reviews"] {
  return {
    used_memories: trace.memory_decisions
      .filter((entry) => entry.decision_kind === "used" && !!entry.used_detail)
      .slice(0, 48)
      .map((entry) => ({
        memory_id: entry.memory_id,
        title: entry.title,
        authority: entry.used_detail!.authority,
        confidence: entry.used_detail!.confidence,
        salience: entry.used_detail!.salience,
        source_layer: entry.used_detail!.source_layer,
        evidence_ids: entry.evidence_ids,
        reason: entry.used_detail!.not_superseded
          ? "Memory entered direct use because it has usable authority and no accepted lifecycle relation superseded it."
          : "Memory entered direct use, but an accepted lifecycle relation was also present in the trace.",
      })),
    downgraded_memories: trace.memory_decisions
      .filter((entry) => entry.decision_kind === "downgraded" && !!entry.downgraded_detail)
      .slice(0, 48)
      .map((entry) => ({
        memory_id: entry.memory_id,
        title: entry.title,
        by_memory_id: entry.downgraded_detail!.by_memory_id,
        evidence_id: entry.downgraded_detail!.evidence_id,
        lifecycle_relation: entry.downgraded_detail!.relation.lifecycle_relation,
        relation_confidence: entry.downgraded_detail!.relation.confidence,
        producer: entry.downgraded_detail!.relation.producer,
        candidate_confidence: entry.downgraded_detail!.relation.candidate_confidence,
        signals: entry.downgraded_detail!.relation.signals,
        gate: entry.downgraded_detail!.relation.gate,
        reasons: entry.downgraded_detail!.relation.reasons,
      })),
    blocked_memories: trace.memory_decisions
      .filter((entry) => entry.decision_kind === "blocked" && !!entry.blocked_detail)
      .slice(0, 48)
      .map((entry) => ({
        memory_id: entry.memory_id,
        title: entry.title,
        blocked_by: entry.blocked_detail!.blocked_by,
        lifecycle_state: entry.blocked_detail!.lifecycle_state,
        authority: entry.blocked_detail!.authority,
        reason: entry.blocked_detail!.reason,
      })),
    rehydrate_memories: trace.memory_decisions
      .filter((entry) => entry.decision_kind === "rehydrate" && !!entry.rehydrate_detail)
      .slice(0, 48)
      .map((entry) => ({
        memory_id: entry.memory_id,
        title: entry.title,
        mode: entry.rehydrate_detail!.mode,
        required: entry.rehydrate_detail!.required,
        payload_status: entry.rehydrate_detail!.payload_status,
        reason: entry.rehydrate_detail!.reason,
      })),
  };
}

export function buildAionisMemoryDecisionAuditReport(
  args: BuildAionisMemoryDecisionAuditReportArgs,
): AionisMemoryDecisionAuditReport {
  const trace = args.trace;
  const decisionReviews = buildAuditDecisionReviews(trace);
  const controlledMemoryCount =
    trace.summary.inspect_before_use_count
    + trace.summary.do_not_use_count
    + trace.summary.rehydrate_count;
  const blockedOrSuppressedCount = trace.memory_decisions.filter((entry) =>
    entry.agent_surface === "do_not_use"
    || entry.lifecycle_state === "suppressed"
    || entry.lifecycle_state === "archived"
    || entry.authority === "blocked"
  ).length;
  const verdict = trace.summary.total_memory_count === 0
    ? "no_history" as const
    : trace.summary.learning_control_visible
      ? "learning_control_visible" as const
      : "insufficient_trace" as const;
  const promptCompactStatus = trace.context_decision.prompt_char_count === 0
    ? "not_applicable" as const
    : trace.context_decision.prompt_char_count <= 4096
      ? "pass" as const
      : "fail" as const;
  const feedbackSignalReview = buildAuditFeedbackSignalReview(trace);

  return parseAionisMemoryDecisionAuditReport({
    contract_version: "aionis_memory_decision_audit_report_v1",
    tenant_id: trace.tenant_id,
    scope: trace.scope,
    intended_use: "operator_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    verdict,
    claims: [
      auditClaim({
        claim: "agent_prompt_excluded",
        status: trace.agent_prompt_included === false ? "pass" : "fail",
        evidence: "Decision trace is returned on measure/debug/audit surfaces, not embedded in agent_context.prompt_text.",
      }),
      auditClaim({
        claim: "runtime_state_unchanged",
        status: trace.runtime_mutation === false ? "pass" : "fail",
        evidence: "Decision trace is a read-only projection over existing product packets and forget effects.",
      }),
      auditClaim({
        claim: "memory_lifecycle_visible",
        status: trace.summary.total_memory_count === 0 ? "not_applicable" : "pass",
        evidence: `${trace.summary.total_memory_count} memory decisions exposed with lifecycle and authority.`,
      }),
      auditClaim({
        claim: "negative_transfer_control_visible",
        status: trace.summary.learning_control_visible ? "pass" : "not_applicable",
        evidence: `${controlledMemoryCount} memories were placed on inspect/do-not-use/rehydrate surfaces.`,
      }),
      auditClaim({
        claim: "feedback_attribution_visible",
        status: trace.feedback_attribution.present ? "pass" : "not_applicable",
        evidence: trace.feedback_attribution.present
          ? `${trace.feedback_attribution.attributed_memory_ids.length} memories received host-used feedback attribution; ${trace.feedback_attribution.unattributed_recalled_memory_ids.length} recalled memories stayed unattributed.`
          : "No activate feedback attribution was supplied for this trace.",
      }),
      auditClaim({
        claim: "history_surface_compact",
        status: promptCompactStatus,
        evidence: `Agent context prompt length is ${trace.context_decision.prompt_char_count} characters.`,
      }),
    ],
    counters: {
      total_memory_count: trace.summary.total_memory_count,
      controlled_memory_count: controlledMemoryCount,
      relation_count: trace.summary.relation_count,
      feedback_attribution_count: trace.summary.feedback_attribution_count,
      feedback_threshold_met_count: trace.summary.feedback_threshold_met_count,
      prompt_char_count: trace.context_decision.prompt_char_count,
    },
    risks: {
      negative_transfer_risk: trace.summary.negative_transfer_risk,
      unresolved_inspection_count: trace.summary.inspect_before_use_count,
      blocked_or_suppressed_count: blockedOrSuppressedCount,
      reasons: compactStrings([
        ...trace.memory_decisions
          .filter((entry) => entry.agent_surface !== "use_now")
          .flatMap((entry) => entry.reason_codes),
        ...trace.relation_decisions.map((entry) => entry.reason),
      ]).slice(0, 12),
    },
    feedback_signal_review: feedbackSignalReview,
    neighborhood_drift_review: trace.neighborhood_drift_observation,
    confidence_decay_candidate_review: trace.confidence_decay_candidate_summary,
    inspect_before_use_shadow_delta_review: trace.inspect_before_use_shadow_delta,
    decision_reviews: decisionReviews,
    source_map: {
      routes_used: args.source_map?.routes_used ?? trace.source_map.routes_used,
      internal_surfaces_used: args.source_map?.internal_surfaces_used ?? compactStrings([
        ...trace.source_map.internal_surfaces_used,
        feedbackSignalReview.present ? "sparse_feedback_signal_summary" : null,
        trace.neighborhood_drift_observation.present ? "neighborhood_drift_observation" : null,
        trace.confidence_decay_candidate_summary.present ? "confidence_decay_candidate_summary" : null,
        trace.inspect_before_use_shadow_delta.present ? "inspect_before_use_shadow_delta" : null,
        "memory_decision_audit_report",
      ]),
      omitted_internal_surfaces: args.source_map?.omitted_internal_surfaces ?? [
        "raw_memory_rows",
        "raw_slots",
        "raw_embedding_vectors",
      ],
    },
  });
}

export function buildAionisGuidePacket(args: BuildAionisGuidePacketArgs): AionisGuidePacket {
  const firstStep = args.planning.continuity_guidance;
  const authority = mapAuthority(
    firstStep?.contract_trust ?? args.planning.history_impact_summary.learning_control.contract_trust,
    args.planning.action_intelligence_pre_action_gate?.authority_blocked === true,
  );
  const authorityVisibilityStableBlockedCount = authorityConsumptionStablePromotionBlockedCount(
    args.planning.authority_visibility_summary,
  );
  const targetFiles = recoverTargetFiles({
    firstStep,
    executionSummary: args.execution_summary,
  });
  const acceptanceChecks = recoverAcceptanceChecks({
    firstStep,
    executionSummary: args.execution_summary,
  });
  const usedMemoryIds = compactStrings([
    ...args.planning.action_packet_summary.workflow_anchor_ids,
    ...args.planning.action_packet_summary.candidate_workflow_anchor_ids,
    ...args.planning.action_packet_summary.trusted_pattern_anchor_ids,
    ...args.planning.action_packet_summary.candidate_pattern_anchor_ids,
  ]);
  const rehydrationIds = compactStrings(args.planning.action_packet_summary.rehydration_anchor_ids);
  const stateSummary =
    args.execution_summary?.continuity_snapshot_summary.recommended_action
    ?? args.execution_summary?.collaboration_summary.next_action
    ?? args.planning.history_impact_summary.primary_reason
    ?? null;
  const resumable =
    args.planning.continuity_carrier_summary.total_count > 0
    || args.execution_summary?.continuity_snapshot_summary.snapshot_mode === "packet_backed";
  const workflowCandidates = buildWorkflowCandidates(args.planning);
  const toolPreferences = buildToolPreferences(args.planning, authority);
  const historyContributions = buildGuideHistoryContributions(args.planning);
  const memoryLifecycle: AionisGuidePacket["memory_lifecycle"] = {
    used_memory_ids: usedMemoryIds,
    suppressed_memory_ids: args.planning.forgetting_summary.suppressed_pattern_anchor_ids,
    archived_memory_ids: [],
    rehydration_hints: rehydrationIds.map((memoryId) => ({
      memory_id: memoryId,
      reason: "Differential rehydration candidate from the planning summary.",
      required: args.planning.action_intelligence_pre_action_gate?.requires_rehydration === true,
    })),
  };
  const negativeTransferRiskValue = negativeTransferRisk(args.planning);
  const blockedAuthorityCount =
    args.planning.authority_visibility_summary.authoritative_blocked_count
    + authorityVisibilityStableBlockedCount;
  const staleMemoryCount = args.planning.forgetting_summary.stale_signal_count;
  const riskReasons = buildRiskReasons(args.planning, args.execution_summary);

  return parseAionisGuidePacket({
    contract_version: "aionis_guide_packet_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor: args.actor,
    task: asTask(args.task),
    guide_brief: buildAionisGuideBrief({
      stateSummary,
      resumable,
      targetFiles,
      acceptanceChecks,
      workflowCandidates,
      toolPreferences,
      historyContributions,
      memoryLifecycle,
      negativeTransferRisk: negativeTransferRiskValue,
      blockedAuthorityCount,
      staleMemoryCount,
      riskReasons,
    }),
    recovered_state: {
      state_summary: stateSummary,
      resumable,
      handoff_ids: [],
      execution_state_revision: null,
      target_files: targetFiles,
      acceptance_checks: acceptanceChecks,
    },
    proven_facts: [],
    guidance: {
      workflow_candidates: workflowCandidates,
      tool_preferences: toolPreferences,
    },
    history_contributions: historyContributions,
    memory_lifecycle: memoryLifecycle,
    risk: {
      negative_transfer_risk: negativeTransferRiskValue,
      blocked_authority_count: blockedAuthorityCount,
      stale_memory_count: staleMemoryCount,
      provider_or_protocol_quarantine: false,
      reasons: riskReasons,
    },
    source_map: {
      routes_used: args.source_map?.routes_used ?? [],
      internal_surfaces_used: args.source_map?.internal_surfaces_used ?? [
        "planning_summary",
        "history_impact_summary",
        "action_packet_summary",
        "forgetting_summary",
      ],
      omitted_internal_surfaces: args.source_map?.omitted_internal_surfaces ?? [
        "raw_find_resolve",
        "rules_state_evaluate",
        "replay_repair_dispatch",
        "sandbox_executor",
      ],
    },
  });
}

function learningPosture(planning: PlanningSummary | AssemblySummary): LearningPosture {
  const control = planning.history_impact_summary.learning_control;
  const forgetting = planning.forgetting_summary.semantic_action_counts;
  const stablePromotionBlockedCount = authorityConsumptionStablePromotionBlockedCount(control);
  if (
    control.action_start_blocked
    || control.authoritative_blocked_count > 0
    || stablePromotionBlockedCount > 0
    || planning.authority_visibility_summary.false_confidence_count > 0
  ) {
    return "constrain";
  }
  if (
    planning.pattern_lifecycle_summary.counter_evidence_open_count > 0
    || planning.policy_lifecycle_summary.contested_count > 0
    || forgetting.demote > 0
    || forgetting.archive > 0
  ) {
    return "invalidate";
  }
  if (
    control.stable_promotion_allowed_count > 0
    || planning.workflow_lifecycle_summary.promotion_ready_count > 0
    || planning.workflow_signal_summary.promotion_ready_workflow_count > 0
  ) {
    return "promotion_ready";
  }
  if (
    planning.workflow_lifecycle_summary.candidate_count > 0
    || planning.action_packet_summary.candidate_workflow_count > 0
    || planning.action_packet_summary.candidate_pattern_count > 0
  ) {
    return "candidate_only";
  }
  return "insufficient_evidence";
}

function learningAuthority(args: {
  posture: LearningPosture;
  planning: PlanningSummary | AssemblySummary;
}): LearningAuthority {
  const stablePromotionBlockedCount = authorityConsumptionStablePromotionBlockedCount(
    args.planning.history_impact_summary.learning_control,
  );
  if (
    args.planning.history_impact_summary.learning_control.action_start_blocked
    || stablePromotionBlockedCount > 0
    || args.planning.history_impact_summary.learning_control.authoritative_blocked_count > 0
  ) {
    return "blocked";
  }
  if (args.posture === "promotion_ready") return "advisory";
  if (args.posture === "insufficient_evidence") return "none";
  return "candidate";
}

function learningPostureReason(args: {
  posture: LearningPosture;
  planning: PlanningSummary | AssemblySummary;
}): string {
  const control = args.planning.history_impact_summary.learning_control;
  const blockers = compactStrings([
    ...control.primary_blockers,
    ...args.planning.authority_visibility_summary.top_blockers,
    args.planning.forgetting_summary.primary_forgetting_reason,
  ]);
  if (blockers.length > 0) return blockers.join("; ");
  if (args.posture === "promotion_ready") return "Existing learning evidence is promotion-ready, but product authority remains evidence-scoped.";
  if (args.posture === "candidate_only") return "Learning candidates are visible but do not have enough evidence for stable authority.";
  if (args.posture === "invalidate") return "Counter-evidence or forgetting signals indicate candidate invalidation or demotion review.";
  if (args.posture === "constrain") return "Learning-control or authority gates limit how far history can shape future behavior.";
  return "No learning evidence was strong enough to shape future behavior.";
}

function buildLearningCandidates(planning: PlanningSummary | AssemblySummary): LearningCandidate[] {
  const candidates: LearningCandidate[] = [];
  const stablePromotionBlockedCount = authorityConsumptionStablePromotionBlockedCount(
    planning.history_impact_summary.learning_control,
  );
  for (const workflowId of planning.action_packet_summary.candidate_workflow_anchor_ids) {
    candidates.push({
      candidate_id: workflowId,
      kind: "workflow",
      authority: stablePromotionBlockedCount > 0 ? "blocked" : "candidate",
      evidence_count: Math.max(1, planning.workflow_lifecycle_summary.candidate_count),
      promotion_state: planning.workflow_lifecycle_summary.promotion_ready_count > 0 ? "promotion_ready" : "candidate",
      source_ids: [workflowId],
      reason: "Workflow candidate is visible but must remain scoped until evidence gates admit promotion.",
    });
  }
  for (const patternId of planning.action_packet_summary.candidate_pattern_anchor_ids) {
    candidates.push({
      candidate_id: patternId,
      kind: "pattern",
      authority: "candidate",
      evidence_count: Math.max(1, planning.pattern_lifecycle_summary.candidate_count),
      promotion_state: "candidate",
      source_ids: [patternId],
      reason: "Pattern candidate has not passed stable promotion evidence.",
    });
  }
  for (const patternId of planning.action_packet_summary.contested_pattern_anchor_ids) {
    candidates.push({
      candidate_id: patternId,
      kind: "pattern",
      authority: "blocked",
      evidence_count: Math.max(1, planning.pattern_lifecycle_summary.contested_count),
      promotion_state: "contested",
      source_ids: [patternId],
      reason: "Contested pattern is visible for review, not stable reuse.",
    });
  }
  return candidates.slice(0, 32);
}

export function buildAionisLearningPacket(args: BuildAionisLearningPacketArgs): AionisLearningPacket {
  const posture = learningPosture(args.planning);
  const authority = learningAuthority({ posture, planning: args.planning });
  const control = args.planning.history_impact_summary.learning_control;
  const stablePromotionBlockedCount = authorityConsumptionStablePromotionBlockedCount(control);
  const stablePromotionAllowed = control.stable_promotion_allowed_count > 0 && stablePromotionBlockedCount === 0;
  const promotionDeniedReasons = compactStrings([
    ...control.primary_blockers,
    ...args.planning.authority_visibility_summary.top_blockers,
  ]);

  return parseAionisLearningPacket({
    contract_version: "aionis_learning_packet_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor: args.actor,
    task: asTask(args.task),
    posture: {
      recommended_learning_posture: posture,
      authority,
      source_code_change_allowed: false,
      stable_promotion_allowed: stablePromotionAllowed,
      reason: learningPostureReason({ posture, planning: args.planning }),
    },
    candidates: buildLearningCandidates(args.planning),
    learning_control: {
      contract_trust: control.contract_trust,
      action_start_blocked: control.action_start_blocked,
      authoritative_allowed_count: control.authoritative_allowed_count,
      authoritative_blocked_count: control.authoritative_blocked_count,
      stable_promotion_allowed_count: control.stable_promotion_allowed_count,
      [AUTHORITY_STABLE_PROMOTION_BLOCKED_COUNT_FIELD]: stablePromotionBlockedCount,
      blocked_reasons: promotionDeniedReasons,
    } as AionisLearningPacket["learning_control"],
    lifecycle_effect: {
      promoted_workflow_count: args.planning.workflow_lifecycle_summary.transition_counts.promoted_to_stable,
      candidate_workflow_count: args.planning.workflow_lifecycle_summary.candidate_count,
      trusted_pattern_count: args.planning.pattern_lifecycle_summary.trusted_count,
      contested_pattern_count: args.planning.pattern_lifecycle_summary.contested_count,
      active_policy_count: args.planning.policy_lifecycle_summary.active_count,
      contested_policy_count: args.planning.policy_lifecycle_summary.contested_count,
      suppressed_memory_ids: args.planning.forgetting_summary.suppressed_pattern_anchor_ids,
      demote_count: args.planning.forgetting_summary.semantic_action_counts.demote,
      archive_count: args.planning.forgetting_summary.semantic_action_counts.archive,
      review_count: args.planning.forgetting_summary.semantic_action_counts.review,
    },
    evidence: {
      workflow_anchor_ids: args.planning.action_packet_summary.workflow_anchor_ids,
      candidate_workflow_anchor_ids: args.planning.action_packet_summary.candidate_workflow_anchor_ids,
      trusted_pattern_anchor_ids: args.planning.action_packet_summary.trusted_pattern_anchor_ids,
      candidate_pattern_anchor_ids: args.planning.action_packet_summary.candidate_pattern_anchor_ids,
      contested_pattern_anchor_ids: args.planning.action_packet_summary.contested_pattern_anchor_ids,
      promotion_denied_reasons: promotionDeniedReasons,
    },
    export_readiness: {
      training_export_ready: false,
      positive_transfer_required: true,
      reason: "Route-level learning packets expose learning candidates only; export requires measured positive transfer in an EffectReport.",
    },
    source_map: {
      routes_used: args.source_map?.routes_used ?? [],
      internal_surfaces_used: args.source_map?.internal_surfaces_used ?? [
        "history_impact_summary.learning",
        "workflow_lifecycle_summary",
        "pattern_lifecycle_summary",
        "policy_lifecycle_summary",
        "authority_visibility_summary",
        "forgetting_summary",
      ],
      omitted_internal_surfaces: args.source_map?.omitted_internal_surfaces ?? [
        "raw_slots",
        "raw_model_review",
        "task_specific_repair_content",
      ],
    },
  });
}

function impactDirection(args: {
  report: KernelEffectReport;
  sufficientEvidence: boolean;
}): ProductImpactDirection {
  if (!args.sufficientEvidence) return "insufficient_evidence";
  if (args.report.proof_summary.regressed_kernel_count > 0 || args.report.effect_delta < -0.05) return "negative";
  if (args.report.proof_summary.improved_kernel_count > 0 && args.report.effect_delta > 0.05) return "positive";
  return "neutral";
}

function changedFields(report: KernelEffectReport): string[] {
  return compactStrings([
    report.proof_summary.repeated_discovery_delta !== 0 ? "efficiency.repeated_discovery_delta" : null,
    report.proof_summary.continuity_guidance_improved ? "execution_experience_guidance" : null,
    report.proof_summary.workflow_reuse_improved ? "learning_effect.workflow_reuse" : null,
    report.proof_summary.context_precision_delta !== 0 ? "forgetting_effect.context_precision" : null,
    report.proof_summary.stale_memory_delta !== 0 ? "forgetting_effect.stale_memory_suppression" : null,
    report.proof_summary.weak_authority_blocked ? "learning_control.blocked_authority" : null,
    ...report.kernel_scores
      .filter((score) => score.delta !== 0)
      .map((score) => `kernel.${score.capability_id}`),
  ]);
}

function trainingTypeForKernel(score: EffectKernelComparison): TrainingCandidateType {
  if (score.capability_id === "continuity") return "handoff_distillation";
  if (score.capability_id === "learning") return "workflow_selector";
  if (score.capability_id === "forgetting") return "forgetting_suppression";
  return "authority_judgment";
}

function labelForKernel(score: EffectKernelComparison, sufficientEvidence: boolean): TrainingCandidateLabel {
  if (!sufficientEvidence) return "insufficient_evidence";
  if (score.delta > 0.05 && score.status !== "fail") return "positive";
  if (score.delta < -0.05 || score.status === "fail") return "negative";
  return "neutral";
}

function buildTrainingCandidates(args: {
  report: KernelEffectReport;
  sufficientEvidence: boolean;
}): AionisEffectReport["training_candidates"] {
  return args.report.kernel_scores
    .filter((score) => score.delta !== 0 || score.status === "fail")
    .map((score) => {
      const label = labelForKernel(score, args.sufficientEvidence);
      return {
        candidate_type: trainingTypeForKernel(score),
        source_ids: [`effect_kernel:${score.capability_id}`],
        label,
        export_ready: args.sufficientEvidence && label === "positive" && args.report.status === "pass",
        reason: compactStrings([
          ...score.signals,
          ...score.regressions,
          `${score.capability_id} delta ${score.delta}`,
        ]).join("; "),
      };
    });
}

function buildKernelEffectHistoryContributions(report: KernelEffectReport): AionisEffectReport["history_contributions"] {
  const continuityImproved = report.kernel_scores.some((score) => score.capability_id === "continuity" && score.delta > 0);
  const workflowReuseImproved = report.proof_summary.workflow_reuse_improved;
  return {
    handoff: {
      used: continuityImproved,
      source_count: continuityImproved ? 1 : 0,
      source_ids: continuityImproved ? ["effect_kernel:continuity"] : [],
      changed_fields: continuityImproved ? ["history_impact.continuity"] : [],
      reason: continuityImproved
        ? "Continuity improvement indicates handoff-style recovered state contributed to the assisted run."
        : "No measured continuity contribution was available.",
    },
    replay: {
      used: workflowReuseImproved,
      source_count: workflowReuseImproved ? 1 : 0,
      source_ids: workflowReuseImproved ? ["effect_kernel:learning"] : [],
      changed_fields: workflowReuseImproved ? ["learning_effect.workflow_reuse"] : [],
      reason: workflowReuseImproved
        ? "Workflow reuse improvement indicates replay-style workflow evidence contributed to the assisted run."
        : "No measured replay workflow contribution was available.",
    },
  };
}

function feedbackReviewMemoryIds(
  entries: AionisMemoryDecisionAuditReport["feedback_signal_review"]["positive_attributed_memories"],
): string[] {
  return entries.map((entry) => entry.memory_id);
}

function buildEffectFeedbackSignalSummary(
  review: AionisMemoryDecisionAuditReport["feedback_signal_review"] | null | undefined,
): AionisEffectReport["feedback_signal_summary"] {
  if (!review) {
    return {
      present: false,
      source: "not_supplied",
      authority_mutation: false,
      positive_attributed_memory_ids: [],
      weak_counter_signal_memory_ids: [],
      strong_counter_signal_memory_ids: [],
      relation_counter_signal_memory_ids: [],
      contradiction_warning_memory_ids: [],
      repeated_unattributed_memory_ids: [],
      repeated_unattributed_without_positive_memory_ids: [],
      read_only_signal_memory_ids: [],
      explanation: "No memory decision audit feedback signal review was supplied for this effect report.",
    };
  }
  return {
    present: review.present,
    source: "memory_decision_audit",
    authority_mutation: false,
    positive_attributed_memory_ids: feedbackReviewMemoryIds(review.positive_attributed_memories),
    weak_counter_signal_memory_ids: feedbackReviewMemoryIds(review.weak_counter_signal_memories),
    strong_counter_signal_memory_ids: feedbackReviewMemoryIds(review.strong_counter_signal_memories),
    relation_counter_signal_memory_ids: feedbackReviewMemoryIds(review.relation_counter_signal_memories),
    contradiction_warning_memory_ids: feedbackReviewMemoryIds(review.contradiction_warning_memories),
    repeated_unattributed_memory_ids: feedbackReviewMemoryIds(review.repeated_unattributed_memories),
    repeated_unattributed_without_positive_memory_ids: feedbackReviewMemoryIds(review.repeated_unattributed_without_positive_memories),
    read_only_signal_memory_ids: review.read_only_signal_memory_ids,
    explanation: review.present
      ? "Feedback signals were summarized from the memory decision audit for product measurement only; they do not mutate authority in the effect report."
      : review.reason,
  };
}

function buildEffectNeighborhoodDriftSummary(
  review: AionisMemoryDecisionAuditReport["neighborhood_drift_review"] | null | undefined,
): AionisEffectReport["neighborhood_drift_summary"] {
  if (!review) {
    return {
      present: false,
      source: "not_supplied",
      authority_mutation: false,
      signal_memory_ids: [],
      candidate_count: 0,
      explanation: "No memory decision audit neighborhood drift review was supplied for this effect report.",
    };
  }
  return {
    present: review.present,
    source: "memory_decision_audit",
    authority_mutation: false,
    signal_memory_ids: review.signal_memory_ids,
    candidate_count: review.candidate_count,
    explanation: review.present
      ? "Neighborhood drift was summarized from memory decision audit for product measurement only; it does not mutate memory authority in the effect report."
      : review.reason,
  };
}

function buildEffectConfidenceDecaySummary(
  review: AionisMemoryDecisionAuditReport["confidence_decay_candidate_review"] | null | undefined,
): AionisEffectReport["confidence_decay_summary"] {
  if (!review) {
    return {
      present: false,
      source: "not_supplied",
      authority_mutation: false,
      time_decay_age_threshold_days: 0,
      decay_candidate_memory_ids: [],
      candidate_from_time_decay_memory_ids: [],
      blocked_by_positive_attribution_memory_ids: [],
      supported_by_neighborhood_drift_memory_ids: [],
      explanation: "No memory decision audit confidence decay review was supplied for this effect report.",
    };
  }
  return {
    present: review.present,
    source: "memory_decision_audit",
    authority_mutation: false,
    time_decay_age_threshold_days: review.time_decay_age_threshold_days,
    decay_candidate_memory_ids: review.decay_candidate_memory_ids,
    candidate_from_time_decay_memory_ids: review.candidate_from_time_decay_memory_ids,
    blocked_by_positive_attribution_memory_ids: review.blocked_by_positive_attribution_memory_ids,
    supported_by_neighborhood_drift_memory_ids: review.supported_by_neighborhood_drift_memory_ids,
    explanation: review.present
      ? "Confidence decay shadow candidates were summarized from memory decision audit for product measurement only; this does not mutate memory authority."
      : review.reason,
  };
}

function effectExplanation(report: KernelEffectReport, direction: ProductImpactDirection): string {
  if (direction === "insufficient_evidence") {
    return "The effect evaluator does not have enough comparison evidence to claim product impact.";
  }
  if (direction === "positive") {
    return "History improved at least one focused Runtime capability without a measured regression.";
  }
  if (direction === "negative") {
    return "History produced a measured regression or failing focused Runtime capability.";
  }
  return `Measured effect is neutral with aggregate delta ${report.effect_delta}.`;
}

export function buildAionisEffectReport(args: BuildAionisEffectReportArgs): AionisEffectReport {
  const sufficientEvidence = args.comparison?.sufficient_evidence
    ?? (args.comparison?.mode === "single_run_history_impact" ? false : true);
  const direction = impactDirection({ report: args.report, sufficientEvidence });
  const changed = sufficientEvidence ? changedFields(args.report) : [];
  const trainingCandidates = buildTrainingCandidates({
    report: args.report,
    sufficientEvidence,
  });

  return parseAionisEffectReport({
    contract_version: "aionis_effect_report_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    task: asTask(args.task),
    comparison: {
      mode: args.comparison?.mode ?? "baseline_vs_aionis",
      baseline_run_id: args.comparison?.baseline_run_id ?? null,
      aionis_run_id: args.comparison?.aionis_run_id ?? null,
      sufficient_evidence: sufficientEvidence,
    },
    history_impact: {
      changed_future_behavior: changed.length > 0,
      impact_direction: direction,
      changed_fields: changed,
      explanation: effectExplanation(args.report, direction),
    },
    efficiency: {
      repeated_discovery_delta: -args.report.proof_summary.repeated_discovery_delta,
      useful_continuity_delta: args.report.proof_summary.continuity_guidance_improved ? -1 : 0,
      token_delta: null,
      context_size_delta: null,
      recovery_step_delta: null,
    },
    quality: {
      verifier_outcome: args.report.status === "pass" ? "pass" : args.report.status === "fail" ? "fail" : "unknown",
      recovered_fact_accuracy: args.report.kernel_scores.find((score) => score.capability_id === "continuity")?.status === "pass"
        ? "positive"
        : "unknown",
      workflow_reuse_outcome: args.report.proof_summary.workflow_reuse_improved
        ? "success"
        : "not_used",
      negative_transfer_detected: direction === "negative",
    },
    history_contributions: buildKernelEffectHistoryContributions(args.report),
    learning_effect: {
      promoted_workflow_ids: [],
      candidate_workflow_ids: [],
      demoted_memory_ids: [],
      blocked_authority_ids: args.report.proof_summary.weak_authority_blocked
        ? ["effect_kernel:learning_control"]
        : [],
      promotion_denied_reasons: args.report.next_actions,
    },
    forgetting_effect: {
      suppressed_memory_ids: [],
      archived_memory_ids: [],
      rehydrated_memory_ids: [],
      stale_memory_filtered_count: Math.max(0, args.report.proof_summary.stale_memory_delta),
    },
    feedback_signal_summary: buildEffectFeedbackSignalSummary(args.feedback_signal_review),
    neighborhood_drift_summary: buildEffectNeighborhoodDriftSummary(args.neighborhood_drift_review),
    confidence_decay_summary: buildEffectConfidenceDecaySummary(args.confidence_decay_review),
    training_candidates: trainingCandidates,
    evidence: {
      evidence_ids: compactStrings([
        ...(args.evidence_ids ?? []),
        ...args.report.kernel_scores.map((score) => `effect_kernel:${score.capability_id}`),
      ]),
      replay_run_ids: [],
      signal_summary_ids: args.report.kernel_scores.flatMap((score) => score.signals),
      promotion_quality_summary_ids: [],
    },
  });
}
