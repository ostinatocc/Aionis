import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";

import {
  evaluateLearningAbsoluteRiskExact,
  evaluateLearningOfflineFiniteHoldoutLattice,
  evaluateLearningPreResponseAvailabilityExact,
  evaluateLearningRiskDifferenceExact,
} from "../../src/memory/learning-evidence-gate.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
  resolveLearningGatePolicy,
} from "../../src/memory/learning-gate-policy.js";

type Claim = "at_most" | "above";
type Rational = Readonly<{ numerator: number; denominator: number }>;
type Contrast = -1 | 0 | 1;

function popcount(value: number): number {
  let current = value;
  let count = 0;
  while (current !== 0) {
    current &= current - 1;
    count += 1;
  }
  return count;
}

function bigintGreatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function canonicalRational(numerator: bigint, denominator: bigint): Rational {
  const divisor = bigintGreatestCommonDivisor(numerator, denominator);
  return {
    numerator: Number(numerator / divisor),
    denominator: Number(denominator / divisor),
  };
}

function labelSwappedThresholdOnExactLattice(
  threshold: Rational,
  pairCount: number,
): Rational {
  const latticeDenominator = BigInt(2 * pairCount);
  const scaledNumerator = BigInt(threshold.numerator) * latticeDenominator;
  const thresholdDenominator = BigInt(threshold.denominator);
  if (scaledNumerator % thresholdDenominator !== 0n) {
    return canonicalRational(-BigInt(threshold.numerator), thresholdDenominator);
  }
  const exactLatticePoint = scaledNumerator / thresholdDenominator;
  return canonicalRational(-exactLatticePoint - 1n, latticeDenominator);
}

function nullContains(args: {
  parameterNumerator: number;
  parameterDenominator: number;
  threshold: Rational;
  claim: Claim;
}): boolean {
  const comparison = BigInt(args.parameterNumerator) * BigInt(args.threshold.denominator)
    - BigInt(args.threshold.numerator) * BigInt(args.parameterDenominator);
  return args.claim === "at_most" ? comparison > 0n : comparison <= 0n;
}

function bruteAbsoluteRisk(args: {
  pairCount: number;
  observedLossCount: number;
  threshold: Rational;
  claim: Claim;
}): bigint {
  const observedLosses = Array.from(
    { length: args.pairCount },
    (_, index) => index < args.observedLossCount ? 1 : 0,
  );
  let maximum = 0n;
  for (let schedule = 0; schedule < 2 ** args.pairCount; schedule += 1) {
    const alternateLosses = Array.from(
      { length: args.pairCount },
      (_, index) => (schedule & (2 ** index)) === 0 ? 0 : 1,
    );
    const riskNumerator = args.observedLossCount + popcount(schedule);
    if (!nullContains({
      parameterNumerator: riskNumerator,
      parameterDenominator: 2 * args.pairCount,
      threshold: args.threshold,
      claim: args.claim,
    })) continue;
    let tail = 0n;
    for (let assignment = 0; assignment < 2 ** args.pairCount; assignment += 1) {
      let statistic = 0;
      for (let index = 0; index < args.pairCount; index += 1) {
        statistic += (assignment & (2 ** index)) === 0
          ? observedLosses[index]!
          : alternateLosses[index]!;
      }
      if (args.claim === "at_most"
        ? statistic <= args.observedLossCount
        : statistic >= args.observedLossCount) {
        tail += 1n;
      }
    }
    if (tail > maximum) maximum = tail;
  }
  return maximum;
}

function enumerateContrasts(length: number): Array<Array<-1 | 0 | 1>> {
  let rows: Array<Array<-1 | 0 | 1>> = [[]];
  for (let index = 0; index < length; index += 1) {
    rows = rows.flatMap((row) => [-1, 0, 1].map((value) => [
      ...row,
      value as -1 | 0 | 1,
    ]));
  }
  return rows;
}

