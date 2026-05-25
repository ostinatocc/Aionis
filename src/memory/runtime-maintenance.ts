import { z } from "zod";
import {
  LearningLoopModeSchema,
  LearningLoopActionSchema,
  LearningLoopRunResponseSchema,
  LearningLoopSurfaceSchema,
  runLearningLoopLite,
  type ForgettingMutationPolicy,
  type LearningLoopAction,
  type LearningLoopLiteOptions,
  type LearningLoopSurface,
} from "./learning-loop.js";
import {
  resolveNodeArchiveRelocationSurface,
  resolveNodeExecutionKind,
  resolveNodePatternExecutionSurface,
  resolveNodePolicyMemorySurface,
  resolveNodeSemanticForgettingSurface,
  resolveNodeWorkflowPromotionSurface,
} from "./node-execution-surface.js";
import {
  hasExplicitMaintenanceProfile,
  runtimeEntropyMaintenanceDefaultsApplication,
} from "./runtime-entropy-route-defaults.js";
import { buildRuntimeSignalTrendSummaryFromRows } from "./runtime-signal-trends.js";
import { buildPromotionQualitySummaryFromRows } from "./promotion-quality-summary.js";
import { buildRuntimeEffectSummaryFromRows } from "./runtime-effect-summary.js";
import { PromotionQualitySummaryV1Schema, RuntimeEffectSummaryV1Schema, RuntimeSignalTrendSummaryV1Schema } from "./schemas.js";
import { resolveTenantScope } from "./tenant.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";

const MemoryTierCountsSchema = z.object({
  hot: z.number().int().min(0),
  warm: z.number().int().min(0),
  cold: z.number().int().min(0),
  archive: z.number().int().min(0),
  other: z.number().int().min(0),
});

const MemoryTierDeltaSchema = z.object({
  hot: z.number().int(),
  warm: z.number().int(),
  cold: z.number().int(),
  archive: z.number().int(),
  other: z.number().int(),
});

const WorkflowCountsSchema = z.object({
  candidate: z.number().int().min(0),
  stable: z.number().int().min(0),
  other: z.number().int().min(0),
});

const WorkflowDeltaSchema = z.object({
  candidate: z.number().int(),
  stable: z.number().int(),
  other: z.number().int(),
});

const PolicyMemoryCountsSchema = z.object({
  active: z.number().int().min(0),
  contested: z.number().int().min(0),
  retired: z.number().int().min(0),
  missing: z.number().int().min(0),
});

const PolicyMemoryDeltaSchema = z.object({
  active: z.number().int(),
  contested: z.number().int(),
  retired: z.number().int(),
  missing: z.number().int(),
});

const PatternCountsSchema = z.object({
  candidate: z.number().int().min(0),
  trusted: z.number().int().min(0),
  contested: z.number().int().min(0),
  missing: z.number().int().min(0),
});

const PatternDeltaSchema = z.object({
  candidate: z.number().int(),
  trusted: z.number().int(),
  contested: z.number().int(),
  missing: z.number().int(),
});

const SemanticForgettingActionCountsSchema = z.object({
  retain: z.number().int().min(0),
  demote: z.number().int().min(0),
  archive: z.number().int().min(0),
  review: z.number().int().min(0),
  missing: z.number().int().min(0),
});

const SemanticForgettingActionDeltaSchema = z.object({
  retain: z.number().int(),
  demote: z.number().int(),
  archive: z.number().int(),
  review: z.number().int(),
  missing: z.number().int(),
});

const ArchiveRelocationStateCountsSchema = z.object({
  none: z.number().int().min(0),
  candidate: z.number().int().min(0),
  cold_archive: z.number().int().min(0),
  missing: z.number().int().min(0),
});

const ArchiveRelocationStateDeltaSchema = z.object({
  none: z.number().int(),
  candidate: z.number().int(),
  cold_archive: z.number().int(),
  missing: z.number().int(),
});

const LearningLoopActionCountsSchema = z.object({
  promote_workflow: z.number().int().min(0),
  retire_policy: z.number().int().min(0),
  demote_memory: z.number().int().min(0),
  archive_memory: z.number().int().min(0),
  monitor: z.number().int().min(0),
  skip: z.number().int().min(0),
  missing: z.number().int().min(0),
});

