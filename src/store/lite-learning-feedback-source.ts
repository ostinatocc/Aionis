import stableStringify from "fast-json-stable-stringify";

import {
  ExposureCommittedV1Schema,
  LearningEpisodeEventWithoutDigestSchema,
  LearningLedgerItemSchema,
  learningEpisodeEventDigest,
  learningEpisodeId,
  learningItemSetDigest,
  type EventWithoutDigest,
  type ExposureCommittedV1,
  type LearningLedgerItem,
} from "../memory/learning-episode-ledger.js";
import { sha256Hex } from "../util/crypto.js";
import type { LiteLearningAuthorityRow } from "./lite-learning-confirmatory-authority.js";
import type { SqliteDatabase } from "./sqlite.js";

export type LiteLearningFeedbackSource = Readonly<{
  event: EventWithoutDigest;
  eventRow: LiteLearningAuthorityRow;
  payload: ExposureCommittedV1;
  items: readonly LearningLedgerItem[];
  headSequence: number;
  headEventSha256: string;
  safetyAuthority: Readonly<{
    taskFamily: string;
    candidatePolicyId: string;
    candidatePolicyVersion: string;
    candidatePolicyImplementationSha256: string;
    candidatePolicyConfigSha256: string;
    experimentId: string;
    experimentRevision: number;
    experimentConfigSha256: string;
    gatePolicyId: string;
    gatePolicyVersion: string;
    gatePolicyConfigSha256: string;
  }> | null;
}>;

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`learning feedback source has invalid ${field}`);
  }
  return value;
}

function nullableString(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`learning feedback source has invalid ${field}`);
  }
  return value;
}

function eventFromRow(row: Record<string, unknown>): EventWithoutDigest {
  return LearningEpisodeEventWithoutDigestSchema.parse({
    contract_version: "aionis_learning_episode_event_v1",
    tenant_id: row.tenant_id,
    scope: row.scope,
    event_id: row.event_id,
    episode_id: row.episode_id,
    episode_sequence: row.episode_sequence,
    event_kind: row.event_kind,
    source_kind: row.source_kind,
    source_id: row.source_id,
    source_sha256: row.source_sha256,
    previous_event_sha256: row.previous_event_sha256,
    payload_sha256: row.payload_sha256,
    item_set_sha256: row.item_set_sha256,
    source_commit_id: row.source_commit_id,
    supersedes_event_id: row.supersedes_event_id,
    operation_id: row.operation_id,
    run_id: row.run_id,
    collection_class: row.collection_class,
    recorded_at: row.recorded_at,
  });
}

function itemFromRow(row: Record<string, unknown>): LearningLedgerItem {
  return LearningLedgerItemSchema.parse({
    memory_id: row.memory_id,
    decision_completeness: row.decision_completeness,
    memory_type: row.memory_type,
    source_backend: row.source_backend,
    recorded_action: row.recorded_action,
    candidate_action: row.candidate_action,
    served_action: row.served_action,
    policy_changed: row.policy_changed === null ? null : Number(row.policy_changed) === 1,
    hard_boundary_preserved: row.hard_boundary_preserved === null
      ? null
      : Number(row.hard_boundary_preserved) === 1,
    prior_supported_use_count: row.prior_supported_use_count,
    prior_contradicted_use_count: row.prior_contradicted_use_count,
    prior_rehydrate_requested_count: row.prior_rehydrate_requested_count,
    prior_effect_state: row.prior_effect_state,
    repeated_negative_posture: row.repeated_negative_posture === null
      ? null
      : Number(row.repeated_negative_posture) === 1,
    learning_track: row.learning_track,
    track_reason: row.track_reason,
  });
}

