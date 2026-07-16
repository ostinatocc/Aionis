import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import { sha256Hex } from "../util/crypto.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_ONLINE_ENDPOINTS,
  LEARNING_GATE_POLICY_VERSION,
  resolveLearningGatePolicyOnlineEndpoint,
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

const AbsoluteRiskConfidenceInversionInputSchema = z.object({
  contract_version: z.literal(
    "aionis_learning_absolute_risk_confidence_inversion_exact_input_v1",
  ),
  pair_count: PairCountSchema,
  observed_candidate_loss_count: CountSchema,
  claim: ClaimSchema,
  rejection_alpha: RejectionAlphaSchema,
}).strict().superRefine((value, context) => {
  if (value.observed_candidate_loss_count > value.pair_count) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observed_candidate_loss_count"],
      message: "Observed candidate losses cannot exceed the pair count",
    });
  }
});

const RiskDifferenceConfidenceInversionInputSchema = z.object({
  contract_version: z.literal(
    "aionis_learning_risk_difference_confidence_inversion_exact_input_v1",
  ),
  pair_count: PairCountSchema,
  observed_contrasts: z.array(ContrastSchema).min(1).max(MAX_REGISTERED_PAIR_COUNT),
  claim: ClaimSchema,
  rejection_alpha: RejectionAlphaSchema,
}).strict().superRefine((value, context) => {
  if (value.observed_contrasts.length !== value.pair_count) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observed_contrasts"],
      message: "Observed contrast count must equal the pair count",
    });
  }
});

const ONLINE_ENDPOINT_IDS = LEARNING_GATE_POLICY_ONLINE_ENDPOINTS.map(
  (endpoint) => endpoint.endpoint_id,
) as [
  (typeof LEARNING_GATE_POLICY_ONLINE_ENDPOINTS)[number]["endpoint_id"],
  ...(typeof LEARNING_GATE_POLICY_ONLINE_ENDPOINTS)[number]["endpoint_id"][],
];
const PolicyFixedOnlineEndpointIdSchema = z.enum(ONLINE_ENDPOINT_IDS);
const PolicyFixedCheckpointIndexSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
const PolicyFixedOutcomeSchema = z.enum(["loss", "no_loss", "missing"]);
const PolicyFixedOutcomePairSchema = z.object({
  pair_ordinal: rejectNegativeZero(
    z.number().int().safe().nonnegative().max(MAX_REGISTERED_PAIR_COUNT - 1),
  ),
  candidate_outcome: PolicyFixedOutcomeSchema,
  control_outcome: PolicyFixedOutcomeSchema.optional(),
}).strict();

const PolicyFixedOnlineEndpointInputSchema = z.object({
  contract_version: z.literal(
    "aionis_learning_policy_fixed_online_endpoint_input_v1",
  ),
  endpoint_id: PolicyFixedOnlineEndpointIdSchema,
  checkpoint_index: PolicyFixedCheckpointIndexSchema,
  outcome_pairs: z.array(PolicyFixedOutcomePairSchema).min(1).max(MAX_REGISTERED_PAIR_COUNT),
}).strict().superRefine((value, context) => {
  const checkpointArrayIndex = value.checkpoint_index - 1;
  const expectedPairCount = GATE_POLICY.config.checkpoint_cumulative_matched_pairs[
    checkpointArrayIndex
  ];
  if (value.outcome_pairs.length !== expectedPairCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome_pairs"],
      message: `Checkpoint ${String(value.checkpoint_index)} requires exactly ${String(expectedPairCount)} outcome pairs`,
    });
  }
  for (const [index, pair] of value.outcome_pairs.entries()) {
    if (pair.pair_ordinal !== index) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome_pairs", index, "pair_ordinal"],
        message: "Outcome pairs must have complete canonical ordinals",
      });
    }
  }
  const endpoint = resolveLearningGatePolicyOnlineEndpoint(value.endpoint_id);
  for (const [index, pair] of value.outcome_pairs.entries()) {
    if (endpoint.statistic === "candidate_absolute_risk"
      && pair.control_outcome !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome_pairs", index, "control_outcome"],
        message: "Absolute-risk endpoint pairs must omit the unused control outcome",
      });
    }
    if (endpoint.statistic === "candidate_control_risk_difference"
      && pair.control_outcome === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome_pairs", index, "control_outcome"],
        message: "Risk-difference endpoint pairs require a control outcome",
      });
    }
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
export type LearningAbsoluteRiskConfidenceInversionExactInput = z.infer<
  typeof AbsoluteRiskConfidenceInversionInputSchema
