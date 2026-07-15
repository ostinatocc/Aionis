import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  FeedbackAttributedV1Schema,
  type FeedbackAttributedV1,
} from "../memory/learning-episode-ledger.js";
import { sha256Hex } from "../util/crypto.js";
import { stableUuid } from "../util/uuid.js";
import type { LiteRuntimeDatabase } from "./lite-runtime-database.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";

const BoundedId = z.string().trim().min(1).max(256);
const CanonicalTimestamp = z.string().datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);

export const UnusedExposureLearningControlPayloadSchema = z.object({
  contract_version: z.literal("unused_exposure_learning_control_v1"),
  exposure_ids: z.array(BoundedId).length(1),
  feedback_event_id: BoundedId,
}).strict().superRefine((value, context) => {
  const canonical = canonicalStrings(value.exposure_ids);
  if (canonical.length !== value.exposure_ids.length
    || canonical.some((entry, index) => entry !== value.exposure_ids[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["exposure_ids"],
      message: "exposure_ids must be unique and sorted by UTF-8 bytes",
    });
  }
});

export type UnusedExposureLearningControlPayload = z.infer<
  typeof UnusedExposureLearningControlPayloadSchema
>;

export type LiteLearningControlJobStatus = "pending" | "leased" | "completed" | "dead_letter";

export type LiteLearningControlJobRow = Readonly<{
  row_id: number;
  tenant_id: string;
  scope: string;
  job_id: string;
  job_kind: "unused_exposure_learning_control_v1";
  operation_id: string;
  source_episode_id: string;
  source_feedback_event_id: string;
  source_commit_id: string;
  payload_sha256: string;
  payload_json: string;
  status: LiteLearningControlJobStatus;
  attempt_count: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  result_commit_id: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

export type LiteLearningControlJobClaim = LiteLearningControlJobRow & Readonly<{
  status: "leased";
  lease_owner: string;
  lease_expires_at: string;
  claim_mode: "execute" | "terminalize_exhausted";
}>;

export type LiteUnusedExposureLearningControlFacts = Readonly<{
  job: LiteLearningControlJobRow;
  payload: UnusedExposureLearningControlPayload;
  feedback: FeedbackAttributedV1;
  feedback_event_row_id: number;
  feedback_event_sha256: string;
  feedback_recorded_at: string;
  source_guide_trace_id: string;
  source_exposure_event_id: string;
  source_exposure_event_sha256: string;
  source_exposure_enrollment_state: string;
  source_consumer_agent_id: string | null;
  source_consumer_team_id: string | null;
  source_guide_ledger_sha256: string;
  source_guide_ledger_json: string;
  unused_memory_ids: readonly string[];
  memory_stats: readonly Readonly<{
    memory_id: string;
    repeated_without_positive_attribution: boolean;
    exposure_count: number;
    positive_attributed_use_count: number;
  }>[];
}>;

export type LiteLearningControlBacklogSnapshot = Readonly<{
  pending: number;
  leased: number;
  expired_leases: number;
  completed: number;
  dead_letter: number;
  exhausted: number;
  oldest_available_at: string | null;
  oldest_lease_expiry: string | null;
}>;

export type LiteLearningControlSafetySource = Readonly<{
  job: LiteLearningControlJobRow;
  feedback_event_row_id: number;
  source_guide_trace_id: string;
  source_exposure_enrollment_state: string;
}>;

export type LiteLearningControlJobAccess = {
  transactionRunner(): SqliteTransactionRunner;
  enqueueUnusedExposureLearningControlJob(args: {
    tenantId: string;
    scope: string;
    sourceEpisodeId: string;
    sourceFeedbackEventId: string;
    sourceCommitId: string;
    exposureIds: readonly string[];
    enqueuedAt: string;
  }): Promise<{ status: "queued" | "already_completed"; job: LiteLearningControlJobRow }>;
  claimLearningControlJobs(args: {
    leaseOwner: string;
    leaseMs: number;
    limit: number;
    now?: Date;
  }): Promise<LiteLearningControlJobClaim[]>;
  loadUnusedExposureLearningControlFactsInTx(args: {
    claim: LiteLearningControlJobClaim;
    now: Date;
  }): Promise<LiteUnusedExposureLearningControlFacts | null>;
  loadLearningControlSafetySourceInTx(args: {
    claim: LiteLearningControlJobClaim;
    now: Date;
  }): Promise<LiteLearningControlSafetySource | null>;
  completeLearningControlJobInTx(args: {
    claim: LiteLearningControlJobClaim;
    resultCommitId: string;
    completedAt: string;
  }): Promise<boolean>;
  retryLearningControlJob(args: {
    claim: LiteLearningControlJobClaim;
    errorCode: string;
    retryAt: Date;
    now?: Date;
  }): Promise<"retried" | "exhausted" | "stale_claim">;
  deferLearningControlJobTerminalization(args: {
    claim: LiteLearningControlJobClaim;
    errorCode: string;
    retryAt: Date;
    now?: Date;
  }): Promise<"deferred" | "stale_claim">;
  deadLetterLearningControlJobInTx(args: {
    claim: LiteLearningControlJobClaim;
    errorCode: string;
    completedAt: string;
  }): Promise<boolean>;
  listLearningControlJobs(args?: {
    statuses?: readonly LiteLearningControlJobStatus[];
    limit?: number;
  }): Promise<LiteLearningControlJobRow[]>;
  learningControlBacklogSnapshot(now?: Date): Promise<LiteLearningControlBacklogSnapshot>;
};

type BuiltLearningControlJob = Omit<LiteLearningControlJobRow, "row_id">;
type SqlRow = Record<string, unknown>;

export class LiteLearningControlJobValidationError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "LiteLearningControlJobValidationError";
    this.code = sanitizeLearningControlErrorCode(code);
  }
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => BoundedId.parse(value)))].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

function requiredId(value: string, field: string): string {
  try {
    return BoundedId.parse(value);
  } catch {
    throw new Error(`${field} must be a bounded non-empty identifier`);
  }
}