function bruteRiskDifference(args: {
  observedContrasts: readonly Contrast[];
  threshold: Rational;
  claim: Claim;
}): bigint {
  const pairCount = args.observedContrasts.length;
  const observedStatistic = args.observedContrasts.reduce<number>((sum, value) => sum + value, 0);
  let maximum = 0n;
  for (const alternateContrasts of enumerateContrasts(pairCount)) {
    const effectNumerator = args.observedContrasts.reduce<number>(
      (sum, value, index) => sum + value + alternateContrasts[index]!,
      0,
    );
    if (!nullContains({
      parameterNumerator: effectNumerator,
      parameterDenominator: 2 * pairCount,
      threshold: args.threshold,
      claim: args.claim,
    })) continue;
    let tail = 0n;
    for (let assignment = 0; assignment < 2 ** pairCount; assignment += 1) {
      let statistic = 0;
      for (let index = 0; index < pairCount; index += 1) {
        statistic += (assignment & (2 ** index)) === 0
          ? args.observedContrasts[index]!
          : alternateContrasts[index]!;
      }
      if (args.claim === "at_most"
        ? statistic <= observedStatistic
        : statistic >= observedStatistic) {
        tail += 1n;
      }
    }
    if (tail > maximum) maximum = tail;
  }
  return maximum;
}

function weakCompositionsOfThree(total: number): ReadonlyArray<readonly [number, number, number]> {
  const compositions: Array<readonly [number, number, number]> = [];
  for (let first = 0; first <= total; first += 1) {
    for (let second = 0; second <= total - first; second += 1) {
      compositions.push([first, second, total - first - second]);
    }
  }
  return compositions;
}

function compressedRiskDifferenceReference(args: {
  observedContrasts: readonly Contrast[];
  threshold: Rational;
  claim: Claim;
}): Readonly<{
  maximumTailCount: bigint;
  maximizingScheduleKeys: ReadonlySet<string>;
}> {
  const contrastValues = [-1, 0, 1] as const;
  const observedCounts = contrastValues.map((observed) =>
    args.observedContrasts.filter((value) => value === observed).length);
  const observedStatistic = args.observedContrasts.reduce<number>(
    (sum, value) => sum + value,
    0,
  );
  const contingencyRows: Array<readonly [number, number, number]> = [];
  let maximumTailCount = 0n;
  const maximizingScheduleKeys = new Set<string>();

  function visitObservedClass(observedClassIndex: number): void {
    if (observedClassIndex < contrastValues.length) {
      for (const composition of weakCompositionsOfThree(observedCounts[observedClassIndex]!)) {
        contingencyRows.push(composition);
        visitObservedClass(observedClassIndex + 1);
        contingencyRows.pop();
      }
      return;
    }

    let effectNumerator = 0;
    let singleStepPairCount = 0;
    let doubleStepPairCount = 0;
    for (let observedIndex = 0; observedIndex < contrastValues.length; observedIndex += 1) {
      const observed = contrastValues[observedIndex]!;
      for (let alternateIndex = 0; alternateIndex < contrastValues.length; alternateIndex += 1) {
        const alternate = contrastValues[alternateIndex]!;
        const count = contingencyRows[observedIndex]![alternateIndex]!;
        effectNumerator += count * (observed + alternate);
        const step = Math.abs(observed - alternate);
        if (step === 1) singleStepPairCount += count;
        if (step === 2) doubleStepPairCount += count;
      }
    }
    if (!nullContains({
      parameterNumerator: effectNumerator,
      parameterDenominator: 2 * args.observedContrasts.length,
      threshold: args.threshold,
      claim: args.claim,
    })) return;

    // This reference deliberately represents a schedule as a 3x3 contingency
    // table, then convolves every pair factor (z^observed + z^alternate).
    // It shares neither the production (q,c,E) feasibility recurrence nor its
    // closed-form binomial tail calculation.
    let statisticCounts = new Map<number, bigint>([[0, 1n]]);
    for (let observedIndex = 0; observedIndex < contrastValues.length; observedIndex += 1) {
      const observed = contrastValues[observedIndex]!;
      for (let alternateIndex = 0; alternateIndex < contrastValues.length; alternateIndex += 1) {
        const alternate = contrastValues[alternateIndex]!;
        const count = contingencyRows[observedIndex]![alternateIndex]!;
        for (let occurrence = 0; occurrence < count; occurrence += 1) {
          const next = new Map<number, bigint>();
          for (const [statistic, assignmentCount] of statisticCounts) {
            next.set(
              statistic + observed,
              (next.get(statistic + observed) ?? 0n) + assignmentCount,
            );
            next.set(
              statistic + alternate,
              (next.get(statistic + alternate) ?? 0n) + assignmentCount,
            );
          }
          statisticCounts = next;
        }
      }
    }
    let tailCount = 0n;
    for (const [statistic, assignmentCount] of statisticCounts) {
      if (args.claim === "at_most"
        ? statistic <= observedStatistic
        : statistic >= observedStatistic) {
        tailCount += assignmentCount;
      }
    }
    const scheduleKey = [
      effectNumerator,
      singleStepPairCount,
      doubleStepPairCount,
    ].join(":");
    if (tailCount > maximumTailCount) {
      maximumTailCount = tailCount;
      maximizingScheduleKeys.clear();
      maximizingScheduleKeys.add(scheduleKey);
    } else if (tailCount === maximumTailCount) {
      maximizingScheduleKeys.add(scheduleKey);
    }
  }

  visitObservedClass(0);
  return { maximumTailCount, maximizingScheduleKeys };
}

