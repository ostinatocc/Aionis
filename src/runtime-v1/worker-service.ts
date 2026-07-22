import { resolve } from "node:path";

import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type CanonicalJson,
  type Sha256,
} from "../continuation/contract.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../continuation/task-envelope.js";
import {
  createContinuationRuntimeV1DurableJobWorkerStore,
  type ContinuationRuntimeV1DurableJob,
} from "../store/continuation-runtime-v1-durable-job-store.js";
import type { ContinuationRuntimeV1Database } from
  "../store/continuation-runtime-v1-database.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../store/continuation-runtime-v1-operation-result-derivation.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationExecution,
  type ContinuationRuntimeV1OperationRecord,
} from "../store/continuation-runtime-v1-operation-store.js";
import { sha256Hex } from "../util/crypto.js";
import {
  buildWorkerCompletionCommandV1,
} from "./command.js";
import { operationRequestFromVerifiedCommandV1 } from "./operation-request.js";
import type {
  RuntimeV1CanonicalObject,
  WorkerCompletionBodyV1,
} from "./command-contract.js";
import type { ContinuationRuntimeV1WorkerConfig } from "./worker-config.js";
import {
  continuationRuntimeV1WorkerPrincipal,
  type ContinuationRuntimeV1WorkerPrincipal,
  type ContinuationRuntimeV1WorkerRole,
} from "./worker-identity.js";

type WorkerSuccessCompletionV1 = Extract<
  WorkerCompletionBodyV1["completion"],
  Readonly<{ status: "succeeded" }>
>;

export type ContinuationRuntimeV1WorkerSuccessOutput<
  R extends ContinuationRuntimeV1WorkerRole,
> = Extract<WorkerSuccessCompletionV1["output"], Readonly<{ kind: R }>>;

/** Safe processor projection; the orchestration layer retains the raw lease token. */
export type ContinuationRuntimeV1WorkerAttemptJob<
  R extends ContinuationRuntimeV1WorkerRole = ContinuationRuntimeV1WorkerRole,
> = Readonly<{
  schema_version: "continuation_runtime_worker_attempt_job_v1";
  tenant_id: string;
  scope: string;
  task_family: string;
  authority_subject_sha256: Sha256;
  job_id: string;
  job_kind: R;
  payload_sha256: Sha256;
  payload: Readonly<{ [key: string]: CanonicalJson }>;
  attempt_count: number;
  max_attempts: number;
  lease_acquired_at: string;
  lease_expires_at: string;
}>;

export type ContinuationRuntimeV1WorkerAuthorityCommitInput<
  R extends ContinuationRuntimeV1WorkerRole,
> = Readonly<{
  context: ContinuationRuntimeV1AuthorityWriteContext;
  job: ContinuationRuntimeV1WorkerAttemptJob<R>;
  output: ContinuationRuntimeV1WorkerSuccessOutput<R>;
}>;

/** Role-specific mutation port; the generic runner owns transition and receipt. */
export type ContinuationRuntimeV1WorkerAuthorityCommitPort<
  R extends ContinuationRuntimeV1WorkerRole,
> = (
  input: ContinuationRuntimeV1WorkerAuthorityCommitInput<R>,
) => void | Promise<void>;

export type ContinuationRuntimeV1PreparedWorkerSuccess<
  R extends ContinuationRuntimeV1WorkerRole,
> = Readonly<{
  output: ContinuationRuntimeV1WorkerSuccessOutput<R>;
  commitAuthority: ContinuationRuntimeV1WorkerAuthorityCommitPort<R>;
}>;

export type ContinuationRuntimeV1WorkerProcessorInput<
  R extends ContinuationRuntimeV1WorkerRole,
> = Readonly<{
  schema_version: "continuation_runtime_worker_processor_input_v1";
  attempt_operation_id: string;
  job: ContinuationRuntimeV1WorkerAttemptJob<R>;
  signal: AbortSignal;
}>;

export type ContinuationRuntimeV1WorkerProcessor<
  R extends ContinuationRuntimeV1WorkerRole = ContinuationRuntimeV1WorkerRole,
> = Readonly<{
  worker_role: R;
  process(
    input: ContinuationRuntimeV1WorkerProcessorInput<R>,
  ): Promise<ContinuationRuntimeV1PreparedWorkerSuccess<R>>;
}>;

export type ContinuationRuntimeV1WorkerFailureDisposition = "retry" | "dead";

type ProcessorFailureRecord = Readonly<{
  code: string;
  disposition: ContinuationRuntimeV1WorkerFailureDisposition;
}>;

const PROCESSOR_FAILURES = new WeakMap<object, ProcessorFailureRecord>();

