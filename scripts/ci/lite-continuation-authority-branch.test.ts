import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthorityBranchManifestError,
  buildAuthorityBranchManifestV1,
  verifyAuthorityBranchManifestV1,
  type AuthoritativeBranchRevisionRefV1,
  type AuthorityBranchCapsuleBindingV1,
  type AuthorityBranchManifestInputV1,
  type AuthorityBranchManifestV1,
  type AuthorityBranchStateV1,
} from "../../src/continuation/authority-branch.js";
import {
  canonicalContinuationSha256,
  canonicalSha256Without,
} from "../../src/continuation/contract.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const CREATED_AT = "2026-07-21T12:00:00.000Z";

const BASE: AuthoritativeBranchRevisionRefV1 = {
  branch_id: "authority-main",
  branch_revision: 3,
  manifest_sha256: SHA_A,
  branch_kind: "authoritative",
  state: "authoritative",
};

function binding(
  scope: string,
  capsuleId: string,
  revision: number,
  disposition: AuthorityBranchCapsuleBindingV1["disposition"],
  admissionAuthority: AuthorityBranchCapsuleBindingV1["admission_authority"],
  digest = SHA_B,
): AuthorityBranchCapsuleBindingV1 {
  return {
    capsule_scope: scope,
    capsule: {
      capsule_id: capsuleId,
      capsule_revision: revision,
      capsule_sha256: digest,
    },
    disposition,
    admission_authority: admissionAuthority,
  };
}

function bindings(): AuthorityBranchCapsuleBindingV1[] {
  return [
    binding("scope-b", "capsule-b", 2, "exclude", "candidate", SHA_C),
    binding("scope-a", "capsule-z", 1, "include", "candidate", SHA_B),
    binding("scope-a", "capsule-a", 3, "prohibit", "authoritative", SHA_D),
  ];
}

