import type {
  AuthorityBranchCapsuleBindingV1,
  AuthoritativeBranchRevisionRefV1,
  TrustedObservationAdmissionRefV1,
} from "../continuation/authority-branch.js";
import {
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type ExecutionCapsuleV1,
  type Sha256,
} from "../continuation/contract.js";
import { verifyHostTaskEnvelopeV1 } from "../continuation/task-envelope.js";
import { assertExecutionCapsuleV1 } from "../continuation/validation.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "./continuation-runtime-v1-operation-result-derivation.js";
import type {
  ContinuationRuntimeV1AuthorityWriteBinding,
  ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";

export const LEARNING_AUTHORITY_CAPSULE_KINDS_V1 = new Set<
  ExecutionCapsuleV1["kind"]
>([
  "procedure",
  "counter_evidence",
]);

export type TrustedObservationAuthorityMutationV1 = Readonly<{
  admissionRef: TrustedObservationAdmissionRefV1 | null;
  taskFamily: string;
  authoritySubjectSha256: Sha256;
  learningBindings: readonly AuthorityBranchCapsuleBindingV1[];
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
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${field}_must_be_plain_object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail(`${field}_shape_invalid`);
  }
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

function parseCanonicalObject(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") fail(`corrupt:${field}_type`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(`corrupt:${field}_parse`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || canonicalContinuationJson(parsed) !== value) {
    fail(`corrupt:${field}_noncanonical`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function capsuleForAuthorityBindingV1(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  binding: AuthorityBranchCapsuleBindingV1,
): ExecutionCapsuleV1 {
  const row = database.db.prepare(`SELECT capsule_json FROM capsule_revisions
    WHERE tenant_id = ? AND scope = ? AND capsule_id = ?
      AND capsule_revision = ? AND capsule_sha256 = ?`).get(
    tenantId,
    binding.capsule_scope,
    binding.capsule.capsule_id,
    binding.capsule.capsule_revision,
    binding.capsule.capsule_sha256,
  ) as Readonly<{ capsule_json: unknown }> | undefined;
  if (!row || typeof row.capsule_json !== "string") fail("capsule_ref_missing");
  const value: unknown = JSON.parse(row.capsule_json);
  assertExecutionCapsuleV1(value);
  return value;
}

function bindingForTrustedCapsule(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  scope: string,
  capsule: ExecutionCapsuleV1,
): AuthorityBranchCapsuleBindingV1 {
  const item = database.db.prepare(`SELECT authority FROM memory_items
    WHERE tenant_id = ? AND scope = ? AND memory_id = ?`).get(
    tenantId,
    scope,
    capsule.source.memory_id,
  ) as Readonly<{ authority: unknown }> | undefined;
  if (!item || (item.authority !== "candidate"
    && item.authority !== "verified"
    && item.authority !== "authoritative")) {
    fail("trusted_capsule_memory_authority_invalid");
  }
  return canonicalContinuationClone({
    capsule_scope: scope,
    capsule: {
      capsule_id: capsule.capsule_id,
      capsule_revision: capsule.capsule_revision,
      capsule_sha256: capsule.capsule_sha256,
    },
    disposition: capsule.proposed_influence === "block"
      ? "prohibit" as const
      : "include" as const,
    admission_authority: item.authority === "authoritative"
      ? "authoritative"
      : "candidate",
  });
}

export function deriveTrustedObservationAuthorityMutationV1(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1AuthorityWriteBinding,
): TrustedObservationAuthorityMutationV1 {
  const result = deriveContinuationRuntimeV1OperationResultV1(
    database,
    binding,
    "before_receipt_insert",
  );
  if (result.schema_version !== "record_observations_result_v1") {
    fail("trusted_observation_operation_result_invalid");
  }
  const snapshotRef = result.observation_snapshot_ref;
  const snapshotRow = database.db.prepare(`SELECT host_task_envelope_json
    FROM observation_snapshots WHERE tenant_id = ? AND scope = ?
      AND world_snapshot_id = ? AND world_snapshot_sha256 = ?
      AND source_operation_kind = 'record_observations'
      AND source_operation_id = ? AND source_request_sha256 = ?`).get(
    binding.tenantId,
    binding.scope,
    snapshotRef.world_snapshot_id,
    snapshotRef.world_snapshot_sha256,
    binding.operationId,
    binding.requestSha256,
  ) as Readonly<{ host_task_envelope_json: unknown }> | undefined;
  if (!snapshotRow || typeof snapshotRow.host_task_envelope_json !== "string") {
    fail("trusted_observation_admission_snapshot_missing");
  }
  const envelopeValue: unknown = JSON.parse(snapshotRow.host_task_envelope_json);
  const envelope = verifyHostTaskEnvelopeV1(envelopeValue);
  if (envelope.host_task_envelope_sha256
      !== snapshotRef.host_task_envelope_sha256
    || envelope.tenant_id !== binding.tenantId
    || envelope.scope !== binding.scope) {
    fail("trusted_observation_admission_snapshot_binding_mismatch");
  }
  if (result.memory_revision_ref === null) {
    return {
      admissionRef: null,
      taskFamily: envelope.task_family,
      authoritySubjectSha256: envelope.authority_subject_sha256,
      learningBindings: [],
    };
  }
  const admissionRef = canonicalContinuationClone({
    schema_version: "trusted_observation_admission_ref_v1" as const,
    observation_snapshot_ref: snapshotRef,
    memory_revision_ref: result.memory_revision_ref,
  });
  const memoryRow = database.db.prepare(`SELECT mutation_json FROM memory_commits
    WHERE tenant_id = ? AND scope = ? AND revision = ? AND commit_id = ?
      AND commit_sha256 = ? AND mutation_sha256 = ?
      AND source_operation_kind = 'record_observations'
      AND source_operation_id = ? AND source_request_sha256 = ?`).get(
    binding.tenantId,
    binding.scope,
    admissionRef.memory_revision_ref.revision,
    admissionRef.memory_revision_ref.commit_id,
    admissionRef.memory_revision_ref.commit_sha256,
    admissionRef.memory_revision_ref.mutation_sha256,
    binding.operationId,
    binding.requestSha256,
  ) as Readonly<{ mutation_json: unknown }> | undefined;
  if (!memoryRow || typeof memoryRow.mutation_json !== "string") {
    fail("trusted_observation_admission_memory_revision_missing");
  }
  const mutation = exactRecord(
    parseCanonicalObject(
      memoryRow.mutation_json,
      "trusted_observation_admission_mutation_json",
    ),
    ["capsules", "items", "relations", "schema_version"],
    "trusted_observation_admission_memory_mutation",
  );
  if (mutation.schema_version !== "memory_mutation_v1"
    || !Array.isArray(mutation.items)
    || !Array.isArray(mutation.capsules)) {
    fail("trusted_observation_admission_memory_mutation_invalid");
  }
  const learningBindings: AuthorityBranchCapsuleBindingV1[] = [];
  for (const value of mutation.capsules) {
    assertExecutionCapsuleV1(value);
    if (value.source.source_commit_id !== admissionRef.memory_revision_ref.commit_id
      || value.applicability.tenant_id !== binding.tenantId
      || value.applicability.scope !== binding.scope
      || value.applicability.task_family !== envelope.task_family) {
      fail("trusted_observation_admission_capsule_binding_mismatch");
    }
    const nextBinding = bindingForTrustedCapsule(
      database,
      binding.tenantId,
      binding.scope,
      value,
    );
    if (LEARNING_AUTHORITY_CAPSULE_KINDS_V1.has(value.kind)) {
      learningBindings.push(nextBinding);
    }
  }
  return {
    admissionRef,
    taskFamily: envelope.task_family,
    authoritySubjectSha256: envelope.authority_subject_sha256,
    learningBindings: canonicalContinuationClone(learningBindings),
  };
}

export function replaceAuthorityBindingsForMemoryKindsV1(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  current: readonly AuthorityBranchCapsuleBindingV1[],
  replacements: readonly AuthorityBranchCapsuleBindingV1[],
  memoryIds: ReadonlySet<string>,
  replaceKinds: ReadonlySet<ExecutionCapsuleV1["kind"]>,
): readonly AuthorityBranchCapsuleBindingV1[] {
  const retained = current.filter((binding) => {
    const capsule = capsuleForAuthorityBindingV1(database, tenantId, binding);
    return !(replaceKinds.has(capsule.kind)
      && memoryIds.has(capsule.source.memory_id));
  });
  return canonicalContinuationClone([...retained, ...replacements]);
}

export function isolatedCandidateAuthorityBranchIdV1(
  lineage: ContinuationRuntimeV1OperationLineageV1,
  base: AuthoritativeBranchRevisionRefV1,
  admissionRef: TrustedObservationAdmissionRefV1,
  bindings: readonly AuthorityBranchCapsuleBindingV1[],
): string {
  return `candidate-${canonicalContinuationSha256({
    schema_version: "isolated_candidate_branch_id_v1",
    source_operation: lineage,
    base_authoritative_ref: base,
    trusted_observation_admission_ref: admissionRef,
    candidate_binding_set: [...bindings].sort((left, right) =>
      compareCanonicalUtf8(
        canonicalContinuationJson(left),
        canonicalContinuationJson(right),
      )),
  })}`;
}

export function authorityHeadUsesPendingOperationV1(
  database: ContinuationRuntimeV1Database,
  lineage: ContinuationRuntimeV1OperationLineageV1,
  authoritySubjectSha256: Sha256,
): ContinuationRuntimeV1OperationLineageV1 | null {
  const row = database.db.prepare(`SELECT source_operation_scope,
      source_operation_kind, source_operation_id, source_request_sha256
    FROM authority_heads WHERE tenant_id = ? AND authority_subject_sha256 = ?`).get(
    lineage.tenant_id,
    authoritySubjectSha256,
  ) as Readonly<Record<string, unknown>> | undefined;
  if (!row) return null;
  return row.source_operation_scope === lineage.scope
    && row.source_operation_kind === lineage.operation_kind
    && row.source_operation_id === lineage.operation_id
    && row.source_request_sha256 === lineage.request_sha256
    ? lineage
    : null;
}
