import stableStringify from "fast-json-stable-stringify";

import {
  LEARNING_SAFETY_STOP_POLICY_SHA256,
  LEARNING_SAFETY_STOP_POLICY_V2_SHA256,
  LearningSafetyStopAuthorizationV1Schema,
  LearningSafetyStopOperationReceiptV1Schema,
  learningSafetyAuthorityOperationId,
  learningSafetyAuthorityScope,
  learningSafetyStopAuthorizationDigest,
  learningControlDeadLetterTriggerSha256,
  learningSafetyEvidenceScopeSetDigest,
} from "../memory/learning-safety-stop.js";
import {
  FeedbackAttributedV1Schema,
  LearningEpisodeEventWithoutDigestSchema,
  assertFeedbackOperationBinding,
  learningEpisodeEventDigest,
  type FeedbackAttributedV1,
} from "../memory/learning-episode-ledger.js";
import {
  resolveNodeFeedbackAttributionStrength,
  type NodeFeedbackAttributionStrength,
  type NodeFeedbackOutcome,
  type NodeFeedbackToolStatus,
  type NodeFeedbackUsedSurface,
  type NodeFeedbackVerifierStatus,
} from "../memory/node-feedback-state.js";
import {
  ToolRuleEvaluationProvenanceSchema,
  type ToolRuleEvaluationProvenance,
} from "../memory/tool-rule-evaluation-provenance.js";
import { buildToolsRunLifecycleSummary } from "../memory/tools-lifecycle-summary.js";
import { buildAionisUri } from "../memory/uri.js";
import { sha256Hex } from "../util/crypto.js";
import { stableUuid } from "../util/uuid.js";
import {
  learningFeedbackAttributionItemDigest,
  learningFeedbackAttributionSetDigest,
} from "./lite-learning-feedback-digest.js";
import type { LiteLearningAuthorityRow } from "./lite-learning-confirmatory-authority.js";
import type { SqliteDatabase } from "./sqlite.js";

type Row = Record<string, unknown>;

export type LiteLearningProtectedToolFeedbackAuthorityResolution =
  | Readonly<{
      status: "available";
      eventId: string;
      eventSha256: string;
      episodeId: string;
      guideTraceId: string;
      runId: string;
      operationId: string;
      operationReceiptSha256: string;
      decisionId: string;
      outcome: "positive";
      operationProtection: "protected";
      sourceCommitId: string;
      recordedAt: string;
    }>
  | Readonly<{
      status: "unavailable";
      reasonCode:
        | "feedback_missing"
        | "feedback_ambiguous"
        | "feedback_binding_mismatch"
        | "feedback_not_positive"
        | "feedback_operation_unprotected";
    }>;

const FEEDBACK_INHERITED_FIELDS = [
  "collection_class", "collection_principal_sha256", "collector_id", "collector_version",
  "host_task_id", "host_task_envelope_sha256",
] as const;
const ROUTE_FEEDBACK_INHERITED_FIELDS = [
  ...FEEDBACK_INHERITED_FIELDS,
  "host_source_task_sha256", "host_source_event_sha256", "host_task_envelope_created_at",
  "task_family", "task_signature_sha256", "repo_signature_sha256",
  "memory_namespace_sha256", "namespace_set_sha256", "namespace_lease_id",
  "namespace_lease_generation", "profile_id", "experiment_id", "experiment_revision",
  "enrollment_state", "serving_phase", "evidence_intent", "assignment_mode",
  "assignment_unit_sha256", "assignment_namespace_sha256", "assignment_bucket",
  "randomization_pair_sha256", "matching_covariate_sha256", "pair_member_ordinal",
  "activation_wave_index", "activation_starts_at", "index_window_ends_at",
  "wave_analysis_at", "assignment_arm", "served_arm", "candidate_policy_id",
  "candidate_policy_version", "policy_affected", "predecision_track", "projection_complete",
] as const;

function requiredString(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`lite_learning_integrity_failed:safety_stop_${field}`);
  }
  return value;
}

function decisionDigest(row: Row): string {
  return sha256Hex(stableStringify(Object.fromEntries(
    Object.entries(row)
      .filter(([field]) => field !== "row_id" && field !== "decision_sha256")
      .sort(([left], [right]) => left.localeCompare(right)),
  )));
}

function parseCanonical(raw: string, errorCode: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`lite_learning_integrity_failed:${errorCode}_json`);
  }
  if (stableStringify(value) !== raw) {
    throw new Error(`lite_learning_integrity_failed:${errorCode}_canonical`);
  }
  return value;
}

function exactObject(value: unknown, fields: readonly string[], errorCode: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`lite_learning_integrity_failed:${errorCode}_object`);
  }
  const row = value as Row;
  const actual = Object.keys(row).sort();
  const expected = [...fields].sort();
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`lite_learning_integrity_failed:${errorCode}_shape`);
  }
  return row;
}

function requiredObject(value: unknown, errorCode: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`lite_learning_integrity_failed:${errorCode}_object`);
  }
  return value as Row;
}

function stringArray(value: unknown, errorCode: string): string[] {
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length) {
    throw new Error(`lite_learning_integrity_failed:${errorCode}`);
  }
  return value as string[];
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

function requiredEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  errorCode: string,
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`lite_learning_integrity_failed:${errorCode}`);
  }
  return value as Values[number];
}

function nullableEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  errorCode: string,
): Values[number] | null {
  if (value === null) return null;
  return requiredEnum(value, allowed, errorCode);
}

function nonNegativeInteger(value: unknown, errorCode: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`lite_learning_integrity_failed:${errorCode}`);
  }
  return value;
}

function sameStringSet(actual: unknown, expected: readonly string[], errorCode: string): void {
  const values = stringArray(actual, errorCode);
  if (stableStringify(canonicalStrings(values)) !== stableStringify(canonicalStrings(expected))) {
    throw new Error(`lite_learning_integrity_failed:${errorCode}`);
  }
}

function parseJson(raw: string, errorCode: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`lite_learning_integrity_failed:${errorCode}_json`);
  }
}

function expectedToolFeedbackAttributionStrength(
  outcome: "positive" | "negative" | "neutral",
): "observed_feedback" | "positive_attribution" | "strong_counter_signal" {
  if (outcome === "positive") return "positive_attribution";
  if (outcome === "negative") return "strong_counter_signal";
  return "observed_feedback";
}

function isToolPolicyPath(path: string): boolean {
  return path === "tool" || path.startsWith("tool.");
}

function toolRuleEvaluationProvenance(args: {
  decision: Row;
  decisionSourceRuleIds: readonly string[];
  guideToolSelection: Row;
}): ToolRuleEvaluationProvenance | null {
  const metadata = requiredObject(
    parseJson(
      requiredString(args.decision, "metadata_json"),
      "tool_feedback_decision_metadata",
    ),
    "tool_feedback_decision_metadata",
  );
  const rawProvenance = metadata.tool_rule_evaluation_provenance_v1;
  const provenanceDeclared = rawProvenance !== undefined;
  const contextDeclared = args.guideToolSelection.context_sha256 !== undefined;
  const digestDeclared = args.guideToolSelection.rule_evaluation_sha256 !== undefined;
  if (!provenanceDeclared && !contextDeclared && !digestDeclared) return null;
  if (!provenanceDeclared || !contextDeclared || !digestDeclared) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_rule_evaluation_provenance_binding");
  }
  const parsed = ToolRuleEvaluationProvenanceSchema.safeParse(
    rawProvenance,
  );
  if (!parsed.success) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_rule_evaluation_provenance");
  }
  const provenance = parsed.data;
  const activeRuleIds = provenance.active_sources.map((source) => source.rule_node_id);
  const allRuleIds = activeRuleIds.concat(
    provenance.shadow_sources.map((source) => source.rule_node_id),
  );
  if (new Set(allRuleIds).size !== allRuleIds.length
    || provenance.effective_context_sha256 !== args.decision.context_sha256
    || provenance.policy_sha256 !== args.decision.policy_sha256
    || args.guideToolSelection.context_sha256 !== args.decision.context_sha256
    || args.guideToolSelection.rule_evaluation_sha256 !== provenance.provenance_sha256) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_rule_evaluation_provenance_binding");
  }
  sameStringSet(
    args.decisionSourceRuleIds,
    activeRuleIds,
    "tool_feedback_rule_evaluation_provenance_active_sources",
  );
  return provenance;
}

function expectedToolFeedbackRuleIds(
  provenance: ToolRuleEvaluationProvenance,
  target: "tool" | "all",
  includeShadow: boolean,
): string[] {
  const sources = provenance.active_sources.concat(
    includeShadow ? provenance.shadow_sources : [],
  );
  return sources
    .filter((source) => target === "all" || source.touched_paths.some(isToolPolicyPath))
    .map((source) => source.rule_node_id);
}

