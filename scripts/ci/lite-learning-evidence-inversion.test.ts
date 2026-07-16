import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  evaluateLearningAbsoluteRiskConfidenceInversionExact,
  evaluateLearningAbsoluteRiskExact,
  evaluateLearningRiskDifferenceConfidenceInversionExact,
  evaluateLearningRiskDifferenceExact,
} from "../../src/memory/learning-evidence-gate.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
  resolveLearningGatePolicy,
} from "../../src/memory/learning-gate-policy.js";

type Claim = "at_most" | "above";
type Contrast = -1 | 0 | 1;
type Rational = Readonly<{ numerator: number; denominator: number }>;
type OraclePoint = Readonly<{
  latticeNumerator: number;
  maxTailCount: bigint;
  assignmentCount: bigint;
  compositeNullRejected: boolean;
  compositeNullEmpty: boolean;
}>;
type OracleInversion = Readonly<{
  orderedPoints: readonly OraclePoint[];
  lastNonRejected: OraclePoint | null;
  firstRejected: OraclePoint | null;
}>;

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

function canonicalRational(numerator: number, denominator: number): Rational {
  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
}

function rejectedAtAlpha(
  maxTailCount: bigint,
  assignmentCount: bigint,
  rejectionAlpha: Rational,
): boolean {
  return BigInt(rejectionAlpha.denominator) * maxTailCount
    <= BigInt(rejectionAlpha.numerator) * assignmentCount;
}

function inversionBoundary(points: readonly OraclePoint[]): OracleInversion {
  const firstRejectedIndex = points.findIndex((point) => point.compositeNullRejected);
  if (firstRejectedIndex < 0) {
    return {
      orderedPoints: points,
      lastNonRejected: points.at(-1) ?? null,
      firstRejected: null,
    };
  }
  return {
    orderedPoints: points,
    lastNonRejected: firstRejectedIndex === 0 ? null : points[firstRejectedIndex - 1]!,
    firstRejected: points[firstRejectedIndex]!,
  };
}

function latticeNumerators(args: {
  minimum: number;
  maximum: number;
  claim: Claim;
}): number[] {
  const values: number[] = [];
  if (args.claim === "at_most") {
    for (let value = args.minimum; value <= args.maximum; value += 1) values.push(value);
  } else {
    for (let value = args.maximum; value >= args.minimum; value -= 1) values.push(value);
  }
  return values;
}

function enumerateContrasts(length: number): Contrast[][] {
  let rows: Contrast[][] = [[]];
  for (let index = 0; index < length; index += 1) {
    rows = rows.flatMap((row) => ([-1, 0, 1] as const).map((value) => [...row, value]));
  }
  return rows;
}

// These two oracles enumerate complete compatible schedules and assignments.
// They do not share the production Pascal or (q,c,E) recurrences.
function bruteAbsolutePoint(args: {
  pairCount: number;
  observedLossCount: number;
  claim: Claim;
  latticeNumerator: number;
  rejectionAlpha: Rational;
}): OraclePoint {
  const assignmentCount = 1n << BigInt(args.pairCount);
  let maxTailCount = 0n;
  let compositeNullEmpty = true;
  for (let schedule = 0; schedule < 2 ** args.pairCount; schedule += 1) {
    const alternateLosses = Array.from(
      { length: args.pairCount },
      (_, pairIndex) => (schedule & (2 ** pairIndex)) === 0 ? 0 : 1,
    );
    const parameterNumerator = args.observedLossCount
      + alternateLosses.reduce<number>((sum, loss) => sum + loss, 0);
    const inCompositeNull = args.claim === "at_most"
      ? parameterNumerator > args.latticeNumerator
      : parameterNumerator <= args.latticeNumerator;
    if (!inCompositeNull) continue;
    compositeNullEmpty = false;

    let tailCount = 0n;
    for (let assignment = 0; assignment < 2 ** args.pairCount; assignment += 1) {
      let statistic = 0;
      for (let pairIndex = 0; pairIndex < args.pairCount; pairIndex += 1) {
        const observedLoss = pairIndex < args.observedLossCount ? 1 : 0;
        statistic += (assignment & (2 ** pairIndex)) === 0
          ? observedLoss
          : alternateLosses[pairIndex]!;
      }
      if (args.claim === "at_most"
        ? statistic <= args.observedLossCount
        : statistic >= args.observedLossCount) {
        tailCount += 1n;
      }
    }
    if (tailCount > maxTailCount) maxTailCount = tailCount;
  }
  return {
    latticeNumerator: args.latticeNumerator,
    maxTailCount,
    assignmentCount,
    compositeNullRejected: rejectedAtAlpha(
      maxTailCount,
      assignmentCount,
      args.rejectionAlpha,
    ),
    compositeNullEmpty,
  };
}

