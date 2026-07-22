import {
  assertCanonicalUtcMillis,
  assertUnicodeScalarString,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type CanonicalJson,
  type CapsuleRefV1,
  type ExecutionCapsuleV1,
} from "../continuation/contract.js";
import { assertExecutionCapsuleV1 } from "../continuation/validation.js";
import {
  buildArchivedMemoryProjectionV1,
  type ContinuationRuntimeV1MemoryAuthority,
  type ContinuationRuntimeV1MemoryCanonicalObject,
  type ContinuationRuntimeV1MemoryLifecycle,
  type MemoryItemMutationV1,
} from "./continuation-runtime-v1-memory-contract.js";
import type { ContinuationRuntimeV1OperationLineageV1 } from
  "./continuation-runtime-v1-operation-store.js";

const SHA = /^[0-9a-f]{64}$/u;

export type HeadRow = Readonly<{
  tenant_id: unknown;
  scope: unknown;
  head_revision: unknown;
  head_commit_id: unknown;
  head_commit_sha256: unknown;
  head_sha256: unknown;
  source_operation_kind: unknown;
  source_operation_id: unknown;
  source_request_sha256: unknown;
  updated_at: unknown;
}>;

export type ItemRow = {
  memory_id: string;
  memory_kind: string;
  lifecycle: ContinuationRuntimeV1MemoryLifecycle;
  authority: ContinuationRuntimeV1MemoryAuthority;
  hydrated: number;
  projection_sha256: string;
  projection_json: string;
  rehydration_ref: string | null;
  source_commit_revision: number;
  source_commit_id: string;
  source_commit_sha256: string;
  row_sha256: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CapsuleRow = {
  tenant_id: string;
  scope: string;
  capsule_json: string;
  capsule_sha256: string;
  capsule_id: string;
  capsule_revision: number;
  parent_capsule_revision: number | null;
  parent_capsule_sha256: string | null;
  memory_id: string;
  source_commit_revision: number;
  source_commit_id: string;
  source_commit_sha256: string;
  source_projection_sha256: string;
  projection_sha256: string;
  projection_json: string;
  precondition_count: number;
  preconditions_json: string;
  coverage_claim_count: number;
  coverage_claims_json: string;
  conflict_count: number;
  conflicts_json: string;
  supersedes_count: number;
  supersedes_json: string;
  created_at: string;
  capsule_kind: ExecutionCapsuleV1["kind"];
  proposed_influence: ExecutionCapsuleV1["proposed_influence"];
  task_family: string;
  task_signature: string | null;
  workflow_signature: string | null;
  workspace_signature: string | null;
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  expires_at: string | null;
};

export type RelationRow = {
  relation_id: string;
  relation_kind: string;
  lifecycle: ContinuationRuntimeV1MemoryLifecycle;
  source_memory_id: string;
  target_memory_id: string;
  projection_sha256: string;
  projection_json: string;
  source_commit_revision: number;
  source_commit_id: string;
  source_commit_sha256: string;
  row_sha256: string;
  created_at: string;
  updated_at: string;
};

export function exactKeys(
  value: unknown,
  expected: readonly string[],
  field: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`continuation_runtime_v1_memory_${field}_must_be_object`);
  }
  const actual = Object.keys(value).sort(compareCanonicalUtf8);
  const wanted = [...expected].sort(compareCanonicalUtf8);
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`continuation_runtime_v1_memory_${field}_shape_invalid`);
  }
}

export function text(value: unknown, max: number, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_memory_${field}_invalid`);
  }
  assertUnicodeScalarString(value, `memory.${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > max) {
    throw new Error(`continuation_runtime_v1_memory_${field}_invalid`);
  }
}

export function sha(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA.test(value)) {
    throw new Error(`continuation_runtime_v1_memory_${field}_invalid`);
  }
}

export function time(value: string | null, field: string): void {
  if (value === null) return;
  assertCanonicalUtcMillis(value, `memory.${field}`);
}

export function canonicalObject(value: unknown, maxBytes: number, field: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`continuation_runtime_v1_memory_${field}_must_be_object`);
  }
  const json = canonicalContinuationJson(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new Error(`continuation_runtime_v1_memory_${field}_too_large`);
  }
  return json;
}

function parseCanonical(raw: unknown, field: string, object = false): CanonicalJson {
  if (typeof raw !== "string") {
    throw new Error(`continuation_runtime_v1_memory_corrupt:${field}_type`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`continuation_runtime_v1_memory_corrupt:${field}_parse`);
  }
  if (object && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error(`continuation_runtime_v1_memory_corrupt:${field}_shape`);
  }
  if (canonicalContinuationJson(parsed) !== raw) {
    throw new Error(`continuation_runtime_v1_memory_corrupt:${field}_encoding`);
  }
  return parsed as CanonicalJson;
}