function exactInput(args: {
  pairCount: number;
  claim: Claim;
  threshold: Rational;
}) {
  return {
    pair_count: args.pairCount,
    claim: args.claim,
    threshold: args.threshold,
    rejection_alpha: { numerator: 1, denominator: 80 },
  } as const;
}

test("absolute-risk composite tails equal an independent assignment oracle through eight pairs", () => {
  const thresholds = [
    { numerator: 0, denominator: 1 },
    { numerator: 1, denominator: 2 },
    { numerator: 1, denominator: 1 },
  ] as const;
  for (let pairCount = 1; pairCount <= 8; pairCount += 1) {
    for (let observedLossCount = 0; observedLossCount <= pairCount; observedLossCount += 1) {
      for (const threshold of thresholds) {
        for (const claim of ["at_most", "above"] as const) {
          const expected = bruteAbsoluteRisk({
            pairCount,
            observedLossCount,
            threshold,
            claim,
          });
          const actual = evaluateLearningAbsoluteRiskExact({
            contract_version: "aionis_learning_absolute_risk_exact_input_v1",
            ...exactInput({ pairCount, claim, threshold }),
            observed_candidate_loss_count: observedLossCount,
          });
          assert.equal(actual.max_tail_count, expected.toString());
          assert.equal(actual.assignment_count, (1n << BigInt(pairCount)).toString());
          assert.equal(actual.tail_rule, claim === "at_most" ? "inclusive_lower" : "inclusive_upper");
          assert.equal("authority_action" in actual, false);
        }
      }
    }
  }
});

test("risk-difference feasibility DP equals a separately written schedule oracle through eight pairs", () => {
  for (let pairCount = 1; pairCount <= 5; pairCount += 1) {
    for (const observedContrasts of enumerateContrasts(pairCount)) {
      const thresholds = pairCount <= 4
        ? [
            { numerator: -1, denominator: 2 },
            { numerator: 0, denominator: 1 },
            { numerator: 1, denominator: 2 },
          ] as const
        : [{ numerator: 0, denominator: 1 }] as const;
      for (const threshold of thresholds) {
        for (const claim of ["at_most", "above"] as const) {
          const expected = bruteRiskDifference({ observedContrasts, threshold, claim });
          const actual = evaluateLearningRiskDifferenceExact({
            contract_version: "aionis_learning_risk_difference_exact_input_v1",
            ...exactInput({ pairCount, claim, threshold }),
            observed_contrasts: observedContrasts,
          });
          assert.equal(actual.max_tail_count, expected.toString());
          assert.equal(actual.observed_contrast_sum,
            observedContrasts.reduce<number>((sum, value) => sum + value, 0));
        }
      }
    }
  }
  const threshold = { numerator: 0, denominator: 1 } as const;
  for (const pairCount of [6, 7, 8]) {
    const vectors: Array<Array<-1 | 0 | 1>> = [
      Array.from({ length: pairCount }, () => -1 as const),
      Array.from({ length: pairCount }, () => 0 as const),
      Array.from({ length: pairCount }, () => 1 as const),
      Array.from({ length: pairCount }, (_, index) => index % 3 === 0 ? -1 : index % 3 === 1 ? 0 : 1),
    ];
    for (const observedContrasts of vectors) {
      for (const claim of ["at_most", "above"] as const) {
        const expected = bruteRiskDifference({ observedContrasts, threshold, claim });
        const actual = evaluateLearningRiskDifferenceExact({
          contract_version: "aionis_learning_risk_difference_exact_input_v1",
          ...exactInput({ pairCount, claim, threshold }),
          observed_contrasts: observedContrasts,
        });
        assert.equal(actual.max_tail_count, expected.toString());
      }
    }
  }
});