function statementChanges(value: unknown): number {
  return Number((value as { changes?: number } | null | undefined)?.changes ?? 0);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function assertInTransaction(transaction: SqliteTransactionRunner): void {
  if (!transaction.inTransaction()) {
    throw new Error("learning control job mutation must share the Runtime transaction");
  }
}

function parseCanonicalJson(raw: string, code: string): unknown {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new LiteLearningControlJobValidationError(code);
  }
  if (stableStringify(decoded) !== raw) {
    throw new LiteLearningControlJobValidationError(code);
  }
  return decoded;
}

function parseJobRow(row: SqlRow): LiteLearningControlJobRow {
  const parsed = row as unknown as LiteLearningControlJobRow;
  if (!Number.isSafeInteger(Number(parsed.row_id)) || Number(parsed.row_id) < 1) {
    throw new LiteLearningControlJobValidationError("invalid_learning_control_job_row");
  }
  return { ...parsed, row_id: Number(parsed.row_id), attempt_count: Number(parsed.attempt_count) };
}

function immutableJobProjection(row: LiteLearningControlJobRow | BuiltLearningControlJob) {
  return {
    tenant_id: row.tenant_id,
    scope: row.scope,
    job_id: row.job_id,
    job_kind: row.job_kind,
    operation_id: row.operation_id,
    source_episode_id: row.source_episode_id,
    source_feedback_event_id: row.source_feedback_event_id,
    source_commit_id: row.source_commit_id,
    payload_sha256: row.payload_sha256,
    payload_json: row.payload_json,
    created_at: row.created_at,
  };
}

export function buildUnusedExposureLearningControlJob(args: {
  tenantId: string;
  scope: string;
  sourceEpisodeId: string;
  sourceFeedbackEventId: string;
  sourceCommitId: string;
  exposureIds: readonly string[];
  enqueuedAt: string;
}): BuiltLearningControlJob {
  const tenantId = requiredId(args.tenantId, "tenantId");
  const scope = requiredId(args.scope, "scope");
  const sourceEpisodeId = requiredId(args.sourceEpisodeId, "sourceEpisodeId");
  const sourceFeedbackEventId = requiredId(args.sourceFeedbackEventId, "sourceFeedbackEventId");
  const sourceCommitId = requiredId(args.sourceCommitId, "sourceCommitId");
  const enqueuedAt = CanonicalTimestamp.parse(args.enqueuedAt);
  const exposureIds = canonicalStrings(args.exposureIds);
  const payload = UnusedExposureLearningControlPayloadSchema.parse({
    contract_version: "unused_exposure_learning_control_v1",
    exposure_ids: exposureIds,
    feedback_event_id: sourceFeedbackEventId,
  });
  const payloadJson = stableStringify(payload);
  const payloadSha256 = sha256Hex(payloadJson);
  const jobId = `lctrl_job_${sha256Hex(stableStringify({
    contract_version: "unused_exposure_learning_control_job_identity_v1",
    tenant_id: tenantId,
    scope,
    source_episode_id: sourceEpisodeId,
    source_feedback_event_id: sourceFeedbackEventId,
    source_commit_id: sourceCommitId,
    payload_sha256: payloadSha256,
  }))}`;
  const operationId = `lctrl_op_${sha256Hex(stableStringify({
    contract_version: "unused_exposure_learning_control_operation_v1",
    job_id: jobId,
  }))}`;
  return {
    tenant_id: tenantId,
    scope,
    job_id: jobId,
    job_kind: "unused_exposure_learning_control_v1",
    operation_id: operationId,
    source_episode_id: sourceEpisodeId,
    source_feedback_event_id: sourceFeedbackEventId,
    source_commit_id: sourceCommitId,
    payload_sha256: payloadSha256,
    payload_json: payloadJson,
    status: "pending",
    attempt_count: 0,
    available_at: enqueuedAt,
    lease_owner: null,
    lease_expires_at: null,
    result_commit_id: null,
    last_error_code: null,
    created_at: enqueuedAt,
    updated_at: enqueuedAt,
    completed_at: null,
  };
}

export function learningControlOperationRequestSha256(
  job: Pick<LiteLearningControlJobRow,
    | "tenant_id" | "scope" | "job_id" | "operation_id" | "source_episode_id"
    | "source_feedback_event_id" | "source_commit_id" | "payload_sha256">,
): string {
  return sha256Hex(stableStringify({
    contract_version: "unused_exposure_learning_control_operation_request_v1",
    tenant_id: job.tenant_id,
    scope: job.scope,
    job_id: job.job_id,
    operation_id: job.operation_id,
    source_episode_id: job.source_episode_id,
    source_feedback_event_id: job.source_feedback_event_id,
    source_commit_id: job.source_commit_id,
    payload_sha256: job.payload_sha256,
  }));
}

export function sanitizeLearningControlErrorCode(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").trim().slice(0, 120) || "learning_control_failed";
}

const WORKER_RECEIPT_FIELDS = [
  "contract_version", "status", "tenant_id", "scope", "job_id", "operation_kind",
  "operation_id", "source_episode_id", "source_feedback_event_id", "source_commit_id",
  "payload_sha256", "attempt_count", "result_commit_id", "changed_memory_ids",
  "skipped_positive_attribution_memory_ids", "missing_node_ids", "last_error_code",
  "completed_at",
] as const;

function exactWorkerReceipt(raw: string): SqlRow {
  const value = parseCanonicalJson(raw, "learning_control_worker_receipt_invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("lite_learning_integrity_failed:learning_control_worker_receipt_object");
  }
  const receipt = value as SqlRow;
  if (stableStringify(Object.keys(receipt).sort())
    !== stableStringify([...WORKER_RECEIPT_FIELDS].sort())) {
    throw new Error("lite_learning_integrity_failed:learning_control_worker_receipt_shape");
  }
  return receipt;
}

function exactStringArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || entry.length === 0)
    || new Set(value).size !== value.length) {
    throw new Error(`lite_learning_integrity_failed:${code}`);
  }
  return value as string[];
}

function exactObject(value: unknown, fields: readonly string[], code: string): SqlRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`lite_learning_integrity_failed:${code}_object`);
  }
  const row = value as SqlRow;
  if (stableStringify(Object.keys(row).sort()) !== stableStringify([...fields].sort())) {
    throw new Error(`lite_learning_integrity_failed:${code}_shape`);
  }
  return row;
}

