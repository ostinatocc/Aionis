import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import { sha256Hex } from "../util/crypto.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
  resolveLearningGatePolicy,
} from "./learning-gate-policy.js";

const GATE_POLICY = resolveLearningGatePolicy(
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
);
const GATE_POLICY_BINDING = Object.freeze({
  gate_policy_id: GATE_POLICY.policy_id,
  gate_policy_version: GATE_POLICY.policy_version,
  gate_policy_config_sha256: GATE_POLICY.policy_config_sha256,
  implementation_contract_sha256: GATE_POLICY.implementation_contract_sha256,
  registry_status: GATE_POLICY.registry_status,
});
export type LearningGatePolicyBinding = typeof GATE_POLICY_BINDING;
const MAX_REGISTERED_PAIR_COUNT = GATE_POLICY.config.confirmatory_pair_count;
const OFFLINE_PAIRED_CASE_COUNT = GATE_POLICY.config.offline_paired_case_count;

function rejectNegativeZero(schema: z.ZodNumber): z.ZodEffects<z.ZodNumber> {
  return schema.refine((value) => !Object.is(value, -0), {
    message: "Negative zero is not a canonical integer",
  });
}

const PairCountSchema = rejectNegativeZero(
  z.number().int().safe().min(1).max(MAX_REGISTERED_PAIR_COUNT),
);
const CountSchema = rejectNegativeZero(
  z.number().int().safe().nonnegative().max(MAX_REGISTERED_PAIR_COUNT),
);
const ClaimSchema = z.enum(["at_most", "above"]);

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

const CanonicalRationalSchema = z.object({
  numerator: rejectNegativeZero(z.number().int().safe()),
  denominator: z.number().int().safe().positive(),
}).strict().superRefine((value, context) => {
  if (value.numerator === 0 ? value.denominator !== 1
    : greatestCommonDivisor(value.numerator, value.denominator) !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a canonical rational in lowest terms",
    });
  }
});

const RejectionAlphaSchema = CanonicalRationalSchema.superRefine((value, context) => {
  if (value.numerator < 0 || value.numerator > value.denominator) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Rejection alpha must be between zero and one",
    });
  }
});

const AbsoluteRiskInputSchema = z.object({
  contract_version: z.literal("aionis_learning_absolute_risk_exact_input_v1"),
  pair_count: PairCountSchema,
  observed_candidate_loss_count: CountSchema,
  claim: ClaimSchema,
  threshold: CanonicalRationalSchema,
  rejection_alpha: RejectionAlphaSchema,
}).strict().superRefine((value, context) => {
  if (value.observed_candidate_loss_count > value.pair_count) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observed_candidate_loss_count"],
      message: "Observed candidate losses cannot exceed the pair count",
    });
  }
  if (value.threshold.numerator < 0
    || value.threshold.numerator > value.threshold.denominator) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["threshold"],
      message: "Absolute-risk threshold must be between zero and one",
    });
  }
});

const ContrastSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]).refine(
  (value) => !Object.is(value, -0),
  { message: "Negative zero is not a canonical contrast" },
);

const OfflineCountSchema = rejectNegativeZero(
  z.number().int().safe().min(0).max(OFFLINE_PAIRED_CASE_COUNT),
);

const RiskDifferenceInputSchema = z.object({
  contract_version: z.literal("aionis_learning_risk_difference_exact_input_v1"),
  pair_count: PairCountSchema,
  observed_contrasts: z.array(ContrastSchema).min(1).max(MAX_REGISTERED_PAIR_COUNT),
  claim: ClaimSchema,
  threshold: CanonicalRationalSchema,
  rejection_alpha: RejectionAlphaSchema,
}).strict().superRefine((value, context) => {
  if (value.observed_contrasts.length !== value.pair_count) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observed_contrasts"],
      message: "Observed contrast count must equal the pair count",
    });
  }
  if (Math.abs(value.threshold.numerator) > value.threshold.denominator) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["threshold"],
      message: "Risk-difference threshold must be between minus one and one",
    });
  }
});

