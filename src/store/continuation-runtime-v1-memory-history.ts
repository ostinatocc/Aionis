import {
  assertCanonicalUtcMillis,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type CanonicalJson,
  type ExecutionCapsuleV1,
} from "../continuation/contract.js";
import { assertExecutionCapsuleV1 } from "../continuation/validation.js";
import { isContinuationRehydrationRefV1 } from
  "../continuation/rehydration-ref.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import type { ContinuationRuntimeV1OperationLineageV1 } from
  "./continuation-runtime-v1-operation-store.js";

type CanonicalObject = Readonly<{ [key: string]: CanonicalJson }>;
type Lifecycle = "active" | "suppressed" | "archived" | "quarantined";
type Authority = "candidate" | "verified" | "authoritative";

export type HistoricalMemoryProjectionRequestV1 = Readonly<{
  tenant_id: string;
  scope: string;
  task_family: string;
  memory_scope_head_revision: number;
  memory_scope_head_sha256: string;
}>;

export type HistoricalMemoryItemV1 = Readonly<{
  memory_id: string;
  memory_kind: string;
  lifecycle: Lifecycle;
  authority: Authority;
  hydrated: boolean;
  projection_sha256: string;
  projection: CanonicalObject;
  rehydration_ref: string | null;
  source_commit_revision: number;
  source_commit_id: string;
  source_commit_sha256: string;
  row_sha256: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export type HistoricalMemoryRelationV1 = Readonly<{
  relation_id: string;
  relation_kind: string;
  lifecycle: Lifecycle;
  source_memory_id: string;
  target_memory_id: string;
  projection_sha256: string;
  projection: CanonicalObject;
  source_commit_revision: number;
  source_commit_id: string;
  source_commit_sha256: string;
  row_sha256: string;
  created_at: string;
  updated_at: string;
}>;

export type HistoricalMemoryCapsuleV1 = Readonly<{
  capsule: ExecutionCapsuleV1;
  source_commit_revision: number;
  source_commit_id: string;
  source_commit_sha256: string;
}>;

export type HistoricalContinuityRecordV1 = Readonly<{
  item: HistoricalMemoryItemV1;
  capsule: HistoricalMemoryCapsuleV1;
}>;

/**
 * The exact memory surface consumed by candidate materialization. Historical
 * audit projections and the bounded current serving projection both expose
 * this shape, without pretending that a current projection verified the full
 * immutable commit chain.
 */
export type ContinuationServingMemoryProjectionV1 = Readonly<{
  tenant_id: string;
  scope: string;
  task_family: string;
  head: Readonly<{
    head_revision: number;
    head_commit_id: string;
    head_commit_sha256: string;
    head_sha256: string;
    source_operation: ContinuationRuntimeV1OperationLineageV1;
    updated_at: string;
  }>;
  items: readonly HistoricalMemoryItemV1[];
  capsules: readonly HistoricalMemoryCapsuleV1[];
  continuity_records: readonly HistoricalContinuityRecordV1[];
}>;

export type HistoricalMemoryProjectionV1 = Readonly<{
  schema_version: "historical_memory_projection_v1";
  tenant_id: string;
  scope: string;
  task_family: string;
  head: Readonly<{
    head_revision: number;
    head_commit_id: string;
    head_commit_sha256: string;
    head_sha256: string;
    source_operation: ContinuationRuntimeV1OperationLineageV1;
    updated_at: string;
  }>;
  verified_commit_count: number;
  audit_items: readonly HistoricalMemoryItemV1[];
  audit_relations: readonly HistoricalMemoryRelationV1[];
  audit_capsules: readonly HistoricalMemoryCapsuleV1[];
  continuity_records: readonly HistoricalContinuityRecordV1[];
  projection_sha256: string;
}>;

export function continuationServingMemoryProjectionFromHistoricalV1(
  projection: HistoricalMemoryProjectionV1,
): ContinuationServingMemoryProjectionV1 {
  return canonicalContinuationClone({
    tenant_id: projection.tenant_id,
    scope: projection.scope,
    task_family: projection.task_family,
    head: projection.head,
    items: projection.audit_items,
    capsules: projection.audit_capsules,
    continuity_records: projection.continuity_records,
  });
}

const SHA256 = /^[0-9a-f]{64}$/u;
const LIFECYCLES = new Set<Lifecycle>([
  "active", "suppressed", "archived", "quarantined",
]);
const AUTHORITIES = new Set<Authority>([
  "candidate", "verified", "authoritative",
]);
const CONTINUITY_KINDS = new Set([
  "current_state", "verified_fact", "constraint",
]);
const OPERATION_ACTORS = Object.freeze({
  record_observations: "trusted_host",
  authority_decision: "operator",
  worker_completion: "worker",
} as const);
const MAX_HISTORY_DEPTH = 32_768;
const MAX_HISTORY_MUTATION_BYTES = 67_108_864;
const MAX_HISTORY_ENTITY_COUNT = 262_144;
const HISTORY_STORES = new WeakMap<object, ContinuationRuntimeV1Database>();

type MemoryOperationKind = keyof typeof OPERATION_ACTORS;

type CommitRow = Readonly<{
  revision: unknown;
  commit_id: unknown;
  commit_sha256: unknown;
  parent_revision: unknown;
  parent_commit_id: unknown;
  parent_commit_sha256: unknown;
  request_sha256: unknown;
  source_operation_kind: unknown;
  source_operation_id: unknown;
  source_request_sha256: unknown;
  mutation_sha256: unknown;
  mutation_json: unknown;
  actor_kind: unknown;
  actor_principal_sha256: unknown;
  created_at: unknown;
  source_actor_kind: unknown;
  source_actor_principal_sha256: unknown;
}>;

export type VerifiedMemoryCommitV1 = Readonly<{
  revision: number;
  commit_id: string;
  commit_sha256: string;
  parent_revision: number | null;
  parent_commit_id: string | null;
  parent_commit_sha256: string | null;
  mutation_json: string;
  source_operation: ContinuationRuntimeV1OperationLineageV1;
  created_at: string;
}>;

type ItemMutation = Readonly<{
  memory_id: string;
  memory_kind: string;
  lifecycle: Lifecycle;
  authority: Authority;
  hydrated: boolean;
  projection: CanonicalObject;
  rehydration_ref: string | null;
  expires_at: string | null;
}>;

type RelationMutation = Readonly<{
  relation_id: string;
  relation_kind: string;
  lifecycle: Lifecycle;
  source_memory_id: string;
  target_memory_id: string;
  projection: CanonicalObject;
}>;

function fail(reason: string): never {
  throw new Error(`continuation_runtime_v1_memory_history_${reason}`);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${field}_must_be_object`);
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.some((key) => typeof key !== "string")) {
    return fail(`${field}_shape_invalid`);
  }
  const actual = [...ownKeys as string[]].sort(compareCanonicalUtf8);
  const expected = [...keys].sort(compareCanonicalUtf8);
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    return fail(`${field}_shape_invalid`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${field}_shape_invalid`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, maxBytes: number, field: string): string {
  if (typeof value !== "string") return fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `memory history ${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    return fail(`${field}_invalid`);
  }
  return value;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) return fail(`${field}_invalid`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail(`${field}_invalid`);
  return value as number;
}

function nullableTime(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fail(`${field}_invalid`);
  assertCanonicalUtcMillis(value, `memory history ${field}`);
  return value;
}

function canonicalObject(value: unknown, maxBytes: number, field: string): CanonicalObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${field}_must_be_object`);
  }
  const json = canonicalContinuationJson(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) return fail(`${field}_too_large`);
  return value as CanonicalObject;
}

function parseCanonicalObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") return fail(`${field}_type`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail(`${field}_parse`);
  }
  if (canonicalContinuationJson(parsed) !== value) return fail(`${field}_encoding`);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(`${field}_shape`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function continuationRuntimeV1MemoryCommitId(args: Readonly<{
  sourceOperation: ContinuationRuntimeV1OperationLineageV1;
  revision: number;
  parentCommitSha256: string | null;
}>): string {
  return `mc_${canonicalContinuationSha256({
    schema_version: "memory_commit_id_v1",
    source_operation: args.sourceOperation,
    revision: args.revision,
    parent_commit_sha256: args.parentCommitSha256,
  })}`;
}

function verifyOperationLineage(
  tenantId: string,
  scope: string,
  row: CommitRow,
  pending: ContinuationRuntimeV1OperationLineageV1 | null,
): ContinuationRuntimeV1OperationLineageV1 {
  if (typeof row.source_operation_kind !== "string"
    || !Object.hasOwn(OPERATION_ACTORS, row.source_operation_kind)) {
    return fail("commit_source_operation_kind_invalid");
  }
  const operationKind = row.source_operation_kind as MemoryOperationKind;
  const operationId = text(row.source_operation_id, 256, "commit_source_operation_id");
  const requestSha256 = sha256(
    row.source_request_sha256,
    "commit_source_request_sha256",
  );
  const expectedTuple = {
    tenant_id: tenantId,
    scope,
    operation_kind: operationKind,
    operation_id: operationId,
    request_sha256: requestSha256,
  } as const;
  let lineage: ContinuationRuntimeV1OperationLineageV1;
  if (row.source_actor_kind === null && row.source_actor_principal_sha256 === null) {
    if (pending === null) return fail("commit_source_operation_missing");
    lineage = pending;
  } else {
    if (row.source_actor_kind !== OPERATION_ACTORS[operationKind]) {
      return fail("commit_source_operation_actor_mismatch");
    }
    lineage = {
      ...expectedTuple,
      actor_kind: OPERATION_ACTORS[operationKind],
      actor_principal_sha256: sha256(
        row.source_actor_principal_sha256,
        "commit_source_actor_principal_sha256",
      ),
    };
  }
  if (canonicalContinuationJson({
    tenant_id: lineage.tenant_id,
    scope: lineage.scope,
    operation_kind: lineage.operation_kind,
    operation_id: lineage.operation_id,
    request_sha256: lineage.request_sha256,
  }) !== canonicalContinuationJson(expectedTuple)
    || lineage.actor_kind !== OPERATION_ACTORS[operationKind]) {
    return fail("commit_source_operation_binding_mismatch");
  }
  sha256(lineage.actor_principal_sha256, "commit_source_actor_principal_sha256");
  if (row.actor_kind !== lineage.actor_kind
    || row.actor_principal_sha256 !== lineage.actor_principal_sha256
    || row.request_sha256 !== requestSha256
    || (pending !== null
      && canonicalContinuationJson(lineage) !== canonicalContinuationJson(pending))) {
    return fail("commit_source_operation_drift");
  }
  return canonicalContinuationClone(lineage);
}

function verifyCommit(
  tenantId: string,
  scope: string,
  row: CommitRow,
  pending: ContinuationRuntimeV1OperationLineageV1 | null,
): VerifiedMemoryCommitV1 {
  const revision = positiveInteger(row.revision, "commit_revision");
  const commitId = text(row.commit_id, 256, "commit_id");
  const commitSha256 = sha256(row.commit_sha256, "commit_sha256");
  const requestSha256 = sha256(row.request_sha256, "commit_request_sha256");
  const mutationSha256 = sha256(row.mutation_sha256, "commit_mutation_sha256");
  const createdAt = nullableTime(row.created_at, "commit_created_at");
  if (createdAt === null) return fail("commit_created_at_invalid");
  const sourceOperation = verifyOperationLineage(tenantId, scope, row, pending);
  let parentRevision: number | null;
  let parentCommitId: string | null;
  let parentCommitSha256: string | null;
  if (row.parent_revision === null) {
    if (revision !== 1 || row.parent_commit_id !== null || row.parent_commit_sha256 !== null) {
      return fail("commit_parent_shape_invalid");
    }
    parentRevision = null;
    parentCommitId = null;
    parentCommitSha256 = null;
  } else {
    parentRevision = positiveInteger(row.parent_revision, "commit_parent_revision");
    if (parentRevision !== revision - 1) return fail("commit_parent_revision_invalid");
    parentCommitId = text(row.parent_commit_id, 256, "commit_parent_id");
    parentCommitSha256 = sha256(row.parent_commit_sha256, "commit_parent_sha256");
  }
  const mutationJson = text(row.mutation_json, 1_048_576, "commit_mutation_json");
  const mutation = parseCanonicalObject(mutationJson, "commit_mutation_json");
  exactRecord(
    mutation,
    ["schema_version", "items", "relations", "capsules"],
    "commit_mutation",
  );
  if (mutation.schema_version !== "memory_mutation_v1"
    || !Array.isArray(mutation.items)
    || !Array.isArray(mutation.relations)
    || !Array.isArray(mutation.capsules)) {
    return fail("commit_mutation_shape_invalid");
  }
  if (canonicalContinuationSha256(mutation) !== mutationSha256) {
    return fail("commit_mutation_digest_mismatch");
  }
  if (continuationRuntimeV1MemoryCommitId({
    sourceOperation,
    revision,
    parentCommitSha256,
  }) !== commitId) return fail("commit_id_mismatch");
  const body = {
    schema_version: "memory_commit_v1",
    tenant_id: tenantId,
    scope,
    revision,
    commit_id: commitId,
    parent_revision: parentRevision,
    parent_commit_id: parentCommitId,
    parent_commit_sha256: parentCommitSha256,
    request_sha256: requestSha256,
    source_operation: sourceOperation,
    mutation_sha256: mutationSha256,
    created_at: createdAt,
  } as const;
  if (canonicalContinuationSha256(body) !== commitSha256) {
    return fail("commit_digest_mismatch");
  }
  return {
    revision,
    commit_id: commitId,
    commit_sha256: commitSha256,
    parent_revision: parentRevision,
    parent_commit_id: parentCommitId,
    parent_commit_sha256: parentCommitSha256,
    mutation_json: mutationJson,
    source_operation: sourceOperation,
    created_at: createdAt,
  };
}

export function readVerifiedContinuationRuntimeV1MemoryCommit(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  scope: string,
  revision: number,
  pending: ContinuationRuntimeV1OperationLineageV1 | null = null,
): VerifiedMemoryCommitV1 | null {
  const row = database.db.prepare(`SELECT
      memory_commit.revision, memory_commit.commit_id,
      memory_commit.commit_sha256, memory_commit.parent_revision,
      memory_commit.parent_commit_id, memory_commit.parent_commit_sha256,
      memory_commit.request_sha256, memory_commit.source_operation_kind,
      memory_commit.source_operation_id, memory_commit.source_request_sha256,
      memory_commit.mutation_sha256, memory_commit.mutation_json,
      memory_commit.actor_kind, memory_commit.actor_principal_sha256,
      memory_commit.created_at,
      source_operation.actor_kind AS source_actor_kind,
      source_operation.actor_principal_sha256 AS source_actor_principal_sha256
    FROM memory_commits AS memory_commit
    LEFT JOIN operations AS source_operation
      ON source_operation.tenant_id = memory_commit.tenant_id
     AND source_operation.scope = memory_commit.scope
     AND source_operation.operation_kind = memory_commit.source_operation_kind
     AND source_operation.operation_id = memory_commit.source_operation_id
     AND source_operation.request_sha256 = memory_commit.source_request_sha256
    WHERE memory_commit.tenant_id = ? AND memory_commit.scope = ?
      AND memory_commit.revision = ?`).get(tenantId, scope, revision) as CommitRow | undefined;
  return row ? verifyCommit(tenantId, scope, row, pending) : null;
}

function readVerifiedCommitChain(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  scope: string,
  targetRevision: number,
): readonly VerifiedMemoryCommitV1[] {
  const rows = database.db.prepare(`SELECT
      memory_commit.revision, memory_commit.commit_id,
      memory_commit.commit_sha256, memory_commit.parent_revision,
      memory_commit.parent_commit_id, memory_commit.parent_commit_sha256,
      memory_commit.request_sha256, memory_commit.source_operation_kind,
      memory_commit.source_operation_id, memory_commit.source_request_sha256,
      memory_commit.mutation_sha256, memory_commit.mutation_json,
      memory_commit.actor_kind, memory_commit.actor_principal_sha256,
      memory_commit.created_at,
      source_operation.actor_kind AS source_actor_kind,
      source_operation.actor_principal_sha256 AS source_actor_principal_sha256
    FROM memory_commits AS memory_commit
    LEFT JOIN operations AS source_operation
      ON source_operation.tenant_id = memory_commit.tenant_id
     AND source_operation.scope = memory_commit.scope
     AND source_operation.operation_kind = memory_commit.source_operation_kind
     AND source_operation.operation_id = memory_commit.source_operation_id
     AND source_operation.request_sha256 = memory_commit.source_request_sha256
    WHERE memory_commit.tenant_id = ? AND memory_commit.scope = ?
      AND memory_commit.revision <= ?
    ORDER BY memory_commit.revision`).all(
      tenantId,
      scope,
      targetRevision,
    ) as CommitRow[];
  if (rows.length === 0) return fail("head_not_found");
  if (rows.length !== targetRevision) return fail("commit_chain_cardinality_mismatch");
  const commits: VerifiedMemoryCommitV1[] = [];
  let mutationBytes = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const commit = verifyCommit(tenantId, scope, rows[index]!, null);
    if (commit.revision !== index + 1) return fail("commit_chain_cardinality_mismatch");
    mutationBytes += Buffer.byteLength(commit.mutation_json, "utf8");
    if (mutationBytes > MAX_HISTORY_MUTATION_BYTES) {
      return fail("mutation_bytes_limit_exceeded");
    }
    const parent = commits.at(-1) ?? null;
    if (parent === null) {
      if (commit.parent_revision !== null) return fail("commit_chain_invalid");
    } else if (commit.parent_revision !== parent.revision
      || commit.parent_commit_id !== parent.commit_id
      || commit.parent_commit_sha256 !== parent.commit_sha256
      || parent.created_at >= commit.created_at) {
      return fail("commit_chain_invalid");
    }
    commits.push(commit);
  }
  return commits;
}