const LearningLoopActionDeltaSchema = z.object({
  promote_workflow: z.number().int(),
  retire_policy: z.number().int(),
  demote_memory: z.number().int(),
  archive_memory: z.number().int(),
  monitor: z.number().int(),
  skip: z.number().int(),
  missing: z.number().int(),
});

const RuntimeMaintenanceReuseSummarySchema = z.object({
  nodes_with_feedback: z.number().int().min(0),
  nodes_with_activation: z.number().int().min(0),
  feedback_positive_total: z.number().int().min(0),
  feedback_negative_total: z.number().int().min(0),
  usage_count_total: z.number().int().min(0),
  reuse_success_total: z.number().int().min(0),
  reuse_failure_total: z.number().int().min(0),
});

const RuntimeMaintenanceReuseDeltaSchema = z.object({
  nodes_with_feedback: z.number().int(),
  nodes_with_activation: z.number().int(),
  feedback_positive_total: z.number().int(),
  feedback_negative_total: z.number().int(),
  usage_count_total: z.number().int(),
  reuse_success_total: z.number().int(),
  reuse_failure_total: z.number().int(),
});

const RuntimeMaintenanceSnapshotSchema = z.object({
  snapshot_version: z.literal("runtime_maintenance_snapshot_v1"),
  scan_limit: z.number().int().positive(),
  scanned_nodes: z.number().int().min(0),
  truncated: z.boolean(),
  tier_counts: MemoryTierCountsSchema,
  workflow_counts: WorkflowCountsSchema,
  policy_memory_counts: PolicyMemoryCountsSchema,
  pattern_counts: PatternCountsSchema,
  semantic_forgetting_action_counts: SemanticForgettingActionCountsSchema,
  archive_relocation_state_counts: ArchiveRelocationStateCountsSchema,
  learning_loop_action_counts: LearningLoopActionCountsSchema,
  reuse_signal_summary: RuntimeMaintenanceReuseSummarySchema,
  runtime_signal_trend_summary: RuntimeSignalTrendSummaryV1Schema,
  promotion_quality_summary: PromotionQualitySummaryV1Schema,
  runtime_effect_summary: RuntimeEffectSummaryV1Schema,
  source_code_change_allowed: z.literal(false),
});
export type RuntimeMaintenanceSnapshot = z.infer<typeof RuntimeMaintenanceSnapshotSchema>;

const RuntimeMaintenanceDeltaSchema = z.object({
  delta_version: z.literal("runtime_maintenance_delta_v1"),
  tier_counts: MemoryTierDeltaSchema,
  workflow_counts: WorkflowDeltaSchema,
  policy_memory_counts: PolicyMemoryDeltaSchema,
  pattern_counts: PatternDeltaSchema,
  semantic_forgetting_action_counts: SemanticForgettingActionDeltaSchema,
  archive_relocation_state_counts: ArchiveRelocationStateDeltaSchema,
  learning_loop_action_counts: LearningLoopActionDeltaSchema,
  reuse_signal_summary: RuntimeMaintenanceReuseDeltaSchema,
  source_code_change_allowed: z.literal(false),
});
export type RuntimeMaintenanceDelta = z.infer<typeof RuntimeMaintenanceDeltaSchema>;

const RuntimeMaintenanceEffectSummarySchema = z.object({
  effect_summary_version: z.literal("runtime_maintenance_effect_summary_v1"),
  memory_reuse_signals: RuntimeMaintenanceReuseSummarySchema,
  workflow_promotions: z.number().int().min(0),
  policy_retirements: z.number().int().min(0),
  memory_demotions: z.number().int().min(0),
  memory_archives: z.number().int().min(0),
  hot_visibility_delta: z.number().int(),
  archive_visibility_delta: z.number().int(),
  source_code_change_allowed: z.literal(false),
});
export type RuntimeMaintenanceEffectSummary = z.infer<typeof RuntimeMaintenanceEffectSummarySchema>;

const RuntimeMaintenanceProfileSchema = z.enum(["immediate", "daily", "long_horizon"]);