const PreResponseAvailabilityInputSchema = z.object({
  contract_version: z.literal("aionis_learning_pre_response_availability_exact_input_v1"),
  pair_count: PairCountSchema,
  candidate_only_available_count: CountSchema,
  control_only_available_count: CountSchema,
}).strict().superRefine((value, context) => {
  if (value.candidate_only_available_count + value.control_only_available_count
    > value.pair_count) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Discordant availability counts cannot exceed the pair count",
    });
  }
});

const OfflineFiniteHoldoutInputSchema = z.object({
  contract_version: z.literal("aionis_learning_offline_finite_holdout_lattice_input_v1"),
  case_count: z.literal(OFFLINE_PAIRED_CASE_COUNT),
  harm_assessable_pair_count: OfflineCountSchema,
  utility_assessable_pair_count: OfflineCountSchema,
  recorded_harm_loss_count: OfflineCountSchema,
  candidate_harm_loss_count: OfflineCountSchema,
  recorded_utility_loss_count: OfflineCountSchema,
  candidate_utility_loss_count: OfflineCountSchema,
  recorded_exploit_harm_loss_count: OfflineCountSchema,
  candidate_exploit_harm_loss_count: OfflineCountSchema,
}).strict().superRefine((value, context) => {
  if (value.recorded_exploit_harm_loss_count > value.recorded_harm_loss_count) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recorded_exploit_harm_loss_count"],
      message: "Recorded exploit harm must be a subset of recorded total harm",
    });
  }
  if (value.candidate_exploit_harm_loss_count > value.candidate_harm_loss_count) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidate_exploit_harm_loss_count"],
      message: "Candidate exploit harm must be a subset of candidate total harm",
    });
  }
});

export type LearningAbsoluteRiskExactInput = z.infer<typeof AbsoluteRiskInputSchema>;
export type LearningRiskDifferenceExactInput = z.infer<typeof RiskDifferenceInputSchema>;
export type LearningPreResponseAvailabilityExactInput = z.infer<
  typeof PreResponseAvailabilityInputSchema
>;
export type LearningOfflineFiniteHoldoutLatticeInput = z.infer<
  typeof OfflineFiniteHoldoutInputSchema
>;

type JsonRecord = Record<string, unknown>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function resultWithDigest<T extends JsonRecord>(
  body: T,
): T & Readonly<{ result_sha256: string }> {
  return deepFreeze({
    ...body,
    result_sha256: sha256Hex(stableStringify(body)),
  });
}

function pascalRows(maximum: number): bigint[][] {
  const rows: bigint[][] = [[1n]];
  for (let rowIndex = 1; rowIndex <= maximum; rowIndex += 1) {
    const previous = rows[rowIndex - 1]!;
    const row = Array<bigint>(rowIndex + 1).fill(1n);
    for (let column = 1; column < rowIndex; column += 1) {
      row[column] = previous[column - 1]! + previous[column]!;
    }
    rows.push(row);
  }
  return rows;
}

function pascalPrefixes(rows: readonly (readonly bigint[])[]): bigint[][] {
  return rows.map((row) => {
    let running = 0n;
    return row.map((value) => {
      running += value;
      return running;
    });
  });
}

function binomialPrefix(
  prefixes: readonly (readonly bigint[])[],
  trials: number,
  inclusiveMaximum: number,
): bigint {
  if (inclusiveMaximum < 0) return 0n;
  if (inclusiveMaximum >= trials) return 1n << BigInt(trials);
  return prefixes[trials]![inclusiveMaximum]!;
}

function binomialSuffix(
  prefixes: readonly (readonly bigint[])[],
  trials: number,
  inclusiveMinimum: number,
): bigint {
  if (inclusiveMinimum <= 0) return 1n << BigInt(trials);
  if (inclusiveMinimum > trials) return 0n;
  return (1n << BigInt(trials)) - prefixes[trials]![inclusiveMinimum - 1]!;
}

function claimSupported(args: {
  maxTailCount: bigint;
  assignmentCount: bigint;
  rejectionAlpha: Readonly<{ numerator: number; denominator: number }>;
}): boolean {
  return BigInt(args.rejectionAlpha.denominator) * args.maxTailCount
    <= BigInt(args.rejectionAlpha.numerator) * args.assignmentCount;
}