function candidateInput(
  overrides: Partial<AuthorityBranchManifestInputV1> = {},
): AuthorityBranchManifestInputV1 {
  return {
    tenant_id: "tenant-a",
    authority_subject_sha256: SHA_E,
    branch_id: "candidate-main",
    branch_revision: 1,
    branch_kind: "candidate",
    state: "draft",
    base_authoritative_ref: BASE,
    previous_revision_ref: null,
    capsule_bindings: bindings(),
    compiler_policy_ref: { artifact_sha256: SHA_B, payload_sha256: SHA_C },
    evidence_policy_ref: { artifact_sha256: SHA_C, payload_sha256: SHA_D },
    effect_certificate_sha256: null,
    reverts_authority_ref: null,
    policy_rotation_artifact_ref: null,
    trusted_observation_admission_ref: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function authoritativeInput(
  overrides: Partial<AuthorityBranchManifestInputV1> = {},
): AuthorityBranchManifestInputV1 {
  return {
    tenant_id: "tenant-a",
    authority_subject_sha256: SHA_E,
    branch_id: "authority-main",
    branch_revision: 1,
    branch_kind: "authoritative",
    state: "authoritative",
    base_authoritative_ref: null,
    previous_revision_ref: null,
    capsule_bindings: bindings(),
    compiler_policy_ref: { artifact_sha256: SHA_B, payload_sha256: SHA_C },
    evidence_policy_ref: { artifact_sha256: SHA_C, payload_sha256: SHA_D },
    effect_certificate_sha256: null,
    reverts_authority_ref: null,
    policy_rotation_artifact_ref: null,
    trusted_observation_admission_ref: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function candidatePrevious(
  state: Exclude<AuthorityBranchStateV1, "authoritative">,
  revision: number,
) {
  return {
    branch_id: "candidate-main",
    branch_revision: revision,
    manifest_sha256: SHA_D,
    branch_kind: "candidate" as const,
    state,
  };
}

function mutable(value: unknown): Record<string, any> {
  return JSON.parse(JSON.stringify(value)) as Record<string, any>;
}

function assertManifestFailure(
  operation: () => unknown,
  code?: AuthorityBranchManifestError["code"],
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof AuthorityBranchManifestError);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test("branch manifests deterministically canonicalize the binding set and bind every authority field", () => {
  const first = buildAuthorityBranchManifestV1(candidateInput());
  const reordered = buildAuthorityBranchManifestV1(candidateInput({
    capsule_bindings: [...bindings()].reverse(),
  }));

  assert.deepEqual(reordered, first);
  assert.deepEqual(
    first.capsule_bindings.map((entry) => [
      entry.capsule_scope,
      entry.capsule.capsule_id,
      entry.capsule.capsule_revision,
      entry.disposition,
    ]),
    [
      ["scope-a", "capsule-a", 3, "prohibit"],
      ["scope-a", "capsule-z", 1, "include"],
      ["scope-b", "capsule-b", 2, "exclude"],
    ],
  );
  assert.equal(canonicalSha256Without(first, "manifest_sha256"), first.manifest_sha256);

  const changedAdmission = buildAuthorityBranchManifestV1(candidateInput({
    capsule_bindings: bindings().map((entry, index) => index === 0
      ? { ...entry, admission_authority: "authoritative" }
      : entry),
  }));
  const changedDisposition = buildAuthorityBranchManifestV1(candidateInput({
    capsule_bindings: bindings().map((entry, index) => index === 0
      ? { ...entry, disposition: "prohibit" }
      : entry),
  }));
  assert.notEqual(changedAdmission.manifest_sha256, first.manifest_sha256);
  assert.notEqual(changedDisposition.manifest_sha256, first.manifest_sha256);
  assert.notEqual(
    buildAuthorityBranchManifestV1(candidateInput({
      compiler_policy_ref: { artifact_sha256: SHA_A, payload_sha256: SHA_C },
    })).manifest_sha256,
    first.manifest_sha256,
  );
  assert.notEqual(
    buildAuthorityBranchManifestV1(candidateInput({
      compiler_policy_ref: { artifact_sha256: SHA_B, payload_sha256: SHA_A },
    })).manifest_sha256,
    first.manifest_sha256,
  );
  assert.notEqual(
    buildAuthorityBranchManifestV1(candidateInput({
      evidence_policy_ref: { artifact_sha256: SHA_A, payload_sha256: SHA_D },
    })).manifest_sha256,
    first.manifest_sha256,
  );
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    policy_rotation_artifact_ref: { artifact_sha256: SHA_A, payload_sha256: SHA_B },
  })));
  assert.notEqual(
    buildAuthorityBranchManifestV1(candidateInput({ created_at: "2026-07-21T12:00:00.001Z" }))
      .manifest_sha256,
    first.manifest_sha256,
  );
});

test("build and verify return detached deeply frozen canonical authority", () => {
  const source = candidateInput();
  const built = buildAuthorityBranchManifestV1(source);
  (source.capsule_bindings[0]!.capsule as { capsule_id: string }).capsule_id = "caller-mutated";

  assert.equal(built.capsule_bindings.some(
    (entry) => entry.capsule.capsule_id === "caller-mutated",
  ), false);
  assert.equal(Object.isFrozen(built), true);
  assert.equal(Object.isFrozen(built.base_authoritative_ref), true);
  assert.equal(Object.isFrozen(built.capsule_bindings), true);
  assert.equal(Object.isFrozen(built.capsule_bindings[0]), true);
  assert.equal(Object.isFrozen(built.capsule_bindings[0]?.capsule), true);
  assert.throws(() => {
    (built.capsule_bindings[0]!.capsule as { capsule_id: string }).capsule_id = "tamper";
  }, TypeError);

  const reorderedOuter = Object.fromEntries(Object.entries(built).reverse());
  const verified = verifyAuthorityBranchManifestV1(reorderedOuter);
  assert.deepEqual(verified, built);
  assert.notEqual(verified, built);
  assert.notEqual(verified.capsule_bindings, built.capsule_bindings);
  assert.notEqual(verified.capsule_bindings[0], built.capsule_bindings[0]);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.previous_revision_ref), true);
});