const LEARNING_CONTROL_COMMIT_DIFF_FIELDS = [
  "job", "learning_control_job_id", "source_episode_id", "source_feedback_event_id",
  "evidence_cutoff_event_row_id", "started_at", "scope", "actor", "run_id",
  "guide_trace_id", "reason", "requested_node_ids", "resolved_node_ids",
  "applied_node_ids", "skipped_positive_attribution_memory_ids", "missing_node_ids",
  "evidence_source",
] as const;

export function assertLiteLearningControlJobOperationIntegrity(
  db: SqliteDatabase,
  rawJob: Record<string, unknown>,
): void {
  const stored = db.prepare(
    `SELECT * FROM lite_learning_control_jobs
     WHERE tenant_id = ? AND scope = ? AND job_id = ?`,
  ).get(rawJob.tenant_id, rawJob.scope, rawJob.job_id) as SqlRow | undefined;
  if (!stored) throw new Error("lite_learning_integrity_failed:learning_control_job_missing");
  const job = parseJobRow(stored);
  const operation = db.prepare(
    `SELECT request_sha256, receipt_json, commit_id
     FROM lite_runtime_write_operations
     WHERE tenant_id = ? AND scope = ?
       AND operation_kind = 'unused_exposure_learning_control_v1'
       AND operation_id = ?`,
  ).get(job.tenant_id, job.scope, job.operation_id) as SqlRow | undefined;
  if (job.status === "pending" || job.status === "leased") {
    if (operation) {
      throw new Error("lite_learning_integrity_failed:learning_control_nonterminal_operation_receipt");
    }
    return;
  }
  if (!operation || typeof operation.receipt_json !== "string") {
    throw new Error("lite_learning_integrity_failed:learning_control_operation_receipt_missing");
  }
  const requestSha256 = learningControlOperationRequestSha256(job);
  const receipt = exactWorkerReceipt(operation.receipt_json);
  const binding = {
    contract_version: "unused_exposure_learning_control_operation_receipt_v1",
    status: job.status === "completed" ? "completed" : "dead_letter",
    tenant_id: job.tenant_id,
    scope: job.scope,
    job_id: job.job_id,
    operation_kind: "unused_exposure_learning_control_v1",
    operation_id: job.operation_id,
    source_episode_id: job.source_episode_id,
    source_feedback_event_id: job.source_feedback_event_id,
    source_commit_id: job.source_commit_id,
    payload_sha256: job.payload_sha256,
    attempt_count: job.attempt_count,
    result_commit_id: job.result_commit_id,
    last_error_code: job.last_error_code,
    completed_at: job.completed_at,
  } as const;
  if (operation.request_sha256 !== requestSha256
    || Object.entries(binding).some(([field, expected]) => receipt[field] !== expected)) {
    throw new Error("lite_learning_integrity_failed:learning_control_operation_receipt_binding");
  }
  exactStringArray(receipt.changed_memory_ids, "learning_control_changed_memory_ids");
  exactStringArray(
    receipt.skipped_positive_attribution_memory_ids,
    "learning_control_skipped_positive_memory_ids",
  );
  exactStringArray(receipt.missing_node_ids, "learning_control_missing_node_ids");
  if (job.status === "dead_letter") {
    if (operation.commit_id !== job.source_commit_id
      || (receipt.changed_memory_ids as unknown[]).length !== 0
      || (receipt.skipped_positive_attribution_memory_ids as unknown[]).length !== 0
      || (receipt.missing_node_ids as unknown[]).length !== 0) {
      throw new Error("lite_learning_integrity_failed:learning_control_dead_letter_receipt");
    }
    return;
  }
  const commit = db.prepare(
    `SELECT id, scope, parent_commit_id, input_sha256, diff_json, actor,
            model_version, prompt_version, commit_hash, created_at
     FROM lite_memory_commits WHERE id = ?`,
  ).get(job.result_commit_id) as SqlRow | undefined;
  if (!commit
    || operation.commit_id !== job.result_commit_id
    || commit.input_sha256 !== requestSha256
    || typeof commit.scope !== "string"
    || typeof commit.actor !== "string"
    || typeof commit.diff_json !== "string"
    || typeof commit.commit_hash !== "string"
    || !/^[a-f0-9]{64}$/u.test(commit.commit_hash)
    || commit.model_version !== null
    || commit.prompt_version !== null) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit");
  }
  const diff = exactObject(
    parseCanonicalJson(commit.diff_json, "learning_control_result_commit_diff_invalid"),
    LEARNING_CONTROL_COMMIT_DIFF_FIELDS,
    "learning_control_result_commit_diff",
  );
  const feedbackEvent = db.prepare(
    `SELECT row_id, episode_id, payload_json
     FROM lite_learning_episode_events
     WHERE tenant_id = ? AND scope = ? AND event_id = ?
       AND event_kind = 'feedback_attributed'`,
  ).get(job.tenant_id, job.scope, job.source_feedback_event_id) as SqlRow | undefined;
  const sourceExposure = db.prepare(
    `SELECT event_id, source_id, memory_namespace_sha256
     FROM lite_learning_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND event_kind = 'exposure_committed'`,
  ).get(job.tenant_id, job.scope, job.source_episode_id) as SqlRow | undefined;
  const feedback = feedbackEvent && typeof feedbackEvent.payload_json === "string"
    ? FeedbackAttributedV1Schema.safeParse(parseCanonicalJson(
        feedbackEvent.payload_json,
        "learning_control_result_feedback_invalid",
      ))
    : null;
  const guideReceipt = sourceExposure && typeof sourceExposure.source_id === "string"
    ? db.prepare(
      `SELECT consumer_agent_id, consumer_team_id
       FROM lite_product_guide_receipts
       WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
    ).get(job.tenant_id, job.scope, sourceExposure.source_id) as SqlRow | undefined
    : undefined;
  if (!feedbackEvent || feedbackEvent.episode_id !== job.source_episode_id
    || !sourceExposure || typeof sourceExposure.event_id !== "string"
    || typeof sourceExposure.source_id !== "string"
    || typeof sourceExposure.memory_namespace_sha256 !== "string"
    || sourceExposure.memory_namespace_sha256 !== sha256Hex(commit.scope)
    || !guideReceipt || !feedback || !feedback.success) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_source");
  }
  const sourceItems = db.prepare(
    `SELECT memory_id FROM lite_learning_exposure_items
     WHERE tenant_id = ? AND scope = ? AND event_id = ?
     ORDER BY memory_id`,
  ).all(job.tenant_id, job.scope, sourceExposure.event_id) as Array<{ memory_id: string }>;
  const usedRows = db.prepare(
    `SELECT subject_id FROM lite_learning_feedback_attributions
     WHERE tenant_id = ? AND scope = ? AND event_id = ? AND subject_kind = 'memory'
     ORDER BY subject_id`,
  ).all(job.tenant_id, job.scope, job.source_feedback_event_id) as Array<{ subject_id: string }>;
  const used = new Set(usedRows.map((row) => row.subject_id));
  const expectedRequested: string[] = [];
  for (const memoryId of canonicalStrings(sourceItems
    .map((row) => row.memory_id)
    .filter((memoryId) => !used.has(memoryId)))) {
    const exposureCount = db.prepare(
      `SELECT COUNT(*) AS count
       FROM lite_learning_exposure_items AS item
       JOIN lite_learning_episode_events AS exposure
         ON exposure.tenant_id = item.tenant_id AND exposure.scope = item.scope
        AND exposure.event_id = item.event_id AND exposure.event_kind = 'exposure_committed'
       JOIN lite_product_guide_receipts AS guide
         ON guide.tenant_id = exposure.tenant_id AND guide.scope = exposure.scope
        AND guide.guide_trace_id = exposure.source_id
       WHERE exposure.tenant_id = ? AND exposure.scope = ? AND exposure.row_id <= ?
         AND item.memory_id = ? AND guide.consumer_agent_id IS ?
         AND guide.consumer_team_id IS ?`,
    ).get(
      job.tenant_id,
      job.scope,
      Number(feedbackEvent.row_id),
      memoryId,
      guideReceipt.consumer_agent_id ?? null,
      guideReceipt.consumer_team_id ?? null,
    ) as { count: number };
    const positiveCount = db.prepare(
      `SELECT COUNT(*) AS count
       FROM lite_learning_feedback_attributions AS attribution
       JOIN lite_learning_episode_events AS feedback_event
         ON feedback_event.tenant_id = attribution.tenant_id
        AND feedback_event.scope = attribution.scope
        AND feedback_event.event_id = attribution.event_id
        AND feedback_event.event_kind = 'feedback_attributed'
       JOIN lite_learning_episode_events AS exposure
         ON exposure.tenant_id = feedback_event.tenant_id
        AND exposure.scope = feedback_event.scope
        AND exposure.episode_id = feedback_event.episode_id
        AND exposure.event_kind = 'exposure_committed'
       JOIN lite_product_guide_receipts AS guide
         ON guide.tenant_id = exposure.tenant_id AND guide.scope = exposure.scope
        AND guide.guide_trace_id = exposure.source_id
       WHERE feedback_event.tenant_id = ? AND feedback_event.scope = ?
         AND feedback_event.row_id <= ? AND attribution.subject_kind = 'memory'
         AND attribution.subject_id = ? AND attribution.outcome = 'positive'
         AND attribution.attribution_strength = 'positive_attribution'
         AND attribution.boundary_outcome = 'aligned'
         AND guide.consumer_agent_id IS ? AND guide.consumer_team_id IS ?`,
    ).get(
      job.tenant_id,
      job.scope,
      Number(feedbackEvent.row_id),
      memoryId,
      guideReceipt.consumer_agent_id ?? null,
      guideReceipt.consumer_team_id ?? null,
    ) as { count: number };
    if (Number(exposureCount.count) >= 2 && Number(positiveCount.count) === 0) {
      expectedRequested.push(memoryId.toLowerCase());
    }
  }
  const requested = exactStringArray(diff.requested_node_ids, "learning_control_requested_node_ids");
  const resolved = exactStringArray(diff.resolved_node_ids, "learning_control_resolved_node_ids");
  const applied = exactStringArray(diff.applied_node_ids, "learning_control_applied_node_ids");
  const skipped = exactStringArray(
    diff.skipped_positive_attribution_memory_ids,
    "learning_control_diff_skipped_positive_memory_ids",
  );
  const missing = exactStringArray(diff.missing_node_ids, "learning_control_diff_missing_node_ids");
  const changedReceipt = receipt.changed_memory_ids as string[];
  const skippedReceipt = receipt.skipped_positive_attribution_memory_ids as string[];
  const missingReceipt = receipt.missing_node_ids as string[];
  const appliedSet = new Set(applied);
  const skippedSet = new Set(skipped);
  const missingSet = new Set(missing);
  const partitionValid = requested.every((memoryId) =>
    Number(appliedSet.has(memoryId)) + Number(skippedSet.has(memoryId)) + Number(missingSet.has(memoryId)) === 1
  ) && applied.every((memoryId) => requested.includes(memoryId))
    && skipped.every((memoryId) => requested.includes(memoryId))
    && missing.every((memoryId) => requested.includes(memoryId));
  if (diff.job !== "feedback_learning_control_inspect_before_use"
    || diff.learning_control_job_id !== job.job_id
    || diff.source_episode_id !== job.source_episode_id
    || diff.source_feedback_event_id !== job.source_feedback_event_id
    || Number(diff.evidence_cutoff_event_row_id) !== Number(feedbackEvent.row_id)
    || diff.guide_trace_id !== sourceExposure.source_id
    || diff.guide_trace_id !== feedback.data.guide_trace_id
    || diff.run_id !== feedback.data.run_id
    || diff.started_at !== job.completed_at
    || diff.scope !== commit.scope
    || diff.actor !== commit.actor
    || (typeof guideReceipt.consumer_agent_id === "string"
      && diff.actor !== guideReceipt.consumer_agent_id)
    || diff.reason !== "Repeated exposure without positive host attribution crossed the durable inspect-before-use gate."
    || diff.evidence_source !== "repeated_unused_without_positive_attribution"
    || stableStringify(requested) !== stableStringify(expectedRequested)
    || stableStringify(resolved) !== stableStringify(requested)
    || !partitionValid
    || stableStringify(applied) !== stableStringify(requested.filter((id) => appliedSet.has(id)))
    || stableStringify(skipped) !== stableStringify(requested.filter((id) => skippedSet.has(id)))
    || stableStringify(missing) !== stableStringify(requested.filter((id) => missingSet.has(id)))
    || stableStringify(applied) !== stableStringify(changedReceipt)
    || stableStringify(skipped) !== stableStringify(skippedReceipt)
    || stableStringify(missing) !== stableStringify(missingReceipt)) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_binding");
  }
  let parentHash = "";
  if (commit.parent_commit_id !== null) {
    const parent = db.prepare(
      "SELECT commit_hash FROM lite_memory_commits WHERE id = ? AND scope = ?",
    ).get(commit.parent_commit_id, commit.scope) as SqlRow | undefined;
    if (!parent || typeof parent.commit_hash !== "string" || !/^[a-f0-9]{64}$/u.test(parent.commit_hash)) {
      throw new Error("lite_learning_integrity_failed:learning_control_result_commit_parent");
    }
    parentHash = parent.commit_hash;
  }
  const expectedCommitHash = sha256Hex(stableStringify({
    parentHash,
    inputSha: commit.input_sha256,
    diffSha: sha256Hex(commit.diff_json),
    scope: commit.scope,
    actor: commit.actor,
    kind: "feedback_learning_control_inspect_before_use",
  }));
  if (commit.commit_hash !== expectedCommitHash
    || commit.id !== stableUuid(`lite:commit:${expectedCommitHash}`)) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_hash");
  }
}

export function assertNoOrphanLiteLearningControlOperations(db: SqliteDatabase): void {
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM lite_runtime_write_operations AS operation
     WHERE operation.operation_kind = 'unused_exposure_learning_control_v1'
       AND NOT EXISTS (
         SELECT 1 FROM lite_learning_control_jobs AS job
         WHERE job.tenant_id = operation.tenant_id AND job.scope = operation.scope
           AND job.operation_id = operation.operation_id
           AND job.status IN ('completed', 'dead_letter')
       )`,
  ).get() as { count: number };
  if (Number(row.count) !== 0) {
    throw new Error("lite_learning_integrity_failed:orphan_learning_control_operation_receipt");
  }
}