export type LearningExactCompositeResult = Readonly<{
  contract_version:
    | "aionis_learning_absolute_risk_exact_result_v1"
    | "aionis_learning_risk_difference_exact_result_v1";
  gate_policy_binding: LearningGatePolicyBinding;
  pair_count: number;
  claim: "at_most" | "above";
  composite_null: "parameter_above_threshold" | "parameter_at_or_below_threshold";
  tail_rule: "inclusive_lower" | "inclusive_upper";
  threshold: Readonly<{ numerator: number; denominator: number }>;
  rejection_alpha: Readonly<{ numerator: number; denominator: number }>;
  max_tail_count: string;
  assignment_count: string;
  claim_supported: boolean;
  result_sha256: string;
}>;

export function evaluateLearningAbsoluteRiskExact(
  inputValue: unknown,
) {
  const input = AbsoluteRiskInputSchema.parse(inputValue);
  const pairCount = input.pair_count;
  const observedLossCount = input.observed_candidate_loss_count;
  const rows = pascalRows(pairCount);
  const prefixes = pascalPrefixes(rows);
  const assignmentCount = 1n << BigInt(pairCount);
  let maximumTailCount = 0n;
  let maximizingSchedule: Readonly<{
    observed_loss_concordant_pair_count: number;
    candidate_potential_discordant_pair_count: number;
    unobserved_loss_after_observed_loss_count: number;
    unobserved_loss_after_observed_no_loss_count: number;
    parameter_numerator: number;
    parameter_denominator: number;
  }> | null = null;

  for (let x = 0; x <= observedLossCount; x += 1) {
    for (let y = 0; y <= pairCount - observedLossCount; y += 1) {
      const concordantLoss = x;
      const discordant = observedLossCount - x + y;
      const parameterNumerator = observedLossCount + x + y;
      const thresholdComparison = BigInt(parameterNumerator) * BigInt(input.threshold.denominator)
        - BigInt(input.threshold.numerator) * BigInt(2 * pairCount);
      const inCompositeNull = input.claim === "at_most"
        ? thresholdComparison > 0n
        : thresholdComparison <= 0n;
      if (!inCompositeNull) continue;
      const binomialBoundary = observedLossCount - concordantLoss;
      const binomialTail = input.claim === "at_most"
        ? binomialPrefix(prefixes, discordant, binomialBoundary)
        : binomialSuffix(prefixes, discordant, binomialBoundary);
      const tailCount = binomialTail * (1n << BigInt(pairCount - discordant));
      if (tailCount > maximumTailCount || maximizingSchedule === null) {
        maximumTailCount = tailCount;
        maximizingSchedule = {
          observed_loss_concordant_pair_count: concordantLoss,
          candidate_potential_discordant_pair_count: discordant,
          unobserved_loss_after_observed_loss_count: x,
          unobserved_loss_after_observed_no_loss_count: y,
          parameter_numerator: parameterNumerator,
          parameter_denominator: 2 * pairCount,
        };
      }
    }
  }

  return resultWithDigest({
    contract_version: "aionis_learning_absolute_risk_exact_result_v1" as const,
    gate_policy_binding: GATE_POLICY_BINDING,
    pair_count: pairCount,
    observed_candidate_loss_count: observedLossCount,
    claim: input.claim,
    composite_null: input.claim === "at_most"
      ? "parameter_above_threshold" as const
      : "parameter_at_or_below_threshold" as const,
    tail_rule: input.claim === "at_most" ? "inclusive_lower" as const : "inclusive_upper" as const,
    threshold: input.threshold,
    rejection_alpha: input.rejection_alpha,
    max_tail_count: maximumTailCount.toString(),
    assignment_count: assignmentCount.toString(),
    claim_supported: claimSupported({
      maxTailCount: maximumTailCount,
      assignmentCount,
      rejectionAlpha: input.rejection_alpha,
    }),
    maximizing_schedule: maximizingSchedule,
    arithmetic: "exact_bigint" as const,
  });
}

function shiftedBits(bits: bigint, shift: number): bigint {
  return shift >= 0 ? bits << BigInt(shift) : bits >> BigInt(-shift);
}

function leastSetBitIndex(bits: bigint): number | null {
  if (bits === 0n) return null;
  const least = bits & -bits;
  return least.toString(2).length - 1;
}

function greatestSetBitIndex(bits: bigint): number | null {
  return bits === 0n ? null : bits.toString(2).length - 1;
}

