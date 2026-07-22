import type { SignedAuthorityArtifactV1 } from "./authority-artifact.js";
import type {
  AuthorityBranchCapsuleBindingV1,
  AuthoritativeBranchRevisionRefV1,
} from "./authority-branch.js";
import {
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type AuthorityArtifactRefV1,
  type Sha256,
} from "./contract.js";

export const POLICY_ROTATION_ARTIFACT_SCHEMA_V1 = "policy_rotation_v1" as const;

export type PolicyRotationPayloadV1 = Readonly<{
  schema_version: "policy_rotation_v1";
  tenant_id: string;
  authority_subject_sha256: Sha256;
  previous_authoritative_ref: AuthoritativeBranchRevisionRefV1;
  old_compiler_policy_ref: AuthorityArtifactRefV1;
  new_compiler_policy_ref: AuthorityArtifactRefV1;
  old_evidence_policy_ref: AuthorityArtifactRefV1;
  new_evidence_policy_ref: AuthorityArtifactRefV1;
  previous_binding_set_sha256: Sha256;
}>;

export type PolicyRotationAuthorityArtifactV1 = SignedAuthorityArtifactV1 & Readonly<{
  artifact_kind: "policy_rotation";
  artifact_schema: "policy_rotation_v1";
  authority_subject_sha256: Sha256;
  payload: PolicyRotationPayloadV1;
}>;

const PAYLOAD_KEYS = Object.freeze([
  "authority_subject_sha256",
  "new_compiler_policy_ref",
  "new_evidence_policy_ref",
  "old_compiler_policy_ref",
  "old_evidence_policy_ref",
  "previous_authoritative_ref",
  "previous_binding_set_sha256",
  "schema_version",
  "tenant_id",
] as const);
const REF_KEYS = Object.freeze(["artifact_sha256", "payload_sha256"] as const);
const BRANCH_REF_KEYS = Object.freeze([
  "branch_id", "branch_kind", "branch_revision", "manifest_sha256", "state",
] as const);

function fail(code: string): never {
  throw new Error(`policy_rotation_v1_${code}`);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field}_must_be_plain_object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${field}_must_be_plain_object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) fail(`${field}_shape_invalid`);
  const actual = keys as string[];
  const expected = new Set(expectedKeys);
  if (actual.length !== expectedKeys.length
    || actual.some((key) => !expected.has(key))
    || expectedKeys.some((key) => !actual.includes(key))) fail(`${field}_shape_invalid`);
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    assertUnicodeScalarString(key, `policy rotation ${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape_invalid`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `policy rotation ${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) fail(`${field}_invalid`);
  return value;
}

function sha(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertSha256(value, `policy rotation ${field}`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${field}_invalid`);
  return value as number;
}

function artifactRef(value: unknown, field: string): AuthorityArtifactRefV1 {
  const record = exactRecord(value, REF_KEYS, field);
  return {
    artifact_sha256: sha(record.artifact_sha256, `${field}_artifact_sha256`),
    payload_sha256: sha(record.payload_sha256, `${field}_payload_sha256`),
  };
}

function authoritativeRef(value: unknown): AuthoritativeBranchRevisionRefV1 {
  const record = exactRecord(value, BRANCH_REF_KEYS, "previous_authoritative_ref");
  if (record.branch_kind !== "authoritative" || record.state !== "authoritative") {
    fail("previous_authoritative_ref_kind_invalid");
  }
  return {
    branch_id: text(record.branch_id, "previous_authoritative_ref_branch_id"),
    branch_revision: positiveInteger(
      record.branch_revision,
      "previous_authoritative_ref_branch_revision",
    ),
    manifest_sha256: sha(
      record.manifest_sha256,
      "previous_authoritative_ref_manifest_sha256",
    ),
    branch_kind: "authoritative",
    state: "authoritative",
  };
}

function parsePayload(value: unknown): PolicyRotationPayloadV1 {
  const record = exactRecord(value, PAYLOAD_KEYS, "payload");
  if (record.schema_version !== POLICY_ROTATION_ARTIFACT_SCHEMA_V1) {
    fail("payload_schema_version_invalid");
  }
  const payload: PolicyRotationPayloadV1 = {
    schema_version: POLICY_ROTATION_ARTIFACT_SCHEMA_V1,
    tenant_id: text(record.tenant_id, "tenant_id"),
    authority_subject_sha256: sha(
      record.authority_subject_sha256,
      "authority_subject_sha256",
    ),
    previous_authoritative_ref: authoritativeRef(record.previous_authoritative_ref),
    old_compiler_policy_ref: artifactRef(
      record.old_compiler_policy_ref,
      "old_compiler_policy_ref",
    ),
    new_compiler_policy_ref: artifactRef(
      record.new_compiler_policy_ref,
      "new_compiler_policy_ref",
    ),
    old_evidence_policy_ref: artifactRef(
      record.old_evidence_policy_ref,
      "old_evidence_policy_ref",
    ),
    new_evidence_policy_ref: artifactRef(
      record.new_evidence_policy_ref,
      "new_evidence_policy_ref",
    ),
    previous_binding_set_sha256: sha(
      record.previous_binding_set_sha256,
      "previous_binding_set_sha256",
    ),
  };
  if (canonicalContinuationJson(payload.old_compiler_policy_ref)
      === canonicalContinuationJson(payload.new_compiler_policy_ref)
    && canonicalContinuationJson(payload.old_evidence_policy_ref)
      === canonicalContinuationJson(payload.new_evidence_policy_ref)) {
    fail("must_change_at_least_one_policy");
  }
  return canonicalContinuationClone(payload);
}

export function authorityBranchBindingSetSha256V1(
  bindings: readonly AuthorityBranchCapsuleBindingV1[],
): Sha256 {
  return canonicalContinuationSha256({
    schema_version: "authority_branch_binding_set_v1",
    capsule_bindings: bindings,
  });
}

export function buildPolicyRotationPayloadV1(
  input: PolicyRotationPayloadV1,
): PolicyRotationPayloadV1 {
  return parsePayload(input);
}

export function verifyPolicyRotationPayloadV1(value: unknown): PolicyRotationPayloadV1 {
  return parsePayload(value);
}

/**
 * Parses an artifact already authenticated by AuthorityArtifactStore. Signature,
 * full-envelope digest, validity, and trust-root checks remain owned by that
 * store; this contract closes the policy-rotation schema and semantic binding.
 */
export function verifyPolicyRotationAuthorityArtifactV1(
  value: SignedAuthorityArtifactV1,
): PolicyRotationAuthorityArtifactV1 {
  if (value.artifact_kind !== "policy_rotation"
    || value.artifact_schema !== POLICY_ROTATION_ARTIFACT_SCHEMA_V1
    || value.authority_subject_sha256 === null) fail("artifact_envelope_invalid");
  const payload = parsePayload(value.payload);
  if (value.tenant_id !== payload.tenant_id
    || value.authority_subject_sha256 !== payload.authority_subject_sha256
    || canonicalContinuationSha256(payload) !== value.payload_sha256) {
    fail("artifact_payload_binding_invalid");
  }
  return canonicalContinuationClone({ ...value, payload }) as PolicyRotationAuthorityArtifactV1;
}