>;
export type LearningRiskDifferenceConfidenceInversionExactInput = z.infer<
  typeof RiskDifferenceConfidenceInversionInputSchema
>;
export type LearningPolicyFixedOnlineEndpointInput = z.infer<
  typeof PolicyFixedOnlineEndpointInputSchema
>;
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

type CanonicalRational = Readonly<{ numerator: number; denominator: number }>;

function canonicalRational(numerator: number, denominator: number): CanonicalRational {
  if (numerator === 0) return Object.freeze({ numerator: 0, denominator: 1 });
  const divisor = greatestCommonDivisor(numerator, denominator);
  return Object.freeze({
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  });
}

type AbsoluteRiskSchedule = Readonly<{
  observed_loss_concordant_pair_count: number;
  candidate_potential_discordant_pair_count: number;
  unobserved_loss_after_observed_loss_count: number;
  unobserved_loss_after_observed_no_loss_count: number;
  parameter_numerator: number;
  parameter_denominator: number;
}>;

type AbsoluteRiskPrepared = Readonly<{
  pairCount: number;
  observedLossCount: number;
  prefixes: readonly (readonly bigint[])[];
  assignmentCount: bigint;
}>;

function prepareAbsoluteRisk(
  pairCount: number,
  observedLossCount: number,
): AbsoluteRiskPrepared {
  const rows = pascalRows(pairCount);
  return {
    pairCount,
    observedLossCount,
    prefixes: pascalPrefixes(rows),
    assignmentCount: 1n << BigInt(pairCount),
  };
}

function visitAbsoluteRiskSchedules(
  prepared: AbsoluteRiskPrepared,
  visitor: (value: Readonly<{
    schedule: AbsoluteRiskSchedule;
    lowerTailCount: bigint;
    upperTailCount: bigint;
  }>) => void,
): void {
  const { pairCount, observedLossCount, prefixes } = prepared;
  for (let x = 0; x <= observedLossCount; x += 1) {
    for (let y = 0; y <= pairCount - observedLossCount; y += 1) {
      const discordant = observedLossCount - x + y;
      const binomialBoundary = observedLossCount - x;
      const identicalAssignmentFactor = 1n << BigInt(pairCount - discordant);
      visitor({
        schedule: {
          observed_loss_concordant_pair_count: x,
          candidate_potential_discordant_pair_count: discordant,
          unobserved_loss_after_observed_loss_count: x,
          unobserved_loss_after_observed_no_loss_count: y,
          parameter_numerator: observedLossCount + x + y,
          parameter_denominator: 2 * pairCount,
        },
        lowerTailCount: binomialPrefix(
          prefixes,
          discordant,
          binomialBoundary,
        ) * identicalAssignmentFactor,
        upperTailCount: binomialSuffix(
          prefixes,
          discordant,
          binomialBoundary,
        ) * identicalAssignmentFactor,
      });
    }
  }
}