const RuntimeEntropyMaintenanceDefaultsApplicationSchema = z.object({
  application_version: z.literal("runtime_entropy_maintenance_defaults_v1"),
  applied: z.boolean(),
  reason: z.enum([
    "applied",
    "no_runtime_entropy_controls",
    "invalid_runtime_entropy_controls",
    "explicit_maintenance_profile",
  ]),
  controls_version: z.literal("runtime_entropy_controls_v1").nullable(),
  recommended_profile: RuntimeMaintenanceProfileSchema.nullable(),
  run_after_task: z.boolean().nullable(),
  defaults: z.object({
    maintenance_profile: RuntimeMaintenanceProfileSchema.optional(),
  }).strict(),
}).strict();

const RuntimeMaintenanceDecisionDiagnosticsSchema = z.object({
  diagnostics_version: z.literal("runtime_maintenance_decision_diagnostics_v1"),
  decision_count: z.number().int().min(0),
  applied_count: z.number().int().min(0),
  monitor_count: z.number().int().min(0),
  skip_count: z.number().int().min(0),
  dry_run_mutation_candidate_count: z.number().int().min(0),
  forgetting_signal_count: z.number().int().min(0),
  forgetting_mutation_candidate_count: z.number().int().min(0),
  blocked_mutation_count: z.number().int().min(0),
  fresh_low_level_protected_count: z.number().int().min(0),
  stale_low_level_mutation_count: z.number().int().min(0),
  high_level_mutation_count: z.number().int().min(0),
  explicit_lifecycle_mutation_count: z.number().int().min(0),
  profile_policy_decision_count: z.number().int().min(0),
  source_code_change_allowed: z.literal(false),
});
export type RuntimeMaintenanceDecisionDiagnostics = z.infer<typeof RuntimeMaintenanceDecisionDiagnosticsSchema>;

const RuntimeMaintenanceRunDiagnosticsSchema = z.object({
  diagnostics_version: z.literal("runtime_maintenance_run_diagnostics_v1"),
  maintenance_profile: RuntimeMaintenanceProfileSchema,
  effective_surfaces: z.array(LearningLoopSurfaceSchema).min(1).max(4),
  effective_limit: z.number().int().positive().max(100),
  effective_max_mutations: z.number().int().positive().max(50),
  effective_snapshot_limit: z.number().int().positive().max(2_000),
  before_truncated: z.boolean(),
  after_truncated: z.boolean(),
  decisions: RuntimeMaintenanceDecisionDiagnosticsSchema,
  source_code_change_allowed: z.literal(false),
});
export type RuntimeMaintenanceRunDiagnostics = z.infer<typeof RuntimeMaintenanceRunDiagnosticsSchema>;

const RuntimeMaintenanceProfilePolicySchema = z.object({
  profile_policy_version: z.literal("runtime_maintenance_profile_policy_v1"),
  maintenance_profile: RuntimeMaintenanceProfileSchema,
  default_surfaces: z.array(LearningLoopSurfaceSchema).min(1).max(4),
  default_limit: z.number().int().positive().max(100),
  default_max_mutations: z.number().int().positive().max(50),
  default_snapshot_limit: z.number().int().positive().max(2_000),
  low_level_grace_hours: z.number().int().min(0).max(24 * 365),
  allow_low_level_stale_mutation: z.boolean(),
  allow_high_level_mutation: z.boolean(),
  allow_explicit_lifecycle_mutation: z.boolean(),
  intent: z.string().min(1).max(256),
  source_code_change_allowed: z.literal(false),
});
export type RuntimeMaintenanceProfile = z.infer<typeof RuntimeMaintenanceProfileSchema>;
export type RuntimeMaintenanceProfilePolicy = z.infer<typeof RuntimeMaintenanceProfilePolicySchema>;

export const RuntimeMaintenanceRunRequestSchema = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  mode: LearningLoopModeSchema.default("apply"),
  maintenance_profile: RuntimeMaintenanceProfileSchema.default("immediate"),
  surfaces: z.array(LearningLoopSurfaceSchema).min(1).max(4).optional(),
  limit: z.number().int().positive().max(100).optional(),
  max_mutations: z.number().int().positive().max(50).optional(),
  snapshot_limit: z.number().int().positive().max(2_000).optional(),
}).strict();
export type RuntimeMaintenanceRunRequest = z.infer<typeof RuntimeMaintenanceRunRequestSchema>;

