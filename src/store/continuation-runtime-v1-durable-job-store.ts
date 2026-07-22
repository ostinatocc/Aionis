import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  assertCanonicalUtcMillis,
  assertUnicodeScalarString,
  canonicalContinuationClone,
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
  constrainContinuationRuntimeV1OperationCompletion,
  continuationRuntimeV1OperationLineage,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";

export const CONTINUATION_RUNTIME_V1_DURABLE_JOB_KINDS = Object.freeze([
  "embedding",
  "ann",
  "effect",
  "retention",
] as const);

export type ContinuationRuntimeV1DurableJobKind =
  typeof CONTINUATION_RUNTIME_V1_DURABLE_JOB_KINDS[number];
export type ContinuationRuntimeV1DurableJobState =
  "queued" | "leased" | "succeeded" | "dead";
export type ContinuationRuntimeV1DurableJobTerminalReason =
  | "worker_succeeded"
  | "worker_dead"
  | "lease_expired_attempts_exhausted";
export type ContinuationRuntimeV1CanonicalObject = Readonly<{
  [key: string]: CanonicalJson;
}>;

export type ContinuationRuntimeV1DurableJob = Readonly<{
  tenant_id: string;
  scope: string;
  task_family: string;
  authority_subject_sha256: string;
  job_id: string;
  job_kind: ContinuationRuntimeV1DurableJobKind;
  dedupe_key: string;
  source_operation: ContinuationRuntimeV1OperationLineageV1;
  state: ContinuationRuntimeV1DurableJobState;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  payload_sha256: string;
  payload: ContinuationRuntimeV1CanonicalObject;
  initial_available_at: string;
  available_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_acquired_at: string | null;
  lease_expires_at: string | null;
  completed_at: string | null;
  terminal_reason: ContinuationRuntimeV1DurableJobTerminalReason | null;
  completion_operation: ContinuationRuntimeV1OperationLineageV1 | null;
  previous_completion_operation: ContinuationRuntimeV1OperationLineageV1 | null;
  last_error: ContinuationRuntimeV1CanonicalObject | null;
  created_at: string;
  updated_at: string;
}>;

export type LeaseNextContinuationRuntimeV1DurableJobArgs = Readonly<{
  tenant_id: string;
  job_kind: ContinuationRuntimeV1DurableJobKind;
  lease_owner: string;
  lease_duration_ms: number;
}>;

export type CompleteContinuationRuntimeV1DurableJobArgs = Readonly<{
  job_id: string;
  lease_token: string;
}>;

export type FailContinuationRuntimeV1DurableJobArgs = Readonly<{
  job_id: string;
  lease_token: string;
  disposition: "retry" | "dead";
  retry_at: string | null;
  error: ContinuationRuntimeV1CanonicalObject;
}>;

export type ReadContinuationRuntimeV1DurableJobArgs = Readonly<{
  tenant_id: string;
  scope: string;
  job_id: string;
}>;

export type ContinuationRuntimeV1DurableJobWorkerStore = Readonly<{
  leaseNext(
    args: LeaseNextContinuationRuntimeV1DurableJobArgs,
  ): Promise<ContinuationRuntimeV1DurableJob | null>;
  complete(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    args: CompleteContinuationRuntimeV1DurableJobArgs,
  ): Promise<ContinuationRuntimeV1DurableJob>;
  fail(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    args: FailContinuationRuntimeV1DurableJobArgs,
  ): Promise<ContinuationRuntimeV1DurableJob>;
  read(
    args: ReadContinuationRuntimeV1DurableJobArgs,
  ): Promise<ContinuationRuntimeV1DurableJob | null>;
}>;

type JobRow = {
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
  source_actor_kind: unknown;
  source_actor_principal_sha256: unknown;
  state: unknown;
  priority: unknown;
  attempt_count: unknown;
  max_attempts: unknown;
  payload_sha256: unknown;
  payload_json: unknown;
  initial_available_at: unknown;
  available_at: unknown;
  lease_owner: unknown;
  lease_token: unknown;
  lease_acquired_at: unknown;
  lease_expires_at: unknown;
  completed_at: unknown;
  terminal_reason: unknown;
  completion_operation_kind: unknown;
  completion_operation_id: unknown;
  completion_request_sha256: unknown;
  completion_actor_kind: unknown;
  completion_actor_principal_sha256: unknown;
  previous_completion_operation_kind: unknown;
  previous_completion_operation_id: unknown;
  previous_completion_request_sha256: unknown;
  previous_completion_actor_kind: unknown;
  previous_completion_actor_principal_sha256: unknown;
  last_error_json: unknown;
  created_at: unknown;
  updated_at: unknown;
};