function bruteAbsoluteInversion(args: {
  pairCount: number;
  observedLossCount: number;
  claim: Claim;
  rejectionAlpha: Rational;
}): OracleInversion {
  return inversionBoundary(latticeNumerators({
    minimum: 0,
    maximum: 2 * args.pairCount,
    claim: args.claim,
  }).map((latticeNumerator) => bruteAbsolutePoint({ ...args, latticeNumerator })));
}

function bruteRiskDifferencePoint(args: {
  observedContrasts: readonly Contrast[];
  claim: Claim;
  latticeNumerator: number;
  rejectionAlpha: Rational;
}): OraclePoint {
  const pairCount = args.observedContrasts.length;
  const observedStatistic = args.observedContrasts.reduce<number>(
    (sum, contrast) => sum + contrast,
    0,
  );
  const assignmentCount = 1n << BigInt(pairCount);
  let maxTailCount = 0n;
  let compositeNullEmpty = true;
  for (const alternateContrasts of enumerateContrasts(pairCount)) {
    const parameterNumerator = args.observedContrasts.reduce<number>(
      (sum, contrast, pairIndex) => sum + contrast + alternateContrasts[pairIndex]!,
      0,
    );
    const inCompositeNull = args.claim === "at_most"
      ? parameterNumerator > args.latticeNumerator
      : parameterNumerator <= args.latticeNumerator;
    if (!inCompositeNull) continue;
    compositeNullEmpty = false;

    let tailCount = 0n;
    for (let assignment = 0; assignment < 2 ** pairCount; assignment += 1) {
      let statistic = 0;
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        statistic += (assignment & (2 ** pairIndex)) === 0
          ? args.observedContrasts[pairIndex]!
          : alternateContrasts[pairIndex]!;
      }
      if (args.claim === "at_most"
        ? statistic <= observedStatistic
        : statistic >= observedStatistic) {
        tailCount += 1n;
      }
    }
    if (tailCount > maxTailCount) maxTailCount = tailCount;
  }
  return {
    latticeNumerator: args.latticeNumerator,
    maxTailCount,
    assignmentCount,
    compositeNullRejected: rejectedAtAlpha(
      maxTailCount,
      assignmentCount,
      args.rejectionAlpha,
    ),
    compositeNullEmpty,
  };
}

function bruteRiskDifferenceInversion(args: {
  observedContrasts: readonly Contrast[];
  claim: Claim;
  rejectionAlpha: Rational;
}): OracleInversion {
  const pairCount = args.observedContrasts.length;
  return inversionBoundary(latticeNumerators({
    minimum: -2 * pairCount,
    maximum: 2 * pairCount,
    claim: args.claim,
  }).map((latticeNumerator) => bruteRiskDifferencePoint({ ...args, latticeNumerator })));
}

function assertPoint(args: {
  actual: Readonly<Record<string, unknown>> | null;
  expected: OraclePoint | null;
  latticeDenominator: number;
  directResult: Readonly<Record<string, unknown>> | null;
}): void {
  if (args.expected === null) {
    assert.equal(args.actual, null);
    assert.equal(args.directResult, null);
    return;
  }
  assert.ok(args.actual);
  assert.ok(args.directResult);
  assert.equal(args.actual.lattice_numerator, args.expected.latticeNumerator);
  assert.equal(args.actual.lattice_denominator, args.latticeDenominator);
  assert.deepEqual(
    args.actual.threshold,
    canonicalRational(args.expected.latticeNumerator, args.latticeDenominator),
  );
  assert.equal(args.actual.max_tail_count, args.expected.maxTailCount.toString());
  assert.equal(args.actual.assignment_count, args.expected.assignmentCount.toString());
  assert.equal(
    args.actual.composite_null_rejected,
    args.expected.compositeNullRejected,
  );
  assert.equal(args.actual.composite_null_empty, args.expected.compositeNullEmpty);

  // Boundary reporting is diagnostic. Every reported point must be byte-for-
  // byte consistent with the direct test that remains the readiness decision.
  assert.equal(args.actual.max_tail_count, args.directResult.max_tail_count);
  assert.equal(args.actual.assignment_count, args.directResult.assignment_count);
  assert.equal(
    args.actual.composite_null_rejected,
    args.directResult.claim_supported,
  );
  assert.equal(
    args.actual.composite_null_empty,
    args.directResult.maximizing_schedule === null,
  );
  assert.deepEqual(args.actual.maximizing_schedule, args.directResult.maximizing_schedule);
}