test("an independent compressed reference pins the 9-to-12-pair lattice", () => {
  const differenceVectors = [
    {
      contrasts: Array.from({ length: 9 }, () => 1 as const),
      claim: "above" as const,
      threshold: { numerator: 0, denominator: 1 },
      tail: "1",
    },
    {
      contrasts: [-1, -1, -1, 0, 0, 0, 1, 1, 1, 1] as const,
      claim: "at_most" as const,
      threshold: { numerator: 1, denominator: 5 },
      tail: "362",
    },
    {
      contrasts: [-1, -1, -1, 0, 0, 0, 1, 1, 1, 1] as const,
      claim: "above" as const,
      threshold: { numerator: -1, denominator: 5 },
      tail: "192",
    },
    {
      contrasts: [-1, -1, -1, 0, 0, 0, 0, 1, 1, 1, 1] as const,
      claim: "at_most" as const,
      threshold: { numerator: 1, denominator: 5 },
      tail: "734",
    },
    {
      contrasts: [-1, 0, 1, -1, 0, 1, -1, 0, 1, -1, 0, 1] as const,
      claim: "at_most" as const,
      threshold: { numerator: 0, denominator: 1 },
      tail: "2048",
    },
  ];
  for (const vector of differenceVectors) {
    const reference = compressedRiskDifferenceReference({
      observedContrasts: vector.contrasts,
      claim: vector.claim,
      threshold: vector.threshold,
    });
    const result = evaluateLearningRiskDifferenceExact({
      contract_version: "aionis_learning_risk_difference_exact_input_v1",
      pair_count: vector.contrasts.length,
      observed_contrasts: vector.contrasts,
      claim: vector.claim,
      threshold: vector.threshold,
      rejection_alpha: { numerator: 1, denominator: 80 },
    });
    assert.equal(reference.maximumTailCount.toString(), vector.tail);
    assert.equal(result.max_tail_count, vector.tail);
    assert.ok(result.maximizing_schedule);
    assert.ok(reference.maximizingScheduleKeys.has([
      result.maximizing_schedule.effect_numerator,
      result.maximizing_schedule.single_step_pair_count,
      result.maximizing_schedule.double_step_pair_count,
    ].join(":")));

    const labelSwappedContrasts = vector.contrasts.map((value): Contrast =>
      value === -1 ? 1 : value === 1 ? -1 : 0);
    const labelSwappedClaim = vector.claim === "at_most" ? "above" as const : "at_most" as const;
    const labelSwappedThreshold = labelSwappedThresholdOnExactLattice(
      vector.threshold,
      labelSwappedContrasts.length,
    );
    const swappedReference = compressedRiskDifferenceReference({
      observedContrasts: labelSwappedContrasts,
      claim: labelSwappedClaim,
      threshold: labelSwappedThreshold,
    });
    const swappedResult = evaluateLearningRiskDifferenceExact({
      contract_version: "aionis_learning_risk_difference_exact_input_v1",
      pair_count: labelSwappedContrasts.length,
      observed_contrasts: labelSwappedContrasts,
      claim: labelSwappedClaim,
      threshold: labelSwappedThreshold,
      rejection_alpha: { numerator: 1, denominator: 80 },
    });
    assert.equal(swappedReference.maximumTailCount, reference.maximumTailCount);
    assert.equal(swappedResult.max_tail_count, vector.tail);
    assert.ok(swappedResult.maximizing_schedule);
    assert.ok(swappedReference.maximizingScheduleKeys.has([
      swappedResult.maximizing_schedule.effect_numerator,
      swappedResult.maximizing_schedule.single_step_pair_count,
      swappedResult.maximizing_schedule.double_step_pair_count,
    ].join(":")));
  }
});

