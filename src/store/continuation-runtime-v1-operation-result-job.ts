import {
  assertCanonicalUtcMillis,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type CanonicalJson,
} from "../continuation/contract.js";
import { sha256Hex } from "../util/crypto.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  deriveEffectCertificateOperationRefV1,
} from "./continuation-runtime-v1-operation-result-evidence.js";
import type {
  ContinuationRuntimeV1OperationResultDerivationBinding,
  ContinuationRuntimeV1OperationResultDerivationMode,
  DurableJobCompletionOperationRefV1,
  DurableJobCreationOperationRefV1,
  DurableJobTransitionOperationRefV1,
  MemoryRevisionOperationRefV1,
  WorkerCompletionOperationResultV1,
} from "./continuation-runtime-v1-operation-result.js";
import {
  canonicalOperationResultSetV1,
  operationResultCanonicalJson,
  operationResultExact,
  operationResultFail,
  operationResultInteger,
  operationResultSha256,
  operationResultText,
  type OperationResultRow,
} from "./continuation-runtime-v1-operation-result-support.js";

export type ContinuationRuntimeV1WorkerResultDependencies = Readonly<{
  memoryRevisionRef: (
    database: ContinuationRuntimeV1Database,
    binding: ContinuationRuntimeV1OperationResultDerivationBinding,
    mode: ContinuationRuntimeV1OperationResultDerivationMode,
  ) => MemoryRevisionOperationRefV1 | null;
  durableJobCreationRefs: (
    database: ContinuationRuntimeV1Database,
    binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  ) => readonly DurableJobCreationOperationRefV1[];
}>;

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

const WORKER_RESULT_KEYS = Object.freeze([
  "durable_job_set",
  "effect_certificate_ref",
  "memory_revision_ref",
  "schema_version",
  "transition_ref",
] as const);

const TRANSITION_KEYS = Object.freeze([
  "attempt_count",
  "available_at",
  "completed_at",
  "job_id",
  "job_kind",
  "last_error_sha256",
  "payload_sha256",
  "previous_completion_ref",
  "state",
  "terminal_reason",
  "transition_sha256",
  "updated_at",
] as const);

function canonicalTimestamp(value: unknown, field: string): string {
  const text = operationResultText(value, field, 24);
  try {
    assertCanonicalUtcMillis(text, `operation result ${field}`);
  } catch (error) {
    throw new Error(
      `continuation_runtime_v1_operation_result_${field}_timestamp_invalid`,
      { cause: error },
    );
  }
  return text;
}

function completionRef(
  value: unknown,
  field: string,
): DurableJobCompletionOperationRefV1 | null {
  if (value === null) return null;
  const record = operationResultExact(
    value,
    ["operation_id", "request_sha256"],
    field,
  );
  return canonicalContinuationClone({
    operation_id: operationResultText(record.operation_id, `${field}_operation_id`),
    request_sha256: operationResultSha256(
      record.request_sha256,
      `${field}_request`,
    ),
  });
}

function transitionBody(
  binding: Pick<
    ContinuationRuntimeV1OperationResultDerivationBinding,
    "tenantId" | "scope"
  >,
  ref: Omit<DurableJobTransitionOperationRefV1, "transition_sha256">,
): CanonicalJson {
  return {
    schema_version: "durable_job_completion_transition_v1",
    tenant_id: binding.tenantId,
    scope: binding.scope,
    ...ref,
  };
}

