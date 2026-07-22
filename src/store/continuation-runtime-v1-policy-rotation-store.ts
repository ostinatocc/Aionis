import { buildAuthorityBranchManifestV1 } from "../continuation/authority-branch.js";
import {
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  type AuthorityArtifactRefV1,
  type Sha256,
} from "../continuation/contract.js";
import {
  authorityBranchBindingSetSha256V1,
  verifyPolicyRotationAuthorityArtifactV1,
} from "../continuation/policy-rotation.js";
import type { ContinuationRuntimeV1AuthorityArtifactReader } from
  "./continuation-runtime-v1-authority-artifact-reader.js";
import type {
  AppendAuthorityDecisionV1Result,
  AuthorityBranchRevisionRecordV1,
  AuthorityHeadV1,
  RotateAuthorityPoliciesV1Args,
} from "./continuation-runtime-v1-authority-types.js";
import {
  assertWritableAuthorityBindingsV1,
  buildAuthorityHeadV1,
  insertAuthorityBranchV1,
  updateAuthorityHeadV1,
} from "./continuation-runtime-v1-authority-write-projection.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import { assertContinuationRuntimeV1CohortHeadMutationAllowed } from
  "./continuation-runtime-v1-cohort-freeze.js";
import type { ContinuationRuntimeV1PolicyAuthority } from
  "./continuation-runtime-v1-policy-authority.js";