function minimumFeasibleEffect(
  bits: bigint,
  minimumEffect: number,
  offset: number,
): number | null {
  const minimumPosition = offset + minimumEffect;
  const retained = minimumPosition <= 0
    ? bits
    : bits & ~((1n << BigInt(minimumPosition)) - 1n);
  const position = leastSetBitIndex(retained);
  return position === null ? null : position - offset;
}

function maximumFeasibleEffect(
  bits: bigint,
  maximumEffect: number,
  offset: number,
): number | null {
  const maximumPosition = offset + maximumEffect;
  if (maximumPosition < 0) return null;
  const retained = bits & ((1n << BigInt(maximumPosition + 1)) - 1n);
  const position = greatestSetBitIndex(retained);
  return position === null ? null : position - offset;
}

function riskDifferenceTailCount(args: {
  pairCount: number;
  observedStatistic: number;
  effectNumerator: number;
  singleStepCount: number;
  doubleStepCount: number;
  tail: "lower" | "upper";
  rows: readonly (readonly bigint[])[];
  prefixes: readonly (readonly bigint[])[];
}): bigint {
  let tailCount = 0n;
  const qRow = args.rows[args.singleStepCount]!;
  for (let positiveSingleSteps = 0;
    positiveSingleSteps <= args.singleStepCount;
    positiveSingleSteps += 1) {
    const residual = 2 * args.observedStatistic
      - args.effectNumerator
      - (2 * positiveSingleSteps - args.singleStepCount)
      + 2 * args.doubleStepCount;
    const doubleTail = args.tail === "lower"
      ? binomialPrefix(
        args.prefixes,
        args.doubleStepCount,
        Math.floor(residual / 4),
      )
      : binomialSuffix(
        args.prefixes,
        args.doubleStepCount,
        Math.ceil(residual / 4),
      );
    tailCount += qRow[positiveSingleSteps]! * doubleTail;
  }
  return tailCount * (1n << BigInt(
    args.pairCount - args.singleStepCount - args.doubleStepCount,
  ));
}

function riskDifferenceSchedulePrecedes(
  candidate: Readonly<{
    single_step_pair_count: number;
    double_step_pair_count: number;
    effect_numerator: number;
  }>,
  current: Readonly<{
    single_step_pair_count: number;
    double_step_pair_count: number;
    effect_numerator: number;
  }>,
): boolean {
  if (candidate.single_step_pair_count !== current.single_step_pair_count) {
    return candidate.single_step_pair_count < current.single_step_pair_count;
  }
  if (candidate.double_step_pair_count !== current.double_step_pair_count) {
    return candidate.double_step_pair_count < current.double_step_pair_count;
  }
  return candidate.effect_numerator < current.effect_numerator;
}