/** Stable processor failure classification without persisting thrown details. */
export class ContinuationRuntimeV1WorkerProcessorError extends Error {
  constructor(value: Readonly<{
    code: string;
    disposition: ContinuationRuntimeV1WorkerFailureDisposition;
  }>) {
    const record = exactRecord(value, ["code", "disposition"], "processor_error");
    const code = safeCode(record.code, "processor_error_code");
    if (record.disposition !== "retry" && record.disposition !== "dead") {
      fail("processor_error_disposition_invalid");
    }
    super("continuation_runtime_v1_worker_processor_failed");
    this.name = "ContinuationRuntimeV1WorkerProcessorError";
    PROCESSOR_FAILURES.set(this, {
      code,
      disposition: record.disposition,
    });
  }

  get code(): string {
    return PROCESSOR_FAILURES.get(this)?.code ?? "processor_unhandled_error";
  }

  get disposition(): ContinuationRuntimeV1WorkerFailureDisposition {
    return PROCESSOR_FAILURES.get(this)?.disposition ?? "retry";
  }
}

export type ContinuationRuntimeV1WorkerAttemptResult = Readonly<{
  schema_version: "continuation_runtime_worker_attempt_result_v1";
  job_id: string;
  job_kind: ContinuationRuntimeV1WorkerRole;
  attempt_count: number;
  operation_id: string;
  operation_status: "created" | "replayed";
  transition_state: "queued" | "succeeded" | "dead";
}>;

export type ContinuationRuntimeV1WorkerBatchResult = Readonly<{
  schema_version: "continuation_runtime_worker_batch_result_v1";
  leased_count: number;
  succeeded_count: number;
  retry_scheduled_count: number;
  dead_count: number;
  replayed_completion_count: number;
  attempts: readonly ContinuationRuntimeV1WorkerAttemptResult[];
}>;

export type ContinuationRuntimeV1WorkerService = Readonly<{
  workerPrincipal(): ContinuationRuntimeV1WorkerPrincipal;
  acceptingNewWork(): boolean;
  inFlightCount(): number;
  processLeasedJob(
    job: ContinuationRuntimeV1DurableJob,
    signal?: AbortSignal,
  ): Promise<ContinuationRuntimeV1WorkerAttemptResult>;
  runBatch(signal?: AbortSignal): Promise<ContinuationRuntimeV1WorkerBatchResult>;
  runUntilStopped(signal?: AbortSignal): Promise<void>;
  stopNewWork(): Promise<void>;
  drainInFlight(): Promise<void>;
}>;

export type ContinuationRuntimeV1WorkerServiceInput<
  R extends ContinuationRuntimeV1WorkerRole,
> = Readonly<{
  database: ContinuationRuntimeV1Database;
  config: ContinuationRuntimeV1WorkerConfig;
  processor: ContinuationRuntimeV1WorkerProcessor<R>;
}>;

const SERVICE_KEYS = Object.freeze(["config", "database", "processor"] as const);
const PROCESSOR_KEYS = Object.freeze(["process", "worker_role"] as const);
const PREPARED_KEYS = Object.freeze(["commitAuthority", "output"] as const);
const DURABLE_JOB_KEYS = Object.freeze([
  "attempt_count",
  "authority_subject_sha256",
  "available_at",
  "completed_at",
  "completion_operation",
  "created_at",
  "dedupe_key",
  "initial_available_at",
  "job_id",
  "job_kind",
  "last_error",
  "lease_acquired_at",
  "lease_expires_at",
  "lease_owner",
  "lease_token",
  "max_attempts",
  "payload",
  "payload_sha256",
  "previous_completion_operation",
  "priority",
  "scope",
  "source_operation",
  "state",
  "task_family",
  "tenant_id",
  "terminal_reason",
  "updated_at",
] as const);
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;
const PROCESSOR_DEADLINE = Symbol("processor_deadline");
const PROCESSOR_ABORT = Symbol("processor_abort");
const RESERVED_PAYLOAD_AUTHORITY_FIELDS = Object.freeze(new Set([
  "attempt_count",
  "authority_subject_sha256",
  "job_id",
  "job_kind",
  "lease_acquired_at",
  "lease_expires_at",
  "lease_owner",
  "lease_token",
  "max_attempts",
  "payload_sha256",
  "scope",
  "task_family",
  "tenant_id",
]));

