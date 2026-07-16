import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLearningPolicyFixedOnlineEndpoint,
} from "../../src/memory/learning-evidence-gate.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_ONLINE_ENDPOINTS,
  LEARNING_GATE_POLICY_UNRESOLVED_ENDPOINT_REQUIREMENTS,
  LEARNING_GATE_POLICY_VERSION,
  resolveLearningGatePolicy,
} from "../../src/memory/learning-gate-policy.js";

type Outcome = "loss" | "no_loss" | "missing";

function absolutePairs(
  pairCount: number,
  candidateOutcome: Outcome,
) {
  return Array.from({ length: pairCount }, (_, pairOrdinal) => ({
    pair_ordinal: pairOrdinal,
    candidate_outcome: candidateOutcome,
  }));
}

function differencePairs(
  pairCount: number,
  candidateOutcome: Outcome,
  controlOutcome: Outcome,
) {
  return Array.from({ length: pairCount }, (_, pairOrdinal) => ({
    pair_ordinal: pairOrdinal,
    candidate_outcome: candidateOutcome,
    control_outcome: controlOutcome,
  }));
}

function evaluate(args: {
  endpointId:
    | "exploit_candidate_absolute_harm_readiness"
    | "exploit_harm_noninferiority"
    | "exploit_harm_deterioration"
    | "verified_candidate_absolute_harm_pause";
  checkpointIndex: 1 | 2 | 3;
  outcomePairs: ReturnType<typeof absolutePairs> | ReturnType<typeof differencePairs>;
}) {
  return evaluateLearningPolicyFixedOnlineEndpoint({
    contract_version: "aionis_learning_policy_fixed_online_endpoint_input_v1",
    endpoint_id: args.endpointId,
    checkpoint_index: args.checkpointIndex,
    outcome_pairs: args.outcomePairs,
  });
}

test("the calibration-pending registry freezes only the four unambiguous online roles", () => {
  const policy = resolveLearningGatePolicy(
    LEARNING_GATE_POLICY_ID,
    LEARNING_GATE_POLICY_VERSION,
  );
  assert.deepEqual(
    policy.implementation_contract.online_endpoint_registry,
    LEARNING_GATE_POLICY_ONLINE_ENDPOINTS,
  );
  assert.deepEqual(
    policy.implementation_contract.unresolved_endpoint_requirements,
    LEARNING_GATE_POLICY_UNRESOLVED_ENDPOINT_REQUIREMENTS,
  );
  assert.deepEqual(
    LEARNING_GATE_POLICY_ONLINE_ENDPOINTS.map((endpoint) => endpoint.endpoint_id),
    [
      "exploit_candidate_absolute_harm_readiness",
      "exploit_harm_noninferiority",
      "exploit_harm_deterioration",
      "verified_candidate_absolute_harm_pause",
    ],
  );
  assert.equal(policy.registry_status, "calibration_pending");
  assert.ok(LEARNING_GATE_POLICY_UNRESOLVED_ENDPOINT_REQUIREMENTS.every(
    (requirement) => requirement.status === "unresolved_fail_closed",
  ));
});

test("the wrapper rejects caller-selected policy parameters and noncanonical pair inputs", () => {
  const base = {
    contract_version: "aionis_learning_policy_fixed_online_endpoint_input_v1",
    endpoint_id: "exploit_candidate_absolute_harm_readiness",
    checkpoint_index: 1,
    outcome_pairs: absolutePairs(96, "no_loss"),
  } as const;
  for (const override of [
    { claim: "above" },
    { threshold: { numerator: 1, denominator: 2 } },
    { rejection_alpha: { numerator: 1, denominator: 2 } },
    { missingness_encoding: "caller_selected" },
  ]) {
    assert.throws(
      () => evaluateLearningPolicyFixedOnlineEndpoint({ ...base, ...override }),
      /unrecognized key/i,
    );
  }
  assert.throws(() => evaluateLearningPolicyFixedOnlineEndpoint({
    ...base,
    outcome_pairs: absolutePairs(95, "no_loss"),
  }), /requires exactly 96 outcome pairs/i);
  assert.throws(() => evaluateLearningPolicyFixedOnlineEndpoint({
    ...base,
    outcome_pairs: [
      { ...absolutePairs(96, "no_loss")[0]!, pair_ordinal: 1 },
      ...absolutePairs(96, "no_loss").slice(1),
    ],
  }), /complete canonical ordinals/i);
  assert.throws(() => evaluateLearningPolicyFixedOnlineEndpoint({
    ...base,
    outcome_pairs: differencePairs(96, "no_loss", "no_loss"),
  }), /must omit the unused control outcome/i);
  assert.throws(() => evaluateLearningPolicyFixedOnlineEndpoint({
    ...base,
    endpoint_id: "exploit_harm_noninferiority",
  }), /require a control outcome/i);
});

