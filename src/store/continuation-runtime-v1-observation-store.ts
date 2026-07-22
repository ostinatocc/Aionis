import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type HostObservationV1,
  type HostObservationValueV1,
  type Sha256,
} from "../continuation/contract.js";
import { buildAuthenticatedCollectorObservationV1 } from
  "../continuation/observation-attestation.js";
import {
  buildHostTaskEnvelopeFromAuthenticatedScopeV1,
  verifyHostTaskEnvelopeV1,
  type HostTaskEnvelopeInputV1,
} from "../continuation/task-envelope.js";
import {
  buildWorldObservationSnapshotV1,
  type WorldObservationSnapshotV1,
} from "../continuation/world-snapshot.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  deriveContinuationRuntimeV1OperationResultV1,
} from "./continuation-runtime-v1-operation-result-derivation.js";
import {
  assertContinuationRuntimeV1OperationResultDeclaration,
} from "./continuation-runtime-v1-operation-result-support.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  continuationRuntimeV1OperationLineage,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";

export type CollectorObservationInputV1 = Readonly<{
  schema_version: "collector_observation_v1";
  observation_id: string;
  probe_id: string;
  probe_spec_sha256: Sha256;
  observed_at: string;
  expires_at: string;
  value: HostObservationValueV1;
  evidence_sha256: Sha256;
}>;

export type PutObservationSnapshotV1 = Readonly<{
  /** Raw host body. Authenticated tenant/scope/authority fields are forbidden. */
  host_task_envelope: HostTaskEnvelopeInputV1;
  collector_observations: readonly CollectorObservationInputV1[];
  signed_observations: readonly HostObservationV1[];
}>;

export type ReadObservationSnapshotV1 = Readonly<{
  tenant_id: string;
  scope: string;
  world_snapshot_id: string;
}>;

export type PersistedObservationSnapshotV1 = Readonly<{
  snapshot: WorldObservationSnapshotV1;
  source_operation: ContinuationRuntimeV1OperationLineageV1;
}>;

export type ContinuationRuntimeV1ObservationStore = Readonly<{
  put(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    input: PutObservationSnapshotV1,
  ): Promise<PersistedObservationSnapshotV1>;
  read(input: ReadObservationSnapshotV1): Promise<PersistedObservationSnapshotV1 | null>;
}>;

export type ContinuationRuntimeV1ObservationStoreOptions = Readonly<{
  now?: () => string;
}>;

type SnapshotRow = Readonly<{
  tenant_id: unknown;
  scope: unknown;
  world_snapshot_id: unknown;
  world_snapshot_sha256: unknown;
  host_task_id: unknown;
  host_task_envelope_sha256: unknown;
  host_task_envelope_json: unknown;
  collection_principal_sha256: unknown;
  observation_count: unknown;
  observations_json: unknown;
  source_operation_kind: unknown;
  source_operation_id: unknown;
  source_request_sha256: unknown;
  observed_from: unknown;
  observed_through: unknown;
  expires_at: unknown;
  created_at: unknown;
  joined_operation_kind: unknown;
  joined_operation_id: unknown;
  joined_request_sha256: unknown;
  joined_request_json: unknown;
  joined_actor_kind: unknown;
  joined_actor_principal_sha256: unknown;
  joined_receipt_sha256: unknown;
  joined_receipt_json: unknown;
  joined_completed_at: unknown;
}>;

const PUT_KEYS = Object.freeze([
  "collector_observations",
  "host_task_envelope",
  "signed_observations",
] as const);
const COLLECTOR_OBSERVATION_KEYS = Object.freeze([
  "evidence_sha256",
  "expires_at",
  "observation_id",
  "observed_at",
  "probe_id",
  "probe_spec_sha256",
  "schema_version",
  "value",
] as const);
const READ_KEYS = Object.freeze([
  "scope",
  "tenant_id",
  "world_snapshot_id",
] as const);
const RECEIPT_KEYS = Object.freeze([
  "actor_kind",
  "actor_principal_sha256",
  "completed_at",
  "operation_id",
  "operation_kind",
  "request_sha256",
  "result",
  "schema_version",
  "scope",
  "tenant_id",
] as const);
const OBSERVATION_MUTATION_CONTEXTS = new WeakSet<object>();
const OBSERVATION_STORE_DATABASES = new WeakMap<object, ContinuationRuntimeV1Database>();

