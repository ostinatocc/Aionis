export const MEMORY_TIER_ORDER = ["archive", "cold", "warm", "hot"] as const;

export type MemoryTierName = (typeof MEMORY_TIER_ORDER)[number];

export type MemoryEvolutionAction =
  | "retain"
  | "demote"
  | "archive"
  | "rehydrate"
  | "review";

export const MEMORY_TIER_RANK: Record<MemoryTierName, number> = {
  archive: 0,
  cold: 1,
  warm: 2,
  hot: 3,
};

export function isMemoryTierName(value: unknown): value is MemoryTierName {
  return typeof value === "string" && (MEMORY_TIER_ORDER as readonly string[]).includes(value);
}

export function normalizeMemoryTier(value: unknown, defaultValue: MemoryTierName = "archive"): MemoryTierName {
  return isMemoryTierName(value) ? value : defaultValue;
}

export function compareMemoryTierRank(left: unknown, right: unknown): number {
  return MEMORY_TIER_RANK[normalizeMemoryTier(left)] - MEMORY_TIER_RANK[normalizeMemoryTier(right)];
}

export function nextWarmerTier(value: unknown): MemoryTierName {
  const tier = normalizeMemoryTier(value);
  return MEMORY_TIER_ORDER[Math.min(MEMORY_TIER_ORDER.length - 1, MEMORY_TIER_RANK[tier] + 1)]!;
}

export function nextColderTier(value: unknown): MemoryTierName {
  const tier = normalizeMemoryTier(value);
  return MEMORY_TIER_ORDER[Math.max(0, MEMORY_TIER_RANK[tier] - 1)]!;
}

export function resolveTierTransitionTarget(args: {
  current_tier: unknown;
  action: MemoryEvolutionAction;
  requested_target_tier?: unknown;
}): MemoryTierName {
  const currentTier = normalizeMemoryTier(args.current_tier);
  if (args.action === "archive") return "archive";
  if (args.action === "rehydrate") {
    const requested = normalizeMemoryTier(args.requested_target_tier, currentTier);
    return compareMemoryTierRank(requested, currentTier) >= 0 ? requested : currentTier;
  }
  if (args.action === "demote") return nextColderTier(currentTier);
  return currentTier;
}

export type WorkflowPromotionState = "candidate" | "stable";

export type WorkflowPromotionOrigin =
  | "replay_compile_from_run"
  | "execution_write_projection"
  | "execution_write_auto_promotion"
  | "replay_learning_episode"
  | "replay_learning_auto_promotion"
  | "replay_promote"
  | "replay_stable_normalization";

export type WorkflowPromotionTransition =
  | "candidate_observed"
  | "promoted_to_stable"
  | "normalized_latest_stable";

export type WorkflowMaintenanceMetadata = {
  model: "lazy_online_v1";
  maintenance_state: "observe" | "retain";
  offline_priority: "promote_candidate" | "retain_workflow";
  lazy_update_fields: Array<"usage_count" | "last_used_at">;
  last_maintenance_at: string;
};

export type WorkflowPromotionMetadata = {
  promotion_state: WorkflowPromotionState;
  promotion_origin: WorkflowPromotionOrigin;
  last_transition: WorkflowPromotionTransition;
  last_transition_at: string;
  source_status: string | null;
  required_observations?: number;
  observed_count?: number;
};

export function buildWorkflowMaintenanceMetadata(args: {
  promotion_state: WorkflowPromotionState;
  at: string;
}): WorkflowMaintenanceMetadata {
  return {
    model: "lazy_online_v1",
    maintenance_state: args.promotion_state === "stable" ? "retain" : "observe",
    offline_priority: args.promotion_state === "stable" ? "retain_workflow" : "promote_candidate",
    lazy_update_fields: ["usage_count", "last_used_at"],
    last_maintenance_at: args.at,
  };
}