function projectTransitionRef(
  value: unknown,
  binding: Pick<
    ContinuationRuntimeV1OperationResultDerivationBinding,
    "tenantId" | "scope"
  >,
): DurableJobTransitionOperationRefV1 {
  const record = operationResultExact(value, TRANSITION_KEYS, "worker_transition");
  const kind = record.job_kind;
  if (kind !== "embedding" && kind !== "ann"
    && kind !== "effect" && kind !== "retention") {
    operationResultFail("worker_transition_job_kind_invalid");
  }
  const jobKind = kind as DurableJobTransitionOperationRefV1["job_kind"];
  const state = record.state;
  if (state !== "queued" && state !== "succeeded" && state !== "dead") {
    operationResultFail("worker_transition_state_invalid");
  }
  const transitionState = state as DurableJobTransitionOperationRefV1["state"];
  const completedAt = record.completed_at === null
    ? null
    : canonicalTimestamp(record.completed_at, "worker_transition_completed_at");
  const terminalReason = record.terminal_reason;
  if (terminalReason !== null && terminalReason !== "worker_succeeded"
    && terminalReason !== "worker_dead") {
    operationResultFail("worker_transition_terminal_reason_invalid");
  }
  const projectedTerminalReason = terminalReason as
    DurableJobTransitionOperationRefV1["terminal_reason"];
  const lastErrorSha = record.last_error_sha256 === null
    ? null
    : operationResultSha256(
      record.last_error_sha256,
      "worker_transition_last_error",
    );
  if ((state === "queued") !== (completedAt === null && terminalReason === null)
    || (state === "succeeded" && (
      completedAt === null || terminalReason !== "worker_succeeded"
      || lastErrorSha !== null
    ))
    || (state === "dead" && (
      completedAt === null || terminalReason !== "worker_dead"
      || lastErrorSha === null
    ))) {
    operationResultFail("worker_transition_state_envelope_invalid");
  }
  const withoutDigest = canonicalContinuationClone({
    job_id: operationResultText(record.job_id, "worker_transition_job_id"),
    job_kind: jobKind,
    payload_sha256: operationResultSha256(
      record.payload_sha256,
      "worker_transition_payload",
    ),
    attempt_count: operationResultInteger(
      record.attempt_count,
      "worker_transition_attempt_count",
      1,
      1_000,
    ),
    state: transitionState,
    previous_completion_ref: completionRef(
      record.previous_completion_ref,
      "worker_transition_previous",
    ),
    available_at: canonicalTimestamp(
      record.available_at,
      "worker_transition_available_at",
    ),
    completed_at: completedAt,
    terminal_reason: projectedTerminalReason,
    last_error_sha256: lastErrorSha,
    updated_at: canonicalTimestamp(
      record.updated_at,
      "worker_transition_updated_at",
    ),
  });
  const transitionSha = operationResultSha256(
    record.transition_sha256,
    "worker_transition",
  );
  if (canonicalContinuationSha256(transitionBody(binding, withoutDigest))
    !== transitionSha) {
    operationResultFail("worker_transition_digest_mismatch");
  }
  return canonicalContinuationClone({
    ...withoutDigest,
    transition_sha256: transitionSha,
  });
}

function currentTransitionRef(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): DurableJobTransitionOperationRefV1 {
  const rows = database.db.prepare(`SELECT * FROM durable_jobs
    WHERE tenant_id = ? AND scope = ?
      AND completion_operation_kind = 'worker_completion'
      AND completion_operation_id = ?
      AND completion_request_sha256 = ?`).all(
        binding.tenantId,
        binding.scope,
        binding.operationId,
        binding.requestSha256,
      ) as OperationResultRow[];
  if (rows.length !== 1) operationResultFail("worker_transition_cardinality");
  const row = rows[0]!;
  const state = row.state;
  if (state !== "queued" && state !== "succeeded" && state !== "dead") {
    operationResultFail("worker_transition_state_invalid");
  }
  const transitionState = state as DurableJobTransitionOperationRefV1["state"];
  const jobKind = row.job_kind;
  if (jobKind !== "embedding" && jobKind !== "ann"
    && jobKind !== "effect" && jobKind !== "retention") {
    operationResultFail("worker_transition_job_kind_invalid");
  }
  const projectedJobKind = jobKind as DurableJobTransitionOperationRefV1["job_kind"];
  const previousTupleAllNull = row.previous_completion_operation_kind === null
    && row.previous_completion_operation_id === null
    && row.previous_completion_request_sha256 === null;
  let previous: DurableJobCompletionOperationRefV1 | null = null;
  if (!previousTupleAllNull) {
    if (row.previous_completion_operation_kind !== "worker_completion") {
      operationResultFail("worker_transition_previous_kind_invalid");
    }
    previous = canonicalContinuationClone({
      operation_id: operationResultText(
        row.previous_completion_operation_id,
        "worker_transition_previous_operation_id",
      ),
      request_sha256: operationResultSha256(
        row.previous_completion_request_sha256,
        "worker_transition_previous_request",
      ),
    });
  }
  const lastError = row.last_error_json === null
    ? null
    : operationResultCanonicalJson(
      row.last_error_json,
      "worker_transition_last_error",
    );
  const completedAt = row.completed_at === null
    ? null
    : canonicalTimestamp(row.completed_at, "worker_transition_completed_at");
  const terminalReason = row.terminal_reason;
  if ((state === "queued" && (completedAt !== null || terminalReason !== null))
    || (state === "succeeded" && terminalReason !== "worker_succeeded")
    || (state === "dead" && terminalReason !== "worker_dead")) {
    operationResultFail("worker_transition_state_envelope_invalid");
  }
  const withoutDigest = canonicalContinuationClone({
    job_id: operationResultText(row.job_id, "worker_transition_job_id"),
    job_kind: projectedJobKind,
    payload_sha256: operationResultSha256(
      row.payload_sha256,
      "worker_transition_payload",
    ),
    attempt_count: operationResultInteger(
      row.attempt_count,
      "worker_transition_attempt_count",
      1,
      1_000,
    ),
    state: transitionState,
    previous_completion_ref: previous,
    available_at: canonicalTimestamp(
      row.available_at,
      "worker_transition_available_at",
    ),
    completed_at: completedAt,
    terminal_reason: terminalReason as "worker_succeeded" | "worker_dead" | null,
    last_error_sha256: lastError === null
      ? null
      : sha256Hex(row.last_error_json as string),
    updated_at: canonicalTimestamp(row.updated_at, "worker_transition_updated_at"),
  });
  return canonicalContinuationClone({
    ...withoutDigest,
    transition_sha256: canonicalContinuationSha256(
      transitionBody(binding, withoutDigest),
    ),
  });
}