test("absolute-risk inversion matches an independent pointwise oracle and both direct boundary tests", () => {
  const cases = [
    {
      pairCount: 3,
      observedLossCount: 1,
      claim: "at_most" as const,
      rejectionAlpha: { numerator: 1, denominator: 2 },
    },
    {
      pairCount: 3,
      observedLossCount: 2,
      claim: "above" as const,
      rejectionAlpha: { numerator: 1, denominator: 2 },
    },
  ];
  for (const vector of cases) {
    const expected = bruteAbsoluteInversion(vector);
    const actual = evaluateLearningAbsoluteRiskConfidenceInversionExact({
      contract_version: "aionis_learning_absolute_risk_confidence_inversion_exact_input_v1",
      pair_count: vector.pairCount,
      observed_candidate_loss_count: vector.observedLossCount,
      claim: vector.claim,
      rejection_alpha: vector.rejectionAlpha,
    });
    const denominator = 2 * vector.pairCount;
    assert.equal(actual.estimand, "candidate_absolute_risk");
    assert.equal(actual.claim, vector.claim);
    assert.equal(actual.lattice.minimum_numerator, 0);
    assert.equal(actual.lattice.maximum_numerator, denominator);
    assert.equal(actual.lattice.denominator, denominator);
    assert.equal(actual.lattice.step_numerator, 1);
    assert.equal(
      actual.lattice.scan_order,
      vector.claim === "at_most" ? "ascending" : "descending",
    );
    assert.equal(actual.boundary_status, "exact_transition");

    const direct = (point: OraclePoint | null) => point === null ? null :
      evaluateLearningAbsoluteRiskExact({
        contract_version: "aionis_learning_absolute_risk_exact_input_v1",
        pair_count: vector.pairCount,
        observed_candidate_loss_count: vector.observedLossCount,
        claim: vector.claim,
        threshold: canonicalRational(point.latticeNumerator, denominator),
        rejection_alpha: vector.rejectionAlpha,
      });
    assertPoint({
      actual: actual.last_non_rejected_lattice_point,
      expected: expected.lastNonRejected,
      latticeDenominator: denominator,
      directResult: direct(expected.lastNonRejected),
    });
    assertPoint({
      actual: actual.first_rejected_lattice_point,
      expected: expected.firstRejected,
      latticeDenominator: denominator,
      directResult: direct(expected.firstRejected),
    });
  }
});

test("risk-difference inversion matches an independent pointwise oracle in both scan directions", () => {
  const observedContrasts = [-1, 0, 1] as const;
  const rejectionAlpha = { numerator: 1, denominator: 2 } as const;
  for (const claim of ["at_most", "above"] as const) {
    const expected = bruteRiskDifferenceInversion({
      observedContrasts,
      claim,
      rejectionAlpha,
    });
    const actual = evaluateLearningRiskDifferenceConfidenceInversionExact({
      contract_version:
        "aionis_learning_risk_difference_confidence_inversion_exact_input_v1",
      pair_count: observedContrasts.length,
      observed_contrasts: observedContrasts,
      claim,
      rejection_alpha: rejectionAlpha,
    });
    const denominator = 2 * observedContrasts.length;
    assert.equal(actual.estimand, "candidate_control_risk_difference");
    assert.equal(actual.lattice.minimum_numerator, -denominator);
    assert.equal(actual.lattice.maximum_numerator, denominator);
    assert.equal(actual.lattice.denominator, denominator);
    assert.equal(actual.lattice.step_numerator, 1);
    assert.equal(
      actual.lattice.scan_order,
      claim === "at_most" ? "ascending" : "descending",
    );
    assert.equal(actual.boundary_status, "exact_transition");

    const direct = (point: OraclePoint | null) => point === null ? null :
      evaluateLearningRiskDifferenceExact({
        contract_version: "aionis_learning_risk_difference_exact_input_v1",
        pair_count: observedContrasts.length,
        observed_contrasts: observedContrasts,
        claim,
        threshold: canonicalRational(point.latticeNumerator, denominator),
        rejection_alpha: rejectionAlpha,
      });
    assertPoint({
      actual: actual.last_non_rejected_lattice_point,
      expected: expected.lastNonRejected,
      latticeDenominator: denominator,
      directResult: direct(expected.lastNonRejected),
    });
    assertPoint({
      actual: actual.first_rejected_lattice_point,
      expected: expected.firstRejected,
      latticeDenominator: denominator,
      directResult: direct(expected.firstRejected),
    });
  }
});