export function assertContinuationRuntimeV1ObservationStore(
  value: unknown,
  database: ContinuationRuntimeV1Database,
): asserts value is ReturnType<typeof createContinuationRuntimeV1ObservationStore> {
  if (value === null || typeof value !== "object"
    || OBSERVATION_STORE_DATABASES.get(value) !== database) {
    throw new Error("continuation_runtime_v1_observation_store_invalid");
  }
}

function exactArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`continuation_runtime_v1_observation_${field}_shape_invalid`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1
    || keys.some((key) => typeof key !== "string")) {
    throw new Error(`continuation_runtime_v1_observation_${field}_shape_invalid`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`continuation_runtime_v1_observation_${field}_shape_invalid`);
    }
    result.push(descriptor.value);
  }
  return result;
}

const SNAPSHOT_SELECT = `SELECT
  snapshots.tenant_id,
  snapshots.scope,
  snapshots.world_snapshot_id,
  snapshots.world_snapshot_sha256,
  snapshots.host_task_id,
  snapshots.host_task_envelope_sha256,
  snapshots.host_task_envelope_json,
  snapshots.collection_principal_sha256,
  snapshots.observation_count,
  snapshots.observations_json,
  snapshots.source_operation_kind,
  snapshots.source_operation_id,
  snapshots.source_request_sha256,
  snapshots.observed_from,
  snapshots.observed_through,
  snapshots.expires_at,
  snapshots.created_at,
  operations.operation_kind AS joined_operation_kind,
  operations.operation_id AS joined_operation_id,
  operations.request_sha256 AS joined_request_sha256,
  operations.request_json AS joined_request_json,
  operations.actor_kind AS joined_actor_kind,
  operations.actor_principal_sha256 AS joined_actor_principal_sha256,
  operations.receipt_sha256 AS joined_receipt_sha256,
  operations.receipt_json AS joined_receipt_json,
  operations.completed_at AS joined_completed_at
FROM observation_snapshots AS snapshots
LEFT JOIN operations AS operations
  ON operations.tenant_id = snapshots.tenant_id
 AND operations.scope = snapshots.scope
 AND operations.operation_kind = snapshots.source_operation_kind
 AND operations.operation_id = snapshots.source_operation_id
 AND operations.request_sha256 = snapshots.source_request_sha256
WHERE snapshots.tenant_id = ?
  AND snapshots.scope = ?
  AND snapshots.world_snapshot_id = ?`;

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`continuation_runtime_v1_observation_${field}_must_be_plain_object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`continuation_runtime_v1_observation_${field}_must_be_plain_object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new Error(`continuation_runtime_v1_observation_${field}_shape_invalid`);
  }
  const actual = [...ownKeys as string[]].sort(compareCanonicalUtf8);
  const expected = [...expectedKeys].sort(compareCanonicalUtf8);
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`continuation_runtime_v1_observation_${field}_shape_invalid`);
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`continuation_runtime_v1_observation_${field}_shape_invalid`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_observation_corrupt:${field}`);
  }
  assertUnicodeScalarString(value, `persisted observation ${field}`);
  if (value.length === 0
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) {
    throw new Error(`continuation_runtime_v1_observation_corrupt:${field}`);
  }
  return value;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_observation_corrupt:${field}`);
  }
  try {
    assertSha256(value, `persisted observation ${field}`);
  } catch (error) {
    throw new Error(`continuation_runtime_v1_observation_corrupt:${field}`, { cause: error });
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_observation_corrupt:${field}`);
  }
  try {
    assertCanonicalUtcMillis(value, `persisted observation ${field}`);
  } catch (error) {
    throw new Error(`continuation_runtime_v1_observation_corrupt:${field}`, { cause: error });
  }
  return value;
}

function canonicalJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_observation_corrupt:${field}_type`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`continuation_runtime_v1_observation_corrupt:${field}_parse`);
  }
  try {
    if (canonicalContinuationJson(parsed) !== value) {
      throw new Error("noncanonical");
    }
  } catch (error) {
    throw new Error(`continuation_runtime_v1_observation_corrupt:${field}_encoding`, {
      cause: error,
    });
  }
  return parsed;
}

