import stableStringify from "fast-json-stable-stringify";

import {
  LEARNING_SAFETY_STOP_POLICY_SHA256,
  LearningSafetyStopAuthorizationV1Schema,
  LearningSafetyStopOperationReceiptV1Schema,
  learningSafetyAuthorityOperationId,
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
  const evidenceScopeSetSha256 = learningSafetyEvidenceScopeSetDigest([args.feedback.event.scope]);
  const authorityScope = learningSafetyAuthorityScope({
    taskFamily: authority.taskFamily,
    evidenceScopeSetSha256,
  });
  const triggerSha256 = learningEpisodeEventDigest(args.feedback.event);
  const authorityOperationId = learningSafetyAuthorityOperationId({
    triggerRefKind: "episode_feedback",
    triggerRefId: args.feedback.event.event_id,
    authorityScope,
    candidatePolicyImplementationSha256: authority.candidatePolicyImplementationSha256,
  });
  const authorization = LearningSafetyStopAuthorizationV1Schema.parse({
    contract_version: "learning_safety_stop_authorization_v1",
    authorization_kind: "safety_automatic",
    action: "pause",
    tenant_id: args.feedback.event.tenant_id,
    task_family: authority.taskFamily,
    authority_scope: authorityScope,
    authority_operation_kind: "learning_gate_authority_v1",
    authority_operation_id: authorityOperationId,
    trigger_ref_kind: "episode_feedback",
    trigger_ref_id: args.feedback.event.event_id,
    trigger_episode_id: args.feedback.event.episode_id,
    trigger_sha256: triggerSha256,
    evidence_scope_set_sha256: evidenceScopeSetSha256,
    candidate_policy_id: authority.candidatePolicyId,
    candidate_policy_version: authority.candidatePolicyVersion,
    candidate_policy_implementation_sha256: authority.candidatePolicyImplementationSha256,
    candidate_policy_config_sha256: authority.candidatePolicyConfigSha256,
    experiment_id: authority.experimentId,
    experiment_revision: authority.experimentRevision,
    experiment_config_sha256: authority.experimentConfigSha256,
    gate_policy_id: authority.gatePolicyId,
    gate_policy_version: authority.gatePolicyVersion,
    gate_policy_config_sha256: authority.gatePolicyConfigSha256,
    stop_policy_sha256: LEARNING_SAFETY_STOP_POLICY_SHA256,
    source_commit_id: args.sourceCommitId,
    authorized_at: args.recordedAt,
  });
  const authorizationSha256 = learningSafetyStopAuthorizationDigest(authorization);
  const decisionId = `lsafety_decision_${sha256Hex(stableStringify({
    authority_operation_id: authorityOperationId,
    authorization_sha256: authorizationSha256,
  }))}`;
  const summary = {
    contract_version: "learning_boundary_safety_summary_v1",
    boundary_outcome: "boundary_ignored",
    boundary_ignored_memory_ids: [...args.boundaryIgnoredMemoryIds],
    trigger_ref_kind: "episode_feedback",
    trigger_ref_id: args.feedback.event.event_id,
    trigger_sha256: triggerSha256,
    stop_policy_sha256: LEARNING_SAFETY_STOP_POLICY_SHA256,
  } as const;
  const evidenceSummaryJson = stableStringify(summary);
  const decision = emptyGateDecision();
  Object.assign(decision, {
    tenant_id: args.feedback.event.tenant_id,
    decision_id: decisionId,
    task_family: authority.taskFamily,
    candidate_policy_id: authority.candidatePolicyId,
    candidate_policy_version: authority.candidatePolicyVersion,
    candidate_policy_implementation_sha256: authority.candidatePolicyImplementationSha256,
    experiment_id: authority.experimentId,
    experiment_revision: authority.experimentRevision,
    gate_policy_id: authority.gatePolicyId,
    gate_policy_version: authority.gatePolicyVersion,
    look_index: null,
    look_reservation_id: null,
    look_reservation_sha256: null,
    decision_kind: "safety_stop",
    evidence_verdict: "pause_required",
    authority_action: "pause",
    authority_scope: "task_family_candidate_implementation",
    analysis_at: args.recordedAt,
    evidence_cutoff_event_row_id: args.feedbackEventRowId,
    evidence_artifact_cutoff_row_id: 0,
    evidence_artifact_count: 0,
    experiment_config_sha256: authority.experimentConfigSha256,
    evidence_scope_set_sha256: evidenceScopeSetSha256,
    evidence_cohort_sha256: sha256Hex(stableStringify(args.boundaryIgnoredMemoryIds)),
    evidence_artifact_set_sha256: sha256Hex(stableStringify([])),
    evidence_summary_sha256: sha256Hex(evidenceSummaryJson),
    evidence_summary_json: evidenceSummaryJson,
    decision_sha256: "0".repeat(64),
    trigger_ref_kind: "episode_feedback",
    trigger_ref_id: args.feedback.event.event_id,
    trigger_episode_id: args.feedback.event.episode_id,
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
    created_by: "aionis-runtime:safety-stop",
    created_at: args.recordedAt,
  });
  decision.decision_sha256 = learningGateDecisionDigest(decision);
  const inserted = await args.ledger.insertAuthorityFact("lite_learning_gate_decisions", decision);
  const operationReceipt = LearningSafetyStopOperationReceiptV1Schema.parse({
    contract_version: "learning_safety_stop_operation_receipt_v1",
    status: "pause_applied",
    tenant_id: args.feedback.event.tenant_id,
    authority_scope: authorityScope,
    operation_kind: "learning_gate_authority_v1",
    operation_id: authorityOperationId,
    request_sha256: authorizationSha256,
    decision_id: decisionId,
    decision_sha256: decision.decision_sha256,
    trigger_ref_kind: "episode_feedback",
    trigger_ref_id: args.feedback.event.event_id,
    trigger_episode_id: args.feedback.event.episode_id,
    trigger_sha256: triggerSha256,
    candidate_policy_implementation_sha256: authority.candidatePolicyImplementationSha256,
    stop_policy_sha256: LEARNING_SAFETY_STOP_POLICY_SHA256,
    source_commit_id: args.sourceCommitId,
  });
  const existingOperation = await args.liteWriteStore.getWriteOperation({
    tenantId: args.feedback.event.tenant_id,
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
      tenantId: args.feedback.event.tenant_id,
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