export const RuntimeMaintenanceRunResponseSchema = z.object({
  ok: z.literal(true),
  run_version: z.literal("runtime_maintenance_run_v1"),
  tenant_id: z.string().min(1),
  scope: z.string().min(1),
  actor: z.string().min(1),
  mode: LearningLoopModeSchema,
  maintenance_profile: RuntimeMaintenanceProfileSchema,
  profile_policy: RuntimeMaintenanceProfilePolicySchema,
  before: RuntimeMaintenanceSnapshotSchema,
  learning_loop: LearningLoopRunResponseSchema,
  after: RuntimeMaintenanceSnapshotSchema,
  delta: RuntimeMaintenanceDeltaSchema,
  effect_summary: RuntimeMaintenanceEffectSummarySchema,
  runtime_entropy_maintenance_defaults: RuntimeEntropyMaintenanceDefaultsApplicationSchema,
  diagnostics: RuntimeMaintenanceRunDiagnosticsSchema,
  applied_count: z.number().int().min(0),
  source_code_change_allowed: z.literal(false),
});
export type RuntimeMaintenanceRunResponse = z.infer<typeof RuntimeMaintenanceRunResponseSchema>;

type RuntimeMaintenanceLiteStore = Pick<LiteWriteStore, "findNodes"> & Parameters<typeof runLearningLoopLite>[0];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nonNegativeInt(value: unknown): number {
  return Math.max(0, Math.trunc(firstNumber(value) ?? 0));
}

function runtimeMaintenanceProfilePolicy(profile: RuntimeMaintenanceProfile): RuntimeMaintenanceProfilePolicy {
  if (profile === "daily") {
    return RuntimeMaintenanceProfilePolicySchema.parse({
      profile_policy_version: "runtime_maintenance_profile_policy_v1",
      maintenance_profile: "daily",
      default_surfaces: ["workflow", "pattern", "policy", "forgetting"],
      default_limit: 100,
      default_max_mutations: 50,
      default_snapshot_limit: 1_000,
      low_level_grace_hours: 24,
      allow_low_level_stale_mutation: true,
      allow_high_level_mutation: true,
      allow_explicit_lifecycle_mutation: true,
      intent: "Daily maintenance may cool stale low-level execution memory while preserving fresh continuity material.",
      source_code_change_allowed: false,
    });
  }
  if (profile === "long_horizon") {
    return RuntimeMaintenanceProfilePolicySchema.parse({
      profile_policy_version: "runtime_maintenance_profile_policy_v1",
      maintenance_profile: "long_horizon",
      default_surfaces: ["policy", "forgetting"],
      default_limit: 100,
      default_max_mutations: 50,
      default_snapshot_limit: 2_000,
      low_level_grace_hours: 24 * 7,
      allow_low_level_stale_mutation: true,
      allow_high_level_mutation: true,
      allow_explicit_lifecycle_mutation: true,
      intent: "Long-horizon maintenance focuses on mature policy and forgetting decisions before deeper compaction.",
      source_code_change_allowed: false,
    });
  }
  return RuntimeMaintenanceProfilePolicySchema.parse({
    profile_policy_version: "runtime_maintenance_profile_policy_v1",
    maintenance_profile: "immediate",
    default_surfaces: ["workflow", "pattern", "policy", "forgetting"],
    default_limit: 40,
    default_max_mutations: 20,
    default_snapshot_limit: 500,
    low_level_grace_hours: 24,
    allow_low_level_stale_mutation: true,
    allow_high_level_mutation: true,
    allow_explicit_lifecycle_mutation: true,
    intent: "Immediate post-run maintenance records closed-loop signals without cooling fresh execution continuity.",
    source_code_change_allowed: false,
  });
}