export function buildWorkflowPromotionMetadata(args: {
  promotion_state: WorkflowPromotionState;
  promotion_origin: WorkflowPromotionOrigin;
  at: string;
  required_observations?: number | null;
  observed_count?: number | null;
  source_status?: string | null;
  last_transition?: WorkflowPromotionTransition | null;
}): WorkflowPromotionMetadata {
  const out: WorkflowPromotionMetadata = {
    promotion_state: args.promotion_state,
    promotion_origin: args.promotion_origin,
    last_transition:
      args.last_transition
      ?? (args.promotion_state === "candidate"
        ? "candidate_observed"
        : args.promotion_origin === "replay_stable_normalization"
          ? "normalized_latest_stable"
          : "promoted_to_stable"),
    last_transition_at: args.at,
    source_status: args.source_status ?? null,
  };
  if (args.required_observations != null) {
    out.required_observations = Math.max(1, Math.trunc(args.required_observations));
  }
  if (args.observed_count != null) {
    out.observed_count = Math.max(0, Math.trunc(args.observed_count));
  }
  return out;
}

export type PatternCredibilityState = "candidate" | "trusted" | "contested";

export type PatternTransitionKind =
  | "candidate_observed"
  | "promoted_to_trusted"
  | "counter_evidence_opened"
  | "revalidated_to_trusted";

export type PatternMaintenanceMetadata = {
  model: "lazy_online_v1";
  maintenance_state: "observe" | "retain" | "review";
  offline_priority: "none" | "promote_candidate" | "retain_trusted" | "review_counter_evidence";
  lazy_update_fields: Array<"usage_count" | "last_used_at" | "reuse_success_count" | "reuse_failure_count">;
  last_maintenance_at: string;
};

export type PatternPromotionMetadata = {
  required_distinct_runs: number;
  distinct_run_count: number;
  observed_run_ids: string[];
  counter_evidence_count: number;
  counter_evidence_open: boolean;
  credibility_state: PatternCredibilityState;
  previous_credibility_state: PatternCredibilityState | null;
  last_transition: PatternTransitionKind;
  last_transition_at: string;
  stable_at: string | null;
  last_validated_at: string | null;
  last_counter_evidence_at: string | null;
};

export type DistillationOrigin =
  | "write_distillation_input_text"
  | "write_distillation_event_node"
  | "write_distillation_evidence_node"
  | "execution_write_projection"
  | "handoff_continuity_carrier"
  | "session_event_continuity_carrier"
  | "session_continuity_carrier"
  | "replay_learning_episode";

export type DistillationTransitionKind =
  | "distilled_from_input_text"
  | "distilled_from_event_node"
  | "distilled_from_evidence_node"
  | "projected_from_execution_write"
  | "projected_from_handoff_carrier"
  | "projected_from_session_event_carrier"
  | "projected_from_session_carrier"
  | "projected_from_replay_learning";

export type DistillationPromotionTarget = "workflow" | "pattern" | "policy";

export type DistillationMaintenanceMetadata = {
  model: "lazy_online_v1";
  maintenance_state: "observe" | "retain";
  offline_priority:
    | "promote_to_workflow"
    | "promote_to_pattern"
    | "promote_to_policy"
    | "retain_distillation";
  lazy_update_fields: Array<"usage_count" | "last_used_at">;
  last_maintenance_at: string;
};

export type DistillationMetadata = {
  abstraction_state: "distilled";
  distillation_origin: DistillationOrigin;
  source_kind:
    | "input_text"
    | "event_nodes"
    | "evidence_nodes"
    | "execution_projection"
    | "handoff_carrier"
    | "session_event_carrier"
    | "session_carrier"
    | "replay_learning";
  preferred_promotion_target: DistillationPromotionTarget;
  extraction_pattern: string | null;
  source_node_id: string | null;
  source_evidence_node_id: string | null;
  has_execution_signature: boolean;
  last_transition: DistillationTransitionKind;
  last_transition_at: string;
};

