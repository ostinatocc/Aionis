import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  FeedbackAttributedV1Schema,
  type FeedbackAttributedV1,
} from "../memory/learning-episode-ledger.js";
import {
  canonicalLearningControlMemoryIds,
  LEARNING_CONTROL_OPERATION_KIND,
  LEARNING_CONTROL_OPERATION_OUTCOME_AUTHORITY_KIND,
  LEARNING_CONTROL_OPERATION_OUTCOME_EVIDENCE_CONTRACT,
  LEARNING_CONTROL_OPERATION_OUTCOME_EVIDENCE_FIELDS,
  type LearningControlOperationOutcomeEvidenceV2,
} from "../memory/learning-episode-ledger.js";
import { resolveNodeLifecycleSignals } from "../memory/lifecycle-signals.js";
import {
  nodeAuthorityStateAfterPatchV2,
  type NodeAuthorityStateV2,
} from "../memory/node-embedding-freshness.js";
import { mergeNodeFeedbackLearningControlSlots } from "../memory/node-feedback-state.js";
import { sha256Hex } from "../util/crypto.js";
import type { LiteRuntimeDatabase } from "./lite-runtime-database.js";
import { assertLiteMemoryCommitRootAuthority } from "./lite-memory-commit-integrity.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";
import {
  assertCanonicalV2MutationJson,
  type CanonicalAppliedAuthorityMutationV2,
  type CanonicalAuthorityTableMutationV2,
} from "./write-commit-authority.js";

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

const LEARNING_CONTROL_NODE_REQUEST_FIELDS = [
  "tier", "slots_json", "text_summary", "salience", "importance", "confidence",
  "update_tier", "side_effects", "operation_context",
] as const;

const LEARNING_CONTROL_NODE_SIDE_EFFECTS = [
  "refresh_execution_native_index",
  "refresh_keyword_index",
  "refresh_embedding_projection",
  "enqueue_ann_projection_when_enabled",
] as const;

const LEARNING_CONTROL_NODE_ROW_FIELDS = [
  "id", "scope", "client_id", "type", "tier", "title", "text_summary",
  "slots_json", "raw_ref", "evidence_ref", "embedding_vector_json",
  "embedding_model", "memory_lane", "producer_agent_id", "owner_agent_id",
  "owner_team_id", "embedding_status", "embedding_last_error", "salience",
  "importance", "confidence", "redaction_version", "commit_id", "created_at",
] as const;

type RootedLearningControlNodeMutation = Readonly<{
  memoryId: string;
  before: NodeAuthorityStateV2;
  after: NodeAuthorityStateV2;
}>;

type LearningControlMemoryStat = Readonly<{
  exposureCount: number;
  positiveAttributedUseCount: number;
}>;

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function learningControlNodeAuthorityState(
  value: unknown,
  code: string,
): NodeAuthorityStateV2 {
  const row = exactObject(value, LEARNING_CONTROL_NODE_ROW_FIELDS, code);
  if (typeof row.id !== "string" || row.id.length === 0
    || typeof row.scope !== "string" || row.scope.length === 0
    || !nullableString(row.client_id)
    || typeof row.type !== "string" || row.type.length === 0
    || typeof row.tier !== "string" || row.tier.length === 0
    || !nullableString(row.title)
    || !nullableString(row.text_summary)
    || !row.slots_json || typeof row.slots_json !== "object" || Array.isArray(row.slots_json)
    || !nullableString(row.raw_ref)
    || !nullableString(row.evidence_ref)
    || !nullableString(row.embedding_model)
    || (row.memory_lane !== "private" && row.memory_lane !== "shared")
    || !nullableString(row.producer_agent_id)
    || !nullableString(row.owner_agent_id)
    || !nullableString(row.owner_team_id)
    || (row.embedding_status !== "pending"
      && row.embedding_status !== "ready"
      && row.embedding_status !== "failed")
    || !nullableString(row.embedding_last_error)
    || typeof row.salience !== "number" || !Number.isFinite(row.salience)
    || typeof row.importance !== "number" || !Number.isFinite(row.importance)
    || typeof row.confidence !== "number" || !Number.isFinite(row.confidence)
    || !Number.isSafeInteger(row.redaction_version) || Number(row.redaction_version) < 0
    || typeof row.commit_id !== "string" || row.commit_id.length === 0
    || typeof row.created_at !== "string" || row.created_at.length === 0) {
    throw new Error(`lite_learning_integrity_failed:${code}`);
  }
  return row as NodeAuthorityStateV2;
}