function learningLoopForgettingPolicy(profilePolicy: RuntimeMaintenanceProfilePolicy): ForgettingMutationPolicy {
  return {
    policy_id: `runtime_maintenance_${profilePolicy.maintenance_profile}`,
    low_level_grace_hours: profilePolicy.low_level_grace_hours,
    allow_low_level_stale_mutation: profilePolicy.allow_low_level_stale_mutation,
    allow_high_level_mutation: profilePolicy.allow_high_level_mutation,
    allow_explicit_lifecycle_mutation: profilePolicy.allow_explicit_lifecycle_mutation,
    source_code_change_allowed: false,
  };
}

function zeroCounts<const T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
}

function incrementCounter<T extends string>(counts: Record<T, number>, key: T) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function deltaCounts<T extends string>(
  before: Record<T, number>,
  after: Record<T, number>,
): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const key of Object.keys(before) as T[]) {
    out[key] = (after[key] ?? 0) - (before[key] ?? 0);
  }
  return out;
}

function actionFromSlots(slots: Record<string, unknown>): LearningLoopAction | "missing" {
  const action = firstString(asRecord(slots.learning_loop_v1)?.action);
  const parsed = LearningLoopActionSchema.safeParse(action);
  return parsed.success ? parsed.data : "missing";
}

function nodeAnchorMetrics(slots: Record<string, unknown>): Record<string, unknown> {
  const anchor = asRecord(slots.anchor_v1);
  return asRecord(anchor?.metrics) ?? {};
}

function updateReuseSignals(args: {
  row: LiteFindNodeRow;
  reuse: RuntimeMaintenanceSnapshot["reuse_signal_summary"];
}) {
  const slots = args.row.slots ?? {};
  const metrics = nodeAnchorMetrics(slots);
  const feedbackPositive = nonNegativeInt(slots.feedback_positive);
  const feedbackNegative = nonNegativeInt(slots.feedback_negative);
  const usageCount = nonNegativeInt(metrics.usage_count);
  const reuseSuccess = nonNegativeInt(metrics.reuse_success_count);
  const reuseFailure = nonNegativeInt(metrics.reuse_failure_count);
  args.reuse.feedback_positive_total += feedbackPositive;
  args.reuse.feedback_negative_total += feedbackNegative;
  args.reuse.usage_count_total += usageCount;
  args.reuse.reuse_success_total += reuseSuccess;
  args.reuse.reuse_failure_total += reuseFailure;
  if (feedbackPositive > 0 || feedbackNegative > 0) args.reuse.nodes_with_feedback += 1;
  if (
    firstString(
      slots.last_activated_at,
      slots.last_feedback_at,
      metrics.last_used_at,
      args.row.last_activated,
    )
  ) {
    args.reuse.nodes_with_activation += 1;
  }
}

async function scanMaintenanceNodes(args: {
  store: RuntimeMaintenanceLiteStore;
  scope: string;
  actor: string;
  snapshotLimit: number;
}): Promise<{ rows: LiteFindNodeRow[]; truncated: boolean }> {
  const rows: LiteFindNodeRow[] = [];
  let offset = 0;
  const pageSize = Math.min(100, args.snapshotLimit);
  let truncated = false;
  while (rows.length < args.snapshotLimit) {
    const page = await args.store.findNodes({
      scope: args.scope,
      consumerAgentId: args.actor,
      consumerTeamId: null,
      limit: Math.min(pageSize, args.snapshotLimit - rows.length),
      offset,
    });
    rows.push(...page.rows);
    offset += page.rows.length;
    if (!page.has_more || page.rows.length === 0) break;
    if (rows.length >= args.snapshotLimit) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated };
}