export function evaluateLearningRiskDifferenceExact(
  inputValue: unknown,
) {
  const input = RiskDifferenceInputSchema.parse(inputValue);
  const pairCount = input.pair_count;
  const observedStatistic = input.observed_contrasts.reduce<number>(
    (sum, contrast) => sum + contrast,
    0,
  );
  const offset = 2 * pairCount;
  const stateBase = pairCount + 1;
  let states = new Map<number, bigint>([[0, 1n << BigInt(offset)]]);
  for (const observedContrast of input.observed_contrasts) {
    const next = new Map<number, bigint>();
    for (const [stateKey, bits] of states) {
      const singleStepCount = Math.floor(stateKey / stateBase);
      const doubleStepCount = stateKey % stateBase;
      for (const alternateContrast of [-1, 0, 1] as const) {
        const difference = Math.abs(observedContrast - alternateContrast);
        const nextSingleStepCount = singleStepCount + (difference === 1 ? 1 : 0);
        const nextDoubleStepCount = doubleStepCount + (difference === 2 ? 1 : 0);
        const nextKey = nextSingleStepCount * stateBase + nextDoubleStepCount;
        const shifted = shiftedBits(bits, observedContrast + alternateContrast);
        next.set(nextKey, (next.get(nextKey) ?? 0n) | shifted);
      }
    }
    states = next;
  }

  const scaledThresholdNumerator = BigInt(input.threshold.numerator) * BigInt(2 * pairCount);
  const scaledThresholdDenominator = BigInt(input.threshold.denominator);
  const truncatedThreshold = scaledThresholdNumerator / scaledThresholdDenominator;
  const hasNegativeRemainder = scaledThresholdNumerator < 0n
    && scaledThresholdNumerator % scaledThresholdDenominator !== 0n;
  const maximumSafeEffect = Number(truncatedThreshold - (hasNegativeRemainder ? 1n : 0n));
  const minimumUnsafeEffect = maximumSafeEffect + 1;
  const rows = pascalRows(pairCount);
  const prefixes = pascalPrefixes(rows);
  let maximumTailCount = 0n;
  let maximizingSchedule: Readonly<{
    single_step_pair_count: number;
    double_step_pair_count: number;
    effect_numerator: number;
    effect_denominator: number;
  }> | null = null;

  for (const [stateKey, bits] of states) {
    const singleStepCount = Math.floor(stateKey / stateBase);
    const doubleStepCount = stateKey % stateBase;
    const effectNumerator = input.claim === "at_most"
      ? minimumFeasibleEffect(bits, minimumUnsafeEffect, offset)
      : maximumFeasibleEffect(bits, maximumSafeEffect, offset);
    if (effectNumerator === null) continue;
    const tailCount = riskDifferenceTailCount({
      pairCount,
      observedStatistic,
      effectNumerator,
      singleStepCount,
      doubleStepCount,
      tail: input.claim === "at_most" ? "lower" : "upper",
      rows,
      prefixes,
    });
    const candidateSchedule = {
      single_step_pair_count: singleStepCount,
      double_step_pair_count: doubleStepCount,
      effect_numerator: effectNumerator,
      effect_denominator: 2 * pairCount,
    };
    if (tailCount > maximumTailCount
      || maximizingSchedule === null
      || (tailCount === maximumTailCount
        && riskDifferenceSchedulePrecedes(candidateSchedule, maximizingSchedule))) {
      maximumTailCount = tailCount;
      maximizingSchedule = candidateSchedule;
    }
  }

  const assignmentCount = 1n << BigInt(pairCount);
  return resultWithDigest({
    contract_version: "aionis_learning_risk_difference_exact_result_v1" as const,
    gate_policy_binding: GATE_POLICY_BINDING,
    pair_count: pairCount,
    observed_contrast_counts: {
      minus_one: input.observed_contrasts.filter((value) => value === -1).length,
      zero: input.observed_contrasts.filter((value) => value === 0).length,
      plus_one: input.observed_contrasts.filter((value) => value === 1).length,
    },
    observed_contrast_sum: observedStatistic,
    claim: input.claim,
    composite_null: input.claim === "at_most"
      ? "parameter_above_threshold" as const
      : "parameter_at_or_below_threshold" as const,
    tail_rule: input.claim === "at_most" ? "inclusive_lower" as const : "inclusive_upper" as const,
    threshold: input.threshold,
    rejection_alpha: input.rejection_alpha,
    max_tail_count: maximumTailCount.toString(),
    assignment_count: assignmentCount.toString(),
    claim_supported: claimSupported({
      maxTailCount: maximumTailCount,
      assignmentCount,
      rejectionAlpha: input.rejection_alpha,
    }),
    feasible_qc_state_count: states.size,
    maximizing_schedule: maximizingSchedule,
    arithmetic: "exact_bigint" as const,
  });
}

export function evaluateLearningPreResponseAvailabilityExact(
  inputValue: unknown,
) {
  const input = PreResponseAvailabilityInputSchema.parse(inputValue);
  const discordantCount = input.candidate_only_available_count
    + input.control_only_available_count;
  const smallerDiscordantCount = Math.min(
    input.candidate_only_available_count,
    input.control_only_available_count,
  );
  const rows = pascalRows(discordantCount);
  const prefixes = pascalPrefixes(rows);
  const denominator = 1n << BigInt(discordantCount);
  const doubledLowerTail = 2n * binomialPrefix(
    prefixes,
    discordantCount,
    smallerDiscordantCount,
  );
  const numerator = doubledLowerTail > denominator ? denominator : doubledLowerTail;
  const integrityThreshold = GATE_POLICY.config.paired_pre_response_imbalance_threshold;
  const integrityHold = BigInt(integrityThreshold.denominator) * numerator
    <= BigInt(integrityThreshold.numerator) * denominator;
  return resultWithDigest({
    contract_version: "aionis_learning_pre_response_availability_exact_result_v1" as const,
    gate_policy_binding: GATE_POLICY_BINDING,
    pair_count: input.pair_count,
    candidate_only_available_count: input.candidate_only_available_count,
    control_only_available_count: input.control_only_available_count,
    discordant_pair_count: discordantCount,
    method: "exact_two_sided_mcnemar_sign_v1" as const,
    tail_rule: "inclusive" as const,
    p_value_numerator: numerator.toString(),
    p_value_denominator: denominator.toString(),
    integrity_threshold: integrityThreshold,
    integrity_hold: integrityHold,
    hold_reason: integrityHold ? "pre_response_availability_imbalance" as const : null,
    arithmetic: "exact_bigint" as const,
  });
}