function learningControlV2OperationContext(args: {
  mutation: CanonicalAppliedAuthorityMutationV2;
  scope: string;
}): {
  operationContext: SqlRow;
  nodes: RootedLearningControlNodeMutation[];
} {
  if (args.mutation.authority_kind !== "feedback_learning_control_inspect_before_use"
    || args.mutation.contract !== "aionis_applied_authority_mutation_v2"
    || args.mutation.digest_version !== 2
    || args.mutation.mutations.length === 0) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_diff");
  }
  const rootedMemoryIds: string[] = [];
  const rootedNodes: RootedLearningControlNodeMutation[] = [];
  let sharedOperationContext: SqlRow | null = null;
  for (const [index, entry] of args.mutation.mutations.entries()) {
    const mutation = entry as CanonicalAuthorityTableMutationV2;
    if (mutation.table !== "lite_memory_nodes" || mutation.operation !== "update") {
      throw new Error("lite_learning_integrity_failed:learning_control_result_commit_node_mutation_table");
    }
    const identity = exactObject(
      mutation.identity,
      ["scope", "id"],
      `learning_control_result_commit_node_identity_${index}`,
    );
    const before = learningControlNodeAuthorityState(
      mutation.before,
      `learning_control_result_commit_node_before_${index}`,
    );
    const after = learningControlNodeAuthorityState(
      mutation.after,
      `learning_control_result_commit_node_after_${index}`,
    );
    const requested = exactObject(
      mutation.requested,
      LEARNING_CONTROL_NODE_REQUEST_FIELDS,
      `learning_control_result_commit_node_requested_${index}`,
    );
    const memoryId = identity.id;
    if (typeof memoryId !== "string" || memoryId.length === 0
      || identity.scope !== args.scope
      || before.id !== memoryId || before.scope !== args.scope
      || after.id !== memoryId || after.scope !== args.scope
      || typeof before.commit_id !== "string" || before.commit_id.length === 0
      || before.commit_id === "$self" || after.commit_id !== "$self"
      || requested.update_tier !== false
      || stableStringify(requested.side_effects)
        !== stableStringify(LEARNING_CONTROL_NODE_SIDE_EFFECTS)
      || !sameCanonicalValue(requested.tier, after.tier)
      || !sameCanonicalValue(requested.slots_json, after.slots_json)
      || !sameCanonicalValue(requested.text_summary, after.text_summary)
      || !sameCanonicalValue(requested.salience, after.salience)
      || !sameCanonicalValue(requested.importance, after.importance)
      || !sameCanonicalValue(requested.confidence, after.confidence)) {
      throw new Error("lite_learning_integrity_failed:learning_control_result_commit_node_mutation");
    }
    const operationContext = exactObject(
      requested.operation_context,
      LEARNING_CONTROL_COMMIT_DIFF_FIELDS,
      `learning_control_result_commit_operation_context_${index}`,
    );
    if (sharedOperationContext === null) {
      sharedOperationContext = operationContext;
    } else if (!sameCanonicalValue(sharedOperationContext, operationContext)) {
      throw new Error("lite_learning_integrity_failed:learning_control_result_commit_operation_context_mismatch");
    }
    rootedMemoryIds.push(memoryId);
    rootedNodes.push({ memoryId, before, after });
  }
  if (sharedOperationContext === null) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_operation_context_missing");
  }
  const appliedMemoryIds = canonicalStrings(exactStringArray(
    sharedOperationContext.applied_node_ids,
    "learning_control_applied_node_ids",
  ));
  if (new Set(rootedMemoryIds).size !== rootedMemoryIds.length
    || stableStringify(canonicalStrings(rootedMemoryIds)) !== stableStringify(appliedMemoryIds)) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_node_subjects");
  }
  return { operationContext: sharedOperationContext, nodes: rootedNodes };
}