export type PolicyMemoryState = "active" | "contested" | "retired";
export type PolicyActivationMode = "hint" | "default";
export type PolicySourceKind = "trusted_pattern" | "stable_workflow" | "blended";
export type PolicyState = "candidate" | "stable";
export type PolicyTransitionKind =
  | "materialized"
  | "refreshed"
  | "contested_by_feedback"
  | "retired_by_feedback"
  | "retired_by_learning_control"
  | "reactivated_by_learning_control";

export type PolicyMaintenanceMetadata = {
  model: "lazy_online_v1";
  maintenance_state: "observe" | "retain" | "review";
  offline_priority:
    | "promote_to_default"
    | "retain_active_policy"
    | "review_contested_policy"
    | "retire_policy"
    | "reactivate_policy";
  lazy_update_fields: Array<"usage_count" | "last_used_at" | "reuse_success_count" | "reuse_failure_count">;
  last_maintenance_at: string;
};

export type PolicyEvolutionMetadata = {
  policy_kind: "tool_preference";
  policy_source_kind: PolicySourceKind;
  policy_state: PolicyState;
  policy_memory_state: PolicyMemoryState;
  activation_mode: PolicyActivationMode;
  materialization_state: "computed" | "persisted";
  source_anchor_count: number;
  last_transition: PolicyTransitionKind;
  last_transition_at: string;
};

export function buildPatternMaintenanceMetadata(args: {
  credibility_state: PatternCredibilityState;
  distinct_run_count: number;
  required_distinct_runs: number;
  counter_evidence_open: boolean;
  at: string;
}): PatternMaintenanceMetadata {
  const maintenanceState =
    args.credibility_state === "contested"
      ? "review"
      : args.credibility_state === "trusted"
        ? "retain"
        : "observe";
  const offlinePriority =
    args.credibility_state === "contested"
      ? "review_counter_evidence"
      : args.credibility_state === "trusted"
        ? "retain_trusted"
        : args.distinct_run_count >= Math.max(0, args.required_distinct_runs - 1)
          ? "promote_candidate"
          : "none";
  return {
    model: "lazy_online_v1",
    maintenance_state: maintenanceState,
    offline_priority: offlinePriority,
    lazy_update_fields: [
      "usage_count",
      "last_used_at",
      "reuse_success_count",
      "reuse_failure_count",
    ],
    last_maintenance_at: args.at,
  };
}

export function resolvePatternTransition(args: {
  credibility_state: PatternCredibilityState;
  previous_credibility_state: PatternCredibilityState | null;
  default_transition?: PatternTransitionKind | null;
}): PatternTransitionKind {
  if (args.credibility_state === "contested") return "counter_evidence_opened";
  if (args.credibility_state === "trusted") {
    if (args.previous_credibility_state === "contested") return "revalidated_to_trusted";
    if (args.previous_credibility_state === "trusted") {
      return args.default_transition ?? "promoted_to_trusted";
    }
    return "promoted_to_trusted";
  }
  return "candidate_observed";
}

export function buildPatternPromotionMetadata(args: {
  required_distinct_runs: number;
  distinct_run_count: number;
  observed_run_ids: string[];
  counter_evidence_count: number;
  counter_evidence_open: boolean;
  credibility_state: PatternCredibilityState;
  previous_credibility_state: PatternCredibilityState | null;
  at: string;
  stable_at?: string | null;
  last_validated_at?: string | null;
  last_counter_evidence_at?: string | null;
  default_transition?: PatternTransitionKind | null;
}): PatternPromotionMetadata {
  return {
    required_distinct_runs: Math.max(1, Math.trunc(args.required_distinct_runs)),
    distinct_run_count: Math.max(0, Math.trunc(args.distinct_run_count)),
    observed_run_ids: args.observed_run_ids,
    counter_evidence_count: Math.max(0, Math.trunc(args.counter_evidence_count)),
    counter_evidence_open: args.counter_evidence_open,
    credibility_state: args.credibility_state,
    previous_credibility_state: args.previous_credibility_state,
    last_transition: resolvePatternTransition({
      credibility_state: args.credibility_state,
      previous_credibility_state: args.previous_credibility_state,
      default_transition: args.default_transition ?? null,
    }),
    last_transition_at: args.at,
    stable_at: args.stable_at ?? null,
    last_validated_at: args.last_validated_at ?? null,
    last_counter_evidence_at: args.last_counter_evidence_at ?? null,
  };
}