async function buildMaintenanceSnapshot(args: {
  store: RuntimeMaintenanceLiteStore;
  scope: string;
  actor: string;
  snapshotLimit: number;
}): Promise<RuntimeMaintenanceSnapshot> {
  const { rows, truncated } = await scanMaintenanceNodes(args);
  const tierCounts = zeroCounts(["hot", "warm", "cold", "archive", "other"] as const);
  const workflowCounts = zeroCounts(["candidate", "stable", "other"] as const);
  const policyCounts = zeroCounts(["active", "contested", "retired", "missing"] as const);
  const patternCounts = zeroCounts(["candidate", "trusted", "contested", "missing"] as const);
  const semanticCounts = zeroCounts(["retain", "demote", "archive", "review", "missing"] as const);
  const archiveCounts = zeroCounts(["none", "candidate", "cold_archive", "missing"] as const);
  const loopActionCounts = zeroCounts([
    "promote_workflow",
    "retire_policy",
    "demote_memory",
    "archive_memory",
    "monitor",
    "skip",
    "missing",
  ] as const);
  const reuse: RuntimeMaintenanceSnapshot["reuse_signal_summary"] = {
    nodes_with_feedback: 0,
    nodes_with_activation: 0,
    feedback_positive_total: 0,
    feedback_negative_total: 0,
    usage_count_total: 0,
    reuse_success_total: 0,
    reuse_failure_total: 0,
  };

  for (const row of rows) {
    const tier = row.tier === "hot" || row.tier === "warm" || row.tier === "cold" || row.tier === "archive"
      ? row.tier
      : "other";
    incrementCounter(tierCounts, tier);

    const executionKind = resolveNodeExecutionKind(row.slots);
    const workflowPromotion = resolveNodeWorkflowPromotionSurface(row.slots);
    const promotionState = firstString(workflowPromotion?.promotion_state);
    if (executionKind === "workflow_candidate" || promotionState === "candidate") {
      incrementCounter(workflowCounts, "candidate");
    } else if (executionKind === "workflow_anchor" || promotionState === "stable") {
      incrementCounter(workflowCounts, "stable");
    } else {
      incrementCounter(workflowCounts, "other");
    }

    const policyState = resolveNodePolicyMemorySurface(row.slots).policy_memory_state ?? "missing";
    incrementCounter(policyCounts, policyState);

    const patternState = resolveNodePatternExecutionSurface({ slots: row.slots }).credibility_state ?? "missing";
    incrementCounter(patternCounts, patternState);

    const semanticAction = resolveNodeSemanticForgettingSurface(row.slots).action ?? "missing";
    incrementCounter(semanticCounts, semanticAction);

    const archiveState = resolveNodeArchiveRelocationSurface(row.slots).relocation_state ?? "missing";
    incrementCounter(archiveCounts, archiveState);

    incrementCounter(loopActionCounts, actionFromSlots(row.slots));
    updateReuseSignals({ row, reuse });
  }

  return RuntimeMaintenanceSnapshotSchema.parse({
    snapshot_version: "runtime_maintenance_snapshot_v1",
    scan_limit: args.snapshotLimit,
    scanned_nodes: rows.length,
    truncated,
    tier_counts: tierCounts,
    workflow_counts: workflowCounts,
    policy_memory_counts: policyCounts,
    pattern_counts: patternCounts,
    semantic_forgetting_action_counts: semanticCounts,
    archive_relocation_state_counts: archiveCounts,
    learning_loop_action_counts: loopActionCounts,
    reuse_signal_summary: reuse,
    runtime_signal_trend_summary: buildRuntimeSignalTrendSummaryFromRows({ rows, truncated }),
    promotion_quality_summary: buildPromotionQualitySummaryFromRows({ rows, truncated }),
    runtime_effect_summary: buildRuntimeEffectSummaryFromRows({ rows, truncated }),
    source_code_change_allowed: false,
  });
}

function buildMaintenanceDelta(
  before: RuntimeMaintenanceSnapshot,
  after: RuntimeMaintenanceSnapshot,
): RuntimeMaintenanceDelta {
  return RuntimeMaintenanceDeltaSchema.parse({
    delta_version: "runtime_maintenance_delta_v1",
    tier_counts: deltaCounts(before.tier_counts, after.tier_counts),
    workflow_counts: deltaCounts(before.workflow_counts, after.workflow_counts),
    policy_memory_counts: deltaCounts(before.policy_memory_counts, after.policy_memory_counts),
    pattern_counts: deltaCounts(before.pattern_counts, after.pattern_counts),
    semantic_forgetting_action_counts: deltaCounts(
      before.semantic_forgetting_action_counts,
      after.semantic_forgetting_action_counts,
    ),
    archive_relocation_state_counts: deltaCounts(
      before.archive_relocation_state_counts,
      after.archive_relocation_state_counts,
    ),
    learning_loop_action_counts: deltaCounts(before.learning_loop_action_counts, after.learning_loop_action_counts),
    reuse_signal_summary: deltaCounts(before.reuse_signal_summary, after.reuse_signal_summary),
    source_code_change_allowed: false,
  });
}

