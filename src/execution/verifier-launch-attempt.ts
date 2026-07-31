import stableStringify from "fast-json-stable-stringify";

import type {
  EpisodeVerifierRunnerStatus,
} from "./episode-verifier-runner.js";
import { sha256Hex } from "../util/crypto.js";

export type RuntimeEpisodeVerifierLaunchAttemptV1 = Readonly<{
  contract_version: "runtime_episode_verifier_launch_attempt_v1";
  tenant_id: string;
  scope: string;
  episode_id: string;
  verifier_invocation_id: string;
  launch_attempt_id: string;
  outcome_operation_id: string;
  attempt_ordinal: number;
  owner_instance_id: string;
  owner_process_id: number;
  invocation_sha256: string;
  invocation_authority_sha256: string;
  invocation_authority_channel_id: string;
  materialization_id: string;
  materialized_subject_root: string;
  materialized_scratch_root: string;
  source_content_digest: string;
  source_environment_digest: string;
  subject_identity_sha256: string;
  subject_view_content_digest: string;
  subject_view_environment_digest: string;
  verifier_definition_sha256: string;
  verifier_program_digest: string;
  verifier_config_digest: string;
  verifier_environment_digest: string;
  execution_pack_manifest_sha256: string;
  resolved_config_digest: string;
  resolved_environment_digest: string;
  prepared_at: string;
  prepared_sha256: string;
}>;

export type RuntimeEpisodeVerifierLaunchCommittedPayloadV1 = Readonly<{
  contract_version:
    "runtime_episode_verifier_launch_committed_payload_v1";
  event_kind: "launch_committed";
  prepared_sha256: string;
}>;

export type RuntimeEpisodeVerifierSpawnObservedPayloadV1 = Readonly<{
  contract_version:
    "runtime_episode_verifier_spawn_observed_payload_v1";
  event_kind: "spawn_observed";
  child_process_id: number;
}>;

export type RuntimeEpisodeVerifierLaunchTerminalPayloadV1 = Readonly<{
  contract_version:
    "runtime_episode_verifier_launch_terminal_payload_v1";
  event_kind: "completed" | "interrupted";
  verifier_output_artifact_id: string;
  verifier_output_sha256: string;
  runtime_launch_sha256: string | null;
  result_sha256: string | null;
  effective_status: EpisodeVerifierRunnerStatus;
  infrastructure_failure_reasons: readonly string[];
  infrastructure_failure_attribution:
    | "arm_caused"
    | "arm_independent"
    | null;
}>;

export type RuntimeEpisodeVerifierLaunchAttemptEventPayloadV1 =
  | RuntimeEpisodeVerifierLaunchCommittedPayloadV1
  | RuntimeEpisodeVerifierSpawnObservedPayloadV1
  | RuntimeEpisodeVerifierLaunchTerminalPayloadV1;

export type RuntimeEpisodeVerifierLaunchAttemptEventV1 = Readonly<{
  contract_version:
    "runtime_episode_verifier_launch_attempt_event_v1";
  tenant_id: string;
  scope: string;
  episode_id: string;
  verifier_invocation_id: string;
  launch_attempt_id: string;
  event_sequence: number;
  previous_event_sha256: string | null;
  event_owner_instance_id: string;
  event_owner_process_id: number;
  payload: RuntimeEpisodeVerifierLaunchAttemptEventPayloadV1;
  recorded_at: string;
  event_sha256: string;
}>;

export type RuntimeEpisodeVerifierOpenLaunchAttemptV1 = Readonly<{
  attempt: RuntimeEpisodeVerifierLaunchAttemptV1;
  events: readonly RuntimeEpisodeVerifierLaunchAttemptEventV1[];
}>;

export type RuntimeEpisodeVerifierInterruptedLaunchEvidenceV1 =
  Readonly<{
    contract_version:
      "runtime_episode_verifier_interrupted_launch_evidence_v1";
    attempt: RuntimeEpisodeVerifierLaunchAttemptV1;
    observed_events:
      readonly RuntimeEpisodeVerifierLaunchAttemptEventV1[];
    terminal_reason:
      | "runtime_episode_verifier_recovered_launch_ambiguous"
      | "runtime_episode_verifier_recovered_process_interrupted"
      | "runtime_episode_verifier_owner_aborted_before_result";
    recovery_instance_id: string;
    recovery_process_id: number;
    recovered_at: string;
  }>;

type LaunchAttemptDigestMaterial = Omit<
  RuntimeEpisodeVerifierLaunchAttemptV1,
  "prepared_sha256"
>;

export type RuntimeEpisodeVerifierLaunchAttemptEventDigestMaterial = Omit<
  RuntimeEpisodeVerifierLaunchAttemptEventV1,
  "event_sha256"
>;

export function runtimeEpisodeVerifierLaunchAttemptDigest(
  value: LaunchAttemptDigestMaterial,
): string {
  return sha256Hex(stableStringify({
    contract: "runtime_episode_verifier_launch_attempt_digest_v1",
    attempt: value,
  }));
}

export function runtimeEpisodeVerifierLaunchEventDigest(
  value: RuntimeEpisodeVerifierLaunchAttemptEventDigestMaterial,
): string {
  return sha256Hex(stableStringify({
    contract: "runtime_episode_verifier_launch_attempt_event_digest_v1",
    event: value,
  }));
}

export function runtimeEpisodeVerifierInterruptedLaunchEvidenceDigest(
  value: RuntimeEpisodeVerifierInterruptedLaunchEvidenceV1,
): string {
  return sha256Hex(stableStringify(value));
}