function fail(reason: string): never {
  throw new Error(`continuation_runtime_v1_worker_service_invalid:${reason}`);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field}_must_be_plain_record`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${field}_must_be_plain_record`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => typeof key !== "string")
    || expectedKeys.some((key) => !ownKeys.includes(key))) {
    fail(`${field}_fields_invalid`);
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set
      || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_fields_invalid`);
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function safeCode(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_CODE.test(value)) fail(`${field}_invalid`);
  return value;
}

function canonicalText(value: unknown, maximumBytes: number, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail(`${field}_invalid`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value)
    || Number(value) < minimum || Number(value) > maximum) {
    fail(`${field}_invalid`);
  }
  return Number(value);
}

function assertSignal(value: unknown): asserts value is AbortSignal {
  if (value === null || typeof value !== "object"
    || typeof (value as AbortSignal).aborted !== "boolean"
    || typeof (value as AbortSignal).addEventListener !== "function"
    || typeof (value as AbortSignal).removeEventListener !== "function") {
    fail("abort_signal_invalid");
  }
}

function assertRole(value: unknown): asserts value is ContinuationRuntimeV1WorkerRole {
  if (value !== "embedding" && value !== "ann"
    && value !== "effect" && value !== "retention") {
    fail("worker_role_invalid");
  }
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const epoch = Date.parse(timestamp);
  const result = epoch + milliseconds;
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(result)) {
    fail("retry_timestamp_invalid");
  }
  return new Date(result).toISOString();
}

function processorSafetyMarginMs(leaseMs: number): number {
  return Math.max(250, Math.min(5_000, Math.floor(leaseMs / 4)));
}

function operationIdFor(job: ContinuationRuntimeV1DurableJob): string {
  return `worker_completion_${canonicalContinuationSha256({
    schema_version: "continuation_runtime_worker_completion_identity_v1",
    tenant_id: job.tenant_id,
    scope: job.scope,
    task_family: job.task_family,
    authority_subject_sha256: job.authority_subject_sha256,
    job_id: job.job_id,
    job_kind: job.job_kind,
    payload_sha256: job.payload_sha256,
    attempt_count: job.attempt_count,
  })}`;
}

function attemptJob<R extends ContinuationRuntimeV1WorkerRole>(
  job: ContinuationRuntimeV1DurableJob & Readonly<{ job_kind: R }>,
): ContinuationRuntimeV1WorkerAttemptJob<R> {
  return canonicalContinuationClone({
    schema_version: "continuation_runtime_worker_attempt_job_v1" as const,
    tenant_id: job.tenant_id,
    scope: job.scope,
    task_family: job.task_family,
    authority_subject_sha256: job.authority_subject_sha256,
    job_id: job.job_id,
    job_kind: job.job_kind,
    payload_sha256: job.payload_sha256,
    payload: job.payload,
    attempt_count: job.attempt_count,
    max_attempts: job.max_attempts,
    lease_acquired_at: job.lease_acquired_at!,
    lease_expires_at: job.lease_expires_at!,
  });
}

function classifiedProcessorFailure(
  error: unknown,
  aborted: boolean,
): ProcessorFailureRecord {
  if (aborted) return { code: "processor_aborted", disposition: "retry" };
  if (error !== null && typeof error === "object") {
    const known = PROCESSOR_FAILURES.get(error);
    if (known) return known;
  }
  return { code: "processor_unhandled_error", disposition: "retry" };
}

function persistedFailure(
  job: ContinuationRuntimeV1DurableJob,
  operationId: string,
  code: string,
): RuntimeV1CanonicalObject {
  const evidence = {
    schema_version: "continuation_runtime_worker_failure_evidence_v1",
    operation_id: operationId,
    job_id: job.job_id,
    job_kind: job.job_kind,
    payload_sha256: job.payload_sha256,
    attempt_count: job.attempt_count,
    code,
  } as const;
  return canonicalContinuationClone({
    schema_version: "continuation_runtime_worker_failure_v1",
    code,
    error_sha256: canonicalContinuationSha256(evidence),
  });
}

function leasedBinding(
  job: ContinuationRuntimeV1DurableJob,
  principal: ContinuationRuntimeV1WorkerPrincipal,
) {
  return {
    tenant_id: job.tenant_id,
    scope: job.scope,
    actor_kind: "worker" as const,
    actor_principal_sha256: principal.actor_principal_sha256,
    task_family: job.task_family,
    authority_subject_sha256: job.authority_subject_sha256,
    job_id: job.job_id,
    job_kind: job.job_kind,
    job_payload_sha256: job.payload_sha256,
    attempt_count: job.attempt_count,
    lease_token_sha256: sha256Hex(job.lease_token!),
  } as const;
}

function attemptResult(
  operationStatus: "created" | "replayed",
  operationId: string,
  record: Pick<ContinuationRuntimeV1OperationRecord, "receipt">
    | Pick<ContinuationRuntimeV1OperationExecution, "receipt">,
  expectedJob: ContinuationRuntimeV1DurableJob,
): ContinuationRuntimeV1WorkerAttemptResult {
  const result = record.receipt.result;
  if (result.schema_version !== "worker_completion_result_v1") {
    fail("worker_completion_receipt_kind_mismatch");
  }
  const transition = result.transition_ref;
  if (transition.job_id !== expectedJob.job_id
    || transition.job_kind !== expectedJob.job_kind
    || transition.payload_sha256 !== expectedJob.payload_sha256
    || transition.attempt_count !== expectedJob.attempt_count) {
    fail("worker_completion_receipt_job_mismatch");
  }
  return canonicalContinuationClone({
    schema_version: "continuation_runtime_worker_attempt_result_v1" as const,
    job_id: transition.job_id,
    job_kind: transition.job_kind,
    attempt_count: transition.attempt_count,
    operation_id: operationId,
    operation_status: operationStatus,
    transition_state: transition.state,
  });
}

function assertPersistedRequestBinding(
  record: ContinuationRuntimeV1OperationRecord,
  job: ContinuationRuntimeV1DurableJob,
  principal: ContinuationRuntimeV1WorkerPrincipal,
): void {
  if (record.request === null || typeof record.request !== "object"
    || Array.isArray(record.request)) {
    fail("worker_completion_request_corrupt");
  }
  const request = record.request as Readonly<Record<string, CanonicalJson>>;
  const leased = request.leased_job_binding;
  const expected = leasedBinding(job, principal);
  if (request.schema_version !== "authenticated_runtime_command_v1"
    || request.operation_kind !== "worker_completion"
    || request.operation_id !== operationIdFor(job)
    || request.tenant_id !== job.tenant_id
    || request.scope !== job.scope
    || request.actor_kind !== "worker"
    || request.actor_principal_sha256 !== principal.actor_principal_sha256
    || request.authority_subject_sha256 !== job.authority_subject_sha256
    || canonicalContinuationJson(leased) !== canonicalContinuationJson({
      job_id: expected.job_id,
      job_kind: expected.job_kind,
      job_payload_sha256: expected.job_payload_sha256,
      attempt_count: expected.attempt_count,
      lease_token_sha256: expected.lease_token_sha256,
    })) {
    fail("worker_completion_request_binding_mismatch");
  }
}

function emptyBatch(): ContinuationRuntimeV1WorkerBatchResult {
  return canonicalContinuationClone({
    schema_version: "continuation_runtime_worker_batch_result_v1" as const,
    leased_count: 0,
    succeeded_count: 0,
    retry_scheduled_count: 0,
    dead_count: 0,
    replayed_completion_count: 0,
    attempts: [],
  });
}

function batchResult(
  attempts: readonly ContinuationRuntimeV1WorkerAttemptResult[],
): ContinuationRuntimeV1WorkerBatchResult {
  return canonicalContinuationClone({
    schema_version: "continuation_runtime_worker_batch_result_v1" as const,
    leased_count: attempts.length,
    succeeded_count: attempts.filter((value) => value.transition_state === "succeeded").length,
    retry_scheduled_count: attempts.filter((value) => value.transition_state === "queued").length,
    dead_count: attempts.filter((value) => value.transition_state === "dead").length,
    replayed_completion_count: attempts.filter(
      (value) => value.operation_status === "replayed",
    ).length,
    attempts,
  });
}

function validateInput<R extends ContinuationRuntimeV1WorkerRole>(
  value: ContinuationRuntimeV1WorkerServiceInput<R>,
): ContinuationRuntimeV1WorkerServiceInput<R> {
  const input = exactRecord(value, SERVICE_KEYS, "service_input");
  const database = input.database as ContinuationRuntimeV1Database;
  const config = input.config as ContinuationRuntimeV1WorkerConfig;
  const processor = exactRecord(input.processor, PROCESSOR_KEYS, "processor");
  if (!database || typeof database !== "object"
    || typeof database.path !== "string"
    || !SHA256.test(database.databaseInstanceId)
    || typeof database.authorityNow !== "function"
    || typeof database.mintAuthorityTime !== "function"
    || typeof database.read !== "function"
    || typeof database.withTx !== "function") {
    fail("database_invalid");
  }
  if (!config || typeof config !== "object" || !Object.isFrozen(config)) {
    fail("config_invalid");
  }
  assertRole(config.workerRole);
  if (processor.worker_role !== config.workerRole
    || typeof processor.process !== "function") {
    fail("processor_role_mismatch");
  }
  canonicalText(config.tenantId, 256, "tenant_id");
  if (typeof config.dataPath !== "string"
    || resolve(config.dataPath) !== resolve(database.path)) {
    fail("database_path_mismatch");
  }
  if (!config.jobs || typeof config.jobs !== "object") fail("jobs_config_invalid");
  positiveInteger(config.jobs.pollMs, 10, 60_000, "poll_ms");
  positiveInteger(config.jobs.batchSize, 1, 256, "batch_size");
  positiveInteger(config.jobs.leaseMs, 1_000, 3_600_000, "lease_ms");
  return value;
}

/** Creates one tenant- and role-confined durable worker orchestration service. */
export function createContinuationRuntimeV1WorkerService<
  R extends ContinuationRuntimeV1WorkerRole,
>(
  value: ContinuationRuntimeV1WorkerServiceInput<R>,
): ContinuationRuntimeV1WorkerService {
  const input = validateInput(value);
  const role = input.config.workerRole as R;
  const principal = continuationRuntimeV1WorkerPrincipal({
    database_instance_id: input.database.databaseInstanceId,
    worker_role: role,
  });
  const jobs = createContinuationRuntimeV1DurableJobWorkerStore(input.database);
  const operations = createContinuationRuntimeV1OperationStore(input.database);
  const authorityNowMilliseconds = (): number =>
    Date.parse(input.database.authorityNow());
  const leaseOwner = `worker_${role}_${principal.actor_principal_sha256}`;
  const activeAttempts = new Map<
    string,
    Promise<ContinuationRuntimeV1WorkerAttemptResult>
  >();
  const inFlight = new Set<Promise<unknown>>();
  const stopWaiters = new Set<() => void>();
  let stopped = false;
  let batchActive = false;
  let loopActive = false;
  let pendingLeaseAdmission: Promise<void> | null = null;

  const wakePollers = (): void => {
    for (const wake of [...stopWaiters]) wake();
    stopWaiters.clear();
  };

  const requestStop = (): void => {
    if (stopped) return;
    stopped = true;
    wakePollers();
  };

  const stopNewWork = async (): Promise<void> => {
    requestStop();
    if (pendingLeaseAdmission) await pendingLeaseAdmission;
  };

  const validateLease = (
    job: ContinuationRuntimeV1DurableJob,
  ): ContinuationRuntimeV1DurableJob & Readonly<{ job_kind: R }> => {
    exactRecord(job, DURABLE_JOB_KEYS, "leased_job");
    const leaseDuration = typeof job.lease_acquired_at === "string"
      && typeof job.lease_expires_at === "string"
      ? Date.parse(job.lease_expires_at) - Date.parse(job.lease_acquired_at)
      : Number.NaN;
    if (job.tenant_id !== input.config.tenantId
      || job.job_kind !== role
      || job.state !== "leased"
      || job.lease_owner !== leaseOwner
      || typeof job.lease_token !== "string" || !SHA256.test(job.lease_token)
      || typeof job.lease_acquired_at !== "string"
      || typeof job.lease_expires_at !== "string"
      || leaseDuration !== input.config.jobs.leaseMs
      || Reflect.ownKeys(job.payload).some((key) => (
        typeof key !== "string" || RESERVED_PAYLOAD_AUTHORITY_FIELDS.has(key)
      ))
      || job.authority_subject_sha256 !== continuationAuthoritySubjectSha256V1({
        tenant_id: job.tenant_id,
        scope: job.scope,
        task_family: job.task_family,
      })) {
      fail("leased_job_binding_invalid");
    }
    return job as ContinuationRuntimeV1DurableJob & Readonly<{ job_kind: R }>;
  };

  const executeFailure = async (
    job: ContinuationRuntimeV1DurableJob & Readonly<{ job_kind: R }>,
    operationId: string,
    failure: ProcessorFailureRecord,
  ): Promise<ContinuationRuntimeV1WorkerAttemptResult> => {
    const retryAt = failure.disposition === "retry"
      ? addMilliseconds(job.lease_acquired_at!, input.config.jobs.pollMs)
      : null;
    const error = persistedFailure(job, operationId, failure.code);
    const command = buildWorkerCompletionCommandV1(operationId, {
      schema_version: "worker_completion_body_v1",
      completion: {
        status: failure.disposition,
        retry_at: retryAt,
        error,
      },
    }, leasedBinding(job, principal));
    const execution = await operations.execute({
      tenantId: job.tenant_id,
      scope: job.scope,
      operationKind: "worker_completion",
      operationId,
      actorKind: "worker",
      actorPrincipalSha256: principal.actor_principal_sha256,
      request: operationRequestFromVerifiedCommandV1(command),
      produce: async (context) => {
        await jobs.fail(context, {
          job_id: job.job_id,
          lease_token: job.lease_token!,
          disposition: failure.disposition,
          retry_at: retryAt,
          error,
        });
        const binding = assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          input.database,
        );
        return deriveContinuationRuntimeV1OperationResultV1(
          input.database,
          binding,
          "before_receipt_insert",
        );
      },
    });
    return attemptResult(execution.status, operationId, execution, job);
  };

  const executeSuccess = async (
    job: ContinuationRuntimeV1DurableJob & Readonly<{ job_kind: R }>,
    safeJob: ContinuationRuntimeV1WorkerAttemptJob<R>,
    operationId: string,
    prepared: ContinuationRuntimeV1PreparedWorkerSuccess<R>,
  ): Promise<ContinuationRuntimeV1WorkerAttemptResult> => {
    const command = buildWorkerCompletionCommandV1(operationId, {
      schema_version: "worker_completion_body_v1",
      completion: { status: "succeeded", output: prepared.output },
    }, leasedBinding(job, principal));
    const execution = await operations.execute({
      tenantId: job.tenant_id,
      scope: job.scope,
      operationKind: "worker_completion",
      operationId,
      actorKind: "worker",
      actorPrincipalSha256: principal.actor_principal_sha256,
      request: operationRequestFromVerifiedCommandV1(command),
      produce: async (context) => {
        try {
          const commitResult = await prepared.commitAuthority({
            context,
            job: safeJob,
            output: command.body.completion.status === "succeeded"
              ? command.body.completion.output as ContinuationRuntimeV1WorkerSuccessOutput<R>
              : prepared.output,
          });
          if (commitResult !== undefined) {
            throw new ContinuationRuntimeV1WorkerProcessorError({
              code: "processor_commit_contract_invalid",
              disposition: "dead",
            });
          }
        } catch (error) {
          if (error !== null && typeof error === "object"
            && PROCESSOR_FAILURES.has(error)) {
            throw error;
          }
          throw new ContinuationRuntimeV1WorkerProcessorError({
            code: "processor_authority_commit_failed",
            disposition: "retry",
          });
        }
        await jobs.complete(context, {
          job_id: job.job_id,
          lease_token: job.lease_token!,
        });
        const binding = assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          input.database,
        );
        return deriveContinuationRuntimeV1OperationResultV1(
          input.database,
          binding,
          "before_receipt_insert",
        );
      },
    });
    return attemptResult(execution.status, operationId, execution, job);
  };

  const runProcessor = async (
    job: ContinuationRuntimeV1DurableJob & Readonly<{ job_kind: R }>,
    safeJob: ContinuationRuntimeV1WorkerAttemptJob<R>,
    operationId: string,
    callerSignal: AbortSignal,
  ): Promise<Readonly<{
    prepared: ContinuationRuntimeV1PreparedWorkerSuccess<R> | null;
    failure: ProcessorFailureRecord | null;
  }>> => {
    const processorDeadline = Date.parse(job.lease_expires_at!)
      - processorSafetyMarginMs(input.config.jobs.leaseMs);
    if (!Number.isSafeInteger(processorDeadline)) fail("processor_deadline_invalid");
    if (callerSignal.aborted) {
      return { prepared: null, failure: {
        code: "processor_aborted",
        disposition: "retry",
      } };
    }
    if (authorityNowMilliseconds() >= processorDeadline) {
      return { prepared: null, failure: {
        code: "processor_lease_deadline",
        disposition: "retry",
      } };
    }

    const controller = new AbortController();
    let deadlineReached = false;
    let callerAborted = false;
    let timer: NodeJS.Timeout | null = null;
    let rejectCancellation!: (reason: unknown) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onCallerAbort = (): void => {
      if (deadlineReached || callerAborted) return;
      callerAborted = true;
      controller.abort();
      rejectCancellation(PROCESSOR_ABORT);
    };
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    timer = setTimeout(() => {
      if (deadlineReached || callerAborted) return;
      deadlineReached = true;
      controller.abort();
      rejectCancellation(PROCESSOR_DEADLINE);
    }, Math.max(0, processorDeadline - authorityNowMilliseconds()));

    try {
      const candidate = await Promise.race([
        input.processor.process(Object.freeze({
          schema_version: "continuation_runtime_worker_processor_input_v1" as const,
          attempt_operation_id: operationId,
          job: safeJob,
          signal: controller.signal,
        })),
        cancellation,
      ]);
      if (deadlineReached || authorityNowMilliseconds() >= processorDeadline) {
        controller.abort();
        return { prepared: null, failure: {
          code: "processor_lease_deadline",
          disposition: "retry",
        } };
      }
      if (callerAborted || callerSignal.aborted) {
        controller.abort();
        return { prepared: null, failure: {
          code: "processor_aborted",
          disposition: "retry",
        } };
      }
      let record: Readonly<Record<string, unknown>>;
      try {
        record = exactRecord(candidate, PREPARED_KEYS, "processor_result");
      } catch {
        return { prepared: null, failure: {
          code: "processor_contract_invalid",
          disposition: "dead",
        } };
      }
      if (typeof record.commitAuthority !== "function") {
        return { prepared: null, failure: {
          code: "processor_contract_invalid",
          disposition: "dead",
        } };
      }
      let prepared: ContinuationRuntimeV1PreparedWorkerSuccess<R> = {
        output: record.output as ContinuationRuntimeV1WorkerSuccessOutput<R>,
        commitAuthority: record.commitAuthority as
          ContinuationRuntimeV1WorkerAuthorityCommitPort<R>,
      };
      try {
        // Validate and detach the processor-owned output before opening the
        // operation transaction. The command builder enforces the exact
        // role-specific output schema and maximum body size.
        const checked = buildWorkerCompletionCommandV1(operationId, {
          schema_version: "worker_completion_body_v1",
          completion: { status: "succeeded", output: prepared.output },
        }, leasedBinding(job, principal));
        if (checked.body.completion.status !== "succeeded") {
          return { prepared: null, failure: {
            code: "processor_contract_invalid",
            disposition: "dead",
          } };
        }
        prepared = {
          output: checked.body.completion.output as
            ContinuationRuntimeV1WorkerSuccessOutput<R>,
          commitAuthority: prepared.commitAuthority,
        };
      } catch {
        return { prepared: null, failure: {
          code: "processor_contract_invalid",
          disposition: "dead",
        } };
      }
      return { prepared, failure: null };
    } catch (error) {
      if (deadlineReached || error === PROCESSOR_DEADLINE) {
        return { prepared: null, failure: {
          code: "processor_lease_deadline",
          disposition: "retry",
        } };
      }
      if (callerAborted || callerSignal.aborted || error === PROCESSOR_ABORT) {
        return { prepared: null, failure: {
          code: "processor_aborted",
          disposition: "retry",
        } };
      }
      return {
        prepared: null,
        failure: classifiedProcessorFailure(error, false),
      };
    } finally {
      if (timer !== null) clearTimeout(timer);
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  };

  const processOne = async (
    suppliedJob: ContinuationRuntimeV1DurableJob,
    signal: AbortSignal,
  ): Promise<ContinuationRuntimeV1WorkerAttemptResult> => {
    const job = validateLease(suppliedJob);
    const operationId = operationIdFor(job);
    const replay = await operations.read({
      tenantId: job.tenant_id,
      scope: job.scope,
      operationKind: "worker_completion",
      operationId,
    });
    if (replay) {
      assertPersistedRequestBinding(replay, job, principal);
      return attemptResult("replayed", operationId, replay, job);
    }
    const authoritative = await jobs.read({
      tenant_id: job.tenant_id,
      scope: job.scope,
      job_id: job.job_id,
    });
    if (!authoritative
      || canonicalContinuationJson(authoritative) !== canonicalContinuationJson(job)) {
      fail("leased_job_snapshot_stale");
    }
    const safeJob = attemptJob(job);
    const processed = await runProcessor(job, safeJob, operationId, signal);
    if (processed.failure !== null) {
      return await executeFailure(job, operationId, processed.failure);
    }
    try {
      return await executeSuccess(job, safeJob, operationId, processed.prepared!);
    } catch (error) {
      // A processor-owned commit-port exception is safe to turn into a retry:
      // OperationStore rolled the complete transaction back. Store, receipt,
      // CAS, corruption, and derivation errors remain infrastructure failures
      // and are never disguised as processor failures.
      if (error !== null && typeof error === "object"
        && PROCESSOR_FAILURES.has(error)) {
        return await executeFailure(
          job,
          operationId,
          PROCESSOR_FAILURES.get(error)!,
        );
      }
      throw error;
    }
  };

  const processAcceptedLeasedJob = (
    job: ContinuationRuntimeV1DurableJob,
    signal: AbortSignal = NEVER_ABORTED_SIGNAL,
  ): Promise<ContinuationRuntimeV1WorkerAttemptResult> => {
    assertSignal(signal);
    exactRecord(job, DURABLE_JOB_KEYS, "leased_job");
    const operationId = operationIdFor(job);
    const existing = activeAttempts.get(operationId);
    if (existing) return existing;
    const promise = processOne(job, signal);
    activeAttempts.set(operationId, promise);
    inFlight.add(promise);
    void promise.finally(() => {
      activeAttempts.delete(operationId);
      inFlight.delete(promise);
    }).catch(() => undefined);
    return promise;
  };

  const processLeasedJob = (
    job: ContinuationRuntimeV1DurableJob,
    signal: AbortSignal = NEVER_ABORTED_SIGNAL,
  ): Promise<ContinuationRuntimeV1WorkerAttemptResult> => {
    if (stopped) {
      return Promise.reject(new Error(
        "continuation_runtime_v1_worker_service_new_attempts_stopped",
      ));
    }
    return processAcceptedLeasedJob(job, signal);
  };

  const leaseAndLaunch = (
    signal: AbortSignal,
  ): Promise<Readonly<{
    attempt: Promise<ContinuationRuntimeV1WorkerAttemptResult>;
  }> | null> => {
    let resolveAdmission!: (
      admission: Readonly<{
        attempt: Promise<ContinuationRuntimeV1WorkerAttemptResult>;
      }> | null,
    ) => void;
    let rejectAdmission!: (error: unknown) => void;
    const result = new Promise<Readonly<{
      attempt: Promise<ContinuationRuntimeV1WorkerAttemptResult>;
    }> | null>(
      (resolveResult, rejectResult) => {
        resolveAdmission = resolveResult;
        rejectAdmission = rejectResult;
      },
    );
    const admission = (async (): Promise<void> => {
      if (stopped || signal.aborted) {
        resolveAdmission(null);
        return;
      }
      try {
        const job = await jobs.leaseNext({
          tenant_id: input.config.tenantId,
          job_kind: role,
          lease_owner: leaseOwner,
          lease_duration_ms: input.config.jobs.leaseMs,
        });
        if (job === null) {
          resolveAdmission(null);
          return;
        }
        resolveAdmission(Object.freeze({
          // This lease was admitted before stopNewWork fenced the acquisition
          // gate. It is accepted in-flight work and therefore must be drained,
          // not abandoned until lease expiry.
          attempt: processAcceptedLeasedJob(job, signal),
        }));
      } catch (error) {
        rejectAdmission(error);
      }
    })();
    pendingLeaseAdmission = admission;
    void admission.finally(() => {
      if (pendingLeaseAdmission === admission) pendingLeaseAdmission = null;
    }).catch(() => undefined);
    return result;
  };

  const runBatchInternal = async (
    signal: AbortSignal,
  ): Promise<ContinuationRuntimeV1WorkerBatchResult> => {
    if (stopped || signal.aborted) return emptyBatch();
    const attempts: Array<Promise<ContinuationRuntimeV1WorkerAttemptResult>> = [];
    for (let index = 0; index < input.config.jobs.batchSize; index += 1) {
      if (stopped || signal.aborted) break;
      const admission = await leaseAndLaunch(signal);
      if (admission === null) break;
      attempts.push(admission.attempt);
    }
    const settled = await Promise.allSettled(attempts);
    const failures = settled.flatMap((item) => item.status === "rejected"
      ? [item.reason]
      : []);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "continuation_runtime_v1_worker_batch_failed",
      );
    }
    return batchResult(settled.map((item) => (
      item as PromiseFulfilledResult<ContinuationRuntimeV1WorkerAttemptResult>
    ).value));
  };

  const runBatch = async (
    signal: AbortSignal = NEVER_ABORTED_SIGNAL,
  ): Promise<ContinuationRuntimeV1WorkerBatchResult> => {
    assertSignal(signal);
    if (batchActive || loopActive) fail("concurrent_batch_forbidden");
    batchActive = true;
    try {
      return await runBatchInternal(signal);
    } finally {
      batchActive = false;
    }
  };

  const waitForPoll = async (signal: AbortSignal): Promise<void> => {
    if (stopped || signal.aborted) return;
    await new Promise<void>((resolveWait) => {
      let timer: NodeJS.Timeout | null = null;
      const done = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        stopWaiters.delete(done);
        signal.removeEventListener("abort", done);
        resolveWait();
      };
      stopWaiters.add(done);
      signal.addEventListener("abort", done, { once: true });
      timer = setTimeout(done, input.config.jobs.pollMs);
    });
  };

  const runUntilStopped = async (
    signal: AbortSignal = NEVER_ABORTED_SIGNAL,
  ): Promise<void> => {
    assertSignal(signal);
    if (loopActive || batchActive) fail("concurrent_run_forbidden");
    loopActive = true;
    const onAbort = (): void => requestStop();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!stopped && !signal.aborted) {
        await runBatchInternal(signal);
        await waitForPoll(signal);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      loopActive = false;
    }
  };

  const drainInFlight = async (): Promise<void> => {
    await stopNewWork();
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  };

  return Object.freeze({
    workerPrincipal: () => principal,
    acceptingNewWork: () => !stopped,
    inFlightCount: () => inFlight.size,
    processLeasedJob,
    runBatch,
    runUntilStopped,
    stopNewWork,
    drainInFlight,
  });
}