function assertLearningControlNodeAfterStates(args: {
  nodes: readonly RootedLearningControlNodeMutation[];
  operationContext: SqlRow;
  inputSha256: string;
  statByMemoryId: ReadonlyMap<string, LearningControlMemoryStat>;
}): void {
  if (!/^[a-f0-9]{64}$/u.test(args.inputSha256)) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_input_sha256");
  }
  const startedAt = typeof args.operationContext.started_at === "string"
    ? args.operationContext.started_at
    : null;
  const reason = typeof args.operationContext.reason === "string"
    ? args.operationContext.reason
    : null;
  const runId = args.operationContext.run_id === null
    ? null
    : typeof args.operationContext.run_id === "string"
      ? args.operationContext.run_id
      : undefined;
  const guideTraceId = args.operationContext.guide_trace_id === null
    ? null
    : typeof args.operationContext.guide_trace_id === "string"
      ? args.operationContext.guide_trace_id
      : undefined;
  if (startedAt === null || reason === null || runId === undefined || guideTraceId === undefined) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_node_state_inputs");
  }
  for (const node of args.nodes) {
    const stat = args.statByMemoryId.get(node.memoryId);
    if (!stat) {
      throw new Error("lite_learning_integrity_failed:learning_control_result_commit_node_state_evidence");
    }
    const nextSlots = mergeNodeFeedbackLearningControlSlots({
      slots: node.before.slots_json as Record<string, unknown>,
      posture: "inspect_before_use",
      source: "repeated_unused_without_positive_attribution",
      timestamp: startedAt,
      run_id: runId,
      guide_trace_id: guideTraceId,
      reason,
      input_sha256: args.inputSha256,
      exposure_count: stat.exposureCount,
      positive_attributed_use_count: stat.positiveAttributedUseCount,
    });
    const lifecycle = resolveNodeLifecycleSignals({
      type: node.before.type,
      tier: node.before.tier,
      title: node.before.title,
      text_summary: node.before.text_summary,
      slots: nextSlots,
      salience: node.before.salience,
      importance: node.before.importance,
      confidence: node.before.confidence,
      raw_ref: node.before.raw_ref,
      evidence_ref: node.before.evidence_ref,
      reference_time: startedAt,
    });
    const expectedAfter = nodeAuthorityStateAfterPatchV2({
      before: node.before,
      patch: {
        id: node.memoryId,
        slots: lifecycle.slots,
        textSummary: node.before.text_summary,
        salience: lifecycle.salience,
        importance: lifecycle.importance,
        confidence: lifecycle.confidence,
      },
    });
    if (!sameCanonicalValue(node.after, expectedAfter)) {
      throw new Error("lite_learning_integrity_failed:learning_control_result_commit_node_state");
    }
  }
}

type LearningControlCommitRow = Readonly<{
  id: string;
  scope: string;
  parent_commit_id: string | null;
  input_sha256: string;
  diff_json: string;
  actor: string;
  model_version: string | null;
  prompt_version: string | null;
  commit_hash: string;
  created_at: string;
  digest_version: number;
  revision: number | null;
  mutation_digest: string | null;
  legacy_anchor_commit_id: string | null;
}>;

function learningControlCommitRow(value: SqlRow | undefined): LearningControlCommitRow {
  if (!value
    || typeof value.id !== "string" || value.id.length === 0
    || typeof value.scope !== "string" || value.scope.length === 0
    || !nullableString(value.parent_commit_id)
    || typeof value.input_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.input_sha256)
    || typeof value.diff_json !== "string"
    || typeof value.actor !== "string" || value.actor.length === 0
    || !nullableString(value.model_version)
    || !nullableString(value.prompt_version)
    || typeof value.commit_hash !== "string" || !/^[a-f0-9]{64}$/u.test(value.commit_hash)
    || typeof value.created_at !== "string"
    || !Number.isSafeInteger(value.digest_version)
    || !(value.revision === null || Number.isSafeInteger(value.revision))
    || !nullableString(value.mutation_digest)
    || !nullableString(value.legacy_anchor_commit_id)) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit");
  }
  return value as LearningControlCommitRow;
}

