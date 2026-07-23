import assert from "node:assert/strict";
import test from "node:test";

import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_STATISTICAL_CONTRACT_V1,
  evaluateEffectEvidenceV1,
  type EffectAdmissionPolicyV1,
  type EffectArmObservationCountsV1,
} from "../../src/continuation/effect-evaluation.js";

const OLD_ENDPOINT_SUBTRACTION_CONTRACT_SHA256 =
  "eee6fc0ecad4703581477cdd38405cc4420e75a32ac62d2fca3562ce6e387099";
const NEWCOMBE_HYBRID_CONTRACT_SHA256 =
  "b87dd50225a36feb44ca4ca3c8a9be2b59a1e7cc02a467fc714308148e0286a3";

function policy(
  confidence_bps: EffectAdmissionPolicyV1["confidence_bps"] = 9_500,
): EffectAdmissionPolicyV1 {
  return {
    min_control_exposures: 1,
    min_candidate_exposures: 1,
    max_missingness_bps: 10_000,
    harm_noninferiority_margin_bps: 10_000,
    utility_min_lift_bps: 0,
    confidence_bps,
  };
}

function observedArm(
  succeeded_count: number,
  observed_outcome_count: number,
): EffectArmObservationCountsV1 {
  return {
    assigned_exposure_count: observed_outcome_count,
    succeeded_count,
    partial_count: observed_outcome_count - succeeded_count,
    failed_count: 0,
    unknown_count: 0,
    missing_outcome_count: 0,
  };
}

function utilityDifference(
  candidateSuccesses: number,
  candidateObservations: number,
  controlSuccesses: number,
  controlObservations: number,
  confidence_bps: EffectAdmissionPolicyV1["confidence_bps"] = 9_500,
) {
  return evaluateEffectEvidenceV1({
    policy: policy(confidence_bps),
    control: observedArm(controlSuccesses, controlObservations),
    candidate: observedArm(candidateSuccesses, candidateObservations),
  });
}

test("effect statistical contract identifies the Newcombe hybrid-score algorithm", () => {
  assert.equal(
    EFFECT_STATISTICAL_CONTRACT_V1.interval,
    "newcombe_hybrid_score_difference_from_independent_wilson_score_intervals",
  );
  assert.notEqual(
    EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
    OLD_ENDPOINT_SUBTRACTION_CONTRACT_SHA256,
  );
  assert.equal(
    EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
    NEWCOMBE_HYBRID_CONTRACT_SHA256,
  );
});

test("Newcombe hybrid matches the published independent-proportion reference vector", () => {
  // Newcombe (1998), Table II example 1: 56/70 versus 48/80.
  // Limits use the uncorrected hybrid-score equations documented by SAS PROC FREQ.
  const expected = [
    { confidence_bps: 9_000 as const, lower_bps: 765, upper_bps: 3_137 },
    { confidence_bps: 9_500 as const, lower_bps: 524, upper_bps: 3_339 },
    { confidence_bps: 9_900 as const, lower_bps: 53, upper_bps: 3_719 },
  ];

  for (const vector of expected) {
    const evaluation = utilityDifference(
      56,
      70,
      48,
      80,
      vector.confidence_bps,
    );
    assert.deepEqual(evaluation.utility_difference, {
      estimate_bps: 2_000,
      lower_bps: vector.lower_bps,
      upper_bps: vector.upper_bps,
    });
  }
});

test("Newcombe combines Wilson deviations by square-and-add, not endpoint subtraction", () => {
  const evaluation = utilityDifference(9, 10, 3, 10);
  assert.deepEqual(evaluation.candidate.utility, {
    estimate_bps: 9_000,
    lower_bps: 5_958,
    upper_bps: 9_822,
  });
  assert.deepEqual(evaluation.control.utility, {
    estimate_bps: 3_000,
    lower_bps: 1_077,
    upper_bps: 6_033,
  });
  assert.deepEqual(evaluation.utility_difference, {
    estimate_bps: 6_000,
    lower_bps: 1_705,
    upper_bps: 8_091,
  });
  assert.notDeepEqual(evaluation.utility_difference, {
    estimate_bps: 6_000,
    lower_bps: -75,
    upper_bps: 8_745,
  });
});

test("Newcombe limits round outward and remain inside the closed risk-difference domain", () => {
  const forward = utilityDifference(10, 10, 0, 20);
  assert.deepEqual(forward.utility_difference, {
    estimate_bps: 10_000,
    lower_bps: 6_790,
    upper_bps: 10_000,
  });

  const reverse = utilityDifference(0, 20, 10, 10);
  assert.deepEqual(reverse.utility_difference, {
    estimate_bps: -10_000,
    lower_bps: -10_000,
    upper_bps: -6_790,
  });
});

test("an arm without observed outcomes preserves the conservative empty-sample interval", () => {
  const empty = observedArm(0, 0);
  const bothEmpty = evaluateEffectEvidenceV1({
    policy: policy(),
    control: empty,
    candidate: empty,
  });
  assert.deepEqual(bothEmpty.control.utility, {
    estimate_bps: null,
    lower_bps: 0,
    upper_bps: 10_000,
  });
  assert.deepEqual(bothEmpty.utility_difference, {
    estimate_bps: null,
    lower_bps: -10_000,
    upper_bps: 10_000,
  });

  const oneEmpty = evaluateEffectEvidenceV1({
    policy: policy(),
    control: empty,
    candidate: observedArm(5, 10),
  });
  assert.deepEqual(oneEmpty.utility_difference, {
    estimate_bps: null,
    lower_bps: -7_635,
    upper_bps: 7_635,
  });
});
