import stableStringify from "fast-json-stable-stringify";

import {
  LEARNING_SAFETY_STOP_POLICY_SHA256,
  LEARNING_SAFETY_STOP_POLICY_V2_SHA256,
  LearningSafetyStopAuthorizationV1Schema,
  LearningSafetyStopOperationReceiptV1Schema,
  learningSafetyAuthorityOperationId,
  learningControlDeadLetterTriggerSha256,
  learningSafetyAuthorityScope,
  learningSafetyEvidenceScopeSetDigest,
  learningSafetyStopAuthorizationDigest,
} from "../memory/learning-safety-stop.js";
import { learningEpisodeEventDigest } from "../memory/learning-episode-ledger.js";
import { sha256Hex } from "../util/crypto.js";
import {
  LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  learningGateDecisionDigest,
  type LiteLearningEpisodeLedgerAccess,
} from "./lite-learning-episode-ledger.js";
import type {
  LiteLearningAuthorityRow,
  LiteLearningSqlValue,
} from "./lite-learning-confirmatory-authority.js";
import type { LiteLearningFeedbackAppend } from "./lite-learning-feedback.js";
import type { LiteLearningFeedbackSource } from "./lite-learning-feedback-source.js";
import type { LiteWriteStore } from "./lite-write-store.js";

type MutableAuthorityRow = Record<string, LiteLearningSqlValue>;

function emptyGateDecision(): MutableAuthorityRow {
  return Object.fromEntries(
    LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_gate_decisions
      .filter((column) => column !== "row_id")
      .map((column) => [column, null]),
  ) as MutableAuthorityRow;
}

export type LiteLearningSafetyStopResult = Readonly<{
  decisionId: string;
  decisionSha256: string;
  authorityOperationId: string;
  authorityScope: string;
  replayed: boolean;
}>;

type LearningSafetyAuthority = NonNullable<LiteLearningFeedbackSource["safetyAuthority"]>;

