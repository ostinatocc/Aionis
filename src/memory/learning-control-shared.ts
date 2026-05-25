import type { MemoryAdmissibilityResult } from "./schemas.js";

export type LearningControlTraceStage =
  | "review_packet_built"
  | "review_result_received"
  | "admissibility_evaluated"
  | "policy_effect_derived"
  | "runtime_policy_applied";

export function buildLearningControlTraceStageOrder(args: {
  reviewSupplied: boolean;
  admissibilityEvaluated: boolean;
  runtimePolicyApplied?: boolean;
}): LearningControlTraceStage[] {
  const stageOrder: LearningControlTraceStage[] = ["review_packet_built"];
  if (args.reviewSupplied) stageOrder.push("review_result_received");
  if (args.admissibilityEvaluated) stageOrder.push("admissibility_evaluated");
  stageOrder.push("policy_effect_derived");
  if (args.runtimePolicyApplied) stageOrder.push("runtime_policy_applied");
  return stageOrder;
}

export function buildLearningControlReasonCodes(args: {
  admissibility: MemoryAdmissibilityResult | null;
  policyEffectReasonCode?: string | null;
  includePolicyEffectReasonCode: boolean;
}): string[] {
  const reasonCodes: string[] = [...(args.admissibility?.reason_codes ?? [])];
  if (args.includePolicyEffectReasonCode && args.policyEffectReasonCode) {
    reasonCodes.push(args.policyEffectReasonCode);
  }
  return reasonCodes;
}

export function appendLearningControlRuntimePolicyAppliedStage(stages: LearningControlTraceStage[]): LearningControlTraceStage[] {
  return stages.includes("runtime_policy_applied")
    ? stages
    : [...stages, "runtime_policy_applied"];
}

export function buildLearningControlDecisionTraceBase(args: {
  reviewResult: unknown | null;
  admissibility: MemoryAdmissibilityResult | null;
  policyEffectApplies: boolean;
  policyEffectReasonCode?: string | null;
  includePolicyEffectReasonCode: boolean;
  runtimePolicyApplied?: boolean;
}): {
  review_supplied: boolean;
  admissibility_evaluated: boolean;
  admissible: boolean | null;
  policy_effect_applies: boolean;
  stage_order: LearningControlTraceStage[];
  reason_codes: string[];
} {
  const reviewSupplied = args.reviewResult != null;
  const admissibilityEvaluated = args.admissibility != null;
  return {
    review_supplied: reviewSupplied,
    admissibility_evaluated: admissibilityEvaluated,
    admissible: args.admissibility?.admissible ?? null,
    policy_effect_applies: args.policyEffectApplies,
    stage_order: buildLearningControlTraceStageOrder({
      reviewSupplied,
      admissibilityEvaluated,
      runtimePolicyApplied: args.runtimePolicyApplied,
    }),
    reason_codes: buildLearningControlReasonCodes({
      admissibility: args.admissibility,
      policyEffectReasonCode: args.policyEffectReasonCode ?? null,
      includePolicyEffectReasonCode: args.includePolicyEffectReasonCode,
    }),
  };
}

export function buildControlledStateDecisionTrace<TState extends string>(args: {
  reviewResult: unknown | null;
  admissibility: MemoryAdmissibilityResult | null;
  policyEffect: {
    applies: boolean;
    reason_code?: string | null;
  } | null;
  includePolicyEffectReasonCode: boolean;
  runtimePolicyApplied?: boolean;
  baseState: TState;
  effectiveState: TState;
}): {
  review_supplied: boolean;
  admissibility_evaluated: boolean;
  admissible: boolean | null;
  policy_effect_applies: boolean;
  stage_order: LearningControlTraceStage[];
  reason_codes: string[];
  baseState: TState;
  effectiveState: TState;
  runtimeApplyChanged: boolean;
} {
  const traceBase = buildLearningControlDecisionTraceBase({
    reviewResult: args.reviewResult,
    admissibility: args.admissibility,
    policyEffectApplies: args.policyEffect?.applies ?? false,
    policyEffectReasonCode: args.policyEffect?.reason_code ?? null,
    includePolicyEffectReasonCode: args.includePolicyEffectReasonCode,
    runtimePolicyApplied: args.runtimePolicyApplied,
  });
  return {
    ...traceBase,
    baseState: args.baseState,
    effectiveState: args.effectiveState,
    runtimeApplyChanged: args.baseState !== args.effectiveState,
  };
}

export function deriveControlledStateRaisePreview<
  TState extends string,
  TReview,
  TReason extends string,
  TSource extends string,
>(args: {
  baseState: TState;
  review: TReview | null;
  admissibility: MemoryAdmissibilityResult | null;
  defaultSource: TSource;
  reviewSource: TSource;
  noReviewReason: TReason;
  notAdmissibleReason: TReason;
  noRaiseReason: TReason;
  applyReason: TReason;
  noRaiseSuggestedState: TState | null;
  appliedState: TState;
  extraNoApplyGuards?: Array<{
    when: boolean;
    reason: TReason;
    reviewSuggestedState: TState | null;
    effectiveState?: TState;
  }>;
  shouldApply: (review: TReview) => boolean;
}): {
  source: TSource;
  applies: boolean;
  baseState: TState;
  reviewSuggestedState: TState | null;
  effectiveState: TState;
  reasonCode: TReason;
} {
  if (!args.review) {
    return {
      source: args.defaultSource,
      applies: false,
      baseState: args.baseState,
      reviewSuggestedState: null,
      effectiveState: args.baseState,
      reasonCode: args.noReviewReason,
    };
  }

  if (!args.admissibility?.admissible) {
    return {
      source: args.defaultSource,
      applies: false,
      baseState: args.baseState,
      reviewSuggestedState: null,
      effectiveState: args.baseState,
      reasonCode: args.notAdmissibleReason,
    };
  }

  for (const guard of args.extraNoApplyGuards ?? []) {
    if (!guard.when) continue;
    return {
      source: args.defaultSource,
      applies: false,
      baseState: args.baseState,
      reviewSuggestedState: guard.reviewSuggestedState,
      effectiveState: guard.effectiveState ?? args.baseState,
      reasonCode: guard.reason,
    };
  }

  if (!args.shouldApply(args.review)) {
    return {
      source: args.defaultSource,
      applies: false,
      baseState: args.baseState,
      reviewSuggestedState: args.noRaiseSuggestedState,
      effectiveState: args.baseState,
      reasonCode: args.noRaiseReason,
    };
  }

  return {
    source: args.reviewSource,
    applies: true,
    baseState: args.baseState,
    reviewSuggestedState: args.appliedState,
    effectiveState: args.appliedState,
    reasonCode: args.applyReason,
  };
}

export function deriveControlledStateRaiseRuntimeApply<
  TEffectiveState extends string,
  TAppliedState extends TEffectiveState,
>(args: {
  policyEffect: { applies: boolean } | null;
  effectiveState: TEffectiveState | null | undefined;
  appliedState: TAppliedState;
}): {
  runtimeApplyRequested: boolean;
  controlledOverrideState: TAppliedState | null;
} {
  const runtimeApplyRequested =
    !!args.policyEffect?.applies
    && args.effectiveState === args.appliedState;
  return {
    runtimeApplyRequested,
    controlledOverrideState: runtimeApplyRequested ? args.appliedState : null,
  };
}
