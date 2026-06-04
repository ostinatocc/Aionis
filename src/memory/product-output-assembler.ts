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
  parseAionisEffectReport,
  parseAionisGuidePacket,
  parseAionisLearningPacket,
  parseAionisMemoryPacket,
  type AionisEffectReport,
  type AionisGuidePacket,
  type AionisGuidanceAuthority,
  type AionisLearningPacket,
  type AionisMemoryDomain,
  type AionisMemoryPacket,
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
} from "./node-execution-surface.js";

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
type LearningCandidate = AionisLearningPacket["candidates"][number];
type LearningPosture = AionisLearningPacket["posture"]["recommended_learning_posture"];
type LearningAuthority = AionisLearningPacket["posture"]["authority"];

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
  }>;
  context_items?: unknown[];
  ranked?: Array<{ id: string; score?: number | null; activation?: number | null }>;
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
  const tier = args.tier ?? "";
  if (archiveRelocation.relocation_state === "cold_archive" || semanticForgetting.action === "archive" || tier === "archive") {
    return "archived";
  }
  if (semanticForgetting.action === "demote") return "demoted";
  if (semanticForgetting.action === "review") return "contested";
  if (lifecycle === "suppressed" || lifecycle === "disabled") return "suppressed";
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

function buildMemoryPacketEntries(args: BuildAionisMemoryPacketArgs): MemoryPacketEntry[] {
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
  return args.nodes.slice(0, 32).map((node) => {
    const slots = asRecord(node.slots);
    const contextItem = contextItems.get(node.id) ?? null;
    const layer = sourceLayer({ type: node.type, slots, contextItem });
    const domain = memoryDomain({ type: node.type, slots, contextItem });
    const confidence = clampConfidence(node.confidence, 0.5);
    const salience = clampConfidence(rankedScore.get(node.id) ?? node.salience, 0.5);
    const contractTrust = resolveNodeExecutionContractTrust({ slots }) ?? contractTrustValue(contextItem?.contract_trust);
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
      scope_hint: memoryScopeHint({ domain, sourceLayer: layer }),
    };
  });
}

function memoryFamily(entries: MemoryPacketEntry[]): AionisMemoryPacket["memory_family"] {
  if (entries.length === 0) return "empty";
  const domains = new Set(entries.map((entry) => entry.domain));
  if (domains.size > 1) return "mixed";
  return domains.has("execution") ? "execution" : "general_cognitive";
}

function buildMemoryEvidenceTrail(entries: MemoryPacketEntry[]): AionisMemoryPacket["evidence_trail"] {
  return entries.flatMap((entry) => {
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
  }).slice(0, 96);
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
  const entries = buildMemoryPacketEntries(args);
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
    evidence_trail: buildMemoryEvidenceTrail(entries),
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

  return parseAionisGuidePacket({
    contract_version: "aionis_guide_packet_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor: args.actor,
    task: asTask(args.task),
    recovered_state: {
      state_summary:
        args.execution_summary?.continuity_snapshot_summary.recommended_action
        ?? args.execution_summary?.collaboration_summary.next_action
        ?? args.planning.history_impact_summary.primary_reason
        ?? null,
      resumable:
        args.planning.continuity_carrier_summary.total_count > 0
        || args.execution_summary?.continuity_snapshot_summary.snapshot_mode === "packet_backed",
      handoff_ids: [],
      execution_state_revision: null,
      target_files: targetFiles,
      acceptance_checks: acceptanceChecks,
    },
    proven_facts: [],
    guidance: {
      workflow_candidates: buildWorkflowCandidates(args.planning),
      tool_preferences: buildToolPreferences(args.planning, authority),
    },
    history_contributions: buildGuideHistoryContributions(args.planning),
    memory_lifecycle: {
      used_memory_ids: usedMemoryIds,
      suppressed_memory_ids: args.planning.forgetting_summary.suppressed_pattern_anchor_ids,
      archived_memory_ids: [],
      rehydration_hints: rehydrationIds.map((memoryId) => ({
        memory_id: memoryId,
        reason: "Differential rehydration candidate from the planning summary.",
        required: args.planning.action_intelligence_pre_action_gate?.requires_rehydration === true,
      })),
    },
    risk: {
      negative_transfer_risk: negativeTransferRisk(args.planning),
      blocked_authority_count:
        args.planning.authority_visibility_summary.authoritative_blocked_count
        + authorityVisibilityStableBlockedCount,
      stale_memory_count: args.planning.forgetting_summary.stale_signal_count,
      provider_or_protocol_quarantine: false,
      reasons: buildRiskReasons(args.planning, args.execution_summary),
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
