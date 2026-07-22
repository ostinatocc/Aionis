import {
  buildAuthorityBranchManifestV1,
  verifyAuthorityBranchManifestV1,
  type AuthorityBranchCapsuleBindingV1,
  type AuthorityBranchManifestV1,
  type AuthorityBranchRevisionRefV1,
  type AuthoritativeBranchRevisionRefV1,
} from "../continuation/authority-branch.js";
import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  type Sha256,
} from "../continuation/contract.js";
import {
  authorityBranchBindingSetSha256V1,
  verifyPolicyRotationAuthorityArtifactV1,
} from "../continuation/policy-rotation.js";
import { assertExecutionCapsuleV1 } from "../continuation/validation.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  deriveContinuationRuntimeV1OperationResultV1,
} from "./continuation-runtime-v1-operation-result-derivation.js";
import {
  assertContinuationRuntimeV1OperationResultDeclaration,
} from "./continuation-runtime-v1-operation-result-support.js";
import type { ContinuationRuntimeV1AuthorityArtifactReader } from
  "./continuation-runtime-v1-authority-artifact-reader.js";
import {
  assertContinuationRuntimeV1EffectCertificateReader,
  type ContinuationRuntimeV1EffectCertificateReader,
} from "./continuation-runtime-v1-effect-certificate-reader.js";
import { validateContinuationRuntimeV1AuthorityDecisionCause } from
  "./continuation-runtime-v1-authority-decision-cause.js";
import {
  AUTHORITY_BINDING_SELECT_V1 as BINDING_SELECT,
  AUTHORITY_BRANCH_SELECT_V1 as BRANCH_SELECT,
  AUTHORITY_HEAD_SELECT_V1 as HEAD_SELECT,
} from "./continuation-runtime-v1-authority-read-sql.js";
import {
  ContinuationRuntimeV1AuthorityHeadConflictError,
  type AppendAuthorityDecisionV1Result,
  type AuthorityBranchRevisionRecordV1,
  type AuthorityHeadV1,
  type ContinuationRuntimeV1AuthorityStore,
  type ContinuationRuntimeV1AuthorityStoreOptions,
  type CreateIsolatedCandidateDraftV1Args,
  type EnsureAuthorityGenesisV1Result,
  type ReadAuthorityBranchRevisionV1Args,
  type ReadAuthorityHeadV1Args,
  type ReadLatestAuthorityBranchRevisionV1Args,
  type RotateAuthorityPoliciesV1Args,
} from "./continuation-runtime-v1-authority-types.js";
import { createContinuationRuntimeV1AuthorityWorkflows } from
  "./continuation-runtime-v1-authority-workflows.js";
import {
  authorityHeadUsesPendingOperationV1,
  capsuleForAuthorityBindingV1,
  deriveTrustedObservationAuthorityMutationV1,
  isolatedCandidateAuthorityBranchIdV1,
  LEARNING_AUTHORITY_CAPSULE_KINDS_V1,
  replaceAuthorityBindingsForMemoryKindsV1,
} from "./continuation-runtime-v1-trusted-observation-authority.js";
import {
  assertContinuationRuntimeV1PolicyAuthority,
  type ContinuationRuntimeV1PolicyAuthority,
} from "./continuation-runtime-v1-policy-authority.js";
import {
  assertWritableAuthorityBindingsV1,
  buildAuthorityHeadV1,
  insertAuthorityBranchV1,
  insertAuthorityHeadV1,
  nextAuthorityTimeV1,
} from "./continuation-runtime-v1-authority-write-projection.js";
import { rotateContinuationRuntimeV1Policies } from
  "./continuation-runtime-v1-policy-rotation-store.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  continuationRuntimeV1OperationLineage,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";
export { ContinuationRuntimeV1AuthorityHeadConflictError } from
  "./continuation-runtime-v1-authority-types.js";
export type {
  AppendAuthorityDecisionV1Result,
  AuthorityBranchRevisionRecordV1, AuthorityHeadV1,
  ContinuationRuntimeV1AuthorityStore, ContinuationRuntimeV1AuthorityStoreOptions,
  EnsureAuthorityGenesisV1Result,
  ReadAuthorityBranchRevisionV1Args, ReadAuthorityHeadV1Args,
  ReadLatestAuthorityBranchRevisionV1Args,
  CreateIsolatedCandidateDraftV1Args,
  RotateAuthorityPoliciesV1Args,
} from "./continuation-runtime-v1-authority-types.js";
type BranchRow = Readonly<Record<string, unknown>>;
type BindingRow = Readonly<Record<string, unknown>>;
type HeadRow = Readonly<Record<string, unknown>>;
type BranchBundle = Readonly<{
  row: BranchRow;
  bindings: readonly BindingRow[];
}>;
const AUTHORITY_AUTHORITATIVE_MUTATION_CONTEXTS = new WeakSet<object>();
const AUTHORITY_CANDIDATE_MUTATION_CONTEXTS = new WeakSet<object>();
const AUTHORITY_OPERATOR_MUTATION_CONTEXTS = new WeakSet<object>();
const AUTHORITY_STORES = new WeakMap<object, Readonly<{
  database: ContinuationRuntimeV1Database;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
  effectCertificateReader: ContinuationRuntimeV1EffectCertificateReader;
}>>();

