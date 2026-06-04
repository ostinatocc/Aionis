import type { AionisKernelCapabilityId } from "./boundary.js";
import { aionisKernelCapabilityIds } from "./boundary.js";

export type EffectStatus = "pass" | "warn" | "fail";

export type ContinuityEffectObservation = {
  repeatedDiscoverySteps?: number;
  firstActionCorrect?: boolean;
  recoveredStateFacts?: number;
  expectedStateFacts?: number;
  verifiedFactsCarried?: number;
  verifiedFactsExpected?: number;
};

export type LearningEffectObservation = {
  workflowReused?: boolean;
  stableWorkflowReused?: boolean;
  provisionalMemoriesWritten?: number;
  trustedPromotions?: number;
  weakEvidencePromoted?: number;
  counterEvidenceDemotions?: number;
};

export type ForgettingEffectObservation = {
  contextItems?: number;
  usefulContextItems?: number;
  staleMemorySurfaced?: number;
  staleMemorySuppressed?: number;
  archivedMemoryRehydratedOnDemand?: number;
  unnecessaryRehydrations?: number;
};

export type LearningControlEffectObservation = {
  weakEvidenceBlocked?: number;
  authorityRequiresEvidence?: boolean;
  blockedAuthorityVisible?: boolean;
  unverifiedAuthorityApplied?: number;
};

export type AionisEffectObservation = {
  label?: string;
  continuity?: ContinuityEffectObservation;
  learning?: LearningEffectObservation;
  forgetting?: ForgettingEffectObservation;
  learning_control?: LearningControlEffectObservation;
};

export type AionisEffectEvaluationInput = {
  baseline: AionisEffectObservation;
  aionis: AionisEffectObservation;
  minEffectDelta?: number;
  minAionisScore?: number;
};

export type EffectKernelScore = {
  capability_id: AionisKernelCapabilityId;
  score: number;
  status: EffectStatus;
  metrics: Record<string, number | boolean | string | null>;
  signals: string[];
  regressions: string[];
};

export type EffectKernelComparison = EffectKernelScore & {
  baseline_score: number;
  delta: number;
};