function validateHistoricalLease(
  db: SqliteDatabase,
  event: EventWithoutDigest,
  row: Record<string, unknown>,
  payload: ExposureCommittedV1,
): void {
  if (payload.namespace_lease_id === null) {
    if (payload.assignment_algorithm === "matched_pair_csprng_bit_v1") {
      throw new Error("learning feedback source matched-pair exposure has no historical lease");
    }
    return;
  }
  const lease = db.prepare(
    `SELECT lease.*, pair_row.matching_covariate_sha256
     FROM lite_learning_namespace_leases AS lease
     JOIN lite_learning_randomization_pairs AS pair_row
       ON pair_row.tenant_id = lease.tenant_id
      AND pair_row.confirmatory_attempt_id = lease.confirmatory_attempt_id
      AND pair_row.randomization_pair_sha256 = lease.randomization_pair_sha256
     WHERE lease.tenant_id = ? AND lease.namespace_lease_id = ?`,
  ).get(event.tenant_id, payload.namespace_lease_id) as Record<string, unknown> | undefined;
  const bindings = {
    memory_namespace_sha256: payload.memory_namespace_sha256,
    namespace_set_sha256: payload.namespace_set_sha256,
    lease_generation: payload.namespace_lease_generation,
    experiment_id: row.experiment_id,
    experiment_revision: row.experiment_revision,
    randomization_pair_sha256: payload.randomization_pair_sha256,
    matching_covariate_sha256: payload.matching_covariate_sha256,
    pair_member_ordinal: payload.pair_member_ordinal,
    assigned_arm: payload.assignment_arm,
    activation_wave_index: payload.activation_wave_index,
    activation_starts_at: payload.activation_starts_at,
    index_window_ends_at: payload.index_window_ends_at,
    wave_analysis_at: payload.wave_analysis_at,
  } as const;
  if (!lease || Object.entries(bindings).some(([field, expected]) => lease[field] !== expected)) {
    throw new Error("learning feedback source historical namespace lease binding mismatch");
  }
  if (lease.status !== "active" && lease.status !== "released") {
    throw new Error("learning feedback source historical namespace lease status is invalid");
  }
  if (lease.status === "released"
    && (typeof lease.released_at !== "string" || lease.released_at < event.recorded_at)) {
    throw new Error("learning feedback source namespace lease predates its exposure");
  }
}