export function assertContinuationRuntimeV1AuthorityStore(
  value: unknown,
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
  effectCertificateReader: ContinuationRuntimeV1EffectCertificateReader,
): asserts value is ContinuationRuntimeV1AuthorityStore {
  if (value === null || typeof value !== "object") fail("store_invalid");
  const record = AUTHORITY_STORES.get(value);
  if (!record || record.database !== database
    || record.artifactStore !== artifactStore
    || record.policyAuthority !== policyAuthority
    || record.effectCertificateReader !== effectCertificateReader) {
    fail("store_invalid");
  }
}

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
    || expectedKeys.some((key) => !actual.includes(key))) {
    fail(`${field}_shape_invalid`);
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    assertUnicodeScalarString(key, `authority ${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape_invalid`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function text(value: unknown, field: string, maxBytes = 256): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `authority ${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) fail(`${field}_invalid`);
  return value;
}

function sha(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertSha256(value, `authority ${field}`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${field}_invalid`);
  return value as number;
}

function time(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertCanonicalUtcMillis(value, `authority ${field}`);
  return value;
}

function parseCanonicalObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") fail(`corrupt:${field}_type`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(`corrupt:${field}_parse`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || canonicalContinuationJson(parsed) !== value) fail(`corrupt:${field}_noncanonical`);
  return parsed as Readonly<Record<string, unknown>>;
}

function sourceOperation(
  database: ContinuationRuntimeV1Database,
  row: Readonly<Record<string, unknown>>,
  pending: ContinuationRuntimeV1OperationLineageV1 | null,
): ContinuationRuntimeV1OperationLineageV1 {
  const operationKind = row.source_operation_kind;
  if (operationKind !== "record_observations"
    && operationKind !== "authority_decision"
    && operationKind !== "worker_completion") {
    fail("corrupt:source_operation_kind");
  }
  const tuple = {
    tenant_id: text(row.tenant_id, "persisted_tenant_id"),
    scope: text(row.source_operation_scope, "persisted_source_operation_scope"),
    operation_kind: operationKind,
    operation_id: text(row.source_operation_id, "persisted_source_operation_id"),
    request_sha256: sha(row.source_request_sha256, "persisted_source_request_sha256"),
  } as const;
  const expectedActor = operationKind === "record_observations"
    ? "trusted_host"
    : operationKind === "authority_decision" ? "operator" : "worker";
  let lineage: ContinuationRuntimeV1OperationLineageV1;
  if (row.source_actor_kind === null || row.source_actor_kind === undefined) {
    if (pending === null) fail("corrupt:source_operation_missing");
    lineage = pending;
  } else {
    if (row.source_actor_kind !== expectedActor) fail("corrupt:source_actor_kind");
    const receipt = exactRecord(
      parseCanonicalObject(row.source_receipt_json, "source_receipt_json"),
      [
        "actor_kind", "actor_principal_sha256", "completed_at", "operation_id",
        "operation_kind", "request_sha256", "result", "schema_version", "scope",
        "tenant_id",
      ],
      "persisted_source_receipt",
    );
    const receiptSha256 = sha(row.source_receipt_sha256, "persisted_source_receipt_sha256");
    const completedAt = time(row.source_completed_at, "persisted_source_completed_at");
    const actorPrincipalSha256 = sha(
      row.source_actor_principal_sha256,
      "persisted_source_actor_principal_sha256",
    );
    if (receipt.schema_version !== "continuation_runtime_operation_receipt_v1"
      || receipt.tenant_id !== tuple.tenant_id
      || receipt.scope !== tuple.scope
      || receipt.operation_kind !== tuple.operation_kind
      || receipt.operation_id !== tuple.operation_id
      || receipt.request_sha256 !== tuple.request_sha256
      || receipt.actor_kind !== expectedActor
      || receipt.actor_principal_sha256 !== actorPrincipalSha256
      || receipt.completed_at !== completedAt
      || canonicalContinuationSha256(receipt) !== receiptSha256) {
      fail("corrupt:source_operation_receipt");
    }
    try {
      const derived = deriveContinuationRuntimeV1OperationResultV1(database, {
        tenantId: tuple.tenant_id,
        scope: tuple.scope,
        operationKind: tuple.operation_kind,
        operationId: tuple.operation_id,
        requestSha256: tuple.request_sha256,
        actorKind: expectedActor,
        actorPrincipalSha256,
      }, "replay", receipt.result);
      assertContinuationRuntimeV1OperationResultDeclaration(receipt.result, derived);
    } catch (error) {
      throw new Error(
        "continuation_runtime_v1_authority_corrupt:source_operation_result",
        { cause: error },
      );
    }
    lineage = {
      ...tuple,
      actor_kind: expectedActor,
      actor_principal_sha256: actorPrincipalSha256,
    };
  }
  const comparable = {
    tenant_id: lineage.tenant_id,
    scope: lineage.scope,
    operation_kind: lineage.operation_kind,
    operation_id: lineage.operation_id,
    request_sha256: lineage.request_sha256,
  };
  if (canonicalContinuationJson(comparable) !== canonicalContinuationJson(tuple)
    || lineage.actor_kind !== expectedActor
    || (pending !== null
      && canonicalContinuationJson(lineage) !== canonicalContinuationJson(pending))) {
    fail("corrupt:source_operation_binding");
  }
  sha(lineage.actor_principal_sha256, "source_actor_principal_sha256");
  return canonicalContinuationClone(lineage);
}

function branchRef(manifest: AuthorityBranchManifestV1): AuthorityBranchRevisionRefV1 {
  return canonicalContinuationClone({
    branch_id: manifest.branch_id,
    branch_revision: manifest.branch_revision,
    manifest_sha256: manifest.manifest_sha256,
    branch_kind: manifest.branch_kind,
    state: manifest.state,
  });
}

function authoritativeRef(manifest: AuthorityBranchManifestV1): AuthoritativeBranchRevisionRefV1 {
  if (manifest.branch_kind !== "authoritative" || manifest.state !== "authoritative") {
    fail("corrupt:authoritative_ref_kind");
  }
  return branchRef(manifest) as AuthoritativeBranchRevisionRefV1;
}