function verifyJoinedOperation(
  database: ContinuationRuntimeV1Database,
  row: SnapshotRow,
  identity: Readonly<{
    tenantId: string;
    scope: string;
    operationId: string;
    requestSha256: string;
    collectorSha256: string;
    worldSnapshotSha256: string;
  }>,
): ContinuationRuntimeV1OperationLineageV1 {
  if (row.joined_operation_kind === null
    || row.joined_operation_id === null
    || row.joined_request_sha256 === null
    || row.joined_request_json === null
    || row.joined_actor_kind === null
    || row.joined_actor_principal_sha256 === null
    || row.joined_receipt_sha256 === null
    || row.joined_receipt_json === null
    || row.joined_completed_at === null) {
    throw new Error("continuation_runtime_v1_observation_corrupt:source_operation_missing");
  }
  if (row.joined_operation_kind !== "record_observations"
    || row.joined_operation_id !== identity.operationId
    || row.joined_request_sha256 !== identity.requestSha256
    || row.joined_actor_kind !== "trusted_host"
    || row.joined_actor_principal_sha256 !== identity.collectorSha256) {
    throw new Error("continuation_runtime_v1_observation_corrupt:source_operation_binding");
  }
  const receiptSha256 = sha256(row.joined_receipt_sha256, "receipt_sha256");
  if (typeof row.joined_request_json !== "string"
    || Buffer.byteLength(row.joined_request_json, "utf8") > 1_048_576) {
    throw new Error("continuation_runtime_v1_observation_corrupt:source_request_json");
  }
  const request = canonicalJson(row.joined_request_json, "request_json");
  if (canonicalContinuationSha256(request) !== identity.requestSha256) {
    throw new Error("continuation_runtime_v1_observation_corrupt:source_request_digest");
  }
  const completedAt = timestamp(row.joined_completed_at, "operation_completed_at");
  const receipt = canonicalJson(row.joined_receipt_json, "receipt_json");
  const receiptRecord = exactRecord(receipt, RECEIPT_KEYS, "persisted_receipt");
  if (canonicalContinuationSha256(receipt) !== receiptSha256
    || receiptRecord.schema_version !== "continuation_runtime_operation_receipt_v1"
    || receiptRecord.tenant_id !== identity.tenantId
    || receiptRecord.scope !== identity.scope
    || receiptRecord.operation_kind !== "record_observations"
    || receiptRecord.operation_id !== identity.operationId
    || receiptRecord.request_sha256 !== identity.requestSha256
    || receiptRecord.actor_kind !== "trusted_host"
    || receiptRecord.actor_principal_sha256 !== identity.collectorSha256
    || receiptRecord.completed_at !== completedAt) {
    throw new Error("continuation_runtime_v1_observation_corrupt:source_operation_receipt");
  }
  try {
    const derived = deriveContinuationRuntimeV1OperationResultV1(database, {
      tenantId: identity.tenantId,
      scope: identity.scope,
      operationKind: "record_observations",
      operationId: identity.operationId,
      requestSha256: identity.requestSha256,
      actorKind: "trusted_host",
      actorPrincipalSha256: identity.collectorSha256,
    }, "replay", receiptRecord.result);
    assertContinuationRuntimeV1OperationResultDeclaration(
      receiptRecord.result,
      derived,
    );
    if (derived.schema_version !== "record_observations_result_v1"
      || derived.observation_snapshot_ref.world_snapshot_id !== identity.operationId
      || derived.observation_snapshot_ref.world_snapshot_sha256
        !== identity.worldSnapshotSha256) {
      throw new Error("observation result mismatch");
    }
  } catch (error) {
    throw new Error(
      "continuation_runtime_v1_observation_corrupt:source_operation_result",
      { cause: error },
    );
  }
  return canonicalContinuationClone({
    tenant_id: identity.tenantId,
    scope: identity.scope,
    operation_kind: "record_observations" as const,
    operation_id: identity.operationId,
    request_sha256: identity.requestSha256,
    actor_kind: "trusted_host" as const,
    actor_principal_sha256: identity.collectorSha256,
  });
}

