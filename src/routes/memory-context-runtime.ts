import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import { buildRecallObservability, collectRecallTrajectoryUriLinks } from "../app/recall-observability.js";
import { applyContextOptimizationProfile } from "../app/context-optimization-profile.js";
import {
  buildAssemblySummary,
  buildExecutionMemorySummaryBundle,
  buildExecutionSummarySurface,
  buildExecutionTreeEffectSummary,
  buildPlanningSummary,
  summarizeActionRecallPacketSurface,
  summarizeWorkflowSignalSurface,
  summarizeWorkflowLifecycleSurface,
  summarizeWorkflowMaintenanceSurface,
  summarizePatternLifecycleSurface,
  summarizePatternMaintenanceSurface,
  summarizePatternSignalSurface,
} from "../app/planning-summary.js";
import { createEmbeddingSurfacePolicy, type EmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { buildLayeredContextCostSignals } from "../memory/cost-signals.js";
import { buildAionisGuidePacket } from "../memory/product-output/guide-packet.js";
import { buildAionisLearningPacket } from "../memory/product-output/learning-effect.js";
import {
  buildDelegationRecordLookup,
  findDelegationRecordNodeRowsLite,
} from "../memory/delegation-records-surface.js";
import { buildDelegationLearningSliceLite } from "../memory/delegation-learning.js";
import { buildExperienceIntelligenceResponse } from "../memory/experience-intelligence.js";
import { memoryRecallParsed, type RecallAuth } from "../memory/recall.js";
import {
  hasExplicitRuntimeVerification,
  runtimeEntropyRecallDefaultsApplication,
  type RuntimeEntropyRecallDefaultsApplicationV1,
  runtimeEntropyVerifierDefaultsApplication,
  type RuntimeEntropyVerifierDefaultsApplicationV1,
} from "../memory/runtime-entropy-route-defaults.js";
import {
  ContextAssembleRequest,
  ExperienceIntelligenceRequest,
  MemoryRecallRequest,
  MemoryRecallTextRequest,
  PlanningContextRequest,
  type ExperienceIntelligenceResponse,
  type StaticContextBlock,
} from "../memory/schemas.js";
import {
  runRuntimeVerificationSurfaceV1,
  type RuntimeVerificationSurfaceV1,
  type ExecutionPacketAssemblyMode,
  type ExecutionPacketV1,
  type ExecutionStateV1,
  type ExecutionTreeV1,
} from "../execution/index.js";
import { buildExecutionEvidenceContextLite } from "../execution/evidence-context.js";
import {
  buildExecutionContinuityContext,
  executionContinuityToStaticBlocks,
  executionPacketToStaticBlocks,
  executionTreeToStaticBlocks,
  mergeExecutionPacketStaticBlocks,
  resolveExecutionKernelContext,
} from "../kernel/execution-continuity-kernel.js";
import { buildExecutionMemoryIntrospectionLite } from "../memory/execution-introspection.js";
import { evaluateRules } from "../memory/rules-evaluate.js";
import { selectTools } from "../memory/tools-select.js";
import { estimateTokenCountFromText } from "../memory/context.js";
import { assembleLayeredContext, extractPlannerPacketSurface } from "../memory/context-orchestrator.js";
import {
  augmentTrajectoryAwareRequest,
} from "../memory/trajectory-compile-runtime.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import { HttpError } from "../util/http.js";
import { normalizeText } from "../util/normalize.js";
import { redactPII } from "../util/redaction.js";
import type { Env } from "../config.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";
import type { AionisGuidePacket } from "../memory/product-output-contract.js";

type ContextRuntimeRequest = FastifyRequest<{ Body: unknown }>;
type ContextRuntimeSurface = "recall_text" | "planning_context" | "context_assemble";
type ContextRuntimeRequestKind = ContextRuntimeSurface;
export type MemoryPlanningContextRouteService = {
  assemble: (
    req: ContextRuntimeRequest,
    reply: FastifyReply,
    options?: {
      body?: unknown;
      principal?: AuthPrincipal | null;
      principalAlreadyChecked?: boolean;
    },
  ) => Promise<unknown>;
};
type ExecutionContinuityStaticBlockLike = ReturnType<typeof executionPacketToStaticBlocks>[number];
type ContextRuntimeRecallKnobs = {
  limit: number;
  neighborhood_hops: 1 | 2;
  max_nodes: number;
  max_edges: number;
  ranked_limit: number;
  min_edge_weight: number;
  min_edge_confidence: number;
};

type RecallProfileLike = {
  profile: string;
  source: string;
};

type ExplicitRecallModeLike = {
  mode: string | null;
  profile: string;
  defaults: Record<string, unknown>;
  applied: boolean;
  reason: string;
  source: string;
};

type ClassAwareRecallProfileLike = {
  profile: string;
  defaults: Record<string, unknown>;
  enabled: boolean;
  applied: boolean;
  reason: string;
  source: string;
  workload_class: string | null;
  signals: string[];
};

type RecallStrategyResolutionLike = {
  strategy: string;
  defaults: Record<string, unknown>;
  applied: boolean;
};

type RecallAdaptiveProfileLike = {
  profile: string;
  defaults: Record<string, unknown>;
  applied: boolean;
  reason: string;
};

type RecallAdaptiveHardCapLike = {
  defaults: Record<string, unknown>;
  applied: boolean;
  reason: string;
};

type RecallTextEmbedBatcherLike = {
  stats: () => unknown;
};

type ParsedMemoryRecall = ReturnType<typeof MemoryRecallRequest.parse>;
type ParsedMemoryRecallText = ReturnType<typeof MemoryRecallTextRequest.parse>;
type ParsedPlanningContext = ReturnType<typeof PlanningContextRequest.parse>;
type ParsedContextAssemble = ReturnType<typeof ContextAssembleRequest.parse>;
type ParsedContextRuntimeQuery = ParsedMemoryRecallText | ParsedPlanningContext | ParsedContextAssemble;
type MemoryRecallOutput = Awaited<ReturnType<typeof memoryRecallParsed>>;
type RulesEvaluationLike = Awaited<ReturnType<typeof evaluateRules>>;
type ToolSelectionLike = Awaited<ReturnType<typeof selectTools>>;
type RecallRouteRules = Pick<
  RulesEvaluationLike,
  "scope" | "considered" | "matched" | "skipped_invalid_then" | "invalid_then_sample" | "applied"
>;
type RecallTextRouteOutput = MemoryRecallOutput & {
  rules?: RecallRouteRules;
};
type PlanningContextRouteOutput = {
  recall: MemoryRecallOutput;
  rules: RulesEvaluationLike;
  tools: ToolSelectionLike | null;
};
type ContextAssembleRouteOutput = {
  recall: MemoryRecallOutput;
  rules: RulesEvaluationLike | null;
  tools: ToolSelectionLike | null;
};
type ContextRuntimeLiteStoreLike =
  LiteWriteStore;
type MemoryRecallRuntimeOptions = NonNullable<Parameters<typeof memoryRecallParsed>[6]>;
type ExecutionEvidenceContextLite = Awaited<ReturnType<typeof buildExecutionEvidenceContextLite>>;
type RecallEmbedResult = Awaited<
  ReturnType<
    (provider: EmbeddingProvider, queryText: string) => Promise<{
      vec: number[];
      ms: number;
      cache_hit: boolean;
      singleflight_join: boolean;
      queue_wait_ms: number;
      batch_size: number;
    }>
  >
>;

function normalizeStaticContextBlocks(
  blocks: StaticContextBlock[] | undefined,
): ExecutionContinuityStaticBlockLike[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((block) => ({
    id: block.id,
    title: block.title ?? block.id,
    content: block.content,
    tags: Array.isArray(block.tags) ? block.tags : [],
    intents: Array.isArray(block.intents) ? block.intents : [],
    priority: typeof block.priority === "number" ? block.priority : 50,
    always_include: block.always_include === true,
  }));
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactRouteStrings(values: Array<string | null | undefined>, max = 32): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

function shortRouteText(value: unknown, maxChars: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function routeRecordArray(root: Record<string, unknown> | null, key: string): Array<Record<string, unknown>> {
  const value = root?.[key];
  if (!Array.isArray(value)) return [];
  return value
    .map(asObjectRecord)
    .filter((entry): entry is Record<string, unknown> => !!entry);
}

function executionEvidenceEntryText(entry: Record<string, unknown>, maxChars = 180): string | null {
  return shortRouteText(
    entry.summary
      ?? entry.observation
      ?? entry.action
      ?? entry.title
      ?? entry.diagnostic_note,
    maxChars,
  );
}

function executionEvidenceTraceSuffix(entry: Record<string, unknown>): string {
  const count = typeof entry.supporting_raw_trace_count === "number"
    ? entry.supporting_raw_trace_count
    : Array.isArray(entry.supporting_raw_trace)
      ? entry.supporting_raw_trace.length
      : null;
  if (count === null) return "";
  return ` raw_trace=${count}`;
}

function renderExecutionEvidenceGuideLine(
  label: string,
  entry: Record<string, unknown>,
  maxChars = 180,
): string | null {
  const text = executionEvidenceEntryText(entry, maxChars);
  if (!text) return null;
  return `${label}: ${text}${executionEvidenceTraceSuffix(entry)}`;
}

function executionEvidenceGuideSurfaces(context: ExecutionEvidenceContextLite | null): {
  useNow: string[];
  doNotUse: string[];
  riskReasons: string[];
  historyUsed: boolean;
  controlsNegativeTransfer: boolean;
} {
  const root = asObjectRecord(context);
  const tree = asObjectRecord(root?.tree);
  if (!root || tree?.present !== true) {
    return {
      useNow: [],
      doNotUse: [],
      riskReasons: [],
      historyUsed: false,
      controlsNegativeTransfer: false,
    };
  }

  const activePath = asObjectRecord(root.current_active_path);
  const activeCompressed = routeRecordArray(activePath, "compressed_state");
  const activeRaw = routeRecordArray(activePath, "raw_state");
  const passedSolutions = routeRecordArray(root, "passed_solutions");
  const failedBranches = routeRecordArray(root, "failed_branches");

  const currentLines = compactRouteStrings([
    ...activeCompressed.slice(-1).map((entry) => renderExecutionEvidenceGuideLine("Current active path", entry)),
    ...activeRaw.slice(-1).map((entry) => renderExecutionEvidenceGuideLine("Current raw step", entry)),
  ], 2);
  const passedLines = compactRouteStrings(
    passedSolutions.slice(0, 3).map((entry) => renderExecutionEvidenceGuideLine("Passed solution", entry)),
    3,
  );
  const failedLines = compactRouteStrings(
    failedBranches.slice(0, 4).map((entry) => renderExecutionEvidenceGuideLine("Failed branch to avoid", entry)),
    4,
  );

  return {
    useNow: compactRouteStrings([
      ...passedLines,
      ...currentLines,
    ], 5),
    doNotUse: failedLines,
    riskReasons: failedLines.length > 0
      ? ["execution_failed_branches_must_remain_avoidance_context"]
      : [],
    historyUsed: currentLines.length > 0 || passedLines.length > 0 || failedLines.length > 0,
    controlsNegativeTransfer: failedLines.length > 0,
  };
}

function guidePostureWithExecutionEvidence(
  current: AionisGuidePacket["guide_brief"]["recommended_posture"],
  surfaces: ReturnType<typeof executionEvidenceGuideSurfaces>,
): AionisGuidePacket["guide_brief"]["recommended_posture"] {
  if (!surfaces.historyUsed) return current;
  if (current === "ignore_history") return "reuse_supported_history";
  return current;
}

function guideAuthorityWithExecutionEvidence(
  current: AionisGuidePacket["guide_brief"]["authority"],
  surfaces: ReturnType<typeof executionEvidenceGuideSurfaces>,
): AionisGuidePacket["guide_brief"]["authority"] {
  if (!surfaces.historyUsed) return current;
  if (current === "none" || current === "candidate") return "advisory";
  return current;
}

function augmentGuidePacketWithExecutionEvidence(
  guide: AionisGuidePacket,
  context: ExecutionEvidenceContextLite | null,
): AionisGuidePacket {
  const surfaces = executionEvidenceGuideSurfaces(context);
  if (!surfaces.historyUsed) return guide;
  return {
    ...guide,
    guide_brief: {
      ...guide.guide_brief,
      history_used: true,
      actionable_history_used: true,
      recommended_posture: guidePostureWithExecutionEvidence(guide.guide_brief.recommended_posture, surfaces),
      authority: guideAuthorityWithExecutionEvidence(guide.guide_brief.authority, surfaces),
      use_now: compactRouteStrings([
        ...surfaces.useNow,
        ...guide.guide_brief.use_now,
      ], 8),
      do_not_use: compactRouteStrings([
        ...surfaces.doNotUse,
        ...guide.guide_brief.do_not_use,
      ], 8),
      expected_product_effects: {
        ...guide.guide_brief.expected_product_effects,
        reduces_repeated_discovery:
          guide.guide_brief.expected_product_effects.reduces_repeated_discovery
          || surfaces.useNow.length > 0,
        reduces_context_replay:
          guide.guide_brief.expected_product_effects.reduces_context_replay
          || surfaces.useNow.length > 0,
        controls_negative_transfer:
          guide.guide_brief.expected_product_effects.controls_negative_transfer
          || surfaces.controlsNegativeTransfer,
        reason: compactRouteStrings([
          guide.guide_brief.expected_product_effects.reason,
          surfaces.useNow.length > 0
            ? "Execution evidence context provides current or passed execution state without replaying the full trajectory."
            : null,
          surfaces.controlsNegativeTransfer
            ? "Execution evidence context separates failed branches as explicit avoidance context."
            : null,
        ], 4).join(" "),
      },
    },
    risk: {
      ...guide.risk,
      negative_transfer_risk:
        guide.risk.negative_transfer_risk === "high" || surfaces.controlsNegativeTransfer
          ? guide.risk.negative_transfer_risk === "high" ? "high" : "medium"
          : guide.risk.negative_transfer_risk,
      reasons: compactRouteStrings([
        ...surfaces.riskReasons,
        ...guide.risk.reasons,
      ], 5),
    },
    source_map: {
      ...guide.source_map,
      internal_surfaces_used: compactRouteStrings([
        ...guide.source_map.internal_surfaces_used,
        "execution_evidence_context",
      ], 32),
    },
  };
}

function promptSection(promptText: unknown, heading: string): string | null {
  if (typeof promptText !== "string" || promptText.trim().length === 0) return null;
  const lines = promptText.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  const out: string[] = [heading];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Z_]+$/.test(line.trim())) break;
    out.push(line);
  }
  const text = out.join("\n").trim();
  return text.length > heading.length ? text : null;
}

