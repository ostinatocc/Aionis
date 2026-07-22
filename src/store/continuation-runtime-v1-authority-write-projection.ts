import type {
  AuthorityBranchCapsuleBindingV1,
  AuthorityBranchManifestV1,
  AuthoritativeBranchRevisionRefV1,
} from "../continuation/authority-branch.js";
import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
} from "../continuation/contract.js";
import { assertExecutionCapsuleV1 } from "../continuation/validation.js";
import type { AuthorityHeadV1 } from "./continuation-runtime-v1-authority-types.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import type { ContinuationRuntimeV1OperationLineageV1 } from
  "./continuation-runtime-v1-operation-store.js";

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_authority_${code}`);
}

/**
 * A binding's admission_authority is immutable source/evidence provenance and
 * remains a compiler scoring input. Promotion changes branch authority, never
 * this field: otherwise the authoritative successor would not represent the
 * exact candidate behavior measured by its effect certificate.
 */
export type ValidatedAuthorityBindingCauseV1 =
  | "genesis"
  | "candidate"
  | "effect"
  | "revert"
  | "policy_rotation";

function assertCauseMatchesManifest(
  manifest: AuthorityBranchManifestV1,
  cause: ValidatedAuthorityBindingCauseV1,
): void {
  const matches = cause === "candidate"
    ? manifest.branch_kind === "candidate"
    : cause === "genesis"
      ? manifest.branch_kind === "authoritative" && manifest.branch_revision === 1
      : cause === "effect"
        ? manifest.branch_kind === "authoritative"
          && manifest.branch_revision > 1
          && manifest.effect_certificate_sha256 !== null
        : cause === "revert"
          ? manifest.branch_kind === "authoritative"
            && manifest.branch_revision > 1
            && manifest.reverts_authority_ref !== null
          : cause === "policy_rotation"
            ? manifest.branch_kind === "authoritative"
              && manifest.branch_revision > 1
              && manifest.policy_rotation_artifact_ref !== null
            : false;
  if (!matches) fail("validated_binding_cause_mismatch");
}

function branchRef(manifest: AuthorityBranchManifestV1) {
  return canonicalContinuationClone({
    branch_id: manifest.branch_id,
    branch_revision: manifest.branch_revision,
    manifest_sha256: manifest.manifest_sha256,
    branch_kind: manifest.branch_kind,
    state: manifest.state,
  });
}

function authoritativeRef(
  manifest: AuthorityBranchManifestV1,
): AuthoritativeBranchRevisionRefV1 {
  if (manifest.branch_kind !== "authoritative" || manifest.state !== "authoritative") {
    fail("corrupt:authoritative_ref_kind");
  }
  return branchRef(manifest) as AuthoritativeBranchRevisionRefV1;
}

function bindingDigest(
  manifest: AuthorityBranchManifestV1,
  binding: AuthorityBranchCapsuleBindingV1,
) {
  return canonicalContinuationSha256({
    schema_version: "authority_branch_capsule_binding_v1",
    tenant_id: manifest.tenant_id,
    authority_subject_sha256: manifest.authority_subject_sha256,
    branch: branchRef(manifest),
    binding,
    created_at: manifest.created_at,
  });
}

function headBody(head: Omit<AuthorityHeadV1, "head_sha256">) {
  return {
    schema_version: head.schema_version,
    tenant_id: head.tenant_id,
    authority_subject_sha256: head.authority_subject_sha256,
    head_revision: head.head_revision,
    target: head.target,
    source_operation: head.source_operation,
    updated_at: head.updated_at,
  };
}

export function assertWritableAuthorityBindingsV1(
  database: ContinuationRuntimeV1Database,
  manifest: AuthorityBranchManifestV1,
  scope: string,
  taskFamily: string | null,
  at: string,
  validatedCause: ValidatedAuthorityBindingCauseV1,
  bindingsToValidate: readonly AuthorityBranchCapsuleBindingV1[] =
    manifest.capsule_bindings,
): void {
  assertCauseMatchesManifest(manifest, validatedCause);
  const manifestBindings = new Set(manifest.capsule_bindings.map(
    (binding) => canonicalContinuationJson(binding),
  ));
  for (const binding of bindingsToValidate) {
    if (!manifestBindings.has(canonicalContinuationJson(binding))) {
      fail("validated_binding_not_in_manifest");
    }
    if (binding.capsule_scope !== scope) fail("capsule_scope_mismatch");
    const row = database.db.prepare(`SELECT capsule.capsule_json,
        item.authority, item.lifecycle, item.hydrated, item.expires_at
      FROM capsule_revisions AS capsule
      LEFT JOIN memory_items AS item
        ON item.tenant_id = capsule.tenant_id
       AND item.scope = capsule.scope
       AND item.memory_id = capsule.memory_id
      WHERE capsule.tenant_id = ? AND capsule.scope = ?
        AND capsule.capsule_id = ? AND capsule.capsule_revision = ?
        AND capsule.capsule_sha256 = ?`).get(
      manifest.tenant_id,
      binding.capsule_scope,
      binding.capsule.capsule_id,
      binding.capsule.capsule_revision,
      binding.capsule.capsule_sha256,
    ) as Readonly<Record<string, unknown>> | undefined;
    if (!row || typeof row.capsule_json !== "string") fail("capsule_ref_missing");
    const capsule: unknown = JSON.parse(row.capsule_json);
    assertExecutionCapsuleV1(capsule);
    if ((capsule.kind !== "procedure" && capsule.kind !== "counter_evidence")
      || capsule.applicability.tenant_id !== manifest.tenant_id
      || capsule.applicability.scope !== scope
      || (taskFamily !== null && capsule.applicability.task_family !== taskFamily)
      || row.authority !== binding.admission_authority
      || row.lifecycle !== "active"
      || (binding.disposition === "include" && row.hydrated !== 1)
      || (row.expires_at !== null && (typeof row.expires_at !== "string" || at >= row.expires_at))
      || (capsule.expires_at !== null && at >= capsule.expires_at)) {
      fail("capsule_not_admissible");
    }
    if (manifest.branch_kind === "authoritative"
      && binding.disposition === "include"
      && binding.admission_authority !== "authoritative"
      && validatedCause !== "effect"
      && validatedCause !== "revert"
      && validatedCause !== "policy_rotation") {
      fail("authoritative_include_requires_authoritative_capsule");
    }
  }
}

export function insertAuthorityBranchV1(
  database: ContinuationRuntimeV1Database,
  source: ContinuationRuntimeV1OperationLineageV1,
  manifest: AuthorityBranchManifestV1,
): void {
  const base = manifest.base_authoritative_ref;
  const previous = manifest.previous_revision_ref;
  const revert = manifest.reverts_authority_ref;
  const rotation = manifest.policy_rotation_artifact_ref;
  const admission = manifest.trusted_observation_admission_ref;
  const values: readonly unknown[] = [
    manifest.tenant_id,
    source.scope,
    source.operation_kind,
    source.operation_id,
    source.request_sha256,
    manifest.authority_subject_sha256,
    manifest.branch_id,
    manifest.branch_revision,
    manifest.manifest_sha256,
    manifest.branch_kind,
    manifest.state,
    base?.branch_id ?? null,
    base?.branch_revision ?? null,
    base?.manifest_sha256 ?? null,
    base?.branch_kind ?? null,
    base?.state ?? null,
    previous?.branch_revision ?? null,
    previous?.manifest_sha256 ?? null,
    manifest.compiler_policy_ref.artifact_sha256,
    manifest.compiler_policy_ref.payload_sha256,
    "compiler_policy",
    manifest.evidence_policy_ref.artifact_sha256,
    manifest.evidence_policy_ref.payload_sha256,
    "evidence_policy",
    rotation?.artifact_sha256 ?? null,
    rotation?.payload_sha256 ?? null,
    rotation === null ? null : "policy_rotation",
    manifest.effect_certificate_sha256,
    revert?.branch_id ?? null,
    revert?.branch_revision ?? null,
    revert?.manifest_sha256 ?? null,
    revert?.branch_kind ?? null,
    revert?.state ?? null,
    admission?.observation_snapshot_ref.world_snapshot_id ?? null,
    admission?.observation_snapshot_ref.world_snapshot_sha256 ?? null,
    admission?.observation_snapshot_ref.host_task_envelope_sha256 ?? null,
    admission?.memory_revision_ref.revision ?? null,
    admission?.memory_revision_ref.commit_id ?? null,
    admission?.memory_revision_ref.commit_sha256 ?? null,
    admission?.memory_revision_ref.mutation_sha256 ?? null,
    admission?.memory_revision_ref.head_sha256 ?? null,
    admission?.memory_revision_ref.item_count ?? null,
    admission?.memory_revision_ref.item_set_sha256 ?? null,
    admission?.memory_revision_ref.relation_count ?? null,
    admission?.memory_revision_ref.relation_set_sha256 ?? null,
    admission?.memory_revision_ref.capsule_count ?? null,
    admission?.memory_revision_ref.capsule_set_sha256 ?? null,
    canonicalContinuationJson(manifest),
    manifest.created_at,
  ];
  database.db.prepare(`INSERT INTO branch_revisions(
    tenant_id, source_operation_scope, source_operation_kind,
    source_operation_id, source_request_sha256, authority_subject_sha256,
    branch_id, branch_revision, manifest_sha256, branch_kind, state,
    base_branch_id, base_branch_revision, base_manifest_sha256,
    base_branch_kind, base_branch_state, previous_branch_revision,
    previous_revision_sha256, compiler_policy_artifact_sha256,
    compiler_policy_payload_sha256, compiler_policy_kind,
    evidence_policy_artifact_sha256, evidence_policy_payload_sha256,
    evidence_policy_kind, policy_rotation_artifact_sha256,
    policy_rotation_payload_sha256, policy_rotation_artifact_kind,
    effect_certificate_sha256, reverts_branch_id,
    reverts_branch_revision, reverts_authority_revision_sha256,
    reverts_branch_kind, reverts_branch_state,
    admission_world_snapshot_id, admission_world_snapshot_sha256,
    admission_host_task_envelope_sha256, admission_memory_revision,
    admission_memory_commit_id, admission_memory_commit_sha256,
    admission_memory_mutation_sha256, admission_memory_head_sha256,
    admission_item_count, admission_item_set_sha256,
    admission_relation_count, admission_relation_set_sha256,
    admission_capsule_count, admission_capsule_set_sha256,
    manifest_json, created_at
  ) VALUES (${values.map(() => "?").join(", ")})`).run(...values);
  const statement = database.db.prepare(`INSERT INTO branch_capsule_bindings(
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    branch_manifest_sha256, branch_kind, capsule_scope, capsule_id,
    capsule_revision, capsule_sha256, disposition, admission_authority,
    binding_sha256, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const binding of manifest.capsule_bindings) {
    statement.run(
      manifest.tenant_id,
      manifest.authority_subject_sha256,
      manifest.branch_id,
      manifest.branch_revision,
      manifest.manifest_sha256,
      manifest.branch_kind,
      binding.capsule_scope,
      binding.capsule.capsule_id,
      binding.capsule.capsule_revision,
      binding.capsule.capsule_sha256,
      binding.disposition,
      binding.admission_authority,
      bindingDigest(manifest, binding),
      manifest.created_at,
    );
  }
}

