import {
  buildControlledStateDecisionTrace,
  deriveControlledStateRaisePreview,
  deriveControlledStateRaiseRuntimeApply,
} from "./learning-control-shared.js";
import type {
  ReplayRepairReviewLearningControlDecisionTrace,
  ReplayRepairReviewLearningControlPolicyEffect,
  ReplayRepairReviewLearningControlPreview,
} from "./schemas.js";
import type { ReplayLearningProjectionResolvedConfig } from "./replay-learning.js";

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return Math.trunc(n);
}

export function resolveReplayLearningProjectionConfig(
  requestObj: Record<string, unknown> | null,
  defaults: ReplayLearningProjectionResolvedConfig | undefined,
): ReplayLearningProjectionResolvedConfig {
  const base: ReplayLearningProjectionResolvedConfig = defaults ?? {
    enabled: false,
    mode: "rule_and_episode",
    delivery: "sync_inline",
    target_rule_state: "draft",
    min_total_steps: 1,
    min_success_ratio: 1,
    max_matcher_bytes: 16384,
    max_tool_prefer: 8,
    episode_ttl_days: 30,
  };
  const modeRaw = toStringOrNull(requestObj?.mode);
  const deliveryRaw = toStringOrNull(requestObj?.delivery);
  const stateRaw = toStringOrNull(requestObj?.target_rule_state);
  return {
    enabled: requestObj?.enabled === undefined ? base.enabled : requestObj.enabled === true,
    mode:
      modeRaw == null
        ? base.mode
        : modeRaw === "episode_only"
          ? "episode_only"
          : "rule_and_episode",
    delivery:
      deliveryRaw == null
        ? base.delivery
        : "sync_inline",
    target_rule_state:
      stateRaw == null
        ? base.target_rule_state
        : stateRaw === "shadow"
          ? "shadow"
          : "draft",
    min_total_steps: clampInt(Number(requestObj?.min_total_steps ?? base.min_total_steps), 0, 500),
    min_success_ratio: Math.max(0, Math.min(1, Number(requestObj?.min_success_ratio ?? base.min_success_ratio))),
    max_matcher_bytes: clampInt(Number(base.max_matcher_bytes), 1, 1024 * 1024),
    max_tool_prefer: clampInt(Number(base.max_tool_prefer), 1, 64),
    episode_ttl_days: clampInt(Number(base.episode_ttl_days), 1, 3650),
  };
}

export function hasExplicitReplayLearningProjectionTargetRuleState(
  requestObj: Record<string, unknown> | null,
): boolean {
  return toStringOrNull(requestObj?.target_rule_state) != null;
}

export function deriveReplayLearningControlPolicyEffect(args: {
  baseTargetRuleState: "draft" | "shadow";
  explicitTargetRuleState: boolean;
  review: ReplayRepairReviewLearningControlPreview["promote_memory"]["review_result"] | null;
  admissibility: ReplayRepairReviewLearningControlPreview["promote_memory"]["admissibility"] | null;
}): ReplayRepairReviewLearningControlPolicyEffect {
  const admissibility = args.admissibility ?? null;
  const review = args.review ?? null;
  const baseTargetRuleState = args.baseTargetRuleState;
  const derived = deriveControlledStateRaisePreview({
    baseState: baseTargetRuleState,
    review,
    admissibility,
    defaultSource: "default_learning_projection",
    reviewSource: "promote_memory_learning_control_review",
    noReviewReason: "review_not_supplied",
    notAdmissibleReason: "review_not_admissible",
    noRaiseReason: "review_did_not_raise_target_rule_state",
    applyReason: "high_strategic_value_workflow_promotion",
    noRaiseSuggestedState: null,
    appliedState: "shadow",
    extraNoApplyGuards: [{
      when: args.explicitTargetRuleState,
      reason: "explicit_target_rule_state_preserved",
      reviewSuggestedState: null,
    }],
    shouldApply: (presentReview) =>
      presentReview.adjudication.disposition === "recommend"
      && presentReview.adjudication.target_kind === "workflow"
      && presentReview.adjudication.target_level === "L2"
      && presentReview.adjudication.strategic_value === "high"
      && baseTargetRuleState === "draft",
  });
  return {
    source: derived.source,
    applies: derived.applies,
    base_target_rule_state: derived.baseState,
    review_suggested_target_rule_state: derived.reviewSuggestedState,
    effective_target_rule_state: derived.effectiveState,
    reason_code: derived.reasonCode,
  };
}

export function applyReplayLearningControlPolicyEffect(args: {
  config: ReplayLearningProjectionResolvedConfig;
  policyEffect: ReplayRepairReviewLearningControlPolicyEffect | null;
}): ReplayLearningProjectionResolvedConfig {
  const policyEffect = args.policyEffect ?? null;
  const applyGate = deriveControlledStateRaiseRuntimeApply({
    policyEffect,
    effectiveState: policyEffect?.effective_target_rule_state,
    appliedState: "shadow",
  });
  if (!applyGate.runtimeApplyRequested || !applyGate.controlledOverrideState) return args.config;
  return {
    ...args.config,
    target_rule_state: applyGate.controlledOverrideState,
  };
}

export function buildReplayLearningControlDecisionTrace(args: {
  reviewResult: ReplayRepairReviewLearningControlPreview["promote_memory"]["review_result"] | null;
  admissibility: ReplayRepairReviewLearningControlPreview["promote_memory"]["admissibility"] | null;
  policyEffect: ReplayRepairReviewLearningControlPreview["promote_memory"]["policy_effect"] | null;
  effectiveConfig: ReplayLearningProjectionResolvedConfig;
}): ReplayRepairReviewLearningControlDecisionTrace {
  const admissibility = args.admissibility ?? null;
  const policyEffect = args.policyEffect ?? null;
  const baseTargetRuleState = policyEffect?.base_target_rule_state ?? args.effectiveConfig.target_rule_state;
  const effectiveTargetRuleState = args.effectiveConfig.target_rule_state;
  const trace = buildControlledStateDecisionTrace({
    reviewResult: args.reviewResult,
    admissibility,
    policyEffect,
    includePolicyEffectReasonCode: true,
    runtimePolicyApplied: true,
    baseState: baseTargetRuleState,
    effectiveState: effectiveTargetRuleState,
  });

  return {
    trace_version: "replay_learning_control_trace_v1",
    review_supplied: trace.review_supplied,
    admissibility_evaluated: trace.admissibility_evaluated,
    admissible: trace.admissible,
    policy_effect_applies: trace.policy_effect_applies,
    base_target_rule_state: trace.baseState,
    effective_target_rule_state: trace.effectiveState,
    runtime_apply_changed_target_rule_state: trace.runtimeApplyChanged,
    stage_order: trace.stage_order as ReplayRepairReviewLearningControlDecisionTrace["stage_order"],
    reason_codes: trace.reason_codes,
  };
}
