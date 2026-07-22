import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { buildSignedAuthorityArtifactV1 } from
  "../../src/continuation/authority-artifact.js";
import type { AuthorityBranchCapsuleBindingV1 } from
  "../../src/continuation/authority-branch.js";
import {
  authorityBranchBindingSetSha256V1,
  buildPolicyRotationPayloadV1,
  verifyPolicyRotationAuthorityArtifactV1,
  verifyPolicyRotationPayloadV1,
  type PolicyRotationPayloadV1,
} from "../../src/continuation/policy-rotation.js";

const KEYS = generateKeyPairSync("ed25519");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);

function payload(overrides: Partial<PolicyRotationPayloadV1> = {}): PolicyRotationPayloadV1 {
  return {
    schema_version: "policy_rotation_v1",
    tenant_id: "tenant-a",
    authority_subject_sha256: SHA_A,
    previous_authoritative_ref: {
      branch_id: "authority-main",
      branch_revision: 3,
      manifest_sha256: SHA_B,
      branch_kind: "authoritative",
      state: "authoritative",
    },
    old_compiler_policy_ref: { artifact_sha256: SHA_B, payload_sha256: SHA_C },
    new_compiler_policy_ref: { artifact_sha256: SHA_D, payload_sha256: SHA_E },
    old_evidence_policy_ref: { artifact_sha256: SHA_C, payload_sha256: SHA_D },
    new_evidence_policy_ref: { artifact_sha256: SHA_C, payload_sha256: SHA_D },
    previous_binding_set_sha256: SHA_E,
    ...overrides,
  };
}

function signed(overrides: Partial<PolicyRotationPayloadV1> = {}) {
  const rotation = buildPolicyRotationPayloadV1(payload(overrides));
  return buildSignedAuthorityArtifactV1({
    tenant_id: rotation.tenant_id,
    artifact_id: "rotation-main-4",
    artifact_revision: 1,
    artifact_kind: "policy_rotation",
    artifact_schema: "policy_rotation_v1",
    authority_subject_sha256: rotation.authority_subject_sha256,
    payload: rotation,
    valid_from: "2026-07-21T01:00:00.000Z",
    expires_at: "2026-07-22T01:00:00.000Z",
    created_at: "2026-07-21T00:00:00.000Z",
  }, KEYS.privateKey);
}

test("rotation payload and signed artifact bind exact old/new authority", () => {
  const built = buildPolicyRotationPayloadV1(payload());
  const verified = verifyPolicyRotationAuthorityArtifactV1(signed());
  assert.deepEqual(verified.payload, built);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.payload), true);
  assert.equal(Object.isFrozen(verified.payload.previous_authoritative_ref), true);
  assert.equal(Object.isFrozen(verified.payload.new_compiler_policy_ref), true);
  assert.notEqual(verified.payload_sha256, SHA_A);
});

test("rotation must change at least one complete full+payload policy reference", () => {
  assert.throws(() => buildPolicyRotationPayloadV1(payload({
    new_compiler_policy_ref: payload().old_compiler_policy_ref,
    new_evidence_policy_ref: payload().old_evidence_policy_ref,
  })), /must_change_at_least_one_policy/u);
  assert.doesNotThrow(() => buildPolicyRotationPayloadV1(payload({
    new_compiler_policy_ref: {
      ...payload().old_compiler_policy_ref,
      payload_sha256: SHA_D,
    },
    new_evidence_policy_ref: payload().old_evidence_policy_ref,
  })));
});

test("rotation artifact envelope, subject, schema, and payload digest fail closed", () => {
  const artifact = signed();
  assert.throws(() => verifyPolicyRotationAuthorityArtifactV1({
    ...artifact,
    artifact_kind: "experiment_cohort",
  }), /artifact_envelope_invalid/u);
  assert.throws(() => verifyPolicyRotationAuthorityArtifactV1({
    ...artifact,
    artifact_schema: "experiment_cohort_v1",
  }), /artifact_envelope_invalid/u);
  assert.throws(() => verifyPolicyRotationAuthorityArtifactV1({
    ...artifact,
    authority_subject_sha256: SHA_B,
  }), /artifact_payload_binding_invalid/u);
  assert.throws(() => verifyPolicyRotationAuthorityArtifactV1({
    ...artifact,
    payload_sha256: SHA_B,
  }), /artifact_payload_binding_invalid/u);
});

test("payload is exact descriptor-safe canonical data with authoritative previous ref", () => {
  assert.throws(() => verifyPolicyRotationPayloadV1({ ...payload(), extra: true }),
    /shape_invalid/u);
  assert.throws(() => verifyPolicyRotationPayloadV1({
    ...payload(),
    previous_authoritative_ref: {
      ...payload().previous_authoritative_ref,
      branch_kind: "candidate",
      state: "active_candidate",
    },
  }), /kind_invalid/u);
  const accessor = { ...payload() } as Record<string, unknown>;
  Object.defineProperty(accessor, "tenant_id", {
    enumerable: true,
    get: () => "tenant-a",
  });
  assert.throws(() => verifyPolicyRotationPayloadV1(accessor), /shape_invalid/u);
  assert.throws(() => verifyPolicyRotationPayloadV1({
    ...payload(),
    tenant_id: "tenant\noperator",
  }), /tenant_id_invalid/u);
});

test("binding-set digest changes with any exact prior capsule authority byte", () => {
  const bindings: AuthorityBranchCapsuleBindingV1[] = [{
    capsule_scope: "scope-a",
    capsule: {
      capsule_id: "capsule-a",
      capsule_revision: 1,
      capsule_sha256: SHA_A,
    },
    disposition: "include",
    admission_authority: "authoritative",
  }];
  const digest = authorityBranchBindingSetSha256V1(bindings);
  assert.notEqual(digest, authorityBranchBindingSetSha256V1([
    { ...bindings[0]!, disposition: "prohibit" },
  ]));
  assert.notEqual(digest, authorityBranchBindingSetSha256V1([
    { ...bindings[0]!, capsule: { ...bindings[0]!.capsule, capsule_sha256: SHA_B } },
  ]));
});
