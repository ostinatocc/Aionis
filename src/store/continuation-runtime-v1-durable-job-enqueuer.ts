import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationJson,
  type CanonicalJson,
} from "../continuation/contract.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../continuation/task-envelope.js";
import { sha256Hex } from "../util/crypto.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  continuationRuntimeV1OperationLineage,
  type ContinuationRuntimeV1AuthorityWriteContext,
} from "./continuation-runtime-v1-operation-store.js";

const JOB_KINDS = Object.freeze([
  "embedding",
  "ann",
  "effect",
  "retention",
] as const);
const JOB_KIND_SET = new Set<string>(JOB_KINDS);
const ENQUEUE_KEYS = Object.freeze([
  "authority_subject_sha256", "available_at", "dedupe_key", "job_kind",
  "max_attempts", "payload", "priority", "task_family",
]);
const PAYLOAD_MAX_BYTES = 262_144;
const SHA256 = /^[0-9a-f]{64}$/u;

export type ContinuationRuntimeV1DurableJobEnqueueKind =
  typeof JOB_KINDS[number];
export type ContinuationRuntimeV1DurableJobEnqueuePayload = Readonly<{
  [key: string]: CanonicalJson;
}>;
export type EnqueueContinuationRuntimeV1DurableJobArgs = Readonly<{
  task_family: string;
  authority_subject_sha256: string;
  job_kind: ContinuationRuntimeV1DurableJobEnqueueKind;
  dedupe_key: string;
  priority: number;
  max_attempts: number;
  payload: ContinuationRuntimeV1DurableJobEnqueuePayload;
  available_at: string;
}>;
export type ContinuationRuntimeV1DurableJobEnqueueReceipt = Readonly<{
  job_id: string;
  payload_sha256: string;
}>;
export type ContinuationRuntimeV1DurableJobEnqueuerOptions = Readonly<{
  now?: () => string;
}>;

export class ContinuationRuntimeV1DurableJobEnqueuePayloadConflictError
  extends Error {
  constructor(
    readonly jobId: string,
    readonly storedPayloadSha256: string,
    readonly receivedPayloadSha256: string,
  ) {
    super("continuation_runtime_v1_durable_job_payload_conflict");
    this.name = "ContinuationRuntimeV1DurableJobEnqueuePayloadConflictError";
  }
}

export class ContinuationRuntimeV1DurableJobEnqueueDefinitionConflictError
  extends Error {
  constructor(readonly jobId: string) {
    super("continuation_runtime_v1_durable_job_definition_conflict");
    this.name = "ContinuationRuntimeV1DurableJobEnqueueDefinitionConflictError";
  }
}

type ImmutableJobRow = {
  tenant_id: unknown;
  scope: unknown;
  task_family: unknown;
  authority_subject_sha256: unknown;
  job_id: unknown;
  job_kind: unknown;
  dedupe_key: unknown;
  source_operation_kind: unknown;
  source_operation_id: unknown;
  source_request_sha256: unknown;
  priority: unknown;
  max_attempts: unknown;
  payload_sha256: unknown;
  payload_json: unknown;
  initial_available_at: unknown;
  created_at: unknown;
};

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_durable_job_enqueue_${code}`);
}

function exactShape(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("shape_invalid");
  }
  const actual = Object.keys(value).sort();
  if (actual.length !== ENQUEUE_KEYS.length
    || actual.some((key, index) => key !== ENQUEUE_KEYS[index])) {
    fail("shape_invalid");
  }
}

function canonicalText(
  value: unknown,
  maximumBytes: number,
  field: string,
): asserts value is string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `durable_job_enqueue.${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail(`${field}_invalid`);
  }
}

function timestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  try {
    assertCanonicalUtcMillis(value, `durable_job_enqueue.${field}`);
  } catch {
    fail(`${field}_invalid`);
  }
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum
    || Number(value) > maximum) fail(`${field}_invalid`);
}

function canonicalPayload(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("payload_must_be_object");
  }
  let json: string;
  try {
    json = canonicalContinuationJson(value);
  } catch {
    fail("payload_invalid");
  }
  if (Buffer.byteLength(json, "utf8") > PAYLOAD_MAX_BYTES) {
    fail("payload_too_large");
  }
  return json;
}