export function resolveLiteLearningFeedbackSource(
  db: SqliteDatabase,
  args: Readonly<{ tenantId: string; scope: string; guideTraceId: string }>,
): LiteLearningFeedbackSource | null {
  const episodeId = learningEpisodeId({
    tenantId: args.tenantId,
    scope: args.scope,
    guideTraceId: args.guideTraceId,
  });
  const eventRow = db.prepare(
    `SELECT * FROM lite_learning_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND event_kind = 'exposure_committed'`,
  ).get(args.tenantId, args.scope, episodeId) as LiteLearningAuthorityRow | undefined;
  if (!eventRow) return null;
  const event = eventFromRow(eventRow);
  if (event.source_id !== args.guideTraceId
    || event.event_kind !== "exposure_committed"
    || event.episode_sequence !== 1) {
    throw new Error("learning feedback source exposure identity mismatch");
  }
  if (eventRow.event_sha256 !== learningEpisodeEventDigest(event)) {
    throw new Error("learning feedback source exposure event digest mismatch");
  }
  const payloadJson = requiredString(eventRow, "payload_json");
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadJson);
  } catch {
    throw new Error("learning feedback source exposure payload is invalid JSON");
  }
  if (stableStringify(decoded) !== payloadJson || sha256Hex(payloadJson) !== event.payload_sha256) {
    throw new Error("learning feedback source exposure payload digest mismatch");
  }
  const payload = ExposureCommittedV1Schema.parse(decoded);
  if (payload.guide_trace_id !== args.guideTraceId) {
    throw new Error("learning feedback source guide identity mismatch");
  }
  const itemRows = db.prepare(
    `SELECT * FROM lite_learning_exposure_items
     WHERE tenant_id = ? AND scope = ? AND event_id = ?
     ORDER BY memory_id`,
  ).all(args.tenantId, args.scope, event.event_id) as Record<string, unknown>[];
  const items = itemRows.map((itemRow) => {
    const item = itemFromRow(itemRow);
    if (itemRow.item_sha256 !== sha256Hex(stableStringify(item))) {
      throw new Error(`learning feedback source exposure item digest mismatch: ${item.memory_id}`);
    }
    return item;
  });
  if (learningItemSetDigest(items) !== event.item_set_sha256) {
    throw new Error("learning feedback source exposure item-set mismatch");
  }
  validateHistoricalLease(db, event, eventRow, payload);
  const head = db.prepare(
    `SELECT episode_sequence, event_sha256 FROM lite_learning_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
     ORDER BY episode_sequence DESC LIMIT 1`,
  ).get(args.tenantId, args.scope, episodeId) as {
    episode_sequence: number;
    event_sha256: string;
  } | undefined;
  if (!head) throw new Error("learning feedback source episode head is missing");
  const candidatePolicyId = nullableString(eventRow, "candidate_policy_id");
  const candidatePolicyVersion = nullableString(eventRow, "candidate_policy_version");
  const candidatePolicy = candidatePolicyId && candidatePolicyVersion
    ? db.prepare(
      `SELECT implementation_contract_sha256, policy_config_sha256
       FROM lite_learning_policy_versions
       WHERE tenant_id = ? AND policy_kind = 'candidate'
         AND policy_id = ? AND policy_version = ?`,
    ).get(args.tenantId, candidatePolicyId, candidatePolicyVersion) as Record<string, unknown> | undefined
    : undefined;
  const gatePolicy = typeof eventRow.experiment_id === "string"
    && Number.isSafeInteger(Number(eventRow.experiment_revision))
    ? db.prepare(
      `SELECT revision.config_sha256 AS experiment_config_sha256,
              revision.gate_policy_id, revision.gate_policy_version,
              gate_policy.policy_config_sha256 AS gate_policy_config_sha256
       FROM lite_learning_experiment_revisions AS revision
       JOIN lite_learning_policy_versions AS gate_policy
         ON gate_policy.tenant_id = revision.tenant_id
        AND gate_policy.policy_kind = 'gate'
        AND gate_policy.policy_id = revision.gate_policy_id
        AND gate_policy.policy_version = revision.gate_policy_version
       WHERE revision.tenant_id = ? AND revision.experiment_id = ?
         AND revision.experiment_revision = ?`,
    ).get(args.tenantId, eventRow.experiment_id, eventRow.experiment_revision) as Record<string, unknown> | undefined
    : undefined;
  return {
    event,
    eventRow,
    payload,
    items,
    headSequence: Number(head.episode_sequence),
    headEventSha256: requiredString(head, "event_sha256"),
    safetyAuthority: candidatePolicy
      && gatePolicy
      && candidatePolicyId
      && candidatePolicyVersion
      && typeof eventRow.task_family === "string"
      && typeof eventRow.experiment_id === "string"
      && Number.isSafeInteger(Number(eventRow.experiment_revision))
      ? {
          taskFamily: eventRow.task_family,
          candidatePolicyId,
          candidatePolicyVersion,
          candidatePolicyImplementationSha256: requiredString(candidatePolicy, "implementation_contract_sha256"),
          candidatePolicyConfigSha256: requiredString(candidatePolicy, "policy_config_sha256"),
          experimentId: eventRow.experiment_id,
          experimentRevision: Number(eventRow.experiment_revision),
          experimentConfigSha256: requiredString(gatePolicy, "experiment_config_sha256"),
          gatePolicyId: requiredString(gatePolicy, "gate_policy_id"),
          gatePolicyVersion: requiredString(gatePolicy, "gate_policy_version"),
          gatePolicyConfigSha256: requiredString(gatePolicy, "gate_policy_config_sha256"),
        }
      : null,
  };
}