test("externally generated exact vectors pin the 96/192/384-pair safety boundary", () => {
  // These numerators were generated by an independent complete-schedule
  // enumerator which does not import the production kernel.
  const vectors = [
    { pairCount: 96, observedLossCount: 8, tail: "1547425049106725343623905280", supported: false },
    { pairCount: 96, observedLossCount: 9, tail: "154742504910672534362390528", supported: false },
    { pairCount: 96, observedLossCount: 10, tail: "0", supported: true },
    {
      pairCount: 192,
      observedLossCount: 15,
      tail: "60294121435942314771036215849444976942999767338411098112",
      supported: false,
    },
    {
      pairCount: 192,
      observedLossCount: 16,
      tail: "13888240839097117778872519933549676976544823294788894720",
      supported: false,
    },
    {
      pairCount: 192,
      observedLossCount: 17,
      tail: "2286770689885818530831595954575851984931087283883343872",
      supported: true,
    },
    {
      pairCount: 384,
      observedLossCount: 27,
      tail: "272917311532513896945325253766135779893722669626075571122691726343755254406473722016854856332107744910486506831872",
      supported: false,
    },
    {
      pairCount: 384,
      observedLossCount: 28,
      tail: "100428686400138507155628280935316048095332474294408617444996319230359219873077720160601381986424872590956445040640",
      supported: false,
    },
    {
      pairCount: 384,
      observedLossCount: 29,
      tail: "32665297955276746881104470180351153460250611842682314214473123578667920592100719431358945636335172751141063622656",
      supported: true,
    },
  ] as const;
  for (const vector of vectors) {
    const result = evaluateLearningAbsoluteRiskExact({
      contract_version: "aionis_learning_absolute_risk_exact_input_v1",
      pair_count: vector.pairCount,
      observed_candidate_loss_count: vector.observedLossCount,
      claim: "above",
      threshold: { numerator: 1, denominator: 20 },
      rejection_alpha: { numerator: 1, denominator: 1_000 },
    });
    assert.equal(result.max_tail_count, vector.tail);
    assert.equal(result.assignment_count, (1n << BigInt(vector.pairCount)).toString());
    assert.equal(result.claim_supported, vector.supported);
  }
});

test("risk-difference result identity depends on sufficient counts, not pair ordering", () => {
  const first = evaluateLearningRiskDifferenceExact({
    contract_version: "aionis_learning_risk_difference_exact_input_v1",
    pair_count: 3,
    observed_contrasts: [1, 1, 0],
    claim: "at_most",
    threshold: { numerator: 1, denominator: 5 },
    rejection_alpha: { numerator: 1, denominator: 80 },
  });
  const permuted = evaluateLearningRiskDifferenceExact({
    contract_version: "aionis_learning_risk_difference_exact_input_v1",
    pair_count: 3,
    observed_contrasts: [1, 0, 1],
    claim: "at_most",
    threshold: { numerator: 1, denominator: 5 },
    rejection_alpha: { numerator: 1, denominator: 80 },
  });
  assert.deepEqual(permuted, first);
});