function protectedFeedbackCommitRoot(args: {
  db: SqliteDatabase;
  event: Row;
  payload: FeedbackAttributedV1;
  attributions: readonly Row[];
  hostUseReceipt: Row | null;
}): {
  commit: Row;
  diff: Row;
  feedback: Row;
  subjectIds: string[];
  expectedAttributionStrength: NodeFeedbackAttributionStrength;
} {
  const { db, event, payload, attributions, hostUseReceipt } = args;
  const commit = db.prepare(
    `SELECT id, scope, parent_commit_id, input_sha256, diff_json, actor,
            model_version, prompt_version, commit_hash, created_at
     FROM lite_memory_commits WHERE id = ?`,
  ).get(event.source_commit_id) as Row | undefined;
  if (!commit
    || commit.id !== event.source_commit_id
    || typeof commit.scope !== "string"
    || typeof commit.actor !== "string"
    || typeof commit.diff_json !== "string"
    || typeof commit.input_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(commit.input_sha256)
    || typeof commit.commit_hash !== "string"
    || !/^[a-f0-9]{64}$/u.test(commit.commit_hash)
    || commit.model_version !== null
    || commit.prompt_version !== null) {
    throw new Error("lite_learning_integrity_failed:feedback_source_commit");
  }
  const namespaceSha256 = event.memory_namespace_sha256;
  if (typeof namespaceSha256 !== "string"
    || namespaceSha256 !== sha256Hex(commit.scope)) {
    throw new Error("lite_learning_integrity_failed:feedback_source_commit_scope");
  }
  const diff = exactObject(
    parseCanonical(commit.diff_json, "feedback_source_commit_diff"),
    [
      "job", "started_at", "scope", "actor", "run_id", "guide_trace_id",
      "learning_episode_id", "feedback_operation_id", "outcome", "activate",
      "feedback", "reason", "requested", "resolved_by_client", "found_node_ids",
      "missing_node_ids", "missing_client_ids",
    ],
    "feedback_source_commit_diff",
  );
  const requested = exactObject(diff.requested, ["node_ids", "client_ids"], "feedback_source_commit_requested");
  const feedback = exactObject(
    diff.feedback,
    [
      "used_surface", "verifier_status", "tool_status", "runtime_signal_refs",
      "boundary_ignored_memory_ids", "verified_host_receipt", "subjects",
    ],
    "feedback_source_commit_feedback",
  );
  if (!Array.isArray(feedback.subjects)) {
    throw new Error("lite_learning_integrity_failed:feedback_source_commit_subjects");
  }
  const subjectIds = canonicalStrings(attributions.map((attribution) => {
    if (attribution.subject_kind !== "memory") {
      throw new Error("lite_learning_integrity_failed:feedback_source_commit_subject_kind");
    }
    return requiredString(attribution, "subject_id");
  }));
  const boundaryIds = canonicalStrings(attributions
    .filter((attribution) => attribution.boundary_outcome === "boundary_ignored")
    .map((attribution) => requiredString(attribution, "subject_id")));
  const expectedSubjects = subjectIds.map((memoryId) => ({
    memory_id: memoryId,
    boundary_ignored: boundaryIds.includes(memoryId),
  }));
  const actualSubjects = feedback.subjects.map((subject) => exactObject(
    subject,
    ["memory_id", "boundary_ignored"],
    "feedback_source_commit_subject",
  ));
  if (stableStringify(actualSubjects) !== stableStringify(expectedSubjects)) {
    throw new Error("lite_learning_integrity_failed:feedback_source_commit_subjects");
  }
  sameStringSet(diff.found_node_ids, subjectIds, "feedback_source_commit_found_subjects");
  sameStringSet(requested.node_ids, subjectIds, "feedback_source_commit_requested_subjects");
  sameStringSet(feedback.boundary_ignored_memory_ids, boundaryIds, "feedback_source_commit_boundaries");
  if (stringArray(requested.client_ids, "feedback_source_commit_client_ids").length !== 0
    || !Array.isArray(diff.resolved_by_client) || diff.resolved_by_client.length !== 0
    || stringArray(diff.missing_node_ids, "feedback_source_commit_missing_nodes").length !== 0
    || stringArray(diff.missing_client_ids, "feedback_source_commit_missing_clients").length !== 0) {
    throw new Error("lite_learning_integrity_failed:feedback_source_commit_partial_subjects");
  }
  const rootedOutcome = requiredEnum(
    diff.outcome,
    ["positive", "negative", "neutral"] as const,
    "feedback_source_commit_outcome",
  ) as NodeFeedbackOutcome;
  const rootedSurface = requiredEnum(
    feedback.used_surface,
    ["use_now", "inspect_before_use", "do_not_use", "explicit_host_assertion"] as const,
    "feedback_source_commit_surface",
  ) as NodeFeedbackUsedSurface;
  const rootedVerifierStatus = nullableEnum(
    feedback.verifier_status,
    ["passed", "failed", "not_run", "unknown"] as const,
    "feedback_source_commit_verifier_status",
  ) as NodeFeedbackVerifierStatus | null;
  const rootedToolStatus = nullableEnum(
    feedback.tool_status,
    ["succeeded", "failed", "not_run", "unknown"] as const,
    "feedback_source_commit_tool_status",
  ) as NodeFeedbackToolStatus | null;
  const rootedRuntimeSignalRefs = stringArray(
    feedback.runtime_signal_refs,
    "feedback_source_commit_runtime_refs",
  );
  const outcomes = new Set(attributions.map((attribution) => attribution.outcome));
  const surfaces = new Set(attributions.map((attribution) => attribution.used_surface));
  const toolStatuses = new Set(attributions.map((attribution) => attribution.tool_status));
  if (outcomes.size !== 1 || !outcomes.has(rootedOutcome)
    || surfaces.size !== 1 || !surfaces.has(rootedSurface)
    || toolStatuses.size !== 1 || !toolStatuses.has(rootedToolStatus)
    || typeof diff.activate !== "boolean"
    || feedback.verified_host_receipt !== (hostUseReceipt !== null)
    || stableStringify(rootedRuntimeSignalRefs)
      !== stableStringify(payload.runtime_signal_refs)
    || attributions.some((attribution) => attribution.runtime_signal_refs_sha256
      !== sha256Hex(stableStringify(payload.runtime_signal_refs)))) {
    throw new Error("lite_learning_integrity_failed:feedback_source_commit_inputs");
  }
  if (hostUseReceipt !== null
    && attributions.some((attribution) => attribution.verifier_status !== feedback.verifier_status)) {
    throw new Error("lite_learning_integrity_failed:feedback_source_commit_verifier");
  }
  const expectedAttributionStrength = resolveNodeFeedbackAttributionStrength({
    outcome: rootedOutcome,
    used_surface: rootedSurface,
    verified_host_receipt: hostUseReceipt !== null,
    verifier_status: rootedVerifierStatus,
    tool_status: rootedToolStatus,
    runtime_signal_refs: rootedRuntimeSignalRefs,
  });
  if (attributions.some((attribution) =>
    attribution.attribution_strength !== expectedAttributionStrength
  )) {
    throw new Error("lite_learning_integrity_failed:feedback_attribution_strength_root");
  }
  if (diff.job !== "nodes_activate"
    || diff.started_at !== event.recorded_at
    || diff.scope !== commit.scope
    || diff.actor !== commit.actor
    || diff.run_id !== payload.run_id
    || diff.guide_trace_id !== payload.guide_trace_id
    || diff.learning_episode_id !== event.episode_id
    || diff.feedback_operation_id !== event.operation_id) {
    throw new Error("lite_learning_integrity_failed:feedback_source_commit_identity");
  }
  let parentHash = "";
  if (commit.parent_commit_id !== null) {
    const parent = db.prepare(
      `SELECT commit_hash FROM lite_memory_commits WHERE id = ? AND scope = ?`,
    ).get(commit.parent_commit_id, commit.scope) as Row | undefined;
    if (!parent || typeof parent.commit_hash !== "string" || !/^[a-f0-9]{64}$/u.test(parent.commit_hash)) {
      throw new Error("lite_learning_integrity_failed:feedback_source_commit_parent");
    }
    parentHash = parent.commit_hash;
  }
  const expectedCommitHash = sha256Hex(stableStringify({
    parentHash,
    inputSha: commit.input_sha256,
    diffSha: sha256Hex(commit.diff_json),
    scope: commit.scope,
    actor: commit.actor,
    kind: "nodes_activate",
  }));
  if (commit.commit_hash !== expectedCommitHash
    || commit.id !== stableUuid(`lite:commit:${expectedCommitHash}`)) {
    throw new Error("lite_learning_integrity_failed:feedback_source_commit_hash");
  }
  return { commit, diff, feedback, subjectIds, expectedAttributionStrength };
}

