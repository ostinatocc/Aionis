import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContinuationCompilerPolicyV1,
  verifyContinuationCompilerPolicyV1,
  type ContinuationCompilerPolicyV1,
} from "../../src/continuation/compiler-policy.js";

const PRINCIPAL = "1".repeat(64);
const SECOND_PRINCIPAL = "2".repeat(64);
const SUBJECT = "a".repeat(64);

function policy(): ContinuationCompilerPolicyV1 {
  return {
    schema_version: "continuation_compiler_policy_v1",
    tenant_id: "tenant-a",
    authority_subject_sha256: SUBJECT,
    candidate_limit: 128,
    continuity_candidate_limit: 64,
    learning_candidate_limit: 64,
    selected_capsule_limit: 64,
    obligation_limit: 64,
    max_render_budget: 65_536,
    hard_coverage_weight: 1_000_000,
    advisory_coverage_weight: 10_000,
    authority_bonus: { candidate: 0, verified: 64, authoritative: 128 },
    freshness_bonus: [0, 2, 4, 8],
    freshness_max_age_ms: [3_600_000, 86_400_000, 604_800_000],
    trusted_observer_principals: {
      trusted_host_collector: [PRINCIPAL],
      external_verifier: [SECOND_PRINCIPAL],
    },
  };
}

test("compiler policy parser returns exact detached deeply frozen authority payload", () => {
  const input = policy();
  const parsed = buildContinuationCompilerPolicyV1(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.authority_bonus), true);
  assert.equal(Object.isFrozen(parsed.freshness_bonus), true);
  assert.equal(Object.isFrozen(parsed.trusted_observer_principals.external_verifier), true);
  assert.deepEqual(verifyContinuationCompilerPolicyV1(parsed), parsed);
});

test("compiler policy is descriptor-safe and rejects unknown, missing, inherited, and accessor data", () => {
  const valid = policy();
  assert.throws(
    () => verifyContinuationCompilerPolicyV1({ ...valid, unknown: true }),
    /unknown or missing fields/u,
  );
  const { candidate_limit: _candidateLimit, ...missing } = valid;
  assert.throws(() => verifyContinuationCompilerPolicyV1(missing), /unknown or missing fields/u);
  assert.throws(
    () => verifyContinuationCompilerPolicyV1(Object.assign(Object.create({ inherited: true }), valid)),
    /plain record/u,
  );
  let accessorCalls = 0;
  const accessor = { ...valid } as Record<string, unknown>;
  Object.defineProperty(accessor, "candidate_limit", {
    enumerable: true,
    get: () => { accessorCalls += 1; return 128; },
  });
  assert.throws(() => verifyContinuationCompilerPolicyV1(accessor), /data properties/u);
  assert.equal(accessorCalls, 0);
  const symbol = { ...valid } as Record<PropertyKey, unknown>;
  symbol[Symbol("hidden")] = true;
  assert.throws(() => verifyContinuationCompilerPolicyV1(symbol), /unknown or missing fields/u);
});

test("compiler policy closes nested shapes, tuple density, principal order, and numeric bounds", () => {
  const valid = policy();
  assert.throws(() => verifyContinuationCompilerPolicyV1({
    ...valid,
    authority_bonus: { ...valid.authority_bonus, root: 1 },
  }), /unknown or missing fields/u);
  const sparse = [0, 2, 4, 8] as Array<number | undefined>;
  delete sparse[2];
  assert.throws(() => verifyContinuationCompilerPolicyV1({
    ...valid,
    freshness_bonus: sparse,
  }), /dense without extra fields/u);
  const extra = [...valid.freshness_max_age_ms] as number[] & { extra?: boolean };
  extra.extra = true;
  assert.throws(() => verifyContinuationCompilerPolicyV1({
    ...valid,
    freshness_max_age_ms: extra,
  }), /dense without extra fields/u);
  assert.throws(() => verifyContinuationCompilerPolicyV1({
    ...valid,
    trusted_observer_principals: {
      ...valid.trusted_observer_principals,
      trusted_host_collector: [SECOND_PRINCIPAL, PRINCIPAL],
    },
  }), /canonical UTF-8 order/u);
  assert.throws(() => verifyContinuationCompilerPolicyV1({
    ...valid,
    trusted_observer_principals: {
      ...valid.trusted_observer_principals,
      external_verifier: [SECOND_PRINCIPAL, SECOND_PRINCIPAL],
    },
  }), /duplicate principals/u);
  assert.throws(() => verifyContinuationCompilerPolicyV1({
    ...valid,
    candidate_limit: 257,
  }), /candidate_limit/u);
  assert.throws(() => verifyContinuationCompilerPolicyV1({
    ...valid,
    continuity_candidate_limit: 65,
  }), /must equal candidate_limit/u);
  assert.throws(() => verifyContinuationCompilerPolicyV1({
    ...valid,
    selected_capsule_limit: 65,
  }), /selected_capsule_limit/u);
  assert.throws(() => verifyContinuationCompilerPolicyV1({
    ...valid,
    freshness_max_age_ms: [86_400_000, 3_600_000, 604_800_000],
  }), /strictly increasing/u);
});
