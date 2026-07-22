import {
  canonicalContinuationClone,
  canonicalContinuationSha256,
  type Sha256,
} from "./contract.js";

export const EFFECT_STATISTICAL_CONTRACT_V1 = canonicalContinuationClone({
  schema_version: "effect_statistical_contract_v1" as const,
  endpoints: {
    harm: "failed_over_observed_non_unknown_outcomes" as const,
    utility: "succeeded_over_observed_non_unknown_outcomes" as const,
    partial: "observed_but_neither_harm_nor_utility" as const,
    unknown: "missing" as const,
    absent_outcome: "missing" as const,
  },
  interval: "newcombe_difference_from_independent_wilson_score_intervals" as const,
  interval_rounding: "outward_to_integer_basis_points" as const,
  confidence_bps: [9_000, 9_500, 9_900] as const,
  admission: "all_closed_policy_checks_must_pass" as const,
});

export const EFFECT_STATISTICAL_CONTRACT_SHA256_V1: Sha256 =
  canonicalContinuationSha256(EFFECT_STATISTICAL_CONTRACT_V1);

export const EFFECT_VERIFIER_CONTRACT_V1 = canonicalContinuationClone({
  schema_version: "effect_verifier_contract_v1" as const,
  cohort: "exact_root_signed_experiment_cohort_and_installation_receipt" as const,
  assignment: "replay_every_hmac_sha256_receipt_from_revealed_committed_seed" as const,
  census: "all_and_only_exact_cohort_assigned_control_or_assigned_candidate_exposures" as const,
  outcome: "latest_legal_outcome_observed_by_cohort_deadline_and_settled_by_cutoff" as const,
  authority: "runtime_rederives_evaluation_before_certificate_persistence" as const,
});

export const EFFECT_VERIFIER_CONTRACT_SHA256_V1: Sha256 =
  canonicalContinuationSha256(EFFECT_VERIFIER_CONTRACT_V1);

export type EffectAdmissionPolicyV1 = Readonly<{
  min_control_exposures: number;
  min_candidate_exposures: number;
  max_missingness_bps: number;
  harm_noninferiority_margin_bps: number;
  utility_min_lift_bps: number;
  confidence_bps: 9_000 | 9_500 | 9_900;
}>;

export type EffectArmObservationCountsV1 = Readonly<{
  assigned_exposure_count: number;
  succeeded_count: number;
  partial_count: number;
  failed_count: number;
  unknown_count: number;
  missing_outcome_count: number;
}>;

export type EffectRateIntervalV1 = Readonly<{
  estimate_bps: number | null;
  lower_bps: number;
  upper_bps: number;
}>;

export type EffectArmEvaluationV1 = EffectArmObservationCountsV1 & Readonly<{
  observed_outcome_count: number;
  missing_total_count: number;
  harm: EffectRateIntervalV1;
  utility: EffectRateIntervalV1;
}>;

export type EffectDifferenceIntervalV1 = Readonly<{
  estimate_bps: number | null;
  lower_bps: number;
  upper_bps: number;
}>;

export type EffectAdmissionRejectionReasonV1 =
  | "control_exposure_minimum_not_met"
  | "candidate_exposure_minimum_not_met"
  | "missingness_limit_exceeded"
  | "harm_noninferiority_not_established"
  | "utility_minimum_lift_not_established";

export type EffectEvidenceEvaluationV1 = Readonly<{
  schema_version: "effect_evidence_evaluation_v1";
  statistical_contract_sha256: Sha256;
  confidence_bps: 9_000 | 9_500 | 9_900;
  control: EffectArmEvaluationV1;
  candidate: EffectArmEvaluationV1;
  total_exposure_count: number;
  missing_outcome_count: number;
  missingness_bps: number;
  harm_difference: EffectDifferenceIntervalV1;
  utility_difference: EffectDifferenceIntervalV1;
  harm_conclusion: "safe" | "harmful" | "inconclusive";
  utility_conclusion: "beneficial" | "neutral" | "harmful" | "inconclusive";
  admission_checks: Readonly<{
    min_control_exposures_met: boolean;
    min_candidate_exposures_met: boolean;
    missingness_within_limit: boolean;
    harm_noninferiority_established: boolean;
    utility_minimum_lift_established: boolean;
  }>;
  admission_state: "admitted" | "rejected";
  rejection_reasons: readonly EffectAdmissionRejectionReasonV1[];
  evaluation_sha256: Sha256;
}>;