function decodeRow(
  database: ContinuationRuntimeV1Database,
  row: SnapshotRow,
): PersistedObservationSnapshotV1 {
  const tenantId = text(row.tenant_id, "tenant_id");
  const scope = text(row.scope, "scope");
  const worldSnapshotId = text(row.world_snapshot_id, "world_snapshot_id");
  const worldSnapshotSha256 = sha256(
    row.world_snapshot_sha256,
    "world_snapshot_sha256",
  );
  const hostTaskId = text(row.host_task_id, "host_task_id");
  const hostTaskEnvelopeSha256 = sha256(
    row.host_task_envelope_sha256,
    "host_task_envelope_sha256",
  );
  const collectorSha256 = sha256(
    row.collection_principal_sha256,
    "collection_principal_sha256",
  );
  const sourceOperationId = text(row.source_operation_id, "source_operation_id");
  const sourceRequestSha256 = sha256(
    row.source_request_sha256,
    "source_request_sha256",
  );
  if (row.source_operation_kind !== "record_observations"
    || sourceOperationId !== worldSnapshotId) {
    throw new Error("continuation_runtime_v1_observation_corrupt:source_operation_identity");
  }
  const observationCount = row.observation_count;
  if (!Number.isSafeInteger(observationCount)
    || (observationCount as number) < 0
    || (observationCount as number) > 2_048) {
    throw new Error("continuation_runtime_v1_observation_corrupt:observation_count");
  }
  const envelope = verifyHostTaskEnvelopeV1(
    canonicalJson(row.host_task_envelope_json, "host_task_envelope_json"),
  );
  if (envelope.host_task_id !== hostTaskId
    || envelope.host_task_envelope_sha256 !== hostTaskEnvelopeSha256) {
    throw new Error("continuation_runtime_v1_observation_corrupt:host_task_envelope_binding");
  }
  const observations = canonicalJson(row.observations_json, "observations_json");
  if (!Array.isArray(observations)
    || observations.length !== observationCount) {
    throw new Error("continuation_runtime_v1_observation_corrupt:observation_count_binding");
  }
  const snapshot = buildWorldObservationSnapshotV1({
    tenant_id: tenantId,
    scope,
    authority_subject_sha256: envelope.authority_subject_sha256,
    world_snapshot_id: worldSnapshotId,
    host_task_envelope: envelope,
    collection_principal_sha256: collectorSha256,
    observations: observations as readonly HostObservationV1[],
    created_at: timestamp(row.created_at, "created_at"),
  });
  if (snapshot.world_snapshot_sha256 !== worldSnapshotSha256
    || snapshot.observed_from !== timestamp(row.observed_from, "observed_from")
    || snapshot.observed_through !== timestamp(row.observed_through, "observed_through")
    || snapshot.expires_at !== timestamp(row.expires_at, "expires_at")) {
    throw new Error("continuation_runtime_v1_observation_corrupt:snapshot_digest_or_window");
  }
  const sourceOperation = verifyJoinedOperation(database, row, {
    tenantId,
    scope,
    operationId: sourceOperationId,
    requestSha256: sourceRequestSha256,
    collectorSha256,
    worldSnapshotSha256,
  });
  return canonicalContinuationClone({
    snapshot,
    source_operation: sourceOperation,
  });
}

function readIdentity(input: unknown): ReadObservationSnapshotV1 {
  const record = exactRecord(input, READ_KEYS, "read_input");
  return {
    tenant_id: text(record.tenant_id, "read_tenant_id"),
    scope: text(record.scope, "read_scope"),
    world_snapshot_id: text(record.world_snapshot_id, "read_world_snapshot_id"),
  };
}