function claimTuple(claim: LiteLearningControlJobClaim): unknown[] {
  return [
    claim.row_id,
    claim.tenant_id,
    claim.scope,
    claim.job_id,
    claim.attempt_count,
    claim.lease_owner,
    claim.lease_expires_at,
  ];
}

function currentClaimRow(
  db: LiteRuntimeDatabase["db"],
  claim: LiteLearningControlJobClaim,
  now: string,
): LiteLearningControlJobRow | null {
  const row = db.prepare(
    `SELECT * FROM lite_learning_control_jobs
     WHERE row_id = ? AND tenant_id = ? AND scope = ? AND job_id = ?
       AND attempt_count = ? AND status = 'leased'
       AND lease_owner = ? AND lease_expires_at = ? AND lease_expires_at > ?`,
  ).get(...claimTuple(claim), now) as SqlRow | undefined;
  return row ? parseJobRow(row) : null;
}

function jobPayload(row: LiteLearningControlJobRow): UnusedExposureLearningControlPayload {
  if (sha256Hex(row.payload_json) !== row.payload_sha256) {
    throw new LiteLearningControlJobValidationError("learning_control_payload_digest_mismatch");
  }
  const payload = UnusedExposureLearningControlPayloadSchema.safeParse(
    parseCanonicalJson(row.payload_json, "invalid_learning_control_payload"),
  );
  if (!payload.success
    || payload.data.feedback_event_id !== row.source_feedback_event_id) {
    throw new LiteLearningControlJobValidationError("invalid_learning_control_payload");
  }
  return payload.data;
}