export function profile(capsule: ExecutionCapsuleV1): string {
  const applicability = capsule.applicability;
  return canonicalContinuationJson({
    task_family: applicability.task_family,
    task_signature: applicability.task_signature,
    workflow_signature: applicability.workflow_signature,
    workspace_signature: applicability.workspace_signature,
    producer_agent_id: applicability.producer_agent_id,
    owner_agent_id: applicability.owner_agent_id,
    owner_team_id: applicability.owner_team_id,
  });
}

export function capsuleRefKey(ref: CapsuleRefV1): string {
  return `${ref.capsule_id}\0${ref.capsule_revision.toString().padStart(16, "0")}\0${ref.capsule_sha256}`;
}

export function capsuleRowKey(row: CapsuleRow): string {
  return capsuleRefKey({
    capsule_id: row.capsule_id,
    capsule_revision: row.capsule_revision,
    capsule_sha256: row.capsule_sha256,
  });
}

export function assertMemoryItemMutationSemantics(args: Readonly<{
  item: MemoryItemMutationV1;
  existing: ItemRow | undefined;
  source_operation: ContinuationRuntimeV1OperationLineageV1;
}>): void {
  const { item, existing, source_operation: operation } = args;
  if (existing === undefined && item.lifecycle !== "active") {
    throw new Error("continuation_runtime_v1_memory_initial_lifecycle_invalid");
  }
  if (item.lifecycle === "archived") {
    if (item.hydrated || item.rehydration_ref === null || !existing
      || existing.lifecycle === "archived"
      || (existing.lifecycle !== "active" && existing.lifecycle !== "suppressed")
      || operation.operation_kind !== "authority_decision"
      || operation.actor_kind !== "operator") {
      throw new Error("continuation_runtime_v1_memory_archive_transition_invalid");
    }
    const expected = buildArchivedMemoryProjectionV1({
      memory_id: item.memory_id,
      source_projection_sha256: existing.projection_sha256,
      rehydration_ref: item.rehydration_ref,
    });
    if (canonicalContinuationJson(item.projection)
      !== canonicalContinuationJson(expected)) {
      throw new Error("continuation_runtime_v1_memory_archive_projection_invalid");
    }
    return;
  }
  if (!item.hydrated || item.rehydration_ref !== null) {
    throw new Error("continuation_runtime_v1_memory_hydration_state_invalid");
  }
  if (existing?.lifecycle === "archived") {
    throw new Error("continuation_runtime_v1_memory_archived_terminal");
  }
  if (existing?.lifecycle === "quarantined") {
    throw new Error("continuation_runtime_v1_memory_quarantined_terminal");
  }
  const lifecycleChanged = existing !== undefined
    && existing.lifecycle !== item.lifecycle;
  if (lifecycleChanged) {
    const allowed = (existing.lifecycle === "active" && item.lifecycle === "suppressed")
      || (existing.lifecycle === "suppressed" && item.lifecycle === "active")
      || ((existing.lifecycle === "active" || existing.lifecycle === "suppressed")
        && item.lifecycle === "quarantined");
    if (!allowed
      || operation.operation_kind !== "authority_decision"
      || operation.actor_kind !== "operator") {
      throw new Error("continuation_runtime_v1_memory_lifecycle_transition_invalid");
    }
  }
}