function executionEvidenceBlockSuffix(context: ExecutionEvidenceContextLite): string {
  const tree = asObjectRecord(asObjectRecord(context)?.tree);
  const raw = String(tree?.tree_id ?? tree?.scope ?? "inline-tree").trim();
  const normalized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "inline-tree").slice(0, 70);
}

function executionEvidenceContextToStaticBlocks(
  context: ExecutionEvidenceContextLite | null,
): ExecutionContinuityStaticBlockLike[] {
  const root = asObjectRecord(context);
  const tree = asObjectRecord(root?.tree);
  if (!root || tree?.present !== true) return [];
  const suffix = executionEvidenceBlockSuffix(context!);
  const activePassedContent = compactRouteStrings([
    promptSection(root.prompt_text, "CURRENT_ACTIVE_PATH"),
    promptSection(root.prompt_text, "PASSED_SOLUTIONS"),
    promptSection(root.prompt_text, "EPISODIC_TRACES"),
  ], 3).join("\n\n");
  const failedContent = promptSection(root.prompt_text, "FAILED_BRANCHES");
  const blocks: ExecutionContinuityStaticBlockLike[] = [];
  if (activePassedContent) {
    blocks.push({
      id: `execution-evidence-${suffix}-active-passed`,
      title: "Execution Evidence Active And Passed",
      content: activePassedContent,
      tags: ["execution-evidence", "current-active-path", "passed-solutions", "episodic-traces", "continuity"],
      intents: ["resume", "continue", "review", "evidence"],
      priority: 100,
      always_include: true,
    });
  }
  if (failedContent && !/- none\b/.test(failedContent)) {
    blocks.push({
      id: `execution-evidence-${suffix}-failed-branches`,
      title: "Execution Evidence Failed Branches",
      content: [
        "branch_role=failed_branch; use_for_next_action=false; use_as_avoidance_hint=true",
        failedContent,
      ].join("\n"),
      tags: ["execution-evidence", "failed-branch", "avoidance", "continuity"],
      intents: ["avoid", "revise", "review"],
      priority: 45,
      always_include: false,
    });
  }
  return blocks;
}

function buildExecutionKernelResponse(
  sourceMode: ExecutionPacketAssemblyMode,
  parsed: {
    execution_packet_v1?: ExecutionPacketV1;
    execution_state_v1?: ExecutionStateV1;
  },
  runtimeVerification?: RuntimeVerificationSurfaceV1 | null,
  plannerSurface?: {
    action_recall_packet?: unknown;
    candidate_workflows?: unknown;
    pattern_signals?: unknown;
    workflow_signals?: unknown;
    recommended_workflows?: unknown;
  },
  executionTreeEffectSummary?: unknown,
) {
  const summaryBundle = buildExecutionMemorySummaryBundle(plannerSurface ?? {});
  return {
    packet_source_mode: sourceMode,
    state_first_assembly: sourceMode === "state_first",
    execution_packet_v1_present: !!parsed.execution_packet_v1,
    execution_state_v1_present: !!parsed.execution_state_v1,
    ...(runtimeVerification ? { runtime_verification: runtimeVerification } : {}),
    ...(executionTreeEffectSummary ? { execution_tree_effect_summary: executionTreeEffectSummary } : {}),
    ...summaryBundle,
  };
}

async function loadPersistedDelegationRecordsForContext(args: {
  liteWriteStore: ContextRuntimeLiteStoreLike;
  scope: string;
  runId?: string | null;
  executionPacket?: ExecutionPacketV1 | null;
  executionState?: ExecutionStateV1 | null;
  consumerAgentId?: string | null;
  consumerTeamId?: string | null;
}): Promise<LiteFindNodeRow[]> {
  const lookup = buildDelegationRecordLookup({
    run_id: args.runId,
    execution_packet: args.executionPacket,
    execution_state: args.executionState,
  });
  return findDelegationRecordNodeRowsLite({
    liteWriteStore: args.liteWriteStore,
    scope: args.scope,
    consumerAgentId: args.consumerAgentId ?? null,
    consumerTeamId: args.consumerTeamId ?? null,
    lookup,
    limit: 4,
  });
}

function buildPlannerPacketResponseSurface(
  plannerSurface: ReturnType<typeof extractPlannerPacketSurface>,
  packetAssembly?: {
    packet_source_mode: string | null;
    state_first_assembly: boolean | null;
    execution_packet_v1_present: boolean | null;
    execution_state_v1_present: boolean | null;
  },
  extras?: {
    tools?: unknown;
    cost_signals?: unknown;
    execution_packet?: unknown;
    execution_artifacts?: unknown;
    execution_evidence?: unknown;
    delegation_records?: unknown;
    execution_tree?: ExecutionTreeV1 | null;
    layered_context?: unknown;
  },
) {
  return {
    planner_packet: plannerSurface.planner_packet,
    pattern_signals: plannerSurface.pattern_signals,
    workflow_signals: plannerSurface.workflow_signals,
    execution_summary: buildExecutionSummarySurface({
      planner_packet: plannerSurface.planner_packet,
      surface: plannerSurface,
      packet_assembly: packetAssembly ?? null,
      tools: extras?.tools,
      cost_signals: extras?.cost_signals,
      execution_packet: extras?.execution_packet,
      execution_artifacts: extras?.execution_artifacts,
      execution_evidence: extras?.execution_evidence,
      delegation_records: extras?.delegation_records,
      execution_tree: extras?.execution_tree ?? null,
      layered_context: extras?.layered_context,
    }),
  };
}

function buildAionisGuidePacketForContextRoute(args: {
  tenantId: string;
  scope: string;
  surface: "planning_context" | "context_assemble";
  parsed: ParsedPlanningContext | ParsedContextAssemble;
  summary: Parameters<typeof buildAionisGuidePacket>[0]["planning"];
  executionEvidenceContext?: ExecutionEvidenceContextLite | null;
}) {
  const guide = buildAionisGuidePacket({
    tenant_id: args.tenantId,
    scope: args.scope,
    actor: {
      consumer_agent_id: args.parsed.consumer_agent_id ?? null,
      consumer_team_id: args.parsed.consumer_team_id ?? null,
      producer_agent_ids: [],
    },
    task: {
      task_id: null,
      run_id: args.parsed.run_id ?? null,
      task_signature: args.summary.continuity_guidance?.workflow_signature ?? null,
      task_family: args.summary.continuity_guidance?.task_family ?? null,
    },
    planning: args.summary,
    source_map: {
      routes_used: [
        args.surface === "planning_context"
          ? "/v1/memory/planning/context"
          : "/v1/memory/context/assemble",
      ],
    },
  });
  return augmentGuidePacketWithExecutionEvidence(guide, args.executionEvidenceContext ?? null);
}

function buildAionisLearningPacketForContextRoute(args: {
  tenantId: string;
  scope: string;
  surface: "planning_context" | "context_assemble";
  parsed: ParsedPlanningContext | ParsedContextAssemble;
  summary: Parameters<typeof buildAionisLearningPacket>[0]["planning"];
}) {
  return buildAionisLearningPacket({
    tenant_id: args.tenantId,
    scope: args.scope,
    actor: {
      consumer_agent_id: args.parsed.consumer_agent_id ?? null,
      consumer_team_id: args.parsed.consumer_team_id ?? null,
      producer_agent_ids: [],
    },
    task: {
      task_id: null,
      run_id: args.parsed.run_id ?? null,
      task_signature: args.summary.continuity_guidance?.workflow_signature ?? null,
      task_family: args.summary.continuity_guidance?.task_family ?? null,
    },
    planning: args.summary,
    source_map: {
      routes_used: [
        args.surface === "planning_context"
          ? "/v1/memory/planning/context"
          : "/v1/memory/context/assemble",
      ],
    },
  });
}

function attachRecallRules(base: MemoryRecallOutput, rulesRes: RulesEvaluationLike): RecallTextRouteOutput {
  return {
    ...base,
    rules: {
      scope: rulesRes.scope,
      considered: rulesRes.considered,
      matched: rulesRes.matched,
      skipped_invalid_then: rulesRes.skipped_invalid_then,
      invalid_then_sample: rulesRes.invalid_then_sample,
      applied: rulesRes.applied,
    },
  };
}

function toRecallKnobs(
  parsed: ParsedMemoryRecallText | ParsedPlanningContext | ParsedContextAssemble | ParsedMemoryRecall,
): ContextRuntimeRecallKnobs {
  return {
    limit: parsed.limit,
    neighborhood_hops: parsed.neighborhood_hops as 1 | 2,
    max_nodes: parsed.max_nodes,
    max_edges: parsed.max_edges,
    ranked_limit: parsed.ranked_limit,
    min_edge_weight: parsed.min_edge_weight,
    min_edge_confidence: parsed.min_edge_confidence,
  };
}

function applyDefaultContextBudget<T extends { context_token_budget?: number; context_char_budget?: number }>(
  parsed: T,
  defaultTokenBudget: number,
  parse: (input: unknown) => T,
): { parsed: T; contextBudgetDefaultApplied: boolean } {
  if (
    parsed.context_token_budget === undefined
    && parsed.context_char_budget === undefined
    && defaultTokenBudget > 0
  ) {
    return {
      parsed: parse({
        ...parsed,
        context_token_budget: defaultTokenBudget,
      }),
      contextBudgetDefaultApplied: true,
    };
  }
  return {
    parsed,
    contextBudgetDefaultApplied: false,
  };
}

function applyAdaptiveRecallTuning<
  T extends ParsedMemoryRecallText | ParsedPlanningContext | ParsedContextAssemble | ParsedMemoryRecall,
>(args: {
  parsed: T;
  parse: (input: unknown) => T;
  profile: string;
  waitMs: number;
  explicitRecallKnobs: boolean;
  resolveAdaptiveRecallProfile: (profile: string, waitMs: number, explicitRecallKnobs: boolean) => RecallAdaptiveProfileLike;
  resolveAdaptiveRecallHardCap: (
    knobs: ContextRuntimeRecallKnobs,
    waitMs: number,
    explicitRecallKnobs: boolean,
  ) => RecallAdaptiveHardCapLike;
}): {
  parsed: T;
  adaptiveProfile: RecallAdaptiveProfileLike;
  adaptiveHardCap: RecallAdaptiveHardCapLike;
} {
  const {
    parsed: initialParsed,
    parse,
    profile,
    waitMs,
    explicitRecallKnobs,
    resolveAdaptiveRecallProfile,
    resolveAdaptiveRecallHardCap,
  } = args;
  const adaptiveProfile = resolveAdaptiveRecallProfile(profile, waitMs, explicitRecallKnobs);
  let parsed = initialParsed;
  if (adaptiveProfile.applied) {
    parsed = parse({ ...parsed, ...adaptiveProfile.defaults });
  }
  const adaptiveHardCap = resolveAdaptiveRecallHardCap(
    toRecallKnobs(parsed),
    waitMs,
    explicitRecallKnobs,
  );
  if (adaptiveHardCap.applied) {
    parsed = parse({ ...parsed, ...adaptiveHardCap.defaults });
  }
  return {
    parsed,
    adaptiveProfile,
    adaptiveHardCap,
  };
}

function buildRecallRequestFromQuery(args: {
  scope: string;
  queryEmbedding: number[];
  parsed: ParsedMemoryRecallText | ParsedPlanningContext | ParsedContextAssemble;
  extras?: Partial<Pick<ParsedMemoryRecall, "rules_context" | "rules_include_shadow" | "rules_limit" | "structured_recall_context">>;
}): ParsedMemoryRecall {
  const { scope, queryEmbedding, parsed, extras } = args;
  return MemoryRecallRequest.parse({
    tenant_id: parsed.tenant_id,
    scope,
    query_text: parsed.query_text,
    recall_strategy: parsed.recall_strategy,
    query_embedding: queryEmbedding,
    consumer_agent_id: parsed.consumer_agent_id,
    consumer_team_id: parsed.consumer_team_id,
    limit: parsed.limit,
    neighborhood_hops: parsed.neighborhood_hops,
    return_debug: parsed.return_debug,
    include_embeddings: parsed.include_embeddings,
    include_meta: parsed.include_meta,
    include_slots: parsed.include_slots,
    include_slots_preview: parsed.include_slots_preview,
    slots_preview_keys: parsed.slots_preview_keys,
    max_nodes: parsed.max_nodes,
    max_edges: parsed.max_edges,
    ranked_limit: parsed.ranked_limit,
    min_edge_weight: parsed.min_edge_weight,
    min_edge_confidence: parsed.min_edge_confidence,
    context_token_budget: parsed.context_token_budget,
    context_char_budget: parsed.context_char_budget,
    context_compaction_profile: parsed.context_compaction_profile,
    memory_layer_preference: parsed.memory_layer_preference,
    structured_recall_context: "structured_recall_context" in parsed
      ? parsed.structured_recall_context
      : "context" in parsed
        ? parsed.context
        : undefined,
    ...extras,
  });
}