test("authoritative genesis, later revisions, reverts, and every legal candidate transition are closed", () => {
  assert.equal(buildAuthorityBranchManifestV1(authoritativeInput()).state, "authoritative");
  const authoritativeRevision = buildAuthorityBranchManifestV1(authoritativeInput({
    branch_revision: 3,
    previous_revision_ref: {
      branch_id: "authority-main",
      branch_revision: 2,
      manifest_sha256: SHA_A,
      branch_kind: "authoritative",
      state: "authoritative",
    },
    reverts_authority_ref: {
      branch_id: "authority-main",
      branch_revision: 1,
      manifest_sha256: SHA_D,
      branch_kind: "authoritative",
      state: "authoritative",
    },
  }));
  assert.equal(authoritativeRevision.reverts_authority_ref?.branch_revision, 1);
  assert.doesNotThrow(() => buildAuthorityBranchManifestV1(authoritativeInput({
    branch_revision: 2,
    previous_revision_ref: {
      branch_id: "authority-main",
      branch_revision: 1,
      manifest_sha256: SHA_A,
      branch_kind: "authoritative",
      state: "authoritative",
    },
    effect_certificate_sha256: SHA_D,
  })));
  assert.doesNotThrow(() => buildAuthorityBranchManifestV1(authoritativeInput({
    branch_revision: 2,
    previous_revision_ref: {
      branch_id: "authority-main",
      branch_revision: 1,
      manifest_sha256: SHA_A,
      branch_kind: "authoritative",
      state: "authoritative",
    },
    policy_rotation_artifact_ref: {
      artifact_sha256: SHA_B,
      payload_sha256: SHA_C,
    },
  })));

  const transitions = [
    { revision: 2, previous: "draft", current: "shadow", effect: null },
    { revision: 3, previous: "shadow", current: "eligible", effect: null },
    { revision: 4, previous: "eligible", current: "active_candidate", effect: null },
    { revision: 5, previous: "active_candidate", current: "merged", effect: SHA_A },
  ] as const;
  for (const transition of transitions) {
    const manifest = buildAuthorityBranchManifestV1(candidateInput({
      branch_revision: transition.revision,
      state: transition.current,
      previous_revision_ref: candidatePrevious(
        transition.previous,
        transition.revision - 1,
      ),
      effect_certificate_sha256: transition.effect,
    }));
    assert.equal(manifest.state, transition.current);
  }
  for (const previous of ["draft", "shadow", "eligible", "active_candidate"] as const) {
    for (const terminal of ["rejected", "quarantined", "expired"] as const) {
      assert.doesNotThrow(() => buildAuthorityBranchManifestV1(candidateInput({
        branch_revision: previous === "draft" ? 2 : 5,
        state: terminal,
        previous_revision_ref: candidatePrevious(
          previous,
          previous === "draft" ? 1 : 4,
        ),
      })));
    }
  }
});

