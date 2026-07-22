import type {
  AuthorityBranchCapsuleBindingV1,
  AuthorityBranchManifestV1,
} from "../continuation/authority-branch.js";
import {
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  type Sha256,
} from "../continuation/contract.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  assertVerifiedAdmittedEffectCertificateCapabilityV1,
  projectVerifiedAdmittedEffectCertificateCapabilityV1,
  type ContinuationRuntimeV1EffectCertificateReader,
  type VerifiedAdmittedEffectCertificateProjectionV1,
} from "./continuation-runtime-v1-effect-certificate-reader.js";
import type {
  AuthorityBranchRevisionRecordV1,
  AuthorityHeadV1,
} from "./continuation-runtime-v1-authority-types.js";
import type { ValidatedAuthorityBindingCauseV1 } from
  "./continuation-runtime-v1-authority-write-projection.js";
import type { ContinuationRuntimeV1OperationLineageV1 } from
  "./continuation-runtime-v1-operation-store.js";

export type AuthorityDecisionCauseReaderV1 = (
  tenantId: string,
  authoritySubjectSha256: Sha256,
  branchId: string,
  revision: number,
  pending?: ContinuationRuntimeV1OperationLineageV1 | null,
) => Promise<AuthorityBranchRevisionRecordV1 | null>;

export type ValidateAuthorityDecisionCauseV1Args = Readonly<{
  database: ContinuationRuntimeV1Database;
  effectCertificateReader: ContinuationRuntimeV1EffectCertificateReader;
  manifest: AuthorityBranchManifestV1;
  current: Readonly<{
    head: AuthorityHeadV1;
    target: AuthorityBranchRevisionRecordV1;
  }>;
  pending: ContinuationRuntimeV1OperationLineageV1;
  readRevision: AuthorityDecisionCauseReaderV1;
}>;

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_authority_${code}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `authority ${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) fail(`${field}_invalid`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${field}_invalid`);
  }
  return value as number;
}

function equalBindings(
  left: readonly AuthorityBranchCapsuleBindingV1[],
  right: readonly AuthorityBranchCapsuleBindingV1[],
): boolean {
  return canonicalContinuationJson(left) === canonicalContinuationJson(right);
}

function promoteCandidateBindings(
  bindings: readonly AuthorityBranchCapsuleBindingV1[],
): readonly AuthorityBranchCapsuleBindingV1[] {
  return canonicalContinuationClone(bindings);
}

async function readAdmittedEffectCertificate(
  database: ContinuationRuntimeV1Database,
  effectCertificateReader: ContinuationRuntimeV1EffectCertificateReader,
  tenantId: string,
  authoritySubjectSha256: Sha256,
  digest: Sha256,
): Promise<VerifiedAdmittedEffectCertificateProjectionV1> {
  const result = await effectCertificateReader.read({
    tenant_id: tenantId,
    certificate_sha256: digest,
  });
  if (!result?.admitted_capability) fail("effect_certificate_not_admitted");
  assertVerifiedAdmittedEffectCertificateCapabilityV1(
    result.admitted_capability,
    database,
    {
      tenant_id: tenantId,
      authority_subject_sha256: authoritySubjectSha256,
      certificate_sha256: digest,
    },
  );
  return projectVerifiedAdmittedEffectCertificateCapabilityV1(
    result.admitted_capability,
    database,
  );
}