export function createLiteLearningControlJobAccess(
  database: LiteRuntimeDatabase,
): LiteLearningControlJobAccess {
  const { db, transaction } = database;

  return {
    transactionRunner() {
      return transaction;
    },

    async enqueueUnusedExposureLearningControlJob(args) {
      assertInTransaction(transaction);
      const built = buildUnusedExposureLearningControlJob(args);
      const source = db.prepare(
        `SELECT episode_id, source_commit_id, payload_json, recorded_at
         FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND event_id = ?
           AND event_kind = 'feedback_attributed'`,
      ).get(
        built.tenant_id,
        built.scope,
        built.source_feedback_event_id,
      ) as SqlRow | undefined;
      if (!source
        || source.episode_id !== built.source_episode_id
        || source.source_commit_id !== built.source_commit_id
        || source.recorded_at !== built.created_at) {
        throw new Error("learning control job source feedback binding mismatch");
      }
      const feedback = FeedbackAttributedV1Schema.parse(
        parseCanonicalJson(String(source.payload_json), "invalid_learning_control_feedback_payload"),
      );
      if (feedback.feedback_kind !== "memory"
        || feedback.learning_control_queue_contract !== "unused_exposure_learning_control_v1") {
        throw new Error("learning control job source lacks atomic queue provenance");
      }
      const payload = UnusedExposureLearningControlPayloadSchema.parse(JSON.parse(built.payload_json));
      if (stableStringify(canonicalStrings(feedback.unused_exposure_ids))
        !== stableStringify(payload.exposure_ids)) {
        throw new Error("learning control job exposure set does not match feedback");
      }
      const sourceExposure = db.prepare(
        `SELECT event_id FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND episode_id = ?
           AND event_kind = 'exposure_committed'`,
      ).get(built.tenant_id, built.scope, built.source_episode_id) as { event_id: string } | undefined;
      if (!sourceExposure
        || stableStringify(payload.exposure_ids) !== stableStringify([sourceExposure.event_id])) {
        throw new Error("learning control job must reference exactly its source episode exposure");
      }

      const existingRows = db.prepare(
        `SELECT * FROM lite_learning_control_jobs
         WHERE tenant_id = ? AND scope = ? AND (job_id = ? OR operation_id = ?)
         ORDER BY row_id`,
      ).all(built.tenant_id, built.scope, built.job_id, built.operation_id) as SqlRow[];
      if (existingRows.length > 0) {
        if (existingRows.length !== 1) throw new Error("learning control job identity alias conflict");
        const existing = parseJobRow(existingRows[0]!);
        if (stableStringify(immutableJobProjection(existing))
          !== stableStringify(immutableJobProjection(built))) {
          throw new Error("learning control job replay conflict");
        }
        if (existing.status === "dead_letter") {
          throw new Error("learning control job is already dead-lettered");
        }
        return {
          status: existing.status === "completed" ? "already_completed" : "queued",
          job: existing,
        };
      }

      db.prepare(
        `INSERT INTO lite_learning_control_jobs
          (tenant_id, scope, job_id, job_kind, operation_id, source_episode_id,
           source_feedback_event_id, source_commit_id, payload_sha256, payload_json,
           status, attempt_count, available_at, lease_owner, lease_expires_at,
           result_commit_id, last_error_code, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL,
                 NULL, NULL, ?, ?, NULL)`,
      ).run(
        built.tenant_id,
        built.scope,
        built.job_id,
        built.job_kind,
        built.operation_id,
        built.source_episode_id,
        built.source_feedback_event_id,
        built.source_commit_id,
        built.payload_sha256,
        built.payload_json,
        built.available_at,
        built.created_at,
        built.updated_at,
      );
      const inserted = db.prepare(
        "SELECT * FROM lite_learning_control_jobs WHERE tenant_id = ? AND scope = ? AND job_id = ?",
      ).get(built.tenant_id, built.scope, built.job_id) as SqlRow | undefined;
      if (!inserted) throw new Error("learning control job insert did not persist");
      return { status: "queued", job: parseJobRow(inserted) };
    },

    async claimLearningControlJobs(args) {
      const leaseOwner = requiredId(args.leaseOwner, "leaseOwner");
      const leaseMs = Math.max(1_000, Math.min(15 * 60_000, Math.trunc(args.leaseMs)));
      const limit = Math.max(1, Math.min(200, Math.trunc(args.limit)));
      const now = args.now ?? new Date();
      const nowValue = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      return await database.withTx(async () => {
        const candidates = db.prepare(
          `SELECT * FROM lite_learning_control_jobs
           WHERE (status = 'pending' AND available_at <= ? AND attempt_count < 8)
              OR (status = 'leased' AND lease_expires_at <= ?)
           ORDER BY available_at, row_id
           LIMIT ?`,
        ).all(nowValue, nowValue, limit) as SqlRow[];
        const claims: LiteLearningControlJobClaim[] = [];
        for (const raw of candidates) {
          const candidate = parseJobRow(raw);
          const exhausted = candidate.attempt_count >= 8;
          const nextAttempt = exhausted ? candidate.attempt_count : candidate.attempt_count + 1;
          const updated = db.prepare(
            `UPDATE lite_learning_control_jobs
             SET status = 'leased', attempt_count = ?, lease_owner = ?, lease_expires_at = ?,
                 updated_at = ?
             WHERE row_id = ? AND status = ? AND attempt_count = ?
               AND ((status = 'pending' AND available_at <= ?)
                 OR (status = 'leased' AND lease_expires_at <= ?))`,
          ).run(
            nextAttempt,
            leaseOwner,
            leaseExpiresAt,
            nowValue,
            candidate.row_id,
            candidate.status,
            candidate.attempt_count,
            nowValue,
            nowValue,
          );
          if (statementChanges(updated) !== 1) continue;
          const claimed = db.prepare(
            "SELECT * FROM lite_learning_control_jobs WHERE row_id = ?",
          ).get(candidate.row_id) as SqlRow | undefined;
          if (!claimed) throw new Error("claimed learning control job disappeared");
          claims.push({
            ...parseJobRow(claimed),
            status: "leased",
            lease_owner: leaseOwner,
            lease_expires_at: leaseExpiresAt,
            claim_mode: exhausted ? "terminalize_exhausted" : "execute",
          });
        }
        return claims;
      });
    },

    async loadUnusedExposureLearningControlFactsInTx(args) {
      assertInTransaction(transaction);
      const nowValue = args.now.toISOString();
      const current = currentClaimRow(db, args.claim, nowValue);
      if (!current) return null;
      const payload = jobPayload(current);
      const feedbackEvent = db.prepare(
        `SELECT * FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND event_id = ?
           AND event_kind = 'feedback_attributed'`,
      ).get(current.tenant_id, current.scope, current.source_feedback_event_id) as SqlRow | undefined;
      if (!feedbackEvent
        || feedbackEvent.episode_id !== current.source_episode_id
        || feedbackEvent.source_commit_id !== current.source_commit_id) {
        throw new LiteLearningControlJobValidationError("learning_control_feedback_source_mismatch");
      }
      const feedback = FeedbackAttributedV1Schema.safeParse(parseCanonicalJson(
        String(feedbackEvent.payload_json),
        "invalid_learning_control_feedback_payload",
      ));
      if (!feedback.success
        || feedback.data.feedback_kind !== "memory"
        || feedback.data.learning_control_queue_contract !== "unused_exposure_learning_control_v1"
        || stableStringify(canonicalStrings(feedback.data.unused_exposure_ids))
          !== stableStringify(payload.exposure_ids)) {
        throw new LiteLearningControlJobValidationError("learning_control_feedback_payload_mismatch");
      }
      const exposureRows = db.prepare(
        `SELECT * FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND event_kind = 'exposure_committed'
           AND event_id IN (${placeholders(payload.exposure_ids.length)})
         ORDER BY event_id`,
      ).all(current.tenant_id, current.scope, ...payload.exposure_ids) as SqlRow[];
      if (exposureRows.length !== payload.exposure_ids.length) {
        throw new LiteLearningControlJobValidationError("learning_control_exposure_missing");
      }
      if (exposureRows.some((row) => row.episode_id !== current.source_episode_id)) {
        throw new LiteLearningControlJobValidationError("learning_control_cross_episode_exposure");
      }
      const sourceExposure = exposureRows[0];
      if (!sourceExposure
        || typeof sourceExposure.source_id !== "string"
        || typeof sourceExposure.event_id !== "string") {
        throw new LiteLearningControlJobValidationError("learning_control_source_exposure_mismatch");
      }
      const receipt = db.prepare(
        `SELECT * FROM lite_product_guide_receipts
         WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
      ).get(current.tenant_id, current.scope, sourceExposure.source_id) as SqlRow | undefined;
      if (!receipt
        || typeof receipt.ledger_json !== "string"
        || typeof receipt.ledger_sha256 !== "string"
        || sha256Hex(receipt.ledger_json) !== receipt.ledger_sha256) {
        throw new LiteLearningControlJobValidationError("learning_control_guide_receipt_invalid");
      }
      const sourceItems = db.prepare(
        `SELECT memory_id FROM lite_learning_exposure_items
         WHERE tenant_id = ? AND scope = ? AND event_id IN (${placeholders(payload.exposure_ids.length)})
         ORDER BY memory_id`,
      ).all(current.tenant_id, current.scope, ...payload.exposure_ids) as Array<{ memory_id: string }>;
      const usedRows = db.prepare(
        `SELECT subject_id FROM lite_learning_feedback_attributions
         WHERE tenant_id = ? AND scope = ? AND event_id = ? AND subject_kind = 'memory'
         ORDER BY subject_id`,
      ).all(current.tenant_id, current.scope, current.source_feedback_event_id) as Array<{ subject_id: string }>;
      const used = new Set(usedRows.map((row) => row.subject_id));
      const unusedMemoryIds = canonicalStrings(sourceItems
        .map((row) => row.memory_id)
        .filter((memoryId) => !used.has(memoryId)));
      const stats: Array<LiteUnusedExposureLearningControlFacts["memory_stats"][number]> = [];
      for (const memoryId of unusedMemoryIds) {
        const exposureCount = db.prepare(
          `SELECT COUNT(*) AS count
           FROM lite_learning_exposure_items AS item
           JOIN lite_learning_episode_events AS exposure
             ON exposure.tenant_id = item.tenant_id AND exposure.scope = item.scope
            AND exposure.event_id = item.event_id AND exposure.event_kind = 'exposure_committed'
           JOIN lite_product_guide_receipts AS guide
             ON guide.tenant_id = exposure.tenant_id AND guide.scope = exposure.scope
            AND guide.guide_trace_id = exposure.source_id
           WHERE exposure.tenant_id = ? AND exposure.scope = ? AND exposure.row_id <= ?
             AND item.memory_id = ? AND guide.consumer_agent_id IS ?
             AND guide.consumer_team_id IS ?`,
        ).get(
          current.tenant_id,
          current.scope,
          Number(feedbackEvent.row_id),
          memoryId,
          receipt.consumer_agent_id ?? null,
          receipt.consumer_team_id ?? null,
        ) as { count: number };
        const positiveCount = db.prepare(
          `SELECT COUNT(*) AS count
           FROM lite_learning_feedback_attributions AS attribution
           JOIN lite_learning_episode_events AS feedback_event
             ON feedback_event.tenant_id = attribution.tenant_id
            AND feedback_event.scope = attribution.scope
            AND feedback_event.event_id = attribution.event_id
            AND feedback_event.event_kind = 'feedback_attributed'
           JOIN lite_learning_episode_events AS exposure
             ON exposure.tenant_id = feedback_event.tenant_id
            AND exposure.scope = feedback_event.scope
            AND exposure.episode_id = feedback_event.episode_id
            AND exposure.event_kind = 'exposure_committed'
           JOIN lite_product_guide_receipts AS guide
             ON guide.tenant_id = exposure.tenant_id AND guide.scope = exposure.scope
            AND guide.guide_trace_id = exposure.source_id
           WHERE feedback_event.tenant_id = ? AND feedback_event.scope = ?
             AND feedback_event.row_id <= ? AND attribution.subject_kind = 'memory'
             AND attribution.subject_id = ? AND attribution.outcome = 'positive'
             AND attribution.attribution_strength = 'positive_attribution'
             AND attribution.boundary_outcome = 'aligned'
             AND guide.consumer_agent_id IS ? AND guide.consumer_team_id IS ?`,
        ).get(
          current.tenant_id,
          current.scope,
          Number(feedbackEvent.row_id),
          memoryId,
          receipt.consumer_agent_id ?? null,
          receipt.consumer_team_id ?? null,
        ) as { count: number };
        const exposures = Number(exposureCount.count);
        const positives = Number(positiveCount.count);
        stats.push({
          memory_id: memoryId,
          repeated_without_positive_attribution: exposures >= 2 && positives === 0,
          exposure_count: exposures,
          positive_attributed_use_count: positives,
        });
      }
      return {
        job: current,
        payload,
        feedback: feedback.data,
        feedback_event_row_id: Number(feedbackEvent.row_id),
        feedback_event_sha256: String(feedbackEvent.event_sha256),
        feedback_recorded_at: String(feedbackEvent.recorded_at),
        source_guide_trace_id: String(sourceExposure.source_id),
        source_exposure_event_id: String(sourceExposure.event_id),
        source_exposure_event_sha256: String(sourceExposure.event_sha256),
        source_exposure_enrollment_state: String(sourceExposure.enrollment_state),
        source_consumer_agent_id: typeof receipt.consumer_agent_id === "string" ? receipt.consumer_agent_id : null,
        source_consumer_team_id: typeof receipt.consumer_team_id === "string" ? receipt.consumer_team_id : null,
        source_guide_ledger_sha256: receipt.ledger_sha256,
        source_guide_ledger_json: receipt.ledger_json,
        unused_memory_ids: unusedMemoryIds,
        memory_stats: stats,
      };
    },

    async loadLearningControlSafetySourceInTx(args) {
      assertInTransaction(transaction);
      const current = currentClaimRow(db, args.claim, args.now.toISOString());
      if (!current) return null;
      const feedbackEvent = db.prepare(
        `SELECT row_id, episode_id, source_commit_id
         FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND event_id = ?
           AND event_kind = 'feedback_attributed'`,
      ).get(current.tenant_id, current.scope, current.source_feedback_event_id) as SqlRow | undefined;
      const exposure = db.prepare(
        `SELECT source_id, enrollment_state
         FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND episode_id = ?
           AND event_kind = 'exposure_committed'`,
      ).get(current.tenant_id, current.scope, current.source_episode_id) as SqlRow | undefined;
      if (!feedbackEvent || !exposure
        || feedbackEvent.episode_id !== current.source_episode_id
        || feedbackEvent.source_commit_id !== current.source_commit_id
        || typeof exposure.source_id !== "string") {
        throw new LiteLearningControlJobValidationError("learning_control_safety_source_mismatch");
      }
      return {
        job: current,
        feedback_event_row_id: Number(feedbackEvent.row_id),
        source_guide_trace_id: exposure.source_id,
        source_exposure_enrollment_state: String(exposure.enrollment_state),
      };
    },

    async completeLearningControlJobInTx(args) {
      assertInTransaction(transaction);
      const completedAt = CanonicalTimestamp.parse(args.completedAt);
      const resultCommitId = requiredId(args.resultCommitId, "resultCommitId");
      const updated = db.prepare(
        `UPDATE lite_learning_control_jobs
         SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
             result_commit_id = ?, last_error_code = NULL, updated_at = ?, completed_at = ?
         WHERE row_id = ? AND tenant_id = ? AND scope = ? AND job_id = ?
           AND attempt_count = ? AND status = 'leased' AND lease_owner = ?
           AND lease_expires_at = ? AND lease_expires_at > ?`,
      ).run(resultCommitId, completedAt, completedAt, ...claimTuple(args.claim), completedAt);
      return statementChanges(updated) === 1;
    },

    async retryLearningControlJob(args) {
      const errorCode = sanitizeLearningControlErrorCode(args.errorCode);
      const now = args.now ?? new Date();
      const nowValue = now.toISOString();
      const retryAt = args.retryAt.toISOString();
      if (retryAt < nowValue) throw new Error("learning control retry cannot be scheduled in the past");
      return await database.withTx(async () => {
        const current = currentClaimRow(db, args.claim, nowValue);
        if (!current) return "stale_claim" as const;
        if (current.attempt_count >= 8) return "exhausted" as const;
        const updated = db.prepare(
          `UPDATE lite_learning_control_jobs
           SET status = 'pending', available_at = ?, lease_owner = NULL,
               lease_expires_at = NULL, last_error_code = ?, updated_at = ?
           WHERE row_id = ? AND tenant_id = ? AND scope = ? AND job_id = ?
             AND attempt_count = ? AND status = 'leased' AND lease_owner = ?
             AND lease_expires_at = ? AND lease_expires_at > ?`,
        ).run(retryAt, errorCode, nowValue, ...claimTuple(args.claim), nowValue);
        return statementChanges(updated) === 1 ? "retried" as const : "stale_claim" as const;
      });
    },

    async deferLearningControlJobTerminalization(args) {
      const errorCode = sanitizeLearningControlErrorCode(args.errorCode);
      const now = args.now ?? new Date();
      const nowValue = now.toISOString();
      const retryAt = args.retryAt.toISOString();
      if (retryAt <= nowValue) {
        throw new Error("learning control terminalization retry must be scheduled in the future");
      }
      return await database.withTx(async () => {
        const current = currentClaimRow(db, args.claim, nowValue);
        if (!current) return "stale_claim" as const;
        if (current.attempt_count < 8) {
          throw new Error("learning control terminalization defer requires an exhausted claim");
        }
        const updated = db.prepare(
          `UPDATE lite_learning_control_jobs
           SET lease_expires_at = ?, last_error_code = ?, updated_at = ?
           WHERE row_id = ? AND tenant_id = ? AND scope = ? AND job_id = ?
             AND attempt_count = ? AND status = 'leased' AND lease_owner = ?
             AND lease_expires_at = ? AND lease_expires_at > ?`,
        ).run(retryAt, errorCode, nowValue, ...claimTuple(args.claim), nowValue);
        return statementChanges(updated) === 1 ? "deferred" as const : "stale_claim" as const;
      });
    },

    async deadLetterLearningControlJobInTx(args) {
      assertInTransaction(transaction);
      const completedAt = CanonicalTimestamp.parse(args.completedAt);
      const errorCode = sanitizeLearningControlErrorCode(args.errorCode);
      const updated = db.prepare(
        `UPDATE lite_learning_control_jobs
         SET status = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
             result_commit_id = NULL, last_error_code = ?, updated_at = ?, completed_at = ?
         WHERE row_id = ? AND tenant_id = ? AND scope = ? AND job_id = ?
           AND attempt_count = ? AND status = 'leased' AND lease_owner = ?
           AND lease_expires_at = ? AND lease_expires_at > ?`,
      ).run(errorCode, completedAt, completedAt, ...claimTuple(args.claim), completedAt);
      return statementChanges(updated) === 1;
    },

    async listLearningControlJobs(args = {}) {
      return await transaction.read(() => {
        const statuses = [...new Set(args.statuses ?? [])];
        const where = statuses.length > 0
          ? `WHERE status IN (${placeholders(statuses.length)})`
          : "";
        const limit = Math.max(1, Math.min(1000, Math.trunc(args.limit ?? 100)));
        return (db.prepare(
          `SELECT * FROM lite_learning_control_jobs ${where} ORDER BY row_id LIMIT ?`,
        ).all(...statuses, limit) as SqlRow[]).map(parseJobRow);
      });
    },

    async learningControlBacklogSnapshot(now = new Date()) {
      return await transaction.read(() => {
        const row = db.prepare(
          `SELECT
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased,
             SUM(CASE WHEN status = 'leased' AND lease_expires_at <= ? THEN 1 ELSE 0 END) AS expired_leases,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter,
             SUM(CASE WHEN status = 'leased' AND attempt_count >= 8 THEN 1 ELSE 0 END) AS exhausted,
             MIN(CASE WHEN status = 'pending' THEN available_at END) AS oldest_available_at,
             MIN(CASE WHEN status = 'leased' THEN lease_expires_at END) AS oldest_lease_expiry
           FROM lite_learning_control_jobs`,
        ).get(now.toISOString()) as SqlRow;
        return {
          pending: Number(row.pending ?? 0),
          leased: Number(row.leased ?? 0),
          expired_leases: Number(row.expired_leases ?? 0),
          completed: Number(row.completed ?? 0),
          dead_letter: Number(row.dead_letter ?? 0),
          exhausted: Number(row.exhausted ?? 0),
          oldest_available_at: typeof row.oldest_available_at === "string" ? row.oldest_available_at : null,
          oldest_lease_expiry: typeof row.oldest_lease_expiry === "string" ? row.oldest_lease_expiry : null,
        };
      });
    },
  };
}