import {
  continuationRuntimeV1OperationLineage,
  type ContinuationRuntimeV1AuthorityWriteBinding,
  type ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";

type VerifiedHead = Readonly<{
  head: AuthorityHeadV1;
  target: AuthorityBranchRevisionRecordV1;
}>;

export type RotateContinuationRuntimeV1PoliciesDependencies = Readonly<{
  database: ContinuationRuntimeV1Database;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
  binding: ContinuationRuntimeV1AuthorityWriteBinding;
  args: RotateAuthorityPoliciesV1Args;
  readHead(
    tenantId: string,
    subject: Sha256,
    pending?: ContinuationRuntimeV1OperationLineageV1 | null,
  ): Promise<VerifiedHead | null>;
  headConflict(
    expectedRevision: number,
    actualRevision: number | null,
    expectedSha256: string,
    actualSha256: string | null,
  ): Error;
}>;

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_authority_${code}`);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field}_must_be_plain_object`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if ((Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
    || keys.some((key) => typeof key !== "string")
    || keys.length !== expectedKeys.length
    || keys.some((key) => !expected.has(key as string))) fail(`${field}_shape_invalid`);
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    assertUnicodeScalarString(key, `policy rotation ${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape_invalid`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function sha(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertSha256(value, `policy rotation ${field}`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${field}_invalid`);
  return value as number;
}

export async function rotateContinuationRuntimeV1Policies(
  dependencies: RotateContinuationRuntimeV1PoliciesDependencies,
): Promise<AppendAuthorityDecisionV1Result> {
  const {
    database, artifactStore, policyAuthority, binding, args, readHead,
  } = dependencies;
  const parsed = exactRecord(args, [
    "expected_head_revision", "expected_head_sha256",
    "policy_rotation_artifact_ref",
  ], "policy_rotation_args");
  const expectedRevision = integer(parsed.expected_head_revision, "expected_head_revision");
  const expectedSha = sha(parsed.expected_head_sha256, "expected_head_sha256");
  const refRecord = exactRecord(parsed.policy_rotation_artifact_ref,
    ["artifact_sha256", "payload_sha256"], "policy_rotation_artifact_ref");
  const rotationRef: AuthorityArtifactRefV1 = {
    artifact_sha256: sha(refRecord.artifact_sha256, "policy_rotation_artifact_sha256"),
    payload_sha256: sha(refRecord.payload_sha256, "policy_rotation_payload_sha256"),
  };
  const installed = await artifactStore.readByDigest({
    tenant_id: binding.tenantId,
    artifact_sha256: rotationRef.artifact_sha256,
  });
  if (!installed || installed.signed_artifact.payload_sha256 !== rotationRef.payload_sha256) {
    fail("policy_rotation_artifact_missing");
  }
  const artifact = verifyPolicyRotationAuthorityArtifactV1(installed.signed_artifact);
  if (artifact.tenant_id !== binding.tenantId) fail("policy_rotation_tenant_mismatch");
  const payload = artifact.payload;
  const current = await readHead(binding.tenantId, payload.authority_subject_sha256);
  if (!current || current.head.head_revision !== expectedRevision
    || current.head.head_sha256 !== expectedSha) {
    throw dependencies.headConflict(
      expectedRevision,
      current?.head.head_revision ?? null,
      expectedSha,
      current?.head.head_sha256 ?? null,
    );
  }
  if (current.head.source_operation.scope !== binding.scope) {
    fail("policy_rotation_scope_mismatch");
  }
  const at = database.mintAuthorityTime(current.head.updated_at);
  await assertContinuationRuntimeV1CohortHeadMutationAllowed(
    database,
    artifactStore,
    {
    tenant_id: binding.tenantId,
    authority_subject_sha256: payload.authority_subject_sha256,
    control_ref: current.head.target,
    at,
    },
  );
  if (artifact.valid_from > at || (artifact.expires_at !== null && at >= artifact.expires_at)
    || canonicalContinuationJson(payload.previous_authoritative_ref)
      !== canonicalContinuationJson(current.head.target)
    || canonicalContinuationJson(payload.old_compiler_policy_ref)
      !== canonicalContinuationJson(current.target.manifest.compiler_policy_ref)
    || canonicalContinuationJson(payload.old_evidence_policy_ref)
      !== canonicalContinuationJson(current.target.manifest.evidence_policy_ref)
    || payload.previous_binding_set_sha256
      !== authorityBranchBindingSetSha256V1(current.target.manifest.capsule_bindings)) {
    fail("policy_rotation_payload_mismatch");
  }
  const newCompilerCapability = await policyAuthority.resolveExact({
    tenant_id: binding.tenantId,
    authority_subject_sha256: payload.authority_subject_sha256,
    artifact_kind: "compiler_policy",
    artifact_ref: payload.new_compiler_policy_ref,
    at,
  });
  const newCompilerPolicy = policyAuthority.ref(newCompilerCapability);
  if (current.target.manifest.capsule_bindings.length
    > policyAuthority.payload(newCompilerCapability).learning_candidate_limit) {
    fail("policy_rotation_learning_capacity_exceeded");
  }
  const newEvidencePolicy = policyAuthority.ref(await policyAuthority.resolveExact({
    tenant_id: binding.tenantId,
    authority_subject_sha256: payload.authority_subject_sha256,
    artifact_kind: "evidence_policy",
    artifact_ref: payload.new_evidence_policy_ref,
    at,
  }));
  const lineage = continuationRuntimeV1OperationLineage(binding);
  const manifest = buildAuthorityBranchManifestV1({
    tenant_id: binding.tenantId,
    authority_subject_sha256: payload.authority_subject_sha256,
    branch_id: current.head.target.branch_id,
    branch_revision: current.head.target.branch_revision + 1,
    branch_kind: "authoritative",
    state: "authoritative",
    base_authoritative_ref: null,
    previous_revision_ref: current.head.target,
    capsule_bindings: current.target.manifest.capsule_bindings,
    compiler_policy_ref: newCompilerPolicy,
    evidence_policy_ref: newEvidencePolicy,
    effect_certificate_sha256: null,
    reverts_authority_ref: null,
    policy_rotation_artifact_ref: rotationRef,
    trusted_observation_admission_ref: null,
    created_at: at,
  });
  assertWritableAuthorityBindingsV1(
    database,
    manifest,
    binding.scope,
    null,
    at,
    "policy_rotation",
  );
  insertAuthorityBranchV1(database, lineage, manifest);
  const head = buildAuthorityHeadV1(binding.tenantId,
    payload.authority_subject_sha256, current.head.head_revision + 1,
    manifest, lineage, at);
  if (!updateAuthorityHeadV1(database, head, expectedRevision, expectedSha)) {
    throw dependencies.headConflict(expectedRevision, null, expectedSha, null);
  }
  const persisted = await readHead(
    binding.tenantId,
    payload.authority_subject_sha256,
    lineage,
  );
  if (!persisted || persisted.head.head_sha256 !== head.head_sha256
    || persisted.target.manifest.manifest_sha256 !== manifest.manifest_sha256) {
    fail("policy_rotation_postwrite_mismatch");
  }
  return canonicalContinuationClone({
    revision: persisted.target,
    head: persisted.head,
    head_advanced: true,
  });
}