function historicalHead(
  tenantId: string,
  scope: string,
  commit: VerifiedMemoryCommitV1,
): HistoricalMemoryProjectionV1["head"] {
  const withoutDigest = {
    tenant_id: tenantId,
    scope,
    head_revision: commit.revision,
    head_commit_id: commit.commit_id,
    head_commit_sha256: commit.commit_sha256,
    source_operation: commit.source_operation,
    updated_at: commit.created_at,
  } as const;
  return canonicalContinuationClone({
    head_revision: commit.revision,
    head_commit_id: commit.commit_id,
    head_commit_sha256: commit.commit_sha256,
    head_sha256: canonicalContinuationSha256({
      schema_version: "memory_scope_head_v1",
      ...withoutDigest,
    }),
    source_operation: commit.source_operation,
    updated_at: commit.created_at,
  });
}

function parseItem(value: unknown): ItemMutation {
  const item = exactRecord(value, [
    "memory_id", "memory_kind", "lifecycle", "authority", "hydrated",
    "projection", "rehydration_ref", "expires_at",
  ], "item_mutation");
  const lifecycle = item.lifecycle;
  const authority = item.authority;
  if (!LIFECYCLES.has(lifecycle as Lifecycle)) return fail("item_lifecycle_invalid");
  if (!AUTHORITIES.has(authority as Authority)) return fail("item_authority_invalid");
  if (typeof item.hydrated !== "boolean") return fail("item_hydrated_invalid");
  const parsed = {
    memory_id: text(item.memory_id, 256, "item_memory_id"),
    memory_kind: text(item.memory_kind, 128, "item_memory_kind"),
    lifecycle: lifecycle as Lifecycle,
    authority: authority as Authority,
    hydrated: item.hydrated,
    projection: canonicalObject(item.projection, 262_144, "item_projection"),
    rehydration_ref: item.rehydration_ref === null
      ? null : text(item.rehydration_ref, 2_048, "item_rehydration_ref"),
    expires_at: nullableTime(item.expires_at, "item_expires_at"),
  };
  if (parsed.rehydration_ref !== null
    && !isContinuationRehydrationRefV1(parsed.rehydration_ref)) {
    return fail("item_rehydration_ref_invalid");
  }
  if (parsed.lifecycle === "archived") {
    if (parsed.hydrated || parsed.rehydration_ref === null) {
      return fail("archived_item_hydration_invalid");
    }
    const tombstone = exactRecord(parsed.projection, [
      "memory_id", "rehydration_ref_sha256", "schema_version",
      "source_projection_sha256",
    ], "archived_item_projection");
    if (tombstone.schema_version !== "archived_memory_projection_v1"
      || tombstone.memory_id !== parsed.memory_id
      || typeof tombstone.source_projection_sha256 !== "string"
      || !SHA256.test(tombstone.source_projection_sha256)
      || tombstone.rehydration_ref_sha256
        !== canonicalContinuationSha256(parsed.rehydration_ref)) {
      return fail("archived_item_projection_invalid");
    }
  } else if (!parsed.hydrated || parsed.rehydration_ref !== null) {
    return fail("nonarchived_item_hydration_invalid");
  }
  return parsed;
}