function projectWorkerResult(
  value: unknown,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): Readonly<{
  raw: OperationResultRow;
  transition: DurableJobTransitionOperationRefV1;
}> {
  const record = operationResultExact(value, WORKER_RESULT_KEYS, "worker_result");
  if (record.schema_version !== "worker_completion_result_v1") {
    operationResultFail("worker_result_schema_invalid");
  }
  return {
    raw: record,
    transition: projectTransitionRef(record.transition_ref, binding),
  };
}

function persistedCanonicalJsonMatches(
  value: unknown,
  digest: unknown,
  maxBytes: number,
): value is string {
  if (typeof value !== "string" || typeof digest !== "string"
    || !/^[0-9a-f]{64}$/u.test(digest)
    || Buffer.byteLength(value, "utf8") > maxBytes
    || sha256Hex(value) !== digest) {
    return false;
  }
  try {
    return canonicalContinuationJson(JSON.parse(value)) === value;
  } catch {
    return false;
  }
}

function persistedWorkerReceipt(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  ref: DurableJobCompletionOperationRefV1,
): Readonly<{
  result: OperationResultRow;
  transition: DurableJobTransitionOperationRefV1;
}> {
  const row = database.db.prepare(`SELECT actor_kind, actor_principal_sha256,
      request_sha256, request_json, receipt_sha256, receipt_json, completed_at
    FROM operations WHERE tenant_id = ? AND scope = ?
      AND operation_kind = 'worker_completion' AND operation_id = ?
      AND request_sha256 = ?`).get(
        binding.tenantId,
        binding.scope,
        ref.operation_id,
        ref.request_sha256,
      ) as OperationResultRow | undefined;
  if (!row || row.actor_kind !== "worker"
    || typeof row.actor_principal_sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(row.actor_principal_sha256)
    || !persistedCanonicalJsonMatches(
      row.request_json,
      row.request_sha256,
      8_388_608,
    )
    || !persistedCanonicalJsonMatches(
      row.receipt_json,
      row.receipt_sha256,
      262_144,
    )) {
    operationResultFail("worker_lineage_receipt_corrupt");
  }
  const envelope = operationResultExact(
    JSON.parse(row.receipt_json),
    RECEIPT_KEYS,
    "worker_lineage_receipt",
  );
  if (envelope.schema_version !== "continuation_runtime_operation_receipt_v1"
    || envelope.tenant_id !== binding.tenantId
    || envelope.scope !== binding.scope
    || envelope.operation_kind !== "worker_completion"
    || envelope.operation_id !== ref.operation_id
    || envelope.request_sha256 !== ref.request_sha256
    || envelope.request_sha256 !== row.request_sha256
    || envelope.actor_kind !== "worker"
    || envelope.actor_principal_sha256 !== row.actor_principal_sha256
    || envelope.completed_at !== row.completed_at) {
    operationResultFail("worker_lineage_receipt_identity_mismatch");
  }
  const projected = projectWorkerResult(envelope.result, binding);
  return { result: projected.raw, transition: projected.transition };
}