export async function validateContinuationRuntimeV1AuthorityDecisionCause(
  args: ValidateAuthorityDecisionCauseV1Args,
): Promise<ValidatedAuthorityBindingCauseV1> {
  const {
    database,
    effectCertificateReader,
    manifest,
    current,
    pending,
    readRevision,
  } = args;
  if (manifest.branch_kind === "candidate") {
    if (manifest.state !== "merged") {
      if (manifest.effect_certificate_sha256 !== null) {
        fail("candidate_effect_without_merge");
      }
      return "candidate";
    }
    const digest = manifest.effect_certificate_sha256;
    if (!digest || !manifest.previous_revision_ref || !manifest.base_authoritative_ref) {
      fail("candidate_merge_cause_missing");
    }
    const certificate = await readAdmittedEffectCertificate(
      database,
      effectCertificateReader,
      manifest.tenant_id,
      manifest.authority_subject_sha256,
      digest,
    );
    if (canonicalContinuationJson(certificate.control_branch_ref)
        !== canonicalContinuationJson(manifest.base_authoritative_ref)
      || canonicalContinuationJson(certificate.candidate_branch_ref)
        !== canonicalContinuationJson(manifest.previous_revision_ref)
      || canonicalContinuationJson(certificate.compiler_policy_ref)
        !== canonicalContinuationJson(manifest.compiler_policy_ref)
      || canonicalContinuationJson(certificate.evidence_policy_ref)
        !== canonicalContinuationJson(manifest.evidence_policy_ref)) {
      fail("candidate_merge_certificate_mismatch");
    }
    const previous = await readRevision(
      manifest.tenant_id,
      manifest.authority_subject_sha256,
      manifest.previous_revision_ref.branch_id,
      manifest.previous_revision_ref.branch_revision,
    );
    if (!previous
      || !equalBindings(previous.manifest.capsule_bindings, manifest.capsule_bindings)) {
      fail("candidate_merge_binding_mismatch");
    }
    return "candidate";
  }
  if (manifest.branch_revision === 1) return "genesis";
  if (manifest.reverts_authority_ref !== null) {
    const target = await readRevision(
      manifest.tenant_id,
      manifest.authority_subject_sha256,
      manifest.reverts_authority_ref.branch_id,
      manifest.reverts_authority_ref.branch_revision,
    );
    if (!target
      || !equalBindings(target.manifest.capsule_bindings, manifest.capsule_bindings)) {
      fail("revert_binding_mismatch");
    }
    return "revert";
  }
  const digest = manifest.effect_certificate_sha256;
  if (!digest) fail("authoritative_decision_cause_missing");
  const certificate = await readAdmittedEffectCertificate(
    database,
    effectCertificateReader,
    manifest.tenant_id,
    manifest.authority_subject_sha256,
    digest,
  );
  if (canonicalContinuationJson(certificate.control_branch_ref)
      !== canonicalContinuationJson(current.head.target)
    || canonicalContinuationJson(certificate.compiler_policy_ref)
      !== canonicalContinuationJson(manifest.compiler_policy_ref)
    || canonicalContinuationJson(certificate.evidence_policy_ref)
      !== canonicalContinuationJson(manifest.evidence_policy_ref)) {
    fail("authoritative_merge_certificate_mismatch");
  }
  const candidateRef = certificate.candidate_branch_ref;
  const rows = database.db.prepare(`SELECT branch_id, branch_revision
    FROM branch_revisions WHERE tenant_id = ? AND authority_subject_sha256 = ?
      AND branch_kind = 'candidate' AND state = 'merged'
      AND effect_certificate_sha256 = ?
      AND base_branch_id = ? AND base_branch_revision = ?
      AND base_manifest_sha256 = ?
      AND previous_branch_revision = ? AND previous_revision_sha256 = ?`).all(
    manifest.tenant_id,
    manifest.authority_subject_sha256,
    digest,
    current.head.target.branch_id,
    current.head.target.branch_revision,
    current.head.target.manifest_sha256,
    candidateRef.branch_revision,
    candidateRef.manifest_sha256,
  ) as Array<{ branch_id: unknown; branch_revision: unknown }>;
  if (rows.length !== 1) {
    fail("authoritative_merge_candidate_missing_or_ambiguous");
  }
  const merged = await readRevision(
    manifest.tenant_id,
    manifest.authority_subject_sha256,
    text(rows[0]!.branch_id, "merged_branch_id"),
    integer(rows[0]!.branch_revision, "merged_branch_revision"),
    pending,
  );
  if (!merged || merged.manifest.compiler_policy_ref.artifact_sha256
      !== manifest.compiler_policy_ref.artifact_sha256
    || merged.manifest.compiler_policy_ref.payload_sha256
      !== manifest.compiler_policy_ref.payload_sha256
    || merged.manifest.evidence_policy_ref.artifact_sha256
      !== manifest.evidence_policy_ref.artifact_sha256
    || merged.manifest.evidence_policy_ref.payload_sha256
      !== manifest.evidence_policy_ref.payload_sha256
    || !equalBindings(
      promoteCandidateBindings(merged.manifest.capsule_bindings),
      manifest.capsule_bindings,
    )) {
    fail("authoritative_merge_candidate_mismatch");
  }
  return "effect";
}