function buildEffectSummary(args: {
  learningLoop: z.infer<typeof LearningLoopRunResponseSchema>;
  after: RuntimeMaintenanceSnapshot;
  delta: RuntimeMaintenanceDelta;
}): RuntimeMaintenanceEffectSummary {
  const applied = args.learningLoop.decisions.filter((entry) => entry.applied);
  const countApplied = (action: LearningLoopAction) =>
    applied.filter((entry) => entry.action === action).length;
  return RuntimeMaintenanceEffectSummarySchema.parse({
    effect_summary_version: "runtime_maintenance_effect_summary_v1",
    memory_reuse_signals: args.after.reuse_signal_summary,
    workflow_promotions: countApplied("promote_workflow"),
    policy_retirements: countApplied("retire_policy"),
    memory_demotions: countApplied("demote_memory"),
    memory_archives: countApplied("archive_memory"),
    hot_visibility_delta: args.delta.tier_counts.hot,
    archive_visibility_delta: args.delta.tier_counts.archive,
    source_code_change_allowed: false,
  });
}

function isMutationAction(action: LearningLoopAction): boolean {
  return action === "promote_workflow"
    || action === "retire_policy"
    || action === "demote_memory"
    || action === "archive_memory";
}

function hasReason(entry: z.infer<typeof LearningLoopRunResponseSchema>["decisions"][number], reason: string): boolean {
  return entry.reasons.includes(reason);
}

function hasReasonPrefix(entry: z.infer<typeof LearningLoopRunResponseSchema>["decisions"][number], prefix: string): boolean {
  return entry.reasons.some((reason) => reason.startsWith(prefix));
}

function buildDecisionDiagnostics(
  learningLoop: z.infer<typeof LearningLoopRunResponseSchema>,
): RuntimeMaintenanceDecisionDiagnostics {
  const decisions = learningLoop.decisions;
  const forgettingDecisions = decisions.filter((entry) => entry.surface === "forgetting");
  return RuntimeMaintenanceDecisionDiagnosticsSchema.parse({
    diagnostics_version: "runtime_maintenance_decision_diagnostics_v1",
    decision_count: decisions.length,
    applied_count: decisions.filter((entry) => entry.applied).length,
    monitor_count: decisions.filter((entry) => entry.action === "monitor").length,
    skip_count: decisions.filter((entry) => entry.action === "skip").length,
    dry_run_mutation_candidate_count: decisions.filter((entry) =>
      entry.mode === "dry_run" && !entry.applied && isMutationAction(entry.action)
    ).length,
    forgetting_signal_count: forgettingDecisions.filter((entry) =>
      hasReasonPrefix(entry, "semantic_action_") && !hasReason(entry, "missing_semantic_forgetting_action")
    ).length,
    forgetting_mutation_candidate_count: forgettingDecisions.filter((entry) =>
      entry.action === "demote_memory" || entry.action === "archive_memory"
    ).length,
    blocked_mutation_count: decisions.filter((entry) => hasReason(entry, "maintenance_mutation_not_admissible")).length,
    fresh_low_level_protected_count: decisions.filter((entry) => hasReason(entry, "fresh_low_level_memory_grace_period")).length,
    stale_low_level_mutation_count: decisions.filter((entry) => hasReason(entry, "memory_age_exceeds_forgetting_grace_period")).length,
    high_level_mutation_count: decisions.filter((entry) => hasReason(entry, "high_level_cognitive_memory_surface")).length,
    explicit_lifecycle_mutation_count: decisions.filter((entry) => hasReason(entry, "explicit_lifecycle_or_feedback_signal")).length,
    profile_policy_decision_count: decisions.filter((entry) => hasReasonPrefix(entry, "forgetting_mutation_policy_")).length,
    source_code_change_allowed: false,
  });
}