const JOB_KIND_SET = new Set<string>(CONTINUATION_RUNTIME_V1_DURABLE_JOB_KINDS);
const STATE_SET = new Set<string>(["queued", "leased", "succeeded", "dead"]);
const SOURCE_OPERATION_KIND_SET = new Set<string>([
  "record_observations", "record_outcome", "authority_decision", "worker_completion",
]);
const TERMINAL_REASON_SET = new Set<string>([
  "worker_succeeded", "worker_dead", "lease_expired_attempts_exhausted",
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const PAYLOAD_MAX_BYTES = 262_144;
const ERROR_MAX_BYTES = 16_384;
const MIN_LEASE_DURATION_MS = 1_000;
const MAX_LEASE_DURATION_MS = 3_600_000;
const SELECT_COLUMNS = `tenant_id, scope, task_family, authority_subject_sha256,
  job_id, job_kind, dedupe_key, state,
  source_operation_kind, source_operation_id, source_request_sha256,
  priority, attempt_count, max_attempts, payload_sha256, payload_json,
  initial_available_at, available_at, lease_owner, lease_token,
  lease_acquired_at, lease_expires_at, completed_at, terminal_reason,
  completion_operation_kind, completion_operation_id,
  completion_request_sha256, previous_completion_operation_kind,
  previous_completion_operation_id, previous_completion_request_sha256,
  last_error_json,
  created_at, updated_at,
  (SELECT actor_kind FROM operations AS source_operation
    WHERE source_operation.tenant_id = durable_jobs.tenant_id
      AND source_operation.scope = durable_jobs.scope
      AND source_operation.operation_kind = durable_jobs.source_operation_kind
      AND source_operation.operation_id = durable_jobs.source_operation_id
      AND source_operation.request_sha256 = durable_jobs.source_request_sha256
  ) AS source_actor_kind,
  (SELECT actor_principal_sha256 FROM operations AS source_operation
    WHERE source_operation.tenant_id = durable_jobs.tenant_id
      AND source_operation.scope = durable_jobs.scope
      AND source_operation.operation_kind = durable_jobs.source_operation_kind
      AND source_operation.operation_id = durable_jobs.source_operation_id
      AND source_operation.request_sha256 = durable_jobs.source_request_sha256
  ) AS source_actor_principal_sha256,
  (SELECT actor_kind FROM operations AS completion_operation
    WHERE completion_operation.tenant_id = durable_jobs.tenant_id
      AND completion_operation.scope = durable_jobs.scope
      AND completion_operation.operation_kind = durable_jobs.completion_operation_kind
      AND completion_operation.operation_id = durable_jobs.completion_operation_id
      AND completion_operation.request_sha256 = durable_jobs.completion_request_sha256
  ) AS completion_actor_kind,
  (SELECT actor_principal_sha256 FROM operations AS completion_operation
    WHERE completion_operation.tenant_id = durable_jobs.tenant_id
      AND completion_operation.scope = durable_jobs.scope
      AND completion_operation.operation_kind = durable_jobs.completion_operation_kind
      AND completion_operation.operation_id = durable_jobs.completion_operation_id
      AND completion_operation.request_sha256 = durable_jobs.completion_request_sha256
  ) AS completion_actor_principal_sha256,
  (SELECT actor_kind FROM operations AS previous_completion_operation
    WHERE previous_completion_operation.tenant_id = durable_jobs.tenant_id
      AND previous_completion_operation.scope = durable_jobs.scope
      AND previous_completion_operation.operation_kind =
        durable_jobs.previous_completion_operation_kind
      AND previous_completion_operation.operation_id =
        durable_jobs.previous_completion_operation_id
      AND previous_completion_operation.request_sha256 =
        durable_jobs.previous_completion_request_sha256
  ) AS previous_completion_actor_kind,
  (SELECT actor_principal_sha256 FROM operations AS previous_completion_operation
    WHERE previous_completion_operation.tenant_id = durable_jobs.tenant_id
      AND previous_completion_operation.scope = durable_jobs.scope
      AND previous_completion_operation.operation_kind =
        durable_jobs.previous_completion_operation_kind
      AND previous_completion_operation.operation_id =
        durable_jobs.previous_completion_operation_id
      AND previous_completion_operation.request_sha256 =
        durable_jobs.previous_completion_request_sha256
  ) AS previous_completion_actor_principal_sha256`;

const LEASE_KEYS = Object.freeze([
  "job_kind", "lease_duration_ms", "lease_owner", "tenant_id",
]);
const COMPLETE_KEYS = Object.freeze(["job_id", "lease_token"]);
const FAIL_KEYS = Object.freeze([
  "disposition", "error", "job_id", "lease_token", "retry_at",
]);
const READ_KEYS = Object.freeze(["job_id", "scope", "tenant_id"]);

function exactShape(value: unknown, expected: readonly string[], field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`continuation_runtime_v1_durable_job_${field}_shape_invalid`);
  }
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`continuation_runtime_v1_durable_job_${field}_shape_invalid`);
  }
}

function canonicalText(
  value: unknown,
  maxBytes: number,
  field: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_durable_job_${field}_invalid`);
  }
  assertUnicodeScalarString(value, `durable_job.${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`continuation_runtime_v1_durable_job_${field}_invalid`);
  }
}

function timestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_durable_job_${field}_invalid`);
  }
  try {
    assertCanonicalUtcMillis(value, `durable_job.${field}`);
  } catch (error) {
    throw new Error(`continuation_runtime_v1_durable_job_${field}_invalid`, {
      cause: error,
    });
  }
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`continuation_runtime_v1_durable_job_${field}_invalid`);
  }
}

function canonicalObjectJson(value: unknown, maximum: number, field: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`continuation_runtime_v1_durable_job_${field}_must_be_object`);
  }
  let json: string;
  try {
    json = canonicalContinuationJson(value);
  } catch (error) {
    throw new Error(`continuation_runtime_v1_durable_job_${field}_invalid`, { cause: error });
  }
  if (Buffer.byteLength(json, "utf8") > maximum) {
    throw new Error(`continuation_runtime_v1_durable_job_${field}_too_large`);
  }
  return json;
}

function parseCanonicalObject(
  value: unknown,
  maximum: number,
  field: string,
): ContinuationRuntimeV1CanonicalObject {
  if (typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`continuation_runtime_v1_durable_job_corrupt:${field}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`continuation_runtime_v1_durable_job_corrupt:${field}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || canonicalContinuationJson(parsed) !== value) {
    throw new Error(`continuation_runtime_v1_durable_job_corrupt:${field}`);
  }
  return canonicalContinuationClone(parsed as ContinuationRuntimeV1CanonicalObject);
}

function deriveJobId(
  tenantId: string,
  scope: string,
  jobKind: ContinuationRuntimeV1DurableJobKind,
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

function addMilliseconds(value: string, duration: number): string {
  timestamp(value, "lease_acquired_at");
  const milliseconds = Date.parse(value) + duration;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("continuation_runtime_v1_durable_job_lease_expiry_overflow");
  }
  const result = new Date(milliseconds).toISOString();
  timestamp(result, "lease_expires_at");
  return result;
}

function leaseCompletionDeadline(leaseExpiresAt: string): string {
  timestamp(leaseExpiresAt, "lease_expires_at");
  const deadlineMilliseconds = Date.parse(leaseExpiresAt) - 1;
  if (!Number.isSafeInteger(deadlineMilliseconds)) {
    throw new Error("continuation_runtime_v1_durable_job_lease_deadline_invalid");
  }
  const deadline = new Date(deadlineMilliseconds).toISOString();
  timestamp(deadline, "lease_completion_deadline");
  return deadline;
}

function sameToken(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sourceOperationSupportsJob(
  jobKind: ContinuationRuntimeV1DurableJobKind,
  operationKind: string,
): boolean {
  return (jobKind === "embedding" && operationKind === "record_observations")
    || (jobKind === "ann" && operationKind === "worker_completion")
    || (jobKind === "effect" && operationKind === "authority_decision")
    || (jobKind === "retention" && operationKind === "authority_decision");
}

function actorKindForOperation(
  operationKind: ContinuationRuntimeV1OperationLineageV1["operation_kind"],
): ContinuationRuntimeV1OperationLineageV1["actor_kind"] {
  if (operationKind === "authority_decision") return "operator";
  if (operationKind === "worker_completion") return "worker";
  return "trusted_host";
}

function lineageWithActor(args: {
  tenantId: string;
  scope: string;
  operationKind: ContinuationRuntimeV1OperationLineageV1["operation_kind"];
  operationId: string;
  requestSha256: string;
  actorKind: unknown;
  actorPrincipalSha256: unknown;
  fallback?: ContinuationRuntimeV1OperationLineageV1;
  field: string;
}): ContinuationRuntimeV1OperationLineageV1 {
  let lineage: ContinuationRuntimeV1OperationLineageV1;
  if (args.actorKind === null && args.actorPrincipalSha256 === null) {
    if (!args.fallback) {
      throw new Error(
        `continuation_runtime_v1_durable_job_corrupt:${args.field}_operation_missing`,
      );
    }
    lineage = args.fallback;
  } else {
    if (args.actorKind !== actorKindForOperation(args.operationKind)
      || typeof args.actorPrincipalSha256 !== "string"
      || !SHA256.test(args.actorPrincipalSha256)) {
      throw new Error(
        `continuation_runtime_v1_durable_job_corrupt:${args.field}_operation_actor`,
      );
    }
    lineage = {
      tenant_id: args.tenantId,
      scope: args.scope,
      operation_kind: args.operationKind,
      operation_id: args.operationId,
      request_sha256: args.requestSha256,
      actor_kind: actorKindForOperation(args.operationKind),
      actor_principal_sha256: args.actorPrincipalSha256,
    };
  }
  const expectedTuple = {
    tenant_id: args.tenantId,
    scope: args.scope,
    operation_kind: args.operationKind,
    operation_id: args.operationId,
    request_sha256: args.requestSha256,
  };
  const actualTuple = {
    tenant_id: lineage.tenant_id,
    scope: lineage.scope,
    operation_kind: lineage.operation_kind,
    operation_id: lineage.operation_id,
    request_sha256: lineage.request_sha256,
  };
  if (canonicalContinuationJson(actualTuple)
      !== canonicalContinuationJson(expectedTuple)
    || lineage.actor_kind !== actorKindForOperation(args.operationKind)
    || !SHA256.test(lineage.actor_principal_sha256)) {
    throw new Error(
      `continuation_runtime_v1_durable_job_corrupt:${args.field}_operation_binding`,
    );
  }
  if (args.fallback
    && canonicalContinuationJson(lineage)
      !== canonicalContinuationJson(args.fallback)) {
    throw new Error(
      `continuation_runtime_v1_durable_job_corrupt:${args.field}_operation_mismatch`,
    );
  }
  return canonicalContinuationClone(lineage);
}

type DecodeLineageFallbacks = Readonly<{
  source?: ContinuationRuntimeV1OperationLineageV1;
  completion?: ContinuationRuntimeV1OperationLineageV1;
  previousCompletion?: ContinuationRuntimeV1OperationLineageV1;
}>;

function decodeRow(
  row: JobRow,
  fallbacks: DecodeLineageFallbacks = {},
): ContinuationRuntimeV1DurableJob {
  canonicalText(row.tenant_id, 256, "tenant_id");
  canonicalText(row.scope, 256, "scope");
  const tenantId = row.tenant_id;
  const scope = row.scope;
  canonicalText(row.task_family, 256, "task_family");
  if (typeof row.authority_subject_sha256 !== "string"
    || !SHA256.test(row.authority_subject_sha256)
    || row.authority_subject_sha256 !== continuationAuthoritySubjectSha256V1({
      tenant_id: tenantId,
      scope,
      task_family: row.task_family,
    })) {
    throw new Error(
      "continuation_runtime_v1_durable_job_corrupt:authority_subject_sha256",
    );
  }
  canonicalText(row.job_id, 256, "job_id");
  canonicalText(row.dedupe_key, 512, "dedupe_key");
  if (typeof row.job_kind !== "string" || !JOB_KIND_SET.has(row.job_kind)) {
    throw new Error("continuation_runtime_v1_durable_job_corrupt:job_kind");
  }
  if (typeof row.state !== "string" || !STATE_SET.has(row.state)) {
    throw new Error("continuation_runtime_v1_durable_job_corrupt:state");
  }
  if (typeof row.source_operation_kind !== "string"
    || !SOURCE_OPERATION_KIND_SET.has(row.source_operation_kind)
    || !sourceOperationSupportsJob(
      row.job_kind as ContinuationRuntimeV1DurableJobKind,
      row.source_operation_kind,
    )) {
    throw new Error("continuation_runtime_v1_durable_job_corrupt:source_operation_kind");
  }
  canonicalText(row.source_operation_id, 256, "source_operation_id");
  if (typeof row.source_request_sha256 !== "string"
    || !SHA256.test(row.source_request_sha256)) {
    throw new Error("continuation_runtime_v1_durable_job_corrupt:source_request_sha256");
  }
  const sourceOperation = lineageWithActor({
    tenantId: row.tenant_id,
    scope: row.scope,
    operationKind: row.source_operation_kind as
      ContinuationRuntimeV1OperationLineageV1["operation_kind"],
    operationId: row.source_operation_id,
    requestSha256: row.source_request_sha256,
    actorKind: row.source_actor_kind,
    actorPrincipalSha256: row.source_actor_principal_sha256,
    fallback: fallbacks.source,
    field: "source",
  });
  integer(row.priority, -1_000_000, 1_000_000, "priority");
  integer(row.attempt_count, 0, 1_000, "attempt_count");
  integer(row.max_attempts, 1, 1_000, "max_attempts");
  if (row.attempt_count > row.max_attempts) {
    throw new Error("continuation_runtime_v1_durable_job_corrupt:attempt_count");
  }
  if (typeof row.payload_sha256 !== "string" || !SHA256.test(row.payload_sha256)) {
    throw new Error("continuation_runtime_v1_durable_job_corrupt:payload_sha256");
  }
  const payload = parseCanonicalObject(row.payload_json, PAYLOAD_MAX_BYTES, "payload_json");
  if (sha256Hex(row.payload_json as string) !== row.payload_sha256) {
    throw new Error("continuation_runtime_v1_durable_job_corrupt:payload_digest");
  }
  timestamp(row.initial_available_at, "initial_available_at");
  timestamp(row.available_at, "available_at");
  timestamp(row.created_at, "created_at");
  timestamp(row.updated_at, "updated_at");
  if (row.updated_at < row.created_at
    || row.initial_available_at < row.created_at
    || row.available_at < row.initial_available_at) {
    throw new Error("continuation_runtime_v1_durable_job_corrupt:updated_at");
  }
  if (deriveJobId(
    row.tenant_id,
    row.scope,
    row.job_kind as ContinuationRuntimeV1DurableJobKind,
    row.dedupe_key,
  ) !== row.job_id) {
    throw new Error("continuation_runtime_v1_durable_job_corrupt:job_identity");
  }

  const nullableText = (value: unknown, maximum: number, field: string): string | null => {
    if (value === null) return null;
    canonicalText(value, maximum, field);
    return value;
  };
  const nullableTime = (value: unknown, field: string): string | null => {
    if (value === null) return null;
    timestamp(value, field);
    return value;
  };
  const leaseOwner = nullableText(row.lease_owner, 256, "lease_owner");
  const leaseToken = nullableText(row.lease_token, 256, "lease_token");
  const leaseAcquiredAt = nullableTime(row.lease_acquired_at, "lease_acquired_at");
  const leaseExpiresAt = nullableTime(row.lease_expires_at, "lease_expires_at");
  const completedAt = nullableTime(row.completed_at, "completed_at");
  const terminalReason = row.terminal_reason === null
    ? null
    : (typeof row.terminal_reason === "string"
      && TERMINAL_REASON_SET.has(row.terminal_reason)
      ? row.terminal_reason as ContinuationRuntimeV1DurableJobTerminalReason
      : (() => {
        throw new Error("continuation_runtime_v1_durable_job_corrupt:terminal_reason");
      })());
  const decodeCompletion = (args: Readonly<{
    operationKind: unknown;
    operationId: unknown;
    requestSha256: unknown;
    actorKind: unknown;
    actorPrincipalSha256: unknown;
    fallback?: ContinuationRuntimeV1OperationLineageV1;
    field: "completion" | "previous_completion";
  }>): ContinuationRuntimeV1OperationLineageV1 | null => {
    const allNull = args.operationKind === null
      && args.operationId === null
      && args.requestSha256 === null;
    if (allNull) {
      if (args.actorKind !== null || args.actorPrincipalSha256 !== null) {
        throw new Error(
          `continuation_runtime_v1_durable_job_corrupt:${args.field}_operation_actor`,
        );
      }
      return null;
    }
    if (args.operationKind !== "worker_completion") {
      throw new Error(
        `continuation_runtime_v1_durable_job_corrupt:${args.field}_operation_kind`,
      );
    }
    canonicalText(args.operationId, 256, `${args.field}_operation_id`);
    if (typeof args.requestSha256 !== "string" || !SHA256.test(args.requestSha256)) {
      throw new Error(
        `continuation_runtime_v1_durable_job_corrupt:${args.field}_request_sha256`,
      );
    }
    const operationId = args.operationId as string;
    const requestSha256 = args.requestSha256 as string;
    return lineageWithActor({
      tenantId,
      scope,
      operationKind: "worker_completion",
      operationId,
      requestSha256,
      actorKind: args.actorKind,
      actorPrincipalSha256: args.actorPrincipalSha256,
      fallback: args.fallback,
      field: args.field,
    });
  };
  const completionOperation = decodeCompletion({
    operationKind: row.completion_operation_kind,
    operationId: row.completion_operation_id,
    requestSha256: row.completion_request_sha256,
    actorKind: row.completion_actor_kind,
    actorPrincipalSha256: row.completion_actor_principal_sha256,
    fallback: fallbacks.completion,
    field: "completion",
  });
  const previousCompletionOperation = decodeCompletion({
    operationKind: row.previous_completion_operation_kind,
    operationId: row.previous_completion_operation_id,
    requestSha256: row.previous_completion_request_sha256,
    actorKind: row.previous_completion_actor_kind,
    actorPrincipalSha256: row.previous_completion_actor_principal_sha256,
    fallback: fallbacks.previousCompletion,
    field: "previous_completion",
  });
  if (previousCompletionOperation !== null
    && (completionOperation === null
      || canonicalContinuationJson(previousCompletionOperation)
        === canonicalContinuationJson(completionOperation))) {
    throw new Error(
      "continuation_runtime_v1_durable_job_corrupt:completion_lineage",
    );
  }
  const lastError = row.last_error_json === null
    ? null
    : parseCanonicalObject(row.last_error_json, ERROR_MAX_BYTES, "last_error_json");

  const leased = row.state === "leased";
  const terminal = row.state === "succeeded" || row.state === "dead";
  if (leased !== (leaseOwner !== null && leaseToken !== null
      && leaseAcquiredAt !== null && leaseExpiresAt !== null)
    || (!leased && (leaseOwner !== null || leaseToken !== null
      || leaseAcquiredAt !== null || leaseExpiresAt !== null))
    || (leased && (!SHA256.test(leaseToken!) || leaseExpiresAt! <= leaseAcquiredAt!
      || row.updated_at !== leaseAcquiredAt || row.available_at > leaseAcquiredAt!
      || (row.attempt_count === 1 && lastError !== null)
      || (row.attempt_count > 1 && lastError === null)))
    || terminal !== (completedAt !== null)
    || (terminal && (row.updated_at !== completedAt || row.available_at > completedAt!))
    || (!terminal && terminalReason !== null)
    || (row.state === "succeeded" && (
      lastError !== null
      || terminalReason !== "worker_succeeded"
      || completionOperation === null
    ))
    || (row.state === "dead" && (
      lastError === null
      || (terminalReason === "worker_dead" && completionOperation === null)
      || (terminalReason === "lease_expired_attempts_exhausted"
        && row.attempt_count !== row.max_attempts)
      || (terminalReason !== "worker_dead"
        && terminalReason !== "lease_expired_attempts_exhausted")
    ))
    || (row.state === "queued" && row.attempt_count === 0
      && (row.updated_at !== row.created_at || row.available_at < row.created_at
        || row.available_at !== row.initial_available_at
        || lastError !== null || completionOperation !== null
        || previousCompletionOperation !== null))
    || (row.state === "queued" && row.attempt_count > 0
      && (lastError === null || row.available_at < row.updated_at))
    || (row.state === "queued" && row.attempt_count >= row.max_attempts)
    || ((row.state === "leased" || terminal) && row.attempt_count < 1)) {
    throw new Error("continuation_runtime_v1_durable_job_corrupt:state_envelope");
  }

  return canonicalContinuationClone({
    tenant_id: row.tenant_id,
    scope: row.scope,
    task_family: row.task_family,
    authority_subject_sha256: row.authority_subject_sha256,
    job_id: row.job_id,
    job_kind: row.job_kind as ContinuationRuntimeV1DurableJobKind,
    dedupe_key: row.dedupe_key,
    source_operation: sourceOperation,
    state: row.state as ContinuationRuntimeV1DurableJobState,
    priority: row.priority,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    payload_sha256: row.payload_sha256,
    payload,
    initial_available_at: row.initial_available_at,
    available_at: row.available_at,
    lease_owner: leaseOwner,
    lease_token: leaseToken,
    lease_acquired_at: leaseAcquiredAt,
    lease_expires_at: leaseExpiresAt,
    completed_at: completedAt,
    terminal_reason: terminalReason,
    completion_operation: completionOperation,
    previous_completion_operation: previousCompletionOperation,
    last_error: lastError,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

function statementChanged(result: unknown): boolean {
  return Number((result as { changes?: number | bigint }).changes ?? 0) === 1;
}

function recoveryError(
  code: "lease_expired" | "lease_expired_attempts_exhausted",
  observedAt: string,
  previousErrorJson: unknown,
): string {
  return canonicalObjectJson({
    schema_version: "continuation_runtime_durable_job_error_v1",
    code,
    observed_at: observedAt,
    previous_error_sha256: typeof previousErrorJson === "string"
      ? sha256Hex(previousErrorJson)
      : null,
  }, ERROR_MAX_BYTES, "recovery_error");
}

export function createContinuationRuntimeV1DurableJobWorkerStore(
  database: ContinuationRuntimeV1Database,
): ContinuationRuntimeV1DurableJobWorkerStore {
  const rowById = (tenantId: string, scope: string, jobId: string): JobRow | null =>
    (database.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM durable_jobs
        WHERE tenant_id = ? AND scope = ? AND job_id = ?`,
    ).get(tenantId, scope, jobId) as JobRow | undefined) ?? null;

  const authenticatedById = (
    tenantId: string,
    scope: string,
    jobId: string,
    fallbacks: DecodeLineageFallbacks = {},
  ): ContinuationRuntimeV1DurableJob | null => {
    const row = rowById(tenantId, scope, jobId);
    return row ? decodeRow(row, fallbacks) : null;
  };

  const transitionExpiredLease = (row: JobRow, clock: string): void => {
    const job = decodeRow(row);
    if (job.state !== "leased" || job.lease_expires_at! > clock) {
      throw new Error("continuation_runtime_v1_durable_job_recovery_candidate_invalid");
    }
    const transitionAt = database.mintAuthorityTime(job.updated_at);
    const exhausted = job.attempt_count >= job.max_attempts;
    const errorJson = recoveryError(
      exhausted ? "lease_expired_attempts_exhausted" : "lease_expired",
      transitionAt,
      row.last_error_json,
    );
    const changed = database.db.prepare(`UPDATE durable_jobs SET
      state = ?, available_at = ?, lease_owner = NULL, lease_token = NULL,
      lease_acquired_at = NULL, lease_expires_at = NULL, completed_at = ?,
      terminal_reason = ?, last_error_json = ?, updated_at = ?
      WHERE tenant_id = ? AND scope = ? AND job_id = ? AND state = 'leased'
        AND job_kind = ?
        AND attempt_count = ? AND lease_token = ? AND lease_expires_at = ?
        AND updated_at = ? AND payload_sha256 = ?`).run(
      exhausted ? "dead" : "queued",
      exhausted ? job.available_at : transitionAt,
      exhausted ? transitionAt : null,
      exhausted ? "lease_expired_attempts_exhausted" : null,
      errorJson,
      transitionAt,
      job.tenant_id,
      job.scope,
      job.job_id,
      job.job_kind,
      job.attempt_count,
      job.lease_token,
      job.lease_expires_at,
      job.updated_at,
      job.payload_sha256,
    );
    if (!statementChanged(changed)) {
      throw new Error("continuation_runtime_v1_durable_job_recovery_cas_conflict");
    }
    decodeRow(rowById(job.tenant_id, job.scope, job.job_id)!);
  };

  return {
    /**
     * Owns only the dequeue/recovery transaction and returns after commit.
     * Workers must perform provider, model, ANN, verifier, and effect work only
     * after this promise resolves and before opening worker_completion.
     */
    async leaseNext(
      args: LeaseNextContinuationRuntimeV1DurableJobArgs,
    ): Promise<ContinuationRuntimeV1DurableJob | null> {
      exactShape(args, LEASE_KEYS, "lease");
      canonicalText(args.tenant_id, 256, "tenant_id");
      if (!JOB_KIND_SET.has(args.job_kind)) {
        throw new Error("continuation_runtime_v1_durable_job_kind_invalid");
      }
      canonicalText(args.lease_owner, 256, "lease_owner");
      integer(
        args.lease_duration_ms,
        MIN_LEASE_DURATION_MS,
        MAX_LEASE_DURATION_MS,
        "lease_duration_ms",
      );
      if (database.transaction.inTransaction()) {
        throw new Error("continuation_runtime_v1_durable_job_lease_must_own_transaction");
      }
      const token = randomBytes(32).toString("hex");
      return await database.withTx(async () => {
        const clock = database.authorityNow();
        timestamp(clock, "lease_clock");
        const tokenCollision = database.db.prepare(
          "SELECT 1 AS present FROM durable_jobs WHERE lease_token = ? LIMIT 1",
        ).get(token);
        if (tokenCollision) {
          throw new Error("continuation_runtime_v1_durable_job_lease_token_collision");
        }
        const expired = database.db.prepare(
          `SELECT ${SELECT_COLUMNS} FROM durable_jobs
            WHERE tenant_id = ? AND job_kind = ?
              AND state = 'leased' AND lease_expires_at <= ?
            ORDER BY lease_expires_at ASC, scope ASC, job_id ASC`,
        ).all(args.tenant_id, args.job_kind, clock) as JobRow[];
        for (const row of expired) transitionExpiredLease(row, clock);

        const candidateRow = database.db.prepare(
          `SELECT ${SELECT_COLUMNS} FROM durable_jobs
            WHERE tenant_id = ? AND job_kind = ? AND state = 'queued'
              AND attempt_count < max_attempts AND available_at <= ?
            ORDER BY available_at ASC, priority DESC, scope ASC, job_id ASC
            LIMIT 1`,
        ).get(args.tenant_id, args.job_kind, clock) as JobRow | undefined;
        if (!candidateRow) return null;
        const candidate = decodeRow(candidateRow);
        const acquiredAt = database.mintAuthorityTime(candidate.updated_at);
        const expiresAt = addMilliseconds(acquiredAt, args.lease_duration_ms);
        const changed = database.db.prepare(`UPDATE durable_jobs SET
          state = 'leased', attempt_count = attempt_count + 1,
          lease_owner = ?, lease_token = ?, lease_acquired_at = ?,
          lease_expires_at = ?, completed_at = NULL, updated_at = ?
          WHERE tenant_id = ? AND scope = ? AND job_id = ? AND state = 'queued'
            AND job_kind = ?
            AND attempt_count = ? AND max_attempts = ? AND updated_at = ?
            AND payload_sha256 = ?`).run(
          args.lease_owner,
          token,
          acquiredAt,
          expiresAt,
          acquiredAt,
          candidate.tenant_id,
          candidate.scope,
          candidate.job_id,
          candidate.job_kind,
          candidate.attempt_count,
          candidate.max_attempts,
          candidate.updated_at,
          candidate.payload_sha256,
        );
        if (!statementChanged(changed)) {
          throw new Error("continuation_runtime_v1_durable_job_lease_cas_conflict");
        }
        const leased = authenticatedById(candidate.tenant_id, candidate.scope, candidate.job_id);
        if (!leased || leased.state !== "leased" || !sameToken(leased.lease_token!, token)) {
          throw new Error("continuation_runtime_v1_durable_job_postlease_mismatch");
        }
        return leased;
      });
    },

    /**
     * Closes only the queue row. Any business-authority mutation belongs
     * earlier in the same worker_completion producer so both commit with its
     * operation receipt or roll back together.
     */
    async complete(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      args: CompleteContinuationRuntimeV1DurableJobArgs,
    ): Promise<ContinuationRuntimeV1DurableJob> {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      if (binding.operationKind !== "worker_completion") {
        throw new Error("continuation_runtime_v1_durable_job_worker_context_required");
      }
      const completionOperation = continuationRuntimeV1OperationLineage(binding);
      exactShape(args, COMPLETE_KEYS, "complete");
      canonicalText(args.job_id, 256, "job_id");
      if (!SHA256.test(args.lease_token)) {
        throw new Error("continuation_runtime_v1_durable_job_lease_token_invalid");
      }
      const row = rowById(binding.tenantId, binding.scope, args.job_id);
      if (!row) throw new Error("continuation_runtime_v1_durable_job_not_found");
      const job = decodeRow(row);
      if (job.state !== "leased") {
        throw new Error("continuation_runtime_v1_durable_job_lease_not_active");
      }
      if (!sameToken(job.lease_token!, args.lease_token)) {
        throw new Error("continuation_runtime_v1_durable_job_lease_token_mismatch");
      }
      const clock = database.authorityNow();
      timestamp(clock, "complete_clock");
      if (job.lease_expires_at! <= clock) {
        throw new Error("continuation_runtime_v1_durable_job_lease_expired");
      }
      const completedAt = database.mintAuthorityTime(job.updated_at);
      if (completedAt >= job.lease_expires_at!) {
        throw new Error("continuation_runtime_v1_durable_job_lease_expired");
      }
      constrainContinuationRuntimeV1OperationCompletion(
        context,
        database,
        leaseCompletionDeadline(job.lease_expires_at!),
      );
      const changed = database.db.prepare(`UPDATE durable_jobs SET
        state = 'succeeded', lease_owner = NULL, lease_token = NULL,
        lease_acquired_at = NULL, lease_expires_at = NULL, completed_at = ?,
        terminal_reason = 'worker_succeeded',
        previous_completion_operation_kind = completion_operation_kind,
        previous_completion_operation_id = completion_operation_id,
        previous_completion_request_sha256 = completion_request_sha256,
        completion_operation_kind = ?, completion_operation_id = ?,
        completion_request_sha256 = ?,
        last_error_json = NULL, updated_at = ?
        WHERE tenant_id = ? AND scope = ? AND job_id = ? AND state = 'leased'
          AND lease_token = ? AND lease_expires_at = ? AND attempt_count = ?
          AND updated_at = ? AND payload_sha256 = ?`).run(
        completedAt,
        completionOperation.operation_kind,
        completionOperation.operation_id,
        completionOperation.request_sha256,
        completedAt,
        job.tenant_id,
        job.scope,
        job.job_id,
        job.lease_token,
        job.lease_expires_at,
        job.attempt_count,
        job.updated_at,
        job.payload_sha256,
      );
      if (!statementChanged(changed)) {
        throw new Error("continuation_runtime_v1_durable_job_complete_cas_conflict");
      }
      return authenticatedById(
        job.tenant_id,
        job.scope,
        job.job_id,
        {
          completion: completionOperation,
          ...(job.completion_operation
            ? { previousCompletion: job.completion_operation }
            : {}),
        },
      )!;
    },

    async fail(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      args: FailContinuationRuntimeV1DurableJobArgs,
    ): Promise<ContinuationRuntimeV1DurableJob> {
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      if (binding.operationKind !== "worker_completion") {
        throw new Error("continuation_runtime_v1_durable_job_worker_context_required");
      }
      const completionOperation = continuationRuntimeV1OperationLineage(binding);
      exactShape(args, FAIL_KEYS, "fail");
      canonicalText(args.job_id, 256, "job_id");
      if (!SHA256.test(args.lease_token)) {
        throw new Error("continuation_runtime_v1_durable_job_lease_token_invalid");
      }
      if (args.disposition !== "retry" && args.disposition !== "dead") {
        throw new Error("continuation_runtime_v1_durable_job_failure_disposition_invalid");
      }
      if ((args.disposition === "retry") !== (args.retry_at !== null)) {
        throw new Error("continuation_runtime_v1_durable_job_retry_time_invalid");
      }
      if (args.retry_at !== null) timestamp(args.retry_at, "retry_at");
      const errorJson = canonicalObjectJson(args.error, ERROR_MAX_BYTES, "error");
      const row = rowById(binding.tenantId, binding.scope, args.job_id);
      if (!row) throw new Error("continuation_runtime_v1_durable_job_not_found");
      const job = decodeRow(row);
      if (job.state !== "leased") {
        throw new Error("continuation_runtime_v1_durable_job_lease_not_active");
      }
      if (!sameToken(job.lease_token!, args.lease_token)) {
        throw new Error("continuation_runtime_v1_durable_job_lease_token_mismatch");
      }
      const clock = database.authorityNow();
      timestamp(clock, "fail_clock");
      if (job.lease_expires_at! <= clock) {
        throw new Error("continuation_runtime_v1_durable_job_lease_expired");
      }
      const workerTransitionAt = database.mintAuthorityTime(job.updated_at);
      if (workerTransitionAt >= job.lease_expires_at!) {
        throw new Error("continuation_runtime_v1_durable_job_lease_expired");
      }
      constrainContinuationRuntimeV1OperationCompletion(
        context,
        database,
        leaseCompletionDeadline(job.lease_expires_at!),
      );
      const dead = args.disposition === "dead" || job.attempt_count >= job.max_attempts;
      const transitionAt = workerTransitionAt;
      const availableAt = dead
        ? job.available_at
        : [args.retry_at!, transitionAt, job.initial_available_at]
          .reduce((latest, candidate) => candidate > latest ? candidate : latest);
      const changed = database.db.prepare(`UPDATE durable_jobs SET
        state = ?, available_at = ?, lease_owner = NULL, lease_token = NULL,
        lease_acquired_at = NULL, lease_expires_at = NULL, completed_at = ?,
        terminal_reason = ?,
        previous_completion_operation_kind = completion_operation_kind,
        previous_completion_operation_id = completion_operation_id,
        previous_completion_request_sha256 = completion_request_sha256,
        completion_operation_kind = ?, completion_operation_id = ?,
        completion_request_sha256 = ?,
        last_error_json = ?, updated_at = ?
        WHERE tenant_id = ? AND scope = ? AND job_id = ? AND state = 'leased'
          AND lease_token = ? AND lease_expires_at = ? AND attempt_count = ?
          AND updated_at = ? AND payload_sha256 = ?`).run(
        dead ? "dead" : "queued",
        availableAt,
        dead ? transitionAt : null,
        dead ? "worker_dead" : null,
        completionOperation.operation_kind,
        completionOperation.operation_id,
        completionOperation.request_sha256,
        errorJson,
        transitionAt,
        job.tenant_id,
        job.scope,
        job.job_id,
        job.lease_token,
        job.lease_expires_at,
        job.attempt_count,
        job.updated_at,
        job.payload_sha256,
      );
      if (!statementChanged(changed)) {
        throw new Error("continuation_runtime_v1_durable_job_fail_cas_conflict");
      }
      return authenticatedById(
        job.tenant_id,
        job.scope,
        job.job_id,
        {
          completion: completionOperation,
          ...(job.completion_operation
            ? { previousCompletion: job.completion_operation }
            : {}),
        },
      )!;
    },

    async read(
      args: ReadContinuationRuntimeV1DurableJobArgs,
    ): Promise<ContinuationRuntimeV1DurableJob | null> {
      exactShape(args, READ_KEYS, "read");
      canonicalText(args.tenant_id, 256, "tenant_id");
      canonicalText(args.scope, 256, "scope");
      canonicalText(args.job_id, 256, "job_id");
      return await database.read(() => authenticatedById(
        args.tenant_id,
        args.scope,
        args.job_id,
      ));
    },
  };
}