function assertLearningControlCommitV2Authority(
  db: SqliteDatabase,
  commit: LearningControlCommitRow,
  expectedInputSha256?: string,
): void {
  if (commit.digest_version !== 2) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_digest_version");
  }
  try {
    assertLiteMemoryCommitRootAuthority({
      db,
      scope: commit.scope,
      commitId: commit.id,
      ...(expectedInputSha256 ? { expectedInputSha256 } : {}),
    });
  } catch (error) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_authority", {
      cause: error,
    });
  }
}

function learningControlPositiveSlotCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function learningControlNodeVisible(args: {
  node: NodeAuthorityStateV2;
  consumerAgentId: string | null;
  consumerTeamId: string | null;
}): boolean {
  const { node, consumerAgentId, consumerTeamId } = args;
  return (node.memory_lane === "shared" && node.owner_team_id === null)
    || (consumerAgentId !== null && node.owner_agent_id === consumerAgentId)
    || (consumerTeamId !== null && node.owner_team_id === consumerTeamId);
}

function exactLearningControlOutcomeEvidence(
  value: unknown,
): LearningControlOperationOutcomeEvidenceV2 {
  const evidence = exactObject(
    value,
    LEARNING_CONTROL_OPERATION_OUTCOME_EVIDENCE_FIELDS,
    "learning_control_outcome_evidence",
  );
  const requested = exactStringArray(
    evidence.requested_node_ids,
    "learning_control_outcome_requested_node_ids",
  );
  const applied = exactStringArray(
    evidence.applied_node_ids,
    "learning_control_outcome_applied_node_ids",
  );
  const skipped = exactStringArray(
    evidence.skipped_positive_attribution_memory_ids,
    "learning_control_outcome_skipped_node_ids",
  );
  const missing = exactStringArray(
    evidence.missing_node_ids,
    "learning_control_outcome_missing_node_ids",
  );
  const partition = canonicalLearningControlMemoryIds([...applied, ...skipped, ...missing]);
  if (evidence.contract_version !== LEARNING_CONTROL_OPERATION_OUTCOME_EVIDENCE_CONTRACT
    || typeof evidence.tenant_id !== "string" || evidence.tenant_id.length === 0
    || typeof evidence.scope !== "string" || evidence.scope.length === 0
    || typeof evidence.job_id !== "string" || evidence.job_id.length === 0
    || typeof evidence.operation_id !== "string" || evidence.operation_id.length === 0
    || typeof evidence.source_episode_id !== "string" || evidence.source_episode_id.length === 0
    || typeof evidence.source_feedback_event_id !== "string"
      || evidence.source_feedback_event_id.length === 0
    || typeof evidence.source_commit_id !== "string" || evidence.source_commit_id.length === 0
    || typeof evidence.payload_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(evidence.payload_sha256)
    || typeof evidence.domain_result_commit_id !== "string"
      || evidence.domain_result_commit_id.length === 0
    || !Number.isSafeInteger(evidence.domain_result_revision)
      || Number(evidence.domain_result_revision) < 0
    || typeof evidence.request_sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(evidence.request_sha256)
    || typeof evidence.actor !== "string" || evidence.actor.length === 0
    || !nullableString(evidence.consumer_agent_id)
    || !nullableString(evidence.consumer_team_id)
    || stableStringify(requested) !== stableStringify(canonicalLearningControlMemoryIds(requested))
    || stableStringify(applied) !== stableStringify(canonicalLearningControlMemoryIds(applied))
    || stableStringify(skipped) !== stableStringify(canonicalLearningControlMemoryIds(skipped))
    || stableStringify(missing) !== stableStringify(canonicalLearningControlMemoryIds(missing))
    || applied.length + skipped.length + missing.length !== requested.length
    || stableStringify(partition) !== stableStringify(requested)
    || !Array.isArray(evidence.observations)
    || evidence.observations.length !== requested.length) {
    throw new Error("lite_learning_integrity_failed:learning_control_outcome_evidence_binding");
  }
  const observations = evidence.observations.map((value, index) => {
    const observation = exactObject(
      value,
      ["memory_id", "state"],
      `learning_control_outcome_observation_${index}`,
    );
    if (observation.memory_id !== requested[index]) {
      throw new Error("lite_learning_integrity_failed:learning_control_outcome_observation_order");
    }
    return {
      memory_id: observation.memory_id,
      state: observation.state === null
        ? null
        : learningControlNodeAuthorityState(
          observation.state,
          `learning_control_outcome_observation_state_${index}`,
        ),
    };
  });
  return { ...evidence, observations } as unknown as LearningControlOperationOutcomeEvidenceV2;
}