test("exact tails include equality and use BigInt rejection comparisons", () => {
  const equality = evaluateLearningAbsoluteRiskExact({
    contract_version: "aionis_learning_absolute_risk_exact_input_v1",
    pair_count: 8,
    observed_candidate_loss_count: 4,
    claim: "at_most",
    threshold: { numerator: 1, denominator: 2 },
    rejection_alpha: { numerator: 1, denominator: 80 },
  });
  assert.equal(equality.composite_null, "parameter_above_threshold");
  assert.equal(equality.tail_rule, "inclusive_lower");
  assert.match(equality.result_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    equality.claim_supported,
    80n * BigInt(equality.max_tail_count) <= BigInt(equality.assignment_count),
  );
  const exactTail = BigInt(equality.max_tail_count);
  const exactAssignments = BigInt(equality.assignment_count);
  const exactDivisor = bigintGreatestCommonDivisor(exactTail, exactAssignments);
  const exactAlpha = {
    numerator: Number(exactTail / exactDivisor),
    denominator: Number(exactAssignments / exactDivisor),
  };
  const inclusiveRejectionEquality = evaluateLearningAbsoluteRiskExact({
    contract_version: "aionis_learning_absolute_risk_exact_input_v1",
    pair_count: 8,
    observed_candidate_loss_count: 4,
    claim: "at_most",
    threshold: { numerator: 1, denominator: 2 },
    rejection_alpha: exactAlpha,
  });
  assert.equal(inclusiveRejectionEquality.claim_supported, true);
  assert.deepEqual(evaluateLearningAbsoluteRiskExact({
    contract_version: "aionis_learning_absolute_risk_exact_input_v1",
    pair_count: 8,
    observed_candidate_loss_count: 4,
    claim: "at_most",
    threshold: { numerator: 1, denominator: 2 },
    rejection_alpha: { numerator: 1, denominator: 80 },
  }), equality);

  assert.throws(() => evaluateLearningAbsoluteRiskExact({
    contract_version: "aionis_learning_absolute_risk_exact_input_v1",
    pair_count: 8,
    observed_candidate_loss_count: 4,
    claim: "at_most",
    threshold: { numerator: 2, denominator: 40 },
    rejection_alpha: { numerator: 1, denominator: 80 },
  }), /canonical rational/);
  assert.throws(() => evaluateLearningRiskDifferenceExact({
    contract_version: "aionis_learning_risk_difference_exact_input_v1",
    pair_count: 2,
    observed_contrasts: [0],
    claim: "above",
    threshold: { numerator: 0, denominator: 1 },
    rejection_alpha: { numerator: 1, denominator: 80 },
  }), /contrast count must equal/);
  assert.throws(() => evaluateLearningAbsoluteRiskExact({
    contract_version: "aionis_learning_absolute_risk_exact_input_v1",
    pair_count: 8,
    observed_candidate_loss_count: 4,
    claim: "at_most",
    threshold: { numerator: 1, denominator: 2 },
    rejection_alpha: { numerator: 1, denominator: 80 },
    caller_override: true,
  }), /unrecognized key/i);

  const roundedNumberTrap = evaluateLearningAbsoluteRiskExact({
    contract_version: "aionis_learning_absolute_risk_exact_input_v1",
    pair_count: 384,
    observed_candidate_loss_count: 383,
    claim: "at_most",
    threshold: {
      numerator: 8_995_471_130_711_380,
      denominator: 9_007_199_254_740_991,
    },
    rejection_alpha: { numerator: 1, denominator: 80 },
  });
  assert.notEqual(roundedNumberTrap.max_tail_count, "0");
  assert.equal(roundedNumberTrap.claim_supported, false);
  assert.throws(() => evaluateLearningAbsoluteRiskExact({
    contract_version: "aionis_learning_absolute_risk_exact_input_v1",
    pair_count: 384,
    observed_candidate_loss_count: 383,
    claim: "at_most",
    threshold: {
      numerator: 8_995_471_130_711_381,
      denominator: 9_007_199_254_740_992,
    },
    rejection_alpha: { numerator: 1, denominator: 80 },
  }), /9007199254740991/);

  const canonicalZero = evaluateLearningAbsoluteRiskExact({
    contract_version: "aionis_learning_absolute_risk_exact_input_v1",
    pair_count: 1,
    observed_candidate_loss_count: 0,
    claim: "at_most",
    threshold: { numerator: 0, denominator: 1 },
    rejection_alpha: { numerator: 1, denominator: 80 },
  });
  assert.match(canonicalZero.result_sha256, /^[0-9a-f]{64}$/u);
  assert.throws(() => evaluateLearningAbsoluteRiskExact({
    contract_version: "aionis_learning_absolute_risk_exact_input_v1",
    pair_count: 1,
    observed_candidate_loss_count: 0,
    claim: "at_most",
    threshold: { numerator: -0, denominator: 1 },
    rejection_alpha: { numerator: 1, denominator: 80 },
  }), /Negative zero is not a canonical integer/);
  assert.throws(() => evaluateLearningRiskDifferenceExact({
    contract_version: "aionis_learning_risk_difference_exact_input_v1",
    pair_count: 1,
    observed_contrasts: [-0],
    claim: "at_most",
    threshold: { numerator: 0, denominator: 1 },
    rejection_alpha: { numerator: 1, denominator: 80 },
  }), /Negative zero is not a canonical contrast/);
  assert.throws(() => evaluateLearningOfflineFiniteHoldoutLattice({
    contract_version: "aionis_learning_offline_finite_holdout_lattice_input_v1",
    case_count: 96,
    harm_assessable_pair_count: -0,
    utility_assessable_pair_count: 96,
    recorded_harm_loss_count: 2,
    candidate_harm_loss_count: 0,
    recorded_utility_loss_count: 0,
    candidate_utility_loss_count: 0,
    recorded_exploit_harm_loss_count: 2,
    candidate_exploit_harm_loss_count: 0,
  }), /Negative zero is not a canonical integer/);
});