test("above inversion reaches the negative risk-difference domain floor", () => {
  const exactFloorTransition = evaluateLearningRiskDifferenceConfidenceInversionExact({
    contract_version: "aionis_learning_risk_difference_confidence_inversion_exact_input_v1",
    pair_count: 1,
    observed_contrasts: [0],
    claim: "above",
    rejection_alpha: { numerator: 0, denominator: 1 },
  });
  assert.equal(exactFloorTransition.boundary_status, "exact_transition");
  assert.equal(exactFloorTransition.lattice.scan_order, "descending");
  assert.equal(exactFloorTransition.lattice.minimum_numerator, -2);
  assert.equal(exactFloorTransition.last_non_rejected_lattice_point?.lattice_numerator, -1);
  assert.equal(exactFloorTransition.first_rejected_lattice_point?.lattice_numerator, -2);
  assert.equal(exactFloorTransition.first_rejected_lattice_point?.max_tail_count, "0");
  assert.equal(
    exactFloorTransition.first_rejected_lattice_point?.composite_null_rejected,
    true,
  );

  const domainLimited = evaluateLearningRiskDifferenceConfidenceInversionExact({
    contract_version: "aionis_learning_risk_difference_confidence_inversion_exact_input_v1",
    pair_count: 1,
    observed_contrasts: [-1],
    claim: "above",
    rejection_alpha: { numerator: 0, denominator: 1 },
  });
  assert.equal(domainLimited.boundary_status, "domain_limit_only");
  assert.equal(domainLimited.first_rejected_lattice_point, null);
  assert.equal(domainLimited.last_non_rejected_lattice_point?.lattice_numerator, -2);
  assert.deepEqual(domainLimited.confidence_bound, {
    relation: "at_least",
    numerator: -2,
    denominator: 2,
    origin: "parameter_domain",
  });
});

test("rejection equality is inclusive at the first rejected lattice point", () => {
  const actual = evaluateLearningAbsoluteRiskConfidenceInversionExact({
    contract_version: "aionis_learning_absolute_risk_confidence_inversion_exact_input_v1",
    pair_count: 3,
    observed_candidate_loss_count: 1,
    claim: "at_most",
    rejection_alpha: { numerator: 1, denominator: 2 },
  });
  const boundary = actual.first_rejected_lattice_point;
  assert.ok(boundary);
  assert.equal(boundary.max_tail_count, "4");
  assert.equal(boundary.assignment_count, "8");
  assert.equal(2n * BigInt(boundary.max_tail_count), BigInt(boundary.assignment_count));
  assert.equal(boundary.composite_null_rejected, true);
  assert.equal(actual.confidence_bound.relation, "at_most");
  assert.equal(actual.confidence_bound.origin, "test_inversion");
});

test("inversion inputs are strict and do not accept caller-selected thresholds", () => {
  const absoluteInput = {
    contract_version: "aionis_learning_absolute_risk_confidence_inversion_exact_input_v1",
    pair_count: 3,
    observed_candidate_loss_count: 1,
    claim: "at_most",
    rejection_alpha: { numerator: 1, denominator: 2 },
  } as const;
  assert.throws(() => evaluateLearningAbsoluteRiskConfidenceInversionExact({
    ...absoluteInput,
    threshold: { numerator: 1, denominator: 20 },
  }), /unrecognized key/i);
  assert.throws(() => evaluateLearningAbsoluteRiskConfidenceInversionExact({
    ...absoluteInput,
    rejection_alpha: { numerator: 2, denominator: 4 },
  }), /canonical rational/i);
  assert.throws(() => evaluateLearningAbsoluteRiskConfidenceInversionExact({
    ...absoluteInput,
    pair_count: -0,
  }), /Negative zero is not a canonical integer/);
  assert.throws(() => evaluateLearningAbsoluteRiskConfidenceInversionExact({
    ...absoluteInput,
    caller_override: true,
  }), /unrecognized key/i);

  const differenceInput = {
    contract_version:
      "aionis_learning_risk_difference_confidence_inversion_exact_input_v1",
    pair_count: 2,
    observed_contrasts: [-1, 1],
    claim: "above",
    rejection_alpha: { numerator: 1, denominator: 2 },
  } as const;
  assert.throws(() => evaluateLearningRiskDifferenceConfidenceInversionExact({
    ...differenceInput,
    observed_contrasts: [-1],
  }), /contrast count must equal/i);
  assert.throws(() => evaluateLearningRiskDifferenceConfidenceInversionExact({
    ...differenceInput,
    observed_contrasts: [-0, 1],
  }), /Negative zero is not a canonical contrast/);
  assert.throws(() => evaluateLearningRiskDifferenceConfidenceInversionExact({
    ...differenceInput,
    contract_version: "aionis_learning_risk_difference_confidence_inversion_exact_input_v2",
  }));
});