test("negative branch state matrix rejects incoherent kind, base, previous, effect, and revert refs", () => {
  const invalid: unknown[] = [
    { ...authoritativeInput(), state: "draft" },
    { ...authoritativeInput(), base_authoritative_ref: BASE },
    { ...candidateInput(), state: "authoritative" },
    { ...candidateInput(), base_authoritative_ref: null },
    {
      ...candidateInput(),
      base_authoritative_ref: { ...BASE, branch_id: "candidate-main" },
    },
    { ...candidateInput(), state: "shadow" },
    { ...candidateInput(), previous_revision_ref: candidatePrevious("draft", 1) },
    { ...candidateInput(), branch_revision: 2, state: "shadow", previous_revision_ref: null },
    {
      ...candidateInput(), branch_revision: 2, state: "shadow",
      previous_revision_ref: { ...candidatePrevious("draft", 1), branch_id: "other" },
    },
    {
      ...candidateInput(), branch_revision: 3, state: "eligible",
      previous_revision_ref: candidatePrevious("shadow", 1),
    },
    {
      ...candidateInput(), branch_revision: 2, state: "shadow",
      previous_revision_ref: { ...BASE, branch_id: "candidate-main", branch_revision: 1 },
    },
    {
      ...candidateInput(), branch_revision: 2, state: "eligible",
      previous_revision_ref: candidatePrevious("draft", 1),
    },
    {
      ...candidateInput(), branch_revision: 6, state: "shadow",
      previous_revision_ref: candidatePrevious("merged", 5),
    },
    {
      ...candidateInput(), branch_revision: 5, state: "merged",
      previous_revision_ref: candidatePrevious("active_candidate", 4),
      effect_certificate_sha256: null,
    },
    { ...candidateInput(), reverts_authority_ref: BASE },
    {
      ...candidateInput(),
      policy_rotation_artifact_ref: { artifact_sha256: SHA_A, payload_sha256: SHA_B },
    },
    { ...authoritativeInput(), reverts_authority_ref: BASE },
    {
      ...authoritativeInput(),
      policy_rotation_artifact_ref: { artifact_sha256: SHA_A, payload_sha256: SHA_B },
    },
    {
      ...authoritativeInput(), branch_revision: 2,
      previous_revision_ref: { ...BASE, branch_id: "authority-main", branch_revision: 1 },
      reverts_authority_ref: { ...BASE, branch_id: "authority-history", branch_revision: 1 },
    },
    {
      ...authoritativeInput(), branch_revision: 2,
      previous_revision_ref: { ...BASE, branch_id: "authority-main", branch_revision: 1 },
      reverts_authority_ref: { ...BASE, branch_id: "authority-main", branch_revision: 2 },
    },
    {
      ...authoritativeInput(), branch_revision: 3,
      previous_revision_ref: { ...BASE, branch_id: "authority-main", branch_revision: 2 },
      reverts_authority_ref: { ...BASE, branch_id: "authority-main", branch_revision: 1 },
      effect_certificate_sha256: SHA_A,
      policy_rotation_artifact_ref: { artifact_sha256: SHA_B, payload_sha256: SHA_C },
    },
    {
      ...authoritativeInput(), branch_revision: 2,
      previous_revision_ref: {
        ...candidatePrevious("draft", 1), branch_id: "authority-main",
      },
    },
    {
      ...candidateInput(),
      base_authoritative_ref: {
        ...candidatePrevious("draft", 1), branch_id: "candidate-base",
      },
    },
  ];
  for (const value of invalid) {
    assertManifestFailure(() => buildAuthorityBranchManifestV1(value as never));
  }

  for (const current of [
    "draft", "shadow", "eligible", "active_candidate", "merged",
    "rejected", "quarantined", "expired",
  ] as const) {
    assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
      branch_revision: 7,
      state: current,
      previous_revision_ref: candidatePrevious("rejected", 6),
      effect_certificate_sha256: current === "merged" ? SHA_A : null,
    })));
  }
});

test("verification rejects digest reuse after body, binding, ordering, or digest tampering", () => {
  const manifest = buildAuthorityBranchManifestV1(candidateInput());

  const policyTamper = mutable(manifest);
  policyTamper.compiler_policy_ref.payload_sha256 = SHA_D;
  assertManifestFailure(
    () => verifyAuthorityBranchManifestV1(policyTamper),
    "authority_branch_manifest_digest_mismatch",
  );

  const bindingTamper = mutable(manifest);
  bindingTamper.capsule_bindings[0].admission_authority = "candidate";
  assertManifestFailure(
    () => verifyAuthorityBranchManifestV1(bindingTamper),
    "authority_branch_manifest_digest_mismatch",
  );

  const orderTamper = mutable(manifest);
  orderTamper.capsule_bindings.reverse();
  assertManifestFailure(
    () => verifyAuthorityBranchManifestV1(orderTamper),
    "authority_branch_manifest_digest_mismatch",
  );

  const digestTamper = mutable(manifest);
  digestTamper.manifest_sha256 = SHA_A;
  assertManifestFailure(
    () => verifyAuthorityBranchManifestV1(digestTamper),
    "authority_branch_manifest_digest_mismatch",
  );

  const invalidStateWithRecomputedDigest = mutable(manifest);
  invalidStateWithRecomputedDigest.state = "shadow";
  const { manifest_sha256: _oldDigest, ...invalidBody } = invalidStateWithRecomputedDigest;
  invalidStateWithRecomputedDigest.manifest_sha256 = canonicalContinuationSha256(invalidBody);
  assertManifestFailure(() => verifyAuthorityBranchManifestV1(invalidStateWithRecomputedDigest));
});