function bindingDigest(
  manifest: AuthorityBranchManifestV1,
  binding: AuthorityBranchCapsuleBindingV1,
): Sha256 {
  return canonicalContinuationSha256({
    schema_version: "authority_branch_capsule_binding_v1",
    tenant_id: manifest.tenant_id,
    authority_subject_sha256: manifest.authority_subject_sha256,
    branch: branchRef(manifest),
    binding,
    created_at: manifest.created_at,
  });
}

function headBody(head: Omit<AuthorityHeadV1, "head_sha256">): Readonly<Record<string, unknown>> {
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

function deterministicGenesisBranchId(
  tenantId: string,
  authoritySubjectSha256: Sha256,
): string {
  const digest = canonicalContinuationSha256({
    schema_version: "authority_genesis_branch_id_v1",
    tenant_id: tenantId,
    authority_subject_sha256: authoritySubjectSha256,
  });
  return `authority-${digest}`;
}

function queryBranchBundleSync(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  subject: string,
  branchId: string,
  revision: number,
): BranchBundle | null {
  const row = database.db.prepare(`${BRANCH_SELECT}
    WHERE branch.tenant_id = ? AND branch.authority_subject_sha256 = ?
      AND branch.branch_id = ? AND branch.branch_revision = ?`).get(
    tenantId,
    subject,
    branchId,
    revision,
  ) as BranchRow | undefined;
  if (!row) return null;
  const bindings = database.db.prepare(`${BINDING_SELECT}
    WHERE binding.tenant_id = ? AND binding.authority_subject_sha256 = ?
      AND binding.branch_id = ? AND binding.branch_revision = ?
    ORDER BY binding.capsule_scope, binding.capsule_id,
      binding.capsule_revision`).all(
    tenantId,
    subject,
    branchId,
    revision,
  ) as BindingRow[];
  return { row, bindings };
}

function assertReferenceRowSync(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  subject: string,
  ref: AuthorityBranchRevisionRefV1,
  field: string,
): void {
  const row = database.db.prepare(`SELECT manifest_json, manifest_sha256,
      branch_kind, state FROM branch_revisions
    WHERE tenant_id = ? AND authority_subject_sha256 = ?
      AND branch_id = ? AND branch_revision = ?`).get(
    tenantId,
    subject,
    ref.branch_id,
    ref.branch_revision,
  ) as Readonly<Record<string, unknown>> | undefined;
  if (!row) fail(`${field}_missing`);
  const manifest = verifyAuthorityBranchManifestV1(
    parseCanonicalObject(row.manifest_json, `${field}_manifest_json`),
  );
  if (manifest.tenant_id !== tenantId
    || manifest.authority_subject_sha256 !== subject
    || manifest.branch_id !== ref.branch_id
    || manifest.branch_revision !== ref.branch_revision
    || manifest.manifest_sha256 !== ref.manifest_sha256
    || row.manifest_sha256 !== ref.manifest_sha256
    || manifest.branch_kind !== ref.branch_kind
    || row.branch_kind !== ref.branch_kind
    || manifest.state !== ref.state
    || row.state !== ref.state) fail(`${field}_mismatch`);
}

function verifyBindingRows(
  manifest: AuthorityBranchManifestV1,
  rows: readonly BindingRow[],
): void {
  if (rows.length !== manifest.capsule_bindings.length) {
    fail("corrupt:binding_cardinality");
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const expected = manifest.capsule_bindings[index]!;
    const persisted: AuthorityBranchCapsuleBindingV1 = {
      capsule_scope: text(row.capsule_scope, "persisted_capsule_scope"),
      capsule: {
        capsule_id: text(row.capsule_id, "persisted_capsule_id"),
        capsule_revision: integer(row.capsule_revision, "persisted_capsule_revision"),
        capsule_sha256: sha(row.capsule_sha256, "persisted_capsule_sha256"),
      },
      disposition: row.disposition as AuthorityBranchCapsuleBindingV1["disposition"],
      admission_authority: row.admission_authority as
        AuthorityBranchCapsuleBindingV1["admission_authority"],
    };
    if (!(["include", "exclude", "prohibit"] as const).includes(persisted.disposition)
      || !(["candidate", "authoritative"] as const)
        .includes(persisted.admission_authority)
      || canonicalContinuationJson(persisted) !== canonicalContinuationJson(expected)
      || row.tenant_id !== manifest.tenant_id
      || row.authority_subject_sha256 !== manifest.authority_subject_sha256
      || row.branch_id !== manifest.branch_id
      || row.branch_revision !== manifest.branch_revision
      || row.branch_manifest_sha256 !== manifest.manifest_sha256
      || row.branch_kind !== manifest.branch_kind
      || row.created_at !== manifest.created_at
      || row.binding_sha256 !== bindingDigest(manifest, persisted)) {
      fail("corrupt:binding_projection");
    }
    if (typeof row.capsule_json !== "string"
      || canonicalContinuationJson(JSON.parse(row.capsule_json)) !== row.capsule_json) {
      fail("corrupt:binding_capsule_missing");
    }
    const capsule: unknown = JSON.parse(row.capsule_json);
    assertExecutionCapsuleV1(capsule);
    if ((capsule.kind !== "procedure" && capsule.kind !== "counter_evidence")
      || capsule.applicability.tenant_id !== manifest.tenant_id
      || capsule.applicability.scope !== persisted.capsule_scope
      || capsule.capsule_id !== persisted.capsule.capsule_id
      || capsule.capsule_revision !== persisted.capsule.capsule_revision
      || capsule.capsule_sha256 !== persisted.capsule.capsule_sha256
      || row.persisted_capsule_sha256 !== persisted.capsule.capsule_sha256
      || canonicalSha256Without(
        capsule as unknown as Readonly<Record<string, unknown>>,
        "capsule_sha256",
      ) !== capsule.capsule_sha256) fail("corrupt:binding_capsule_projection");
  }
}

function decodeBranchBundle(
  database: ContinuationRuntimeV1Database,
  bundle: BranchBundle,
  pending: ContinuationRuntimeV1OperationLineageV1 | null,
): AuthorityBranchRevisionRecordV1 {
  const row = bundle.row;
  const manifest = verifyAuthorityBranchManifestV1(
    parseCanonicalObject(row.manifest_json, "manifest_json"),
  );
  const source = sourceOperation(database, row, pending);
  if (source.operation_kind !== "record_observations"
    && source.operation_kind !== "authority_decision") {
    fail("corrupt:branch_source_operation_kind");
  }
  const base = manifest.base_authoritative_ref;
  const previous = manifest.previous_revision_ref;
  const revert = manifest.reverts_authority_ref;
  const admission = manifest.trusted_observation_admission_ref;
  if (row.tenant_id !== manifest.tenant_id
    || row.authority_subject_sha256 !== manifest.authority_subject_sha256
    || row.branch_id !== manifest.branch_id
    || row.branch_revision !== manifest.branch_revision
    || row.manifest_sha256 !== manifest.manifest_sha256
    || row.branch_kind !== manifest.branch_kind
    || row.state !== manifest.state
    || row.base_branch_id !== (base?.branch_id ?? null)
    || row.base_branch_revision !== (base?.branch_revision ?? null)
    || row.base_manifest_sha256 !== (base?.manifest_sha256 ?? null)
    || row.base_branch_kind !== (base?.branch_kind ?? null)
    || row.base_branch_state !== (base?.state ?? null)
    || row.previous_branch_revision !== (previous?.branch_revision ?? null)
    || row.previous_revision_sha256 !== (previous?.manifest_sha256 ?? null)
    || row.compiler_policy_artifact_sha256 !== manifest.compiler_policy_ref.artifact_sha256
    || row.compiler_policy_payload_sha256 !== manifest.compiler_policy_ref.payload_sha256
    || row.compiler_policy_kind !== "compiler_policy"
    || row.evidence_policy_artifact_sha256 !== manifest.evidence_policy_ref.artifact_sha256
    || row.evidence_policy_payload_sha256 !== manifest.evidence_policy_ref.payload_sha256
    || row.evidence_policy_kind !== "evidence_policy"
    || row.policy_rotation_artifact_sha256
      !== (manifest.policy_rotation_artifact_ref?.artifact_sha256 ?? null)
    || row.policy_rotation_payload_sha256
      !== (manifest.policy_rotation_artifact_ref?.payload_sha256 ?? null)
    || row.policy_rotation_artifact_kind
      !== (manifest.policy_rotation_artifact_ref === null ? null : "policy_rotation")
    || row.effect_certificate_sha256 !== manifest.effect_certificate_sha256
    || row.reverts_branch_id !== (revert?.branch_id ?? null)
    || row.reverts_branch_revision !== (revert?.branch_revision ?? null)
    || row.reverts_authority_revision_sha256 !== (revert?.manifest_sha256 ?? null)
    || row.reverts_branch_kind !== (revert?.branch_kind ?? null)
    || row.reverts_branch_state !== (revert?.state ?? null)
    || row.admission_world_snapshot_id
      !== (admission?.observation_snapshot_ref.world_snapshot_id ?? null)
    || row.admission_world_snapshot_sha256
      !== (admission?.observation_snapshot_ref.world_snapshot_sha256 ?? null)
    || row.admission_host_task_envelope_sha256
      !== (admission?.observation_snapshot_ref.host_task_envelope_sha256 ?? null)
    || row.admission_memory_revision
      !== (admission?.memory_revision_ref.revision ?? null)
    || row.admission_memory_commit_id
      !== (admission?.memory_revision_ref.commit_id ?? null)
    || row.admission_memory_commit_sha256
      !== (admission?.memory_revision_ref.commit_sha256 ?? null)
    || row.admission_memory_mutation_sha256
      !== (admission?.memory_revision_ref.mutation_sha256 ?? null)
    || row.admission_memory_head_sha256
      !== (admission?.memory_revision_ref.head_sha256 ?? null)
    || row.admission_item_count !== (admission?.memory_revision_ref.item_count ?? null)
    || row.admission_item_set_sha256
      !== (admission?.memory_revision_ref.item_set_sha256 ?? null)
    || row.admission_relation_count
      !== (admission?.memory_revision_ref.relation_count ?? null)
    || row.admission_relation_set_sha256
      !== (admission?.memory_revision_ref.relation_set_sha256 ?? null)
    || row.admission_capsule_count
      !== (admission?.memory_revision_ref.capsule_count ?? null)
    || row.admission_capsule_set_sha256
      !== (admission?.memory_revision_ref.capsule_set_sha256 ?? null)
    || row.created_at !== manifest.created_at) fail("corrupt:branch_projection");
  verifyBindingRows(manifest, bundle.bindings);
  if (base) assertReferenceRowSync(database, manifest.tenant_id,
    manifest.authority_subject_sha256, base, "base_ref");
  if (previous) assertReferenceRowSync(database, manifest.tenant_id,
    manifest.authority_subject_sha256, previous, "previous_ref");
  if (revert) assertReferenceRowSync(database, manifest.tenant_id,
    manifest.authority_subject_sha256, revert, "revert_ref");
  return canonicalContinuationClone({ manifest, source_operation: source });
}

async function fullyVerifyBranch(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
  bundle: BranchBundle,
  pending: ContinuationRuntimeV1OperationLineageV1 | null,
): Promise<AuthorityBranchRevisionRecordV1> {
  const record = decodeBranchBundle(database, bundle, pending);
  const admission = record.manifest.trusted_observation_admission_ref;
  if (admission !== null) {
    if (record.source_operation.operation_kind !== "record_observations") {
      fail("corrupt:trusted_observation_admission_source_kind");
    }
    const derived = deriveContinuationRuntimeV1OperationResultV1(
      database,
      {
        tenantId: record.source_operation.tenant_id,
        scope: record.source_operation.scope,
        operationKind: record.source_operation.operation_kind,
        operationId: record.source_operation.operation_id,
        requestSha256: record.source_operation.request_sha256,
        actorKind: record.source_operation.actor_kind,
        actorPrincipalSha256: record.source_operation.actor_principal_sha256,
      },
      pending === null ? "replay" : "before_receipt_insert",
    );
    if (derived.schema_version !== "record_observations_result_v1"
      || derived.memory_revision_ref === null
      || canonicalContinuationJson(admission)
        !== canonicalContinuationJson({
          schema_version: "trusted_observation_admission_ref_v1",
          observation_snapshot_ref: derived.observation_snapshot_ref,
          memory_revision_ref: derived.memory_revision_ref,
        })) {
      fail("corrupt:trusted_observation_admission_projection");
    }
  }
  const compilerPolicy = await policyAuthority.resolveExact({
    tenant_id: record.manifest.tenant_id,
    authority_subject_sha256: record.manifest.authority_subject_sha256,
    artifact_kind: "compiler_policy",
    artifact_ref: record.manifest.compiler_policy_ref,
    at: record.manifest.created_at,
  });
  if ((record.manifest.branch_kind === "authoritative"
      || record.manifest.state === "eligible"
      || record.manifest.state === "active_candidate"
      || record.manifest.state === "merged")
    && record.manifest.capsule_bindings.length
      > policyAuthority.payload(compilerPolicy).learning_candidate_limit) {
    fail("corrupt:learning_branch_capacity_exceeded");
  }
  await policyAuthority.resolveExact({
    tenant_id: record.manifest.tenant_id,
    authority_subject_sha256: record.manifest.authority_subject_sha256,
    artifact_kind: "evidence_policy",
    artifact_ref: record.manifest.evidence_policy_ref,
    at: record.manifest.created_at,
  });
  const rotationRef = record.manifest.policy_rotation_artifact_ref;
  if (rotationRef !== null) {
    const installed = await artifactStore.readByDigest({
      tenant_id: record.manifest.tenant_id,
      artifact_sha256: rotationRef.artifact_sha256,
    });
    if (!installed || installed.signed_artifact.payload_sha256 !== rotationRef.payload_sha256) {
      fail("corrupt:policy_rotation_artifact_ref");
    }
    const artifact = verifyPolicyRotationAuthorityArtifactV1(installed.signed_artifact);
    const payload = artifact.payload;
    const previousRef = record.manifest.previous_revision_ref;
    if (!previousRef || artifact.valid_from > record.manifest.created_at
      || (artifact.expires_at !== null && record.manifest.created_at >= artifact.expires_at)
      || payload.tenant_id !== record.manifest.tenant_id
      || payload.authority_subject_sha256 !== record.manifest.authority_subject_sha256
      || canonicalContinuationJson(payload.previous_authoritative_ref)
        !== canonicalContinuationJson(previousRef)) {
      fail("corrupt:policy_rotation_payload_binding");
    }
    const previousBundle = queryBranchBundleSync(
      database,
      record.manifest.tenant_id,
      record.manifest.authority_subject_sha256,
      previousRef.branch_id,
      previousRef.branch_revision,
    );
    if (!previousBundle) fail("corrupt:policy_rotation_previous_missing");
    const previous = decodeBranchBundle(database, previousBundle, null).manifest;
    await policyAuthority.resolveExact({
      tenant_id: previous.tenant_id,
      authority_subject_sha256: previous.authority_subject_sha256,
      artifact_kind: "compiler_policy",
      artifact_ref: payload.old_compiler_policy_ref,
      at: previous.created_at,
    });
    await policyAuthority.resolveExact({
      tenant_id: previous.tenant_id,
      authority_subject_sha256: previous.authority_subject_sha256,
      artifact_kind: "evidence_policy",
      artifact_ref: payload.old_evidence_policy_ref,
      at: previous.created_at,
    });
    if (canonicalContinuationJson(payload.old_compiler_policy_ref)
        !== canonicalContinuationJson(previous.compiler_policy_ref)
      || canonicalContinuationJson(payload.old_evidence_policy_ref)
        !== canonicalContinuationJson(previous.evidence_policy_ref)
      || canonicalContinuationJson(payload.new_compiler_policy_ref)
        !== canonicalContinuationJson(record.manifest.compiler_policy_ref)
      || canonicalContinuationJson(payload.new_evidence_policy_ref)
        !== canonicalContinuationJson(record.manifest.evidence_policy_ref)
      || payload.previous_binding_set_sha256
        !== authorityBranchBindingSetSha256V1(previous.capsule_bindings)
      || canonicalContinuationJson(previous.capsule_bindings)
        !== canonicalContinuationJson(record.manifest.capsule_bindings)) {
      fail("corrupt:policy_rotation_transition");
    }
  }
  return record;
}

function decodeHead(
  database: ContinuationRuntimeV1Database,
  row: HeadRow,
  target: AuthorityBranchRevisionRecordV1,
  pending: ContinuationRuntimeV1OperationLineageV1 | null,
): AuthorityHeadV1 {
  const source = sourceOperation(database, row, pending);
  const manifest = target.manifest;
  const resultWithoutDigest: Omit<AuthorityHeadV1, "head_sha256"> = {
    schema_version: "authority_head_v1",
    tenant_id: text(row.tenant_id, "persisted_head_tenant_id"),
    authority_subject_sha256: sha(
      row.authority_subject_sha256,
      "persisted_head_authority_subject_sha256",
    ),
    head_revision: integer(row.head_revision, "persisted_head_revision"),
    target: authoritativeRef(manifest),
    source_operation: source,
    updated_at: time(row.updated_at, "persisted_head_updated_at"),
  };
  const persistedDigest = sha(row.head_sha256, "persisted_head_sha256");
  if (row.branch_id !== manifest.branch_id
    || row.branch_revision !== manifest.branch_revision
    || row.manifest_sha256 !== manifest.manifest_sha256
    || row.branch_kind !== "authoritative"
    || row.branch_state !== "authoritative"
    || resultWithoutDigest.tenant_id !== manifest.tenant_id
    || resultWithoutDigest.authority_subject_sha256 !== manifest.authority_subject_sha256
    || resultWithoutDigest.head_revision !== manifest.branch_revision
    || resultWithoutDigest.updated_at < manifest.created_at
    || canonicalContinuationJson(source)
      !== canonicalContinuationJson(target.source_operation)
    || canonicalContinuationSha256(headBody(resultWithoutDigest)) !== persistedDigest) {
    fail("corrupt:head_projection");
  }
  return canonicalContinuationClone({ ...resultWithoutDigest, head_sha256: persistedDigest });
}

async function readRevisionInternal(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
  tenantId: string,
  subject: Sha256,
  branchId: string,
  revision: number,
  pending: ContinuationRuntimeV1OperationLineageV1 | null = null,
): Promise<AuthorityBranchRevisionRecordV1 | null> {
  const bundle = await database.read(() => queryBranchBundleSync(
    database,
    tenantId,
    subject,
    branchId,
    revision,
  ));
  return bundle
    ? fullyVerifyBranch(database, artifactStore, policyAuthority, bundle, pending)
    : null;
}

async function readHeadInternal(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
  tenantId: string,
  subject: Sha256,
  pending: ContinuationRuntimeV1OperationLineageV1 | null = null,
): Promise<Readonly<{ head: AuthorityHeadV1; target: AuthorityBranchRevisionRecordV1 }> | null> {
  const snapshot = await database.read(() => {
    const row = database.db.prepare(`${HEAD_SELECT}
      WHERE head.tenant_id = ? AND head.authority_subject_sha256 = ?`).get(
      tenantId,
      subject,
    ) as HeadRow | undefined;
    if (!row) return null;
    const branchId = text(row.branch_id, "persisted_head_branch_id");
    const revision = integer(row.branch_revision, "persisted_head_branch_revision");
    const bundle = queryBranchBundleSync(database, tenantId, subject, branchId, revision);
    if (!bundle) fail("corrupt:head_target_missing");
    return { row, bundle };
  });
  if (!snapshot) return null;
  const target = await fullyVerifyBranch(
    database,
    artifactStore,
    policyAuthority,
    snapshot.bundle,
    pending,
  );
  return canonicalContinuationClone({
    head: decodeHead(database, snapshot.row, target, pending),
    target,
  });
}

export function createContinuationRuntimeV1AuthorityStore(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
  effectCertificateReader: ContinuationRuntimeV1EffectCertificateReader,
  options: ContinuationRuntimeV1AuthorityStoreOptions = {},
): ContinuationRuntimeV1AuthorityStore {
  assertContinuationRuntimeV1PolicyAuthority(policyAuthority, database, artifactStore);
  assertContinuationRuntimeV1EffectCertificateReader(
    effectCertificateReader,
    database,
    artifactStore,
    policyAuthority,
  );
  const now = options.now ?? (() => new Date().toISOString());
  const workflows = createContinuationRuntimeV1AuthorityWorkflows({
    database,
    artifactStore,
    policyAuthority,
    now,
    claimOperatorContext(context) {
      if (AUTHORITY_OPERATOR_MUTATION_CONTEXTS.has(context)) {
        fail("operator_operation_context_already_used");
      }
      AUTHORITY_OPERATOR_MUTATION_CONTEXTS.add(context);
    },
    readHead: (tenantId, subject, pending = null) => readHeadInternal(
      database,
      artifactStore,
      policyAuthority,
      tenantId,
      subject,
      pending,
    ),
    readRevision: (tenantId, subject, branchId, revision, pending = null) =>
      readRevisionInternal(
        database,
        artifactStore,
        policyAuthority,
        tenantId,
        subject,
        branchId,
        revision,
        pending,
      ),
    validateCause: (manifest, current, pending) =>
      validateContinuationRuntimeV1AuthorityDecisionCause({
        database,
        effectCertificateReader,
        manifest,
        current,
        pending,
        readRevision: (tenantId, subject, branchId, revision, readPending = null) =>
          readRevisionInternal(
            database,
            artifactStore,
            policyAuthority,
            tenantId,
            subject,
            branchId,
            revision,
            readPending,
          ),
      }),
  });
  const store: ContinuationRuntimeV1AuthorityStore = Object.freeze({
    advanceCandidate: workflows.advanceCandidate,
    terminateCandidate: workflows.terminateCandidate,
    mergeCandidate: workflows.mergeCandidate,
    revertAuthority: workflows.revertAuthority,
    async ensureGenesis(
      context: ContinuationRuntimeV1AuthorityWriteContext,
    ): Promise<EnsureAuthorityGenesisV1Result> {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      if (binding.operationKind !== "record_observations" || binding.actorKind !== "trusted_host") {
        fail("genesis_operation_forbidden");
      }
      if (AUTHORITY_AUTHORITATIVE_MUTATION_CONTEXTS.has(context)) {
        fail("authoritative_operation_context_already_used");
      }
      AUTHORITY_AUTHORITATIVE_MUTATION_CONTEXTS.add(context);
      const mutation = deriveTrustedObservationAuthorityMutationV1(database, binding);
      const at = nextAuthorityTimeV1(now(), null);
      const subject = mutation.authoritySubjectSha256;
      const branchId = deterministicGenesisBranchId(binding.tenantId, subject);
      const lineage = continuationRuntimeV1OperationLineage(binding);
      const existing = await readHeadInternal(database, artifactStore, policyAuthority,
        binding.tenantId, subject);
      if (existing) {
        return canonicalContinuationClone({
          created: false,
          revision: existing.target,
          head: existing.head,
        });
      }
      const orphanCount = (database.db.prepare(`SELECT COUNT(*) AS count
        FROM branch_revisions WHERE tenant_id = ? AND authority_subject_sha256 = ?`).get(
        binding.tenantId,
        subject,
      ) as { count: number }).count;
      if (orphanCount !== 0) fail("corrupt:genesis_orphan_branch");
      const compilerPolicy = policyAuthority.ref(await policyAuthority.resolveCurrent({
        tenant_id: binding.tenantId,
        authority_subject_sha256: subject,
        artifact_kind: "compiler_policy",
        at,
      }));
      const evidencePolicy = policyAuthority.ref(await policyAuthority.resolveCurrent({
        tenant_id: binding.tenantId,
        authority_subject_sha256: subject,
        artifact_kind: "evidence_policy",
        at,
      }));
      const manifest = buildAuthorityBranchManifestV1({
        tenant_id: binding.tenantId,
        authority_subject_sha256: subject,
        branch_id: branchId,
        branch_revision: 1,
        branch_kind: "authoritative",
        state: "authoritative",
        base_authoritative_ref: null,
        previous_revision_ref: null,
        capsule_bindings: [],
        compiler_policy_ref: compilerPolicy,
        evidence_policy_ref: evidencePolicy,
        effect_certificate_sha256: null,
        reverts_authority_ref: null,
        policy_rotation_artifact_ref: null,
        trusted_observation_admission_ref: null,
        created_at: at,
      });
      assertWritableAuthorityBindingsV1(
        database, manifest, binding.scope, mutation.taskFamily, at, "genesis",
      );
      insertAuthorityBranchV1(database, lineage, manifest);
      const head = buildAuthorityHeadV1(
        binding.tenantId, subject, 1, manifest, lineage, at,
      );
      insertAuthorityHeadV1(database, head);
      const persisted = await readHeadInternal(database, artifactStore, policyAuthority,
        binding.tenantId, subject, lineage);
      if (!persisted || persisted.head.head_sha256 !== head.head_sha256
        || persisted.target.manifest.manifest_sha256 !== manifest.manifest_sha256) {
        fail("genesis_postwrite_mismatch");
      }
      return canonicalContinuationClone({
        created: true,
        revision: persisted.target,
        head: persisted.head,
      });
    },

    async createIsolatedCandidateDraft(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      args: CreateIsolatedCandidateDraftV1Args,
    ): Promise<AppendAuthorityDecisionV1Result | null> {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      if (binding.operationKind !== "record_observations"
        || binding.actorKind !== "trusted_host") {
        fail("isolated_candidate_operation_forbidden");
      }
      if (AUTHORITY_CANDIDATE_MUTATION_CONTEXTS.has(context)) {
        fail("candidate_operation_context_already_used");
      }
      AUTHORITY_CANDIDATE_MUTATION_CONTEXTS.add(context);
      const parsed = exactRecord(args, [
        "expected_head_revision", "expected_head_sha256",
      ], "isolated_candidate_args");
      const expectedRevision = integer(
        parsed.expected_head_revision,
        "expected_head_revision",
      );
      const expectedSha = sha(parsed.expected_head_sha256, "expected_head_sha256");
      const mutation = deriveTrustedObservationAuthorityMutationV1(database, binding);
      if (mutation.learningBindings.length === 0) return null;
      if (mutation.admissionRef === null) {
        fail("trusted_observation_learning_admission_missing");
      }
      const lineage = continuationRuntimeV1OperationLineage(binding);
      const current = await readHeadInternal(
        database,
        artifactStore,
        policyAuthority,
        binding.tenantId,
        mutation.authoritySubjectSha256,
        authorityHeadUsesPendingOperationV1(
          database,
          lineage,
          mutation.authoritySubjectSha256,
        ),
      );
      if (!current
        || current.head.source_operation.scope !== binding.scope
        || current.head.head_revision !== expectedRevision
        || current.head.head_sha256 !== expectedSha) {
        throw new ContinuationRuntimeV1AuthorityHeadConflictError(
          expectedRevision,
          current?.head.head_revision ?? null,
          expectedSha,
          current?.head.head_sha256 ?? null,
        );
      }
      const learningMemoryIds = new Set(mutation.learningBindings.map(
        (candidateBinding) => capsuleForAuthorityBindingV1(
          database,
          binding.tenantId,
          candidateBinding,
        ).source.memory_id,
      ));
      const capsuleBindings = replaceAuthorityBindingsForMemoryKindsV1(
        database,
        binding.tenantId,
        current.target.manifest.capsule_bindings,
        mutation.learningBindings,
        learningMemoryIds,
        LEARNING_AUTHORITY_CAPSULE_KINDS_V1,
      );
      const at = nextAuthorityTimeV1(now(), current.head.updated_at);
      const manifest = buildAuthorityBranchManifestV1({
        tenant_id: binding.tenantId,
        authority_subject_sha256: mutation.authoritySubjectSha256,
        branch_id: isolatedCandidateAuthorityBranchIdV1(
          lineage,
          current.head.target,
          mutation.admissionRef,
          mutation.learningBindings,
        ),
        branch_revision: 1,
        branch_kind: "candidate",
        state: "draft",
        base_authoritative_ref: current.head.target,
        previous_revision_ref: null,
        capsule_bindings: capsuleBindings,
        compiler_policy_ref: current.target.manifest.compiler_policy_ref,
        evidence_policy_ref: current.target.manifest.evidence_policy_ref,
        effect_certificate_sha256: null,
        reverts_authority_ref: null,
        policy_rotation_artifact_ref: null,
        trusted_observation_admission_ref: mutation.admissionRef,
        created_at: at,
      });
      assertWritableAuthorityBindingsV1(
        database,
        manifest,
        binding.scope,
        mutation.taskFamily,
        at,
        "candidate",
        mutation.learningBindings,
      );
      insertAuthorityBranchV1(database, lineage, manifest);
      const persisted = await readRevisionInternal(
        database,
        artifactStore,
        policyAuthority,
        binding.tenantId,
        mutation.authoritySubjectSha256,
        manifest.branch_id,
        manifest.branch_revision,
        lineage,
      );
      if (!persisted || persisted.manifest.manifest_sha256 !== manifest.manifest_sha256) {
        fail("isolated_candidate_postwrite_mismatch");
      }
      return canonicalContinuationClone({
        revision: persisted,
        head: current.head,
        head_advanced: false,
      });
    },


    async rotatePolicies(

      context: ContinuationRuntimeV1AuthorityWriteContext,
      args: RotateAuthorityPoliciesV1Args,
    ): Promise<AppendAuthorityDecisionV1Result> {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      if (binding.operationKind !== "authority_decision" || binding.actorKind !== "operator") {
        fail("policy_rotation_operation_forbidden");
      }
      if (AUTHORITY_OPERATOR_MUTATION_CONTEXTS.has(context)) {
        fail("operator_operation_context_already_used");
      }
      AUTHORITY_OPERATOR_MUTATION_CONTEXTS.add(context);
      return rotateContinuationRuntimeV1Policies({
        database,
        artifactStore,
        policyAuthority,
        binding,
        args,
        now,
        readHead: (tenantId, subject, pending = null) => readHeadInternal(
          database,
          artifactStore,
          policyAuthority,
          tenantId,
          subject,
          pending,
        ),
        headConflict: (
          expectedRevision,
          actualRevision,
          expectedSha256,
          actualSha256,
        ) => new ContinuationRuntimeV1AuthorityHeadConflictError(
          expectedRevision,
          actualRevision,
          expectedSha256,
          actualSha256,
        ),
      });
    },

    async readRevision(
      args: ReadAuthorityBranchRevisionV1Args,
    ): Promise<AuthorityBranchRevisionRecordV1 | null> {
      const parsed = exactRecord(args, [
        "authority_subject_sha256", "branch_id", "branch_revision", "tenant_id",
      ], "read_revision_args");
      return readRevisionInternal(
        database,
        artifactStore,
        policyAuthority,
        text(parsed.tenant_id, "tenant_id"),
        sha(parsed.authority_subject_sha256, "authority_subject_sha256"),
        text(parsed.branch_id, "branch_id"),
        integer(parsed.branch_revision, "branch_revision"),
      );
    },

    async readLatestRevision(
      args: ReadLatestAuthorityBranchRevisionV1Args,
    ): Promise<AuthorityBranchRevisionRecordV1 | null> {
      const parsed = exactRecord(args, [
        "authority_subject_sha256", "branch_id", "tenant_id",
      ], "read_latest_revision_args");
      const tenantId = text(parsed.tenant_id, "tenant_id");
      const subject = sha(
        parsed.authority_subject_sha256,
        "authority_subject_sha256",
      );
      const branchId = text(parsed.branch_id, "branch_id");
      const row = await database.read(() => database.db.prepare(`SELECT
          MAX(branch_revision) AS branch_revision
        FROM branch_revisions
        WHERE tenant_id=? AND authority_subject_sha256=? AND branch_id=?`).get(
          tenantId,
          subject,
          branchId,
        ) as Readonly<{ branch_revision: unknown }>);
      if (row.branch_revision === null) return null;
      return readRevisionInternal(
        database,
        artifactStore,
        policyAuthority,
        tenantId,
        subject,
        branchId,
        integer(row.branch_revision, "branch_revision"),
      );
    },

    async readHead(args: ReadAuthorityHeadV1Args): Promise<AuthorityHeadV1 | null> {
      const parsed = exactRecord(args,
        ["authority_subject_sha256", "tenant_id"], "read_head_args");
      const result = await readHeadInternal(
        database,
        artifactStore,
        policyAuthority,
        text(parsed.tenant_id, "tenant_id"),
        sha(parsed.authority_subject_sha256, "authority_subject_sha256"),
      );
      return result?.head ?? null;
    },
  });
  AUTHORITY_STORES.set(store, {
    database,
    artifactStore,
    policyAuthority,
    effectCertificateReader,
  });
  return store;
}
