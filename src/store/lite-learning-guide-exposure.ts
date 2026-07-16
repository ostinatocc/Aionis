import stableStringify from "fast-json-stable-stringify";

import {
  LearningEpisodeEventWithoutDigestSchema,
  LearningEpisodePayloadV1Schema,
  LearningLedgerItemSchema,
  isLearningExposurePromotionEligible,
  learningEpisodeEventDigest,
  learningEpisodeTrackSummary,
  resolveLearningExposureAssignmentMode,
  type EventWithoutDigest,
  type ExposureCommittedV1,
  type LearningLedgerItem,
} from "../memory/learning-episode-ledger.js";
import { sha256Hex } from "../util/crypto.js";
import {
  LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
} from "./lite-learning-episode-ledger.js";
import type { LiteLearningAuthorityRow } from "./lite-learning-confirmatory-authority.js";

export type LiteGuideExposureExperimentBinding = Readonly<{
  profileId: string;
  experimentId: string;
  experimentRevision: number;
  enrollmentState: "enrolled" | "not_enrolled";
  servingPhase: "aa" | "shadow" | "active_control";
  candidatePolicyId: string;
  candidatePolicyVersion: string;
}>;

export function buildLiteGuideExposureEventRow(args: {
  event: EventWithoutDigest;
  payload: ExposureCommittedV1;
  exposureItems: readonly LearningLedgerItem[];
  experiment: LiteGuideExposureExperimentBinding | null;
}): LiteLearningAuthorityRow {
  const event = LearningEpisodeEventWithoutDigestSchema.parse(args.event);
  const payload = LearningEpisodePayloadV1Schema.parse(args.payload) as ExposureCommittedV1;
  const items = args.exposureItems.map((item) => LearningLedgerItemSchema.parse(item));
  const payloadJson = stableStringify(payload);
  if (event.event_kind !== "exposure_committed"
    || payload.contract_version !== "aionis_learning_exposure_v1") {
    throw new Error("guide exposure row builder accepts exposure events only");
  }
  const row = Object.fromEntries(
    LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_episode_events
      .filter((column) => column !== "row_id")
      .map((column) => [column, null]),
  ) as LiteLearningAuthorityRow;
  const envelope = payload.host_task_envelope;
  const assignmentMode = resolveLearningExposureAssignmentMode(payload);
  const hasLegacyItems = items.some((item) => item.decision_completeness === "legacy_served_only");
  const policyAffected = items.some((item) => item.decision_completeness === "complete"
    && item.served_action !== item.recorded_action);
  const predecisionTrack = hasLegacyItems
    ? "unclassified"
    : learningEpisodeTrackSummary(items.map((item) => ({
      policy_affected: item.decision_completeness === "complete"
        && item.served_action !== item.recorded_action,
      learning_track: item.learning_track,
    })));
  Object.assign(row, {
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
    event_sha256: learningEpisodeEventDigest(event),
    payload_sha256: event.payload_sha256,
    payload_json: payloadJson,
    item_set_sha256: event.item_set_sha256,
    source_commit_id: event.source_commit_id,
    supersedes_event_id: event.supersedes_event_id,
    operation_id: event.operation_id,
    run_id: event.run_id,
    collection_class: event.collection_class,
    collection_principal_sha256: payload.collection_principal_sha256,
    collector_id: payload.collector_id,
    collector_version: payload.collector_version,
    host_task_id: payload.host_task_id,
    host_source_task_sha256: envelope?.source_task_sha256 ?? null,
    host_source_event_sha256: envelope?.source_event_sha256 ?? null,
    host_task_envelope_created_at: envelope?.created_at ?? null,
    host_task_envelope_sha256: payload.host_task_envelope_sha256,
    task_family: envelope?.task_family ?? null,
    task_signature_sha256: envelope ? sha256Hex(envelope.task_signature) : null,
    repo_signature_sha256: envelope ? sha256Hex(envelope.repository_signature) : null,
    memory_namespace_sha256: payload.memory_namespace_sha256,
    namespace_set_sha256: payload.namespace_set_sha256,
    namespace_lease_id: payload.namespace_lease_id,
    namespace_lease_generation: payload.namespace_lease_generation,
    profile_id: args.experiment?.profileId ?? null,
    experiment_id: args.experiment?.experimentId ?? null,
    experiment_revision: args.experiment?.experimentRevision ?? null,
    enrollment_state: args.experiment?.enrollmentState ?? "not_enrolled",
    serving_phase: args.experiment?.servingPhase
      ?? (payload.served_arm === "candidate" ? "fixed_active" : "off"),
    evidence_intent: payload.evidence_intent,
    assignment_mode: assignmentMode,
    assignment_unit_sha256: payload.memory_namespace_sha256 === null
      ? null
      : sha256Hex(stableStringify({
        tenant_id: event.tenant_id,
        memory_namespace_sha256: payload.memory_namespace_sha256,
      })),
    assignment_namespace_sha256: payload.assignment_namespace_sha256,
    assignment_bucket: payload.assignment_bucket,
    randomization_pair_sha256: payload.randomization_pair_sha256,
    matching_covariate_sha256: payload.matching_covariate_sha256,
    pair_member_ordinal: payload.pair_member_ordinal,
    activation_wave_index: payload.activation_wave_index,
    activation_starts_at: payload.activation_starts_at,
    index_window_ends_at: payload.index_window_ends_at,
    wave_analysis_at: payload.wave_analysis_at,
    assignment_arm: payload.assignment_arm,
    served_arm: payload.served_arm,
    candidate_policy_id: args.experiment?.candidatePolicyId ?? null,
    candidate_policy_version: args.experiment?.candidatePolicyVersion ?? null,
    policy_affected: policyAffected ? 1 : 0,
    predecision_track: predecisionTrack,
    projection_complete: payload.projection_complete ? 1 : 0,
    promotion_eligible: isLearningExposurePromotionEligible(payload) ? 1 : 0,
    recorded_at: event.recorded_at,
  });
  return row;
}