function supportsSource(
  jobKind: ContinuationRuntimeV1DurableJobEnqueueKind,
  operationKind: string,
): boolean {
  return (jobKind === "embedding" && operationKind === "record_observations")
    || (jobKind === "ann" && operationKind === "worker_completion")
    || (jobKind === "effect" && operationKind === "authority_decision")
    || (jobKind === "retention" && operationKind === "authority_decision");
}

function deriveJobId(
  tenantId: string,
  scope: string,
  jobKind: ContinuationRuntimeV1DurableJobEnqueueKind,
  dedupeKey: string,
): string {
  return `job_${sha256Hex(canonicalContinuationJson({
    schema_version: "continuation_runtime_durable_job_identity_v1",
    tenant_id: tenantId,
    scope,
    job_kind: jobKind,
    dedupe_key: dedupeKey,
  }))}`;
}

function validateStoredRow(row: ImmutableJobRow): void {
  canonicalText(row.tenant_id, 256, "stored_tenant_id");
  canonicalText(row.scope, 256, "stored_scope");
  canonicalText(row.task_family, 256, "stored_task_family");
  canonicalText(row.job_id, 256, "stored_job_id");
  canonicalText(row.dedupe_key, 512, "stored_dedupe_key");
  if (typeof row.authority_subject_sha256 !== "string"
    || !SHA256.test(row.authority_subject_sha256)
    || row.authority_subject_sha256 !== continuationAuthoritySubjectSha256V1({
      tenant_id: row.tenant_id,
      scope: row.scope,
      task_family: row.task_family,
    })) fail("stored_authority_subject_invalid");
  if (typeof row.job_kind !== "string" || !JOB_KIND_SET.has(row.job_kind)
    || !supportsSource(
      row.job_kind as ContinuationRuntimeV1DurableJobEnqueueKind,
      String(row.source_operation_kind),
    )) fail("stored_kind_invalid");
  canonicalText(row.source_operation_id, 256, "stored_source_operation_id");
  if (typeof row.source_request_sha256 !== "string"
    || !SHA256.test(row.source_request_sha256)) {
    fail("stored_source_request_invalid");
  }
  integer(row.priority, -1_000_000, 1_000_000, "stored_priority");
  integer(row.max_attempts, 1, 1_000, "stored_max_attempts");
  timestamp(row.initial_available_at, "stored_initial_available_at");
  timestamp(row.created_at, "stored_created_at");
  if (typeof row.payload_sha256 !== "string" || !SHA256.test(row.payload_sha256)
    || typeof row.payload_json !== "string"
    || Buffer.byteLength(row.payload_json, "utf8") > PAYLOAD_MAX_BYTES
    || sha256Hex(row.payload_json) !== row.payload_sha256) {
    fail("stored_payload_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json) as unknown;
  } catch {
    fail("stored_payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || canonicalContinuationJson(parsed) !== row.payload_json) {
    fail("stored_payload_invalid");
  }
  const expectedId = deriveJobId(
    row.tenant_id,
    row.scope,
    row.job_kind as ContinuationRuntimeV1DurableJobEnqueueKind,
    row.dedupe_key,
  );
  if (row.job_id !== expectedId) fail("stored_identity_invalid");
}

const IMMUTABLE_COLUMNS = `tenant_id, scope, task_family,
  authority_subject_sha256, job_id, job_kind, dedupe_key,
  source_operation_kind, source_operation_id, source_request_sha256,
  priority, max_attempts, payload_sha256, payload_json,
  initial_available_at, created_at`;

/**
 * Creates the only durable-job capability admitted to daemon and offline
 * provisioning closures. Leasing and terminal transitions live in the worker
 * store and are not reachable through this object.
 */
export function createContinuationRuntimeV1DurableJobEnqueuer(
  database: ContinuationRuntimeV1Database,
  options: ContinuationRuntimeV1DurableJobEnqueuerOptions = {},
) {
  const now = options.now ?? (() => new Date().toISOString());

  const byId = (tenantId: string, scope: string, jobId: string) =>
    database.db.prepare(`SELECT ${IMMUTABLE_COLUMNS} FROM durable_jobs
      WHERE tenant_id = ? AND scope = ? AND job_id = ?`).get(
      tenantId,
      scope,
      jobId,
    ) as ImmutableJobRow | undefined;

  return Object.freeze({
    async enqueue(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      args: EnqueueContinuationRuntimeV1DurableJobArgs,
    ): Promise<ContinuationRuntimeV1DurableJobEnqueueReceipt> {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        database,
      );
      exactShape(args);
      if (!JOB_KIND_SET.has(args.job_kind)) fail("kind_invalid");
      if (!supportsSource(args.job_kind, binding.operationKind)) {
        fail("source_operation_kind_invalid");
      }
      canonicalText(args.task_family, 256, "task_family");
      try {
        assertSha256(
          args.authority_subject_sha256,
          "durable_job_enqueue.authority_subject_sha256",
        );
      } catch {
        fail("authority_subject_invalid");
      }
      if (args.authority_subject_sha256 !== continuationAuthoritySubjectSha256V1({
        tenant_id: binding.tenantId,
        scope: binding.scope,
        task_family: args.task_family,
      })) fail("authority_subject_mismatch");
      canonicalText(args.dedupe_key, 512, "dedupe_key");
      integer(args.priority, -1_000_000, 1_000_000, "priority");
      integer(args.max_attempts, 1, 1_000, "max_attempts");
      timestamp(args.available_at, "available_at");
      const payloadJson = canonicalPayload(args.payload);
      const payloadSha256 = sha256Hex(payloadJson);
      const source = continuationRuntimeV1OperationLineage(binding);
      const jobId = deriveJobId(
        binding.tenantId,
        binding.scope,
        args.job_kind,
        args.dedupe_key,
      );
      const existing = database.db.prepare(
        `SELECT ${IMMUTABLE_COLUMNS} FROM durable_jobs
          WHERE tenant_id = ? AND scope = ? AND job_kind = ? AND dedupe_key = ?`,
      ).get(
        binding.tenantId,
        binding.scope,
        args.job_kind,
        args.dedupe_key,
      ) as ImmutableJobRow | undefined;
      if (existing) {
        validateStoredRow(existing);
        if (existing.payload_sha256 !== payloadSha256
          || existing.payload_json !== payloadJson) {
          throw new ContinuationRuntimeV1DurableJobEnqueuePayloadConflictError(
            existing.job_id as string,
            existing.payload_sha256 as string,
            payloadSha256,
          );
        }
        const availableAt = args.available_at < (existing.created_at as string)
          ? existing.created_at
          : args.available_at;
        if (existing.job_id !== jobId
          || existing.task_family !== args.task_family
          || existing.authority_subject_sha256 !== args.authority_subject_sha256
          || existing.priority !== args.priority
          || existing.max_attempts !== args.max_attempts
          || existing.initial_available_at !== availableAt
          || existing.source_operation_kind !== source.operation_kind
          || existing.source_operation_id !== source.operation_id
          || existing.source_request_sha256 !== source.request_sha256) {
          throw new ContinuationRuntimeV1DurableJobEnqueueDefinitionConflictError(
            existing.job_id as string,
          );
        }
        return Object.freeze({ job_id: jobId, payload_sha256: payloadSha256 });
      }
      const collision = byId(binding.tenantId, binding.scope, jobId);
      if (collision) {
        validateStoredRow(collision);
        fail("identity_collision");
      }
      const createdAt = now();
      timestamp(createdAt, "created_at");
      const availableAt = args.available_at < createdAt
        ? createdAt
        : args.available_at;
      database.db.prepare(`INSERT INTO durable_jobs(
        tenant_id, scope, task_family, authority_subject_sha256,
        job_id, job_kind, dedupe_key,
        source_operation_kind, source_operation_id, source_request_sha256,
        state, priority, attempt_count, max_attempts, payload_sha256,
        payload_json, initial_available_at, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?, ?, ?)`).run(
        binding.tenantId,
        binding.scope,
        args.task_family,
        args.authority_subject_sha256,
        jobId,
        args.job_kind,
        args.dedupe_key,
        source.operation_kind,
        source.operation_id,
        source.request_sha256,
        args.priority,
        args.max_attempts,
        payloadSha256,
        payloadJson,
        availableAt,
        availableAt,
        createdAt,
        createdAt,
      );
      const inserted = byId(binding.tenantId, binding.scope, jobId);
      if (!inserted) fail("postwrite_missing");
      validateStoredRow(inserted);
      return Object.freeze({ job_id: jobId, payload_sha256: payloadSha256 });
    },
  });
}