const Z_BY_CONFIDENCE = Object.freeze({
  9000: 1.6448536269514722,
  9500: 1.959963984540054,
  9900: 2.5758293035489004,
} as const);

const REASON_ORDER: readonly EffectAdmissionRejectionReasonV1[] = Object.freeze([
  "control_exposure_minimum_not_met",
  "candidate_exposure_minimum_not_met",
  "missingness_limit_exceeded",
  "harm_noninferiority_not_established",
  "utility_minimum_lift_not_established",
]);

function fail(code: string): never {
  throw new Error(`effect_evaluation_${code}`);
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < minimum || (value as number) > maximum) {
    fail(`${field}_invalid`);
  }
  return value as number;
}

function policy(value: EffectAdmissionPolicyV1): EffectAdmissionPolicyV1 {
  const confidence = integer(value.confidence_bps, 9_000, 9_900, "confidence_bps");
  if (confidence !== 9_000 && confidence !== 9_500 && confidence !== 9_900) {
    fail("confidence_bps_not_closed");
  }
  return {
    min_control_exposures: integer(
      value.min_control_exposures,
      1,
      4_096,
      "min_control_exposures",
    ),
    min_candidate_exposures: integer(
      value.min_candidate_exposures,
      1,
      4_096,
      "min_candidate_exposures",
    ),
    max_missingness_bps: integer(
      value.max_missingness_bps,
      0,
      10_000,
      "max_missingness_bps",
    ),
    harm_noninferiority_margin_bps: integer(
      value.harm_noninferiority_margin_bps,
      0,
      10_000,
      "harm_noninferiority_margin_bps",
    ),
    utility_min_lift_bps: integer(
      value.utility_min_lift_bps,
      0,
      10_000,
      "utility_min_lift_bps",
    ),
    confidence_bps: confidence,
  };
}

function counts(value: EffectArmObservationCountsV1, field: string): EffectArmObservationCountsV1 {
  const result = {
    assigned_exposure_count: integer(
      value.assigned_exposure_count,
      0,
      4_096,
      `${field}.assigned_exposure_count`,
    ),
    succeeded_count: integer(value.succeeded_count, 0, 4_096, `${field}.succeeded_count`),
    partial_count: integer(value.partial_count, 0, 4_096, `${field}.partial_count`),
    failed_count: integer(value.failed_count, 0, 4_096, `${field}.failed_count`),
    unknown_count: integer(value.unknown_count, 0, 4_096, `${field}.unknown_count`),
    missing_outcome_count: integer(
      value.missing_outcome_count,
      0,
      4_096,
      `${field}.missing_outcome_count`,
    ),
  };
  const total = result.succeeded_count + result.partial_count + result.failed_count
    + result.unknown_count + result.missing_outcome_count;
  if (total !== result.assigned_exposure_count) fail(`${field}_cardinality_mismatch`);
  return result;
}

function rateInterval(
  successes: number,
  observations: number,
  confidence: 9_000 | 9_500 | 9_900,
): EffectRateIntervalV1 {
  if (observations === 0) {
    return { estimate_bps: null, lower_bps: 0, upper_bps: 10_000 };
  }
  const proportion = successes / observations;
  const z = Z_BY_CONFIDENCE[confidence];
  const z2 = z * z;
  const denominator = 1 + z2 / observations;
  const center = (proportion + z2 / (2 * observations)) / denominator;
  const radius = (z / denominator) * Math.sqrt(
    (proportion * (1 - proportion) / observations)
      + (z2 / (4 * observations * observations)),
  );
  return {
    estimate_bps: Math.round(proportion * 10_000),
    lower_bps: Math.max(0, Math.floor((center - radius) * 10_000)),
    upper_bps: Math.min(10_000, Math.ceil((center + radius) * 10_000)),
  };
}