test("inversion is a generic policy-digest-bound diagnostic with no authority role", () => {
  const policy = resolveLearningGatePolicy(
    LEARNING_GATE_POLICY_ID,
    LEARNING_GATE_POLICY_VERSION,
  );
  const expectedBinding = {
    gate_policy_id: policy.policy_id,
    gate_policy_version: policy.policy_version,
    gate_policy_config_sha256: policy.policy_config_sha256,
    implementation_contract_sha256: policy.implementation_contract_sha256,
    registry_status: "calibration_pending",
  } as const;
  const results = [
    evaluateLearningAbsoluteRiskConfidenceInversionExact({
      contract_version: "aionis_learning_absolute_risk_confidence_inversion_exact_input_v1",
      pair_count: 2,
      observed_candidate_loss_count: 1,
      claim: "at_most",
      rejection_alpha: { numerator: 1, denominator: 2 },
    }),
    evaluateLearningRiskDifferenceConfidenceInversionExact({
      contract_version:
        "aionis_learning_risk_difference_confidence_inversion_exact_input_v1",
      pair_count: 2,
      observed_contrasts: [-1, 1],
      claim: "above",
      rejection_alpha: { numerator: 1, denominator: 2 },
    }),
  ];
  for (const result of results) {
    assert.deepEqual(result.gate_policy_binding, expectedBinding);
    assert.equal(result.confidence_coefficient.numerator, 1);
    assert.equal(result.confidence_coefficient.denominator, 2);
    assert.equal(result.parameter_source, "caller_supplied_mathematical_diagnostic");
    assert.equal(result.authority_role, "diagnostic_only");
    assert.match(result.result_sha256, /^[0-9a-f]{64}$/u);
    assert.equal("authority_action" in result, false);
    assert.equal("evidence_verdict" in result, false);
  }
});

test("384-pair inversion reuses one exact state space within the resource guard", {
  timeout: 120_000,
}, () => {
  const vectors = [
    {
      claim: "at_most" as const,
      contrasts: Array.from({ length: 384 }, () => 0 as const),
      resultSha256: "4e8f6ea9c7978349e51068ffc9a5e47783a020a1da3a947a6f8b63f40ed2eb45",
    },
    {
      claim: "above" as const,
      contrasts: Array.from(
        { length: 384 },
        (_, index) => index % 5 === 0 ? 1 as const : 0 as const,
      ),
      resultSha256: "f38ecbb5c316eea400c9df9f0d85e161f0fb02ec7eccb54fdc82f67e34ef0bb0",
    },
  ];
  let maximumObservedRss = process.memoryUsage().rss;
  for (const vector of vectors) {
    const started = performance.now();
    const result = evaluateLearningRiskDifferenceConfidenceInversionExact({
      contract_version:
        "aionis_learning_risk_difference_confidence_inversion_exact_input_v1",
      pair_count: 384,
      observed_contrasts: vector.contrasts,
      claim: vector.claim,
      rejection_alpha: { numerator: 1, denominator: 80 },
    });
    maximumObservedRss = Math.max(maximumObservedRss, process.memoryUsage().rss);
    assert.equal(result.result_sha256, vector.resultSha256);
    assert.equal(
      result.inversion_method,
      "exact_monotone_boundary_search_over_full_lattice_v1",
    );
    assert.ok(performance.now() - started < 60_000);
  }
  assert.ok(maximumObservedRss <= 512 * 1024 * 1024);
});
