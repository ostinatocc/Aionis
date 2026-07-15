import stableStringify from "fast-json-stable-stringify";

import {
  LEARNING_SAFETY_STOP_POLICY_SHA256,
  LearningSafetyStopAuthorizationV1Schema,
  LearningSafetyStopOperationReceiptV1Schema,
  learningSafetyAuthorityOperationId,
  learningSafetyAuthorityScope,
  learningSafetyStopAuthorizationDigest,
} from "../memory/learning-safety-stop.js";
import { FeedbackAttributedV1Schema, type FeedbackAttributedV1 } from "../memory/learning-episode-ledger.js";
import {
  resolveNodeFeedbackAttributionStrength,
  type NodeFeedbackAttributionStrength,
  type NodeFeedbackOutcome,
  type NodeFeedbackToolStatus,
  type NodeFeedbackUsedSurface,
  type NodeFeedbackVerifierStatus,
} from "../memory/node-feedback-state.js";
import { sha256Hex } from "../util/crypto.js";
import { stableUuid } from "../util/uuid.js";
import type { SqliteDatabase } from "./sqlite.js";

type Row = Record<string, unknown>;

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

export function assertLiteLearningFeedbackExposureProvenance(
  db: SqliteDatabase,
  event: Row,
  payload: FeedbackAttributedV1,
  feedbackAttributions?: readonly Row[],
  feedbackHostUseReceipt?: Row | null,
): {
  routeBound: boolean;
  protectedRoot: ReturnType<typeof protectedFeedbackCommitRoot> | null;
} {
  const exposure = db.prepare(
    `SELECT * FROM lite_learning_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND event_kind = 'exposure_committed'`,
  ).get(event.tenant_id, event.scope, event.episode_id) as Row | undefined;
  const routeBound = payload.feedback_kind === "memory"
    && payload.operation_protection === "protected";
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
  if (routeBound) {
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
  return { routeBound, protectedRoot };
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
    const { routeBound, protectedRoot } = assertLiteLearningFeedbackExposureProvenance(db, event, payload);
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
    if (routeBound) {
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
    if (authorizationSha256 !== decision.authorization_sha256
      || decision.decision_sha256 !== decisionDigest(decision)
      || authorization.stop_policy_sha256 !== LEARNING_SAFETY_STOP_POLICY_SHA256) {
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
    const summaryJson = requiredString(decision, "evidence_summary_json");
    const summary = parseCanonical(summaryJson, "safety_stop_summary") as Row;
    const boundaryIds = boundaryRows.map((row) => requiredString(row, "subject_id"));
    if (sha256Hex(summaryJson) !== decision.evidence_summary_sha256
      || summary.contract_version !== "learning_boundary_safety_summary_v1"
      || summary.boundary_outcome !== "boundary_ignored"
      || stableStringify(summary.boundary_ignored_memory_ids) !== stableStringify(boundaryIds)
      || summary.trigger_ref_id !== authorization.trigger_ref_id
      || summary.trigger_sha256 !== authorization.trigger_sha256
      || summary.stop_policy_sha256 !== authorization.stop_policy_sha256) {
      throw new Error("lite_learning_integrity_failed:safety_stop_summary_binding");
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