test("pre-response availability uses the exact two-sided McNemar boundary", () => {
  const noDiscordance = evaluateLearningPreResponseAvailabilityExact({
    contract_version: "aionis_learning_pre_response_availability_exact_input_v1",
    pair_count: 96,
    candidate_only_available_count: 0,
    control_only_available_count: 0,
  });
  assert.equal(noDiscordance.p_value_numerator, "1");
  assert.equal(noDiscordance.p_value_denominator, "1");
  assert.equal(noDiscordance.integrity_hold, false);

  const aboveBoundary = evaluateLearningPreResponseAvailabilityExact({
    contract_version: "aionis_learning_pre_response_availability_exact_input_v1",
    pair_count: 96,
    candidate_only_available_count: 10,
    control_only_available_count: 0,
  });
  assert.equal(aboveBoundary.p_value_numerator, "2");
  assert.equal(aboveBoundary.p_value_denominator, "1024");
  assert.equal(aboveBoundary.integrity_hold, false);

  const rejected = evaluateLearningPreResponseAvailabilityExact({
    contract_version: "aionis_learning_pre_response_availability_exact_input_v1",
    pair_count: 96,
    candidate_only_available_count: 11,
    control_only_available_count: 0,
  });
  assert.equal(rejected.p_value_numerator, "2");
  assert.equal(rejected.p_value_denominator, "2048");
  assert.equal(rejected.integrity_hold, true);
  assert.equal(rejected.hold_reason, "pre_response_availability_imbalance");
  const labelSwapped = evaluateLearningPreResponseAvailabilityExact({
    contract_version: "aionis_learning_pre_response_availability_exact_input_v1",
    pair_count: 96,
    candidate_only_available_count: 0,
    control_only_available_count: 11,
  });
  assert.equal(labelSwapped.p_value_numerator, rejected.p_value_numerator);
  assert.equal(labelSwapped.p_value_denominator, rejected.p_value_denominator);
  assert.equal(labelSwapped.integrity_hold, rejected.integrity_hold);
  assert.equal(labelSwapped.hold_reason, rejected.hold_reason);
});

test("offline 96-case lattice uses the full denominator and exact integer boundaries", () => {
  const passing = evaluateLearningOfflineFiniteHoldoutLattice({
    contract_version: "aionis_learning_offline_finite_holdout_lattice_input_v1",
    case_count: 96,
    harm_assessable_pair_count: 87,
    utility_assessable_pair_count: 87,
    recorded_harm_loss_count: 20,
    candidate_harm_loss_count: 24,
    recorded_utility_loss_count: 30,
    candidate_utility_loss_count: 34,
    recorded_exploit_harm_loss_count: 12,
    candidate_exploit_harm_loss_count: 10,
  });
  assert.equal(passing.verdict, "passed");
  assert.deepEqual(passing.hold_reasons, []);

  const fiveOfNinetySix = evaluateLearningOfflineFiniteHoldoutLattice({
    ...passing.input,
    candidate_harm_loss_count: 25,
  });
  assert.equal(fiveOfNinetySix.checks.harm_noninferiority_at_plus_5_points, false);
  assert.ok(fiveOfNinetySix.hold_reasons.includes("harm_noninferiority_failed"));

  const oneOfNinetySix = evaluateLearningOfflineFiniteHoldoutLattice({
    ...passing.input,
    candidate_exploit_harm_loss_count: 11,
  });
  assert.equal(oneOfNinetySix.checks.exploit_harm_reduction_at_minus_2_points, false);
  assert.ok(oneOfNinetySix.hold_reasons.includes("exploit_harm_reduction_failed"));

  const eightySix = evaluateLearningOfflineFiniteHoldoutLattice({
    ...passing.input,
    harm_assessable_pair_count: 86,
  });
  assert.equal(eightySix.checks.harm_assessability_at_least_90_percent, false);
  assert.throws(() => evaluateLearningOfflineFiniteHoldoutLattice({
    ...passing.input,
    recorded_harm_loss_count: 0,
    recorded_exploit_harm_loss_count: 96,
  }), /subset of recorded total harm/);
});

test("every pure result binds the calibration-pending gate policy and carries no authority action", () => {
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
    evaluateLearningAbsoluteRiskExact({
      contract_version: "aionis_learning_absolute_risk_exact_input_v1",
      pair_count: 1,
      observed_candidate_loss_count: 0,
      claim: "at_most",
      threshold: { numerator: 1, denominator: 20 },
      rejection_alpha: { numerator: 1, denominator: 80 },
    }),
    evaluateLearningRiskDifferenceExact({
      contract_version: "aionis_learning_risk_difference_exact_input_v1",
      pair_count: 1,
      observed_contrasts: [0],
      claim: "at_most",
      threshold: { numerator: 1, denominator: 20 },
      rejection_alpha: { numerator: 1, denominator: 80 },
    }),
    evaluateLearningPreResponseAvailabilityExact({
      contract_version: "aionis_learning_pre_response_availability_exact_input_v1",
      pair_count: 1,
      candidate_only_available_count: 0,
      control_only_available_count: 0,
    }),
    evaluateLearningOfflineFiniteHoldoutLattice({
      contract_version: "aionis_learning_offline_finite_holdout_lattice_input_v1",
      case_count: 96,
      harm_assessable_pair_count: 96,
      utility_assessable_pair_count: 96,
      recorded_harm_loss_count: 2,
      candidate_harm_loss_count: 0,
      recorded_utility_loss_count: 0,
      candidate_utility_loss_count: 0,
      recorded_exploit_harm_loss_count: 2,
      candidate_exploit_harm_loss_count: 0,
    }),
  ];
  for (const result of results) {
    assert.deepEqual(result.gate_policy_binding, expectedBinding);
    assert.equal("authority_action" in result, false);
  }
});