async function appendLearningSafetyStop(args: Readonly<{
  ledger: LiteLearningEpisodeLedgerAccess;
  liteWriteStore: LiteWriteStore;
  tenantId: string;
  sourceScope: string;
  authority: LearningSafetyAuthority;
  triggerRefKind: "episode_feedback" | "control_job";
  triggerRefId: string;
  triggerEpisodeId: string;
  triggerSha256: string;
  evidenceCutoffEventRowId: number;
  evidenceCohortSha256: string;
  evidenceSummary: Readonly<Record<string, unknown>>;
  stopPolicySha256: string;
  sourceCommitId: string;
  recordedAt: string;
  createdBy: string;
}>): Promise<LiteLearningSafetyStopResult> {
  const evidenceScopeSetSha256 = learningSafetyEvidenceScopeSetDigest([args.sourceScope]);
  const authorityScope = learningSafetyAuthorityScope({
    taskFamily: args.authority.taskFamily,
    evidenceScopeSetSha256,
  });
  const authorityOperationId = learningSafetyAuthorityOperationId({
    triggerRefKind: args.triggerRefKind,
    triggerRefId: args.triggerRefId,
    authorityScope,
    candidatePolicyImplementationSha256: args.authority.candidatePolicyImplementationSha256,
    stopPolicySha256: args.stopPolicySha256,
  });
  const authorization = LearningSafetyStopAuthorizationV1Schema.parse({
    contract_version: "learning_safety_stop_authorization_v1",
    authorization_kind: "safety_automatic",
    action: "pause",
    tenant_id: args.tenantId,
    task_family: args.authority.taskFamily,
    authority_scope: authorityScope,
    authority_operation_kind: "learning_gate_authority_v1",
    authority_operation_id: authorityOperationId,
    trigger_ref_kind: args.triggerRefKind,
    trigger_ref_id: args.triggerRefId,
    trigger_episode_id: args.triggerEpisodeId,
    trigger_sha256: args.triggerSha256,
    evidence_scope_set_sha256: evidenceScopeSetSha256,
    candidate_policy_id: args.authority.candidatePolicyId,
    candidate_policy_version: args.authority.candidatePolicyVersion,
    candidate_policy_implementation_sha256: args.authority.candidatePolicyImplementationSha256,
    candidate_policy_config_sha256: args.authority.candidatePolicyConfigSha256,
    experiment_id: args.authority.experimentId,
    experiment_revision: args.authority.experimentRevision,
    experiment_config_sha256: args.authority.experimentConfigSha256,
    gate_policy_id: args.authority.gatePolicyId,
    gate_policy_version: args.authority.gatePolicyVersion,
    gate_policy_config_sha256: args.authority.gatePolicyConfigSha256,
    stop_policy_sha256: args.stopPolicySha256,
    source_commit_id: args.sourceCommitId,
    authorized_at: args.recordedAt,
  });
  const authorizationSha256 = learningSafetyStopAuthorizationDigest(authorization);
  const decisionId = `lsafety_decision_${sha256Hex(stableStringify({
    authority_operation_id: authorityOperationId,
    authorization_sha256: authorizationSha256,
  }))}`;
  const evidenceSummaryJson = stableStringify(args.evidenceSummary);
  const decision = emptyGateDecision();
  Object.assign(decision, {
    tenant_id: args.tenantId,
    decision_id: decisionId,
    task_family: args.authority.taskFamily,
    candidate_policy_id: args.authority.candidatePolicyId,
    candidate_policy_version: args.authority.candidatePolicyVersion,
    candidate_policy_implementation_sha256: args.authority.candidatePolicyImplementationSha256,
    experiment_id: args.authority.experimentId,
    experiment_revision: args.authority.experimentRevision,
    gate_policy_id: args.authority.gatePolicyId,
    gate_policy_version: args.authority.gatePolicyVersion,
    look_index: null,
    look_reservation_id: null,
    look_reservation_sha256: null,
    decision_kind: "safety_stop",
    evidence_verdict: "pause_required",
    authority_action: "pause",
    authority_scope: "task_family_candidate_implementation",
    analysis_at: args.recordedAt,
    evidence_cutoff_event_row_id: args.evidenceCutoffEventRowId,
    evidence_artifact_cutoff_row_id: 0,
    evidence_artifact_count: 0,
    experiment_config_sha256: args.authority.experimentConfigSha256,
    evidence_scope_set_sha256: evidenceScopeSetSha256,
    evidence_cohort_sha256: args.evidenceCohortSha256,
    evidence_artifact_set_sha256: sha256Hex(stableStringify([])),
    evidence_summary_sha256: sha256Hex(evidenceSummaryJson),
    evidence_summary_json: evidenceSummaryJson,
    decision_sha256: "0".repeat(64),
    trigger_ref_kind: args.triggerRefKind,
    trigger_ref_id: args.triggerRefId,
    trigger_episode_id: args.triggerEpisodeId,
    supersedes_decision_id: null,
    basis_evidence_decision_id: null,
    authority_mutation_id: `lsafety_mutation_${sha256Hex(authorityOperationId)}`,
    source_commit_id: args.sourceCommitId,
    adjudication_observed_event_head_row_id: null,
    adjudication_observed_artifact_head_row_id: null,
    post_cutoff_safety_sha256: null,
    authorization_kind: "safety_automatic",
    authorization_sha256: authorizationSha256,
    authorization_payload_json: stableStringify(authorization),
    authorization_mac: null,
    authorization_nonce: null,
    authorization_expires_at: null,
    authorization_key_id: null,
    approved_by: null,
    authority_operation_id: authorityOperationId,
    authority_operation_scope: authorityScope,
    authority_operation_kind: "learning_gate_authority_v1",
    created_by: args.createdBy,
    created_at: args.recordedAt,
  });
  decision.decision_sha256 = learningGateDecisionDigest(decision);
  const inserted = await args.ledger.insertAutomaticSafetyStopDecision(decision);
  const operationReceipt = LearningSafetyStopOperationReceiptV1Schema.parse({
    contract_version: "learning_safety_stop_operation_receipt_v1",
    status: "pause_applied",
    tenant_id: args.tenantId,
    authority_scope: authorityScope,
    operation_kind: "learning_gate_authority_v1",
    operation_id: authorityOperationId,
    request_sha256: authorizationSha256,
    decision_id: decisionId,
    decision_sha256: decision.decision_sha256,
    trigger_ref_kind: args.triggerRefKind,
    trigger_ref_id: args.triggerRefId,
    trigger_episode_id: args.triggerEpisodeId,
    trigger_sha256: args.triggerSha256,
    candidate_policy_implementation_sha256: args.authority.candidatePolicyImplementationSha256,
    stop_policy_sha256: args.stopPolicySha256,
    source_commit_id: args.sourceCommitId,
  });
  const existingOperation = await args.liteWriteStore.getWriteOperation({
    tenantId: args.tenantId,
    scope: authorityScope,
    operationKind: "learning_gate_authority_v1",
    operationId: authorityOperationId,
  });
  if (existingOperation) {
    if (existingOperation.request_sha256 !== authorizationSha256
      || existingOperation.receipt_json !== stableStringify(operationReceipt)
      || existingOperation.commit_id !== args.sourceCommitId) {
      throw new Error("learning safety-stop authority operation replay conflict");
    }
  } else {
    await args.liteWriteStore.insertWriteOperation({
      tenantId: args.tenantId,
      scope: authorityScope,
      operationKind: "learning_gate_authority_v1",
      operationId: authorityOperationId,
      requestSha256: authorizationSha256,
      receiptJson: stableStringify(operationReceipt),
      commitId: args.sourceCommitId,
    });
  }
  return {
    decisionId,
    decisionSha256: String(decision.decision_sha256),
    authorityOperationId,
    authorityScope,
    replayed: inserted.replayed,
  };
}

