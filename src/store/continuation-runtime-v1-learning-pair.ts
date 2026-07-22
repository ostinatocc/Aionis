import type {
  AuthorityBranchCapsuleBindingV1,
} from "../continuation/authority-branch.js";
import {
  canonicalContinuationJson,
  type AuthorityBranchRefV1,
  type Sha256,
} from "../continuation/contract.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";

type BindingRow = Readonly<{
  capsule_scope: unknown;
  capsule_id: unknown;
  capsule_revision: unknown;
  capsule_sha256: unknown;
  disposition: unknown;
  admission_authority: unknown;
}>;

export type ContinuationRuntimeV1LearningPairMetrics = Readonly<{
  control_binding_count: number;
  candidate_binding_count: number;
  treatment_delta_count: number;
}>;

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_learning_pair_${code}`);
}

function binding(row: BindingRow): AuthorityBranchCapsuleBindingV1 {
  if (typeof row.capsule_scope !== "string"
    || typeof row.capsule_id !== "string"
    || !Number.isSafeInteger(row.capsule_revision)
    || (row.capsule_revision as number) < 1
    || typeof row.capsule_sha256 !== "string"
    || (row.disposition !== "include" && row.disposition !== "exclude"
      && row.disposition !== "prohibit")
    || (row.admission_authority !== "candidate"
      && row.admission_authority !== "authoritative")) {
    fail("binding_projection_corrupt");
  }
  return {
    capsule_scope: row.capsule_scope,
    capsule: {
      capsule_id: row.capsule_id,
      capsule_revision: row.capsule_revision as number,
      capsule_sha256: row.capsule_sha256 as Sha256,
    },
    disposition: row.disposition,
    admission_authority: row.admission_authority,
  };
}

function identity(value: AuthorityBranchCapsuleBindingV1): string {
  return canonicalContinuationJson([
    value.capsule_scope,
    value.capsule.capsule_id,
  ]);
}

function readBindings(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  authoritySubjectSha256: Sha256,
  ref: AuthorityBranchRefV1,
): readonly AuthorityBranchCapsuleBindingV1[] {
  const rows = database.db.prepare(`SELECT capsule_scope, capsule_id,
      capsule_revision, capsule_sha256, disposition, admission_authority
    FROM branch_capsule_bindings
    WHERE tenant_id = ? AND authority_subject_sha256 = ?
      AND branch_id = ? AND branch_revision = ?
      AND branch_manifest_sha256 = ?
    ORDER BY capsule_scope, capsule_id`).all(
    tenantId,
    authoritySubjectSha256,
    ref.branch_id,
    ref.branch_revision,
    ref.manifest_sha256,
  ) as BindingRow[];
  const parsed = rows.map(binding);
  const identities = new Set(parsed.map(identity));
  if (identities.size !== parsed.length) fail("duplicate_capsule_identity");
  return parsed;
}

export function continuationRuntimeV1LearningPairMetrics(
  database: ContinuationRuntimeV1Database,
  args: Readonly<{
    tenant_id: string;
    authority_subject_sha256: Sha256;
    control_ref: AuthorityBranchRefV1;
    candidate_ref: AuthorityBranchRefV1;
  }>,
): ContinuationRuntimeV1LearningPairMetrics {
  const control = readBindings(
    database,
    args.tenant_id,
    args.authority_subject_sha256,
    args.control_ref,
  );
  const candidate = readBindings(
    database,
    args.tenant_id,
    args.authority_subject_sha256,
    args.candidate_ref,
  );
  const controlByIdentity = new Map(control.map((value) => [identity(value), value]));
  const candidateByIdentity = new Map(candidate.map((value) => [identity(value), value]));
  const identities = new Set([
    ...controlByIdentity.keys(),
    ...candidateByIdentity.keys(),
  ]);
  let treatmentDeltaCount = 0;
  for (const key of identities) {
    if (canonicalContinuationJson(controlByIdentity.get(key) ?? null)
      !== canonicalContinuationJson(candidateByIdentity.get(key) ?? null)) {
      treatmentDeltaCount += 1;
    }
  }
  return Object.freeze({
    control_binding_count: control.length,
    candidate_binding_count: candidate.length,
    treatment_delta_count: treatmentDeltaCount,
  });
}