function absoluteRiskCompositeTail(args: {
  prepared: AbsoluteRiskPrepared;
  claim: "at_most" | "above";
  threshold: CanonicalRational;
}): Readonly<{
  maximumTailCount: bigint;
  maximizingSchedule: AbsoluteRiskSchedule | null;
}> {
  let maximumTailCount = 0n;
  let maximizingSchedule: AbsoluteRiskSchedule | null = null;
  visitAbsoluteRiskSchedules(args.prepared, ({ schedule, lowerTailCount, upperTailCount }) => {
    const comparison = BigInt(schedule.parameter_numerator)
      * BigInt(args.threshold.denominator)
      - BigInt(args.threshold.numerator) * BigInt(schedule.parameter_denominator);
    const inCompositeNull = args.claim === "at_most" ? comparison > 0n : comparison <= 0n;
    if (!inCompositeNull) return;
    const tailCount = args.claim === "at_most" ? lowerTailCount : upperTailCount;
    if (tailCount > maximumTailCount || maximizingSchedule === null) {
      maximumTailCount = tailCount;
      maximizingSchedule = schedule;
    }
  });
  return { maximumTailCount, maximizingSchedule };
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
  const prepared = prepareAbsoluteRisk(pairCount, observedLossCount);
  const composite = absoluteRiskCompositeTail({
    prepared,
    claim: input.claim,
    threshold: input.threshold,
  });

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
    max_tail_count: composite.maximumTailCount.toString(),
    assignment_count: prepared.assignmentCount.toString(),
    claim_supported: claimSupported({
      maxTailCount: composite.maximumTailCount,
      assignmentCount: prepared.assignmentCount,
      rejectionAlpha: input.rejection_alpha,
    }),
    maximizing_schedule: composite.maximizingSchedule,
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

type RiskDifferenceSchedule = Readonly<{
  single_step_pair_count: number;
  double_step_pair_count: number;
  effect_numerator: number;
  effect_denominator: number;
}>;

type RiskDifferencePrepared = Readonly<{
  pairCount: number;
  observedStatistic: number;
  observedContrastCounts: Readonly<{
    minus_one: number;
    zero: number;
    plus_one: number;
  }>;
  offset: number;
  stateBase: number;
  states: ReadonlyMap<number, bigint>;
  rows: readonly (readonly bigint[])[];
  prefixes: readonly (readonly bigint[])[];
  assignmentCount: bigint;
}>;

function prepareRiskDifference(
  pairCount: number,
  observedContrasts: readonly (-1 | 0 | 1)[],
): RiskDifferencePrepared {
  const observedStatistic = observedContrasts.reduce<number>(
    (sum, contrast) => sum + contrast,
    0,
  );
  const offset = 2 * pairCount;
  const stateBase = pairCount + 1;
  let states = new Map<number, bigint>([[0, 1n << BigInt(offset)]]);
  for (const observedContrast of observedContrasts) {
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
  const rows = pascalRows(pairCount);
  return {
    pairCount,
    observedStatistic,
    observedContrastCounts: {
      minus_one: observedContrasts.filter((value) => value === -1).length,
      zero: observedContrasts.filter((value) => value === 0).length,
      plus_one: observedContrasts.filter((value) => value === 1).length,
    },
    offset,
    stateBase,
    states,
    rows,
    prefixes: pascalPrefixes(rows),
    assignmentCount: 1n << BigInt(pairCount),
  };
}

function riskDifferenceCompositeTailAtLattice(args: {
  prepared: RiskDifferencePrepared;
  claim: "at_most" | "above";
  latticeThresholdNumerator: number;
}): Readonly<{
  maximumTailCount: bigint;
  maximizingSchedule: RiskDifferenceSchedule | null;
}> {
  const {
    pairCount,
    observedStatistic,
    offset,
    stateBase,
    states,
    rows,
    prefixes,
  } = args.prepared;
  const maximumSafeEffect = args.latticeThresholdNumerator;
  const minimumUnsafeEffect = maximumSafeEffect + 1;
  let maximumTailCount = 0n;
  let maximizingSchedule: RiskDifferenceSchedule | null = null;

  for (const [stateKey, bits] of states) {
    const singleStepCount = Math.floor(stateKey / stateBase);
    const doubleStepCount = stateKey % stateBase;
    const effectNumerator = args.claim === "at_most"
      ? minimumFeasibleEffect(bits, minimumUnsafeEffect, offset)
      : maximumFeasibleEffect(bits, maximumSafeEffect, offset);
    if (effectNumerator === null) continue;
    const tailCount = riskDifferenceTailCount({
      pairCount,
      observedStatistic,
      effectNumerator,
      singleStepCount,
      doubleStepCount,
      tail: args.claim === "at_most" ? "lower" : "upper",
      rows,
      prefixes,
    });
    const candidateSchedule: RiskDifferenceSchedule = {
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
  return { maximumTailCount, maximizingSchedule };
}

function floorRationalOnLattice(
  threshold: CanonicalRational,
  latticeDenominator: number,
): number {
  const scaledNumerator = BigInt(threshold.numerator) * BigInt(latticeDenominator);
  const denominator = BigInt(threshold.denominator);
  const truncated = scaledNumerator / denominator;
  return Number(
    scaledNumerator < 0n && scaledNumerator % denominator !== 0n
      ? truncated - 1n
      : truncated,
  );
}

export function evaluateLearningRiskDifferenceExact(
  inputValue: unknown,
) {
  const input = RiskDifferenceInputSchema.parse(inputValue);
  const pairCount = input.pair_count;
  const prepared = prepareRiskDifference(pairCount, input.observed_contrasts);
  const composite = riskDifferenceCompositeTailAtLattice({
    prepared,
    claim: input.claim,
    latticeThresholdNumerator: floorRationalOnLattice(input.threshold, 2 * pairCount),
  });
  return resultWithDigest({
    contract_version: "aionis_learning_risk_difference_exact_result_v1" as const,
    gate_policy_binding: GATE_POLICY_BINDING,
    pair_count: pairCount,
    observed_contrast_counts: prepared.observedContrastCounts,
    observed_contrast_sum: prepared.observedStatistic,
    claim: input.claim,
    composite_null: input.claim === "at_most"
      ? "parameter_above_threshold" as const
      : "parameter_at_or_below_threshold" as const,
    tail_rule: input.claim === "at_most" ? "inclusive_lower" as const : "inclusive_upper" as const,
    threshold: input.threshold,
    rejection_alpha: input.rejection_alpha,
    max_tail_count: composite.maximumTailCount.toString(),
    assignment_count: prepared.assignmentCount.toString(),
    claim_supported: claimSupported({
      maxTailCount: composite.maximumTailCount,
      assignmentCount: prepared.assignmentCount,
      rejectionAlpha: input.rejection_alpha,
    }),
    feasible_qc_state_count: prepared.states.size,
    maximizing_schedule: composite.maximizingSchedule,
    arithmetic: "exact_bigint" as const,
  });
}

type ExactInversionPoint<Schedule> = Readonly<{
  lattice_numerator: number;
  lattice_denominator: number;
  threshold: CanonicalRational;
  max_tail_count: string;
  assignment_count: string;
  composite_null_rejected: boolean;
  composite_null_empty: boolean;
  maximizing_schedule: Schedule | null;
}>;

function exactInversionPoint<Schedule>(args: {
  latticeNumerator: number;
  latticeDenominator: number;
  maximumTailCount: bigint;
  assignmentCount: bigint;
  rejectionAlpha: CanonicalRational;
  maximizingSchedule: Schedule | null;
}): ExactInversionPoint<Schedule> {
  return {
    lattice_numerator: args.latticeNumerator,
    lattice_denominator: args.latticeDenominator,
    threshold: canonicalRational(args.latticeNumerator, args.latticeDenominator),
    max_tail_count: args.maximumTailCount.toString(),
    assignment_count: args.assignmentCount.toString(),
    composite_null_rejected: claimSupported({
      maxTailCount: args.maximumTailCount,
      assignmentCount: args.assignmentCount,
      rejectionAlpha: args.rejectionAlpha,
    }),
    composite_null_empty: args.maximizingSchedule === null,
    maximizing_schedule: args.maximizingSchedule,
  };
}

function inversionBoundary<Schedule>(args: {
  claim: "at_most" | "above";
  minimumNumerator: number;
  maximumNumerator: number;
  latticeDenominator: number;
  pointAt: (latticeNumerator: number) => ExactInversionPoint<Schedule>;
  search: "exhaustive" | "binary";
}): Readonly<{
  boundaryStatus:
    | "exact_transition"
    | "domain_limit_only"
    | "all_lattice_nulls_rejected";
  lastNonRejected: ExactInversionPoint<Schedule> | null;
  firstRejected: ExactInversionPoint<Schedule> | null;
  confidenceBound: Readonly<{
    relation: "at_most" | "at_least";
    numerator: number;
    denominator: number;
    origin: "test_inversion" | "parameter_domain";
  }>;
}> {
  const latticePointCount = args.maximumNumerator - args.minimumNumerator + 1;
  const numeratorAtScanIndex = (scanIndex: number): number => args.claim === "at_most"
    ? args.minimumNumerator + scanIndex
    : args.maximumNumerator - scanIndex;
  let firstRejectedIndex: number | null = null;

  if (args.search === "exhaustive") {
    for (let scanIndex = 0; scanIndex < latticePointCount; scanIndex += 1) {
      if (args.pointAt(numeratorAtScanIndex(scanIndex)).composite_null_rejected) {
        firstRejectedIndex = scanIndex;
        break;
      }
    }
  } else {
    let lower = 0;
    let upper = latticePointCount;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      if (args.pointAt(numeratorAtScanIndex(middle)).composite_null_rejected) {
        upper = middle;
      } else {
        lower = middle + 1;
      }
    }
    if (lower < latticePointCount) firstRejectedIndex = lower;
  }

  if (firstRejectedIndex === null) {
    const domainNumerator = args.claim === "at_most"
      ? args.maximumNumerator
      : args.minimumNumerator;
    return {
      boundaryStatus: "domain_limit_only",
      lastNonRejected: args.pointAt(domainNumerator),
      firstRejected: null,
      confidenceBound: {
        relation: args.claim === "at_most" ? "at_most" : "at_least",
        numerator: domainNumerator,
        denominator: args.latticeDenominator,
        origin: "parameter_domain",
      },
    };
  }

  const firstRejectedNumerator = numeratorAtScanIndex(firstRejectedIndex);
  const firstRejected = args.pointAt(firstRejectedNumerator);
  const lastNonRejected = firstRejectedIndex === 0
    ? null
    : args.pointAt(numeratorAtScanIndex(firstRejectedIndex - 1));
  if (lastNonRejected?.composite_null_rejected === true
    || !firstRejected.composite_null_rejected) {
    throw new Error("Exact confidence inversion rejection boundary is not monotone");
  }
  return {
    boundaryStatus: firstRejectedIndex === 0
      ? "all_lattice_nulls_rejected"
      : "exact_transition",
    lastNonRejected,
    firstRejected,
    confidenceBound: {
      relation: args.claim === "at_most" ? "at_most" : "at_least",
      numerator: args.claim === "at_most"
        ? firstRejectedNumerator
        : firstRejectedNumerator + 1,
      denominator: args.latticeDenominator,
      origin: "test_inversion",
    },
  };
}

export function evaluateLearningAbsoluteRiskConfidenceInversionExact(
  inputValue: unknown,
) {
  const input = AbsoluteRiskConfidenceInversionInputSchema.parse(inputValue);
  const pairCount = input.pair_count;
  const latticeDenominator = 2 * pairCount;
  const prepared = prepareAbsoluteRisk(
    pairCount,
    input.observed_candidate_loss_count,
  );
  type EnvelopeEntry = Readonly<{
    maximumTailCount: bigint;
    maximizingSchedule: AbsoluteRiskSchedule | null;
    visitOrdinal: number;
  }>;
  const perParameter: EnvelopeEntry[] = Array.from(
    { length: latticeDenominator + 1 },
    () => ({ maximumTailCount: 0n, maximizingSchedule: null, visitOrdinal: Infinity }),
  );
  let visitOrdinal = 0;
  visitAbsoluteRiskSchedules(prepared, ({ schedule, lowerTailCount, upperTailCount }) => {
    const tailCount = input.claim === "at_most" ? lowerTailCount : upperTailCount;
    const current = perParameter[schedule.parameter_numerator]!;
    if (tailCount > current.maximumTailCount
      || (tailCount === current.maximumTailCount && visitOrdinal < current.visitOrdinal)) {
      perParameter[schedule.parameter_numerator] = {
        maximumTailCount: tailCount,
        maximizingSchedule: schedule,
        visitOrdinal,
      };
    }
    visitOrdinal += 1;
  });

  const envelope: EnvelopeEntry[] = Array.from(
    { length: latticeDenominator + 1 },
    () => ({ maximumTailCount: 0n, maximizingSchedule: null, visitOrdinal: Infinity }),
  );
  let running: EnvelopeEntry = {
    maximumTailCount: 0n,
    maximizingSchedule: null,
    visitOrdinal: Infinity,
  };
  const takeBetter = (candidate: EnvelopeEntry, current: EnvelopeEntry): EnvelopeEntry =>
    candidate.maximizingSchedule !== null
      && (current.maximizingSchedule === null
        || candidate.maximumTailCount > current.maximumTailCount
        || (candidate.maximumTailCount === current.maximumTailCount
          && candidate.visitOrdinal < current.visitOrdinal))
      ? candidate
      : current;
  if (input.claim === "at_most") {
    for (let thresholdNumerator = latticeDenominator;
      thresholdNumerator >= 0;
      thresholdNumerator -= 1) {
      if (thresholdNumerator < latticeDenominator) {
        running = takeBetter(perParameter[thresholdNumerator + 1]!, running);
      }
      envelope[thresholdNumerator] = running;
    }
  } else {
    for (let thresholdNumerator = 0;
      thresholdNumerator <= latticeDenominator;
      thresholdNumerator += 1) {
      running = takeBetter(perParameter[thresholdNumerator]!, running);
      envelope[thresholdNumerator] = running;
    }
  }

  const points = new Map<number, ExactInversionPoint<AbsoluteRiskSchedule>>();
  const pointAt = (latticeNumerator: number): ExactInversionPoint<AbsoluteRiskSchedule> => {
    const cached = points.get(latticeNumerator);
    if (cached) return cached;
    const entry = envelope[latticeNumerator]!;
    const point = exactInversionPoint({
      latticeNumerator,
      latticeDenominator,
      maximumTailCount: entry.maximumTailCount,
      assignmentCount: prepared.assignmentCount,
      rejectionAlpha: input.rejection_alpha,
      maximizingSchedule: entry.maximizingSchedule,
    });
    points.set(latticeNumerator, point);
    return point;
  };
  const boundary = inversionBoundary({
    claim: input.claim,
    minimumNumerator: 0,
    maximumNumerator: latticeDenominator,
    latticeDenominator,
    pointAt,
    search: "exhaustive",
  });
  return resultWithDigest({
    contract_version:
      "aionis_learning_absolute_risk_confidence_inversion_exact_result_v1" as const,
    gate_policy_binding: GATE_POLICY_BINDING,
    estimand: "candidate_absolute_risk" as const,
    pair_count: pairCount,
    observed_candidate_loss_count: input.observed_candidate_loss_count,
    claim: input.claim,
    composite_null: input.claim === "at_most"
      ? "parameter_above_threshold" as const
      : "parameter_at_or_below_threshold" as const,
    tail_rule: input.claim === "at_most" ? "inclusive_lower" as const : "inclusive_upper" as const,
    rejection_alpha: input.rejection_alpha,
    confidence_coefficient: canonicalRational(
      input.rejection_alpha.denominator - input.rejection_alpha.numerator,
      input.rejection_alpha.denominator,
    ),
    lattice: {
      minimum_numerator: 0,
      maximum_numerator: latticeDenominator,
      denominator: latticeDenominator,
      step_numerator: 1,
      scan_order: input.claim === "at_most" ? "ascending" as const : "descending" as const,
    },
    boundary_status: boundary.boundaryStatus,
    last_non_rejected_lattice_point: boundary.lastNonRejected,
    first_rejected_lattice_point: boundary.firstRejected,
    confidence_bound: boundary.confidenceBound,
    inversion_method: "exact_exhaustive_full_lattice_envelope_v1" as const,
    parameter_source: "caller_supplied_mathematical_diagnostic" as const,
    authority_role: "diagnostic_only" as const,
    arithmetic: "exact_bigint" as const,
  });
}

export function evaluateLearningRiskDifferenceConfidenceInversionExact(
  inputValue: unknown,
) {
  const input = RiskDifferenceConfidenceInversionInputSchema.parse(inputValue);
  const pairCount = input.pair_count;
  const latticeDenominator = 2 * pairCount;
  const prepared = prepareRiskDifference(pairCount, input.observed_contrasts);
  const points = new Map<number, ExactInversionPoint<RiskDifferenceSchedule>>();
  const pointAt = (latticeNumerator: number): ExactInversionPoint<RiskDifferenceSchedule> => {
    const cached = points.get(latticeNumerator);
    if (cached) return cached;
    const composite = riskDifferenceCompositeTailAtLattice({
      prepared,
      claim: input.claim,
      latticeThresholdNumerator: latticeNumerator,
    });
    const point = exactInversionPoint({
      latticeNumerator,
      latticeDenominator,
      maximumTailCount: composite.maximumTailCount,
      assignmentCount: prepared.assignmentCount,
      rejectionAlpha: input.rejection_alpha,
      maximizingSchedule: composite.maximizingSchedule,
    });
    points.set(latticeNumerator, point);
    return point;
  };
  const boundary = inversionBoundary({
    claim: input.claim,
    minimumNumerator: -latticeDenominator,
    maximumNumerator: latticeDenominator,
    latticeDenominator,
    pointAt,
    search: "binary",
  });
  return resultWithDigest({
    contract_version:
      "aionis_learning_risk_difference_confidence_inversion_exact_result_v1" as const,
    gate_policy_binding: GATE_POLICY_BINDING,
    estimand: "candidate_control_risk_difference" as const,
    pair_count: pairCount,
    observed_contrast_counts: prepared.observedContrastCounts,
    observed_contrast_sum: prepared.observedStatistic,
    claim: input.claim,
    composite_null: input.claim === "at_most"
      ? "parameter_above_threshold" as const
      : "parameter_at_or_below_threshold" as const,
    tail_rule: input.claim === "at_most" ? "inclusive_lower" as const : "inclusive_upper" as const,
    rejection_alpha: input.rejection_alpha,
    confidence_coefficient: canonicalRational(
      input.rejection_alpha.denominator - input.rejection_alpha.numerator,
      input.rejection_alpha.denominator,
    ),
    lattice: {
      minimum_numerator: -latticeDenominator,
      maximum_numerator: latticeDenominator,
      denominator: latticeDenominator,
      step_numerator: 1,
      scan_order: input.claim === "at_most" ? "ascending" as const : "descending" as const,
    },
    boundary_status: boundary.boundaryStatus,
    last_non_rejected_lattice_point: boundary.lastNonRejected,
    first_rejected_lattice_point: boundary.firstRejected,
    confidence_bound: boundary.confidenceBound,
    inversion_method: "exact_monotone_boundary_search_over_full_lattice_v1" as const,
    parameter_source: "caller_supplied_mathematical_diagnostic" as const,
    authority_role: "diagnostic_only" as const,
    feasible_qc_state_count: prepared.states.size,
    arithmetic: "exact_bigint" as const,
  });
}

function encodePolicyFixedOutcome(
  outcome: "loss" | "no_loss" | "missing",
  missingnessRule: "missing_as_loss" | "missing_as_no_loss" | "not_used",
): 0 | 1 {
  if (outcome === "loss") return 1;
  if (outcome === "no_loss") return 0;
  if (missingnessRule === "missing_as_loss") return 1;
  if (missingnessRule === "missing_as_no_loss") return 0;
  throw new Error("Policy-fixed endpoint attempted to encode an unused outcome arm");
}

export function evaluateLearningPolicyFixedOnlineEndpoint(
  inputValue: unknown,
) {
  const input = PolicyFixedOnlineEndpointInputSchema.parse(inputValue);
  const endpoint = resolveLearningGatePolicyOnlineEndpoint(input.endpoint_id);
  const checkpoint = GATE_POLICY.implementation_contract.golden_vectors[
    input.checkpoint_index - 1
  ]!;
  const threshold = GATE_POLICY.config[endpoint.threshold_config_key];
  const registeredRejectionAlpha = GATE_POLICY.config[
    endpoint.rejection_alpha_config_key
  ];
  const canonicalOutcomeInputSha256 = sha256Hex(stableStringify({
    contract_version: "aionis_learning_policy_fixed_endpoint_outcome_input_v1",
    endpoint_id: endpoint.endpoint_id,
    checkpoint_index: input.checkpoint_index,
    outcome_pairs: input.outcome_pairs,
  }));
  const candidateMissingCount = input.outcome_pairs.filter(
    (pair) => pair.candidate_outcome === "missing",
  ).length;
  const controlMissingCount = input.outcome_pairs.filter(
    (pair) => pair.control_outcome === "missing",
  ).length;
  const checkpointEligible = endpoint.eligible_checkpoint_indexes.some(
    (checkpointIndex) => checkpointIndex === input.checkpoint_index,
  );
  const commonResult = {
    contract_version: "aionis_learning_policy_fixed_online_endpoint_result_v1" as const,
    gate_policy_binding: GATE_POLICY_BINDING,
    endpoint_contract: endpoint,
    checkpoint: {
      checkpoint_index: checkpoint.checkpoint_index,
      checkpoint_kind: checkpoint.checkpoint_kind,
      cumulative_matched_pairs: checkpoint.cumulative_matched_pairs,
      confirmatory_alpha_per_direction: checkpoint.confirmatory_alpha_per_direction,
      promotion_or_demotion_claim_allowed:
        checkpoint.promotion_or_demotion_claim_allowed,
    },
    canonical_outcome_input_sha256: canonicalOutcomeInputSha256,
    input_trust: "caller_supplied_non_authority" as const,
    scheduled_pair_count: input.outcome_pairs.length,
    missing_outcome_counts: {
      candidate: candidateMissingCount,
      control: controlMissingCount,
    },
    fixed_parameters: {
      claim: endpoint.claim,
      threshold,
      registered_rejection_alpha: registeredRejectionAlpha,
      effective_rejection_alpha: checkpointEligible
        ? registeredRejectionAlpha
        : checkpoint.confirmatory_alpha_per_direction,
      missingness_encoding: endpoint.missingness_encoding,
    },
    policy_registry_status: GATE_POLICY.registry_status,
    production_authority_eligible: false as const,
    authority_action: null,
    authority_mutation: false as const,
  };
  if (!checkpointEligible) {
    return resultWithDigest({
      ...commonResult,
      evaluation_status: "not_applicable_at_checkpoint" as const,
      encoded_sufficient_statistic: null,
      direct_test: null,
      confidence_inversion: null,
      endpoint_claim_supported: null,
      statistical_signal: {
        promotion_iut_component_pass: null,
        demotion_claim_supported: null,
        automatic_safety_trigger_candidate: null,
      },
    });
  }

  if (endpoint.statistic === "candidate_absolute_risk") {
    const observedCandidateLossCount = input.outcome_pairs.reduce<number>(
      (count, pair) => count + encodePolicyFixedOutcome(
        pair.candidate_outcome,
        endpoint.missingness_encoding.candidate,
      ),
      0,
    );
    const directTest = evaluateLearningAbsoluteRiskExact({
      contract_version: "aionis_learning_absolute_risk_exact_input_v1",
      pair_count: input.outcome_pairs.length,
      observed_candidate_loss_count: observedCandidateLossCount,
      claim: endpoint.claim,
      threshold,
      rejection_alpha: registeredRejectionAlpha,
    });
    const confidenceInversion = evaluateLearningAbsoluteRiskConfidenceInversionExact({
      contract_version:
        "aionis_learning_absolute_risk_confidence_inversion_exact_input_v1",
      pair_count: input.outcome_pairs.length,
      observed_candidate_loss_count: observedCandidateLossCount,
      claim: endpoint.claim,
      rejection_alpha: registeredRejectionAlpha,
    });
    return resultWithDigest({
      ...commonResult,
      evaluation_status: "evaluated" as const,
      encoded_sufficient_statistic: {
        kind: "candidate_absolute_loss_count" as const,
        observed_candidate_loss_count: observedCandidateLossCount,
      },
      direct_test: directTest,
      confidence_inversion: confidenceInversion,
      endpoint_claim_supported: directTest.claim_supported,
      statistical_signal: {
        promotion_iut_component_pass: endpoint.verdict_role === "promotion_iut_component"
          ? directTest.claim_supported
          : null,
        demotion_claim_supported: null,
        automatic_safety_trigger_candidate:
          endpoint.verdict_role === "separate_automatic_safety_trigger"
            ? directTest.claim_supported
            : null,
      },
    });
  }

  const observedContrasts = input.outcome_pairs.map((pair): -1 | 0 | 1 => {
    const candidateLoss = encodePolicyFixedOutcome(
      pair.candidate_outcome,
      endpoint.missingness_encoding.candidate,
    );
    const controlOutcome = pair.control_outcome;
    if (controlOutcome === undefined) {
      throw new Error("Risk-difference endpoint pair is missing its control outcome");
    }
    const controlLoss = encodePolicyFixedOutcome(
      controlOutcome,
      endpoint.missingness_encoding.control,
    );
    return (candidateLoss - controlLoss) as -1 | 0 | 1;
  });
  const directTest = evaluateLearningRiskDifferenceExact({
    contract_version: "aionis_learning_risk_difference_exact_input_v1",
    pair_count: input.outcome_pairs.length,
    observed_contrasts: observedContrasts,
    claim: endpoint.claim,
    threshold,
    rejection_alpha: registeredRejectionAlpha,
  });
  const confidenceInversion = evaluateLearningRiskDifferenceConfidenceInversionExact({
    contract_version:
      "aionis_learning_risk_difference_confidence_inversion_exact_input_v1",
    pair_count: input.outcome_pairs.length,
    observed_contrasts: observedContrasts,
    claim: endpoint.claim,
    rejection_alpha: registeredRejectionAlpha,
  });
  return resultWithDigest({
    ...commonResult,
    evaluation_status: "evaluated" as const,
    encoded_sufficient_statistic: {
      kind: "paired_binary_loss_contrasts" as const,
      observed_contrast_counts: directTest.observed_contrast_counts,
      observed_contrast_sum: directTest.observed_contrast_sum,
    },
    direct_test: directTest,
    confidence_inversion: confidenceInversion,
    endpoint_claim_supported: directTest.claim_supported,
    statistical_signal: {
      promotion_iut_component_pass: endpoint.verdict_role === "promotion_iut_component"
        ? directTest.claim_supported
        : null,
      demotion_claim_supported: endpoint.verdict_role === "sole_v1_demotion_endpoint"
        ? directTest.claim_supported
        : null,
      automatic_safety_trigger_candidate: null,
    },
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