function buildRunDiagnostics(args: {
  maintenanceProfile: RuntimeMaintenanceProfile;
  effectiveSurfaces: LearningLoopSurface[];
  effectiveLimit: number;
  effectiveMaxMutations: number;
  effectiveSnapshotLimit: number;
  before: RuntimeMaintenanceSnapshot;
  learningLoop: z.infer<typeof LearningLoopRunResponseSchema>;
  after: RuntimeMaintenanceSnapshot;
}): RuntimeMaintenanceRunDiagnostics {
  return RuntimeMaintenanceRunDiagnosticsSchema.parse({
    diagnostics_version: "runtime_maintenance_run_diagnostics_v1",
    maintenance_profile: args.maintenanceProfile,
    effective_surfaces: args.effectiveSurfaces,
    effective_limit: args.effectiveLimit,
    effective_max_mutations: args.effectiveMaxMutations,
    effective_snapshot_limit: args.effectiveSnapshotLimit,
    before_truncated: args.before.truncated,
    after_truncated: args.after.truncated,
    decisions: buildDecisionDiagnostics(args.learningLoop),
    source_code_change_allowed: false,
  });
}

export async function runRuntimeMaintenanceLite(
  store: RuntimeMaintenanceLiteStore,
  body: unknown,
  opts: LearningLoopLiteOptions,
): Promise<RuntimeMaintenanceRunResponse> {
  const entropyMaintenanceDefaults = runtimeEntropyMaintenanceDefaultsApplication({
    body,
    explicitMaintenanceProfile: hasExplicitMaintenanceProfile(body),
  });
  if (entropyMaintenanceDefaults.application.reason === "invalid_runtime_entropy_controls") {
    throw new Error("invalid_runtime_entropy_controls");
  }
  const parsed = RuntimeMaintenanceRunRequestSchema.parse(entropyMaintenanceDefaults.body);
  const profilePolicy = runtimeMaintenanceProfilePolicy(parsed.maintenance_profile);
  const effectiveSurfaces: LearningLoopSurface[] = parsed.surfaces ?? [...profilePolicy.default_surfaces];
  const effectiveLimit = parsed.limit ?? profilePolicy.default_limit;
  const effectiveMaxMutations = parsed.max_mutations ?? profilePolicy.default_max_mutations;
  const effectiveSnapshotLimit = parsed.snapshot_limit ?? profilePolicy.default_snapshot_limit;
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const actor = firstString(parsed.actor) ?? "runtime_maintenance";
  const before = await buildMaintenanceSnapshot({
    store,
    scope: tenancy.scope_key,
    actor,
    snapshotLimit: effectiveSnapshotLimit,
  });
  const learningLoop = await runLearningLoopLite(store, {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    actor,
    mode: parsed.mode,
    surfaces: effectiveSurfaces,
    limit: effectiveLimit,
    max_mutations: effectiveMaxMutations,
    forgetting_mutation_policy: learningLoopForgettingPolicy(profilePolicy),
  }, opts);
  const after = await buildMaintenanceSnapshot({
    store,
    scope: tenancy.scope_key,
    actor,
    snapshotLimit: effectiveSnapshotLimit,
  });
  const delta = buildMaintenanceDelta(before, after);
  const effectSummary = buildEffectSummary({
    learningLoop,
    after,
    delta,
  });
  const diagnostics = buildRunDiagnostics({
    maintenanceProfile: parsed.maintenance_profile,
    effectiveSurfaces,
    effectiveLimit,
    effectiveMaxMutations,
    effectiveSnapshotLimit,
    before,
    learningLoop,
    after,
  });
  return RuntimeMaintenanceRunResponseSchema.parse({
    ok: true,
    run_version: "runtime_maintenance_run_v1",
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    actor,
    mode: parsed.mode,
    maintenance_profile: parsed.maintenance_profile,
    profile_policy: profilePolicy,
    before,
    learning_loop: learningLoop,
    after,
    delta,
    effect_summary: effectSummary,
    runtime_entropy_maintenance_defaults: entropyMaintenanceDefaults.application,
    diagnostics,
    applied_count: learningLoop.applied_count,
    source_code_change_allowed: false,
  });
}