test("calibration-pending 384-pair shapes are exact, deterministic, and inside the local resource guard", { timeout: 120_000 }, () => {
  const policy = resolveLearningGatePolicy(
    LEARNING_GATE_POLICY_ID,
    LEARNING_GATE_POLICY_VERSION,
  );
  const absoluteObservedLossCounts = [0, 19, 20, 384] as const;
  for (const observedCandidateLossCount of absoluteObservedLossCounts) {
    const started = performance.now();
    const result = evaluateLearningAbsoluteRiskExact({
      contract_version: "aionis_learning_absolute_risk_exact_input_v1",
      pair_count: 384,
      observed_candidate_loss_count: observedCandidateLossCount,
      claim: "above",
      threshold: policy.config.operational_pause_verified_harm_lower_above,
      rejection_alpha: policy.config.operational_pause_alpha_per_checkpoint,
    });
    assert.equal(result.assignment_count, (1n << 384n).toString());
    assert.ok(performance.now() - started < 60_000);
  }

  const patterns: ReadonlyArray<Readonly<{
    name: string;
    contrasts: readonly Contrast[];
    resultSha256: string;
  }>> = [
    {
      name: "all-minus",
      contrasts: Array.from({ length: 384 }, () => -1 as const),
      resultSha256: "83973b75d47e081d47ced00670ac4ee4cec8c5dbb21ad994c78d294a86ca6122",
    },
    {
      name: "all-zero",
      contrasts: Array.from({ length: 384 }, () => 0 as const),
      resultSha256: "71af427484cdc9ab0f87ca7059efb1cae7dbf5f098c5bb32939d9fe5afcb58c3",
    },
    {
      name: "all-plus",
      contrasts: Array.from({ length: 384 }, () => 1 as const),
      resultSha256: "7317d50368a76e6dfe58332a34eb0c4b5790054b21add2f0b4f9968bbf6bae0b",
    },
    {
      name: "balanced",
      contrasts: Array.from(
        { length: 384 },
        (_, index) => index % 3 === 0 ? -1 as const : index % 3 === 1 ? 0 as const : 1 as const,
      ),
      resultSha256: "2654af502c1066c5de740d44eb5cf500c1bc673abd817ad8c5d7ec7d5c2b2a79",
    },
    {
      name: "boundary",
      contrasts: Array.from({ length: 384 }, (_, index) => index < 192 ? -1 as const : 1 as const),
      resultSha256: "62cba7692638c18b2b6b250bf48ae2da8fd443547bac781d1628d2270d4f7554",
    },
    {
      name: "worst-missing-coded",
      contrasts: Array.from({ length: 384 }, (_, index) => index % 5 === 0 ? 1 as const : 0 as const),
      resultSha256: "4268c775426f84266abeef81efaf8f94a66dcd94090e69f5a116c4f9fc989109",
    },
  ];
  let maximumObservedRss = process.memoryUsage().rss;
  for (const pattern of patterns) {
    const started = performance.now();
    const result = evaluateLearningRiskDifferenceExact({
      contract_version: "aionis_learning_risk_difference_exact_input_v1",
      pair_count: 384,
      observed_contrasts: pattern.contrasts,
      claim: "at_most",
      threshold: policy.config.exploit_harm_noninferiority_margin,
      rejection_alpha: policy.config.alpha_per_direction_per_formal_look,
    });
    const elapsed = performance.now() - started;
    maximumObservedRss = Math.max(maximumObservedRss, process.memoryUsage().rss);
    assert.equal(result.assignment_count, (1n << 384n).toString());
    assert.equal(result.result_sha256, pattern.resultSha256, `${pattern.name} result drifted`);
    assert.ok(elapsed < 60_000, `${pattern.name} exact kernel took ${String(elapsed)}ms`);
  }
  assert.ok(maximumObservedRss <= 512 * 1024 * 1024);
});