export function createContinuationRuntimeV1ObservationStore(
  database: ContinuationRuntimeV1Database,
  options: ContinuationRuntimeV1ObservationStoreOptions = {},
): ContinuationRuntimeV1ObservationStore {
  const now = options.now ?? (() => new Date().toISOString());
  const store: ContinuationRuntimeV1ObservationStore = Object.freeze({
    async put(context, input) {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      if (binding.operationKind !== "record_observations"
        || binding.actorKind !== "trusted_host") {
        throw new Error("continuation_runtime_v1_observation_operation_authority_invalid");
      }
      if (OBSERVATION_MUTATION_CONTEXTS.has(context)) {
        throw new Error("continuation_runtime_v1_observation_context_already_used");
      }
      OBSERVATION_MUTATION_CONTEXTS.add(context);
      const record = exactRecord(input, PUT_KEYS, "put_input");
      const hostTaskEnvelope = buildHostTaskEnvelopeFromAuthenticatedScopeV1(
        record.host_task_envelope as HostTaskEnvelopeInputV1,
        { tenant_id: binding.tenantId, scope: binding.scope },
      );
      const collectorObservations = exactArray(
        record.collector_observations,
        "collector_observations",
      ).map((value) => {
        const observation = exactRecord(
          value,
          COLLECTOR_OBSERVATION_KEYS,
          "collector_observation",
        );
        if (observation.schema_version !== "collector_observation_v1") {
          throw new Error(
            "continuation_runtime_v1_observation_collector_observation_schema_invalid",
          );
        }
        return buildAuthenticatedCollectorObservationV1({
          schema_version: "host_observation_v1",
          observation_id: observation.observation_id as string,
          probe_id: observation.probe_id as string,
          probe_spec_sha256: observation.probe_spec_sha256 as Sha256,
          host_task_envelope_sha256: hostTaskEnvelope.host_task_envelope_sha256,
          world_snapshot_id: binding.operationId,
          observed_at: observation.observed_at as string,
          expires_at: observation.expires_at as string,
          value: observation.value as HostObservationValueV1,
          evidence_sha256: observation.evidence_sha256 as Sha256,
        }, binding.actorPrincipalSha256);
      });
      const signedObservations = exactArray(
        record.signed_observations,
        "signed_observations",
      ) as readonly HostObservationV1[];
      for (const observation of signedObservations) {
        if (observation === null || typeof observation !== "object"
          || Object.getOwnPropertyDescriptor(observation, "observer")?.value
            !== "external_verifier") {
          throw new Error(
            "continuation_runtime_v1_observation_signed_observer_role_invalid",
          );
        }
      }
      const snapshot = buildWorldObservationSnapshotV1({
        tenant_id: binding.tenantId,
        scope: binding.scope,
        authority_subject_sha256: hostTaskEnvelope.authority_subject_sha256,
        world_snapshot_id: binding.operationId,
        host_task_envelope: hostTaskEnvelope,
        collection_principal_sha256: binding.actorPrincipalSha256,
        observations: [...collectorObservations, ...signedObservations],
        created_at: now(),
      });
      for (const observation of snapshot.observations) {
        if (observation.observer === "trusted_host_collector"
          && observation.observer_principal_sha256 !== binding.actorPrincipalSha256) {
          throw new Error(
            "continuation_runtime_v1_observation_collector_principal_mismatch",
          );
        }
      }
      const sourceOperation = continuationRuntimeV1OperationLineage(binding);
      const envelopeJson = canonicalContinuationJson(snapshot.host_task_envelope);
      const observationsJson = canonicalContinuationJson(snapshot.observations);
      database.db.prepare(`INSERT INTO observation_snapshots(
        tenant_id,
        scope,
        world_snapshot_id,
        world_snapshot_sha256,
        host_task_id,
        host_task_envelope_sha256,
        host_task_envelope_json,
        collection_principal_sha256,
        observation_count,
        observations_json,
        source_operation_kind,
        source_operation_id,
        source_request_sha256,
        observed_from,
        observed_through,
        expires_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        snapshot.tenant_id,
        snapshot.scope,
        snapshot.world_snapshot_id,
        snapshot.world_snapshot_sha256,
        snapshot.host_task_envelope.host_task_id,
        snapshot.host_task_envelope.host_task_envelope_sha256,
        envelopeJson,
        snapshot.collection_principal_sha256,
        snapshot.observations.length,
        observationsJson,
        sourceOperation.operation_kind,
        sourceOperation.operation_id,
        sourceOperation.request_sha256,
        snapshot.observed_from,
        snapshot.observed_through,
        snapshot.expires_at,
        snapshot.created_at,
      );
      return canonicalContinuationClone({
        snapshot,
        source_operation: sourceOperation,
      });
    },

    async read(input) {
      const identity = readIdentity(input);
      return await database.read(() => {
        const row = database.db.prepare(SNAPSHOT_SELECT).get(
          identity.tenant_id,
          identity.scope,
          identity.world_snapshot_id,
        ) as SnapshotRow | undefined;
        return row ? decodeRow(database, row) : null;
      });
    },
  });
  OBSERVATION_STORE_DATABASES.set(store, database);
  return store;
}