export async function appendBoundaryLearningSafetyStop(args: Readonly<{
  ledger: LiteLearningEpisodeLedgerAccess;
  liteWriteStore: LiteWriteStore;
  source: LiteLearningFeedbackSource;
  feedback: LiteLearningFeedbackAppend;
  feedbackEventRowId: number;
  boundaryIgnoredMemoryIds: readonly string[];
  sourceCommitId: string;
  recordedAt: string;
}>): Promise<LiteLearningSafetyStopResult | null> {
  const authority = args.source.safetyAuthority;
  if (!authority || args.boundaryIgnoredMemoryIds.length === 0) return null;
  const triggerSha256 = learningEpisodeEventDigest(args.feedback.event);
  return await appendLearningSafetyStop({
    ledger: args.ledger,
    liteWriteStore: args.liteWriteStore,
    tenantId: args.feedback.event.tenant_id,
    sourceScope: args.feedback.event.scope,
    authority,
    triggerRefKind: "episode_feedback",
    triggerRefId: args.feedback.event.event_id,
    triggerEpisodeId: args.feedback.event.episode_id,
    triggerSha256,
    evidenceCutoffEventRowId: args.feedbackEventRowId,
    evidenceCohortSha256: sha256Hex(stableStringify(args.boundaryIgnoredMemoryIds)),
    evidenceSummary: {
      contract_version: "learning_boundary_safety_summary_v1",
      boundary_outcome: "boundary_ignored",
      boundary_ignored_memory_ids: [...args.boundaryIgnoredMemoryIds],
      trigger_ref_kind: "episode_feedback",
      trigger_ref_id: args.feedback.event.event_id,
      trigger_sha256: triggerSha256,
      stop_policy_sha256: LEARNING_SAFETY_STOP_POLICY_SHA256,
    },
    stopPolicySha256: LEARNING_SAFETY_STOP_POLICY_SHA256,
    sourceCommitId: args.sourceCommitId,
    recordedAt: args.recordedAt,
    createdBy: "aionis-runtime:safety-stop",
  });
}

export async function appendControlJobLearningSafetyStop(args: Readonly<{
  ledger: LiteLearningEpisodeLedgerAccess;
  liteWriteStore: LiteWriteStore;
  source: LiteLearningFeedbackSource;
  job: Readonly<{
    tenant_id: string;
    scope: string;
    job_id: string;
    source_episode_id: string;
    source_feedback_event_id: string;
    source_commit_id: string;
    payload_sha256: string;
    attempt_count: number;
  }>;
  feedbackEventRowId: number;
  lastErrorCode: string;
  recordedAt: string;
}>): Promise<LiteLearningSafetyStopResult | null> {
  const authority = args.source.safetyAuthority;
  if (!authority) return null;
  const triggerSha256 = learningControlDeadLetterTriggerSha256({
    tenantId: args.job.tenant_id,
    scope: args.job.scope,
    jobId: args.job.job_id,
    sourceEpisodeId: args.job.source_episode_id,
    sourceFeedbackEventId: args.job.source_feedback_event_id,
    sourceCommitId: args.job.source_commit_id,
    payloadSha256: args.job.payload_sha256,
    attemptCount: args.job.attempt_count,
    lastErrorCode: args.lastErrorCode,
  });
  return await appendLearningSafetyStop({
    ledger: args.ledger,
    liteWriteStore: args.liteWriteStore,
    tenantId: args.job.tenant_id,
    sourceScope: args.job.scope,
    authority,
    triggerRefKind: "control_job",
    triggerRefId: args.job.job_id,
    triggerEpisodeId: args.job.source_episode_id,
    triggerSha256,
    evidenceCutoffEventRowId: args.feedbackEventRowId,
    evidenceCohortSha256: sha256Hex(stableStringify([args.job.job_id, args.job.payload_sha256])),
    evidenceSummary: {
      contract_version: "learning_control_dead_letter_safety_summary_v1",
      job_id: args.job.job_id,
      source_episode_id: args.job.source_episode_id,
      source_feedback_event_id: args.job.source_feedback_event_id,
      source_commit_id: args.job.source_commit_id,
      payload_sha256: args.job.payload_sha256,
      attempt_count: args.job.attempt_count,
      last_error_code: args.lastErrorCode,
      trigger_ref_kind: "control_job",
      trigger_ref_id: args.job.job_id,
      trigger_sha256: triggerSha256,
      stop_policy_sha256: LEARNING_SAFETY_STOP_POLICY_V2_SHA256,
    },
    stopPolicySha256: LEARNING_SAFETY_STOP_POLICY_V2_SHA256,
    sourceCommitId: args.job.source_commit_id,
    recordedAt: args.recordedAt,
    createdBy: "aionis-runtime:learning-control-worker",
  });
}