export function registerMemoryContextRuntimeRoutes(args: {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
  embeddingSurfacePolicy?: EmbeddingSurfacePolicy;
  liteWriteStore: ContextRuntimeLiteStoreLike;
  liteRecallAccess: RecallStoreAccess;
  recallTextEmbedBatcher: unknown;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: ContextRuntimeRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "recall" | "debug_embeddings") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "recall" | "debug_embeddings", tenantId: string) => Promise<void>;
  enforceRecallTextEmbedQuota: (req: FastifyRequest, reply: FastifyReply, tenantId: string) => Promise<void>;
  buildRecallAuth: (req: FastifyRequest, allowEmbeddings: boolean) => RecallAuth;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: "recall") => Promise<InflightGateToken>;
  hasExplicitRecallKnobs: (body: unknown) => boolean;
  resolveRecallProfile: (endpoint: "recall_text", tenantId: string) => RecallProfileLike;
  resolveExplicitRecallMode: (body: unknown, baseProfile: string, explicitRecallKnobs: boolean) => ExplicitRecallModeLike;
  resolveClassAwareRecallProfile: (
    endpoint: ContextRuntimeSurface,
    body: unknown,
    baseProfile: string,
    explicitRecallKnobs: boolean,
  ) => ClassAwareRecallProfileLike;
  withRecallProfileDefaults: (body: unknown, defaults: Record<string, unknown>) => Record<string, unknown>;
  resolveRecallStrategy: (body: unknown, explicitRecallKnobs: boolean) => RecallStrategyResolutionLike;
  resolveAdaptiveRecallProfile: (profile: string, waitMs: number, explicitRecallKnobs: boolean) => RecallAdaptiveProfileLike;
  resolveAdaptiveRecallHardCap: (
    knobs: ContextRuntimeRecallKnobs,
    waitMs: number,
    explicitRecallKnobs: boolean,
  ) => RecallAdaptiveHardCapLike;
  inferRecallStrategyFromKnobs: (knobs: ContextRuntimeRecallKnobs) => unknown;
  buildRecallTrajectory: (args: unknown) => unknown;
  embedRecallTextQuery: (provider: EmbeddingProvider, queryText: string) => Promise<{
    vec: number[];
    ms: number;
    cache_hit: boolean;
    singleflight_join: boolean;
    queue_wait_ms: number;
    batch_size: number;
  }>;
  mapRecallTextEmbeddingError: (err: unknown) => {
    statusCode: number;
    code: string;
    message: string;
    retry_after_sec?: number;
    details?: Record<string, unknown>;
  };
  recordContextAssemblyTelemetryBestEffort: (args: {
    req: FastifyRequest;
    tenant_id: string;
    scope: string;
    endpoint: "planning_context" | "context_assemble";
    latency_ms: number;
    layered_output: boolean;
    layered_context: unknown;
    selected_memory_layers?: string[];
    selection_policy?: {
      name?: string | null;
      source?: string | null;
      trust_anchor_layers?: string[];
      requested_allowed_layers?: string[];
    } | null;
  }) => Promise<void>;
}) {
  const {
    app,
    env,
    embedder,
    embeddingSurfacePolicy: embeddingSurfacePolicyArg,
    liteWriteStore,
    liteRecallAccess,
    recallTextEmbedBatcher,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    enforceRecallTextEmbedQuota,
    buildRecallAuth,
    tenantFromBody,
    acquireInflightSlot,
    hasExplicitRecallKnobs,
    resolveRecallProfile,
    resolveExplicitRecallMode,
    resolveClassAwareRecallProfile,
    withRecallProfileDefaults,
    resolveRecallStrategy,
    resolveAdaptiveRecallProfile,
    resolveAdaptiveRecallHardCap,
    inferRecallStrategyFromKnobs,
    buildRecallTrajectory,
    embedRecallTextQuery,
    mapRecallTextEmbeddingError,
    recordContextAssemblyTelemetryBestEffort,
  } = args;
  assertLocalStoreRuntimeEdition(env, "local-store memory-context-runtime routes");
  const embeddingSurfacePolicy =
    embeddingSurfacePolicyArg ?? createEmbeddingSurfacePolicy({ providerConfigured: !!embedder });
  const recallTextEmbedBatcherStats = () =>
    recallTextEmbedBatcher && typeof recallTextEmbedBatcher === "object" && "stats" in recallTextEmbedBatcher
    && typeof recallTextEmbedBatcher.stats === "function"
      ? (recallTextEmbedBatcher as RecallTextEmbedBatcherLike).stats()
      : null;
  const resolveSurfaceEmbedder = (
    surface: ContextRuntimeSurface,
  ) => {
    if (!embeddingSurfacePolicy.isEnabled(surface)) {
      throw new HttpError(409, "embedding_surface_disabled", `embedding surface disabled: ${surface}`, {
        contract: "error_v1",
        surface,
      });
    }
    if (!embedder) {
      throw new HttpError(400, "no_embedding_provider", `Configure EMBEDDING_PROVIDER to use ${surface}.`, {
        contract: "error_v1",
        surface,
      });
    }
    return embedder;
  };
  const allowUnsafeDropTrustAnchors = (req: FastifyRequest): boolean => {
    if (env.APP_ENV === "prod") return false;
    const raw = String(req.headers["x-aionis-internal-allow-drop-trust-anchors"] ?? "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  };
  const allowInternalL4Serving = (req: FastifyRequest): boolean => {
    if (env.APP_ENV === "prod") return false;
    const raw = String(req.headers["x-aionis-internal-allow-l4-serving"] ?? "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  };
  const allowLayerPolicyRetrievalFiltering = (req: FastifyRequest): boolean => {
    if (env.APP_ENV === "prod") return false;
    const raw = String(req.headers["x-aionis-internal-apply-layer-policy-to-retrieval"] ?? "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  };
  const runRecallEmbedding = async (args: {
    endpoint: ContextRuntimeSurface;
    req: ContextRuntimeRequest;
    reply: FastifyReply;
    provider: EmbeddingProvider;
    scope: string;
    tenantId: string;
    queryText: string;
  }): Promise<RecallEmbedResult> => {
    const { endpoint, req, reply, provider, scope, tenantId, queryText } = args;
    try {
      return await embedRecallTextQuery(provider, queryText);
    } catch (err: unknown) {
      const mapped = mapRecallTextEmbeddingError(err);
      if (mapped.retry_after_sec) reply.header("retry-after", mapped.retry_after_sec);
      req.log.warn(
        {
          [endpoint]: {
            scope,
            tenant_id: tenantId,
            embedding_provider: provider.name,
            query_len: queryText.length,
            mapped_error: mapped.code,
            mapped_status: mapped.statusCode,
            err_message: err instanceof Error ? err.message : String(err),
          },
        },
        `${endpoint} embedding failed`,
      );
      throw new HttpError(mapped.statusCode, mapped.code, mapped.message, mapped.details);
    }
  };
  const prepareSurfaceRequest = async <TParsed extends ParsedContextRuntimeQuery>(args: {
    req: ContextRuntimeRequest;
    requestKind: ContextRuntimeRequestKind;
    surface: ContextRuntimeSurface;
    parse: (input: unknown) => TParsed;
    body?: unknown;
    principal?: AuthPrincipal | null;
    principalAlreadyChecked?: boolean;
  }): Promise<{
    parsed: TParsed;
    explicitRecallKnobs: boolean;
    baseProfile: RecallProfileLike;
    explicitMode: ExplicitRecallModeLike;
    classAwareProfile: ClassAwareRecallProfileLike;
    contextBudgetDefaultApplied: boolean;
    runtimeEntropyRecallDefaults: RuntimeEntropyRecallDefaultsApplicationV1;
    runtimeEntropyVerifierDefaults: RuntimeEntropyVerifierDefaultsApplicationV1;
    wantDebugEmbeddings: boolean;
    scope: string;
    q: string;
  }> => {
    const { req, requestKind, surface, parse } = args;
    const principal = args.principalAlreadyChecked ? (args.principal ?? null) : await requireMemoryPrincipal(req);
    const bodyRaw = withIdentityFromRequest(req, args.body ?? req.body, principal, requestKind);
    const explicitRecallKnobs = hasExplicitRecallKnobs(bodyRaw);
    const baseProfile = resolveRecallProfile("recall_text", tenantFromBody(bodyRaw));
    const explicitMode = resolveExplicitRecallMode(bodyRaw, baseProfile.profile, explicitRecallKnobs);
    const classAwareProfile = resolveClassAwareRecallProfile(surface, bodyRaw, explicitMode.profile, explicitRecallKnobs);
    let body = withRecallProfileDefaults(bodyRaw, classAwareProfile.defaults);
    const strategyResolution = resolveRecallStrategy(bodyRaw, explicitRecallKnobs || explicitMode.mode !== null);
    if (strategyResolution.applied) {
      body = {
        ...body,
        ...strategyResolution.defaults,
        recall_strategy: strategyResolution.strategy,
      };
    }
    const entropyDefaults = runtimeEntropyRecallDefaultsApplication({
      body,
      explicitRecallKnobs,
    });
    if (entropyDefaults.application.reason === "invalid_runtime_entropy_controls") {
      throw new HttpError(
        400,
        "invalid_runtime_entropy_controls",
        "runtime_entropy_controls must match runtime_entropy_controls_v1.",
      );
    }
    body = entropyDefaults.body;
    const verifierDefaults = runtimeEntropyVerifierDefaultsApplication({
      body,
      explicitRuntimeVerification: hasExplicitRuntimeVerification(bodyRaw),
      supportsRuntimeVerification: surface !== "recall_text",
    });
    if (verifierDefaults.application.reason === "invalid_runtime_entropy_controls") {
      throw new HttpError(
        400,
        "invalid_runtime_entropy_controls",
        "runtime_entropy_controls must match runtime_entropy_controls_v1.",
      );
    }
    body = verifierDefaults.body;
    let parsed = parse(body);
    const budgetDefaulted = applyDefaultContextBudget(
      parsed,
      env.MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT,
      parse,
    );
    parsed = budgetDefaulted.parsed;
    const scope = parsed.scope ?? env.MEMORY_SCOPE;
    const qNorm = normalizeText(parsed.query_text, env.MAX_TEXT_LEN);
    return {
      parsed,
      explicitRecallKnobs,
      baseProfile,
      explicitMode,
      classAwareProfile,
      contextBudgetDefaultApplied: budgetDefaulted.contextBudgetDefaultApplied,
      runtimeEntropyRecallDefaults: entropyDefaults.application,
      runtimeEntropyVerifierDefaults: verifierDefaults.application,
      wantDebugEmbeddings: parsed.return_debug && parsed.include_embeddings,
      scope,
      q: env.PII_REDACTION ? redactPII(qNorm).text : qNorm,
    };
  };
  const buildRulesTimingObserver = (timings: Record<string, number>) => ({
    timing: (stage: string, ms: number) => {
      timings[stage] = (timings[stage] ?? 0) + ms;
    },
  });
  const runRecallWithStore = async <T>(args: {
    endpoint: ContextRuntimeSurface;
    recallParsed: ParsedMemoryRecall;
    auth: RecallAuth;
    timings: Record<string, number>;
    buildRuntimeOptions: () => MemoryRecallRuntimeOptions;
    finalize: (recall: MemoryRecallOutput) => Promise<T>;
  }): Promise<T> => {
    const recall = await memoryRecallParsed(args.recallParsed,
      env.MEMORY_SCOPE,
      env.MEMORY_TENANT_ID,
      args.auth,
      buildRulesTimingObserver(args.timings),
      args.endpoint,
      args.buildRuntimeOptions(),
    );
    return args.finalize(recall);
  };
  const buildRecallRuntimeOptions = (args: {
    internalAllowL4Selection: boolean;
    unsafeDropTrustAnchors?: boolean;
    applyLayerPolicyToRetrieval?: boolean;
  }): MemoryRecallRuntimeOptions => ({
    stage1_exact_recovery_on_empty: env.MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY,
    recall_access: liteRecallAccess,
    recall_engine_mode: env.RECALL_ENGINE_MODE,
    internal_allow_l4_selection: args.internalAllowL4Selection,
    ...(args.unsafeDropTrustAnchors !== undefined
      ? { unsafe_allow_drop_trust_anchors: args.unsafeDropTrustAnchors }
      : {}),
    ...(args.applyLayerPolicyToRetrieval !== undefined
      ? { unsafe_apply_layer_policy_to_retrieval: args.applyLayerPolicyToRetrieval }
      : {}),
  });
  const toRecallEmbedMetrics = (embedding: RecallEmbedResult) => ({
    embedMs: embedding.ms,
    embedCacheHit: embedding.cache_hit,
    embedSingleflightJoin: embedding.singleflight_join,
    embedQueueWaitMs: embedding.queue_wait_ms,
    embedBatchSize: embedding.batch_size,
  });
  const enforceRecallSurfaceQuotas = async (args: {
    req: ContextRuntimeRequest;
    reply: FastifyReply;
    tenantId: string;
    wantDebugEmbeddings: boolean;
  }) => {
    const { req, reply, tenantId, wantDebugEmbeddings } = args;
    await enforceRateLimit(req, reply, "recall");
    await enforceTenantQuota(req, reply, "recall", tenantId);
    if (wantDebugEmbeddings) await enforceRateLimit(req, reply, "debug_embeddings");
    if (wantDebugEmbeddings) await enforceTenantQuota(req, reply, "debug_embeddings", tenantId);
    await enforceRecallTextEmbedQuota(req, reply, tenantId);
  };
  const prepareAdaptiveRecallExecution = async <
    TParsed extends ParsedMemoryRecallText | ParsedPlanningContext | ParsedContextAssemble | ParsedMemoryRecall,
  >(args: {
    parsed: TParsed;
    parse: (input: unknown) => TParsed;
    profile: string;
    explicitRecallKnobs: boolean;
    explicitMode: ExplicitRecallModeLike;
  }) => {
    const gate = await acquireInflightSlot("recall");
    const adaptiveTuning = applyAdaptiveRecallTuning({
      parsed: args.parsed,
      parse: args.parse,
      profile: args.profile,
      waitMs: gate.wait_ms,
      explicitRecallKnobs: args.explicitRecallKnobs || args.explicitMode.mode !== null,
      resolveAdaptiveRecallProfile,
      resolveAdaptiveRecallHardCap,
    });
    return {
      gate,
      parsed: adaptiveTuning.parsed,
      adaptiveProfile: adaptiveTuning.adaptiveProfile,
      adaptiveHardCap: adaptiveTuning.adaptiveHardCap,
    };
  };
  const buildContextRulesRequest = (args: {
    recallParsed: ParsedMemoryRecall;
    context: unknown;
    includeShadow: boolean | undefined;
    rulesLimit: number | undefined;
  }) => ({
    scope: args.recallParsed.scope ?? env.MEMORY_SCOPE,
    tenant_id: args.recallParsed.tenant_id ?? env.MEMORY_TENANT_ID,
    context: args.context,
    include_shadow: args.includeShadow,
    limit: args.rulesLimit,
  });
  const buildContextToolsRequest = (args: {
    recallParsed: ParsedMemoryRecall;
    parsed: ParsedPlanningContext | ParsedContextAssemble;
    context: unknown;
  }) => ({
    scope: args.recallParsed.scope ?? env.MEMORY_SCOPE,
    tenant_id: args.recallParsed.tenant_id ?? env.MEMORY_TENANT_ID,
    ...("run_id" in args.parsed && typeof args.parsed.run_id === "string" ? { run_id: args.parsed.run_id } : {}),
    context: args.context,
    execution_result_summary: args.parsed.execution_result_summary,
    execution_artifacts: args.parsed.execution_artifacts,
    execution_evidence: args.parsed.execution_evidence,
    candidates: args.parsed.tool_candidates,
    include_shadow: args.parsed.include_shadow,
    rules_limit: args.parsed.rules_limit,
    strict: args.parsed.tool_strict,
  });
  const maybeEvaluateContextRules = async (args: {
    recallParsed: ParsedMemoryRecall;
    context: unknown;
    includeShadow: boolean | undefined;
    rulesLimit: number | undefined;
    includeRules?: boolean;
  }): Promise<RulesEvaluationLike | null> => {
    if (args.includeRules === false) return null;
    return evaluateRules(
      buildContextRulesRequest({
        recallParsed: args.recallParsed,
        context: args.context,
        includeShadow: args.includeShadow,
        rulesLimit: args.rulesLimit,
      }),
      env.MEMORY_SCOPE,
      env.MEMORY_TENANT_ID,
      {
        liteWriteStore,
      },
    );
  };
  const evaluateContextRules = async (args: {
    recallParsed: ParsedMemoryRecall;
    context: unknown;
    includeShadow: boolean | undefined;
    rulesLimit: number | undefined;
  }): Promise<RulesEvaluationLike> => {
    const rules = await maybeEvaluateContextRules({
      ...args,
      includeRules: true,
    });
    if (!rules) {
      throw new Error("rules evaluation unexpectedly returned null");
    }
    return rules;
  };
  const maybeSelectContextTools = async (args: {
    recallParsed: ParsedMemoryRecall;
    parsed: ParsedPlanningContext | ParsedContextAssemble;
    context: unknown;
  }): Promise<ToolSelectionLike | null> => {
    if (!Array.isArray(args.parsed.tool_candidates) || args.parsed.tool_candidates.length === 0) {
      return null;
    }
    return selectTools(buildContextToolsRequest({
        recallParsed: args.recallParsed,
        parsed: args.parsed,
        context: args.context,
      }),
      env.MEMORY_SCOPE,
      env.MEMORY_TENANT_ID,
      {
        recallAccess: liteRecallAccess,
        embedder,
        liteWriteStore,
      },
    );
  };
  const maybeBuildContextExperienceIntelligence = async (args: {
    parsed: ParsedPlanningContext | ParsedContextAssemble;
    tools: ToolSelectionLike | null;
  }): Promise<ExperienceIntelligenceResponse | null> => {
    if (!args.tools) return null;
    if (!Array.isArray(args.parsed.tool_candidates) || args.parsed.tool_candidates.length === 0) return null;
    const request = ExperienceIntelligenceRequest.parse({
      tenant_id: args.parsed.tenant_id,
      scope: args.parsed.scope,
      consumer_agent_id: args.parsed.consumer_agent_id,
      consumer_team_id: args.parsed.consumer_team_id,
      run_id: args.parsed.run_id,
      query_text: args.parsed.query_text,
      context: args.parsed.context ?? {},
      candidates: args.parsed.tool_candidates,
      include_shadow: args.parsed.include_shadow,
      rules_limit: args.parsed.rules_limit,
      strict: args.parsed.tool_strict,
      reorder_candidates: true,
      execution_result_summary: args.parsed.execution_result_summary,
      execution_artifacts: args.parsed.execution_artifacts,
      execution_evidence: args.parsed.execution_evidence,
      execution_state_v1: args.parsed.execution_state_v1,
      edit_boundary_context: args.parsed.edit_boundary_context,
      workflow_limit: 8,
    });
    const introspection = await buildExecutionMemoryIntrospectionLite(
      liteWriteStore,
      {
        tenant_id: request.tenant_id,
        scope: request.scope,
        consumer_agent_id: request.consumer_agent_id,
        consumer_team_id: request.consumer_team_id,
        limit: request.workflow_limit,
      },
      env.MEMORY_SCOPE,
      env.MEMORY_TENANT_ID,
      env.LITE_LOCAL_ACTOR_ID,
    );
    const recommendedWorkflows = Array.isArray(introspection.recommended_workflows) ? introspection.recommended_workflows : [];
    const candidateWorkflows = Array.isArray(introspection.candidate_workflows) ? introspection.candidate_workflows : [];
    const trustedPatterns = Array.isArray(introspection.trusted_patterns) ? introspection.trusted_patterns : [];
    const contestedPatterns = Array.isArray(introspection.contested_patterns) ? introspection.contested_patterns : [];
    const context =
      args.parsed.context && typeof args.parsed.context === "object" && !Array.isArray(args.parsed.context)
        ? (args.parsed.context as Record<string, unknown>)
        : {};
    const delegationLearning = await buildDelegationLearningSliceLite({
      liteWriteStore,
      body: request,
      tenantId: request.tenant_id ?? env.MEMORY_TENANT_ID,
      scope: request.scope ?? env.MEMORY_SCOPE,
      defaultScope: env.MEMORY_SCOPE,
      defaultTenantId: env.MEMORY_TENANT_ID,
      defaultActorId: env.LITE_LOCAL_ACTOR_ID,
      taskFamilies: [
        ...recommendedWorkflows.map((entry) => (entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).task_family : null)),
        ...candidateWorkflows.map((entry) => (entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).task_family : null)),
        ...trustedPatterns.map((entry) => (entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).task_family : null)),
        ...contestedPatterns.map((entry) => (entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).task_family : null)),
        context.task_kind,
      ],
      limitCandidates: [request.workflow_limit],
    });
    return buildExperienceIntelligenceResponse({
      parsed: request,
      tools: args.tools,
      introspection,
      delegationLearning,
    });
  };
  const projectDelegationLearningToLayeredContext = (args: {
    layeredContext: unknown;
    experienceIntelligence: ExperienceIntelligenceResponse | null;
  }) => {
    if (!args.layeredContext || typeof args.layeredContext !== "object" || Array.isArray(args.layeredContext)) return;
    if (!args.experienceIntelligence) return;
    const layered = args.layeredContext as Record<string, unknown>;
    layered.delegation_learning = {
      summary_version: "delegation_learning_projection_v1",
      learning_summary: args.experienceIntelligence.learning_summary,
      learning_recommendations: args.experienceIntelligence.learning_recommendations,
    };
    const adaptiveGuidance = args.experienceIntelligence.action_retrieval.adaptive_guidance;
    if (adaptiveGuidance) {
      layered.adaptive_guidance = adaptiveGuidance;
    }
    const experienceAdaptationTrace = args.experienceIntelligence.experience_adaptation_trace;
    if (experienceAdaptationTrace) {
      layered.experience_adaptation_trace = experienceAdaptationTrace;
    }
  };
  const buildContextOperatorProjection = (args: {
    returnLayeredContext: boolean;
    experienceIntelligence: ExperienceIntelligenceResponse | null;
    actionRetrievalGate?: Record<string, unknown> | null;
    continuityGuidance?: Record<string, unknown> | null;
  }) => {
    if (!args.returnLayeredContext) return undefined;
    const delegationLearning = args.experienceIntelligence
      ? {
          summary_version: "delegation_learning_projection_v1",
          learning_summary: args.experienceIntelligence.learning_summary,
          learning_recommendations: args.experienceIntelligence.learning_recommendations,
        }
      : undefined;
    const firstStep = args.continuityGuidance && typeof args.continuityGuidance === "object"
      ? args.continuityGuidance
      : null;
    const continuitySignal =
      firstStep?.continuity_signal_v1
      && typeof firstStep.continuity_signal_v1 === "object"
      && !Array.isArray(firstStep.continuity_signal_v1)
        ? firstStep.continuity_signal_v1 as Record<string, unknown>
        : null;
    const editBoundary =
      firstStep?.edit_boundary_v1
      && typeof firstStep.edit_boundary_v1 === "object"
      && !Array.isArray(firstStep.edit_boundary_v1)
        ? firstStep.edit_boundary_v1 as Record<string, unknown>
        : null;
    const verificationRepair =
      firstStep?.verification_repair_v1
      && typeof firstStep.verification_repair_v1 === "object"
      && !Array.isArray(firstStep.verification_repair_v1)
        ? firstStep.verification_repair_v1 as Record<string, unknown>
        : null;
    const pathRecommendation =
      args.experienceIntelligence?.recommendation?.path
      && typeof args.experienceIntelligence.recommendation.path === "object"
      && !Array.isArray(args.experienceIntelligence.recommendation.path)
        ? args.experienceIntelligence.recommendation.path as Record<string, unknown>
        : null;
    const policyContract =
      args.experienceIntelligence?.policy_contract
      && typeof args.experienceIntelligence.policy_contract === "object"
      && !Array.isArray(args.experienceIntelligence.policy_contract)
        ? args.experienceIntelligence.policy_contract as Record<string, unknown>
        : null;
    const executionContract =
      firstStep?.execution_contract_v1
      && typeof firstStep.execution_contract_v1 === "object"
      && !Array.isArray(firstStep.execution_contract_v1)
        ? firstStep.execution_contract_v1 as Record<string, unknown>
        : null;
    const readNullableString = (...values: unknown[]) => {
      for (const value of values) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed.length > 0) return trimmed;
      }
      return null;
    };
    const gate = args.actionRetrievalGate && typeof args.actionRetrievalGate === "object"
      ? args.actionRetrievalGate
      : null;
    const adaptiveGuidance =
      args.experienceIntelligence?.action_retrieval?.adaptive_guidance
      && typeof args.experienceIntelligence.action_retrieval.adaptive_guidance === "object"
      && !Array.isArray(args.experienceIntelligence.action_retrieval.adaptive_guidance)
        ? args.experienceIntelligence.action_retrieval.adaptive_guidance
        : null;
    const experienceAdaptationTrace =
      args.experienceIntelligence?.experience_adaptation_trace
      && typeof args.experienceIntelligence.experience_adaptation_trace === "object"
      && !Array.isArray(args.experienceIntelligence.experience_adaptation_trace)
        ? args.experienceIntelligence.experience_adaptation_trace
        : null;
    const runtimeContract =
      args.experienceIntelligence?.action_intelligence_runtime_contract
      && typeof args.experienceIntelligence.action_intelligence_runtime_contract === "object"
      && !Array.isArray(args.experienceIntelligence.action_intelligence_runtime_contract)
        ? args.experienceIntelligence.action_intelligence_runtime_contract as Record<string, unknown>
        : null;
    const actionIntelligencePreActionGate =
      runtimeContract?.pre_action_gate
      && typeof runtimeContract.pre_action_gate === "object"
      && !Array.isArray(runtimeContract.pre_action_gate)
        ? runtimeContract.pre_action_gate as Record<string, unknown>
        : null;
    const runtimeEntropyProfile =
      runtimeContract?.runtime_entropy_profile
      && typeof runtimeContract.runtime_entropy_profile === "object"
      && !Array.isArray(runtimeContract.runtime_entropy_profile)
        ? runtimeContract.runtime_entropy_profile as Record<string, unknown>
        : null;
    const runtimeEntropyControls =
      runtimeContract?.runtime_entropy_controls
      && typeof runtimeContract.runtime_entropy_controls === "object"
      && !Array.isArray(runtimeContract.runtime_entropy_controls)
        ? runtimeContract.runtime_entropy_controls as Record<string, unknown>
        : null;
    const gateAction =
      typeof gate?.gate_action === "string"
      && (
        gate.gate_action === "inspect_context"
        || gate.gate_action === "widen_recall"
        || gate.gate_action === "rehydrate_payload"
        || gate.gate_action === "request_operator_review"
      )
        ? gate.gate_action
        : null;
    const recommendedActions = Array.isArray(gate?.recommended_actions)
      ? gate.recommended_actions.filter(
          (entry): entry is "inspect_context" | "widen_recall" | "rehydrate_payload" | "request_operator_review" =>
            entry === "inspect_context"
            || entry === "widen_recall"
            || entry === "rehydrate_payload"
            || entry === "request_operator_review",
        )
      : [];
    const orderedActions: Array<"inspect_context" | "widen_recall" | "rehydrate_payload" | "request_operator_review"> = gateAction
      ? [gateAction, ...recommendedActions.filter((entry) => entry !== gateAction)]
      : recommendedActions;
    const contractTrust =
      firstStep?.contract_trust === "authoritative"
      || firstStep?.contract_trust === "advisory"
      || firstStep?.contract_trust === "observational"
        ? firstStep.contract_trust
        : "observational";
    const selectedTool = readNullableString(
      executionContract?.selected_tool,
      firstStep?.selected_tool,
    );
    const filePath = typeof executionContract?.file_path === "string"
      ? executionContract.file_path
      : typeof firstStep?.file_path === "string"
        ? firstStep.file_path
        : null;
    const taskFamily = contractTrust === "observational"
      ? null
      : readNullableString(
          executionContract?.task_family,
          firstStep?.task_family,
          pathRecommendation?.task_family,
          policyContract?.task_family,
        );
    const workflowSignature = contractTrust === "observational"
      ? null
      : readNullableString(
          executionContract?.workflow_signature,
          firstStep?.workflow_signature,
          pathRecommendation?.workflow_signature,
          policyContract?.workflow_signature,
        );
    const policyMemoryId = contractTrust === "observational"
      ? null
      : readNullableString(
          executionContract?.policy_memory_id,
          firstStep?.policy_memory_id,
          policyContract?.policy_memory_id,
          pathRecommendation?.policy_memory_id,
        );
    const preferredRehydration = gate?.preferred_rehydration && typeof gate.preferred_rehydration === "object"
      ? (gate.preferred_rehydration as Record<string, unknown>)
      : null;
    const buildDefaultInstruction = (
      action: "inspect_context" | "widen_recall" | "rehydrate_payload" | "request_operator_review",
    ) => {
      if (action === "request_operator_review") {
        return selectedTool
          ? `Request operator review before committing to ${selectedTool}.`
          : "Request operator review before committing to the next step.";
      }
      if (action === "rehydrate_payload") {
        const label =
          (typeof preferredRehydration?.title === "string" && preferredRehydration.title)
          || (typeof preferredRehydration?.summary === "string" && preferredRehydration.summary)
          || "the colder payload";
        return filePath
          ? `Rehydrate colder payload for ${label} before reusing ${selectedTool ?? "the learned path"} on ${filePath}.`
          : `Rehydrate colder payload for ${label} before committing to the next step.`;
      }
      if (action === "widen_recall") {
        return selectedTool
          ? `Widen recall before committing to ${selectedTool}${filePath ? ` on ${filePath}` : ""}.`
          : "Widen recall before committing to the next step.";
      }
      if (selectedTool && filePath) {
        return `Inspect ${filePath} and the current context before using ${selectedTool}.`;
      }
      if (selectedTool) {
        return `Inspect the current context before starting with ${selectedTool}.`;
      }
      return "Inspect the current context before taking the next step.";
    };
    const actionHints = orderedActions.map((action, index) => ({
      summary_version: "context_operator_action_hint_v1" as const,
      action,
      priority:
        index === 0 && contractTrust === "authoritative"
          ? "required" as const
          : "recommended" as const,
      contract_trust: contractTrust,
      execution_contract_v1: executionContract,
      instruction:
        index === 0 && typeof gate?.instruction === "string"
          ? gate.instruction
          : buildDefaultInstruction(action),
      selected_tool: selectedTool,
      file_path: filePath,
      task_family: taskFamily,
      workflow_signature: workflowSignature,
      policy_memory_id: policyMemoryId,
      tool_route: action === "rehydrate_payload" ? "/v1/memory/tools/rehydrate_payload" : null,
      tool_method: action === "rehydrate_payload" ? "POST" as const : null,
      example_call:
        action === "rehydrate_payload" && typeof preferredRehydration?.example_call === "string"
          ? preferredRehydration.example_call
          : null,
      preferred_rehydration_anchor_id:
        action === "rehydrate_payload" && typeof preferredRehydration?.anchor_id === "string"
          ? preferredRehydration.anchor_id
          : null,
    }));
    if (!delegationLearning && !actionIntelligencePreActionGate && !runtimeEntropyProfile && !runtimeEntropyControls && !gate && !adaptiveGuidance && !experienceAdaptationTrace && !continuitySignal && !editBoundary && !verificationRepair && actionHints.length === 0) return undefined;
    return {
      ...(delegationLearning ? { delegation_learning: delegationLearning } : {}),
      ...(actionIntelligencePreActionGate ? { action_intelligence_pre_action_gate: actionIntelligencePreActionGate } : {}),
      ...(runtimeEntropyProfile ? { runtime_entropy_profile: runtimeEntropyProfile } : {}),
      ...(runtimeEntropyControls ? { runtime_entropy_controls: runtimeEntropyControls } : {}),
      ...(gate ? { action_retrieval_gate: gate } : {}),
      ...(adaptiveGuidance ? { adaptive_guidance: adaptiveGuidance } : {}),
      ...(experienceAdaptationTrace ? { experience_adaptation_trace: experienceAdaptationTrace } : {}),
      ...(continuitySignal ? { continuity_signal_v1: continuitySignal } : {}),
      ...(editBoundary ? { edit_boundary_v1: editBoundary } : {}),
      ...(verificationRepair ? { verification_repair_v1: verificationRepair } : {}),
      ...(actionHints.length > 0 ? { action_hints: actionHints } : {}),
    };
  };
  const buildRecallRouteDiagnostics = (args: {
    recallParsed: ParsedMemoryRecall;
    recallOut: MemoryRecallOutput;
    tools?: ToolSelectionLike | null;
    timings: Record<string, number>;
    inflightWaitMs: number;
    explicitMode: ExplicitRecallModeLike;
    adaptiveProfile: RecallAdaptiveProfileLike;
    adaptiveHardCap: RecallAdaptiveHardCapLike;
    runtimeEntropyRecallDefaults: RuntimeEntropyRecallDefaultsApplicationV1;
    runtimeEntropyVerifierDefaults: RuntimeEntropyVerifierDefaultsApplicationV1;
    classAwareObservability: Record<string, unknown>;
  }) => {
    const contextText = typeof args.recallOut?.context?.text === "string" ? args.recallOut.context.text : "";
    const contextChars = contextText.length;
    const contextEstTokens = estimateTokenCountFromText(contextText);
    const trajectory = buildRecallTrajectory({
      strategy:
        args.recallParsed.recall_strategy ??
        inferRecallStrategyFromKnobs(toRecallKnobs(args.recallParsed)),
      limit: args.recallParsed.limit,
      neighborhood_hops: args.recallParsed.neighborhood_hops,
      max_nodes: args.recallParsed.max_nodes,
      max_edges: args.recallParsed.max_edges,
      ranked_limit: args.recallParsed.ranked_limit,
      min_edge_weight: args.recallParsed.min_edge_weight,
      min_edge_confidence: args.recallParsed.min_edge_confidence,
      seeds: args.recallOut.seeds.length,
      nodes: args.recallOut.subgraph.nodes.length,
      edges: args.recallOut.subgraph.edges.length,
      context_chars: contextChars,
      timings: args.timings,
      neighborhood_counts: args.recallOut?.debug?.neighborhood_counts ?? null,
      stage1: args.recallOut?.debug?.stage1 ?? null,
      uri_links: collectRecallTrajectoryUriLinks({ recall: args.recallOut, tools: args.tools ?? undefined }),
    });
    const observability = buildRecallObservability({
      timings: args.timings,
      inflight_wait_ms: args.inflightWaitMs,
      context_items: args.recallOut?.context?.items ?? [],
      selection_policy: args.recallOut?.context?.selection_policy ?? null,
      selection_stats: args.recallOut?.context?.selection_stats ?? null,
      explicit_mode: {
        mode: args.explicitMode.mode,
        profile: args.explicitMode.profile,
        applied: args.explicitMode.applied,
        reason: args.explicitMode.reason,
        source: args.explicitMode.source,
      },
      adaptive_profile: {
        profile: args.adaptiveProfile.profile,
        applied: args.adaptiveProfile.applied,
        reason: args.adaptiveProfile.reason,
      },
      class_aware: args.classAwareObservability,
      adaptive_hard_cap: {
        applied: args.adaptiveHardCap.applied,
        reason: args.adaptiveHardCap.reason,
      },
      runtime_entropy_defaults: args.runtimeEntropyRecallDefaults,
      runtime_entropy_verifier_defaults: args.runtimeEntropyVerifierDefaults,
      stage1: args.recallOut?.debug?.stage1 ?? null,
      neighborhood_counts: args.recallOut?.debug?.neighborhood_counts ?? null,
    });
    return {
      contextText,
      contextChars,
      contextEstTokens,
      trajectory,
      observability,
    };
  };
  const buildEffectiveStaticBlocks = (args: {
    parsed: ParsedPlanningContext | ParsedContextAssemble;
    executionKernel: ReturnType<typeof resolveExecutionKernelContext>;
    executionEvidenceContext?: ExecutionEvidenceContextLite | null;
  }) => {
    const staticContextBlocks = normalizeStaticContextBlocks(args.parsed.static_context_blocks);
    const parsedWithStaticBlocks = {
      ...args.parsed,
      static_context_blocks: staticContextBlocks,
    };
    const executionEvidenceBlocks = executionEvidenceContextToStaticBlocks(args.executionEvidenceContext ?? null);
    return args.executionKernel.packet
      ? [
          ...executionPacketToStaticBlocks(args.executionKernel.packet),
          ...executionEvidenceBlocks,
          ...(args.parsed.execution_tree_v1 ? executionTreeToStaticBlocks(args.parsed.execution_tree_v1) : []),
          ...executionContinuityToStaticBlocks(parsedWithStaticBlocks).blocks,
          ...staticContextBlocks,
        ]
      : [
          ...executionEvidenceBlocks,
          ...mergeExecutionPacketStaticBlocks(parsedWithStaticBlocks),
        ];
  };
  const buildDefaultExecutionEvidenceContext = async (
    parsed: ParsedPlanningContext | ParsedContextAssemble,
  ): Promise<ExecutionEvidenceContextLite | null> => {
    if (!parsed.execution_tree_v1) return null;
    return buildExecutionEvidenceContextLite({
      liteWriteStore,
      executionTreeStore: null,
      body: {
        tenant_id: parsed.tenant_id,
        scope: parsed.scope,
        consumer_agent_id: parsed.consumer_agent_id,
        consumer_team_id: parsed.consumer_team_id,
        execution_tree_v1: parsed.execution_tree_v1,
        include_memory_evidence: false,
        include_prompt_text: true,
        prompt_detail: "compact",
      },
      defaultScope: env.MEMORY_SCOPE,
      defaultTenantId: env.MEMORY_TENANT_ID,
    });
  };
  const resolveContextRuntimeVerification = async (args: {
    parsed: ParsedPlanningContext | ParsedContextAssemble;
    executionKernel: ReturnType<typeof resolveExecutionKernelContext>;
  }): Promise<RuntimeVerificationSurfaceV1 | null> => {
    if (!args.executionKernel.packet) return null;
    const control = args.parsed.runtime_verification ?? { version: 1, mode: "plan" as const };
    const verifierExecutionEnabled = env.APP_ENV !== "prod" && env.RUNTIME_VERIFIER_EXECUTION_ENABLED;
    const executionBlockedReason = env.APP_ENV === "prod"
      ? "runtime_verifier_execution_blocked_in_prod"
      : "runtime_verifier_execution_disabled";
    return runRuntimeVerificationSurfaceV1(
      args.executionKernel.packet,
      {
        ...control,
        validation_boundary: "runtime_orchestrator",
      },
      {
        allowExecution: verifierExecutionEnabled,
        executionBlockedReason,
      },
    );
  };
  const appendRuntimeVerificationEvidence = <
    TParsed extends ParsedPlanningContext | ParsedContextAssemble,
  >(args: {
    parsed: TParsed;
    runtimeVerification: RuntimeVerificationSurfaceV1 | null;
    parse: (input: unknown) => TParsed;
  }): TParsed => {
    const runtimeVerification = args.runtimeVerification;
    const evidence = runtimeVerification?.evidence_for_trust_gate;
    if (!runtimeVerification || !evidence) return args.parsed;
    return args.parse({
      ...args.parsed,
      execution_evidence: [
        ...(Array.isArray(args.parsed.execution_evidence) ? args.parsed.execution_evidence : []),
        evidence,
      ],
      execution_result_summary: {
        ...(args.parsed.execution_result_summary ?? {}),
        runtime_verification_v1: {
          surface_version: runtimeVerification.surface_version,
          requested_mode: runtimeVerification.requested_mode,
          execution_state: runtimeVerification.execution_state,
          request_count: runtimeVerification.request_count,
          result_count: runtimeVerification.result_count,
          authoritative_evidence_ready: runtimeVerification.summary.authoritative_evidence_ready,
          reason_codes: runtimeVerification.summary.reason_codes,
        },
      },
    });
  };
  const recordContextAssemblyTelemetrySafe = async (args: {
    req: ContextRuntimeRequest;
    tenantId: string;
    scope: string;
    endpoint: "planning_context" | "context_assemble";
    latencyMs: number;
    layeredContext: unknown;
    costSignals: ReturnType<typeof buildLayeredContextCostSignals>;
    selectionPolicy: unknown;
  }) => {
    try {
      await recordContextAssemblyTelemetryBestEffort({
        req: args.req,
        tenant_id: args.tenantId,
        scope: args.scope,
        endpoint: args.endpoint,
        latency_ms: args.latencyMs,
        layered_output: !!args.layeredContext,
        layered_context: args.layeredContext,
        selected_memory_layers: Array.isArray(args.costSignals?.selected_memory_layers) ? args.costSignals.selected_memory_layers : [],
        selection_policy:
          args.selectionPolicy && typeof args.selectionPolicy === "object"
            ? (args.selectionPolicy as {
                name?: string | null;
                source?: string | null;
                trust_anchor_layers?: string[];
                requested_allowed_layers?: string[];
              })
            : null,
      });
    } catch (err) {
      args.req.log.warn({ err, tenant_id: args.tenantId, scope: args.scope }, `${args.endpoint} telemetry insert failed`);
    }
  };
  const buildLayeredContextArtifacts = (args: {
    parsed: ParsedPlanningContext | ParsedContextAssemble;
    recallParsed: ParsedMemoryRecall;
    recallOut: MemoryRecallOutput;
    rules: RulesEvaluationLike | null;
    tools: ToolSelectionLike | null;
    executionContext: unknown;
    effectiveStaticBlocks: ReturnType<typeof mergeExecutionPacketStaticBlocks>;
    contextEstTokens: number;
    optimizationProfile: {
      requested: string | null;
      source: string | null;
    };
  }) => {
    const layeredContext = args.parsed.return_layered_context
      ? assembleLayeredContext({
          recall: args.recallOut,
          rules: args.rules,
          tools: args.tools,
          query_text: args.parsed.query_text,
          execution_context: args.executionContext,
          tool_candidates: args.parsed.tool_candidates,
          static_blocks: args.effectiveStaticBlocks ?? null,
          static_injection: args.parsed.static_injection ?? null,
          config: args.parsed.context_layers ?? null,
        })
      : undefined;
    if (layeredContext && typeof layeredContext === "object") {
      (layeredContext as Record<string, unknown>).optimization_profile = args.optimizationProfile;
    }
    const costSignals = buildLayeredContextCostSignals({
      layered_context: layeredContext,
      context_items: Array.isArray(args.recallOut?.context?.items) ? args.recallOut.context.items : [],
      context_selection_stats: args.recallOut?.context?.selection_stats ?? null,
      context_est_tokens: args.contextEstTokens,
      context_token_budget: args.recallParsed.context_token_budget ?? null,
      context_char_budget: args.recallParsed.context_char_budget ?? null,
      context_compaction_profile: args.recallParsed.context_compaction_profile ?? "balanced",
      context_optimization_profile: args.optimizationProfile.requested,
    });
    return {
      layeredContext,
      costSignals,
    };
  };

  app.post("/v1/memory/recall_text", async (req: ContextRuntimeRequest, reply: FastifyReply) => {
    const surfaceEmbedder = resolveSurfaceEmbedder("recall_text");

    const t0 = performance.now();
    const timings: Record<string, number> = {};
    const preparedRequest = await prepareSurfaceRequest({
      req,
      requestKind: "recall_text",
      surface: "recall_text",
      parse: MemoryRecallTextRequest.parse,
    });
    let parsed = preparedRequest.parsed;
    const explicitRecallKnobs = preparedRequest.explicitRecallKnobs;
    const baseProfile = preparedRequest.baseProfile;
    const explicitMode = preparedRequest.explicitMode;
    const classAwareProfile = preparedRequest.classAwareProfile;
    const contextBudgetDefaultApplied = preparedRequest.contextBudgetDefaultApplied;
    const runtimeEntropyRecallDefaults = preparedRequest.runtimeEntropyRecallDefaults;
    const runtimeEntropyVerifierDefaults = preparedRequest.runtimeEntropyVerifierDefaults;
    const wantDebugEmbeddingsText = preparedRequest.wantDebugEmbeddings;
    await enforceRecallSurfaceQuotas({
      req,
      reply,
      tenantId: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
      wantDebugEmbeddings: wantDebugEmbeddingsText,
    });
    const scope = preparedRequest.scope;
    const q = preparedRequest.q;
    const internalAllowL4Selection = allowInternalL4Serving(req);

    let vec: number[];
    let embedMs = 0;
    let embedCacheHit = false;
    let embedSingleflightJoin = false;
    let embedQueueWaitMs = 0;
    let embedBatchSize = 1;
    let recallParsed: ParsedMemoryRecall;
    const adaptiveExecution = await prepareAdaptiveRecallExecution({
      parsed,
      parse: MemoryRecallTextRequest.parse,
      profile: classAwareProfile.profile,
      explicitRecallKnobs,
      explicitMode,
    });
    const gate = adaptiveExecution.gate;
    parsed = adaptiveExecution.parsed;
    const adaptiveProfile = adaptiveExecution.adaptiveProfile;
    const adaptiveHardCap = adaptiveExecution.adaptiveHardCap;
    let out: RecallTextRouteOutput;
    try {
      const emb = await runRecallEmbedding({
        endpoint: "recall_text",
        req,
        reply,
        provider: surfaceEmbedder,
        scope,
        tenantId: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        queryText: q,
      });
      vec = emb.vec;
      ({ embedMs, embedCacheHit, embedSingleflightJoin, embedQueueWaitMs, embedBatchSize } = toRecallEmbedMetrics(emb));

      recallParsed = buildRecallRequestFromQuery({
        scope,
        queryEmbedding: vec,
        parsed,
        extras: {
          rules_context: parsed.rules_context,
          rules_include_shadow: parsed.rules_include_shadow,
          rules_limit: parsed.rules_limit,
        },
      });
      const wantDebugEmbeddings = recallParsed.return_debug && recallParsed.include_embeddings;
      const auth = buildRecallAuth(req, wantDebugEmbeddings);
      out = await runRecallWithStore({
        endpoint: "recall_text",
        recallParsed,
        auth,
        timings,
        buildRuntimeOptions: () =>
          buildRecallRuntimeOptions({
            internalAllowL4Selection,
          }),
        finalize: async (base) => {
          if (recallParsed.rules_context === undefined || recallParsed.rules_context === null) {
            return base;
          }
          const rulesRes = await evaluateRules(
            {
              scope: recallParsed.scope ?? env.MEMORY_SCOPE,
              tenant_id: recallParsed.tenant_id ?? env.MEMORY_TENANT_ID,
              context: recallParsed.rules_context,
              include_shadow: recallParsed.rules_include_shadow,
              limit: recallParsed.rules_limit,
            },
            env.MEMORY_SCOPE,
            env.MEMORY_TENANT_ID,
            { liteWriteStore },
          );
          return attachRecallRules(base, rulesRes);
        },
      });
    } finally {
      gate.release();
    }
    const ms = performance.now() - t0;
    const diagnostics = buildRecallRouteDiagnostics({
      recallParsed,
      recallOut: out,
      timings,
      inflightWaitMs: gate.wait_ms,
      explicitMode,
      adaptiveProfile,
      adaptiveHardCap,
      runtimeEntropyRecallDefaults,
      runtimeEntropyVerifierDefaults,
      classAwareObservability: {
        workload_class: classAwareProfile.workload_class,
        profile: classAwareProfile.profile,
        enabled: classAwareProfile.enabled,
        applied: classAwareProfile.applied,
        reason: classAwareProfile.reason,
        source: classAwareProfile.source,
        signals: classAwareProfile.signals,
      },
    });
    const contextChars = diagnostics.contextChars;
    const contextEstTokens = diagnostics.contextEstTokens;
    req.log.info(
      {
        recall_text: {
          scope: out.scope,
          tenant_id: out.tenant_id ?? recallParsed.tenant_id ?? env.MEMORY_TENANT_ID,
          limit: recallParsed.limit,
          hops: recallParsed.neighborhood_hops,
          embedding_provider: surfaceEmbedder.name,
          embed_ms: embedMs,
          embed_cache_hit: embedCacheHit,
          embed_singleflight_join: embedSingleflightJoin,
          embed_queue_wait_ms: embedQueueWaitMs,
          embed_batch_size: embedBatchSize,
          embed_batcher: recallTextEmbedBatcherStats(),
          include_meta: !!recallParsed.include_meta,
          include_slots: !!recallParsed.include_slots,
          include_slots_preview: !!recallParsed.include_slots_preview,
          consumer_agent_id: recallParsed.consumer_agent_id ?? null,
          consumer_team_id: recallParsed.consumer_team_id ?? null,
          seeds: out.seeds.length,
          nodes: out.subgraph.nodes.length,
          edges: out.subgraph.edges.length,
          neighborhood_counts: out.debug?.neighborhood_counts ?? null,
          rules: out.rules ? { considered: out.rules.considered, matched: out.rules.matched } : null,
          context_chars: contextChars,
          context_est_tokens: contextEstTokens,
	          context_token_budget: recallParsed.context_token_budget ?? null,
	          context_char_budget: recallParsed.context_char_budget ?? null,
	          context_compaction_profile: recallParsed.context_compaction_profile ?? "balanced",
	          context_budget_default_applied: contextBudgetDefaultApplied,
	          stage1_exact_recovery_enabled: env.MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY,
	          stage1_exact_recovery_used: Number.isFinite(timings["stage1_candidates_exact_recovery"]),
	          recall_engine_mode: env.RECALL_ENGINE_MODE,
	          stage1_ann_seed_count: out.debug?.stage1?.ann_seed_count ?? null,
	          stage1_ann_ms: timings["stage1_candidates_ann"] ?? null,
	          stage1_hybrid_seed_count: out.debug?.stage1?.hybrid_seed_count ?? null,
	          stage1_hybrid_ms: timings["stage1_candidates_hybrid"] ?? null,
	          stage1_exact_recovery_ms: timings["stage1_candidates_exact_recovery"] ?? null,
	          profile: adaptiveProfile.profile,
          profile_source: baseProfile.source,
          recall_mode: explicitMode.mode,
          recall_mode_profile: explicitMode.profile,
          recall_mode_applied: explicitMode.applied,
          recall_mode_reason: explicitMode.reason,
          recall_mode_source: explicitMode.source,
          class_aware_profile: classAwareProfile.profile,
          class_aware_enabled: classAwareProfile.enabled,
          class_aware_applied: classAwareProfile.applied,
          class_aware_reason: classAwareProfile.reason,
          class_aware_source: classAwareProfile.source,
          class_aware_workload_class: classAwareProfile.workload_class,
          class_aware_signals: classAwareProfile.signals,
          adaptive_profile_applied: adaptiveProfile.applied,
          adaptive_profile_reason: adaptiveProfile.reason,
          adaptive_hard_cap_applied: adaptiveHardCap.applied,
          adaptive_hard_cap_reason: adaptiveHardCap.reason,
          runtime_entropy_defaults_applied: runtimeEntropyRecallDefaults.applied,
          runtime_entropy_defaults_reason: runtimeEntropyRecallDefaults.reason,
          runtime_entropy_defaults_breadth: runtimeEntropyRecallDefaults.recall_breadth,
          runtime_entropy_verifier_defaults_applied: runtimeEntropyVerifierDefaults.applied,
          runtime_entropy_verifier_defaults_reason: runtimeEntropyVerifierDefaults.reason,
          runtime_entropy_verifier_defaults_schedule: runtimeEntropyVerifierDefaults.verifier_schedule,
          adaptive_hard_cap_wait_ms: env.MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS,
          inflight_wait_ms: gate.wait_ms,
          ms,
          timings_ms: timings,
        },
      },
      "memory recall_text",
    );
    return reply.code(200).send({
      ...out,
      query: { text: q, embedding_provider: surfaceEmbedder.name },
      trajectory: diagnostics.trajectory,
      observability: diagnostics.observability,
    });
  });

  const assemblePlanningContext: MemoryPlanningContextRouteService["assemble"] = async (req, reply, options = {}) => {
    const surfaceEmbedder = resolveSurfaceEmbedder("planning_context");

    const t0 = performance.now();
    const timings: Record<string, number> = {};
    const preparedRequest = await prepareSurfaceRequest({
      req,
      requestKind: "planning_context",
      surface: "planning_context",
      parse: PlanningContextRequest.parse,
      body: options.body,
      principal: options.principal,
      principalAlreadyChecked: options.principalAlreadyChecked,
    });
    let parsed = preparedRequest.parsed;
    const explicitRecallKnobs = preparedRequest.explicitRecallKnobs;
    const baseProfile = preparedRequest.baseProfile;
    const explicitMode = preparedRequest.explicitMode;
    const classAwareProfile = preparedRequest.classAwareProfile;
    const contextBudgetDefaultApplied = preparedRequest.contextBudgetDefaultApplied;
    const runtimeEntropyRecallDefaults = preparedRequest.runtimeEntropyRecallDefaults;
    const runtimeEntropyVerifierDefaults = preparedRequest.runtimeEntropyVerifierDefaults;
    const wantDebugEmbeddings = preparedRequest.wantDebugEmbeddings;
    await enforceRecallSurfaceQuotas({
      req,
      reply,
      tenantId: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
      wantDebugEmbeddings,
    });

    const scope = preparedRequest.scope;
    const q = preparedRequest.q;

    let embedMs = 0;
    let embedCacheHit = false;
    let embedSingleflightJoin = false;
    let embedQueueWaitMs = 0;
    let embedBatchSize = 1;
    let recallParsed: ParsedMemoryRecall;
    const adaptiveExecution = await prepareAdaptiveRecallExecution({
      parsed,
      parse: PlanningContextRequest.parse,
      profile: classAwareProfile.profile,
      explicitRecallKnobs,
      explicitMode,
    });
    const gate = adaptiveExecution.gate;
    parsed = adaptiveExecution.parsed;
    const adaptiveProfile = adaptiveExecution.adaptiveProfile;
    const adaptiveHardCap = adaptiveExecution.adaptiveHardCap;
    const planningOptimization = applyContextOptimizationProfile(
      parsed,
      env.MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT === "off"
        ? null
        : env.MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT,
    );
    parsed = PlanningContextRequest.parse(planningOptimization.parsed);
    parsed = augmentTrajectoryAwareRequest({
      parsed,
      parse: PlanningContextRequest.parse,
      defaultScope: env.MEMORY_SCOPE,
      defaultTenantId: env.MEMORY_TENANT_ID,
    }).parsed;
    const executionKernel = resolveExecutionKernelContext(parsed);
    const runtimeVerification = await resolveContextRuntimeVerification({
      parsed,
      executionKernel,
    });
    parsed = appendRuntimeVerificationEvidence({
      parsed,
      runtimeVerification,
      parse: PlanningContextRequest.parse,
    });
    const planningExecutionContext = buildExecutionContinuityContext(parsed);
    const executionEvidenceContext = await buildDefaultExecutionEvidenceContext(parsed);

    let out: PlanningContextRouteOutput;
    try {
      let vec: number[];
      const emb = await runRecallEmbedding({
        endpoint: "planning_context",
        req,
        reply,
        provider: surfaceEmbedder,
        scope,
        tenantId: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        queryText: q,
      });
      vec = emb.vec;
      ({ embedMs, embedCacheHit, embedSingleflightJoin, embedQueueWaitMs, embedBatchSize } = toRecallEmbedMetrics(emb));

      recallParsed = buildRecallRequestFromQuery({
        scope,
        queryEmbedding: vec,
        parsed,
      });
      const auth = buildRecallAuth(req, wantDebugEmbeddings);
      const unsafeDropTrustAnchors = allowUnsafeDropTrustAnchors(req);
      const applyLayerPolicyToRetrieval = allowLayerPolicyRetrievalFiltering(req);
      const internalAllowL4Selection = allowInternalL4Serving(req);
      out = await runRecallWithStore({
        endpoint: "planning_context",
        recallParsed,
        auth,
        timings,
        buildRuntimeOptions: () =>
          buildRecallRuntimeOptions({
            internalAllowL4Selection,
            unsafeDropTrustAnchors,
            applyLayerPolicyToRetrieval,
          }),
        finalize: async (recall) => {
          const rules = await evaluateContextRules({
            recallParsed,
            context: planningExecutionContext,
            includeShadow: parsed.include_shadow,
            rulesLimit: parsed.rules_limit,
          });
          const tools = await maybeSelectContextTools({
            recallParsed,
            parsed,
            context: planningExecutionContext,
          });
          return { recall, rules, tools };
        },
      });
    } finally {
      gate.release();
    }

    const ms = performance.now() - t0;
    const recallOut = out.recall;
    const diagnostics = buildRecallRouteDiagnostics({
      recallParsed,
      recallOut,
      tools: out.tools,
      timings,
      inflightWaitMs: gate.wait_ms,
      explicitMode,
      adaptiveProfile,
      adaptiveHardCap,
      runtimeEntropyRecallDefaults,
      runtimeEntropyVerifierDefaults,
      classAwareObservability: {
        workload_class: classAwareProfile.workload_class,
        profile: classAwareProfile.profile,
        applied: classAwareProfile.applied,
        reason: classAwareProfile.reason,
        signals: classAwareProfile.signals,
      },
    });
    const experienceIntelligence = await maybeBuildContextExperienceIntelligence({
      parsed,
      tools: out.tools,
    });
    const contextChars = diagnostics.contextChars;
    const contextEstTokens = diagnostics.contextEstTokens;

    req.log.info(
      {
        planning_context: {
          scope: recallOut.scope,
          tenant_id: recallOut.tenant_id ?? recallParsed.tenant_id ?? env.MEMORY_TENANT_ID,
          has_tool_candidates: Array.isArray(parsed.tool_candidates) && parsed.tool_candidates.length > 0,
          tool_candidates: parsed.tool_candidates?.length ?? 0,
          include_shadow: parsed.include_shadow,
          rules_limit: parsed.rules_limit,
          embed_ms: embedMs,
          embed_cache_hit: embedCacheHit,
          embed_singleflight_join: embedSingleflightJoin,
          embed_queue_wait_ms: embedQueueWaitMs,
          embed_batch_size: embedBatchSize,
          context_chars: contextChars,
	          context_est_tokens: contextEstTokens,
	          context_token_budget: recallParsed.context_token_budget ?? null,
	          context_char_budget: recallParsed.context_char_budget ?? null,
	          context_compaction_profile: recallParsed.context_compaction_profile ?? "balanced",
	          context_optimization_profile: planningOptimization.optimization_profile.requested,
	          context_optimization_profile_source: planningOptimization.optimization_profile.source,
	          context_budget_default_applied: contextBudgetDefaultApplied,
	          recall_engine_mode: env.RECALL_ENGINE_MODE,
	          stage1_ann_seed_count: recallOut.debug?.stage1?.ann_seed_count ?? null,
	          stage1_ann_ms: timings["stage1_candidates_ann"] ?? null,
	          stage1_hybrid_seed_count: recallOut.debug?.stage1?.hybrid_seed_count ?? null,
	          stage1_hybrid_ms: timings["stage1_candidates_hybrid"] ?? null,
	          stage1_exact_recovery_used: Number.isFinite(timings["stage1_candidates_exact_recovery"]),
	          stage1_exact_recovery_ms: timings["stage1_candidates_exact_recovery"] ?? null,
	          profile: adaptiveProfile.profile,
          profile_source: baseProfile.source,
          recall_mode: explicitMode.mode,
          recall_mode_profile: explicitMode.profile,
          recall_mode_applied: explicitMode.applied,
          recall_mode_reason: explicitMode.reason,
          recall_mode_source: explicitMode.source,
          class_aware_profile: classAwareProfile.profile,
          class_aware_enabled: classAwareProfile.enabled,
          class_aware_applied: classAwareProfile.applied,
          class_aware_reason: classAwareProfile.reason,
          class_aware_source: classAwareProfile.source,
          class_aware_workload_class: classAwareProfile.workload_class,
          class_aware_signals: classAwareProfile.signals,
          runtime_entropy_defaults_applied: runtimeEntropyRecallDefaults.applied,
          runtime_entropy_defaults_reason: runtimeEntropyRecallDefaults.reason,
          runtime_entropy_defaults_breadth: runtimeEntropyRecallDefaults.recall_breadth,
          runtime_entropy_verifier_defaults_applied: runtimeEntropyVerifierDefaults.applied,
          runtime_entropy_verifier_defaults_reason: runtimeEntropyVerifierDefaults.reason,
          runtime_entropy_verifier_defaults_schedule: runtimeEntropyVerifierDefaults.verifier_schedule,
          rules_considered: out.rules?.considered ?? 0,
          rules_matched: out.rules?.matched ?? 0,
          tools_selected: out.tools?.selection?.selected ?? null,
          return_layered_context: parsed.return_layered_context,
          execution_kernel_packet_source_mode: executionKernel.source_mode,
          execution_packet_v1_present: !!parsed.execution_packet_v1,
          execution_state_v1_present: !!parsed.execution_state_v1,
          ms,
          timings_ms: timings,
        },
      },
      "memory planning_context",
    );

    const effectiveStaticBlocks = buildEffectiveStaticBlocks({
      parsed,
      executionKernel,
      executionEvidenceContext,
    });
    const { layeredContext, costSignals } = buildLayeredContextArtifacts({
      parsed,
      recallParsed,
      recallOut,
      rules: out.rules,
      tools: out.tools,
      executionContext: planningExecutionContext,
      effectiveStaticBlocks,
      contextEstTokens,
      optimizationProfile: planningOptimization.optimization_profile,
    });
    projectDelegationLearningToLayeredContext({
      layeredContext,
      experienceIntelligence,
    });
    const plannerSurface = extractPlannerPacketSurface({ layeredContext, recall: recallOut });
    const persistedDelegationRecords = await loadPersistedDelegationRecordsForContext({
      liteWriteStore,
      scope: recallOut.scope,
      runId: parsed.run_id ?? null,
      executionPacket: executionKernel.packet,
      executionState: parsed.execution_state_v1 ?? null,
      consumerAgentId: parsed.consumer_agent_id ?? env.LITE_LOCAL_ACTOR_ID,
      consumerTeamId: parsed.consumer_team_id ?? null,
    });
    const executionTreeEffectSummary = buildExecutionTreeEffectSummary({
      executionTree: parsed.execution_tree_v1 ?? null,
      layeredContext,
    });
    const planningSummary = buildPlanningSummary({
      rules: out.rules,
      tools: out.tools,
      layered_context: layeredContext,
      planner_surface: plannerSurface,
      cost_signals: costSignals,
      context_est_tokens: contextEstTokens,
      context_compaction_profile: recallParsed.context_compaction_profile ?? "balanced",
      optimization_profile: planningOptimization.optimization_profile.requested,
      recall_mode: explicitMode.mode,
      experience_intelligence: experienceIntelligence,
      edit_boundary_context: parsed.edit_boundary_context ?? null,
      execution_evidence: parsed.execution_evidence,
      execution_tree: parsed.execution_tree_v1 ?? null,
    });
    const operatorProjection = buildContextOperatorProjection({
      returnLayeredContext: parsed.return_layered_context === true,
      experienceIntelligence,
      actionRetrievalGate:
        planningSummary.action_retrieval_gate && typeof planningSummary.action_retrieval_gate === "object"
          ? (planningSummary.action_retrieval_gate as Record<string, unknown>)
          : null,
      continuityGuidance:
        planningSummary.continuity_guidance && typeof planningSummary.continuity_guidance === "object"
          ? (planningSummary.continuity_guidance as Record<string, unknown>)
          : null,
    });
    const tenantIdOut = recallOut.tenant_id ?? recallParsed.tenant_id ?? env.MEMORY_TENANT_ID;
    await recordContextAssemblyTelemetrySafe({
      req,
      tenantId: tenantIdOut,
      scope: recallOut.scope,
      endpoint: "planning_context",
      latencyMs: ms,
      layeredContext,
      costSignals,
      selectionPolicy: recallOut?.context?.selection_policy ?? null,
    });

    return {
      tenant_id: tenantIdOut,
      scope: recallOut.scope,
      execution_kernel: buildExecutionKernelResponse(
        executionKernel.source_mode,
        parsed,
        runtimeVerification,
        plannerSurface,
        planningSummary.execution_tree_effect_summary ?? executionTreeEffectSummary,
      ),
      query: { text: q, embedding_provider: surfaceEmbedder.name },
      recall: {
        ...recallOut,
        trajectory: diagnostics.trajectory,
        observability: diagnostics.observability,
      },
      rules: out.rules,
      tools: out.tools ?? undefined,
      runtime_tool_hints: Array.isArray(recallOut.runtime_tool_hints) ? recallOut.runtime_tool_hints : [],
      ...buildPlannerPacketResponseSurface(plannerSurface, {
        packet_source_mode: executionKernel.source_mode,
        state_first_assembly: executionKernel.source_mode === "state_first",
        execution_packet_v1_present: !!parsed.execution_packet_v1,
        execution_state_v1_present: !!parsed.execution_state_v1,
      }, {
        tools: out.tools,
        cost_signals: costSignals,
        execution_packet: executionKernel.packet,
        execution_artifacts: parsed.execution_artifacts,
        execution_evidence: parsed.execution_evidence,
        delegation_records: persistedDelegationRecords,
        execution_tree: parsed.execution_tree_v1 ?? null,
        layered_context: layeredContext,
      }),
      planning_summary: planningSummary,
      aionis_guide_packet: buildAionisGuidePacketForContextRoute({
        tenantId: tenantIdOut,
        scope: recallOut.scope,
        surface: "planning_context",
        parsed,
        summary: planningSummary,
        executionEvidenceContext,
      }),
      aionis_learning_packet: buildAionisLearningPacketForContextRoute({
        tenantId: tenantIdOut,
        scope: recallOut.scope,
        surface: "planning_context",
        parsed,
        summary: planningSummary,
      }),
      operator_projection: operatorProjection,
      execution_evidence_context: executionEvidenceContext,
      layered_context: layeredContext,
      cost_signals: costSignals,
    };
  };
  const planningContextService: MemoryPlanningContextRouteService = {
    assemble: assemblePlanningContext,
  };

  app.post("/v1/memory/planning/context", async (req: ContextRuntimeRequest, reply: FastifyReply) => {
    const response = await planningContextService.assemble(req, reply);
    return reply.code(200).send(response);
  });

  app.post("/v1/memory/context/assemble", async (req: ContextRuntimeRequest, reply: FastifyReply) => {
    const surfaceEmbedder = resolveSurfaceEmbedder("context_assemble");

    const t0 = performance.now();
    const timings: Record<string, number> = {};
    const preparedRequest = await prepareSurfaceRequest({
      req,
      requestKind: "context_assemble",
      surface: "context_assemble",
      parse: ContextAssembleRequest.parse,
    });
    let parsed = preparedRequest.parsed;
    const explicitRecallKnobs = preparedRequest.explicitRecallKnobs;
    const baseProfile = preparedRequest.baseProfile;
    const explicitMode = preparedRequest.explicitMode;
    const classAwareProfile = preparedRequest.classAwareProfile;
    const contextBudgetDefaultApplied = preparedRequest.contextBudgetDefaultApplied;
    const runtimeEntropyRecallDefaults = preparedRequest.runtimeEntropyRecallDefaults;
    const runtimeEntropyVerifierDefaults = preparedRequest.runtimeEntropyVerifierDefaults;
    const wantDebugEmbeddings = preparedRequest.wantDebugEmbeddings;
    await enforceRecallSurfaceQuotas({
      req,
      reply,
      tenantId: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
      wantDebugEmbeddings,
    });

    const scope = preparedRequest.scope;
    const q = preparedRequest.q;

    let embedMs = 0;
    let embedCacheHit = false;
    let embedSingleflightJoin = false;
    let embedQueueWaitMs = 0;
    let embedBatchSize = 1;
    let recallParsed: ParsedMemoryRecall;
    const adaptiveExecution = await prepareAdaptiveRecallExecution({
      parsed,
      parse: ContextAssembleRequest.parse,
      profile: classAwareProfile.profile,
      explicitRecallKnobs,
      explicitMode,
    });
    const gate = adaptiveExecution.gate;
    parsed = adaptiveExecution.parsed;
    const adaptiveProfile = adaptiveExecution.adaptiveProfile;
    const adaptiveHardCap = adaptiveExecution.adaptiveHardCap;
    const assembleOptimization = applyContextOptimizationProfile(
      parsed,
      env.MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT === "off"
        ? null
        : env.MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT,
    );
    parsed = ContextAssembleRequest.parse(assembleOptimization.parsed);
    parsed = augmentTrajectoryAwareRequest({
      parsed,
      parse: ContextAssembleRequest.parse,
      defaultScope: env.MEMORY_SCOPE,
      defaultTenantId: env.MEMORY_TENANT_ID,
    }).parsed;
    const executionKernel = resolveExecutionKernelContext(parsed);
    const runtimeVerification = await resolveContextRuntimeVerification({
      parsed,
      executionKernel,
    });
    parsed = appendRuntimeVerificationEvidence({
      parsed,
      runtimeVerification,
      parse: ContextAssembleRequest.parse,
    });
    const executionContext = buildExecutionContinuityContext(parsed);
    const executionEvidenceContext = await buildDefaultExecutionEvidenceContext(parsed);

    let out: ContextAssembleRouteOutput;
    try {
      let vec: number[];
      const emb = await runRecallEmbedding({
        endpoint: "context_assemble",
        req,
        reply,
        provider: surfaceEmbedder,
        scope,
        tenantId: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        queryText: q,
      });
      vec = emb.vec;
      ({ embedMs, embedCacheHit, embedSingleflightJoin, embedQueueWaitMs, embedBatchSize } = toRecallEmbedMetrics(emb));

      recallParsed = buildRecallRequestFromQuery({
        scope,
        queryEmbedding: vec,
        parsed,
      });
      const auth = buildRecallAuth(req, wantDebugEmbeddings);
      const unsafeDropTrustAnchors = allowUnsafeDropTrustAnchors(req);
      const applyLayerPolicyToRetrieval = allowLayerPolicyRetrievalFiltering(req);
      const internalAllowL4Selection = allowInternalL4Serving(req);
      out = await runRecallWithStore({
        endpoint: "context_assemble",
        recallParsed,
        auth,
        timings,
        buildRuntimeOptions: () =>
          buildRecallRuntimeOptions({
            internalAllowL4Selection,
            unsafeDropTrustAnchors,
            applyLayerPolicyToRetrieval,
          }),
        finalize: async (recall) => {
          const rules = await maybeEvaluateContextRules({
            recallParsed,
            context: executionContext,
            includeShadow: parsed.include_shadow,
            rulesLimit: parsed.rules_limit,
            includeRules: parsed.include_rules,
          });
          const tools = await maybeSelectContextTools({
            recallParsed,
            parsed,
            context: executionContext,
          });
          return { recall, rules, tools };
        },
      });
    } finally {
      gate.release();
    }

    const ms = performance.now() - t0;
    const recallOut = out.recall;
    const diagnostics = buildRecallRouteDiagnostics({
      recallParsed,
      recallOut,
      tools: out.tools,
      timings,
      inflightWaitMs: gate.wait_ms,
      explicitMode,
      adaptiveProfile,
      adaptiveHardCap,
      runtimeEntropyRecallDefaults,
      runtimeEntropyVerifierDefaults,
      classAwareObservability: {
        workload_class: classAwareProfile.workload_class,
        profile: classAwareProfile.profile,
        enabled: classAwareProfile.enabled,
        applied: classAwareProfile.applied,
        reason: classAwareProfile.reason,
        source: classAwareProfile.source,
        signals: classAwareProfile.signals,
      },
    });
    const experienceIntelligence = await maybeBuildContextExperienceIntelligence({
      parsed,
      tools: out.tools,
    });
    const contextChars = diagnostics.contextChars;
    const contextEstTokens = diagnostics.contextEstTokens;

    const effectiveStaticBlocks = buildEffectiveStaticBlocks({
      parsed,
      executionKernel,
      executionEvidenceContext,
    });
    const { layeredContext, costSignals } = buildLayeredContextArtifacts({
      parsed,
      recallParsed,
      recallOut,
      rules: out.rules,
      tools: out.tools,
      executionContext: parsed.context,
      effectiveStaticBlocks,
      contextEstTokens,
      optimizationProfile: assembleOptimization.optimization_profile,
    });
    projectDelegationLearningToLayeredContext({
      layeredContext,
      experienceIntelligence,
    });
    const plannerSurface = extractPlannerPacketSurface({ layeredContext, recall: recallOut });
    const persistedDelegationRecords = await loadPersistedDelegationRecordsForContext({
      liteWriteStore,
      scope: recallOut.scope,
      runId: parsed.run_id ?? null,
      executionPacket: executionKernel.packet,
      executionState: parsed.execution_state_v1 ?? null,
      consumerAgentId: parsed.consumer_agent_id ?? env.LITE_LOCAL_ACTOR_ID,
      consumerTeamId: parsed.consumer_team_id ?? null,
    });
    const executionTreeEffectSummary = buildExecutionTreeEffectSummary({
      executionTree: parsed.execution_tree_v1 ?? null,
      layeredContext,
    });
    const assemblySummary = buildAssemblySummary({
      rules: out.rules,
      tools: out.tools,
      layered_context: layeredContext,
      planner_surface: plannerSurface,
      cost_signals: costSignals,
      context_est_tokens: contextEstTokens,
      context_compaction_profile: recallParsed.context_compaction_profile ?? "balanced",
      optimization_profile: assembleOptimization.optimization_profile.requested,
      recall_mode: explicitMode.mode,
      include_rules: parsed.include_rules,
      experience_intelligence: experienceIntelligence,
      edit_boundary_context: parsed.edit_boundary_context ?? null,
      execution_evidence: parsed.execution_evidence,
      execution_tree: parsed.execution_tree_v1 ?? null,
    });
    const operatorProjection = buildContextOperatorProjection({
      returnLayeredContext: parsed.return_layered_context === true,
      experienceIntelligence,
      actionRetrievalGate:
        assemblySummary.action_retrieval_gate && typeof assemblySummary.action_retrieval_gate === "object"
          ? (assemblySummary.action_retrieval_gate as Record<string, unknown>)
          : null,
      continuityGuidance:
        assemblySummary.continuity_guidance && typeof assemblySummary.continuity_guidance === "object"
          ? (assemblySummary.continuity_guidance as Record<string, unknown>)
          : null,
    });
    const tenantIdOut = recallOut.tenant_id ?? recallParsed.tenant_id ?? env.MEMORY_TENANT_ID;
    await recordContextAssemblyTelemetrySafe({
      req,
      tenantId: tenantIdOut,
      scope: recallOut.scope,
      endpoint: "context_assemble",
      latencyMs: ms,
      layeredContext,
      costSignals,
      selectionPolicy: recallOut?.context?.selection_policy ?? null,
    });

    req.log.info(
      {
        context_assemble: {
          scope: recallOut.scope,
          tenant_id: tenantIdOut,
          include_rules: parsed.include_rules,
          include_shadow: parsed.include_shadow,
          rules_limit: parsed.rules_limit,
          has_tool_candidates: Array.isArray(parsed.tool_candidates) && parsed.tool_candidates.length > 0,
          tool_candidates: parsed.tool_candidates?.length ?? 0,
          return_layered_context: parsed.return_layered_context,
          execution_kernel_packet_source_mode: executionKernel.source_mode,
          execution_packet_v1_present: !!parsed.execution_packet_v1,
          execution_state_v1_present: !!parsed.execution_state_v1,
          embed_ms: embedMs,
          embed_cache_hit: embedCacheHit,
          embed_singleflight_join: embedSingleflightJoin,
          embed_queue_wait_ms: embedQueueWaitMs,
          embed_batch_size: embedBatchSize,
          context_chars: contextChars,
	          context_est_tokens: contextEstTokens,
	          context_token_budget: recallParsed.context_token_budget ?? null,
	          context_char_budget: recallParsed.context_char_budget ?? null,
	          context_compaction_profile: recallParsed.context_compaction_profile ?? "balanced",
	          context_optimization_profile: assembleOptimization.optimization_profile.requested,
	          context_optimization_profile_source: assembleOptimization.optimization_profile.source,
	          context_budget_default_applied: contextBudgetDefaultApplied,
	          recall_engine_mode: env.RECALL_ENGINE_MODE,
	          stage1_ann_seed_count: recallOut.debug?.stage1?.ann_seed_count ?? null,
	          stage1_ann_ms: timings["stage1_candidates_ann"] ?? null,
	          stage1_hybrid_seed_count: recallOut.debug?.stage1?.hybrid_seed_count ?? null,
	          stage1_hybrid_ms: timings["stage1_candidates_hybrid"] ?? null,
	          stage1_exact_recovery_used: Number.isFinite(timings["stage1_candidates_exact_recovery"]),
	          stage1_exact_recovery_ms: timings["stage1_candidates_exact_recovery"] ?? null,
	          profile: adaptiveProfile.profile,
          profile_source: baseProfile.source,
          recall_mode: explicitMode.mode,
          recall_mode_profile: explicitMode.profile,
          recall_mode_applied: explicitMode.applied,
          recall_mode_reason: explicitMode.reason,
          recall_mode_source: explicitMode.source,
          class_aware_profile: classAwareProfile.profile,
          class_aware_enabled: classAwareProfile.enabled,
          class_aware_applied: classAwareProfile.applied,
          class_aware_reason: classAwareProfile.reason,
          class_aware_source: classAwareProfile.source,
          class_aware_workload_class: classAwareProfile.workload_class,
          class_aware_signals: classAwareProfile.signals,
          runtime_entropy_defaults_applied: runtimeEntropyRecallDefaults.applied,
          runtime_entropy_defaults_reason: runtimeEntropyRecallDefaults.reason,
          runtime_entropy_defaults_breadth: runtimeEntropyRecallDefaults.recall_breadth,
          runtime_entropy_verifier_defaults_applied: runtimeEntropyVerifierDefaults.applied,
          runtime_entropy_verifier_defaults_reason: runtimeEntropyVerifierDefaults.reason,
          runtime_entropy_verifier_defaults_schedule: runtimeEntropyVerifierDefaults.verifier_schedule,
          rules_considered: out.rules?.considered ?? 0,
          rules_matched: out.rules?.matched ?? 0,
          tools_selected: out.tools?.selection?.selected ?? null,
          ms,
          timings_ms: timings,
        },
      },
      "memory context_assemble",
    );

    return reply.code(200).send({
      tenant_id: tenantIdOut,
      scope: recallOut.scope,
      execution_kernel: buildExecutionKernelResponse(
        executionKernel.source_mode,
        parsed,
        runtimeVerification,
        plannerSurface,
        assemblySummary.execution_tree_effect_summary ?? executionTreeEffectSummary,
      ),
      query: { text: q, embedding_provider: surfaceEmbedder.name },
      recall: {
        ...recallOut,
        trajectory: diagnostics.trajectory,
        observability: diagnostics.observability,
      },
      rules: out.rules ?? undefined,
      tools: out.tools ?? undefined,
      runtime_tool_hints: Array.isArray(recallOut.runtime_tool_hints) ? recallOut.runtime_tool_hints : [],
      ...buildPlannerPacketResponseSurface(plannerSurface, {
        packet_source_mode: executionKernel.source_mode,
        state_first_assembly: executionKernel.source_mode === "state_first",
        execution_packet_v1_present: !!parsed.execution_packet_v1,
        execution_state_v1_present: !!parsed.execution_state_v1,
      }, {
        tools: out.tools,
        cost_signals: costSignals,
        execution_packet: executionKernel.packet,
        execution_artifacts: parsed.execution_artifacts,
        execution_evidence: parsed.execution_evidence,
        delegation_records: persistedDelegationRecords,
        execution_tree: parsed.execution_tree_v1 ?? null,
        layered_context: layeredContext,
      }),
      assembly_summary: assemblySummary,
      aionis_guide_packet: buildAionisGuidePacketForContextRoute({
        tenantId: tenantIdOut,
        scope: recallOut.scope,
        surface: "context_assemble",
        parsed,
        summary: assemblySummary,
        executionEvidenceContext,
      }),
      aionis_learning_packet: buildAionisLearningPacketForContextRoute({
        tenantId: tenantIdOut,
        scope: recallOut.scope,
        surface: "context_assemble",
        parsed,
        summary: assemblySummary,
      }),
      operator_projection: operatorProjection,
      execution_evidence_context: executionEvidenceContext,
      layered_context: layeredContext,
      cost_signals: costSignals,
    });
  });

  return {
    planningContextService,
  };
}