function learningControlExpectedDispositionFromObservations(args: {
  evidence: LearningControlOperationOutcomeEvidenceV2;
  statByMemoryId: ReadonlyMap<string, LearningControlMemoryStat>;
}): {
  applied: string[];
  skipped: string[];
  missing: string[];
} {
  const applied: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  for (const observation of args.evidence.observations) {
    const memoryId = observation.memory_id;
    const node = observation.state;
    if (!node || !learningControlNodeVisible({
      node,
      consumerAgentId: args.evidence.consumer_agent_id ?? args.evidence.actor,
      consumerTeamId: args.evidence.consumer_team_id,
    })) {
      missing.push(memoryId);
      continue;
    }
    const slots = node.slots_json as Record<string, unknown>;
    const stat = args.statByMemoryId.get(memoryId);
    if (learningControlPositiveSlotCount(slots.positive_attributed_use_count) > 0
      || learningControlPositiveSlotCount(slots.feedback_positive) > 0
      || Number(stat?.positiveAttributedUseCount ?? 0) > 0) {
      skipped.push(memoryId);
    } else {
      applied.push(memoryId);
    }
  }
  return { applied, skipped, missing };
}

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
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at
     FROM lite_runtime_write_operations
     WHERE tenant_id = ? AND scope = ?
       AND operation_kind = ?
       AND operation_id = ?`,
  ).get(
    job.tenant_id,
    job.scope,
    LEARNING_CONTROL_OPERATION_KIND,
    job.operation_id,
  ) as SqlRow | undefined;
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
    operation_kind: LEARNING_CONTROL_OPERATION_KIND,
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
  const commit = learningControlCommitRow(db.prepare(
    `SELECT id, scope, parent_commit_id, input_sha256, diff_json, actor,
            model_version, prompt_version, commit_hash, created_at,
            digest_version, revision, mutation_digest, legacy_anchor_commit_id
     FROM lite_memory_commits WHERE id = ?`,
  ).get(job.result_commit_id) as SqlRow | undefined);
  if (operation.commit_id !== job.result_commit_id
    || commit.scope !== job.scope
    || commit.digest_version !== 2
    || !Number.isSafeInteger(commit.revision)
    || Number(commit.revision) < 1
    || commit.input_sha256 !== requestSha256
    || commit.model_version !== null
    || commit.prompt_version !== null
    || operation.created_at !== commit.created_at
    || job.completed_at !== commit.created_at) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit");
  }
  assertLearningControlCommitV2Authority(db, commit, requestSha256);
  let outcomeMutation: CanonicalAppliedAuthorityMutationV2;
  try {
    outcomeMutation = assertCanonicalV2MutationJson({
      diffJson: commit.diff_json,
      mutationDigest: String(commit.mutation_digest),
      createdAt: commit.created_at,
      scope: commit.scope,
    }) as CanonicalAppliedAuthorityMutationV2;
  } catch (error) {
    throw new Error("lite_learning_integrity_failed:learning_control_outcome_commit_diff", {
      cause: error,
    });
  }
  if (outcomeMutation.authority_kind !== LEARNING_CONTROL_OPERATION_OUTCOME_AUTHORITY_KIND
    || outcomeMutation.mutations.length !== 1) {
    throw new Error("lite_learning_integrity_failed:learning_control_outcome_commit_kind");
  }
  const outcomeEntry = exactObject(
    outcomeMutation.mutations[0],
    ["table", "identity", "operation", "before", "requested", "after"],
    "learning_control_outcome_mutation",
  );
  const outcomeIdentity = exactObject(
    outcomeEntry.identity,
    ["tenant_id", "scope", "operation_kind", "operation_id"],
    "learning_control_outcome_identity",
  );
  const outcomeAfter = exactObject(
    outcomeEntry.after,
    [
      "tenant_id", "scope", "operation_kind", "operation_id", "request_sha256",
      "receipt_json", "commit_id", "created_at",
    ],
    "learning_control_outcome_after",
  );
  const evidence = exactLearningControlOutcomeEvidence(outcomeEntry.requested);
  const canonicalAfter = {
    tenant_id: operation.tenant_id,
    scope: operation.scope,
    operation_kind: operation.operation_kind,
    operation_id: operation.operation_id,
    request_sha256: operation.request_sha256,
    receipt_json: { ...receipt, result_commit_id: "$self" },
    commit_id: operation.commit_id === commit.id ? "$self" : operation.commit_id,
    created_at: operation.created_at,
  };
  const expectedOutcomeIdentity = {
      tenant_id: job.tenant_id,
      scope: job.scope,
      operation_kind: LEARNING_CONTROL_OPERATION_KIND,
      operation_id: job.operation_id,
  };
  const outcomeAfterMismatches = Object.keys(canonicalAfter).filter(
    (field) => stableStringify(outcomeAfter[field]) !== stableStringify(
      canonicalAfter[field as keyof typeof canonicalAfter],
    ),
  );
  const outcomeBindingMismatches = [
    outcomeEntry.table === "lite_runtime_write_operations" ? null : "table",
    outcomeEntry.operation === "insert" ? null : "operation",
    outcomeEntry.before === null ? null : "before",
    stableStringify(outcomeIdentity) === stableStringify(expectedOutcomeIdentity) ? null : "identity",
    outcomeAfterMismatches.length === 0
      ? null : `after.${outcomeAfterMismatches.join("+")}`,
    evidence.tenant_id === job.tenant_id ? null : "tenant_id",
    evidence.scope === job.scope ? null : "scope",
    evidence.job_id === job.job_id ? null : "job_id",
    evidence.operation_id === job.operation_id ? null : "operation_id",
    evidence.source_episode_id === job.source_episode_id ? null : "source_episode_id",
    evidence.source_feedback_event_id === job.source_feedback_event_id
      ? null : "source_feedback_event_id",
    evidence.source_commit_id === job.source_commit_id ? null : "source_commit_id",
    evidence.payload_sha256 === job.payload_sha256 ? null : "payload_sha256",
    evidence.request_sha256 === requestSha256 ? null : "request_sha256",
    evidence.actor === commit.actor ? null : "actor",
    evidence.domain_result_commit_id === commit.parent_commit_id
      ? null : "domain_result_commit_id",
    evidence.domain_result_revision === Number(commit.revision) - 1
      ? null : "domain_result_revision",
  ].filter((field): field is string => field !== null);
  if (outcomeBindingMismatches.length > 0) {
    throw new Error(
      `lite_learning_integrity_failed:learning_control_outcome_commit_binding:${outcomeBindingMismatches.join(",")}`,
    );
  }
  const parent = learningControlCommitRow(db.prepare(
    `SELECT id, scope, parent_commit_id, input_sha256, diff_json, actor,
            model_version, prompt_version, commit_hash, created_at,
            digest_version, revision, mutation_digest, legacy_anchor_commit_id
     FROM lite_memory_commits WHERE id = ? AND scope = ?`,
  ).get(commit.parent_commit_id, commit.scope) as SqlRow | undefined);
  const parentTime = new Date(parent.created_at).getTime();
  const outcomeTime = new Date(commit.created_at).getTime();
  if (parent.id !== evidence.domain_result_commit_id
    || parent.scope !== commit.scope
    || (parent.digest_version === 2
      && parent.revision !== evidence.domain_result_revision)
    || (parent.digest_version === 1 && evidence.domain_result_revision !== 0)
    || !Number.isFinite(parentTime)
    || !Number.isFinite(outcomeTime)
    || parentTime > outcomeTime) {
    throw new Error("lite_learning_integrity_failed:learning_control_outcome_parent_fence");
  }
  const sourceCommit = learningControlCommitRow(db.prepare(
    `SELECT id, scope, parent_commit_id, input_sha256, diff_json, actor,
            model_version, prompt_version, commit_hash, created_at,
            digest_version, revision, mutation_digest, legacy_anchor_commit_id
     FROM lite_memory_commits WHERE id = ? AND scope = ?`,
  ).get(job.source_commit_id, job.scope) as SqlRow | undefined);
  const sourceTime = new Date(sourceCommit.created_at).getTime();
  if (!Number.isFinite(sourceTime)
    || sourceTime > parentTime
    || (sourceCommit.digest_version === 2 && (
      !Number.isSafeInteger(sourceCommit.revision)
      || Number(sourceCommit.revision) > evidence.domain_result_revision
    ))) {
    throw new Error("lite_learning_integrity_failed:learning_control_outcome_source_commit_order");
  }
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
  const consumerAgentId = typeof guideReceipt.consumer_agent_id === "string"
    ? guideReceipt.consumer_agent_id
    : null;
  const consumerTeamId = typeof guideReceipt.consumer_team_id === "string"
    ? guideReceipt.consumer_team_id
    : null;
  if (evidence.consumer_agent_id !== consumerAgentId
    || evidence.consumer_team_id !== consumerTeamId
    || (consumerAgentId !== null && evidence.actor !== consumerAgentId)) {
    throw new Error("lite_learning_integrity_failed:learning_control_outcome_consumer_binding");
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
  const statByMemoryId = new Map<string, LearningControlMemoryStat>();
  const exposureCounts = new Map((db.prepare(
    `SELECT item.memory_id, COUNT(*) AS count
     FROM lite_learning_exposure_items AS item
     JOIN lite_learning_episode_events AS exposure
       ON exposure.tenant_id = item.tenant_id AND exposure.scope = item.scope
      AND exposure.event_id = item.event_id AND exposure.event_kind = 'exposure_committed'
     JOIN lite_product_guide_receipts AS guide
       ON guide.tenant_id = exposure.tenant_id AND guide.scope = exposure.scope
      AND guide.guide_trace_id = exposure.source_id
     WHERE exposure.tenant_id = ? AND exposure.scope = ? AND exposure.row_id <= ?
       AND guide.consumer_agent_id IS ? AND guide.consumer_team_id IS ?
     GROUP BY item.memory_id`,
  ).all(
    job.tenant_id,
    job.scope,
    Number(feedbackEvent.row_id),
    guideReceipt.consumer_agent_id ?? null,
    guideReceipt.consumer_team_id ?? null,
  ) as Array<{ memory_id: string; count: number }>).map(
    (row) => [row.memory_id.toLowerCase(), Number(row.count)] as const,
  ));
  const positiveCounts = new Map((db.prepare(
    `SELECT attribution.subject_id AS memory_id, COUNT(*) AS count
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
       AND attribution.outcome = 'positive'
       AND attribution.attribution_strength = 'positive_attribution'
       AND attribution.boundary_outcome = 'aligned'
       AND guide.consumer_agent_id IS ? AND guide.consumer_team_id IS ?
     GROUP BY attribution.subject_id`,
  ).all(
    job.tenant_id,
    job.scope,
    Number(feedbackEvent.row_id),
    guideReceipt.consumer_agent_id ?? null,
    guideReceipt.consumer_team_id ?? null,
  ) as Array<{ memory_id: string; count: number }>).map(
    (row) => [row.memory_id.toLowerCase(), Number(row.count)] as const,
  ));
  for (const memoryId of canonicalStrings(sourceItems
    .map((row) => row.memory_id)
    .filter((memoryId) => !used.has(memoryId)))) {
    const normalizedMemoryId = memoryId.toLowerCase();
    const stat = {
      exposureCount: exposureCounts.get(normalizedMemoryId) ?? 0,
      positiveAttributedUseCount: positiveCounts.get(normalizedMemoryId) ?? 0,
    };
    statByMemoryId.set(normalizedMemoryId, stat);
    if (stat.exposureCount >= 2 && stat.positiveAttributedUseCount === 0) {
      expectedRequested.push(normalizedMemoryId);
    }
  }
  const changedReceipt = receipt.changed_memory_ids as string[];
  const skippedReceipt = receipt.skipped_positive_attribution_memory_ids as string[];
  const missingReceipt = receipt.missing_node_ids as string[];
  const expectedDisposition = learningControlExpectedDispositionFromObservations({
    evidence,
    statByMemoryId,
  });
  const receiptPartition = canonicalStrings([
    ...changedReceipt,
    ...skippedReceipt,
    ...missingReceipt,
  ]);
  if (changedReceipt.length + skippedReceipt.length + missingReceipt.length
      !== expectedRequested.length
    || stableStringify(receiptPartition) !== stableStringify(expectedRequested)
    || stableStringify(evidence.requested_node_ids) !== stableStringify(expectedRequested)
    || stableStringify(evidence.applied_node_ids) !== stableStringify(changedReceipt)
    || stableStringify(evidence.skipped_positive_attribution_memory_ids)
      !== stableStringify(skippedReceipt)
    || stableStringify(evidence.missing_node_ids) !== stableStringify(missingReceipt)
    || stableStringify(changedReceipt) !== stableStringify(expectedDisposition.applied)
    || stableStringify(skippedReceipt) !== stableStringify(expectedDisposition.skipped)
    || stableStringify(missingReceipt) !== stableStringify(expectedDisposition.missing)) {
    throw new Error("lite_learning_integrity_failed:learning_control_result_commit_binding");
  }
  if (changedReceipt.length === 0) {
    if (parent.digest_version === 2) assertLearningControlCommitV2Authority(db, parent);
    return;
  }
  if (parent.digest_version !== 2
    || parent.input_sha256 !== requestSha256
    || parent.actor !== evidence.actor
    || parent.model_version !== null
    || parent.prompt_version !== null) {
    throw new Error("lite_learning_integrity_failed:learning_control_domain_commit");
  }
  assertLearningControlCommitV2Authority(db, parent, requestSha256);
  let domainMutation: CanonicalAppliedAuthorityMutationV2;
  try {
    domainMutation = assertCanonicalV2MutationJson({
      diffJson: parent.diff_json,
      mutationDigest: String(parent.mutation_digest),
      createdAt: parent.created_at,
      scope: parent.scope,
    }) as CanonicalAppliedAuthorityMutationV2;
  } catch (error) {
    throw new Error("lite_learning_integrity_failed:learning_control_domain_commit_diff", {
      cause: error,
    });
  }
  const rooted = learningControlV2OperationContext({
    mutation: domainMutation,
    scope: parent.scope,
  });
  const semanticDiff: unknown = rooted.operationContext;
  const rootedNodes = rooted.nodes;
  const diff = exactObject(
    semanticDiff,
    LEARNING_CONTROL_COMMIT_DIFF_FIELDS,
    "learning_control_result_commit_diff",
  );
  const requested = exactStringArray(diff.requested_node_ids, "learning_control_requested_node_ids");
  const resolved = exactStringArray(diff.resolved_node_ids, "learning_control_resolved_node_ids");
  const applied = exactStringArray(diff.applied_node_ids, "learning_control_applied_node_ids");
  const skipped = exactStringArray(
    diff.skipped_positive_attribution_memory_ids,
    "learning_control_diff_skipped_positive_memory_ids",
  );
  const missing = exactStringArray(diff.missing_node_ids, "learning_control_diff_missing_node_ids");
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
    || diff.started_at !== commit.created_at
    || diff.scope !== parent.scope
    || diff.actor !== parent.actor
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
  const observationById = new Map(
    evidence.observations.map((observation) => [observation.memory_id, observation.state]),
  );
  for (const node of rootedNodes) {
    const observed = observationById.get(node.memoryId);
    if (!observed || stableStringify(observed) !== stableStringify({
      ...node.after,
      commit_id: parent.id,
    })) {
      throw new Error("lite_learning_integrity_failed:learning_control_outcome_applied_observation");
    }
  }
  assertLearningControlNodeAfterStates({
    nodes: rootedNodes,
    operationContext: diff,
    inputSha256: parent.input_sha256,
    statByMemoryId,
  });
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