test("unknown, accessor, symbol, inherited, sparse, and array-extra data fail closed", () => {
  assertManifestFailure(() => buildAuthorityBranchManifestV1({
    ...candidateInput(), unknown: true,
  } as never));
  const built = buildAuthorityBranchManifestV1(candidateInput());
  assertManifestFailure(() => verifyAuthorityBranchManifestV1({ ...built, unknown: true }));
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    compiler_policy_ref: {
      artifact_sha256: SHA_B,
      payload_sha256: SHA_C,
      unknown: SHA_D,
    } as never,
  })));

  let getterExecuted = false;
  const accessor = { ...candidateInput() } as Record<string, unknown>;
  Object.defineProperty(accessor, "branch_id", {
    enumerable: true,
    get: () => {
      getterExecuted = true;
      return "forged";
    },
  });
  assertManifestFailure(() => buildAuthorityBranchManifestV1(accessor as never));
  assert.equal(getterExecuted, false);

  const nestedAccessor = mutable(candidateInput());
  Object.defineProperty(nestedAccessor.capsule_bindings[0].capsule, "capsule_id", {
    enumerable: true,
    get: () => {
      getterExecuted = true;
      return "forged";
    },
  });
  assertManifestFailure(() => buildAuthorityBranchManifestV1(nestedAccessor as never));
  assert.equal(getterExecuted, false);

  const symbol = candidateInput() as Record<PropertyKey, unknown>;
  symbol[Symbol("authority")] = true;
  assertManifestFailure(() => buildAuthorityBranchManifestV1(symbol as never));

  const inherited = Object.assign(Object.create({ inherited: true }), candidateInput());
  assertManifestFailure(() => buildAuthorityBranchManifestV1(inherited));

  const extraArray = [...bindings()] as Array<AuthorityBranchCapsuleBindingV1> & { extra?: boolean };
  extraArray.extra = true;
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    capsule_bindings: extraArray,
  })));

  const sparse = new Array<AuthorityBranchCapsuleBindingV1>(1);
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    capsule_bindings: sparse,
  })));
});

test("one scoped capsule revision has exactly one binding regardless of digest or disposition", () => {
  const first = binding("scope-a", "capsule-duplicate", 1, "include", "candidate", SHA_A);
  const conflicting = binding(
    "scope-a", "capsule-duplicate", 1, "prohibit", "authoritative", SHA_B,
  );
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    capsule_bindings: [first, conflicting],
  })));

  const differentScope = buildAuthorityBranchManifestV1(candidateInput({
    capsule_bindings: [first, { ...conflicting, capsule_scope: "scope-b" }],
  }));
  assert.equal(differentScope.capsule_bindings.length, 2);
});

test("text, Unicode, digest, timestamp, integer, array, and manifest byte bounds are strict", () => {
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    tenant_id: "中".repeat(86),
  })));
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    branch_id: "x".repeat(257),
  })));
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    authority_subject_sha256: "A".repeat(64),
  })));
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    evidence_policy_ref: { artifact_sha256: SHA_C, payload_sha256: "D".repeat(64) },
  })));
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    created_at: "2026-07-21T12:00:00Z",
  })));
  for (const revision of [0, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
      branch_revision: revision,
    })));
  }
  for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 0x7f]) {
    assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
      branch_id: `bad${String.fromCodePoint(codePoint)}branch`,
    })));
  }
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    branch_id: "bad\ud800branch",
  })));

  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    capsule_bindings: new Array(4_097).fill(bindings()[0]),
  })));

  const oversizedBindings = Array.from({ length: 900 }, (_, index) => binding(
    "scope-oversized",
    `${String(index).padStart(4, "0")}-${"x".repeat(250)}`,
    1,
    "include",
    "verified",
    SHA_A,
  ));
  assertManifestFailure(() => buildAuthorityBranchManifestV1(candidateInput({
    capsule_bindings: oversizedBindings,
  })));
});