export function verifyItem(
  tenantId: string,
  scope: string,
  row: ItemRow,
): ContinuationRuntimeV1MemoryCanonicalObject {
  const projection = parseCanonical(
    row.projection_json,
    "item_projection",
    true,
  ) as ContinuationRuntimeV1MemoryCanonicalObject;
  if (canonicalContinuationSha256(projection) !== row.projection_sha256) {
    throw new Error("continuation_runtime_v1_memory_corrupt:item_projection_digest");
  }
  if (row.lifecycle === "archived") {
    if (row.hydrated !== 0 || row.rehydration_ref === null) {
      throw new Error("continuation_runtime_v1_memory_corrupt:archived_hydration_state");
    }
    const expectedKeys = [
      "memory_id",
      "rehydration_ref_sha256",
      "schema_version",
      "source_projection_sha256",
    ];
    exactKeys(projection, expectedKeys, "archived_projection");
    if (projection.schema_version !== "archived_memory_projection_v1"
      || projection.memory_id !== row.memory_id
      || typeof projection.source_projection_sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(projection.source_projection_sha256)
      || projection.rehydration_ref_sha256
        !== canonicalContinuationSha256(row.rehydration_ref)) {
      throw new Error("continuation_runtime_v1_memory_corrupt:archived_projection");
    }
  } else if (row.hydrated !== 1 || row.rehydration_ref !== null) {
    throw new Error("continuation_runtime_v1_memory_corrupt:nonarchived_hydration_state");
  }
  const body: ContinuationRuntimeV1MemoryCanonicalObject = {
    tenant_id: tenantId,
    scope,
    memory_id: row.memory_id,
    memory_kind: row.memory_kind,
    lifecycle: row.lifecycle,
    authority: row.authority,
    hydrated: row.hydrated === 1,
    projection_sha256: row.projection_sha256,
    rehydration_ref: row.rehydration_ref,
    source_commit_revision: row.source_commit_revision,
    source_commit_id: row.source_commit_id,
    source_commit_sha256: row.source_commit_sha256,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (canonicalContinuationSha256(body) !== row.row_sha256) {
    throw new Error("continuation_runtime_v1_memory_corrupt:item_row_digest");
  }
  return projection;
}

export function verifyRelation(
  tenantId: string,
  scope: string,
  row: RelationRow,
): ContinuationRuntimeV1MemoryCanonicalObject {
  const projection = parseCanonical(
    row.projection_json,
    "relation_projection",
    true,
  ) as ContinuationRuntimeV1MemoryCanonicalObject;
  if (canonicalContinuationSha256(projection) !== row.projection_sha256) {
    throw new Error("continuation_runtime_v1_memory_corrupt:relation_projection_digest");
  }
  const body: ContinuationRuntimeV1MemoryCanonicalObject = {
    tenant_id: tenantId,
    scope,
    relation_id: row.relation_id,
    relation_kind: row.relation_kind,
    lifecycle: row.lifecycle,
    source_memory_id: row.source_memory_id,
    target_memory_id: row.target_memory_id,
    projection_sha256: row.projection_sha256,
    source_commit_revision: row.source_commit_revision,
    source_commit_id: row.source_commit_id,
    source_commit_sha256: row.source_commit_sha256,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (canonicalContinuationSha256(body) !== row.row_sha256) {
    throw new Error("continuation_runtime_v1_memory_corrupt:relation_row_digest");
  }
  return projection;
}

export function verifyCapsule(row: CapsuleRow): ExecutionCapsuleV1 {
  const parsed = parseCanonical(row.capsule_json, "capsule_json", true) as unknown;
  assertExecutionCapsuleV1(parsed);
  const capsule = parsed as ExecutionCapsuleV1;
  const { projection_sha256: projectionSha256, ...projectionBody } = capsule.projection;
  if (canonicalContinuationSha256(projectionBody) !== projectionSha256) {
    throw new Error("continuation_runtime_v1_memory_corrupt:capsule_projection_digest");
  }
  if (canonicalContinuationSha256((({ capsule_sha256: _, ...body }) => body)(capsule))
      !== row.capsule_sha256
    || capsule.capsule_sha256 !== row.capsule_sha256
    || capsule.capsule_id !== row.capsule_id
    || capsule.capsule_revision !== row.capsule_revision
    || capsule.parent_capsule_sha256 !== row.parent_capsule_sha256
    || capsule.applicability.tenant_id !== row.tenant_id
    || capsule.applicability.scope !== row.scope
    || capsule.source.memory_id !== row.memory_id
    || capsule.source.source_commit_id !== row.source_commit_id
    || capsule.source.source_projection_sha256 !== row.source_projection_sha256
    || capsule.created_at !== row.created_at
    || capsule.expires_at !== row.expires_at
    || capsule.kind !== row.capsule_kind
    || capsule.proposed_influence !== row.proposed_influence
    || capsule.applicability.task_family !== row.task_family
    || capsule.applicability.task_signature !== row.task_signature
    || capsule.applicability.workflow_signature !== row.workflow_signature
    || capsule.applicability.workspace_signature !== row.workspace_signature
    || capsule.applicability.producer_agent_id !== row.producer_agent_id
    || capsule.applicability.owner_agent_id !== row.owner_agent_id
    || capsule.applicability.owner_team_id !== row.owner_team_id
    || capsule.projection.projection_sha256 !== row.projection_sha256
    || row.parent_capsule_revision
      !== (capsule.capsule_revision === 1 ? null : capsule.capsule_revision - 1)) {
    throw new Error("continuation_runtime_v1_memory_corrupt:capsule_identity");
  }
  const checks: Array<[unknown, unknown, number, string]> = [
    [capsule.projection, row.projection_json, -1, "capsule_projection"],
    [capsule.precondition_specs, row.preconditions_json,
      row.precondition_count, "capsule_preconditions"],
    [capsule.coverage_claims, row.coverage_claims_json,
      row.coverage_claim_count, "capsule_coverage_claims"],
    [capsule.conflicts_with, row.conflicts_json, row.conflict_count, "capsule_conflicts"],
    [capsule.supersedes, row.supersedes_json, row.supersedes_count, "capsule_supersedes"],
  ];
  for (const [value, json, count, field] of checks) {
    if (canonicalContinuationJson(value) !== json
      || (count >= 0 && (value as readonly unknown[]).length !== count)) {
      throw new Error(`continuation_runtime_v1_memory_corrupt:${field}`);
    }
  }
  return capsule;
}