export function buildAuthorityHeadV1(
  tenantId: string,
  subject: string,
  headRevision: number,
  target: AuthorityBranchManifestV1,
  source: ContinuationRuntimeV1OperationLineageV1,
  updatedAt: string,
): AuthorityHeadV1 {
  const without: Omit<AuthorityHeadV1, "head_sha256"> = {
    schema_version: "authority_head_v1",
    tenant_id: tenantId,
    authority_subject_sha256: subject,
    head_revision: headRevision,
    target: authoritativeRef(target),
    source_operation: source,
    updated_at: updatedAt,
  };
  return canonicalContinuationClone({
    ...without,
    head_sha256: canonicalContinuationSha256(headBody(without)),
  });
}

export function insertAuthorityHeadV1(
  database: ContinuationRuntimeV1Database,
  head: AuthorityHeadV1,
): void {
  database.db.prepare(`INSERT INTO authority_heads(
    tenant_id, source_operation_scope, source_operation_kind,
    source_operation_id, source_request_sha256, authority_subject_sha256,
    head_revision, branch_id, branch_revision, manifest_sha256, branch_kind,
    branch_state, head_sha256, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authoritative',
    'authoritative', ?, ?)`).run(
    head.tenant_id,
    head.source_operation.scope,
    head.source_operation.operation_kind,
    head.source_operation.operation_id,
    head.source_operation.request_sha256,
    head.authority_subject_sha256,
    head.head_revision,
    head.target.branch_id,
    head.target.branch_revision,
    head.target.manifest_sha256,
    head.head_sha256,
    head.updated_at,
  );
}

export function updateAuthorityHeadV1(
  database: ContinuationRuntimeV1Database,
  head: AuthorityHeadV1,
  expectedRevision: number,
  expectedSha256: string,
): boolean {
  const result = database.db.prepare(`UPDATE authority_heads SET
    source_operation_scope = ?, source_operation_kind = ?,
    source_operation_id = ?, source_request_sha256 = ?, head_revision = ?,
    branch_id = ?, branch_revision = ?, manifest_sha256 = ?,
    branch_kind = 'authoritative', branch_state = 'authoritative',
    head_sha256 = ?, updated_at = ?
    WHERE tenant_id = ? AND authority_subject_sha256 = ?
      AND head_revision = ? AND head_sha256 = ?`).run(
    head.source_operation.scope,
    head.source_operation.operation_kind,
    head.source_operation.operation_id,
    head.source_operation.request_sha256,
    head.head_revision,
    head.target.branch_id,
    head.target.branch_revision,
    head.target.manifest_sha256,
    head.head_sha256,
    head.updated_at,
    head.tenant_id,
    head.authority_subject_sha256,
    expectedRevision,
    expectedSha256,
  );
  return Number((result as { changes?: number | bigint }).changes ?? 0) === 1;
}