export function resolveDistillationOrigin(
  sourceKind:
    | "input_text"
    | "event_nodes"
    | "evidence_nodes"
    | "execution_projection"
    | "handoff_carrier"
    | "session_event_carrier"
    | "session_carrier"
    | "replay_learning",
): DistillationOrigin {
  if (sourceKind === "execution_projection") return "execution_write_projection";
  if (sourceKind === "handoff_carrier") return "handoff_continuity_carrier";
  if (sourceKind === "session_event_carrier") return "session_event_continuity_carrier";
  if (sourceKind === "session_carrier") return "session_continuity_carrier";
  if (sourceKind === "replay_learning") return "replay_learning_episode";
  if (sourceKind === "event_nodes") return "write_distillation_event_node";
  if (sourceKind === "evidence_nodes") return "write_distillation_evidence_node";
  return "write_distillation_input_text";
}

export function resolveDistillationTransition(
  sourceKind:
    | "input_text"
    | "event_nodes"
    | "evidence_nodes"
    | "execution_projection"
    | "handoff_carrier"
    | "session_event_carrier"
    | "session_carrier"
    | "replay_learning",
): DistillationTransitionKind {
  if (sourceKind === "execution_projection") return "projected_from_execution_write";
  if (sourceKind === "handoff_carrier") return "projected_from_handoff_carrier";
  if (sourceKind === "session_event_carrier") return "projected_from_session_event_carrier";
  if (sourceKind === "session_carrier") return "projected_from_session_carrier";
  if (sourceKind === "replay_learning") return "projected_from_replay_learning";
  if (sourceKind === "event_nodes") return "distilled_from_event_node";
  if (sourceKind === "evidence_nodes") return "distilled_from_evidence_node";
  return "distilled_from_input_text";
}

export function resolveDistillationPromotionTarget(args: {
  distillation_kind: "write_distillation_evidence" | "write_distillation_fact" | "workflow_candidate";
  has_execution_signature: boolean;
}): DistillationPromotionTarget {
  if (args.distillation_kind === "write_distillation_evidence" || args.distillation_kind === "workflow_candidate") return "workflow";
  return args.has_execution_signature ? "workflow" : "pattern";
}

export function buildDistillationMaintenanceMetadata(args: {
  preferred_promotion_target: DistillationPromotionTarget;
  at: string;
  retain?: boolean;
}): DistillationMaintenanceMetadata {
  const priority =
    args.retain
      ? "retain_distillation"
      : args.preferred_promotion_target === "workflow"
        ? "promote_to_workflow"
        : args.preferred_promotion_target === "policy"
          ? "promote_to_policy"
          : "promote_to_pattern";
  return {
    model: "lazy_online_v1",
    maintenance_state: args.retain ? "retain" : "observe",
    offline_priority: priority,
    lazy_update_fields: ["usage_count", "last_used_at"],
    last_maintenance_at: args.at,
  };
}