export function evaluateLearningOfflineFiniteHoldoutLattice(
  inputValue: unknown,
) {
  const input = OfflineFiniteHoldoutInputSchema.parse(inputValue);
  const coverageThreshold = GATE_POLICY.config.min_feedback_coverage;
  const harmMargin = GATE_POLICY.config.exploit_harm_noninferiority_margin;
  const utilityMargin = GATE_POLICY.config.accepted_action_noninferiority_margin;
  const exploitReduction = GATE_POLICY.config.min_offline_paired_harm_reduction;
  const checks = {
    harm_assessability_at_least_90_percent:
      BigInt(coverageThreshold.denominator) * BigInt(input.harm_assessable_pair_count)
        >= BigInt(coverageThreshold.numerator) * BigInt(input.case_count),
    utility_assessability_at_least_90_percent:
      BigInt(coverageThreshold.denominator) * BigInt(input.utility_assessable_pair_count)
        >= BigInt(coverageThreshold.numerator) * BigInt(input.case_count),
    harm_noninferiority_at_plus_5_points:
      BigInt(harmMargin.denominator)
        * BigInt(input.candidate_harm_loss_count - input.recorded_harm_loss_count)
        <= BigInt(harmMargin.numerator) * BigInt(input.case_count),
    utility_noninferiority_at_plus_5_points:
      BigInt(utilityMargin.denominator)
        * BigInt(input.candidate_utility_loss_count - input.recorded_utility_loss_count)
        <= BigInt(utilityMargin.numerator) * BigInt(input.case_count),
    exploit_harm_reduction_at_minus_2_points:
      BigInt(exploitReduction.denominator) * BigInt(
        input.candidate_exploit_harm_loss_count - input.recorded_exploit_harm_loss_count,
      ) <= -BigInt(exploitReduction.numerator) * BigInt(input.case_count),
  };
  const holdReasons: string[] = [];
  if (!checks.harm_assessability_at_least_90_percent) {
    holdReasons.push("harm_assessability_below_90_percent");
  }
  if (!checks.utility_assessability_at_least_90_percent) {
    holdReasons.push("utility_assessability_below_90_percent");
  }
  if (!checks.harm_noninferiority_at_plus_5_points) {
    holdReasons.push("harm_noninferiority_failed");
  }
  if (!checks.utility_noninferiority_at_plus_5_points) {
    holdReasons.push("utility_noninferiority_failed");
  }
  if (!checks.exploit_harm_reduction_at_minus_2_points) {
    holdReasons.push("exploit_harm_reduction_failed");
  }
  return resultWithDigest({
    contract_version: "aionis_learning_offline_finite_holdout_lattice_result_v1" as const,
    gate_policy_binding: GATE_POLICY_BINDING,
    input,
    full_risk_set: {
      harm_loss_difference:
        input.candidate_harm_loss_count - input.recorded_harm_loss_count,
      utility_loss_difference:
        input.candidate_utility_loss_count - input.recorded_utility_loss_count,
      exploit_harm_loss_difference:
        input.candidate_exploit_harm_loss_count - input.recorded_exploit_harm_loss_count,
    },
    checks,
    hold_reasons: holdReasons,
    verdict: holdReasons.length === 0 ? "passed" as const : "hold" as const,
    sampling_alpha: null,
    population_claim: null,
    arithmetic: "exact_integer_cross_multiplication" as const,
  });
}