test("checkpoint 1 spends zero confirmatory alpha and cannot evaluate readiness or demotion", () => {
  for (const result of [
    evaluate({
      endpointId: "exploit_candidate_absolute_harm_readiness",
      checkpointIndex: 1,
      outcomePairs: absolutePairs(96, "no_loss"),
    }),
    evaluate({
      endpointId: "exploit_harm_deterioration",
      checkpointIndex: 1,
      outcomePairs: differencePairs(96, "loss", "no_loss"),
    }),
  ]) {
    assert.equal(result.evaluation_status, "not_applicable_at_checkpoint");
    assert.deepEqual(result.fixed_parameters.effective_rejection_alpha, {
      numerator: 0,
      denominator: 1,
    });
    assert.equal(result.direct_test, null);
    assert.equal(result.confidence_inversion, null);
    assert.equal(result.endpoint_claim_supported, null);
    assert.equal(result.authority_action, null);
    assert.equal(result.authority_mutation, false);
  }
});

test("formal and operational endpoints resolve every decision parameter from policy", () => {
  const readiness = evaluate({
    endpointId: "exploit_candidate_absolute_harm_readiness",
    checkpointIndex: 2,
    outcomePairs: absolutePairs(192, "no_loss"),
  });
  assert.equal(readiness.evaluation_status, "evaluated");
  assert.equal(readiness.fixed_parameters.claim, "at_most");
  assert.deepEqual(readiness.fixed_parameters.threshold, { numerator: 1, denominator: 20 });
  assert.deepEqual(readiness.fixed_parameters.effective_rejection_alpha, {
    numerator: 1,
    denominator: 80,
  });
  assert.equal(readiness.endpoint_contract.verdict_role, "promotion_iut_component");
  assert.equal(
    readiness.statistical_signal.promotion_iut_component_pass,
    readiness.direct_test?.claim_supported,
  );

  const safety = evaluate({
    endpointId: "verified_candidate_absolute_harm_pause",
    checkpointIndex: 1,
    outcomePairs: absolutePairs(96, "loss"),
  });
  assert.equal(safety.evaluation_status, "evaluated");
  assert.equal(safety.fixed_parameters.claim, "above");
  assert.deepEqual(safety.fixed_parameters.effective_rejection_alpha, {
    numerator: 1,
    denominator: 1_000,
  });
  assert.equal(safety.endpoint_claim_supported, true);
  assert.equal(safety.statistical_signal.automatic_safety_trigger_candidate, true);
  assert.equal(safety.input_trust, "caller_supplied_non_authority");
  assert.equal(safety.production_authority_eligible, false);
  assert.equal(safety.authority_action, null);
  assert.equal(safety.authority_mutation, false);
});

test("opposite conservative missingness cannot manufacture readiness or demotion", () => {
  const readiness = evaluate({
    endpointId: "exploit_candidate_absolute_harm_readiness",
    checkpointIndex: 2,
    outcomePairs: absolutePairs(192, "missing"),
  });
  assert.deepEqual(readiness.encoded_sufficient_statistic, {
    kind: "candidate_absolute_loss_count",
    observed_candidate_loss_count: 192,
  });

  const safety = evaluate({
    endpointId: "verified_candidate_absolute_harm_pause",
    checkpointIndex: 2,
    outcomePairs: absolutePairs(192, "missing"),
  });
  assert.deepEqual(safety.encoded_sufficient_statistic, {
    kind: "candidate_absolute_loss_count",
    observed_candidate_loss_count: 0,
  });
  assert.equal(safety.statistical_signal.automatic_safety_trigger_candidate, false);

  const noninferiority = evaluate({
    endpointId: "exploit_harm_noninferiority",
    checkpointIndex: 2,
    outcomePairs: differencePairs(192, "missing", "missing"),
  });
  assert.deepEqual(noninferiority.encoded_sufficient_statistic, {
    kind: "paired_binary_loss_contrasts",
    observed_contrast_counts: { minus_one: 0, zero: 0, plus_one: 192 },
    observed_contrast_sum: 192,
  });

  const demotion = evaluate({
    endpointId: "exploit_harm_deterioration",
    checkpointIndex: 2,
    outcomePairs: differencePairs(192, "missing", "missing"),
  });
  assert.deepEqual(demotion.encoded_sufficient_statistic, {
    kind: "paired_binary_loss_contrasts",
    observed_contrast_counts: { minus_one: 192, zero: 0, plus_one: 0 },
    observed_contrast_sum: -192,
  });
  assert.equal(demotion.statistical_signal.demotion_claim_supported, false);
});

test("policy-fixed direct tests and diagnostic inversions are immutable non-authority results", () => {
  const input = {
    endpointId: "exploit_harm_noninferiority" as const,
    checkpointIndex: 2 as const,
    outcomePairs: differencePairs(192, "no_loss", "no_loss"),
  };
  const first = evaluate(input);
  const replay = evaluate(input);
  assert.deepEqual(replay, first);
  assert.match(first.canonical_outcome_input_sha256, /^[0-9a-f]{64}$/u);
  assert.match(first.result_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(first.direct_test?.claim, first.fixed_parameters.claim);
  assert.deepEqual(first.direct_test?.threshold, first.fixed_parameters.threshold);
  assert.deepEqual(
    first.direct_test?.rejection_alpha,
    first.fixed_parameters.effective_rejection_alpha,
  );
  assert.equal(first.confidence_inversion?.authority_role, "diagnostic_only");
  assert.equal(first.confidence_inversion?.parameter_source,
    "caller_supplied_mathematical_diagnostic");
  assert.equal(first.authority_action, null);
  assert.equal(first.authority_mutation, false);
});