export function buildDistillationMetadata(args: {
  source_kind:
    | "input_text"
    | "event_nodes"
    | "evidence_nodes"
    | "execution_projection"
    | "handoff_carrier"
    | "session_event_carrier"
    | "session_carrier"
    | "replay_learning";
  distillation_kind: "write_distillation_evidence" | "write_distillation_fact" | "workflow_candidate";
  at: string;
  extraction_pattern?: string | null;
  source_node_id?: string | null;
  source_evidence_node_id?: string | null;
  has_execution_signature?: boolean;
  preferred_promotion_target?: DistillationPromotionTarget | null;
}): DistillationMetadata {
  const preferredPromotionTarget = args.preferred_promotion_target
    ?? resolveDistillationPromotionTarget({
      distillation_kind: args.distillation_kind,
      has_execution_signature: args.has_execution_signature === true,
    });
  return {
    abstraction_state: "distilled",
    distillation_origin: resolveDistillationOrigin(args.source_kind),
    source_kind: args.source_kind,
    preferred_promotion_target: preferredPromotionTarget,
    extraction_pattern: args.extraction_pattern ?? null,
    source_node_id: args.source_node_id ?? null,
    source_evidence_node_id: args.source_evidence_node_id ?? null,
    has_execution_signature: args.has_execution_signature === true,
    last_transition: resolveDistillationTransition(args.source_kind),
    last_transition_at: args.at,
  };
}

export function resolvePolicyTransition(args: {
  policy_memory_state: PolicyMemoryState;
  source: "materialization" | "feedback" | "learning_control";
  learning_control_action?: "refresh" | "retire" | "reactivate" | null;
}): PolicyTransitionKind {
  if (args.source === "learning_control") {
    if (args.learning_control_action === "retire") return "retired_by_learning_control";
    if (args.learning_control_action === "reactivate") return "reactivated_by_learning_control";
    return "refreshed";
  }
  if (args.source === "feedback") {
    if (args.policy_memory_state === "retired") return "retired_by_feedback";
    if (args.policy_memory_state === "contested") return "contested_by_feedback";
    return "refreshed";
  }
  return "materialized";
}

export function buildPolicyMaintenanceMetadata(args: {
  policy_memory_state: PolicyMemoryState;
  activation_mode: PolicyActivationMode;
  at: string;
  learning_control_action?: "refresh" | "retire" | "reactivate" | null;
}): PolicyMaintenanceMetadata {
  const offlinePriority =
    args.learning_control_action === "reactivate"
      ? "reactivate_policy"
      : args.policy_memory_state === "retired"
        ? "retire_policy"
        : args.policy_memory_state === "contested"
          ? "review_contested_policy"
          : args.activation_mode === "default"
            ? "retain_active_policy"
            : "promote_to_default";
  const maintenanceState =
    offlinePriority === "retain_active_policy"
      ? "retain"
      : offlinePriority === "promote_to_default"
        ? "observe"
        : "review";
  return {
    model: "lazy_online_v1",
    maintenance_state: maintenanceState,
    offline_priority: offlinePriority,
    lazy_update_fields: ["usage_count", "last_used_at", "reuse_success_count", "reuse_failure_count"],
    last_maintenance_at: args.at,
  };
}

export function buildPolicyEvolutionMetadata(args: {
  policy_source_kind: PolicySourceKind;
  policy_state: PolicyState;
  policy_memory_state: PolicyMemoryState;
  activation_mode: PolicyActivationMode;
  materialization_state?: "computed" | "persisted";
  source_anchor_count: number;
  at: string;
  source: "materialization" | "feedback" | "learning_control";
  learning_control_action?: "refresh" | "retire" | "reactivate" | null;
}): PolicyEvolutionMetadata {
  return {
    policy_kind: "tool_preference",
    policy_source_kind: args.policy_source_kind,
    policy_state: args.policy_state,
    policy_memory_state: args.policy_memory_state,
    activation_mode: args.activation_mode,
    materialization_state: args.materialization_state ?? "persisted",
    source_anchor_count: Math.max(0, Math.trunc(args.source_anchor_count)),
    last_transition: resolvePolicyTransition({
      policy_memory_state: args.policy_memory_state,
      source: args.source,
      learning_control_action: args.learning_control_action ?? null,
    }),
    last_transition_at: args.at,
  };
}