function historicalTransitionRef(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  persistedResultHint: unknown,
): DurableJobTransitionOperationRefV1 {
  const hinted = projectWorkerResult(persistedResultHint, binding).transition;
  const job = database.db.prepare(`SELECT job_id, job_kind, payload_sha256,
      attempt_count, completion_operation_kind, completion_operation_id,
      completion_request_sha256 FROM durable_jobs
    WHERE tenant_id = ? AND scope = ? AND job_id = ?`).get(
      binding.tenantId,
      binding.scope,
      hinted.job_id,
    ) as OperationResultRow | undefined;
  if (!job || job.job_kind !== hinted.job_kind
    || job.payload_sha256 !== hinted.payload_sha256
    || job.completion_operation_kind !== "worker_completion"
    || typeof job.completion_operation_id !== "string"
    || typeof job.completion_request_sha256 !== "string") {
    operationResultFail("worker_lineage_job_mismatch");
  }
  const seen = new Set<string>();
  let current: DurableJobCompletionOperationRefV1 = {
    operation_id: job.completion_operation_id,
    request_sha256: operationResultSha256(
      job.completion_request_sha256,
      "worker_lineage_current_request",
    ),
  };
  let newerAttempt = operationResultInteger(
    job.attempt_count,
    "worker_lineage_job_attempt",
    1,
    1_000,
  ) + 1;
  for (let depth = 0; depth <= 1_000; depth += 1) {
    const key = canonicalContinuationJson(current);
    if (seen.has(key)) operationResultFail("worker_lineage_cycle");
    seen.add(key);
    const receipt = persistedWorkerReceipt(database, binding, current);
    if (receipt.transition.job_id !== hinted.job_id
      || receipt.transition.job_kind !== hinted.job_kind
      || receipt.transition.payload_sha256 !== hinted.payload_sha256
      || receipt.transition.attempt_count >= newerAttempt) {
      operationResultFail("worker_lineage_transition_mismatch");
    }
    if (current.operation_id === binding.operationId
      && current.request_sha256 === binding.requestSha256) {
      if (canonicalContinuationJson(receipt.transition)
        !== canonicalContinuationJson(hinted)) {
        operationResultFail("worker_lineage_target_mismatch");
      }
      return receipt.transition;
    }
    newerAttempt = receipt.transition.attempt_count;
    if (receipt.transition.previous_completion_ref === null) {
      operationResultFail("worker_lineage_target_missing");
    }
    current = receipt.transition.previous_completion_ref;
  }
  operationResultFail("worker_lineage_depth_exceeded");
}

function assertWorkerMutationClass(
  transition: DurableJobTransitionOperationRefV1,
  memory: MemoryRevisionOperationRefV1 | null,
  effect: ReturnType<typeof deriveEffectCertificateOperationRefV1>,
  jobs: readonly DurableJobCreationOperationRefV1[],
): void {
  if (transition.state !== "succeeded") {
    if (memory !== null || effect !== null || jobs.length !== 0) {
      operationResultFail("worker_failed_transition_has_authority_mutation");
    }
    return;
  }
  if (transition.job_kind === "effect") {
    if (effect === null || memory !== null || jobs.length !== 0) {
      operationResultFail("effect_worker_mutation_class_invalid");
    }
    return;
  }
  if (effect !== null) operationResultFail("non_effect_worker_certificate_forbidden");
  if (transition.job_kind === "embedding") {
    if (memory !== null || jobs.length !== 1 || jobs[0]!.job_kind !== "ann") {
      operationResultFail("embedding_worker_child_job_invalid");
    }
    return;
  }
  if (transition.job_kind === "ann") {
    if (memory !== null || jobs.length !== 0) {
      operationResultFail("ann_worker_mutation_class_invalid");
    }
    return;
  }
  if (memory !== null || jobs.length !== 0) {
    operationResultFail("retention_worker_mutation_class_invalid");
  }
}

export function deriveWorkerCompletionOperationResultV1(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  mode: ContinuationRuntimeV1OperationResultDerivationMode,
  persistedResultHint: unknown,
  dependencies: ContinuationRuntimeV1WorkerResultDependencies,
): WorkerCompletionOperationResultV1 {
  const transition = mode === "before_receipt_insert"
    ? currentTransitionRef(database, binding)
    : historicalTransitionRef(database, binding, persistedResultHint);
  const memory = dependencies.memoryRevisionRef(database, binding, mode);
  const effect = deriveEffectCertificateOperationRefV1(database, binding);
  const jobs = dependencies.durableJobCreationRefs(database, binding);
  assertWorkerMutationClass(transition, memory, effect, jobs);
  return canonicalContinuationClone({
    schema_version: "worker_completion_result_v1" as const,
    transition_ref: transition,
    memory_revision_ref: memory,
    effect_certificate_ref: effect,
    durable_job_set: canonicalOperationResultSetV1(jobs),
  });
}