function parseRelation(value: unknown): RelationMutation {
  const relation = exactRecord(value, [
    "relation_id", "relation_kind", "lifecycle", "source_memory_id",
    "target_memory_id", "projection",
  ], "relation_mutation");
  if (!LIFECYCLES.has(relation.lifecycle as Lifecycle)) {
    return fail("relation_lifecycle_invalid");
  }
  const sourceMemoryId = text(
    relation.source_memory_id,
    256,
    "relation_source_memory_id",
  );
  const targetMemoryId = text(
    relation.target_memory_id,
    256,
    "relation_target_memory_id",
  );
  if (sourceMemoryId === targetMemoryId) return fail("relation_self_reference");
  return {
    relation_id: text(relation.relation_id, 256, "relation_id"),
    relation_kind: text(relation.relation_kind, 128, "relation_kind"),
    lifecycle: relation.lifecycle as Lifecycle,
    source_memory_id: sourceMemoryId,
    target_memory_id: targetMemoryId,
    projection: canonicalObject(relation.projection, 65_536, "relation_projection"),
  };
}

function ensureSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  field: string,
): void {
  let previous: string | null = null;
  for (const value of values) {
    const current = key(value);
    if (previous !== null && compareCanonicalUtf8(previous, current) >= 0) {
      fail(`${field}_not_strictly_sorted`);
    }
    previous = current;
  }
}