function toolFeedbackCommitRoot(args: {
  db: SqliteDatabase;
  event: Row;
  payload: FeedbackAttributedV1;
  attributions: readonly Row[];
}): {
  attribution: Row;
  commit: Row;
  feedback: Row;
  decision: Row;
  guideToolSelection: Row;
  ruleEvaluationProvenance: ToolRuleEvaluationProvenance | null;
} {
  const { db, event, payload, attributions } = args;
  if (payload.feedback_kind !== "tool_selection"
    || event.source_kind !== "tool_feedback_operation"
    || attributions.length !== 1) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_root_shape");
  }
  const attribution = attributions[0]!;
  const outcome = requiredEnum(
    attribution.outcome,
    ["positive", "negative", "neutral"] as const,
    "tool_feedback_attribution_outcome",
  );
  if (attribution.subject_kind !== "tool_decision"
    || attribution.action_outcome !== null
    || attribution.used_surface !== null
    || attribution.exposure_action !== null
    || attribution.boundary_outcome !== "not_applicable"
    || attribution.attribution_strength !== expectedToolFeedbackAttributionStrength(outcome)
    || attribution.evidence_class !== "tool_decision"
    || attribution.host_use_receipt_id !== null
    || attribution.host_use_receipt_sha256 !== null
    || attribution.receipt_item_sha256 !== null
    || attribution.host_task_envelope_sha256 !== null
    || attribution.collection_principal_sha256 !== null
    || attribution.collector_id !== null
    || attribution.collector_version !== null
    || attribution.content_evidence_sha256 !== null
    || attribution.verifier_kind !== null
    || attribution.verifier_version !== null
    || attribution.verifier_config_sha256 !== null
    || attribution.verifier_status !== null
    || attribution.tool_status !== null
    || attribution.runtime_signal_refs_sha256 !== null) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_attribution_shape");
  }
  const decisionId = requiredString(attribution, "subject_id");
  const commit = db.prepare(
    `SELECT id, scope, parent_commit_id, input_sha256, diff_json, actor,
            model_version, prompt_version, commit_hash, created_at
     FROM lite_memory_commits WHERE id = ?`,
  ).get(event.source_commit_id) as Row | undefined;
  if (!commit
    || commit.id !== event.source_commit_id
    || typeof commit.scope !== "string"
    || typeof commit.actor !== "string"
    || typeof commit.diff_json !== "string"
    || typeof commit.input_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(commit.input_sha256)
    || typeof commit.commit_hash !== "string"
    || !/^[a-f0-9]{64}$/u.test(commit.commit_hash)
    || commit.model_version !== null
    || commit.prompt_version !== null
    || event.memory_namespace_sha256 !== sha256Hex(commit.scope)) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_source_commit");
  }
  const diff = parseJson(commit.diff_json, "tool_feedback_source_commit_diff") as Row;
  const feedbackRows = diff && typeof diff === "object" && !Array.isArray(diff)
    ? diff.tool_feedback
    : null;
  if (!Array.isArray(feedbackRows) || feedbackRows.length !== 1) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_source_commit_diff");
  }
  const rootedFeedback = feedbackRows[0] as Row;
  if (!rootedFeedback || typeof rootedFeedback !== "object" || Array.isArray(rootedFeedback)
    || rootedFeedback.decision_id !== decisionId
    || rootedFeedback.run_id !== payload.run_id
    || rootedFeedback.outcome !== outcome) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_source_commit_inputs");
  }
  let parentHash = "";
  if (commit.parent_commit_id !== null) {
    const parent = db.prepare(
      `SELECT commit_hash FROM lite_memory_commits WHERE id = ? AND scope = ?`,
    ).get(commit.parent_commit_id, commit.scope) as Row | undefined;
    if (!parent || typeof parent.commit_hash !== "string" || !/^[a-f0-9]{64}$/u.test(parent.commit_hash)) {
      throw new Error("lite_learning_integrity_failed:tool_feedback_source_commit_parent");
    }
    parentHash = parent.commit_hash;
  }
  const expectedCommitHash = sha256Hex(stableStringify({
    parentHash,
    inputSha: commit.input_sha256,
    diffSha: sha256Hex(stableStringify(diff)),
    scope: commit.scope,
    actor: commit.actor,
    kind: "tool_feedback",
  }));
  if (commit.commit_hash !== expectedCommitHash
    || commit.id !== stableUuid(`lite:commit:${expectedCommitHash}`)) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_source_commit_hash");
  }
  const decision = db.prepare(
    `SELECT id, scope, decision_kind, run_id, selected_tool, candidates_json,
            context_sha256, policy_sha256, source_rule_ids_json, metadata_json,
            commit_id, created_at
     FROM lite_memory_execution_decisions WHERE id = ?`,
  ).get(decisionId) as Row | undefined;
  if (!decision
    || decision.decision_kind !== "tools_select"
    || decision.run_id !== payload.run_id
    || decision.scope !== commit.scope) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_decision_binding");
  }
  const latestDecisionFeedback = db.prepare(
    `SELECT feedback.source_commit_id
     FROM lite_learning_feedback_attributions AS attribution
     JOIN lite_learning_episode_events AS feedback
       ON feedback.tenant_id = attribution.tenant_id
      AND feedback.scope = attribution.scope
      AND feedback.event_id = attribution.event_id
     WHERE attribution.tenant_id = ? AND attribution.scope = ?
       AND attribution.subject_kind = 'tool_decision'
       AND attribution.subject_id = ?
     ORDER BY feedback.row_id DESC
     LIMIT 1`,
  ).get(event.tenant_id, event.scope, decisionId) as Row | undefined;
  const currentEventPersisted = db.prepare(
    `SELECT 1 AS present
     FROM lite_learning_episode_events
     WHERE tenant_id = ? AND scope = ? AND event_id = ?`,
  ).get(event.tenant_id, event.scope, event.event_id) as Row | undefined;
  const expectedDecisionHead = currentEventPersisted
    ? latestDecisionFeedback?.source_commit_id
    : event.source_commit_id;
  if (typeof expectedDecisionHead !== "string"
    || decision.commit_id !== expectedDecisionHead) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_decision_head");
  }
  const guideReceipt = db.prepare(
    `SELECT ledger_sha256, ledger_json, commit_id
     FROM lite_product_guide_receipts
     WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
  ).get(event.tenant_id, event.scope, payload.guide_trace_id) as Row | undefined;
  const guideLedgerJson = guideReceipt ? requiredString(guideReceipt, "ledger_json") : null;
  if (!guideReceipt || guideLedgerJson === null
    || sha256Hex(guideLedgerJson) !== guideReceipt.ledger_sha256) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_guide_receipt");
  }
  const guideLedger = parseCanonical(
    guideLedgerJson,
    "tool_feedback_guide_ledger",
  ) as Row;
  const guideToolSelection = guideLedger.tool_selection as Row | undefined;
  const decisionCandidates = stringArray(
    parseCanonical(
      requiredString(decision, "candidates_json"),
      "tool_feedback_decision_candidates",
    ),
    "tool_feedback_decision_candidates",
  );
  const feedbackCandidates = stringArray(
    rootedFeedback.candidates,
    "tool_feedback_source_commit_candidates",
  );
  const feedbackRuleNodeIds = stringArray(
    rootedFeedback.rule_node_ids,
    "tool_feedback_source_commit_rule_node_ids",
  );
  const decisionSourceRuleIds = stringArray(
    parseCanonical(
      requiredString(decision, "source_rule_ids_json"),
      "tool_feedback_decision_source_rule_ids",
    ),
    "tool_feedback_decision_source_rule_ids",
  );
  const guideSourceRuleIds = stringArray(
    guideToolSelection?.source_rule_ids,
    "tool_feedback_guide_source_rule_ids",
  );
  const feedbackTarget = requiredEnum(
    rootedFeedback.target,
    ["tool", "all"] as const,
    "tool_feedback_source_commit_target",
  );
  const decisionSourceRuleIdSet = new Set(decisionSourceRuleIds);
  if (!guideToolSelection
    || typeof guideToolSelection !== "object"
    || Array.isArray(guideToolSelection)
    || guideToolSelection.contract_version !== "aionis_tool_selection_receipt_v1"
    || guideToolSelection.decision_id !== decisionId
    || guideToolSelection.run_id !== payload.run_id
    || guideToolSelection.selected_tool !== decision.selected_tool
    || stableStringify(guideToolSelection.candidates) !== stableStringify(decisionCandidates)
    || guideToolSelection.policy_sha256 !== decision.policy_sha256
    || stableStringify(guideSourceRuleIds) !== stableStringify(decisionSourceRuleIds)
    || rootedFeedback.selected_tool !== decision.selected_tool
    || stableStringify(feedbackCandidates) !== stableStringify(decisionCandidates)
    || !["provided", "inferred", "created_from_feedback"].includes(
      String(rootedFeedback.decision_link_mode),
    )
    || new Set(feedbackRuleNodeIds).size !== feedbackRuleNodeIds.length) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_guide_decision_binding");
  }
  const ruleEvaluationProvenance = toolRuleEvaluationProvenance({
    decision,
    decisionSourceRuleIds,
    guideToolSelection,
  });
  if (ruleEvaluationProvenance) {
    const feedbackIncludeShadow = rootedFeedback.include_shadow;
    if (typeof feedbackIncludeShadow !== "boolean"
      || (feedbackIncludeShadow && !ruleEvaluationProvenance.include_shadow)) {
      throw new Error("lite_learning_integrity_failed:tool_feedback_rule_evaluation_shadow_binding");
    }
    sameStringSet(
      guideSourceRuleIds,
      ruleEvaluationProvenance.active_sources.map((source) => source.rule_node_id),
      "tool_feedback_guide_rule_evaluation_sources",
    );
    sameStringSet(
      feedbackRuleNodeIds,
      expectedToolFeedbackRuleIds(
        ruleEvaluationProvenance,
        feedbackTarget,
        feedbackIncludeShadow,
      ),
      "tool_feedback_rule_evaluation_attribution",
    );
  } else if (feedbackRuleNodeIds.some((ruleNodeId) => !decisionSourceRuleIdSet.has(ruleNodeId))
    || (feedbackTarget === "all"
      && stableStringify(feedbackRuleNodeIds) !== stableStringify(decisionSourceRuleIds))) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_guide_decision_binding");
  }
  return {
    attribution,
    commit,
    feedback: rootedFeedback,
    decision,
    guideToolSelection,
    ruleEvaluationProvenance,
  };
}

export function assertLiteLearningFeedbackExposureProvenance(
  db: SqliteDatabase,
  event: Row,
  payload: FeedbackAttributedV1,
  feedbackAttributions?: readonly Row[],
  feedbackHostUseReceipt?: Row | null,
): {
  routeBound: boolean;
  routeKind: "memory" | "tool_selection" | null;
  protectedRoot: ReturnType<typeof protectedFeedbackCommitRoot> | null;
  toolRoot: ReturnType<typeof toolFeedbackCommitRoot> | null;
} {
  const exposure = db.prepare(
    `SELECT * FROM lite_learning_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND event_kind = 'exposure_committed'`,
  ).get(event.tenant_id, event.scope, event.episode_id) as Row | undefined;
  const routeKind = payload.operation_protection === "protected"
    ? payload.feedback_kind
    : null;
  const routeBound = routeKind !== null;
  const driftedField = exposure
    ? (routeBound ? ROUTE_FEEDBACK_INHERITED_FIELDS : FEEDBACK_INHERITED_FIELDS)
      .find((field) => exposure[field] !== event[field])
    : undefined;
  if (!exposure
    || exposure.source_id !== payload.guide_trace_id
    || driftedField !== undefined
    || Number(event.promotion_eligible) !== 0) {
    throw new Error(`lite_learning_integrity_failed:feedback_exposure_provenance:${driftedField ?? "identity"}`);
  }
  let protectedRoot: ReturnType<typeof protectedFeedbackCommitRoot> | null = null;
  if (routeKind === "memory") {
    const attributions = feedbackAttributions ?? db.prepare(
      `SELECT * FROM lite_learning_feedback_attributions
       WHERE tenant_id = ? AND scope = ? AND event_id = ?
       ORDER BY subject_kind, subject_id`,
    ).all(event.tenant_id, event.scope, event.event_id) as Row[];
    const hostUseReceipt = feedbackHostUseReceipt === undefined
      ? (db.prepare(
          `SELECT * FROM lite_learning_host_use_receipts
           WHERE tenant_id = ? AND scope = ? AND feedback_event_id = ?`,
        ).get(event.tenant_id, event.scope, event.event_id) as Row | undefined) ?? null
      : feedbackHostUseReceipt;
    protectedRoot = protectedFeedbackCommitRoot({ db, event, payload, attributions, hostUseReceipt });
  }
  const toolRoot = payload.feedback_kind === "tool_selection"
    ? toolFeedbackCommitRoot({
        db,
        event,
        payload,
        attributions: feedbackAttributions ?? db.prepare(
          `SELECT * FROM lite_learning_feedback_attributions
           WHERE tenant_id = ? AND scope = ? AND event_id = ?
           ORDER BY subject_kind, subject_id`,
        ).all(event.tenant_id, event.scope, event.event_id) as Row[],
      })
    : null;
  return { routeBound, routeKind, protectedRoot, toolRoot };
}

function assertProtectedToolFeedbackOperationReceipt(args: {
  db: SqliteDatabase;
  event: Row;
  payload: FeedbackAttributedV1;
  root: NonNullable<ReturnType<typeof toolFeedbackCommitRoot>>;
}): void {
  const { db, event, payload, root } = args;
  const operation = db.prepare(
    `SELECT request_sha256, receipt_json, commit_id
     FROM lite_runtime_write_operations
     WHERE tenant_id = ? AND scope = ? AND operation_kind = 'product_feedback_v1'
       AND operation_id = ?`,
  ).get(event.tenant_id, event.scope, event.operation_id) as Row | undefined;
  const receiptJson = operation ? requiredString(operation, "receipt_json") : null;
  if (!operation
    || operation.request_sha256 !== payload.request_sha256
    || operation.commit_id !== event.source_commit_id
    || receiptJson === null
    || sha256Hex(receiptJson) !== payload.operation_receipt_sha256) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_operation_receipt");
  }
  const result = requiredObject(
    parseCanonical(receiptJson, "tool_feedback_operation_receipt"),
    "tool_feedback_operation_receipt",
  );
  const body = requiredObject(result.body, "tool_feedback_operation_receipt_body");
  const feedbackResult = requiredObject(
    body.feedback_result,
    "tool_feedback_operation_receipt_result",
  );
  const toolSelection = requiredObject(
    body.tool_selection,
    "tool_feedback_operation_receipt_selection",
  );
  const runLifecycle = requiredObject(
    body.run_lifecycle,
    "tool_feedback_operation_receipt_run",
  );
  const sourceMap = requiredObject(
    body.source_map,
    "tool_feedback_operation_receipt_source_map",
  );
  const rootedRuleNodeIds = stringArray(
    root.feedback.rule_node_ids,
    "tool_feedback_operation_receipt_root_rules",
  );
  const responseRuleNodeIds = stringArray(
    feedbackResult.rule_node_ids,
    "tool_feedback_operation_receipt_result_rules",
  );
  const responseRoutes = stringArray(
    sourceMap.routes_used,
    "tool_feedback_operation_receipt_routes",
  );
  const responseSurfaces = stringArray(
    sourceMap.internal_surfaces_used,
    "tool_feedback_operation_receipt_surfaces",
  );
  if (result.ok !== true
    || result.statusCode !== 200
    || body.contract_version !== "aionis_feedback_result_v1"
    || body.product_action !== "feedback"
    || body.feedback_kind !== "tool_selection"
    || body.operation_id !== event.operation_id
    || body.tenant_id !== event.tenant_id
    || body.scope !== event.scope
    || body.learning_attribution_status !== "tool_decision"
    || body.learning_episode_id !== event.episode_id
    || body.learning_feedback_event_id !== event.event_id
    || stableStringify(toolSelection) !== stableStringify(root.guideToolSelection)
    || feedbackResult.ok !== true
    || feedbackResult.tenant_id !== event.tenant_id
    || feedbackResult.scope !== event.scope
    || feedbackResult.commit_id !== event.source_commit_id
    || feedbackResult.commit_hash !== root.commit.commit_hash
    || feedbackResult.commit_uri !== buildAionisUri({
      tenant_id: requiredString(event, "tenant_id"),
      scope: requiredString(event, "scope"),
      type: "commit",
      id: requiredString(root.commit, "id"),
    })
    || feedbackResult.decision_id !== root.decision.id
    || feedbackResult.decision_uri !== buildAionisUri({
      tenant_id: requiredString(event, "tenant_id"),
      scope: requiredString(event, "scope"),
      type: "decision",
      id: requiredString(root.decision, "id"),
    })
    || feedbackResult.decision_link_mode !== root.feedback.decision_link_mode
    || feedbackResult.decision_policy_sha256 !== root.decision.policy_sha256
    || feedbackResult.updated_rules !== rootedRuleNodeIds.length
    || stableStringify(responseRuleNodeIds) !== stableStringify(rootedRuleNodeIds)
    || !responseRoutes.includes("/v1/feedback")
    || !responseSurfaces.includes("learning_episode_feedback_attribution")) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_operation_receipt_binding");
  }

  const rootedFeedbackRows = db.prepare(
    `SELECT rule_node_id, run_id, outcome, source, decision_id, commit_id
     FROM lite_memory_rule_feedback
     WHERE scope = ? AND decision_id = ? AND commit_id = ?
     ORDER BY rule_node_id, id`,
  ).all(root.commit.scope, root.decision.id, event.source_commit_id) as Row[];
  if (rootedFeedbackRows.length !== rootedRuleNodeIds.length
    || rootedFeedbackRows.some((row) => row.run_id !== payload.run_id
      || row.outcome !== root.attribution.outcome
      || row.source !== "tools_feedback"
      || row.decision_id !== root.decision.id
      || row.commit_id !== event.source_commit_id)
    || stableStringify(rootedFeedbackRows.map((row) => row.rule_node_id).sort())
      !== stableStringify([...rootedRuleNodeIds].sort())) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_rule_feedback_root");
  }

  const decisionRowidCutoff = payload.run_lifecycle_decision_rowid_cutoff;
  const feedbackRowidCutoff = payload.run_lifecycle_feedback_rowid_cutoff;
  if (!Number.isSafeInteger(decisionRowidCutoff) || Number(decisionRowidCutoff) < 1
    || !Number.isSafeInteger(feedbackRowidCutoff) || Number(feedbackRowidCutoff) < 0) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_operation_receipt_run_cutoff");
  }
  const decisionStats = db.prepare(
    `SELECT COUNT(*) AS count, MAX(created_at) AS latest_created_at,
            COALESCE(MAX(rowid), 0) AS rowid_cutoff
     FROM lite_memory_execution_decisions
     WHERE scope = ? AND run_id = ? AND rowid <= ?`,
  ).get(root.commit.scope, payload.run_id, decisionRowidCutoff) as Row;
  const decisionRows = db.prepare(
    `SELECT id, decision_kind, run_id, selected_tool, candidates_json,
            context_sha256, policy_sha256, source_rule_ids_json, metadata_json,
            commit_id, created_at
     FROM lite_memory_execution_decisions
     WHERE scope = ? AND run_id = ? AND rowid <= ?
     ORDER BY created_at DESC, id DESC
     LIMIT 10`,
  ).all(root.commit.scope, payload.run_id, decisionRowidCutoff) as Row[];
  const responseDecisions = runLifecycle.decisions;
  if (!Array.isArray(responseDecisions)
    || responseDecisions.length !== decisionRows.length) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_operation_receipt_decisions");
  }
  for (let index = 0; index < decisionRows.length; index += 1) {
    const decisionRow = decisionRows[index]!;
    const responseDecision = exactObject(
      responseDecisions[index],
      [
        "decision_id", "decision_uri", "decision_kind", "run_id", "selected_tool",
        "candidates", "context_sha256", "policy_sha256", "source_rule_ids", "metadata",
        "created_at", "commit_id", "commit_uri",
      ],
      "tool_feedback_operation_receipt_decision",
    );
    const decisionId = requiredString(decisionRow, "id");
    const decisionCandidates = parseJson(
      requiredString(decisionRow, "candidates_json"),
      "tool_feedback_operation_receipt_decision_candidates",
    );
    const decisionSourceRules = parseJson(
      requiredString(decisionRow, "source_rule_ids_json"),
      "tool_feedback_operation_receipt_decision_rules",
    );
    const decisionMetadata = parseJson(
      requiredString(decisionRow, "metadata_json"),
      "tool_feedback_operation_receipt_decision_metadata",
    );
    const historicalFeedback = db.prepare(
      `SELECT feedback.source_commit_id
       FROM lite_learning_feedback_attributions AS attribution
       JOIN lite_learning_episode_events AS feedback
         ON feedback.tenant_id = attribution.tenant_id
        AND feedback.scope = attribution.scope
        AND feedback.event_id = attribution.event_id
       WHERE attribution.tenant_id = ? AND attribution.scope = ?
         AND attribution.subject_kind = 'tool_decision'
         AND attribution.subject_id = ?
         AND feedback.row_id <= ?
       ORDER BY feedback.row_id DESC
       LIMIT 1`,
    ).get(
      event.tenant_id,
      event.scope,
      decisionId,
      event.row_id,
    ) as Row | undefined;
    const receiptCommitId = responseDecision.commit_id;
    const receiptCommitUri = responseDecision.commit_uri;
    if (responseDecision.decision_id !== decisionId
      || responseDecision.decision_uri !== buildAionisUri({
        tenant_id: requiredString(event, "tenant_id"),
        scope: requiredString(event, "scope"),
        type: "decision",
        id: decisionId,
      })
      || responseDecision.decision_kind !== decisionRow.decision_kind
      || responseDecision.run_id !== decisionRow.run_id
      || responseDecision.selected_tool !== decisionRow.selected_tool
      || stableStringify(responseDecision.candidates) !== stableStringify(decisionCandidates)
      || responseDecision.context_sha256 !== decisionRow.context_sha256
      || responseDecision.policy_sha256 !== decisionRow.policy_sha256
      || stableStringify(responseDecision.source_rule_ids) !== stableStringify(decisionSourceRules)
      || stableStringify(responseDecision.metadata) !== stableStringify(decisionMetadata)
      || responseDecision.created_at !== decisionRow.created_at
      || (historicalFeedback && receiptCommitId !== historicalFeedback.source_commit_id)
      || (receiptCommitId === null ? receiptCommitUri !== null : (
        typeof receiptCommitId !== "string"
        || receiptCommitUri !== buildAionisUri({
          tenant_id: requiredString(event, "tenant_id"),
          scope: requiredString(event, "scope"),
          type: "commit",
          id: receiptCommitId,
        })
      ))) {
      throw new Error("lite_learning_integrity_failed:tool_feedback_operation_receipt_decision_binding");
    }
    if (typeof receiptCommitId === "string") {
      const receiptCommit = db.prepare(
        "SELECT 1 AS present FROM lite_memory_commits WHERE id = ? AND scope = ?",
      ).get(receiptCommitId, root.commit.scope) as Row | undefined;
      if (!receiptCommit) {
        throw new Error("lite_learning_integrity_failed:tool_feedback_operation_receipt_decision_commit");
      }
    }
  }

  const feedbackStats = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN outcome = 'positive' THEN 1 ELSE 0 END) AS positive,
            SUM(CASE WHEN outcome = 'negative' THEN 1 ELSE 0 END) AS negative,
            SUM(CASE WHEN outcome = 'neutral' THEN 1 ELSE 0 END) AS neutral,
            SUM(CASE WHEN decision_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_decision_count,
            SUM(CASE WHEN source = 'tools_feedback' THEN 1 ELSE 0 END) AS tools_feedback_count,
            MAX(created_at) AS latest_feedback_at,
            COALESCE(MAX(rowid), 0) AS rowid_cutoff
     FROM lite_memory_rule_feedback
     WHERE scope = ? AND run_id = ? AND rowid <= ?`,
  ).get(root.commit.scope, payload.run_id, feedbackRowidCutoff) as Row;
  const recentFeedback = db.prepare(
    `SELECT id, scope, rule_node_id, run_id, outcome, note, source,
            decision_id, commit_id, created_at
     FROM lite_memory_rule_feedback
     WHERE scope = ? AND run_id = ? AND rowid <= ?
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
  ).all(root.commit.scope, payload.run_id, feedbackRowidCutoff) as Row[];
  const lifecycle = requiredObject(
    runLifecycle.lifecycle,
    "tool_feedback_operation_receipt_lifecycle",
  );
  const responseFeedback = requiredObject(
    runLifecycle.feedback,
    "tool_feedback_operation_receipt_run_feedback",
  );
  const responseByOutcome = requiredObject(
    responseFeedback.by_outcome,
    "tool_feedback_operation_receipt_run_feedback_outcome",
  );
  const decisionCount = Number(decisionStats.count ?? 0);
  const feedbackTotal = Number(feedbackStats.total ?? 0);
  const positive = Number(feedbackStats.positive ?? 0);
  const negative = Number(feedbackStats.negative ?? 0);
  const neutral = Number(feedbackStats.neutral ?? 0);
  const linkedDecisionCount = Number(feedbackStats.linked_decision_count ?? 0);
  const toolsFeedbackCount = Number(feedbackStats.tools_feedback_count ?? 0);
  const lifecycleStatus = feedbackTotal > 0 ? "feedback_linked" : "decision_recorded";
  if (runLifecycle.tenant_id !== event.tenant_id
    || runLifecycle.scope !== event.scope
    || runLifecycle.run_id !== payload.run_id
    || lifecycle.status !== lifecycleStatus
    || lifecycle.decision_count !== decisionCount
    || lifecycle.latest_decision_at !== (decisionStats.latest_created_at ?? null)
    || Number(decisionStats.rowid_cutoff) !== decisionRowidCutoff
    || lifecycle.latest_feedback_at !== (feedbackStats.latest_feedback_at ?? null)
    || responseFeedback.total !== feedbackTotal
    || responseByOutcome.positive !== positive
    || responseByOutcome.negative !== negative
    || responseByOutcome.neutral !== neutral
    || positive + negative + neutral !== feedbackTotal
    || responseFeedback.linked_decision_count !== linkedDecisionCount
    || responseFeedback.tools_feedback_count !== toolsFeedbackCount
    || Number(feedbackStats.rowid_cutoff) !== feedbackRowidCutoff
    || stableStringify(responseFeedback.recent) !== stableStringify(recentFeedback)) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_operation_receipt_run_binding");
  }
  const expectedLifecycleSummary = buildToolsRunLifecycleSummary({
    run_id: payload.run_id,
    lifecycle: {
      status: lifecycleStatus,
      decision_count: decisionCount,
      latest_decision_at: decisionStats.latest_created_at as string | null,
      latest_feedback_at: feedbackStats.latest_feedback_at as string | null,
    },
    decisions: responseDecisions,
    feedback: responseFeedback,
  });
  if (stableStringify(runLifecycle.lifecycle_summary) !== stableStringify(expectedLifecycleSummary)) {
    throw new Error("lite_learning_integrity_failed:tool_feedback_operation_receipt_run_summary");
  }
}

export function resolveLiteLearningProtectedPositiveToolFeedbackAuthority(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    guideTraceId: string;
    runId: string;
    expectedDecisionId: string | null;
    expectedEventId?: string | null;
    expectedEventSha256?: string | null;
    expectedOperationId?: string | null;
    expectedOperationReceiptSha256?: string | null;
  }>,
): LiteLearningProtectedToolFeedbackAuthorityResolution {
  const rows = db.prepare(
    `SELECT feedback.*
     FROM lite_learning_episode_events AS feedback
     WHERE feedback.tenant_id = ? AND feedback.scope = ? AND feedback.episode_id = ?
       AND feedback.event_kind = 'feedback_attributed'
       AND json_extract(feedback.payload_json, '$.feedback_kind') = 'tool_selection'
       AND NOT EXISTS (
         SELECT 1 FROM lite_learning_episode_events AS replacement
         WHERE replacement.tenant_id = feedback.tenant_id
           AND replacement.scope = feedback.scope
           AND replacement.supersedes_event_id = feedback.event_id
       )
     ORDER BY feedback.episode_sequence, feedback.event_id`,
  ).all(args.tenantId, args.scope, args.episodeId) as Row[];
  if (rows.length === 0) return { status: "unavailable", reasonCode: "feedback_missing" };

  const candidates = rows.map((event) => {
    const canonicalEvent = LearningEpisodeEventWithoutDigestSchema.parse({
      contract_version: "aionis_learning_episode_event_v1",
      tenant_id: event.tenant_id,
      scope: event.scope,
      event_id: event.event_id,
      episode_id: event.episode_id,
      episode_sequence: event.episode_sequence,
      event_kind: event.event_kind,
      source_kind: event.source_kind,
      source_id: event.source_id,
      source_sha256: event.source_sha256,
      previous_event_sha256: event.previous_event_sha256,
      payload_sha256: event.payload_sha256,
      item_set_sha256: event.item_set_sha256,
      source_commit_id: event.source_commit_id,
      supersedes_event_id: event.supersedes_event_id,
      operation_id: event.operation_id,
      run_id: event.run_id,
      collection_class: event.collection_class,
      recorded_at: event.recorded_at,
    });
    const payload = FeedbackAttributedV1Schema.parse(parseCanonical(
      requiredString(event, "payload_json"),
      "measurement_tool_feedback_payload",
    ));
    if (event.event_sha256 !== learningEpisodeEventDigest(canonicalEvent)
      || canonicalEvent.payload_sha256 !== sha256Hex(requiredString(event, "payload_json"))) {
      throw new Error("lite_learning_integrity_failed:measurement_tool_feedback_event_digest");
    }
    assertFeedbackOperationBinding(canonicalEvent, payload);
    const predecessor = canonicalEvent.episode_sequence > 1
      ? db.prepare(
        `SELECT event_sha256 FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND episode_id = ? AND episode_sequence = ?`,
      ).get(
        canonicalEvent.tenant_id,
        canonicalEvent.scope,
        canonicalEvent.episode_id,
        canonicalEvent.episode_sequence - 1,
      ) as Row | undefined
      : undefined;
    if (canonicalEvent.episode_sequence <= 1
      || !predecessor
      || predecessor.event_sha256 !== canonicalEvent.previous_event_sha256) {
      throw new Error("lite_learning_integrity_failed:measurement_tool_feedback_chain");
    }
    const attributions = db.prepare(
      `SELECT * FROM lite_learning_feedback_attributions
       WHERE tenant_id = ? AND scope = ? AND event_id = ?
       ORDER BY subject_kind, subject_id`,
    ).all(canonicalEvent.tenant_id, canonicalEvent.scope, canonicalEvent.event_id) as
      LiteLearningAuthorityRow[];
    if (attributions.length !== 1) {
      throw new Error("lite_learning_integrity_failed:measurement_tool_feedback_attribution_count");
    }
    for (const attribution of attributions) {
      if (attribution.tenant_id !== canonicalEvent.tenant_id
        || attribution.scope !== canonicalEvent.scope
        || attribution.event_id !== canonicalEvent.event_id
        || attribution.episode_id !== canonicalEvent.episode_id
        || attribution.item_sha256 !== learningFeedbackAttributionItemDigest(attribution)) {
        throw new Error("lite_learning_integrity_failed:measurement_tool_feedback_attribution_digest");
      }
    }
    if (canonicalEvent.item_set_sha256 !== learningFeedbackAttributionSetDigest(attributions)) {
      throw new Error("lite_learning_integrity_failed:measurement_tool_feedback_item_set_digest");
    }
    const { toolRoot } = assertLiteLearningFeedbackExposureProvenance(
      db,
      event,
      payload,
      attributions,
      null,
    );
    if (toolRoot === null) {
      throw new Error("lite_learning_integrity_failed:measurement_tool_feedback_root_missing");
    }
    return { event, payload, root: toolRoot };
  }).filter(({ payload, root }) =>
    payload.guide_trace_id === args.guideTraceId
    && payload.run_id === args.runId
    && (args.expectedDecisionId === null || root.attribution.subject_id === args.expectedDecisionId)
  ).filter(({ event, payload }) =>
    (args.expectedEventId == null || event.event_id === args.expectedEventId)
    && (args.expectedEventSha256 == null || event.event_sha256 === args.expectedEventSha256)
    && (args.expectedOperationId == null || event.operation_id === args.expectedOperationId)
    && (args.expectedOperationReceiptSha256 == null
      || payload.operation_receipt_sha256 === args.expectedOperationReceiptSha256)
  );
  if (candidates.length === 0) {
    return { status: "unavailable", reasonCode: "feedback_binding_mismatch" };
  }
  if (candidates.length !== 1) {
    return { status: "unavailable", reasonCode: "feedback_ambiguous" };
  }
  const candidate = candidates[0]!;
  if (candidate.root.attribution.outcome !== "positive") {
    return { status: "unavailable", reasonCode: "feedback_not_positive" };
  }
  if (candidate.payload.operation_protection !== "protected") {
    return { status: "unavailable", reasonCode: "feedback_operation_unprotected" };
  }
  assertProtectedToolFeedbackOperationReceipt({
    db,
    event: candidate.event,
    payload: candidate.payload,
    root: candidate.root,
  });
  return {
    status: "available",
    eventId: requiredString(candidate.event, "event_id"),
    eventSha256: requiredString(candidate.event, "event_sha256"),
    episodeId: args.episodeId,
    guideTraceId: args.guideTraceId,
    runId: args.runId,
    operationId: requiredString(candidate.event, "operation_id"),
    operationReceiptSha256: requiredString(candidate.payload, "operation_receipt_sha256"),
    decisionId: requiredString(candidate.root.attribution, "subject_id"),
    outcome: "positive",
    operationProtection: "protected",
    sourceCommitId: requiredString(candidate.event, "source_commit_id"),
    recordedAt: requiredString(candidate.event, "recorded_at"),
  };
}

function assertFeedbackAuthorityProvenance(db: SqliteDatabase): void {
  const feedbackEvents = db.prepare(
    `SELECT * FROM lite_learning_episode_events
     WHERE event_kind = 'feedback_attributed'
     ORDER BY tenant_id, scope, episode_id, episode_sequence`,
  ).all() as Row[];
  for (const event of feedbackEvents) {
    const payloadJson = requiredString(event, "payload_json");
    const payload = FeedbackAttributedV1Schema.parse(parseCanonical(
      payloadJson,
      "feedback_authority_payload",
    ));
    const { routeKind, protectedRoot, toolRoot } =
      assertLiteLearningFeedbackExposureProvenance(db, event, payload);
    if (payload.feedback_kind === "tool_selection") {
      if (toolRoot === null) {
        throw new Error("lite_learning_integrity_failed:tool_feedback_root_missing");
      }
      if (routeKind === "tool_selection") {
        assertProtectedToolFeedbackOperationReceipt({ db, event, payload, root: toolRoot });
      }
      continue;
    }
    const attributions = db.prepare(
      `SELECT attribution.*, item.served_action
       FROM lite_learning_feedback_attributions AS attribution
       LEFT JOIN lite_learning_exposure_items AS item
         ON item.tenant_id = attribution.tenant_id
        AND item.scope = attribution.scope
        AND item.episode_id = attribution.episode_id
        AND item.memory_id = attribution.subject_id
       WHERE attribution.tenant_id = ? AND attribution.scope = ?
         AND attribution.event_id = ? AND attribution.subject_kind = 'memory'
       ORDER BY attribution.subject_id`,
    ).all(event.tenant_id, event.scope, event.event_id) as Row[];
    for (const attribution of attributions) {
      const comparableSurface = attribution.used_surface === "explicit_host_assertion"
        ? "use_now"
        : attribution.used_surface;
      const expectedBoundary = attribution.served_action === comparableSurface
        ? "aligned"
        : "boundary_ignored";
      if (typeof attribution.served_action !== "string"
        || attribution.exposure_action !== attribution.served_action
        || attribution.boundary_outcome !== expectedBoundary
        || (attribution.evidence_class === "verified_host_receipt" && expectedBoundary !== "aligned")) {
        throw new Error("lite_learning_integrity_failed:feedback_served_surface_provenance");
      }
    }
    if (routeKind === "memory") {
      const operation = db.prepare(
        `SELECT request_sha256, receipt_json, commit_id
         FROM lite_runtime_write_operations
         WHERE tenant_id = ? AND scope = ? AND operation_kind = 'product_feedback_v1'
           AND operation_id = ?`,
      ).get(event.tenant_id, event.scope, event.operation_id) as Row | undefined;
      const operationReceiptJson = operation
        ? requiredString(operation, "receipt_json")
        : null;
      if (!operation
        || operation.request_sha256 !== payload.request_sha256
        || operation.commit_id !== event.source_commit_id
        || operationReceiptJson === null
        || sha256Hex(operationReceiptJson) !== payload.operation_receipt_sha256) {
        throw new Error("lite_learning_integrity_failed:feedback_operation_receipt");
      }
      const result = parseCanonical(
        operationReceiptJson,
        "feedback_operation_receipt",
      ) as Row;
      const body = result.body as Row | undefined;
      const mutation = body?.result as Row | undefined;
      const activated = mutation?.activated as Row | undefined;
      const effect = body?.forget_effect as Row | undefined;
      const responseAttribution = effect?.attribution as Row | undefined;
      const commit = db.prepare(
        "SELECT commit_hash FROM lite_memory_commits WHERE id = ?",
      ).get(event.source_commit_id) as Row | undefined;
      const expectedStatus = payload.host_use_receipt_sha256 === null
        ? "legacy_unverified"
        : "verified_host_receipt";
      if (result.ok !== true
        || result.statusCode !== 200
        || !body
        || body.operation_id !== event.operation_id
        || body.tenant_id !== event.tenant_id
        || body.scope !== event.scope
        || body.learning_episode_id !== event.episode_id
        || body.learning_feedback_event_id !== event.event_id
        || body.learning_attribution_status !== expectedStatus
        || body.operation !== "activate"
        || body.target !== "memory"
        || !mutation || mutation.commit_id !== event.source_commit_id
        || !commit || mutation.commit_hash !== commit.commit_hash
        || !activated
        || activated.guide_trace_id !== payload.guide_trace_id
        || activated.learning_episode_id !== event.episode_id
        || activated.feedback_operation_id !== event.operation_id
        || activated.outcome !== attributions[0]?.outcome
        || !effect || Number(effect.changed_count) !== attributions.length
        || !responseAttribution
        || responseAttribution.learning_episode_id !== event.episode_id
        || responseAttribution.run_id !== payload.run_id
        || responseAttribution.outcome !== attributions[0]?.outcome
        || responseAttribution.used_surface !== attributions[0]?.used_surface) {
        throw new Error("lite_learning_integrity_failed:feedback_operation_receipt_binding");
      }
      if (payload.learning_control_queue_contract === "unused_exposure_learning_control_v1") {
        const guideTrace = effect.guide_trace as Row | undefined;
        const learningControl = exactObject(
          guideTrace?.feedback_learning_control,
          ["learning_control_status"],
          "feedback_operation_receipt_learning_control",
        );
        if (learningControl.learning_control_status !== "queued") {
          throw new Error("lite_learning_integrity_failed:feedback_operation_receipt_learning_control_status");
        }
      }
      sameStringSet(activated.updated_ids, attributions.map((row) => requiredString(row, "subject_id")),
        "feedback_operation_receipt_updated_subjects");
      sameStringSet(effect.affected_memory_ids, attributions.map((row) => requiredString(row, "subject_id")),
        "feedback_operation_receipt_effect_subjects");
      const responseAttributions = activated.feedback_attributions;
      if (!Array.isArray(responseAttributions)
        || responseAttributions.length !== attributions.length
        || protectedRoot === null) {
        throw new Error("lite_learning_integrity_failed:feedback_operation_receipt_attributions");
      }
      const attributionBySubject = new Map(attributions.map((attribution) => [
        requiredString(attribution, "subject_id"),
        attribution,
      ]));
      const seenResponseSubjects = new Set<string>();
      for (const rawResponseAttribution of responseAttributions) {
        const receiptAttribution = exactObject(
          rawResponseAttribution,
          [
            "memory_id", "guide_trace_id", "learning_episode_id", "feedback_operation_id",
            "run_id", "outcome", "used_surface", "verifier_status", "tool_status",
            "runtime_signal_refs", "attribution_strength", "boundary_outcome",
            "feedback_positive", "feedback_negative", "weak_counter_signal_count",
            "strong_counter_signal_count",
          ],
          "feedback_operation_receipt_attribution",
        );
        const memoryId = requiredString(receiptAttribution, "memory_id");
        const attribution = attributionBySubject.get(memoryId);
        if (!attribution || seenResponseSubjects.has(memoryId)
          || receiptAttribution.guide_trace_id !== payload.guide_trace_id
          || receiptAttribution.learning_episode_id !== event.episode_id
          || receiptAttribution.feedback_operation_id !== event.operation_id
          || receiptAttribution.run_id !== payload.run_id
          || receiptAttribution.outcome !== attribution.outcome
          || receiptAttribution.used_surface !== attribution.used_surface
          || receiptAttribution.verifier_status !== protectedRoot.feedback.verifier_status
          || receiptAttribution.tool_status !== attribution.tool_status
          || stableStringify(receiptAttribution.runtime_signal_refs) !== stableStringify(payload.runtime_signal_refs)
          || receiptAttribution.attribution_strength !== attribution.attribution_strength
          || receiptAttribution.attribution_strength !== protectedRoot.expectedAttributionStrength
          || receiptAttribution.boundary_outcome !== attribution.boundary_outcome) {
          throw new Error("lite_learning_integrity_failed:feedback_operation_receipt_attribution_binding");
        }
        seenResponseSubjects.add(memoryId);
        for (const counter of [
          "feedback_positive", "feedback_negative", "weak_counter_signal_count", "strong_counter_signal_count",
        ] as const) {
          nonNegativeInteger(receiptAttribution[counter], `feedback_operation_receipt_attribution_${counter}`);
        }
      }
      if (seenResponseSubjects.size !== attributions.length) {
        throw new Error("lite_learning_integrity_failed:feedback_operation_receipt_attribution_membership");
      }
    }
  }
}

export function assertLiteLearningSafetyStopBundlesIntegrity(db: SqliteDatabase): void {
  assertFeedbackAuthorityProvenance(db);
  const decisions = db.prepare(
    `SELECT * FROM lite_learning_gate_decisions
     WHERE decision_kind = 'safety_stop'
     ORDER BY tenant_id, decision_id`,
  ).all() as Row[];
  for (const decision of decisions) {
    const authorizationJson = requiredString(decision, "authorization_payload_json");
    const authorization = LearningSafetyStopAuthorizationV1Schema.parse(
      parseCanonical(authorizationJson, "safety_stop_authorization"),
    );
    const authorizationSha256 = learningSafetyStopAuthorizationDigest(authorization);
    const expectedStopPolicySha256 = authorization.trigger_ref_kind === "control_job"
      ? LEARNING_SAFETY_STOP_POLICY_V2_SHA256
      : LEARNING_SAFETY_STOP_POLICY_SHA256;
    if (authorizationSha256 !== decision.authorization_sha256
      || decision.decision_sha256 !== decisionDigest(decision)
      || authorization.stop_policy_sha256 !== expectedStopPolicySha256) {
      throw new Error("lite_learning_integrity_failed:safety_stop_authorization_digest");
    }
    const expectedScope = learningSafetyAuthorityScope({
      taskFamily: authorization.task_family,
      evidenceScopeSetSha256: authorization.evidence_scope_set_sha256,
    });
    const expectedOperationId = learningSafetyAuthorityOperationId({
      triggerRefKind: authorization.trigger_ref_kind,
      triggerRefId: authorization.trigger_ref_id,
      authorityScope: expectedScope,
      candidatePolicyImplementationSha256: authorization.candidate_policy_implementation_sha256,
      stopPolicySha256: authorization.stop_policy_sha256,
    });
    const bindings = {
      tenant_id: authorization.tenant_id,
      task_family: authorization.task_family,
      candidate_policy_id: authorization.candidate_policy_id,
      candidate_policy_version: authorization.candidate_policy_version,
      candidate_policy_implementation_sha256: authorization.candidate_policy_implementation_sha256,
      experiment_id: authorization.experiment_id,
      experiment_revision: authorization.experiment_revision,
      gate_policy_id: authorization.gate_policy_id,
      gate_policy_version: authorization.gate_policy_version,
      experiment_config_sha256: authorization.experiment_config_sha256,
      evidence_scope_set_sha256: authorization.evidence_scope_set_sha256,
      trigger_ref_kind: authorization.trigger_ref_kind,
      trigger_ref_id: authorization.trigger_ref_id,
      trigger_episode_id: authorization.trigger_episode_id,
      source_commit_id: authorization.source_commit_id,
      authorization_kind: authorization.authorization_kind,
      authority_operation_scope: expectedScope,
      authority_operation_kind: authorization.authority_operation_kind,
      authority_operation_id: expectedOperationId,
      created_at: authorization.authorized_at,
    } as const;
    if (Object.entries(bindings).some(([field, expected]) => decision[field] !== expected)
      || decision.authority_action !== "pause"
      || decision.evidence_verdict !== "pause_required"
      || decision.authority_scope !== "task_family_candidate_implementation") {
      throw new Error("lite_learning_integrity_failed:safety_stop_authority_binding");
    }
    const summaryJson = requiredString(decision, "evidence_summary_json");
    const summary = parseCanonical(summaryJson, "safety_stop_summary") as Row;
    if (sha256Hex(summaryJson) !== decision.evidence_summary_sha256) {
      throw new Error("lite_learning_integrity_failed:safety_stop_summary_binding");
    }
    if (authorization.trigger_ref_kind === "episode_feedback") {
      const trigger = db.prepare(
        `SELECT row_id, event_sha256, episode_id, source_commit_id
         FROM lite_learning_episode_events
         WHERE tenant_id = ? AND event_id = ? AND event_kind = 'feedback_attributed'`,
      ).get(authorization.tenant_id, authorization.trigger_ref_id) as Row | undefined;
      const boundaryRows = trigger ? db.prepare(
        `SELECT subject_id FROM lite_learning_feedback_attributions
         WHERE tenant_id = ? AND event_id = ? AND boundary_outcome = 'boundary_ignored'
         ORDER BY subject_id`,
      ).all(authorization.tenant_id, authorization.trigger_ref_id) as Row[] : [];
      if (!trigger
        || trigger.event_sha256 !== authorization.trigger_sha256
        || trigger.episode_id !== authorization.trigger_episode_id
        || trigger.source_commit_id !== authorization.source_commit_id
        || Number(trigger.row_id) !== Number(decision.evidence_cutoff_event_row_id)
        || boundaryRows.length === 0) {
        throw new Error("lite_learning_integrity_failed:safety_stop_trigger_binding");
      }
      const boundaryIds = boundaryRows.map((row) => requiredString(row, "subject_id"));
      if (summary.contract_version !== "learning_boundary_safety_summary_v1"
        || summary.boundary_outcome !== "boundary_ignored"
        || stableStringify(summary.boundary_ignored_memory_ids) !== stableStringify(boundaryIds)
        || summary.trigger_ref_kind !== "episode_feedback"
        || summary.trigger_ref_id !== authorization.trigger_ref_id
        || summary.trigger_sha256 !== authorization.trigger_sha256
        || summary.stop_policy_sha256 !== authorization.stop_policy_sha256) {
        throw new Error("lite_learning_integrity_failed:safety_stop_summary_binding");
      }
    } else if (authorization.trigger_ref_kind === "control_job") {
      const job = db.prepare(
        `SELECT * FROM lite_learning_control_jobs
         WHERE tenant_id = ? AND job_id = ? AND status = 'dead_letter'`,
      ).get(authorization.tenant_id, authorization.trigger_ref_id) as Row | undefined;
      const feedback = job ? db.prepare(
        `SELECT row_id, episode_id, source_commit_id FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND event_id = ?
           AND event_kind = 'feedback_attributed'`,
      ).get(job.tenant_id, job.scope, job.source_feedback_event_id) as Row | undefined : undefined;
      const exposure = job ? db.prepare(
        `SELECT source_id, enrollment_state, candidate_policy_id, candidate_policy_version,
                experiment_id, experiment_revision
         FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND episode_id = ?
           AND event_kind = 'exposure_committed'`,
      ).get(job.tenant_id, job.scope, job.source_episode_id) as Row | undefined : undefined;
      const expectedTriggerSha256 = job ? learningControlDeadLetterTriggerSha256({
        tenantId: requiredString(job, "tenant_id"),
        scope: requiredString(job, "scope"),
        jobId: requiredString(job, "job_id"),
        sourceEpisodeId: requiredString(job, "source_episode_id"),
        sourceFeedbackEventId: requiredString(job, "source_feedback_event_id"),
        sourceCommitId: requiredString(job, "source_commit_id"),
        payloadSha256: requiredString(job, "payload_sha256"),
        attemptCount: nonNegativeInteger(job.attempt_count, "control_job_attempt_count"),
        lastErrorCode: requiredString(job, "last_error_code"),
      }) : null;
      if (!job || !feedback || !exposure
        || exposure.enrollment_state !== "enrolled"
        || feedback.episode_id !== job.source_episode_id
        || feedback.source_commit_id !== job.source_commit_id
        || exposure.candidate_policy_id !== authorization.candidate_policy_id
        || exposure.candidate_policy_version !== authorization.candidate_policy_version
        || exposure.experiment_id !== authorization.experiment_id
        || Number(exposure.experiment_revision) !== authorization.experiment_revision
        || authorization.trigger_episode_id !== job.source_episode_id
        || authorization.trigger_sha256 !== expectedTriggerSha256
        || authorization.source_commit_id !== job.source_commit_id
        || authorization.evidence_scope_set_sha256
          !== learningSafetyEvidenceScopeSetDigest([requiredString(job, "scope")])
        || Number(feedback.row_id) !== Number(decision.evidence_cutoff_event_row_id)
        || decision.evidence_cohort_sha256
          !== sha256Hex(stableStringify([job.job_id, job.payload_sha256]))) {
        throw new Error("lite_learning_integrity_failed:safety_stop_control_job_binding");
      }
      if (summary.contract_version !== "learning_control_dead_letter_safety_summary_v1"
        || summary.job_id !== job.job_id
        || summary.source_episode_id !== job.source_episode_id
        || summary.source_feedback_event_id !== job.source_feedback_event_id
        || summary.source_commit_id !== job.source_commit_id
        || summary.payload_sha256 !== job.payload_sha256
        || Number(summary.attempt_count) !== Number(job.attempt_count)
        || summary.last_error_code !== job.last_error_code
        || summary.trigger_ref_kind !== "control_job"
        || summary.trigger_ref_id !== job.job_id
        || summary.trigger_sha256 !== expectedTriggerSha256
        || summary.stop_policy_sha256 !== authorization.stop_policy_sha256) {
        throw new Error("lite_learning_integrity_failed:safety_stop_summary_binding");
      }
    } else {
      throw new Error("lite_learning_integrity_failed:safety_stop_trigger_kind_unsupported");
    }
    const revision = db.prepare(
      `SELECT config_sha256, candidate_policy_id, candidate_policy_version,
              candidate_policy_implementation_sha256, candidate_policy_config_sha256,
              gate_policy_id, gate_policy_version, gate_policy_config_sha256
       FROM lite_learning_experiment_revisions
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(
      authorization.tenant_id,
      authorization.experiment_id,
      authorization.experiment_revision,
    ) as Row | undefined;
    if (!revision
      || revision.config_sha256 !== authorization.experiment_config_sha256
      || revision.candidate_policy_id !== authorization.candidate_policy_id
      || revision.candidate_policy_version !== authorization.candidate_policy_version
      || revision.candidate_policy_implementation_sha256 !== authorization.candidate_policy_implementation_sha256
      || revision.candidate_policy_config_sha256 !== authorization.candidate_policy_config_sha256
      || revision.gate_policy_id !== authorization.gate_policy_id
      || revision.gate_policy_version !== authorization.gate_policy_version
      || revision.gate_policy_config_sha256 !== authorization.gate_policy_config_sha256) {
      throw new Error("lite_learning_integrity_failed:safety_stop_revision_binding");
    }
    const operation = db.prepare(
      `SELECT request_sha256, receipt_json, commit_id
       FROM lite_runtime_write_operations
       WHERE tenant_id = ? AND scope = ? AND operation_kind = 'learning_gate_authority_v1'
         AND operation_id = ?`,
    ).get(authorization.tenant_id, expectedScope, expectedOperationId) as Row | undefined;
    if (!operation
      || operation.request_sha256 !== authorizationSha256
      || operation.commit_id !== authorization.source_commit_id) {
      throw new Error("lite_learning_integrity_failed:safety_stop_operation_receipt");
    }
    const receipt = LearningSafetyStopOperationReceiptV1Schema.parse(parseCanonical(
      requiredString(operation, "receipt_json"),
      "safety_stop_receipt",
    ));
    if (receipt.tenant_id !== authorization.tenant_id
      || receipt.authority_scope !== expectedScope
      || receipt.operation_id !== expectedOperationId
      || receipt.request_sha256 !== authorizationSha256
      || receipt.decision_id !== decision.decision_id
      || receipt.decision_sha256 !== decision.decision_sha256
      || receipt.trigger_ref_kind !== authorization.trigger_ref_kind
      || receipt.trigger_ref_id !== authorization.trigger_ref_id
      || receipt.trigger_episode_id !== authorization.trigger_episode_id
      || receipt.trigger_sha256 !== authorization.trigger_sha256
      || receipt.candidate_policy_implementation_sha256 !== authorization.candidate_policy_implementation_sha256
      || receipt.stop_policy_sha256 !== authorization.stop_policy_sha256
      || receipt.source_commit_id !== authorization.source_commit_id) {
      throw new Error("lite_learning_integrity_failed:safety_stop_receipt_binding");
    }
  }
  const enrolledDeadLettersWithoutOneStop = db.prepare(
    `SELECT COUNT(*) AS count
     FROM lite_learning_control_jobs AS job
     WHERE job.status = 'dead_letter'
       AND EXISTS (
         SELECT 1 FROM lite_learning_episode_events AS exposure
         WHERE exposure.tenant_id = job.tenant_id AND exposure.scope = job.scope
           AND exposure.episode_id = job.source_episode_id
           AND exposure.event_kind = 'exposure_committed'
           AND exposure.enrollment_state = 'enrolled'
       )
       AND (
         SELECT COUNT(*) FROM lite_learning_gate_decisions AS decision
         WHERE decision.tenant_id = job.tenant_id
           AND decision.decision_kind = 'safety_stop'
           AND decision.trigger_ref_kind = 'control_job'
           AND decision.trigger_ref_id = job.job_id
       ) <> 1`,
  ).get() as { count: number };
  if (Number(enrolledDeadLettersWithoutOneStop.count) !== 0) {
    throw new Error("lite_learning_integrity_failed:enrolled_control_dead_letter_safety_stop_missing");
  }
  const orphans = db.prepare(
    `SELECT COUNT(*) AS count FROM lite_runtime_write_operations AS operation
     WHERE operation.operation_kind = 'learning_gate_authority_v1'
       AND NOT EXISTS (
         SELECT 1 FROM lite_learning_gate_decisions AS decision
         WHERE decision.tenant_id = operation.tenant_id
           AND decision.authority_operation_scope = operation.scope
           AND decision.authority_operation_kind = operation.operation_kind
           AND decision.authority_operation_id = operation.operation_id
       )`,
  ).get() as { count: number };
  if (Number(orphans.count) !== 0) {
    throw new Error("lite_learning_integrity_failed:orphan_gate_authority_receipt");
  }
}