export type AionisEffectReport = {
  report_version: "aionis_effect_evaluator_v1";
  status: EffectStatus;
  baseline_score: number;
  aionis_score: number;
  effect_delta: number;
  kernel_scores: EffectKernelComparison[];
  proof_summary: {
    improved_kernel_count: number;
    regressed_kernel_count: number;
    failed_kernel_count: number;
    repeated_discovery_delta: number;
    first_action_improved: boolean;
    workflow_reuse_improved: boolean;
    context_precision_delta: number;
    stale_memory_delta: number;
    weak_authority_blocked: boolean;
  };
  next_actions: string[];
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function nonNegative(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function ratio(numerator: unknown, denominator: unknown, defaultValue = 0): number {
  const n = nonNegative(numerator);
  const d = nonNegative(denominator);
  if (d <= 0) return defaultValue;
  return clamp01(n / d);
}

function boolScore(value: unknown): number {
  return value === true ? 1 : 0;
}

function average(values: number[]): number {
  const present = values.filter((value) => Number.isFinite(value));
  if (present.length === 0) return 0;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function roundDelta(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function statusFromScore(score: number, hardFail = false): EffectStatus {
  if (hardFail) return "fail";
  if (score >= 0.7) return "pass";
  if (score >= 0.45) return "warn";
  return "fail";
}

function scoreContinuity(observation: ContinuityEffectObservation | undefined): EffectKernelScore {
  const input = observation ?? {};
  const repeatedDiscoverySteps = nonNegative(input.repeatedDiscoverySteps);
  const recoveredStateRatio = ratio(input.recoveredStateFacts, input.expectedStateFacts, input.recoveredStateFacts ? 1 : 0);
  const verifiedFactRatio = ratio(input.verifiedFactsCarried, input.verifiedFactsExpected, input.verifiedFactsCarried ? 1 : 0);
  const repeatedDiscoveryAvoidance = 1 - clamp01(repeatedDiscoverySteps / 5);
  const score = roundScore(average([
    boolScore(input.firstActionCorrect),
    recoveredStateRatio,
    verifiedFactRatio,
    repeatedDiscoveryAvoidance,
  ]));
  const regressions = [
    ...(input.firstActionCorrect === false ? ["first_action_wrong"] : []),
    ...(repeatedDiscoverySteps > 2 ? ["repeated_discovery_too_high"] : []),
    ...(recoveredStateRatio < 0.7 ? ["recovered_state_fact_gap"] : []),
  ];
  return {
    capability_id: "continuity",
    score,
    status: statusFromScore(score),
    metrics: {
      first_action_correct: input.firstActionCorrect === true,
      repeated_discovery_steps: repeatedDiscoverySteps,
      recovered_state_fact_ratio: roundScore(recoveredStateRatio),
      verified_fact_ratio: roundScore(verifiedFactRatio),
    },
    signals: [
      ...(input.firstActionCorrect ? ["first_action_matches_expected"] : []),
      ...(recoveredStateRatio >= 0.7 ? ["execution_state_recovered"] : []),
      ...(verifiedFactRatio >= 0.7 ? ["verified_facts_carried"] : []),
    ],
    regressions,
  };
}

function scoreLearning(observation: LearningEffectObservation | undefined): EffectKernelScore {
  const input = observation ?? {};
  const weakEvidencePromoted = nonNegative(input.weakEvidencePromoted);
  const trustedPromotions = nonNegative(input.trustedPromotions);
  const provisionalMemoriesWritten = nonNegative(input.provisionalMemoriesWritten);
  const counterEvidenceDemotions = nonNegative(input.counterEvidenceDemotions);
  const workflowReuseScore = input.stableWorkflowReused ? 1 : input.workflowReused ? 0.75 : 0;
  const promotionScore = weakEvidencePromoted > 0
    ? 0
    : trustedPromotions > 0
      ? 1
      : provisionalMemoriesWritten > 0
        ? 0.55
        : 0;
  const counterEvidenceScore = counterEvidenceDemotions > 0 ? 1 : 0.65;
  const score = roundScore(average([
    workflowReuseScore,
    promotionScore,
    counterEvidenceScore,
  ]));
  const regressions = [
    ...(weakEvidencePromoted > 0 ? ["weak_evidence_promoted"] : []),
    ...(workflowReuseScore === 0 ? ["workflow_not_reused"] : []),
  ];
  return {
    capability_id: "learning",
    score,
    status: statusFromScore(score, weakEvidencePromoted > 0),
    metrics: {
      workflow_reused: input.workflowReused === true,
      stable_workflow_reused: input.stableWorkflowReused === true,
      provisional_memories_written: provisionalMemoriesWritten,
      trusted_promotions: trustedPromotions,
      weak_evidence_promoted: weakEvidencePromoted,
      counter_evidence_demotions: counterEvidenceDemotions,
    },
    signals: [
      ...(input.workflowReused ? ["workflow_reused"] : []),
      ...(input.stableWorkflowReused ? ["stable_workflow_reused"] : []),
      ...(trustedPromotions > 0 ? ["trusted_memory_promoted"] : []),
      ...(counterEvidenceDemotions > 0 ? ["counter_evidence_demoted_memory"] : []),
    ],
    regressions,
  };
}

function contextPrecision(input: ForgettingEffectObservation): number {
  return ratio(input.usefulContextItems, input.contextItems, input.contextItems ? 0 : 1);
}

function scoreForgetting(observation: ForgettingEffectObservation | undefined): EffectKernelScore {
  const input = observation ?? {};
  const staleMemorySurfaced = nonNegative(input.staleMemorySurfaced);
  const staleMemorySuppressed = nonNegative(input.staleMemorySuppressed);
  const archivedMemoryRehydratedOnDemand = nonNegative(input.archivedMemoryRehydratedOnDemand);
  const unnecessaryRehydrations = nonNegative(input.unnecessaryRehydrations);
  const precision = contextPrecision(input);
  const staleControlScore = staleMemorySurfaced > 0
    ? clamp01(staleMemorySuppressed / (staleMemorySuppressed + staleMemorySurfaced))
    : 1;
  const rehydrationScore = unnecessaryRehydrations > 0
    ? 0
    : archivedMemoryRehydratedOnDemand > 0
      ? 1
      : 0.7;
  const score = roundScore(average([
    precision,
    staleControlScore,
    rehydrationScore,
  ]));
  const regressions = [
    ...(staleMemorySurfaced > 0 ? ["stale_memory_reached_context"] : []),
    ...(unnecessaryRehydrations > 0 ? ["unnecessary_rehydration"] : []),
    ...(precision < 0.6 ? ["context_precision_low"] : []),
  ];
  return {
    capability_id: "forgetting",
    score,
    status: statusFromScore(score),
    metrics: {
      context_items: nonNegative(input.contextItems),
      useful_context_items: nonNegative(input.usefulContextItems),
      context_precision: roundScore(precision),
      stale_memory_surfaced: staleMemorySurfaced,
      stale_memory_suppressed: staleMemorySuppressed,
      archived_memory_rehydrated_on_demand: archivedMemoryRehydratedOnDemand,
      unnecessary_rehydrations: unnecessaryRehydrations,
    },
    signals: [
      ...(precision >= 0.7 ? ["context_precision_good"] : []),
      ...(staleMemorySuppressed > 0 ? ["stale_memory_suppressed"] : []),
      ...(archivedMemoryRehydratedOnDemand > 0 ? ["archive_rehydrated_on_demand"] : []),
    ],
    regressions,
  };
}

function scoreLearningControl(observation: LearningControlEffectObservation | undefined): EffectKernelScore {
  const input = observation ?? {};
  const weakEvidenceBlocked = nonNegative(input.weakEvidenceBlocked);
  const unverifiedAuthorityApplied = nonNegative(input.unverifiedAuthorityApplied);
  const score = roundScore(average([
    weakEvidenceBlocked > 0 ? 1 : 0.55,
    boolScore(input.authorityRequiresEvidence),
    boolScore(input.blockedAuthorityVisible),
    unverifiedAuthorityApplied > 0 ? 0 : 1,
  ]));
  const regressions = [
    ...(unverifiedAuthorityApplied > 0 ? ["unverified_authority_applied"] : []),
    ...(input.authorityRequiresEvidence === false ? ["authority_does_not_require_evidence"] : []),
    ...(input.blockedAuthorityVisible === false ? ["blocked_authority_not_visible"] : []),
  ];
  return {
    capability_id: "learning_control",
    score,
    status: statusFromScore(score, unverifiedAuthorityApplied > 0),
    metrics: {
      weak_evidence_blocked: weakEvidenceBlocked,
      authority_requires_evidence: input.authorityRequiresEvidence === true,
      blocked_authority_visible: input.blockedAuthorityVisible === true,
      unverified_authority_applied: unverifiedAuthorityApplied,
    },
    signals: [
      ...(weakEvidenceBlocked > 0 ? ["weak_evidence_blocked"] : []),
      ...(input.authorityRequiresEvidence ? ["authority_requires_evidence"] : []),
      ...(input.blockedAuthorityVisible ? ["blocked_authority_visible"] : []),
    ],
    regressions,
  };
}

export function scoreAionisEffectObservation(observation: AionisEffectObservation): EffectKernelScore[] {
  const scores = [
    scoreContinuity(observation.continuity),
    scoreLearning(observation.learning),
    scoreForgetting(observation.forgetting),
    scoreLearningControl(observation.learning_control),
  ];
  const expected = aionisKernelCapabilityIds();
  const present = scores.map((score) => score.capability_id);
  if (expected.length !== present.length || expected.some((id) => !present.includes(id))) {
    throw new Error("effect evaluator must score every focused kernel capability");
  }
  return scores;
}

function aggregateScore(scores: EffectKernelScore[]): number {
  return roundScore(average(scores.map((score) => score.score)));
}

function compareKernelScores(args: {
  baselineScores: EffectKernelScore[];
  aionisScores: EffectKernelScore[];
}): EffectKernelComparison[] {
  return args.aionisScores.map((aionisScore) => {
    const baselineScore = args.baselineScores.find((score) => score.capability_id === aionisScore.capability_id);
    if (!baselineScore) {
      throw new Error(`effect evaluator missing baseline score for ${aionisScore.capability_id}`);
    }
    const delta = roundDelta(aionisScore.score - baselineScore.score);
    return {
      ...aionisScore,
      baseline_score: baselineScore.score,
      delta,
      regressions: [
        ...aionisScore.regressions,
        ...(delta < -0.05 ? ["kernel_score_regressed"] : []),
      ],
    };
  });
}

function reportStatus(args: {
  aionisScore: number;
  effectDelta: number;
  kernelScores: EffectKernelComparison[];
  minEffectDelta: number;
  minAionisScore: number;
}): EffectStatus {
  if (args.kernelScores.some((score) => score.status === "fail")) return "fail";
  if (args.kernelScores.some((score) => score.delta < -0.05)) return "warn";
  if (
    args.kernelScores.every((score) => score.status === "pass")
    && args.aionisScore >= args.minAionisScore
    && args.effectDelta >= args.minEffectDelta
  ) {
    return "pass";
  }
  if (args.aionisScore >= 0.55 && args.effectDelta >= 0) return "warn";
  return "fail";
}

function nextActions(kernelScores: EffectKernelComparison[], status: EffectStatus): string[] {
  const actions = new Set<string>();
  if (status === "pass") {
    actions.add("promote_effect_evaluator_to_live_measurement");
  }
  if (status === "warn" && kernelScores.every((score) => score.delta >= -0.05)) {
    actions.add("raise_measured_effect_delta_with_real_agent_runs");
  }
  for (const score of kernelScores) {
    if (score.status === "pass" && score.delta >= -0.05) continue;
    if (score.capability_id === "continuity") actions.add("tighten_task_start_and_handoff_recovery_packets");
    if (score.capability_id === "learning") actions.add("add_more_evidence_before_trusted_promotion");
    if (score.capability_id === "forgetting") actions.add("improve_context_precision_and_stale_memory_suppression");
    if (score.capability_id === "learning_control") actions.add("block_authority_until_outcome_evidence_is_visible");
  }
  return [...actions];
}

export function evaluateAionisEffect(args: AionisEffectEvaluationInput): AionisEffectReport {
  const minEffectDelta = typeof args.minEffectDelta === "number" ? args.minEffectDelta : 0.1;
  const minAionisScore = typeof args.minAionisScore === "number" ? args.minAionisScore : 0.7;
  const baselineScores = scoreAionisEffectObservation(args.baseline);
  const aionisScores = scoreAionisEffectObservation(args.aionis);
  const kernelScores = compareKernelScores({ baselineScores, aionisScores });
  const baselineScore = aggregateScore(baselineScores);
  const aionisScore = aggregateScore(aionisScores);
  const effectDelta = roundDelta(aionisScore - baselineScore);
  const repeatedDiscoveryDelta =
    nonNegative(args.baseline.continuity?.repeatedDiscoverySteps)
    - nonNegative(args.aionis.continuity?.repeatedDiscoverySteps);
  const baselinePrecision = contextPrecision(args.baseline.forgetting ?? {});
  const aionisPrecision = contextPrecision(args.aionis.forgetting ?? {});
  const staleMemoryDelta =
    nonNegative(args.baseline.forgetting?.staleMemorySurfaced)
    - nonNegative(args.aionis.forgetting?.staleMemorySurfaced);
  const status = reportStatus({
    aionisScore,
    effectDelta,
    kernelScores,
    minEffectDelta,
    minAionisScore,
  });
  return {
    report_version: "aionis_effect_evaluator_v1",
    status,
    baseline_score: baselineScore,
    aionis_score: aionisScore,
    effect_delta: effectDelta,
    kernel_scores: kernelScores,
    proof_summary: {
      improved_kernel_count: kernelScores.filter((score) => score.delta > 0.05).length,
      regressed_kernel_count: kernelScores.filter((score) => score.delta < -0.05).length,
      failed_kernel_count: kernelScores.filter((score) => score.status === "fail").length,
      repeated_discovery_delta: roundDelta(repeatedDiscoveryDelta),
      first_action_improved:
        args.baseline.continuity?.firstActionCorrect !== true
        && args.aionis.continuity?.firstActionCorrect === true,
      workflow_reuse_improved:
        args.baseline.learning?.workflowReused !== true
        && args.aionis.learning?.workflowReused === true,
      context_precision_delta: roundDelta(aionisPrecision - baselinePrecision),
      stale_memory_delta: roundDelta(staleMemoryDelta),
      weak_authority_blocked:
        nonNegative(args.aionis.learning_control?.weakEvidenceBlocked) > 0
        && nonNegative(args.aionis.learning_control?.unverifiedAuthorityApplied) === 0,
    },
    next_actions: nextActions(kernelScores, status),
  };
}