function armEvaluation(
  value: EffectArmObservationCountsV1,
  confidence: 9_000 | 9_500 | 9_900,
  field: string,
): EffectArmEvaluationV1 {
  const parsed = counts(value, field);
  const observed = parsed.succeeded_count + parsed.partial_count + parsed.failed_count;
  const missing = parsed.unknown_count + parsed.missing_outcome_count;
  return {
    ...parsed,
    observed_outcome_count: observed,
    missing_total_count: missing,
    harm: rateInterval(parsed.failed_count, observed, confidence),
    utility: rateInterval(parsed.succeeded_count, observed, confidence),
  };
}

function difference(
  candidate: EffectRateIntervalV1,
  control: EffectRateIntervalV1,
): EffectDifferenceIntervalV1 {
  return {
    estimate_bps: candidate.estimate_bps === null || control.estimate_bps === null
      ? null
      : candidate.estimate_bps - control.estimate_bps,
    lower_bps: Math.max(-10_000, candidate.lower_bps - control.upper_bps),
    upper_bps: Math.min(10_000, candidate.upper_bps - control.lower_bps),
  };
}

export function evaluateEffectEvidenceV1(input: Readonly<{
  policy: EffectAdmissionPolicyV1;
  control: EffectArmObservationCountsV1;
  candidate: EffectArmObservationCountsV1;
}>): EffectEvidenceEvaluationV1 {
  const thresholds = policy(input.policy);
  const control = armEvaluation(input.control, thresholds.confidence_bps, "control");
  const candidate = armEvaluation(input.candidate, thresholds.confidence_bps, "candidate");
  const total = control.assigned_exposure_count + candidate.assigned_exposure_count;
  if (total > 4_096) fail("total_exposure_count_exceeded");
  const missing = control.missing_total_count + candidate.missing_total_count;
  const missingness = total === 0 ? 10_000 : Math.ceil((missing * 10_000) / total);
  const harm = difference(candidate.harm, control.harm);
  const utility = difference(candidate.utility, control.utility);
  const checks = {
    min_control_exposures_met:
      control.assigned_exposure_count >= thresholds.min_control_exposures,
    min_candidate_exposures_met:
      candidate.assigned_exposure_count >= thresholds.min_candidate_exposures,
    missingness_within_limit: missingness <= thresholds.max_missingness_bps,
    harm_noninferiority_established:
      harm.upper_bps <= thresholds.harm_noninferiority_margin_bps,
    utility_minimum_lift_established:
      utility.lower_bps >= thresholds.utility_min_lift_bps,
  };
  const failed = new Set<EffectAdmissionRejectionReasonV1>();
  if (!checks.min_control_exposures_met) failed.add("control_exposure_minimum_not_met");
  if (!checks.min_candidate_exposures_met) failed.add("candidate_exposure_minimum_not_met");
  if (!checks.missingness_within_limit) failed.add("missingness_limit_exceeded");
  if (!checks.harm_noninferiority_established) {
    failed.add("harm_noninferiority_not_established");
  }
  if (!checks.utility_minimum_lift_established) {
    failed.add("utility_minimum_lift_not_established");
  }
  const rejectionReasons = REASON_ORDER.filter((reason) => failed.has(reason));
  const harmConclusion = checks.harm_noninferiority_established
    ? "safe" as const
    : harm.lower_bps > thresholds.harm_noninferiority_margin_bps
      ? "harmful" as const
      : "inconclusive" as const;
  const utilityConclusion = checks.utility_minimum_lift_established
    ? "beneficial" as const
    : utility.upper_bps < 0
      ? "harmful" as const
      : utility.lower_bps <= 0 && utility.upper_bps >= 0
        ? "neutral" as const
        : "inconclusive" as const;
  const body = {
    schema_version: "effect_evidence_evaluation_v1" as const,
    statistical_contract_sha256: EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
    confidence_bps: thresholds.confidence_bps,
    control,
    candidate,
    total_exposure_count: total,
    missing_outcome_count: missing,
    missingness_bps: missingness,
    harm_difference: harm,
    utility_difference: utility,
    harm_conclusion: harmConclusion,
    utility_conclusion: utilityConclusion,
    admission_checks: checks,
    admission_state: rejectionReasons.length === 0
      ? "admitted" as const
      : "rejected" as const,
    rejection_reasons: rejectionReasons,
  };
  return canonicalContinuationClone({
    ...body,
    evaluation_sha256: canonicalContinuationSha256(body),
  });
}