function capsuleProfile(capsule: ExecutionCapsuleV1): string {
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

function capsuleKey(capsule: ExecutionCapsuleV1): string {
  return `${capsule.capsule_id}\0${String(capsule.capsule_revision).padStart(16, "0")}`;
}

function verifyCapsule(
  value: unknown,
  tenantId: string,
  scope: string,
  commit: VerifiedMemoryCommitV1,
  items: ReadonlyMap<string, HistoricalMemoryItemV1>,
  capsules: ReadonlyMap<string, HistoricalMemoryCapsuleV1>,
): HistoricalMemoryCapsuleV1 {
  assertExecutionCapsuleV1(value);
  const capsule = value as ExecutionCapsuleV1;
  const { projection_sha256: projectionSha256, ...projectionBody } = capsule.projection;
  if (canonicalContinuationSha256(projectionBody) !== projectionSha256) {
    return fail("capsule_projection_digest_mismatch");
  }
  const { capsule_sha256: capsuleSha256, ...capsuleBody } = capsule;
  if (canonicalContinuationSha256(capsuleBody) !== capsuleSha256) {
    return fail("capsule_digest_mismatch");
  }
  if (capsule.applicability.tenant_id !== tenantId
    || capsule.applicability.scope !== scope
    || capsule.source.source_commit_id !== commit.commit_id
    || capsule.created_at !== commit.created_at) {
    return fail("capsule_commit_binding_mismatch");
  }
  const source = items.get(capsule.source.memory_id);
  if (!source || source.projection_sha256 !== capsule.source.source_projection_sha256) {
    return fail("capsule_source_projection_mismatch");
  }
  const preceding = capsule.capsule_revision === 1
    ? undefined
    : capsules.get(`${capsule.capsule_id}\0${String(
      capsule.capsule_revision - 1,
    ).padStart(16, "0")}`);
  if (capsule.capsule_revision === 1) {
    if (preceding || capsule.parent_capsule_sha256 !== null) {
      return fail("capsule_parent_mismatch");
    }
  } else if (!preceding
    || preceding.capsule.capsule_revision !== capsule.capsule_revision - 1
    || preceding.capsule.capsule_sha256 !== capsule.parent_capsule_sha256
    || capsuleProfile(preceding.capsule) !== capsuleProfile(capsule)) {
    return fail("capsule_parent_mismatch");
  }
  for (const ref of [...capsule.conflicts_with, ...capsule.supersedes]) {
    const target = capsules.get(
      `${ref.capsule_id}\0${String(ref.capsule_revision).padStart(16, "0")}`,
    );
    if (!target || target.capsule.capsule_sha256 !== ref.capsule_sha256
      || capsuleProfile(target.capsule) !== capsuleProfile(capsule)) {
      return fail("capsule_relation_ref_mismatch");
    }
  }
  return canonicalContinuationClone({
    capsule,
    source_commit_revision: commit.revision,
    source_commit_id: commit.commit_id,
    source_commit_sha256: commit.commit_sha256,
  });
}

function replay(
  tenantId: string,
  scope: string,
  taskFamily: string,
  head: HistoricalMemoryProjectionV1["head"],
  commits: readonly VerifiedMemoryCommitV1[],
): HistoricalMemoryProjectionV1 {
  const items = new Map<string, HistoricalMemoryItemV1>();
  const relations = new Map<string, HistoricalMemoryRelationV1>();
  const capsules = new Map<string, HistoricalMemoryCapsuleV1>();
  for (const commit of commits) {
    const mutation = parseCanonicalObject(commit.mutation_json, "commit_mutation_json");
    const itemValues = mutation.items as readonly unknown[];
    const relationValues = mutation.relations as readonly unknown[];
    const capsuleValues = mutation.capsules as readonly unknown[];
    const itemMutations = itemValues.map(parseItem);
    const relationMutations = relationValues.map(parseRelation);
    ensureSortedUnique(itemMutations, (item) => item.memory_id, "item_mutations");
    ensureSortedUnique(relationMutations, (relation) => relation.relation_id, "relation_mutations");
    for (const item of itemMutations) {
      const existing = items.get(item.memory_id);
      if (!existing && item.lifecycle !== "active") {
        fail("initial_lifecycle_invalid");
      }
      if (item.lifecycle === "archived") {
        const tombstone = item.projection as Readonly<{
          source_projection_sha256: CanonicalJson;
        }>;
        if (!existing || existing.lifecycle === "archived"
          || (existing.lifecycle !== "active" && existing.lifecycle !== "suppressed")
          || commit.source_operation.operation_kind !== "authority_decision"
          || commit.source_operation.actor_kind !== "operator"
          || tombstone.source_projection_sha256 !== existing.projection_sha256) {
          fail("archive_transition_invalid");
        }
      } else if (existing?.lifecycle === "archived") {
        fail("archived_item_not_terminal");
      } else if (existing?.lifecycle === "quarantined") {
        fail("quarantined_item_not_terminal");
      } else if (existing && existing.lifecycle !== item.lifecycle) {
        const allowed = (existing.lifecycle === "active" && item.lifecycle === "suppressed")
          || (existing.lifecycle === "suppressed" && item.lifecycle === "active")
          || ((existing.lifecycle === "active" || existing.lifecycle === "suppressed")
            && item.lifecycle === "quarantined");
        if (!allowed
          || commit.source_operation.operation_kind !== "authority_decision"
          || commit.source_operation.actor_kind !== "operator") {
          fail("lifecycle_transition_invalid");
        }
      }
      const projectionSha256 = canonicalContinuationSha256(item.projection);
      const createdAt = existing?.created_at ?? commit.created_at;
      const rowBody = {
        tenant_id: tenantId,
        scope,
        memory_id: item.memory_id,
        memory_kind: item.memory_kind,
        lifecycle: item.lifecycle,
        authority: item.authority,
        hydrated: item.hydrated,
        projection_sha256: projectionSha256,
        rehydration_ref: item.rehydration_ref,
        source_commit_revision: commit.revision,
        source_commit_id: commit.commit_id,
        source_commit_sha256: commit.commit_sha256,
        expires_at: item.expires_at,
        created_at: createdAt,
        updated_at: commit.created_at,
      } as const;
      items.set(item.memory_id, canonicalContinuationClone({
        memory_id: item.memory_id,
        memory_kind: item.memory_kind,
        lifecycle: item.lifecycle,
        authority: item.authority,
        hydrated: item.hydrated,
        projection_sha256: projectionSha256,
        projection: item.projection,
        rehydration_ref: item.rehydration_ref,
        source_commit_revision: commit.revision,
        source_commit_id: commit.commit_id,
        source_commit_sha256: commit.commit_sha256,
        row_sha256: canonicalContinuationSha256(rowBody),
        expires_at: item.expires_at,
        created_at: createdAt,
        updated_at: commit.created_at,
      }));
    }
    for (const relation of relationMutations) {
      if (!items.has(relation.source_memory_id) || !items.has(relation.target_memory_id)) {
        fail("relation_endpoint_missing");
      }
      const existing = relations.get(relation.relation_id);
      const projectionSha256 = canonicalContinuationSha256(relation.projection);
      const createdAt = existing?.created_at ?? commit.created_at;
      const rowBody = {
        tenant_id: tenantId,
        scope,
        relation_id: relation.relation_id,
        relation_kind: relation.relation_kind,
        lifecycle: relation.lifecycle,
        source_memory_id: relation.source_memory_id,
        target_memory_id: relation.target_memory_id,
        projection_sha256: projectionSha256,
        source_commit_revision: commit.revision,
        source_commit_id: commit.commit_id,
        source_commit_sha256: commit.commit_sha256,
        created_at: createdAt,
        updated_at: commit.created_at,
      } as const;
      relations.set(relation.relation_id, canonicalContinuationClone({
        relation_id: relation.relation_id,
        relation_kind: relation.relation_kind,
        lifecycle: relation.lifecycle,
        source_memory_id: relation.source_memory_id,
        target_memory_id: relation.target_memory_id,
        projection_sha256: projectionSha256,
        projection: relation.projection,
        source_commit_revision: commit.revision,
        source_commit_id: commit.commit_id,
        source_commit_sha256: commit.commit_sha256,
        row_sha256: canonicalContinuationSha256(rowBody),
        created_at: createdAt,
        updated_at: commit.created_at,
      }));
    }
    const verifiedCapsules = capsuleValues.map((value) => verifyCapsule(
      value,
      tenantId,
      scope,
      commit,
      items,
      capsules,
    ));
    ensureSortedUnique(
      verifiedCapsules,
      (entry) => entry.capsule.capsule_id,
      "capsule_mutations",
    );
    for (const capsule of verifiedCapsules) {
      const key = capsuleKey(capsule.capsule);
      if (capsules.has(key)) fail("capsule_revision_duplicate");
      capsules.set(key, capsule);
    }
    if (items.size + relations.size + capsules.size > MAX_HISTORY_ENTITY_COUNT) {
      fail("entity_count_limit_exceeded");
    }
    const relationTupleKeys = new Set<string>();
    for (const relation of relations.values()) {
      const key = `${relation.relation_kind}\0${relation.source_memory_id}\0${relation.target_memory_id}`;
      if (relationTupleKeys.has(key)) fail("relation_tuple_duplicate");
      relationTupleKeys.add(key);
    }
  }
  const auditCapsules = [...capsules.values()]
    .filter((entry) => entry.capsule.applicability.task_family === taskFamily)
    .sort((left, right) => compareCanonicalUtf8(
      capsuleKey(left.capsule),
      capsuleKey(right.capsule),
    ));
  const auditMemoryIds = new Set(
    auditCapsules.map((entry) => entry.capsule.source.memory_id),
  );
  const auditItems = [...items.values()]
    .filter((item) => auditMemoryIds.has(item.memory_id))
    .sort((left, right) => compareCanonicalUtf8(left.memory_id, right.memory_id));
  const auditRelations = [...relations.values()]
    .filter((relation) => auditMemoryIds.has(relation.source_memory_id)
      && auditMemoryIds.has(relation.target_memory_id))
    .sort((left, right) => compareCanonicalUtf8(left.relation_id, right.relation_id));
  const latestCapsuleRevision = new Map<string, number>();
  for (const entry of auditCapsules) {
    latestCapsuleRevision.set(entry.capsule.capsule_id, entry.capsule.capsule_revision);
  }
  const continuityRecords = auditCapsules.flatMap((entry) => {
    const capsule = entry.capsule;
    if (latestCapsuleRevision.get(capsule.capsule_id) !== capsule.capsule_revision
      || !CONTINUITY_KINDS.has(capsule.kind)) return [];
    const item = items.get(capsule.source.memory_id);
    if (!item
      || item.lifecycle !== "active"
      || (item.authority !== "verified" && item.authority !== "authoritative")
      || !item.hydrated
      || item.memory_kind !== capsule.kind
      || item.projection_sha256 !== capsule.source.source_projection_sha256) return [];
    return [{ item, capsule: entry }];
  });
  const body = {
    schema_version: "historical_memory_projection_v1" as const,
    tenant_id: tenantId,
    scope,
    task_family: taskFamily,
    head,
    verified_commit_count: commits.length,
    audit_items: auditItems,
    audit_relations: auditRelations,
    audit_capsules: auditCapsules,
    continuity_records: continuityRecords,
  };
  return canonicalContinuationClone({
    ...body,
    projection_sha256: canonicalContinuationSha256(body),
  });
}

export function assertContinuationRuntimeV1MemoryHistoryStore(
  value: unknown,
  database: ContinuationRuntimeV1Database,
): asserts value is ReturnType<typeof createContinuationRuntimeV1MemoryHistoryStore> {
  if (value === null || typeof value !== "object"
    || HISTORY_STORES.get(value) !== database) {
    fail("store_invalid");
  }
}

export function createContinuationRuntimeV1MemoryHistoryStore(
  database: ContinuationRuntimeV1Database,
) {
  const store = Object.freeze({
    async readHistoricalProjection(
      value: HistoricalMemoryProjectionRequestV1,
    ): Promise<HistoricalMemoryProjectionV1> {
      const request = exactRecord(value, [
        "tenant_id", "scope", "task_family", "memory_scope_head_revision",
        "memory_scope_head_sha256",
      ], "request");
      const tenantId = text(request.tenant_id, 256, "tenant_id");
      const scope = text(request.scope, 256, "scope");
      const taskFamily = text(request.task_family, 256, "task_family");
      const targetRevision = positiveInteger(
        request.memory_scope_head_revision,
        "memory_scope_head_revision",
      );
      const targetHeadSha256 = sha256(
        request.memory_scope_head_sha256,
        "memory_scope_head_sha256",
      );
      if (targetRevision > MAX_HISTORY_DEPTH) return fail("depth_limit_exceeded");
      return database.read(() => {
        const commits = readVerifiedCommitChain(
          database,
          tenantId,
          scope,
          targetRevision,
        );
        const target = commits.at(-1);
        if (!target) return fail("head_not_found");
        const head = historicalHead(tenantId, scope, target);
        if (head.head_sha256 !== targetHeadSha256) return fail("head_digest_mismatch");
        return replay(
          tenantId,
          scope,
          taskFamily,
          head,
          commits,
        );
      });
    },
  });
  HISTORY_STORES.set(store, database);
  return store;
}
