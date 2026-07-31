import {
  createHash,
  createPublicKey,
  KeyObject,
  verify as verifySignature,
} from "node:crypto";

import stableStringify from "fast-json-stable-stringify";

import {
  assertAuthenticEpisodeVerifierExecution,
} from "../execution/episode-verifier-runner.js";
import type {
  RuntimeEpisodeVerifierInvocationAuthorityIssuer,
  RuntimeEpisodeVerifierInvocationAuthorityV1,
  RuntimeEpisodeVerifierInvocationAuthorityVerifier,
} from "../execution/runtime-episode-verifier-launch-authority.js";
import {
  assertAuthenticRuntimeEpisodeVerifierLaunchEvidence,
  runtimeEpisodeVerifierExecutionEvidence,
  runtimeEpisodeVerifierFailureAttribution,
  type RuntimeEpisodeVerifierLaunchV1,
  type RuntimeEpisodeVerifierPreparedLaunchV1,
  type RuntimeEpisodeVerifierSpawnObservationV1,
} from "../execution/runtime-episode-verifier-registry.js";
import {
  runtimeEpisodeVerifierLaunchAttemptDigest,
  runtimeEpisodeVerifierLaunchEventDigest,
  type RuntimeEpisodeVerifierInterruptedLaunchEvidenceV1,
  type RuntimeEpisodeVerifierLaunchAttemptEventPayloadV1,
  type RuntimeEpisodeVerifierLaunchAttemptEventV1,
  type RuntimeEpisodeVerifierLaunchAttemptV1,
  type RuntimeEpisodeVerifierOpenLaunchAttemptV1,
} from "../execution/verifier-launch-attempt.js";
import type {
  VerifierSubjectMaterializationV1,
} from "../execution/verifier-subject-materialization.js";
import {
  ActionMutationReceiptV1Schema,
  AgentDecisionEventV1Schema,
  DecisionEpisodeV1Schema,
  EpisodeRewardV1Schema,
  EvidenceArtifactRefV1Schema,
  ExecutionEpisodeSubjectIdentityV1Schema,
  ExecutionEpisodeEventEnvelopeV1Schema,
  ExecutionEpisodeEventPayloadV1Schema,
  ExecutionEpisodeTaskManifestV1Schema,
  ExecutionCostReceiptV1Schema,
  PlannedActionEventV1Schema,
  ProgressStateEventV1Schema,
  SemanticObservationEventV1Schema,
  StateSnapshotV1Schema,
  VerifierInvocationV1Schema,
  VerifierOutcomeReceiptV1Schema,
  actionMutationReceiptDigest,
  buildExecutionEpisodeEventEnvelopeV1,
  decisionEpisodeDigest,
  episodeRewardDigest,
  executionCostReceiptDigest,
  evidenceArtifactRefDigest,
  executionEpisodeEventPayloadDigest,
  executionEpisodeTaskManifestDigest,
  isEpisodeRewardSelectorEligible,
  stateSnapshotDigest,
  verifierInvocationDigest,
  verifierOutcomeEvidenceDigest,
  verifierOutcomeReceiptDigest,
  type DecisionCommittedReceiptV1,
  type DecisionEpisodeV1,
  type AgentDecisionEventV1,
  type EpisodeRewardV1,
  type ExecutionCostReceiptMaterialV1,
  type ExecutionCostReceiptV1,
  type EvidenceArtifactKindV1,
  type EvidenceArtifactRefV1,
  type ExecutionEpisodeTerminationV1,
  type ExecutionEpisodeEventEnvelopeV1,
  type ExecutionEpisodeEventPayloadV1,
  type PlannedActionEventV1,
  type ProgressStateEventV1,
  type SemanticObservationEventV1,
  type StateSnapshotV1,
  type VerifierInvocationV1,
  type VerifierOutcomeReceiptV1,
} from "../memory/execution-episode.js";
import {
  hostTaskEnvelopeDigest,
} from "../execution/host-task-contract.js";
import { sha256Hex } from "../util/crypto.js";
import { stableUuid } from "../util/uuid.js";
import {
  appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction,
} from "./lite-runtime-applied-authority.js";
import type { LiteRuntimeDatabase } from "./lite-runtime-database.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";

export const LITE_EXECUTION_EPISODE_OPERATION_KIND = Object.freeze({
  begin: "execution_episode_begin_v1",
  decision: "execution_episode_decision_v1",
  action: "execution_episode_action_v1",
  semanticObservation: "execution_episode_semantic_observation_v1",
  agentDecision: "execution_episode_agent_decision_v1",
  progressState: "execution_episode_progress_state_v1",
  plannedAction: "execution_episode_planned_action_v1",
  verifierInvocation: "execution_episode_verifier_invocation_v1",
  verifierOutcome: "execution_episode_verifier_outcome_v1",
  close: "execution_episode_close_v1",
});

const MAX_EVENT_PAYLOAD_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

type SqlRow = Record<string, unknown>;

export type LiteExecutionEpisodeOperationArgs = Readonly<{
  tenantId: string;
  scope: string;
  operationId: string;
  occurredAt?: string;
}>;

export type LiteExecutionEpisodeAppendResult = Readonly<{
  event: ExecutionEpisodeEventEnvelopeV1;
  replayed: boolean;
}>;

export type LiteExecutionVerifierInvocationReservationResult = Readonly<{
  invocation: VerifierInvocationV1;
  replayed: boolean;
}>;

export type LiteExecutionVerifierLaunchAuthorizationResult = Readonly<{
  invocation: VerifierInvocationV1;
  authority: RuntimeEpisodeVerifierInvocationAuthorityV1;
}>;

export type LiteExecutionEpisodeReplay = Readonly<{
  episode: DecisionEpisodeV1;
  events: readonly ExecutionEpisodeEventEnvelopeV1[];
  current_state_snapshot_id: string;
  closed: boolean;
  reward: EpisodeRewardV1 | null;
  cost_receipt: ExecutionCostReceiptV1 | null;
  /**
   * The outcome has primary truth authority and can be transported to Phase 2.
   * It is not selector-eligible until assignment, delivery, exposure, and
   * propensity attribution are durably bound there.
   */
  reward_eligible: boolean;
  selector_eligible: boolean;
}>;

export type LiteExecutionEpisodeIntegritySummary = Readonly<{
  episode_count: number;
  event_count: number;
  closed_episode_count: number;
  selector_eligible_episode_count: number;
}>;

export type LiteExecutionEpisodeMemoryCompilationCandidate = Readonly<{
  tenant_id: string;
  store_scope: string;
  public_scope: string;
  episode_id: string;
  reward_id: string;
  reward_sha256: string;
  outcome_class: "verified_pass" | "verified_failure";
  close_event_id: string;
  close_event_sha256: string;
  created_at: string;
}>;

export type LiteExecutionEpisodeTrustedRunnerKey =
  | KeyObject
  | string
  | Buffer;

export type LiteExecutionEpisodeStoreOptions = Readonly<{
  /**
   * Ed25519 public keys keyed by `${principal_id}\0${key_id}`.
   *
   * A trusted-runner outcome is rejected when its exact configured key is
   * absent. The signature is canonical padded base64 over the 32 raw bytes of
   * `signed_payload_digest`.
   */
  trustedRunnerPublicKeys?: ReadonlyMap<
    string,
    LiteExecutionEpisodeTrustedRunnerKey
  >;
  verifierInvocationAuthorityIssuer?:
    RuntimeEpisodeVerifierInvocationAuthorityIssuer;
  verifierInvocationAuthorityVerifier?:
    RuntimeEpisodeVerifierInvocationAuthorityVerifier;
  now?: () => string;
}>;

export type LiteExecutionEpisodeTerminationKind =
  ExecutionEpisodeTerminationV1;

export type LiteExecutionEpisodeCostInputV1 = Readonly<{
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  tokenUsageAuthority: "provider_total" | "signed_host_receipt";
  rawUsageRef: EvidenceArtifactRefV1;
  monetaryCostMicros?: number;
  currency?: string;
  producerId: string;
}>;

export type LiteExecutionEpisodeStore = Readonly<{
  transactionRunner(): SqliteTransactionRunner;
  beginEpisode(args: LiteExecutionEpisodeOperationArgs & Readonly<{
    episode: DecisionEpisodeV1;
    initialStateSnapshot: StateSnapshotV1;
  }>): Promise<LiteExecutionEpisodeAppendResult>;
  appendDecision(args: LiteExecutionEpisodeOperationArgs & Readonly<{
    decision: DecisionCommittedReceiptV1;
  }>): Promise<LiteExecutionEpisodeAppendResult>;
  appendAction(args: LiteExecutionEpisodeOperationArgs & Readonly<{
    action: import("../memory/execution-episode.js").ActionMutationReceiptV1;
    stateBeforeSnapshot: StateSnapshotV1;
    stateAfterSnapshot: StateSnapshotV1;
  }>): Promise<LiteExecutionEpisodeAppendResult>;
  appendSemanticObservation(
    args: LiteExecutionEpisodeOperationArgs & Readonly<{
      observation: Omit<SemanticObservationEventV1, "semantic_event_id">;
    }>,
  ): Promise<LiteExecutionEpisodeAppendResult>;
  appendAgentDecision(
    args: LiteExecutionEpisodeOperationArgs & Readonly<{
      decision: Omit<AgentDecisionEventV1, "semantic_event_id">;
    }>,
  ): Promise<LiteExecutionEpisodeAppendResult>;
  appendProgressState(
    args: LiteExecutionEpisodeOperationArgs & Readonly<{
      progress: Omit<ProgressStateEventV1, "semantic_event_id">;
    }>,
  ): Promise<LiteExecutionEpisodeAppendResult>;
  appendPlannedAction(
    args: LiteExecutionEpisodeOperationArgs & Readonly<{
      plannedAction: Omit<PlannedActionEventV1, "semantic_event_id">;
    }>,
  ): Promise<LiteExecutionEpisodeAppendResult>;
  reserveVerifierInvocation(args: Readonly<{
    tenantId: string;
    scope: string;
    invocation: VerifierInvocationV1;
  }>): Promise<LiteExecutionVerifierInvocationReservationResult>;
  getVerifierInvocation(args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    verifierInvocationId: string;
  }>): Promise<VerifierInvocationV1 | null>;
  authorizeVerifierInvocationLaunch(args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    verifierInvocationId: string;
    sourceSubjectRoot: string;
    materialization: VerifierSubjectMaterializationV1;
  }>): Promise<LiteExecutionVerifierLaunchAuthorizationResult>;
  prepareVerifierLaunchAttempt(args: Readonly<{
    tenantId: string;
    scope: string;
    outcomeOperationId: string;
    ownerInstanceId: string;
    ownerProcessId: number;
    preparedLaunch: RuntimeEpisodeVerifierPreparedLaunchV1;
    preparedAt?: string;
  }>): Promise<RuntimeEpisodeVerifierLaunchAttemptV1>;
  appendVerifierSpawnObservation(args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    verifierInvocationId: string;
    launchAttemptId: string;
    ownerInstanceId: string;
    ownerProcessId: number;
    observation: RuntimeEpisodeVerifierSpawnObservationV1;
  }>): Promise<RuntimeEpisodeVerifierLaunchAttemptEventV1>;
  getOpenVerifierLaunchAttempt(args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    verifierInvocationId: string;
  }>): Promise<RuntimeEpisodeVerifierOpenLaunchAttemptV1 | null>;
  listOpenVerifierLaunchAttempts(): Promise<
    readonly RuntimeEpisodeVerifierOpenLaunchAttemptV1[]
  >;
  recordInterruptedVerifierOutcome(args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    launchAttemptId: string;
    recoveryInstanceId: string;
    recoveryProcessId: number;
    recoveredAt: string;
    verifierOutputRef: EvidenceArtifactRefV1;
    interruptedEvidence:
      RuntimeEpisodeVerifierInterruptedLaunchEvidenceV1;
  }>): Promise<Readonly<{
    invocation: VerifierInvocationV1;
    outcome: VerifierOutcomeReceiptV1;
    verifiedStateSnapshot: StateSnapshotV1;
    terminalEvent: RuntimeEpisodeVerifierLaunchAttemptEventV1;
    append: LiteExecutionEpisodeAppendResult;
  }>>;
  recordVerifierOutcome(args: LiteExecutionEpisodeOperationArgs & Readonly<{
    invocation: VerifierInvocationV1;
    outcome: VerifierOutcomeReceiptV1;
    verifiedStateSnapshot: StateSnapshotV1;
    runtimeExecutionEvidence?: RuntimeEpisodeVerifierLaunchV1;
  }>): Promise<LiteExecutionEpisodeAppendResult>;
  /**
   * Compatibility alias for recordVerifierOutcome. It still requires a prior,
   * durable reserveVerifierInvocation call and never creates the invocation.
   */
  appendVerifier(args: LiteExecutionEpisodeOperationArgs & Readonly<{
    invocation: VerifierInvocationV1;
    outcome: VerifierOutcomeReceiptV1;
    verifiedStateSnapshot: StateSnapshotV1;
    runtimeExecutionEvidence?: RuntimeEpisodeVerifierLaunchV1;
  }>): Promise<LiteExecutionEpisodeAppendResult>;
  closeEpisode(args: Readonly<{
    tenantId: string;
    scope: string;
    operationId: string;
    episodeId: string;
    termination: LiteExecutionEpisodeTerminationKind;
    verifierReceiptId?: string;
    outcomeDetails?: readonly string[];
    cost?: LiteExecutionEpisodeCostInputV1;
  }>): Promise<LiteExecutionEpisodeAppendResult>;
  getEpisode(args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
  }>): Promise<LiteExecutionEpisodeReplay | null>;
  replayEpisode(args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
  }>): Promise<LiteExecutionEpisodeReplay>;
  listMemoryCompilationCandidates(args: Readonly<{
    limit: number;
    offset?: number;
  }>): Promise<readonly LiteExecutionEpisodeMemoryCompilationCandidate[]>;
  verifyEpisodeIntegrity(args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
  }>): Promise<LiteExecutionEpisodeReplay>;
  verifyIntegrity(): Promise<LiteExecutionEpisodeIntegritySummary>;
}>;

type EventRow = Readonly<{
  tenant_id: string;
  scope: string;
  episode_id: string;
  event_id: string;
  episode_sequence: number;
  event_kind: ExecutionEpisodeEventPayloadV1["event_kind"];
  operation_kind: string;
  operation_id: string;
  request_sha256: string;
  previous_event_sha256: string | null;
  event_sha256: string;
  payload_sha256: string;
  payload_json: string;
  decision_id: string | null;
  action_id: string | null;
  state_before_snapshot_id: string | null;
  state_after_snapshot_id: string | null;
  action_mutation: number | null;
  verifier_receipt_id: string | null;
  reward_id: string | null;
  recorded_at: string;
}>;

type EventHead = Readonly<{
  episode_sequence: number;
  event_sha256: string;
  recorded_at: string;
}>;

type OperationRow = Readonly<{
  tenant_id: string;
  scope: string;
  operation_kind: string;
  operation_id: string;
  request_sha256: string;
  receipt_json: string;
  commit_id: string | null;
  created_at: string;
}>;

type OperationReceipt = Readonly<{
  contract_version: "execution_episode_operation_receipt_v1";
  event: ExecutionEpisodeEventEnvelopeV1;
}>;

type VerifierInvocationOperationReceipt = Readonly<{
  contract_version:
    "execution_episode_verifier_invocation_operation_receipt_v1";
  invocation: VerifierInvocationV1;
  invocation_sha256: string;
}>;

function canonicalJson(value: unknown): string {
  return stableStringify(value);
}

function parseCanonicalJson(value: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label}_json_invalid`);
  }
  if (canonicalJson(parsed) !== value) {
    throw new Error(`${label}_json_not_canonical`);
  }
  return parsed;
}

function requiredString(row: SqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`execution_episode_row_field_invalid:${field}`);
  }
  return value;
}

function nullableString(row: SqlRow, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`execution_episode_row_field_invalid:${field}`);
  }
  return value;
}

function requiredInteger(row: SqlRow, field: string): number {
  const value = Number(row[field]);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`execution_episode_row_field_invalid:${field}`);
  }
  return value;
}

function nullableInteger(row: SqlRow, field: string): number | null {
  if (row[field] === null) return null;
  return requiredInteger(row, field);
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label}_timestamp_invalid`);
  }
}

function launchAttemptFromRow(
  row: SqlRow,
): RuntimeEpisodeVerifierLaunchAttemptV1 {
  const attempt: RuntimeEpisodeVerifierLaunchAttemptV1 = {
    contract_version: "runtime_episode_verifier_launch_attempt_v1",
    tenant_id: requiredString(row, "tenant_id"),
    scope: requiredString(row, "scope"),
    episode_id: requiredString(row, "episode_id"),
    verifier_invocation_id:
      requiredString(row, "verifier_invocation_id"),
    launch_attempt_id: requiredString(row, "launch_attempt_id"),
    outcome_operation_id: requiredString(row, "outcome_operation_id"),
    attempt_ordinal: requiredInteger(row, "attempt_ordinal"),
    owner_instance_id: requiredString(row, "owner_instance_id"),
    owner_process_id: requiredInteger(row, "owner_process_id"),
    invocation_sha256: requiredString(row, "invocation_sha256"),
    invocation_authority_sha256:
      requiredString(row, "invocation_authority_sha256"),
    invocation_authority_channel_id:
      requiredString(row, "invocation_authority_channel_id"),
    materialization_id: requiredString(row, "materialization_id"),
    materialized_subject_root:
      requiredString(row, "materialized_subject_root"),
    materialized_scratch_root:
      requiredString(row, "materialized_scratch_root"),
    source_content_digest:
      requiredString(row, "source_content_digest"),
    source_environment_digest:
      requiredString(row, "source_environment_digest"),
    subject_identity_sha256:
      requiredString(row, "subject_identity_sha256"),
    subject_view_content_digest:
      requiredString(row, "subject_view_content_digest"),
    subject_view_environment_digest:
      requiredString(row, "subject_view_environment_digest"),
    verifier_definition_sha256:
      requiredString(row, "verifier_definition_sha256"),
    verifier_program_digest:
      requiredString(row, "verifier_program_digest"),
    verifier_config_digest:
      requiredString(row, "verifier_config_digest"),
    verifier_environment_digest:
      requiredString(row, "verifier_environment_digest"),
    execution_pack_manifest_sha256:
      requiredString(row, "execution_pack_manifest_sha256"),
    resolved_config_digest:
      requiredString(row, "resolved_config_digest"),
    resolved_environment_digest:
      requiredString(row, "resolved_environment_digest"),
    prepared_at: requiredString(row, "prepared_at"),
    prepared_sha256: requiredString(row, "prepared_sha256"),
  };
  const { prepared_sha256: _preparedSha256, ...material } = attempt;
  if (
    runtimeEpisodeVerifierLaunchAttemptDigest(material)
      !== attempt.prepared_sha256
  ) {
    throw new Error("execution_verifier_launch_attempt_digest_invalid");
  }
  assertCanonicalTimestamp(
    attempt.prepared_at,
    "execution_verifier_launch_attempt",
  );
  return Object.freeze(attempt);
}

function launchAttemptRow(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    launchAttemptId: string;
  }>,
): RuntimeEpisodeVerifierLaunchAttemptV1 | null {
  const row = db.prepare(
    `SELECT *
     FROM lite_execution_verifier_launch_attempts
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND launch_attempt_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.episodeId,
    args.launchAttemptId,
  ) as SqlRow | undefined;
  return row ? launchAttemptFromRow(row) : null;
}

function launchEventPayloadFromRow(
  row: SqlRow,
  attempt: RuntimeEpisodeVerifierLaunchAttemptV1,
): RuntimeEpisodeVerifierLaunchAttemptEventPayloadV1 {
  const eventKind = requiredString(row, "event_kind");
  if (eventKind === "launch_committed") {
    return Object.freeze({
      contract_version:
        "runtime_episode_verifier_launch_committed_payload_v1",
      event_kind: "launch_committed",
      prepared_sha256: attempt.prepared_sha256,
    });
  }
  if (eventKind === "spawn_observed") {
    const childProcessId = nullableInteger(row, "spawned_process_id");
    if (childProcessId === null || childProcessId <= 0) {
      throw new Error(
        "execution_verifier_launch_spawn_observation_invalid",
      );
    }
    return Object.freeze({
      contract_version:
        "runtime_episode_verifier_spawn_observed_payload_v1",
      event_kind: "spawn_observed",
      child_process_id: childProcessId,
    });
  }
  if (eventKind !== "completed" && eventKind !== "interrupted") {
    throw new Error("execution_verifier_launch_event_kind_invalid");
  }
  const reasonsValue = parseCanonicalJson(
    requiredString(row, "infrastructure_failure_reasons_json"),
    "execution_verifier_launch_infrastructure_failure_reasons",
  );
  if (
    !Array.isArray(reasonsValue)
    || reasonsValue.some((reason) => typeof reason !== "string")
  ) {
    throw new Error(
      "execution_verifier_launch_infrastructure_failure_reasons_invalid",
    );
  }
  const reasons = canonicalReasons(reasonsValue as string[]);
  if (canonicalJson(reasons) !== canonicalJson(reasonsValue)) {
    throw new Error(
      "execution_verifier_launch_infrastructure_failure_reasons_not_canonical",
    );
  }
  const effectiveStatus = nullableString(row, "effective_status");
  if (
    effectiveStatus !== "passed"
    && effectiveStatus !== "failed"
    && effectiveStatus !== "infrastructure_error"
  ) {
    throw new Error(
      "execution_verifier_launch_terminal_status_invalid",
    );
  }
  const attribution = nullableString(
    row,
    "infrastructure_failure_attribution",
  );
  if (
    attribution !== null
    && attribution !== "arm_caused"
    && attribution !== "arm_independent"
  ) {
    throw new Error(
      "execution_verifier_launch_terminal_attribution_invalid",
    );
  }
  return Object.freeze({
    contract_version:
      "runtime_episode_verifier_launch_terminal_payload_v1",
    event_kind: eventKind,
    verifier_output_artifact_id:
      requiredString(row, "verifier_output_artifact_id"),
    verifier_output_sha256:
      requiredString(row, "verifier_output_sha256"),
    runtime_launch_sha256: nullableString(
      row,
      "runtime_launch_sha256",
    ),
    result_sha256: nullableString(row, "result_sha256"),
    effective_status: effectiveStatus,
    infrastructure_failure_reasons: Object.freeze(reasons),
    infrastructure_failure_attribution: attribution,
  });
}

function launchEventFromRow(
  row: SqlRow,
  attempt: RuntimeEpisodeVerifierLaunchAttemptV1,
): RuntimeEpisodeVerifierLaunchAttemptEventV1 {
  const event: RuntimeEpisodeVerifierLaunchAttemptEventV1 = {
    contract_version:
      "runtime_episode_verifier_launch_attempt_event_v1",
    tenant_id: requiredString(row, "tenant_id"),
    scope: requiredString(row, "scope"),
    episode_id: requiredString(row, "episode_id"),
    verifier_invocation_id:
      requiredString(row, "verifier_invocation_id"),
    launch_attempt_id: requiredString(row, "launch_attempt_id"),
    event_sequence: requiredInteger(row, "event_sequence"),
    previous_event_sha256:
      nullableString(row, "previous_event_sha256"),
    event_owner_instance_id:
      requiredString(row, "event_owner_instance_id"),
    event_owner_process_id:
      requiredInteger(row, "event_owner_process_id"),
    payload: launchEventPayloadFromRow(row, attempt),
    recorded_at: requiredString(row, "recorded_at"),
    event_sha256: requiredString(row, "event_sha256"),
  };
  if (
    event.tenant_id !== attempt.tenant_id
    || event.scope !== attempt.scope
    || event.episode_id !== attempt.episode_id
    || event.verifier_invocation_id !== attempt.verifier_invocation_id
    || event.launch_attempt_id !== attempt.launch_attempt_id
  ) {
    throw new Error("execution_verifier_launch_event_attempt_mismatch");
  }
  const { event_sha256: _eventSha256, ...material } = event;
  if (
    runtimeEpisodeVerifierLaunchEventDigest(material)
      !== event.event_sha256
  ) {
    throw new Error("execution_verifier_launch_event_digest_invalid");
  }
  assertCanonicalTimestamp(
    event.recorded_at,
    "execution_verifier_launch_event",
  );
  return Object.freeze(event);
}

function launchEventsForAttempt(
  db: SqliteDatabase,
  attempt: RuntimeEpisodeVerifierLaunchAttemptV1,
): readonly RuntimeEpisodeVerifierLaunchAttemptEventV1[] {
  const rows = db.prepare(
    `SELECT *
     FROM lite_execution_verifier_launch_attempt_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND verifier_invocation_id = ? AND launch_attempt_id = ?
     ORDER BY event_sequence`,
  ).all(
    attempt.tenant_id,
    attempt.scope,
    attempt.episode_id,
    attempt.verifier_invocation_id,
    attempt.launch_attempt_id,
  ) as SqlRow[];
  const events = rows.map((row) => launchEventFromRow(row, attempt));
  for (const [index, event] of events.entries()) {
    if (
      event.event_sequence !== index
      || event.previous_event_sha256
        !== (index === 0 ? null : events[index - 1]!.event_sha256)
    ) {
      throw new Error("execution_verifier_launch_event_chain_invalid");
    }
  }
  return Object.freeze(events);
}

function buildLaunchEvent(
  attempt: RuntimeEpisodeVerifierLaunchAttemptV1,
  args: Readonly<{
    previous: RuntimeEpisodeVerifierLaunchAttemptEventV1 | null;
    ownerInstanceId: string;
    ownerProcessId: number;
    payload: RuntimeEpisodeVerifierLaunchAttemptEventPayloadV1;
    recordedAt: string;
  }>,
): RuntimeEpisodeVerifierLaunchAttemptEventV1 {
  assertCanonicalTimestamp(
    args.recordedAt,
    "execution_verifier_launch_event",
  );
  const material = {
    contract_version:
      "runtime_episode_verifier_launch_attempt_event_v1" as const,
    tenant_id: attempt.tenant_id,
    scope: attempt.scope,
    episode_id: attempt.episode_id,
    verifier_invocation_id: attempt.verifier_invocation_id,
    launch_attempt_id: attempt.launch_attempt_id,
    event_sequence: (args.previous?.event_sequence ?? -1) + 1,
    previous_event_sha256: args.previous?.event_sha256 ?? null,
    event_owner_instance_id: args.ownerInstanceId,
    event_owner_process_id: args.ownerProcessId,
    payload: args.payload,
    recorded_at: args.recordedAt,
  };
  return Object.freeze({
    ...material,
    event_sha256: runtimeEpisodeVerifierLaunchEventDigest(material),
  });
}

function insertLaunchEvent(
  db: SqliteDatabase,
  event: RuntimeEpisodeVerifierLaunchAttemptEventV1,
): void {
  const payload = event.payload;
  const terminal =
    payload.event_kind === "completed"
    || payload.event_kind === "interrupted"
      ? payload
      : null;
  db.prepare(
    `INSERT INTO lite_execution_verifier_launch_attempt_events
       (tenant_id, scope, episode_id, verifier_invocation_id,
        launch_attempt_id, event_sequence, event_kind,
        event_owner_instance_id, event_owner_process_id,
        previous_event_sha256, event_sha256, spawned_process_id,
        verifier_output_artifact_id, verifier_output_sha256,
        runtime_launch_sha256, result_sha256, effective_status,
        infrastructure_failure_reasons_json,
        infrastructure_failure_attribution, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?)`,
  ).run(
    event.tenant_id,
    event.scope,
    event.episode_id,
    event.verifier_invocation_id,
    event.launch_attempt_id,
    event.event_sequence,
    payload.event_kind,
    event.event_owner_instance_id,
    event.event_owner_process_id,
    event.previous_event_sha256,
    event.event_sha256,
    payload.event_kind === "spawn_observed"
      ? payload.child_process_id
      : null,
    terminal?.verifier_output_artifact_id ?? null,
    terminal?.verifier_output_sha256 ?? null,
    terminal?.runtime_launch_sha256 ?? null,
    terminal?.result_sha256 ?? null,
    terminal?.effective_status ?? null,
    canonicalJson(
      terminal?.infrastructure_failure_reasons ?? [],
    ),
    terminal?.infrastructure_failure_attribution ?? null,
    event.recorded_at,
  );
  const stored = db.prepare(
    `SELECT *
     FROM lite_execution_verifier_launch_attempt_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND launch_attempt_id = ? AND event_sequence = ?`,
  ).get(
    event.tenant_id,
    event.scope,
    event.episode_id,
    event.launch_attempt_id,
    event.event_sequence,
  ) as SqlRow | undefined;
  const attempt = launchAttemptRow(db, {
    tenantId: event.tenant_id,
    scope: event.scope,
    episodeId: event.episode_id,
    launchAttemptId: event.launch_attempt_id,
  });
  if (
    !stored
    || !attempt
    || canonicalJson(launchEventFromRow(stored, attempt))
      !== canonicalJson(event)
  ) {
    throw new Error(
      "execution_verifier_launch_event_persistence_mismatch",
    );
  }
}

function openLaunchAttemptForInvocation(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    verifierInvocationId: string;
  }>,
): RuntimeEpisodeVerifierOpenLaunchAttemptV1 | null {
  const rows = db.prepare(
    `SELECT attempt.*
     FROM lite_execution_verifier_launch_attempts AS attempt
     WHERE attempt.tenant_id = ? AND attempt.scope = ?
       AND attempt.episode_id = ?
       AND attempt.verifier_invocation_id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM lite_execution_verifier_launch_attempt_events AS terminal
         WHERE terminal.tenant_id = attempt.tenant_id
           AND terminal.scope = attempt.scope
           AND terminal.episode_id = attempt.episode_id
           AND terminal.verifier_invocation_id =
             attempt.verifier_invocation_id
           AND terminal.launch_attempt_id = attempt.launch_attempt_id
           AND terminal.event_kind IN ('completed', 'interrupted')
       )
     ORDER BY attempt.attempt_ordinal`,
  ).all(
    args.tenantId,
    args.scope,
    args.episodeId,
    args.verifierInvocationId,
  ) as SqlRow[];
  if (rows.length > 1) {
    throw new Error(
      "execution_verifier_multiple_open_launch_attempts",
    );
  }
  if (rows.length === 0) return null;
  const attempt = launchAttemptFromRow(rows[0]!);
  const events = launchEventsForAttempt(db, attempt);
  if (
    events.length === 0
    || events[0]?.payload.event_kind !== "launch_committed"
    || events.some((event) =>
      event.payload.event_kind === "completed"
      || event.payload.event_kind === "interrupted")
  ) {
    throw new Error("execution_verifier_open_launch_attempt_invalid");
  }
  return Object.freeze({ attempt, events });
}

function eventOccurredAt(payload: ExecutionEpisodeEventPayloadV1): string {
  switch (payload.event_kind) {
    case "episode_started":
      return payload.episode.opened_at;
    case "decision_committed":
      return payload.decision.committed_at;
    case "action_observed":
      return payload.action.occurred_at;
    case "semantic_observation_recorded":
      return payload.observation.recorded_at;
    case "agent_decision_recorded":
      return payload.decision.recorded_at;
    case "progress_state_recorded":
      return payload.progress.recorded_at;
    case "planned_action_recorded":
      return payload.planned_action.recorded_at;
    case "verifier_recorded":
      return payload.outcome.completed_at;
    case "episode_closed":
      return payload.closed_at;
  }
}

function payloadEpisodeId(payload: ExecutionEpisodeEventPayloadV1): string {
  switch (payload.event_kind) {
    case "episode_started":
      return payload.episode.episode_id;
    case "decision_committed":
      return payload.decision.episode_id;
    case "action_observed":
      return payload.action.episode_id;
    case "semantic_observation_recorded":
      return payload.observation.episode_id;
    case "agent_decision_recorded":
      return payload.decision.episode_id;
    case "progress_state_recorded":
      return payload.progress.episode_id;
    case "planned_action_recorded":
      return payload.planned_action.episode_id;
    case "verifier_recorded":
      return payload.invocation.episode_id;
    case "episode_closed":
      return payload.reward.episode_id;
  }
}

function semanticEventStateBinding(
  payload: ExecutionEpisodeEventPayloadV1,
): Readonly<{
  semanticEventId: string;
  targetStateSnapshotId: string;
}> | null {
  switch (payload.event_kind) {
    case "semantic_observation_recorded":
      return {
        semanticEventId: payload.observation.semantic_event_id,
        targetStateSnapshotId:
          payload.observation.target_state_snapshot_id,
      };
    case "agent_decision_recorded":
      return {
        semanticEventId: payload.decision.semantic_event_id,
        targetStateSnapshotId: payload.decision.target_state_snapshot_id,
      };
    case "progress_state_recorded":
      return {
        semanticEventId: payload.progress.semantic_event_id,
        targetStateSnapshotId: payload.progress.target_state_snapshot_id,
      };
    case "planned_action_recorded":
      return {
        semanticEventId: payload.planned_action.semantic_event_id,
        targetStateSnapshotId:
          payload.planned_action.target_state_snapshot_id,
      };
    default:
      return null;
  }
}

function operationReceipt(
  event: ExecutionEpisodeEventEnvelopeV1,
): OperationReceipt {
  return {
    contract_version: "execution_episode_operation_receipt_v1",
    event,
  };
}

function operationReceiptJson(
  event: ExecutionEpisodeEventEnvelopeV1,
): string {
  return canonicalJson(operationReceipt(event));
}

function verifierInvocationOperationReceipt(
  invocation: VerifierInvocationV1,
): VerifierInvocationOperationReceipt {
  return {
    contract_version:
      "execution_episode_verifier_invocation_operation_receipt_v1",
    invocation,
    invocation_sha256: verifierInvocationDigest(invocation),
  };
}

function verifierInvocationOperationReceiptJson(
  invocation: VerifierInvocationV1,
): string {
  return canonicalJson(verifierInvocationOperationReceipt(invocation));
}

export function runtimeVerifierInvocationReservationDigest(
  value: Readonly<{
    episodeId: string;
    verifierInvocationId: string;
    verifierId: string;
    verifierDefinitionSha256: string;
    verifierRunnerInstanceId: string;
    verifierProgramDigest: string;
    verifierConfigDigest: string;
    verifierEnvironmentDigest: string;
    targetStateSnapshotId: string;
    targetStateSnapshotAlgorithmVersion: string;
  }>,
): string {
  return sha256Hex(canonicalJson({
    contract_version: "runtime_verifier_invocation_reservation_v1",
    episode_id: value.episodeId,
    verifier_invocation_id: value.verifierInvocationId,
    verifier_id: value.verifierId,
    verifier_definition_sha256: value.verifierDefinitionSha256,
    verifier_runner_instance_id: value.verifierRunnerInstanceId,
    verifier_program_digest: value.verifierProgramDigest,
    verifier_config_digest: value.verifierConfigDigest,
    verifier_environment_digest: value.verifierEnvironmentDigest,
    target_state_snapshot_id: value.targetStateSnapshotId,
    target_state_snapshot_algorithm_version:
      value.targetStateSnapshotAlgorithmVersion,
  }));
}

function expectedRuntimeVerifierInvocationReservationDigest(
  invocation: VerifierInvocationV1,
): string {
  return runtimeVerifierInvocationReservationDigest({
    episodeId: invocation.episode_id,
    verifierInvocationId: invocation.verifier_invocation_id,
    verifierId: invocation.verifier_id,
    verifierDefinitionSha256: invocation.verifier_definition_sha256,
    verifierRunnerInstanceId: invocation.verifier_runner_instance_id,
    verifierProgramDigest: invocation.verifier_program_digest,
    verifierConfigDigest: invocation.verifier_config_digest,
    verifierEnvironmentDigest: invocation.verifier_environment_digest,
    targetStateSnapshotId: invocation.target_state_snapshot_id,
    targetStateSnapshotAlgorithmVersion:
      invocation.target_state_snapshot_algorithm_version,
  });
}

function eventIdFor(args: {
  tenantId: string;
  scope: string;
  operationKind: string;
  operationId: string;
}): string {
  return `eev_${stableUuid(canonicalJson({
    contract_version: "execution_episode_event_identity_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    operation_kind: args.operationKind,
    operation_id: args.operationId,
  }))}`;
}

function assertExactFields(
  row: SqlRow,
  expected: Readonly<Record<string, unknown>>,
  label: string,
): void {
  for (const [field, expectedValue] of Object.entries(expected)) {
    const stored = row[field];
    if (
      typeof expectedValue === "number"
      && typeof stored === "bigint"
      && Number.isSafeInteger(expectedValue)
    ) {
      if (stored !== BigInt(expectedValue)) {
        throw new Error(`${label}_projection_mismatch:${field}`);
      }
      continue;
    }
    if (stored !== expectedValue) {
      throw new Error(`${label}_projection_mismatch:${field}`);
    }
  }
}

function artifactReferenceKind(
  kind: EvidenceArtifactKindV1,
): string {
  switch (kind) {
    case "state_snapshot":
      return "state_snapshot";
    case "feature_vector":
      return "feature_vector";
    case "prompt":
      return "prompt";
    case "tool_request":
      return "tool_request";
    case "tool_result":
      return "tool_result";
    case "usage_receipt":
      return "usage_receipt";
    case "workspace_diff":
      return "workspace_diff";
    case "verifier_input":
      return "verifier_input";
    case "verifier_output":
      return "verifier_output";
    case "candidate_set":
      return "candidate_set";
    case "policy_parameters":
    case "policy_calibration":
      return "policy_artifact";
    case "manifest":
      return "manifest";
    case "training_dataset":
    case "procedure_candidate":
      return "payload";
  }
}

function eventArtifactRefs(
  payload: ExecutionEpisodeEventPayloadV1,
): ReadonlyArray<Readonly<{
  ref: EvidenceArtifactRefV1;
  referenceKind: string;
}>> {
  const values: Array<Readonly<{
    ref: EvidenceArtifactRefV1;
    referenceKind: string;
  }>> = [];
  const add = (ref: EvidenceArtifactRefV1, referenceKind?: string): void => {
    values.push({
      ref,
      referenceKind: referenceKind ?? artifactReferenceKind(ref.kind),
    });
  };
  switch (payload.event_kind) {
    case "episode_started":
      add(payload.episode.task_envelope_ref, "manifest");
      add(payload.episode.task_manifest_ref, "manifest");
      add(payload.episode.source_task_ref, "prompt");
      add(payload.episode.model_config_ref, "manifest");
      add(payload.initial_state_snapshot.artifact_ref, "state_snapshot");
      break;
    case "decision_committed":
      break;
    case "action_observed":
      add(payload.action.request_ref);
      add(payload.action.result_ref);
      add(payload.state_before_snapshot.artifact_ref, "state_snapshot");
      add(payload.state_after_snapshot.artifact_ref, "state_snapshot");
      break;
    case "semantic_observation_recorded":
      for (const ref of payload.observation.authority.evidence_refs) add(ref);
      break;
    case "agent_decision_recorded":
      for (const ref of payload.decision.authority.evidence_refs) add(ref);
      break;
    case "progress_state_recorded":
      for (const ref of payload.progress.authority.evidence_refs) add(ref);
      break;
    case "planned_action_recorded":
      for (const ref of payload.planned_action.authority.evidence_refs) add(ref);
      break;
    case "verifier_recorded":
      add(payload.invocation.verifier_input_ref, "verifier_input");
      add(payload.outcome.verifier_output_ref, "verifier_output");
      add(payload.verified_state_snapshot.artifact_ref, "state_snapshot");
      break;
    case "episode_closed":
      if (payload.final_state_snapshot) {
        add(payload.final_state_snapshot.artifact_ref, "state_snapshot");
      }
      if (payload.reward.token_usage_ref) {
        add(payload.reward.token_usage_ref, "usage_receipt");
      }
      if (payload.cost_receipt?.raw_usage_ref) {
        add(payload.cost_receipt.raw_usage_ref, "usage_receipt");
      }
      break;
  }
  const unique = new Map<string, typeof values[number]>();
  for (const value of values) {
    unique.set(`${value.ref.artifact_id}\u0000${value.referenceKind}`, value);
  }
  return [...unique.values()].sort((left, right) => (
    `${left.ref.artifact_id}\u0000${left.referenceKind}`
      .localeCompare(`${right.ref.artifact_id}\u0000${right.referenceKind}`)
  ));
}

function artifactRefFromRow(row: SqlRow): EvidenceArtifactRefV1 {
  return EvidenceArtifactRefV1Schema.parse({
    contract_version: "evidence_artifact_ref_v1",
    artifact_id: requiredString(row, "artifact_id"),
    kind: requiredString(row, "kind"),
    sha256: requiredString(row, "sha256"),
    storage_ref: requiredString(row, "storage_ref"),
    byte_length: requiredInteger(row, "byte_length"),
    media_type: requiredString(row, "media_type"),
    encoding: requiredString(row, "encoding"),
    redaction_policy: requiredString(row, "redaction_policy"),
    retention_policy: requiredString(row, "retention_policy"),
  });
}

function assertArtifactRef(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    episodeId: string;
    ref: EvidenceArtifactRefV1;
  },
): void {
  const ref = EvidenceArtifactRefV1Schema.parse(args.ref);
  const row = db.prepare(
    `SELECT artifact.artifact_id, artifact.episode_id, artifact.kind,
            artifact.sha256, artifact.storage_ref, artifact.byte_length,
            artifact.media_type, artifact.encoding,
            artifact.redaction_policy, artifact.retention_policy,
            artifact.artifact_ref_sha256, blob.byte_length AS blob_byte_length,
            blob.content_bytes
     FROM lite_runtime_evidence_artifacts AS artifact
     JOIN lite_runtime_evidence_blobs AS blob
       ON blob.tenant_id = artifact.tenant_id
      AND blob.blob_sha256 = artifact.sha256
     WHERE artifact.tenant_id = ? AND artifact.scope = ?
       AND artifact.artifact_id = ?`,
  ).get(args.tenantId, args.scope, ref.artifact_id) as SqlRow | undefined;
  if (!row) {
    throw new Error(`execution_episode_artifact_missing:${ref.artifact_id}`);
  }
  if (requiredString(row, "episode_id") !== args.episodeId) {
    throw new Error(`execution_episode_artifact_cross_episode:${ref.artifact_id}`);
  }
  const storedRef = artifactRefFromRow(row);
  const contentValue = row.content_bytes;
  if (!(contentValue instanceof Uint8Array)) {
    throw new Error(`execution_episode_artifact_blob_missing:${ref.artifact_id}`);
  }
  const content = Buffer.from(contentValue);
  if (
    canonicalJson(storedRef) !== canonicalJson(ref)
    || requiredString(row, "artifact_ref_sha256")
      !== evidenceArtifactRefDigest(ref)
    || requiredInteger(row, "blob_byte_length") !== ref.byte_length
    || content.byteLength !== ref.byte_length
    || createHash("sha256").update(content).digest("hex") !== ref.sha256
  ) {
    throw new Error(`execution_episode_artifact_ref_mismatch:${ref.artifact_id}`);
  }
}

function snapshotExpectedRow(
  args: {
    tenantId: string;
    scope: string;
    episodeId: string;
    snapshot: StateSnapshotV1;
  },
): Readonly<Record<string, unknown>> {
  const snapshot = StateSnapshotV1Schema.parse(args.snapshot);
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    episode_id: args.episodeId,
    snapshot_id: snapshot.snapshot_id,
    algorithm_id: snapshot.algorithm_id,
    algorithm_version: snapshot.algorithm_version,
    state_kind: snapshot.state_kind,
    environment_digest: snapshot.environment_digest,
    content_digest: snapshot.content_digest,
    artifact_id: snapshot.artifact_ref.artifact_id,
    snapshot_sha256: stateSnapshotDigest(snapshot),
    captured_at: snapshot.captured_at,
  };
}

function ensureStateSnapshot(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    episodeId: string;
    snapshot: StateSnapshotV1;
  },
): void {
  const snapshot = StateSnapshotV1Schema.parse(args.snapshot);
  assertArtifactRef(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.episodeId,
    ref: snapshot.artifact_ref,
  });
  const expected = snapshotExpectedRow({ ...args, snapshot });
  const existing = db.prepare(
    `SELECT *
     FROM lite_execution_state_snapshots
     WHERE tenant_id = ? AND scope = ? AND episode_id = ? AND snapshot_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.episodeId,
    snapshot.snapshot_id,
  ) as SqlRow | undefined;
  if (existing) {
    assertExactFields(existing, expected, "execution_state_snapshot");
    return;
  }
  db.prepare(
    `INSERT INTO lite_execution_state_snapshots
       (tenant_id, scope, episode_id, snapshot_id, algorithm_id,
        algorithm_version, state_kind, environment_digest, content_digest,
        artifact_id, snapshot_sha256, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...Object.values(expected));
}

function episodeExpectedRow(
  args: {
    tenantId: string;
    scope: string;
    episode: DecisionEpisodeV1;
  },
): Readonly<Record<string, unknown>> {
  const episode = DecisionEpisodeV1Schema.parse(args.episode);
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    episode_id: episode.episode_id,
    episode_contract_version: episode.contract_version,
    public_scope: episode.public_scope,
    task_id: episode.task_id,
    task_cluster_id: episode.task_cluster_id,
    task_cluster_policy_version: episode.task_cluster_policy_version,
    task_envelope_sha256: episode.task_envelope_digest,
    task_envelope_artifact_id: episode.task_envelope_ref.artifact_id,
    task_manifest_sha256: episode.task_manifest_digest,
    task_manifest_artifact_id: episode.task_manifest_ref.artifact_id,
    source_task_sha256: episode.source_task_ref.sha256,
    source_task_artifact_id: episode.source_task_ref.artifact_id,
    run_id: episode.run_id,
    model_id: episode.model_id,
    model_config_digest: episode.model_config_digest,
    model_config_artifact_id: episode.model_config_ref.artifact_id,
    environment_digest: episode.environment_digest,
    subject_identity_json: canonicalJson(episode.subject_identity),
    subject_identity_sha256: episode.subject_identity.identity_sha256,
    required_verifier_id: episode.required_verifier.verifier_id,
    required_verifier_definition_sha256:
      episode.required_verifier.verifier_definition_sha256,
    initial_state_snapshot_id: episode.initial_state_snapshot_id,
    budget_max_steps: episode.budget.max_steps,
    budget_max_tokens: episode.budget.max_tokens,
    budget_max_cost_micros: episode.budget.max_cost_micros ?? null,
    budget_deadline_ms: episode.budget.deadline_ms ?? null,
    episode_sha256: decisionEpisodeDigest(episode),
    opened_at: episode.opened_at,
  };
}

function ensureEpisode(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    episode: DecisionEpisodeV1;
  },
): void {
  const episode = DecisionEpisodeV1Schema.parse(args.episode);
  if (episode.tenant_id !== args.tenantId || episode.store_scope !== args.scope) {
    throw new Error("execution_episode_scope_identity_mismatch");
  }
  assertArtifactRef(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: episode.episode_id,
    ref: episode.task_envelope_ref,
  });
  assertArtifactRef(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: episode.episode_id,
    ref: episode.task_manifest_ref,
  });
  assertArtifactRef(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: episode.episode_id,
    ref: episode.source_task_ref,
  });
  assertArtifactRef(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: episode.episode_id,
    ref: episode.model_config_ref,
  });
  const taskManifestArtifact = db.prepare(
    `SELECT blob.content_bytes
     FROM lite_runtime_evidence_artifacts AS artifact
     JOIN lite_runtime_evidence_blobs AS blob
       ON blob.tenant_id = artifact.tenant_id
      AND blob.blob_sha256 = artifact.sha256
     WHERE artifact.tenant_id = ? AND artifact.scope = ?
       AND artifact.episode_id = ? AND artifact.artifact_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    episode.episode_id,
    episode.task_manifest_ref.artifact_id,
  ) as { content_bytes: Uint8Array } | undefined;
  const taskEnvelopeArtifact = db.prepare(
    `SELECT blob.content_bytes
     FROM lite_runtime_evidence_artifacts AS artifact
     JOIN lite_runtime_evidence_blobs AS blob
       ON blob.tenant_id = artifact.tenant_id
      AND blob.blob_sha256 = artifact.sha256
     WHERE artifact.tenant_id = ? AND artifact.scope = ?
       AND artifact.episode_id = ? AND artifact.artifact_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    episode.episode_id,
    episode.task_envelope_ref.artifact_id,
  ) as { content_bytes: Uint8Array } | undefined;
  if (!taskManifestArtifact || !taskEnvelopeArtifact) {
    throw new Error("execution_episode_task_manifest_artifact_missing");
  }
  const taskManifest = ExecutionEpisodeTaskManifestV1Schema.parse(
    parseCanonicalJson(
      Buffer.from(taskManifestArtifact.content_bytes).toString("utf8"),
      "execution_episode_task_manifest",
    ),
  );
  const initialState = storedStateSnapshot(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: episode.episode_id,
    snapshotId: episode.initial_state_snapshot_id,
  });
  if (
    executionEpisodeTaskManifestDigest(taskManifest)
      !== episode.task_manifest_digest
    || hostTaskEnvelopeDigest(taskManifest.host_task_envelope)
      !== episode.task_envelope_digest
    || canonicalJson(taskManifest.host_task_envelope)
      !== Buffer.from(taskEnvelopeArtifact.content_bytes).toString("utf8")
    || taskManifest.host_task_envelope.host_task_id !== episode.task_id
    || taskManifest.host_task_envelope.source_task_sha256
      !== episode.source_task_ref.sha256
    || canonicalJson(taskManifest.source_task_ref)
      !== canonicalJson(episode.source_task_ref)
    || taskManifest.model.model_id !== episode.model_id
    || taskManifest.model.model_config_digest
      !== episode.model_config_digest
    || canonicalJson(taskManifest.model.model_config_ref)
      !== canonicalJson(episode.model_config_ref)
    || taskManifest.subject.state_kind !== initialState.state_kind
    || taskManifest.subject.capture_algorithm_id !== initialState.algorithm_id
    || taskManifest.subject.capture_algorithm_version
      !== initialState.algorithm_version
    || taskManifest.subject.expected_initial_content_digest
      !== initialState.content_digest
    || taskManifest.subject.state_kind
      !== episode.subject_identity.state_kind
    || taskManifest.subject.capture_algorithm_id
      !== episode.subject_identity.capture_algorithm_id
    || taskManifest.subject.capture_algorithm_version
      !== episode.subject_identity.capture_algorithm_version
    || canonicalJson(taskManifest.subject.subject_state_spec)
      !== canonicalJson(episode.subject_identity.subject_state_spec)
    || taskManifest.required_verifier.verifier_id
      !== episode.required_verifier.verifier_id
    || taskManifest.required_verifier.verifier_definition_sha256
      !== episode.required_verifier.verifier_definition_sha256
    || episode.environment_digest !== initialState.environment_digest
  ) {
    throw new Error("execution_episode_task_manifest_binding_mismatch");
  }
  const expected = episodeExpectedRow({ ...args, episode });
  const existing = db.prepare(
    `SELECT *
     FROM lite_execution_episodes
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
  ).get(args.tenantId, args.scope, episode.episode_id) as SqlRow | undefined;
  if (existing) {
    assertExactFields(existing, expected, "execution_episode");
    return;
  }
  db.prepare(
    `INSERT INTO lite_execution_episodes
       (tenant_id, scope, episode_id, episode_contract_version, public_scope,
        task_id, task_cluster_id, task_cluster_policy_version,
        task_envelope_sha256, task_envelope_artifact_id,
        task_manifest_sha256, task_manifest_artifact_id, source_task_sha256,
        source_task_artifact_id, run_id, model_id, model_config_digest,
        model_config_artifact_id, environment_digest, subject_identity_json,
        subject_identity_sha256, required_verifier_id,
        required_verifier_definition_sha256, initial_state_snapshot_id,
        budget_max_steps, budget_max_tokens, budget_max_cost_micros,
        budget_deadline_ms, episode_sha256, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...Object.values(expected));
}

function invocationExpectedRow(
  args: {
    tenantId: string;
    scope: string;
    invocation: VerifierInvocationV1;
  },
): Readonly<Record<string, unknown>> {
  const invocation = VerifierInvocationV1Schema.parse(args.invocation);
  const launchAuthority = invocation.launch_authority;
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    episode_id: invocation.episode_id,
    verifier_invocation_id: invocation.verifier_invocation_id,
    verifier_id: invocation.verifier_id,
    verifier_definition_sha256: invocation.verifier_definition_sha256,
    verifier_kind: invocation.verifier_kind,
    verifier_version: invocation.verifier_version,
    verifier_issuer_id: invocation.verifier_issuer_id,
    verifier_runner_instance_id: invocation.verifier_runner_instance_id,
    launch_authority_kind: launchAuthority.kind,
    runtime_reservation_digest: launchAuthority.kind === "runtime_launched"
      ? launchAuthority.runtime_reservation_digest
      : null,
    principal_id: launchAuthority.kind === "trusted_runner"
      ? launchAuthority.principal_id
      : null,
    key_id: launchAuthority.kind === "trusted_runner"
      ? launchAuthority.key_id
      : null,
    verifier_program_digest: invocation.verifier_program_digest,
    verifier_config_digest: invocation.verifier_config_digest,
    verifier_environment_digest: invocation.verifier_environment_digest,
    verified_state_snapshot_id: invocation.target_state_snapshot_id,
    target_state_snapshot_algorithm_version:
      invocation.target_state_snapshot_algorithm_version,
    verifier_input_artifact_id: invocation.verifier_input_ref.artifact_id,
    invocation_sha256: verifierInvocationDigest(invocation),
    invoked_at: invocation.invoked_at,
  };
}

function outcomeExpectedRow(
  args: {
    tenantId: string;
    scope: string;
    outcome: VerifierOutcomeReceiptV1;
  },
): Readonly<Record<string, unknown>> {
  const outcome = VerifierOutcomeReceiptV1Schema.parse(args.outcome);
  const attestation = outcome.attestation;
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    episode_id: outcome.episode_id,
    verifier_receipt_id: outcome.verifier_receipt_id,
    verifier_invocation_id: outcome.verifier_invocation_id,
    verifier_id: outcome.verifier_id,
    verifier_definition_sha256: outcome.verifier_definition_sha256,
    verifier_kind: outcome.verifier_kind,
    verifier_version: outcome.verifier_version,
    verifier_issuer_id: outcome.verifier_issuer_id,
    verifier_runner_instance_id: outcome.verifier_runner_instance_id,
    attestation_kind: attestation.kind,
    runtime_launch_sha256: attestation.kind === "runtime_launched"
      ? attestation.runtime_launch_sha256
      : null,
    principal_id: attestation.kind === "trusted_runner_signature"
      ? attestation.principal_id
      : null,
    key_id: attestation.kind === "trusted_runner_signature"
      ? attestation.key_id
      : null,
    signed_payload_digest: attestation.kind === "runtime_launched"
      ? null
      : attestation.signed_payload_digest,
    signature: attestation.kind === "runtime_launched"
      ? null
      : attestation.signature,
    verifier_program_digest: outcome.verifier_program_digest,
    verifier_config_digest: outcome.verifier_config_digest,
    verifier_environment_digest: outcome.verifier_environment_digest,
    verified_state_snapshot_id: outcome.verified_state_snapshot_id,
    verified_state_snapshot_algorithm_version:
      outcome.verified_state_snapshot_algorithm_version,
    verifier_input_artifact_id: outcome.verifier_input_ref.artifact_id,
    verifier_output_artifact_id: outcome.verifier_output_ref.artifact_id,
    evidence_digest: outcome.evidence_digest,
    execution_exit_code: outcome.execution_exit_code,
    status: outcome.status,
    infrastructure_failure_reasons_json:
      canonicalJson(outcome.infrastructure_failure_reasons),
    infrastructure_failure_attribution:
      outcome.infrastructure_failure_attribution,
    receipt_sha256: verifierOutcomeReceiptDigest(outcome),
    completed_at: outcome.completed_at,
  };
}

function canonicalBase64Bytes(value: string): Buffer | null {
  if (value.length % 4 !== 0 || !CANONICAL_BASE64_PATTERN.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

function trustedRunnerKeyIdentity(principalId: string, keyId: string): string {
  return `${principalId}\u0000${keyId}`;
}

function assertTrustedRunnerSignature(
  outcome: VerifierOutcomeReceiptV1,
  options: LiteExecutionEpisodeStoreOptions,
): void {
  if (outcome.attestation.kind !== "trusted_runner_signature") return;
  const key = options.trustedRunnerPublicKeys?.get(trustedRunnerKeyIdentity(
    outcome.attestation.principal_id,
    outcome.attestation.key_id,
  ));
  if (!key) {
    throw new Error("execution_verifier_trusted_runner_key_missing");
  }
  const signature = canonicalBase64Bytes(outcome.attestation.signature);
  if (!signature) {
    throw new Error("execution_verifier_signature_not_canonical_base64");
  }
  let publicKey: KeyObject;
  try {
    publicKey = key instanceof KeyObject ? key : createPublicKey(key);
  } catch {
    throw new Error("execution_verifier_trusted_runner_key_invalid");
  }
  const message = Buffer.from(
    outcome.attestation.signed_payload_digest,
    "hex",
  );
  if (
    message.byteLength !== 32
    || !verifySignature(null, message, publicKey, signature)
  ) {
    throw new Error("execution_verifier_signature_invalid");
  }
}

function assertPersistedInterruptedRuntimeExecutionEvidence(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    invocation: VerifierInvocationV1;
    outcome: VerifierOutcomeReceiptV1;
  }>,
): boolean {
  if (
    args.outcome.attestation.kind !== "runtime_launched"
    || args.outcome.status !== "infrastructure_error"
    || args.outcome.infrastructure_failure_attribution !== "arm_caused"
    || args.outcome.execution_exit_code !== null
  ) {
    return false;
  }
  const row = db.prepare(
    `SELECT attempt.*
     FROM lite_execution_verifier_launch_attempt_events AS terminal
     JOIN lite_execution_verifier_launch_attempts AS attempt
       ON attempt.tenant_id = terminal.tenant_id
      AND attempt.scope = terminal.scope
      AND attempt.episode_id = terminal.episode_id
      AND attempt.verifier_invocation_id =
        terminal.verifier_invocation_id
      AND attempt.launch_attempt_id = terminal.launch_attempt_id
     WHERE terminal.tenant_id = ? AND terminal.scope = ?
       AND terminal.episode_id = ?
       AND terminal.verifier_invocation_id = ?
       AND terminal.event_kind = 'interrupted'
       AND terminal.event_sha256 = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.invocation.episode_id,
    args.invocation.verifier_invocation_id,
    args.outcome.attestation.runtime_launch_sha256,
  ) as SqlRow | undefined;
  if (!row) return false;
  const attempt = launchAttemptFromRow(row);
  const events = launchEventsForAttempt(db, attempt);
  const terminal = events.at(-1);
  if (
    !terminal
    || terminal.payload.event_kind !== "interrupted"
    || terminal.event_sha256
      !== args.outcome.attestation.runtime_launch_sha256
    || terminal.recorded_at !== args.outcome.completed_at
    || terminal.payload.verifier_output_artifact_id
      !== args.outcome.verifier_output_ref.artifact_id
    || terminal.payload.verifier_output_sha256
      !== args.outcome.verifier_output_ref.sha256
    || terminal.payload.runtime_launch_sha256 !== null
    || terminal.payload.result_sha256 !== null
    || terminal.payload.effective_status !== "infrastructure_error"
    || terminal.payload.infrastructure_failure_attribution
      !== "arm_caused"
    || canonicalJson(
      terminal.payload.infrastructure_failure_reasons,
    ) !== canonicalJson(
      args.outcome.infrastructure_failure_reasons,
    )
    || attempt.invocation_sha256
      !== verifierInvocationDigest(args.invocation)
    || attempt.verifier_definition_sha256
      !== args.invocation.verifier_definition_sha256
    || attempt.verifier_program_digest
      !== args.invocation.verifier_program_digest
    || attempt.verifier_config_digest
      !== args.invocation.verifier_config_digest
    || attempt.verifier_environment_digest
      !== args.invocation.verifier_environment_digest
  ) {
    throw new Error(
      "execution_verifier_interrupted_runtime_binding_mismatch",
    );
  }
  const artifact = db.prepare(
    `SELECT blob.content_bytes
     FROM lite_runtime_evidence_artifacts AS artifact
     JOIN lite_runtime_evidence_blobs AS blob
       ON blob.tenant_id = artifact.tenant_id
      AND blob.blob_sha256 = artifact.sha256
     WHERE artifact.tenant_id = ? AND artifact.scope = ?
       AND artifact.episode_id = ? AND artifact.artifact_id = ?
       AND artifact.kind = 'verifier_output'
       AND artifact.sha256 = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.invocation.episode_id,
    args.outcome.verifier_output_ref.artifact_id,
    args.outcome.verifier_output_ref.sha256,
  ) as { content_bytes: Uint8Array } | undefined;
  if (!artifact) {
    throw new Error(
      "execution_verifier_interrupted_output_artifact_missing",
    );
  }
  const raw = Buffer.from(artifact.content_bytes).toString("utf8");
  const parsed = parseCanonicalJson(
    raw,
    "execution_verifier_interrupted_output_evidence",
  ) as Partial<RuntimeEpisodeVerifierInterruptedLaunchEvidenceV1>;
  const observedEvents = events.slice(0, -1);
  const expectedReason =
    terminal.payload.infrastructure_failure_reasons[0];
  const ownerAborted =
    expectedReason
      === "runtime_episode_verifier_owner_aborted_before_result";
  if (
    parsed.contract_version
      !== "runtime_episode_verifier_interrupted_launch_evidence_v1"
    || canonicalJson(parsed.attempt) !== canonicalJson(attempt)
    || canonicalJson(parsed.observed_events)
      !== canonicalJson(observedEvents)
    || parsed.terminal_reason !== expectedReason
    || parsed.recovery_instance_id
      !== terminal.event_owner_instance_id
    || parsed.recovery_process_id
      !== terminal.event_owner_process_id
    || parsed.recovered_at !== terminal.recorded_at
    || (
      ownerAborted
        ? (
          terminal.event_owner_instance_id !== attempt.owner_instance_id
          || terminal.event_owner_process_id !== attempt.owner_process_id
        )
        : terminal.event_owner_instance_id === attempt.owner_instance_id
    )
  ) {
    throw new Error(
      "execution_verifier_interrupted_output_evidence_invalid",
    );
  }
  return true;
}

function assertRuntimeExecutionEvidence(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    invocation: VerifierInvocationV1;
    outcome: VerifierOutcomeReceiptV1;
    options: LiteExecutionEpisodeStoreOptions;
    runtimeExecutionEvidence?: RuntimeEpisodeVerifierLaunchV1;
  },
): void {
  if (args.invocation.launch_authority.kind !== "runtime_launched") {
    if (args.runtimeExecutionEvidence !== undefined) {
      throw new Error(
        "execution_verifier_runtime_evidence_for_trusted_runner_forbidden",
      );
    }
    return;
  }
  const launch = args.runtimeExecutionEvidence;
  if (!launch) {
    if (assertPersistedInterruptedRuntimeExecutionEvidence(db, args)) {
      return;
    }
    throw new Error("execution_verifier_runtime_execution_evidence_required");
  }
  const authorityVerifier =
    args.options.verifierInvocationAuthorityVerifier;
  if (!authorityVerifier) {
    throw new Error(
      "execution_verifier_invocation_authority_channel_unavailable",
    );
  }
  const evidence = assertAuthenticRuntimeEpisodeVerifierLaunchEvidence(
    launch,
    authorityVerifier,
  );
  const identity = evidence.definition_identity;
  const launchIdentity = evidence.launch_identity;
  const result = evidence.result;
  assertAuthenticEpisodeVerifierExecution(result);
  if (
    identity.verifier_id !== args.invocation.verifier_id
    || identity.definition_sha256
      !== args.invocation.verifier_definition_sha256
    || identity.verifier_kind !== args.invocation.verifier_kind
    || identity.verifier_version !== args.invocation.verifier_version
    || identity.verifier_issuer_id !== args.invocation.verifier_issuer_id
    || identity.verifier_config_digest
      !== args.invocation.verifier_config_digest
    || identity.verifier_program_digest
      !== args.invocation.verifier_program_digest
    || (
      identity.reward_role === "diagnostic"
      && args.invocation.verifier_kind !== "llm_judge_diagnostic"
    )
    || (
      identity.reward_role === "primary"
      && args.invocation.verifier_kind === "llm_judge_diagnostic"
    )
  ) {
    throw new Error(
      "execution_verifier_registry_definition_binding_mismatch",
    );
  }
  if (
    launchIdentity.episode_id !== args.invocation.episode_id
    || launchIdentity.verifier_invocation_id
      !== args.invocation.verifier_invocation_id
    || launchIdentity.verifier_invocation_digest
      !== verifierInvocationDigest(args.invocation)
    || launchIdentity.verifier_id !== args.invocation.verifier_id
    || launchIdentity.verifier_definition_sha256
      !== args.invocation.verifier_definition_sha256
    || launchIdentity.verifier_program_digest
      !== args.invocation.verifier_program_digest
    || launchIdentity.verifier_config_digest
      !== args.invocation.verifier_config_digest
    || launchIdentity.verifier_environment_digest
      !== args.invocation.verifier_environment_digest
    || launchIdentity.source_environment_digest
      !== args.invocation.verifier_environment_digest
    || result.config_sha256 !== launchIdentity.resolved_config_digest
    || args.outcome.attestation.kind !== "runtime_launched"
    || args.outcome.attestation.runtime_launch_sha256
      !== launchIdentity.launch_sha256
    || args.outcome.status !== launch.effective_status
    || canonicalJson(args.outcome.infrastructure_failure_reasons)
      !== canonicalJson(launch.infrastructure_failure_reasons)
    || args.outcome.infrastructure_failure_attribution
      !== runtimeEpisodeVerifierFailureAttribution(launch)
    || args.outcome.execution_exit_code !== result.exit_code
    || args.outcome.completed_at !== result.completed_at
    || Date.parse(result.started_at) < Date.parse(args.invocation.invoked_at)
  ) {
    throw new Error("execution_verifier_runtime_execution_binding_mismatch");
  }
  const target = db.prepare(
    `SELECT snapshot.content_digest, snapshot.environment_digest,
            episode.subject_identity_sha256
     FROM lite_execution_state_snapshots AS snapshot
     JOIN lite_execution_episodes AS episode
       ON episode.tenant_id = snapshot.tenant_id
      AND episode.scope = snapshot.scope
      AND episode.episode_id = snapshot.episode_id
     WHERE snapshot.tenant_id = ? AND snapshot.scope = ?
       AND snapshot.episode_id = ? AND snapshot.snapshot_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.invocation.episode_id,
    args.invocation.target_state_snapshot_id,
  ) as {
    content_digest: string;
    environment_digest: string;
    subject_identity_sha256: string;
  } | undefined;
  if (
    !target
    || launchIdentity.source_content_digest !== target.content_digest
    || launchIdentity.source_environment_digest !== target.environment_digest
    || launchIdentity.subject_identity_sha256
      !== target.subject_identity_sha256
  ) {
    throw new Error("execution_verifier_runtime_subject_binding_mismatch");
  }
  if (
    args.outcome.verifier_program_digest
      !== args.invocation.verifier_program_digest
    || identity.verifier_program_digest
      !== args.outcome.verifier_program_digest
  ) {
    throw new Error("execution_verifier_program_digest_mismatch");
  }
  const row = db.prepare(
    `SELECT blob.content_bytes
     FROM lite_runtime_evidence_artifacts AS artifact
     JOIN lite_runtime_evidence_blobs AS blob
       ON blob.tenant_id = artifact.tenant_id
      AND blob.blob_sha256 = artifact.sha256
     WHERE artifact.tenant_id = ? AND artifact.scope = ?
       AND artifact.episode_id = ? AND artifact.artifact_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.invocation.episode_id,
    args.outcome.verifier_output_ref.artifact_id,
  ) as { content_bytes: Uint8Array } | undefined;
  const expectedOutput = Buffer.from(
    canonicalJson(runtimeEpisodeVerifierExecutionEvidence(launch)),
    "utf8",
  );
  if (
    !row
    || !Buffer.from(row.content_bytes).equals(expectedOutput)
    || args.outcome.verifier_output_ref.sha256 !== sha256Hex(
      expectedOutput.toString("utf8"),
    )
  ) {
    throw new Error("execution_verifier_output_artifact_mismatch");
  }
}

function assertVerifierInvocationOperationBindsInvocation(
  operation: OperationRow,
  invocation: VerifierInvocationV1,
): void {
  const invocationSha256 = verifierInvocationDigest(invocation);
  if (
    operation.operation_kind
      !== LITE_EXECUTION_EPISODE_OPERATION_KIND.verifierInvocation
    || operation.operation_id !== invocation.verifier_invocation_id
    || operation.request_sha256 !== invocationSha256
    || operation.created_at !== invocation.invoked_at
    || operation.receipt_json
      !== verifierInvocationOperationReceiptJson(invocation)
  ) {
    throw new Error(
      "execution_verifier_invocation_operation_receipt_mismatch",
    );
  }
  const parsed = parseCanonicalJson(
    operation.receipt_json,
    "execution_verifier_invocation_operation_receipt",
  ) as Partial<VerifierInvocationOperationReceipt>;
  if (
    parsed.contract_version
      !== "execution_episode_verifier_invocation_operation_receipt_v1"
    || parsed.invocation_sha256 !== invocationSha256
    || canonicalJson(parsed.invocation) !== canonicalJson(invocation)
  ) {
    throw new Error(
      "execution_verifier_invocation_operation_receipt_invalid",
    );
  }
}

function assertPersistedVerifierInvocation(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    invocation: VerifierInvocationV1;
  },
): void {
  const expected = invocationExpectedRow(args);
  const row = db.prepare(
    `SELECT * FROM lite_execution_verifier_invocations
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND verifier_invocation_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.invocation.episode_id,
    args.invocation.verifier_invocation_id,
  ) as SqlRow | undefined;
  if (!row) {
    throw new Error("execution_verifier_invocation_not_reserved");
  }
  assertExactFields(row, expected, "execution_verifier_invocation");
  const operation = operationRow(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind:
      LITE_EXECUTION_EPISODE_OPERATION_KIND.verifierInvocation,
    operationId: args.invocation.verifier_invocation_id,
  });
  if (!operation) {
    throw new Error(
      "execution_verifier_invocation_operation_authority_missing",
    );
  }
  assertVerifierInvocationOperationBindsInvocation(
    operation,
    args.invocation,
  );
}

function loadPersistedVerifierInvocation(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    verifierInvocationId: string;
  }>,
): VerifierInvocationV1 {
  const operation = operationRow(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind:
      LITE_EXECUTION_EPISODE_OPERATION_KIND.verifierInvocation,
    operationId: args.verifierInvocationId,
  });
  if (!operation) {
    throw new Error(
      "execution_verifier_invocation_operation_authority_missing",
    );
  }
  const parsed = parseCanonicalJson(
    operation.receipt_json,
    "execution_verifier_invocation_operation_receipt",
  ) as Partial<VerifierInvocationOperationReceipt>;
  if (
    parsed.contract_version
      !== "execution_episode_verifier_invocation_operation_receipt_v1"
  ) {
    throw new Error(
      "execution_verifier_invocation_operation_receipt_invalid",
    );
  }
  const invocation = VerifierInvocationV1Schema.parse(parsed.invocation);
  if (
    invocation.episode_id !== args.episodeId
    || invocation.verifier_invocation_id !== args.verifierInvocationId
    || parsed.invocation_sha256 !== verifierInvocationDigest(invocation)
  ) {
    throw new Error(
      "execution_verifier_invocation_operation_receipt_invalid",
    );
  }
  assertPersistedVerifierInvocation(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    invocation,
  });
  return invocation;
}

function ensureVerifierProjection(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    invocation: VerifierInvocationV1;
    outcome: VerifierOutcomeReceiptV1;
    options: LiteExecutionEpisodeStoreOptions;
    runtimeExecutionEvidence?: RuntimeEpisodeVerifierLaunchV1;
  },
): void {
  const invocation = VerifierInvocationV1Schema.parse(args.invocation);
  const outcome = VerifierOutcomeReceiptV1Schema.parse(args.outcome);
  assertTrustedRunnerSignature(outcome, args.options);
  assertRuntimeExecutionEvidence(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    invocation,
    outcome,
    options: args.options,
    runtimeExecutionEvidence: args.runtimeExecutionEvidence,
  });
  assertArtifactRef(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: invocation.episode_id,
    ref: invocation.verifier_input_ref,
  });
  assertArtifactRef(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: invocation.episode_id,
    ref: outcome.verifier_output_ref,
  });
  assertPersistedVerifierInvocation(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    invocation,
  });

  const outcomeExpected = outcomeExpectedRow({
    tenantId: args.tenantId,
    scope: args.scope,
    outcome,
  });
  const outcomeRow = db.prepare(
    `SELECT * FROM lite_execution_verifier_receipts
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND verifier_receipt_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    outcome.episode_id,
    outcome.verifier_receipt_id,
  ) as SqlRow | undefined;
  if (outcomeRow) {
    assertExactFields(
      outcomeRow,
      outcomeExpected,
      "execution_verifier_receipt",
    );
  } else {
    db.prepare(
      `INSERT INTO lite_execution_verifier_receipts
         (tenant_id, scope, episode_id, verifier_receipt_id,
          verifier_invocation_id, verifier_id, verifier_definition_sha256,
          verifier_kind, verifier_version, verifier_issuer_id,
          verifier_runner_instance_id, attestation_kind,
          runtime_launch_sha256, principal_id, key_id,
          signed_payload_digest, signature, verifier_program_digest,
          verifier_config_digest, verifier_environment_digest,
          verified_state_snapshot_id,
          verified_state_snapshot_algorithm_version,
          verifier_input_artifact_id, verifier_output_artifact_id,
          evidence_digest, execution_exit_code, status,
          infrastructure_failure_reasons_json,
          infrastructure_failure_attribution, receipt_sha256, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...Object.values(outcomeExpected));
  }
}

function rewardExpectedRow(
  args: {
    tenantId: string;
    scope: string;
    eventId: string;
    reward: EpisodeRewardV1;
    createdAt: string;
  },
): Readonly<Record<string, unknown>> {
  const reward = EpisodeRewardV1Schema.parse(args.reward);
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    episode_id: reward.episode_id,
    reward_id: reward.reward_id,
    close_event_id: args.eventId,
    reward_contract_version: reward.reward_contract_version,
    verified_success: reward.verified_success,
    outcome_class: reward.outcome_class,
    reward_authority: reward.reward_authority,
    final_state_snapshot_id: reward.final_state_snapshot_id ?? null,
    verifier_receipt_id: reward.verifier_receipt_id ?? null,
    token_count: reward.token_count,
    token_usage_authority: reward.token_usage_authority,
    token_usage_artifact_id: reward.token_usage_ref?.artifact_id ?? null,
    tool_call_count: reward.tool_call_count,
    elapsed_ms: reward.elapsed_ms,
    outcome_reasons_json: canonicalJson(reward.outcome_reasons),
    contamination_json: canonicalJson(reward.contamination_reasons),
    reward_sha256: episodeRewardDigest(reward),
    created_at: args.createdAt,
  };
}

function ensureReward(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    eventId: string;
    reward: EpisodeRewardV1;
    createdAt: string;
  },
): void {
  const expected = rewardExpectedRow(args);
  const reward = EpisodeRewardV1Schema.parse(args.reward);
  if (reward.token_usage_ref) {
    assertArtifactRef(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId: reward.episode_id,
      ref: reward.token_usage_ref,
    });
  }
  const existing = db.prepare(
    `SELECT * FROM lite_execution_episode_rewards
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
  ).get(args.tenantId, args.scope, reward.episode_id) as SqlRow | undefined;
  if (existing) {
    assertExactFields(existing, expected, "execution_episode_reward");
    return;
  }
  db.prepare(
    `INSERT INTO lite_execution_episode_rewards
       (tenant_id, scope, episode_id, reward_id, close_event_id,
        reward_contract_version, verified_success, outcome_class,
        reward_authority, final_state_snapshot_id, verifier_receipt_id,
        token_count, token_usage_authority, token_usage_artifact_id,
        tool_call_count, elapsed_ms, outcome_reasons_json, contamination_json,
        reward_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...Object.values(expected));
}

function currentStateSnapshotId(
  db: SqliteDatabase,
  args: { tenantId: string; scope: string; episodeId: string },
): string {
  const row = db.prepare(
    `SELECT COALESCE((
       SELECT state_after_snapshot_id
       FROM lite_execution_episode_events
       WHERE tenant_id = ? AND scope = ? AND episode_id = ?
         AND event_kind = 'action_observed'
       ORDER BY episode_sequence DESC
       LIMIT 1
     ), (
       SELECT initial_state_snapshot_id
       FROM lite_execution_episodes
       WHERE tenant_id = ? AND scope = ? AND episode_id = ?
     )) AS snapshot_id`,
  ).get(
    args.tenantId,
    args.scope,
    args.episodeId,
    args.tenantId,
    args.scope,
    args.episodeId,
  ) as { snapshot_id: string | null } | undefined;
  if (!row?.snapshot_id) {
    throw new Error("execution_episode_current_state_missing");
  }
  return row.snapshot_id;
}

function storedStateSnapshot(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    episodeId: string;
    snapshotId: string;
  },
): StateSnapshotV1 {
  const row = db.prepare(
    `SELECT snapshot.*, artifact.artifact_id, artifact.kind, artifact.sha256,
            artifact.storage_ref, artifact.byte_length, artifact.media_type,
            artifact.encoding, artifact.redaction_policy,
            artifact.retention_policy
     FROM lite_execution_state_snapshots AS snapshot
     JOIN lite_runtime_evidence_artifacts AS artifact
       ON artifact.tenant_id = snapshot.tenant_id
      AND artifact.scope = snapshot.scope
      AND artifact.episode_id = snapshot.episode_id
      AND artifact.artifact_id = snapshot.artifact_id
     WHERE snapshot.tenant_id = ? AND snapshot.scope = ?
       AND snapshot.episode_id = ? AND snapshot.snapshot_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.episodeId,
    args.snapshotId,
  ) as SqlRow | undefined;
  if (!row) throw new Error("execution_state_snapshot_projection_missing");
  const value = StateSnapshotV1Schema.parse({
    contract_version: "state_snapshot_v1",
    snapshot_id: requiredString(row, "snapshot_id"),
    algorithm_id: requiredString(row, "algorithm_id"),
    algorithm_version: requiredString(row, "algorithm_version"),
    state_kind: requiredString(row, "state_kind"),
    environment_digest: requiredString(row, "environment_digest"),
    content_digest: requiredString(row, "content_digest"),
    artifact_ref: artifactRefFromRow(row),
    captured_at: requiredString(row, "captured_at"),
  });
  assertExactFields(row, snapshotExpectedRow({
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.episodeId,
    snapshot: value,
  }), "execution_state_snapshot");
  return value;
}

function episodeToolCallCount(
  db: SqliteDatabase,
  args: { tenantId: string; scope: string; episodeId: string },
): number {
  const rows = db.prepare(
    `SELECT payload_json
     FROM lite_execution_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND event_kind = 'action_observed'
     ORDER BY episode_sequence`,
  ).all(args.tenantId, args.scope, args.episodeId) as Array<{
    payload_json: string;
  }>;
  let count = 0;
  for (const row of rows) {
    const payload = ExecutionEpisodeEventPayloadV1Schema.parse(
      parseCanonicalJson(row.payload_json, "execution_episode_payload"),
    );
    if (
      payload.event_kind !== "action_observed"
    ) {
      throw new Error("execution_episode_action_projection_mismatch");
    }
    if (payload.action.tool_name !== undefined) count += 1;
  }
  return count;
}

function assertCloseRewardAuthority(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    reward: EpisodeRewardV1;
  },
): void {
  const reward = EpisodeRewardV1Schema.parse(args.reward);
  const currentState = currentStateSnapshotId(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: reward.episode_id,
  });
  if (
    reward.final_state_snapshot_id !== undefined
    && reward.final_state_snapshot_id !== currentState
  ) {
    throw new Error("execution_episode_close_state_stale");
  }
  if (reward.verifier_receipt_id === undefined) return;
  const row = db.prepare(
    `SELECT receipt.verified_state_snapshot_id, receipt.status,
            receipt.verifier_kind, event.event_id
     FROM lite_execution_verifier_receipts AS receipt
     JOIN lite_execution_episode_events AS event
       ON event.tenant_id = receipt.tenant_id
      AND event.scope = receipt.scope
      AND event.episode_id = receipt.episode_id
      AND event.verifier_receipt_id = receipt.verifier_receipt_id
      AND event.event_kind = 'verifier_recorded'
     WHERE receipt.tenant_id = ? AND receipt.scope = ?
       AND receipt.episode_id = ? AND receipt.verifier_receipt_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    reward.episode_id,
    reward.verifier_receipt_id,
  ) as SqlRow | undefined;
  if (!row) throw new Error("execution_episode_close_verifier_missing");
  if (requiredString(row, "verified_state_snapshot_id") !== currentState) {
    throw new Error("execution_episode_close_verifier_stale");
  }
  const status = requiredString(row, "status");
  if (
    (reward.outcome_class === "verified_pass" && status !== "passed")
    || (reward.outcome_class === "verified_failure" && status !== "failed")
  ) {
    throw new Error("execution_episode_close_verifier_status_mismatch");
  }
  if (
    reward.verified_success !== null
    && requiredString(row, "verifier_kind") === "llm_judge_diagnostic"
  ) {
    throw new Error("execution_episode_diagnostic_verifier_not_primary_reward");
  }
}

function eventProjectionColumns(
  payload: ExecutionEpisodeEventPayloadV1,
): Readonly<{
  decisionId: string | null;
  actionId: string | null;
  stateBeforeSnapshotId: string | null;
  stateAfterSnapshotId: string | null;
  actionMutation: number | null;
  verifierReceiptId: string | null;
  rewardId: string | null;
}> {
  switch (payload.event_kind) {
    case "episode_started":
      return {
        decisionId: null,
        actionId: null,
        stateBeforeSnapshotId: null,
        stateAfterSnapshotId: null,
        actionMutation: null,
        verifierReceiptId: null,
        rewardId: null,
      };
    case "semantic_observation_recorded":
    case "agent_decision_recorded":
    case "progress_state_recorded":
    case "planned_action_recorded":
      return {
        decisionId: null,
        actionId: null,
        stateBeforeSnapshotId: null,
        stateAfterSnapshotId: null,
        actionMutation: null,
        verifierReceiptId: null,
        rewardId: null,
      };
    case "decision_committed":
      return {
        decisionId: payload.decision.decision_id,
        actionId: null,
        stateBeforeSnapshotId: null,
        stateAfterSnapshotId: null,
        actionMutation: null,
        verifierReceiptId: null,
        rewardId: null,
      };
    case "action_observed":
      return {
        decisionId: null,
        actionId: payload.action.action_id,
        stateBeforeSnapshotId: payload.action.state_before_snapshot_id,
        stateAfterSnapshotId: payload.action.state_after_snapshot_id,
        actionMutation: payload.action.mutation ? 1 : 0,
        verifierReceiptId: null,
        rewardId: null,
      };
    case "verifier_recorded":
      return {
        decisionId: null,
        actionId: null,
        stateBeforeSnapshotId: null,
        stateAfterSnapshotId: null,
        actionMutation: null,
        verifierReceiptId: payload.outcome.verifier_receipt_id,
        rewardId: null,
      };
    case "episode_closed":
      return {
        decisionId: null,
        actionId: null,
        stateBeforeSnapshotId: null,
        stateAfterSnapshotId: null,
        actionMutation: null,
        verifierReceiptId: null,
        rewardId: payload.reward.reward_id,
      };
  }
}

function eventRowFromUnknown(row: SqlRow): EventRow {
  const eventKind = requiredString(row, "event_kind");
  if (![
    "episode_started",
    "decision_committed",
    "action_observed",
    "semantic_observation_recorded",
    "agent_decision_recorded",
    "progress_state_recorded",
    "planned_action_recorded",
    "verifier_recorded",
    "episode_closed",
  ].includes(eventKind)) {
    throw new Error("execution_episode_event_kind_invalid");
  }
  return {
    tenant_id: requiredString(row, "tenant_id"),
    scope: requiredString(row, "scope"),
    episode_id: requiredString(row, "episode_id"),
    event_id: requiredString(row, "event_id"),
    episode_sequence: requiredInteger(row, "episode_sequence"),
    event_kind: eventKind as EventRow["event_kind"],
    operation_kind: requiredString(row, "operation_kind"),
    operation_id: requiredString(row, "operation_id"),
    request_sha256: requiredString(row, "request_sha256"),
    previous_event_sha256: nullableString(row, "previous_event_sha256"),
    event_sha256: requiredString(row, "event_sha256"),
    payload_sha256: requiredString(row, "payload_sha256"),
    payload_json: requiredString(row, "payload_json"),
    decision_id: nullableString(row, "decision_id"),
    action_id: nullableString(row, "action_id"),
    state_before_snapshot_id: nullableString(row, "state_before_snapshot_id"),
    state_after_snapshot_id: nullableString(row, "state_after_snapshot_id"),
    action_mutation: nullableInteger(row, "action_mutation"),
    verifier_receipt_id: nullableString(row, "verifier_receipt_id"),
    reward_id: nullableString(row, "reward_id"),
    recorded_at: requiredString(row, "recorded_at"),
  };
}

function envelopeFromEventRow(rowInput: SqlRow): ExecutionEpisodeEventEnvelopeV1 {
  const row = eventRowFromUnknown(rowInput);
  const payloadValue = parseCanonicalJson(
    row.payload_json,
    "execution_episode_payload",
  );
  const payload = ExecutionEpisodeEventPayloadV1Schema.parse(payloadValue);
  if (executionEpisodeEventPayloadDigest(payload) !== row.payload_sha256) {
    throw new Error("execution_episode_payload_digest_mismatch");
  }
  const envelope = ExecutionEpisodeEventEnvelopeV1Schema.parse({
    contract_version: "execution_episode_event_v1",
    event_id: row.event_id,
    episode_id: row.episode_id,
    operation_kind: row.operation_kind,
    operation_id: row.operation_id,
    request_sha256: row.request_sha256,
    sequence: row.episode_sequence,
    previous_event_sha256: row.previous_event_sha256,
    payload,
    payload_sha256: row.payload_sha256,
    event_sha256: row.event_sha256,
    occurred_at: row.recorded_at,
  });
  if (
    row.event_kind !== payload.event_kind
    || row.recorded_at !== eventOccurredAt(payload)
  ) {
    throw new Error("execution_episode_event_projection_mismatch");
  }
  const projection = eventProjectionColumns(payload);
  assertExactFields(row as unknown as SqlRow, {
    decision_id: projection.decisionId,
    action_id: projection.actionId,
    state_before_snapshot_id: projection.stateBeforeSnapshotId,
    state_after_snapshot_id: projection.stateAfterSnapshotId,
    action_mutation: projection.actionMutation,
    verifier_receipt_id: projection.verifierReceiptId,
    reward_id: projection.rewardId,
  }, "execution_episode_event");
  return envelope;
}

function operationRow(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    operationKind: string;
    operationId: string;
  },
): OperationRow | null {
  return (db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at
     FROM lite_runtime_write_operations
     WHERE tenant_id = ? AND scope = ? AND operation_kind = ?
       AND operation_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.operationKind,
    args.operationId,
  ) as OperationRow | undefined) ?? null;
}

function eventByOperation(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    operationKind: string;
    operationId: string;
  },
): ExecutionEpisodeEventEnvelopeV1 | null {
  const row = db.prepare(
    `SELECT *
     FROM lite_execution_episode_events
     WHERE tenant_id = ? AND scope = ? AND operation_kind = ?
       AND operation_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.operationKind,
    args.operationId,
  ) as SqlRow | undefined;
  return row ? envelopeFromEventRow(row) : null;
}

function assertOperationBindsEvent(
  operation: OperationRow,
  event: ExecutionEpisodeEventEnvelopeV1,
): void {
  if (
    operation.request_sha256 !== event.payload_sha256
    || operation.created_at !== event.occurred_at
    || operation.receipt_json !== operationReceiptJson(event)
  ) {
    throw new Error("execution_episode_operation_receipt_mismatch");
  }
  const parsed = parseCanonicalJson(
    operation.receipt_json,
    "execution_episode_operation_receipt",
  ) as Partial<OperationReceipt>;
  if (
    parsed.contract_version !== "execution_episode_operation_receipt_v1"
    || canonicalJson(parsed.event) !== canonicalJson(event)
  ) {
    throw new Error("execution_episode_operation_receipt_invalid");
  }
}

function eventHead(
  db: SqliteDatabase,
  args: { tenantId: string; scope: string; episodeId: string },
): EventHead | null {
  return (db.prepare(
    `SELECT episode_sequence, event_sha256, recorded_at
     FROM lite_execution_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
     ORDER BY episode_sequence DESC
     LIMIT 1`,
  ).get(args.tenantId, args.scope, args.episodeId) as EventHead | undefined)
    ?? null;
}

function actionCount(
  db: SqliteDatabase,
  args: { tenantId: string; scope: string; episodeId: string },
): number {
  const row = db.prepare(
    `SELECT count(*) AS count
     FROM lite_execution_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND event_kind = 'action_observed'`,
  ).get(args.tenantId, args.scope, args.episodeId) as { count: number };
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("execution_episode_action_count_invalid");
  }
  return count;
}

function assertEpisodeOpen(
  db: SqliteDatabase,
  args: { tenantId: string; scope: string; episodeId: string },
): void {
  const row = db.prepare(
    `SELECT 1 AS present
     FROM lite_execution_episodes
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
  ).get(args.tenantId, args.scope, args.episodeId);
  if (!row) throw new Error("execution_episode_missing");
  const closed = db.prepare(
    `SELECT 1 AS present
     FROM lite_execution_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND event_kind = 'episode_closed'`,
  ).get(args.tenantId, args.scope, args.episodeId);
  if (closed) throw new Error("execution_episode_already_closed");
}

function insertEventRow(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    event: ExecutionEpisodeEventEnvelopeV1;
  },
): void {
  const event = ExecutionEpisodeEventEnvelopeV1Schema.parse(args.event);
  const payloadJson = canonicalJson(event.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error("execution_episode_payload_too_large");
  }
  const projection = eventProjectionColumns(event.payload);
  db.prepare(
    `INSERT INTO lite_execution_episode_events
       (tenant_id, scope, episode_id, event_id, episode_sequence, event_kind,
        operation_kind, operation_id, request_sha256, previous_event_sha256,
        event_sha256, payload_sha256, payload_json, decision_id, action_id,
        state_before_snapshot_id, state_after_snapshot_id, action_mutation,
        verifier_receipt_id, reward_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.tenantId,
    args.scope,
    event.episode_id,
    event.event_id,
    event.sequence,
    event.payload.event_kind,
    event.operation_kind,
    event.operation_id,
    event.request_sha256,
    event.previous_event_sha256,
    event.event_sha256,
    event.payload_sha256,
    payloadJson,
    projection.decisionId,
    projection.actionId,
    projection.stateBeforeSnapshotId,
    projection.stateAfterSnapshotId,
    projection.actionMutation,
    projection.verifierReceiptId,
    projection.rewardId,
    event.occurred_at,
  );
}

function insertEventArtifactRefs(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    event: ExecutionEpisodeEventEnvelopeV1;
  },
): void {
  for (const reference of eventArtifactRefs(args.event.payload)) {
    assertArtifactRef(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId: args.event.episode_id,
      ref: reference.ref,
    });
    db.prepare(
      `INSERT INTO lite_execution_event_artifact_refs
         (tenant_id, scope, episode_id, event_id, artifact_id,
          reference_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.tenantId,
      args.scope,
      args.event.episode_id,
      args.event.event_id,
      reference.ref.artifact_id,
      reference.referenceKind,
      args.event.occurred_at,
    );
  }
}

function assertExpectedEventArtifactRefs(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    event: ExecutionEpisodeEventEnvelopeV1;
  },
): void {
  const expected = eventArtifactRefs(args.event.payload);
  const rows = db.prepare(
    `SELECT artifact_id, reference_kind, created_at
     FROM lite_execution_event_artifact_refs
     WHERE tenant_id = ? AND scope = ? AND episode_id = ? AND event_id = ?
     ORDER BY artifact_id, reference_kind`,
  ).all(
    args.tenantId,
    args.scope,
    args.event.episode_id,
    args.event.event_id,
  ) as SqlRow[];
  if (rows.length !== expected.length) {
    throw new Error("execution_episode_event_artifact_membership_mismatch");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const row = rows[index];
    const reference = expected[index];
    if (!row || !reference) {
      throw new Error("execution_episode_event_artifact_membership_mismatch");
    }
    assertExactFields(row, {
      artifact_id: reference.ref.artifact_id,
      reference_kind: reference.referenceKind,
      created_at: args.event.occurred_at,
    }, "execution_episode_event_artifact");
    assertArtifactRef(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId: args.event.episode_id,
      ref: reference.ref,
    });
  }
}

function ensureEventProjections(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    event: ExecutionEpisodeEventEnvelopeV1;
    options: LiteExecutionEpisodeStoreOptions;
    runtimeExecutionEvidence?: RuntimeEpisodeVerifierLaunchV1;
  },
): void {
  const payload = args.event.payload;
  switch (payload.event_kind) {
    case "episode_started":
      ensureStateSnapshot(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: payload.episode.episode_id,
        snapshot: payload.initial_state_snapshot,
      });
      ensureEpisode(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episode: payload.episode,
      });
      break;
    case "decision_committed":
      break;
    case "action_observed":
      ensureStateSnapshot(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: payload.action.episode_id,
        snapshot: payload.state_before_snapshot,
      });
      ensureStateSnapshot(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: payload.action.episode_id,
        snapshot: payload.state_after_snapshot,
      });
      break;
    case "semantic_observation_recorded":
    case "agent_decision_recorded":
    case "progress_state_recorded":
    case "planned_action_recorded":
      break;
    case "verifier_recorded":
      ensureStateSnapshot(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: payload.invocation.episode_id,
        snapshot: payload.verified_state_snapshot,
      });
      ensureVerifierProjection(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        invocation: payload.invocation,
        outcome: payload.outcome,
        options: args.options,
        runtimeExecutionEvidence: args.runtimeExecutionEvidence,
      });
      break;
    case "episode_closed":
      if (payload.final_state_snapshot) {
        ensureStateSnapshot(db, {
          tenantId: args.tenantId,
          scope: args.scope,
          episodeId: payload.reward.episode_id,
          snapshot: payload.final_state_snapshot,
        });
      }
      assertCloseRewardAuthority(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        reward: payload.reward,
      });
      ensureReward(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        eventId: args.event.event_id,
        reward: payload.reward,
        createdAt: payload.closed_at,
      });
      break;
  }
}

function assertStoredEventProjection(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    event: ExecutionEpisodeEventEnvelopeV1;
    options: LiteExecutionEpisodeStoreOptions;
  },
): void {
  const payload = args.event.payload;
  const assertSnapshot = (snapshot: StateSnapshotV1, episodeId: string): void => {
    const row = db.prepare(
      `SELECT * FROM lite_execution_state_snapshots
       WHERE tenant_id = ? AND scope = ? AND episode_id = ?
         AND snapshot_id = ?`,
    ).get(
      args.tenantId,
      args.scope,
      episodeId,
      snapshot.snapshot_id,
    ) as SqlRow | undefined;
    if (!row) throw new Error("execution_state_snapshot_projection_missing");
    assertExactFields(row, snapshotExpectedRow({
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId,
      snapshot,
    }), "execution_state_snapshot");
    assertArtifactRef(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId,
      ref: snapshot.artifact_ref,
    });
  };
  switch (payload.event_kind) {
    case "episode_started": {
      const row = db.prepare(
        `SELECT * FROM lite_execution_episodes
         WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
      ).get(
        args.tenantId,
        args.scope,
        payload.episode.episode_id,
      ) as SqlRow | undefined;
      if (!row) throw new Error("execution_episode_projection_missing");
      assertExactFields(row, episodeExpectedRow({
        tenantId: args.tenantId,
        scope: args.scope,
        episode: payload.episode,
      }), "execution_episode");
      assertSnapshot(
        payload.initial_state_snapshot,
        payload.episode.episode_id,
      );
      assertArtifactRef(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: payload.episode.episode_id,
        ref: payload.episode.task_envelope_ref,
      });
      assertArtifactRef(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: payload.episode.episode_id,
        ref: payload.episode.task_manifest_ref,
      });
      assertArtifactRef(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: payload.episode.episode_id,
        ref: payload.episode.source_task_ref,
      });
      assertArtifactRef(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: payload.episode.episode_id,
        ref: payload.episode.model_config_ref,
      });
      ensureEpisode(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episode: payload.episode,
      });
      break;
    }
    case "decision_committed":
      break;
    case "action_observed":
      assertSnapshot(payload.state_before_snapshot, payload.action.episode_id);
      assertSnapshot(payload.state_after_snapshot, payload.action.episode_id);
      break;
    case "semantic_observation_recorded":
    case "agent_decision_recorded":
    case "progress_state_recorded":
    case "planned_action_recorded":
      break;
    case "verifier_recorded": {
      assertSnapshot(
        payload.verified_state_snapshot,
        payload.invocation.episode_id,
      );
      const invocation = db.prepare(
        `SELECT * FROM lite_execution_verifier_invocations
         WHERE tenant_id = ? AND scope = ? AND episode_id = ?
           AND verifier_invocation_id = ?`,
      ).get(
        args.tenantId,
        args.scope,
        payload.invocation.episode_id,
        payload.invocation.verifier_invocation_id,
      ) as SqlRow | undefined;
      const outcome = db.prepare(
        `SELECT * FROM lite_execution_verifier_receipts
         WHERE tenant_id = ? AND scope = ? AND episode_id = ?
           AND verifier_receipt_id = ?`,
      ).get(
        args.tenantId,
        args.scope,
        payload.outcome.episode_id,
        payload.outcome.verifier_receipt_id,
      ) as SqlRow | undefined;
      if (!invocation || !outcome) {
        throw new Error("execution_verifier_projection_missing");
      }
      assertExactFields(invocation, invocationExpectedRow({
        tenantId: args.tenantId,
        scope: args.scope,
        invocation: payload.invocation,
      }), "execution_verifier_invocation");
      assertExactFields(outcome, outcomeExpectedRow({
        tenantId: args.tenantId,
        scope: args.scope,
        outcome: payload.outcome,
      }), "execution_verifier_receipt");
      assertTrustedRunnerSignature(payload.outcome, args.options);
      break;
    }
    case "episode_closed": {
      if (
        canonicalJson(payload.outcome_details)
          !== canonicalJson(canonicalOutcomeDetails(payload.outcome_details))
      ) {
        throw new Error("execution_episode_close_details_not_canonical");
      }
      if (payload.reward.contamination_reasons.length !== 0) {
        throw new Error(
          "execution_episode_phase1_contamination_not_runtime_derived",
        );
      }
      if (payload.final_state_snapshot) {
        assertSnapshot(
          payload.final_state_snapshot,
          payload.reward.episode_id,
        );
      }
      const row = db.prepare(
        `SELECT * FROM lite_execution_episode_rewards
         WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
      ).get(
        args.tenantId,
        args.scope,
        payload.reward.episode_id,
      ) as SqlRow | undefined;
      if (!row) throw new Error("execution_episode_reward_projection_missing");
      assertExactFields(row, rewardExpectedRow({
        tenantId: args.tenantId,
        scope: args.scope,
        eventId: args.event.event_id,
        reward: payload.reward,
        createdAt: payload.closed_at,
      }), "execution_episode_reward");
      assertCloseRewardAuthority(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        reward: payload.reward,
      });
      break;
    }
  }
  assertExpectedEventArtifactRefs(db, args);
}

function assertEventChainAndActions(
  events: readonly ExecutionEpisodeEventEnvelopeV1[],
): void {
  let previous: ExecutionEpisodeEventEnvelopeV1 | null = null;
  let actionSequence = 0;
  let closed = false;
  let currentStateSnapshotId: string | null = null;
  for (const event of events) {
    if (
      event.sequence !== (previous?.sequence ?? -1) + 1
      || event.previous_event_sha256 !== (previous?.event_sha256 ?? null)
    ) {
      throw new Error("execution_episode_event_chain_invalid");
    }
    if (
      previous !== null
      && Date.parse(event.occurred_at) < Date.parse(previous.occurred_at)
    ) {
      throw new Error("execution_episode_event_time_not_monotonic");
    }
    if (closed) throw new Error("execution_episode_event_after_close");
    switch (event.payload.event_kind) {
      case "episode_started":
        if (currentStateSnapshotId !== null) {
          throw new Error("execution_episode_multiple_start_events");
        }
        currentStateSnapshotId =
          event.payload.initial_state_snapshot.snapshot_id;
        break;
      case "decision_committed":
        if (
          currentStateSnapshotId === null
          || event.payload.decision.target_state_snapshot_id
            !== currentStateSnapshotId
        ) {
          throw new Error(
            "execution_episode_decision_target_state_stale",
          );
        }
        break;
      case "action_observed":
        if (event.payload.action.sequence !== actionSequence) {
          throw new Error("execution_episode_action_sequence_invalid");
        }
        if (
          currentStateSnapshotId === null
          || event.payload.action.state_before_snapshot_id
            !== currentStateSnapshotId
        ) {
          throw new Error("execution_episode_action_state_chain_invalid");
        }
        currentStateSnapshotId =
          event.payload.action.state_after_snapshot_id;
        actionSequence += 1;
        break;
      case "semantic_observation_recorded":
        if (
          currentStateSnapshotId === null
          || event.payload.observation.target_state_snapshot_id
            !== currentStateSnapshotId
          || event.payload.observation.semantic_event_id !== event.event_id
        ) {
          throw new Error(
            "execution_episode_semantic_observation_state_or_identity_invalid",
          );
        }
        break;
      case "agent_decision_recorded":
        if (
          currentStateSnapshotId === null
          || event.payload.decision.target_state_snapshot_id
            !== currentStateSnapshotId
          || event.payload.decision.semantic_event_id !== event.event_id
        ) {
          throw new Error(
            "execution_episode_agent_decision_state_or_identity_invalid",
          );
        }
        break;
      case "progress_state_recorded":
        if (
          currentStateSnapshotId === null
          || event.payload.progress.target_state_snapshot_id
            !== currentStateSnapshotId
          || event.payload.progress.semantic_event_id !== event.event_id
        ) {
          throw new Error(
            "execution_episode_progress_state_or_identity_invalid",
          );
        }
        break;
      case "planned_action_recorded":
        if (
          currentStateSnapshotId === null
          || event.payload.planned_action.target_state_snapshot_id
            !== currentStateSnapshotId
          || event.payload.planned_action.semantic_event_id !== event.event_id
        ) {
          throw new Error(
            "execution_episode_planned_action_state_or_identity_invalid",
          );
        }
        break;
      case "verifier_recorded":
        if (
          currentStateSnapshotId === null
          || event.payload.invocation.target_state_snapshot_id
            !== currentStateSnapshotId
        ) {
          throw new Error("execution_verifier_invocation_target_state_stale");
        }
        break;
      case "episode_closed":
        if (
          currentStateSnapshotId === null
          || event.payload.reward.final_state_snapshot_id
            !== currentStateSnapshotId
        ) {
          throw new Error("execution_episode_close_state_stale");
        }
        closed = true;
        break;
    }
    previous = event;
  }
  if (events.length > 0 && events[0]?.payload.event_kind !== "episode_started") {
    throw new Error("execution_episode_root_event_invalid");
  }
}

/**
 * Pure, synchronous replay/integrity primitive used by both the Runtime store
 * and offline data-operations. It never starts a transaction and never writes.
 */
export function inspectLiteExecutionEpisode(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    options?: LiteExecutionEpisodeStoreOptions;
  }>,
): LiteExecutionEpisodeReplay | null {
  const rows = db.prepare(
    `SELECT *
     FROM lite_execution_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
     ORDER BY episode_sequence`,
  ).all(args.tenantId, args.scope, args.episodeId) as SqlRow[];
  const episodeRow = db.prepare(
    `SELECT 1 AS present
     FROM lite_execution_episodes
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
  ).get(args.tenantId, args.scope, args.episodeId);
  if (rows.length === 0) {
    if (episodeRow) throw new Error("execution_episode_projection_without_event");
    return null;
  }
  if (!episodeRow) throw new Error("execution_episode_event_without_projection");
  const events = rows.map(envelopeFromEventRow);
  assertEventChainAndActions(events);
  const options = args.options ?? {};
  for (const event of events) {
    const operation = operationRow(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      operationKind: event.operation_kind,
      operationId: event.operation_id,
    });
    if (!operation) {
      throw new Error("execution_episode_operation_authority_missing");
    }
    assertOperationBindsEvent(operation, event);
    assertStoredEventProjection(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      event,
      options,
    });
  }
  const started = events[0]?.payload;
  if (!started || started.event_kind !== "episode_started") {
    throw new Error("execution_episode_started_payload_missing");
  }
  const closeEvents = events.filter(
    (event) => event.payload.event_kind === "episode_closed",
  );
  if (closeEvents.length > 1) {
    throw new Error("execution_episode_multiple_close_events");
  }
  const closePayload = closeEvents[0]?.payload;
  const reward = closePayload?.event_kind === "episode_closed"
    ? closePayload.reward
    : null;
  const costReceipt = closePayload?.event_kind === "episode_closed"
    ? closePayload.cost_receipt ?? null
    : null;
  const currentState = currentStateSnapshotId(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.episodeId,
  });
  return {
    episode: started.episode,
    events: Object.freeze(events),
    current_state_snapshot_id: currentState,
    closed: reward !== null,
    reward,
    cost_receipt: costReceipt,
    reward_eligible: reward === null
      ? false
      : isEpisodeRewardSelectorEligible(reward),
    // Phase 1 intentionally has no complete treatment assignment, delivery,
    // prompt exposure, or propensity binding. A primary reward is useful truth
    // transport, but must not be mistaken for a causal selector-training row.
    selector_eligible: false,
  };
}

export function assertLiteExecutionEpisodeIntegrity(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    options?: LiteExecutionEpisodeStoreOptions;
  }>,
): LiteExecutionEpisodeReplay {
  const replay = inspectLiteExecutionEpisode(db, args);
  if (!replay) throw new Error("execution_episode_missing");
  return replay;
}

/**
 * Pure, synchronous full-store integrity inspection. Artifacts may be staged
 * before an episode begins, so artifact-only rows are deliberately left to the
 * artifact store's retention/orphan inspector.
 */
export function assertLiteExecutionEpisodeStoreIntegrity(
  db: SqliteDatabase,
  options: LiteExecutionEpisodeStoreOptions = {},
): LiteExecutionEpisodeIntegritySummary {
  const identities = db.prepare(
    `SELECT tenant_id, scope, episode_id
     FROM lite_execution_episodes
     ORDER BY tenant_id, scope, episode_id`,
  ).all() as Array<{
    tenant_id: string;
    scope: string;
    episode_id: string;
  }>;
  let eventCount = 0;
  let closedEpisodeCount = 0;
  let selectorEligibleEpisodeCount = 0;
  for (const identity of identities) {
    const replay = assertLiteExecutionEpisodeIntegrity(db, {
      tenantId: identity.tenant_id,
      scope: identity.scope,
      episodeId: identity.episode_id,
      options,
    });
    eventCount += replay.events.length;
    if (replay.closed) closedEpisodeCount += 1;
    if (replay.selector_eligible) selectorEligibleEpisodeCount += 1;
  }
  const rawEventCount = requiredInteger(
    db.prepare(
      "SELECT count(*) AS count FROM lite_execution_episode_events",
    ).get() as SqlRow,
    "count",
  );
  if (rawEventCount !== eventCount) {
    throw new Error("execution_episode_orphan_event_detected");
  }

  const expectedProjectionCounts = {
    snapshots: new Set<string>(),
    receipts: new Set<string>(),
    rewards: new Set<string>(),
  };
  for (const identity of identities) {
    const replay = assertLiteExecutionEpisodeIntegrity(db, {
      tenantId: identity.tenant_id,
      scope: identity.scope,
      episodeId: identity.episode_id,
      options,
    });
    for (const event of replay.events) {
      const prefix = `${identity.tenant_id}\u0000${identity.scope}\u0000${identity.episode_id}\u0000`;
      switch (event.payload.event_kind) {
        case "episode_started":
          expectedProjectionCounts.snapshots.add(
            `${prefix}${event.payload.initial_state_snapshot.snapshot_id}`,
          );
          break;
        case "decision_committed":
          break;
        case "action_observed":
          expectedProjectionCounts.snapshots.add(
            `${prefix}${event.payload.state_before_snapshot.snapshot_id}`,
          );
          expectedProjectionCounts.snapshots.add(
            `${prefix}${event.payload.state_after_snapshot.snapshot_id}`,
          );
          break;
        case "verifier_recorded":
          expectedProjectionCounts.snapshots.add(
            `${prefix}${event.payload.verified_state_snapshot.snapshot_id}`,
          );
          expectedProjectionCounts.receipts.add(
            `${prefix}${event.payload.outcome.verifier_receipt_id}`,
          );
          break;
        case "episode_closed":
          if (event.payload.final_state_snapshot) {
            expectedProjectionCounts.snapshots.add(
              `${prefix}${event.payload.final_state_snapshot.snapshot_id}`,
            );
          }
          expectedProjectionCounts.rewards.add(
            `${prefix}${event.payload.reward.reward_id}`,
          );
          break;
      }
    }
  }
  const tableCounts = {
    snapshots: "lite_execution_state_snapshots",
    receipts: "lite_execution_verifier_receipts",
    rewards: "lite_execution_episode_rewards",
  } as const;
  for (const [key, table] of Object.entries(tableCounts) as Array<
    [keyof typeof tableCounts, typeof tableCounts[keyof typeof tableCounts]]
  >) {
    const count = requiredInteger(
      db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as SqlRow,
      "count",
    );
    if (count !== expectedProjectionCounts[key].size) {
      throw new Error(`execution_episode_orphan_projection_detected:${table}`);
    }
  }
  const invocationRows = db.prepare(
    `SELECT tenant_id, scope, episode_id, verifier_invocation_id
     FROM lite_execution_verifier_invocations
     ORDER BY tenant_id, scope, episode_id, verifier_invocation_id`,
  ).all() as Array<{
    tenant_id: string;
    scope: string;
    episode_id: string;
    verifier_invocation_id: string;
  }>;
  for (const row of invocationRows) {
    const operation = operationRow(db, {
      tenantId: row.tenant_id,
      scope: row.scope,
      operationKind:
        LITE_EXECUTION_EPISODE_OPERATION_KIND.verifierInvocation,
      operationId: row.verifier_invocation_id,
    });
    if (!operation) {
      throw new Error(
        "execution_verifier_invocation_operation_authority_missing",
      );
    }
    const parsed = parseCanonicalJson(
      operation.receipt_json,
      "execution_verifier_invocation_operation_receipt",
    ) as Partial<VerifierInvocationOperationReceipt>;
    const invocation = VerifierInvocationV1Schema.parse(parsed.invocation);
    if (
      invocation.episode_id !== row.episode_id
      || invocation.verifier_invocation_id !== row.verifier_invocation_id
    ) {
      throw new Error(
        "execution_verifier_invocation_operation_receipt_invalid",
      );
    }
    assertPersistedVerifierInvocation(db, {
      tenantId: row.tenant_id,
      scope: row.scope,
      invocation,
    });
  }
  const launchAttemptRows = db.prepare(
    `SELECT *
     FROM lite_execution_verifier_launch_attempts
     ORDER BY tenant_id, scope, episode_id, verifier_invocation_id,
              attempt_ordinal`,
  ).all() as SqlRow[];
  for (const row of launchAttemptRows) {
    const attempt = launchAttemptFromRow(row);
    const events = launchEventsForAttempt(db, attempt);
    if (
      events.length === 0
      || events.length > 3
      || events[0]?.payload.event_kind !== "launch_committed"
      || events[0]?.recorded_at !== attempt.prepared_at
      || events[0]?.event_owner_instance_id
        !== attempt.owner_instance_id
      || events[0]?.event_owner_process_id
        !== attempt.owner_process_id
    ) {
      throw new Error(
        "execution_verifier_launch_attempt_event_root_invalid",
      );
    }
    for (const event of events) {
      if (
        event.payload.event_kind !== "interrupted"
        && (
          event.event_owner_instance_id !== attempt.owner_instance_id
          || event.event_owner_process_id !== attempt.owner_process_id
        )
      ) {
        throw new Error(
          "execution_verifier_launch_attempt_event_owner_invalid",
        );
      }
    }
    const terminalEvents = events.filter((event) =>
      event.payload.event_kind === "completed"
      || event.payload.event_kind === "interrupted");
    if (
      terminalEvents.length > 1
      || (
        terminalEvents.length === 1
        && terminalEvents[0] !== events.at(-1)
      )
    ) {
      throw new Error(
        "execution_verifier_launch_attempt_terminal_invalid",
      );
    }
    const receipts = db.prepare(
      `SELECT *
       FROM lite_execution_verifier_receipts
       WHERE tenant_id = ? AND scope = ? AND episode_id = ?
         AND verifier_invocation_id = ?`,
    ).all(
      attempt.tenant_id,
      attempt.scope,
      attempt.episode_id,
      attempt.verifier_invocation_id,
    ) as SqlRow[];
    const terminal = terminalEvents[0];
    if (!terminal) {
      if (receipts.length !== 0) {
        throw new Error(
          "execution_verifier_open_launch_attempt_has_receipt",
        );
      }
      continue;
    }
    if (receipts.length !== 1) {
      throw new Error(
        "execution_verifier_terminal_launch_receipt_missing",
      );
    }
    const payload = terminal.payload;
    if (
      payload.event_kind !== "completed"
      && payload.event_kind !== "interrupted"
    ) {
      throw new Error(
        "execution_verifier_launch_attempt_terminal_invalid",
      );
    }
    const receipt = receipts[0]!;
    const expectedRuntimeLaunchSha256 =
      payload.event_kind === "completed"
        ? payload.runtime_launch_sha256
        : terminal.event_sha256;
    if (
      requiredString(receipt, "verifier_output_artifact_id")
        !== payload.verifier_output_artifact_id
      || requiredString(receipt, "status") !== payload.effective_status
      || requiredString(receipt, "completed_at") !== terminal.recorded_at
      || nullableString(receipt, "runtime_launch_sha256")
        !== expectedRuntimeLaunchSha256
      || canonicalJson(parseCanonicalJson(
        requiredString(
          receipt,
          "infrastructure_failure_reasons_json",
        ),
        "execution_verifier_receipt_infrastructure_reasons",
      )) !== canonicalJson(payload.infrastructure_failure_reasons)
      || nullableString(
        receipt,
        "infrastructure_failure_attribution",
      ) !== payload.infrastructure_failure_attribution
    ) {
      throw new Error(
        "execution_verifier_launch_terminal_receipt_mismatch",
      );
    }
    const artifact = db.prepare(
      `SELECT 1 AS present
       FROM lite_runtime_evidence_artifacts
       WHERE tenant_id = ? AND scope = ? AND episode_id = ?
         AND artifact_id = ? AND kind = 'verifier_output'
         AND sha256 = ?`,
    ).get(
      attempt.tenant_id,
      attempt.scope,
      attempt.episode_id,
      payload.verifier_output_artifact_id,
      payload.verifier_output_sha256,
    );
    if (!artifact) {
      throw new Error(
        "execution_verifier_launch_terminal_output_missing",
      );
    }
    if (
      payload.event_kind === "interrupted"
      && (
        (
          payload.infrastructure_failure_reasons[0]
            === "runtime_episode_verifier_owner_aborted_before_result"
            ? (
              terminal.event_owner_instance_id !== attempt.owner_instance_id
              || terminal.event_owner_process_id
                !== attempt.owner_process_id
            )
            : terminal.event_owner_instance_id === attempt.owner_instance_id
        )
        || payload.runtime_launch_sha256 !== null
        || payload.result_sha256 !== null
      )
    ) {
      throw new Error(
        "execution_verifier_interrupted_launch_terminal_invalid",
      );
    }
  }
  const orphanRuntimeReceipts = requiredInteger(
    db.prepare(
      `SELECT count(*) AS count
       FROM lite_execution_verifier_receipts AS receipt
       WHERE receipt.attestation_kind = 'runtime_launched'
         AND NOT EXISTS (
           SELECT 1
           FROM lite_execution_verifier_launch_attempt_events AS terminal
           WHERE terminal.tenant_id = receipt.tenant_id
             AND terminal.scope = receipt.scope
             AND terminal.episode_id = receipt.episode_id
             AND terminal.verifier_invocation_id =
               receipt.verifier_invocation_id
             AND terminal.event_kind IN ('completed', 'interrupted')
             AND (
               (
                 terminal.event_kind = 'completed'
                 AND terminal.runtime_launch_sha256 =
                   receipt.runtime_launch_sha256
               )
               OR (
                 terminal.event_kind = 'interrupted'
                 AND terminal.event_sha256 =
                   receipt.runtime_launch_sha256
               )
             )
         )`,
    ).get() as SqlRow,
    "count",
  );
  if (orphanRuntimeReceipts !== 0) {
    throw new Error(
      "execution_verifier_runtime_receipt_without_launch_terminal",
    );
  }
  return {
    episode_count: identities.length,
    event_count: eventCount,
    closed_episode_count: closedEpisodeCount,
    selector_eligible_episode_count: selectorEligibleEpisodeCount,
  };
}

let executionEpisodeSavepointSequence = 0;

async function withExecutionEpisodeMutationSavepoint<T>(
  db: SqliteDatabase,
  transaction: SqliteTransactionRunner,
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!transaction.inTransaction()) {
    throw new Error(
      "execution_episode_mutation_requires_shared_runtime_transaction",
    );
  }
  executionEpisodeSavepointSequence += 1;
  const savepoint =
    `execution_episode_${label}_${String(executionEpisodeSavepointSequence)}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const value = await fn();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return value;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // Preserve the domain failure. The outer Runtime transaction owns its
      // final rollback if SQLite could not restore this local savepoint.
    }
    throw error;
  }
}

function appendEventInCurrentTransaction(
  db: SqliteDatabase,
  transaction: SqliteTransactionRunner,
  options: LiteExecutionEpisodeStoreOptions,
  args: LiteExecutionEpisodeOperationArgs & Readonly<{
    operationKind: string;
    payload: ExecutionEpisodeEventPayloadV1;
    runtimeExecutionEvidence?: RuntimeEpisodeVerifierLaunchV1;
  }>,
): LiteExecutionEpisodeAppendResult {
  if (!transaction.inTransaction()) {
    throw new Error(
      "execution_episode_mutation_requires_shared_runtime_transaction",
    );
  }
  const payload = ExecutionEpisodeEventPayloadV1Schema.parse(args.payload);
  const episodeId = payloadEpisodeId(payload);
  const occurredAt = args.occurredAt ?? eventOccurredAt(payload);
  assertCanonicalTimestamp(occurredAt, "execution_episode_event");
  if (occurredAt !== eventOccurredAt(payload)) {
    throw new Error("execution_episode_event_time_mismatch");
  }
  const requestSha256 = executionEpisodeEventPayloadDigest(payload);
  if (!SHA256_PATTERN.test(requestSha256)) {
    throw new Error("execution_episode_request_digest_invalid");
  }
  const expectedEventId = eventIdFor({
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind: args.operationKind,
    operationId: args.operationId,
  });
  const semanticBinding = semanticEventStateBinding(payload);
  if (
    semanticBinding !== null
    && semanticBinding.semanticEventId !== expectedEventId
  ) {
    throw new Error("execution_episode_semantic_event_identity_invalid");
  }

  const existingOperation = operationRow(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind: args.operationKind,
    operationId: args.operationId,
  });
  if (existingOperation) {
    if (existingOperation.request_sha256 !== requestSha256) {
      throw new Error("execution_episode_operation_conflict");
    }
    const existingEvent = eventByOperation(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      operationKind: args.operationKind,
      operationId: args.operationId,
    });
    if (!existingEvent) {
      throw new Error("execution_episode_operation_without_event");
    }
    if (
      existingEvent.episode_id !== episodeId
      || existingEvent.payload_sha256 !== requestSha256
      || canonicalJson(existingEvent.payload) !== canonicalJson(payload)
    ) {
      throw new Error("execution_episode_operation_conflict");
    }
    assertOperationBindsEvent(existingOperation, existingEvent);
    assertStoredEventProjection(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      event: existingEvent,
      options,
    });
    return { event: existingEvent, replayed: true };
  }

  const head = eventHead(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId,
  });
  if (payload.event_kind === "episode_started") {
    if (head) throw new Error("execution_episode_start_not_first");
  } else {
    assertEpisodeOpen(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId,
    });
    if (!head) throw new Error("execution_episode_start_missing");
    if (Date.parse(occurredAt) < Date.parse(head.recorded_at)) {
      throw new Error("execution_episode_event_time_not_monotonic");
    }
  }
  if (payload.event_kind === "decision_committed") {
    const currentSnapshotId = currentStateSnapshotId(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId,
    });
    if (
      payload.decision.target_state_snapshot_id !== currentSnapshotId
    ) {
      throw new Error("execution_episode_decision_target_state_stale");
    }
  }
  if (semanticBinding !== null) {
    const currentSnapshotId = currentStateSnapshotId(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId,
    });
    if (semanticBinding.targetStateSnapshotId !== currentSnapshotId) {
      throw new Error("execution_episode_semantic_event_target_state_stale");
    }
  }
  if (payload.event_kind === "action_observed") {
    const expectedActionSequence = actionCount(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId,
    });
    if (payload.action.sequence !== expectedActionSequence) {
      throw new Error(
        `execution_episode_action_sequence_invalid:${expectedActionSequence}`,
      );
    }
  }

  const event = buildExecutionEpisodeEventEnvelopeV1({
    event_id: expectedEventId,
    episode_id: episodeId,
    operation_kind: args.operationKind,
    operation_id: args.operationId,
    request_sha256: requestSha256,
    sequence: (head?.episode_sequence ?? -1) + 1,
    previous_event_sha256: head?.event_sha256 ?? null,
    payload,
    occurred_at: occurredAt,
  });

  appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction({
    db,
    transaction,
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind: args.operationKind,
    operationId: args.operationId,
    requestSha256,
    receiptJson: operationReceiptJson(event),
    commitId: null,
    createdAt: occurredAt,
  });

  ensureEventProjections(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    event,
    options,
    runtimeExecutionEvidence: args.runtimeExecutionEvidence,
  });
  insertEventRow(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    event,
  });
  insertEventArtifactRefs(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    event,
  });
  assertStoredEventProjection(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    event,
    options,
  });
  const insertedOperation = operationRow(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind: args.operationKind,
    operationId: args.operationId,
  });
  if (!insertedOperation) {
    throw new Error("execution_episode_operation_authority_missing");
  }
  assertOperationBindsEvent(insertedOperation, event);
  return { event, replayed: false };
}

function closeRewardId(args: {
  tenantId: string;
  scope: string;
  episodeId: string;
  operationId: string;
}): string {
  return `erw_${stableUuid(canonicalJson({
    contract_version: "execution_episode_reward_identity_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    episode_id: args.episodeId,
    operation_id: args.operationId,
  }))}`;
}

function closeCostReceiptId(args: {
  tenantId: string;
  scope: string;
  episodeId: string;
  operationId: string;
}): string {
  return `ecr_${stableUuid(canonicalJson({
    contract_version: "execution_cost_receipt_identity_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    episode_id: args.episodeId,
    operation_id: args.operationId,
  }))}`;
}

function canonicalReasons(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  ));
}

function canonicalOutcomeDetails(
  details: readonly string[] | undefined,
): string[] {
  return canonicalReasons(details ?? []);
}

function costInputMatchesReceipt(
  input: LiteExecutionEpisodeCostInputV1 | undefined,
  receipt: ExecutionCostReceiptV1 | undefined,
): boolean {
  if (input === undefined) {
    return receipt === undefined
      || (
        receipt.token_usage_authority === "unavailable"
        && receipt.input_tokens === null
        && receipt.output_tokens === null
        && receipt.cached_input_tokens === null
        && receipt.raw_usage_ref === undefined
      );
  }
  return receipt !== undefined
    && receipt.provider === input.provider
    && receipt.model === input.model
    && receipt.input_tokens === input.inputTokens
    && receipt.output_tokens === input.outputTokens
    && receipt.cached_input_tokens === (input.cachedInputTokens ?? null)
    && receipt.token_usage_authority === input.tokenUsageAuthority
    && receipt.monetary_cost_micros
      === (input.monetaryCostMicros ?? null)
    && receipt.currency === (input.currency ?? null)
    && receipt.producer_id === input.producerId
    && canonicalJson(receipt.raw_usage_ref)
      === canonicalJson(input.rawUsageRef);
}

function deriveEpisodeClose(
  db: SqliteDatabase,
  options: LiteExecutionEpisodeStoreOptions,
  args: Readonly<{
    tenantId: string;
    scope: string;
    operationId: string;
    episodeId: string;
    termination: LiteExecutionEpisodeTerminationKind;
    verifierReceiptId?: string;
    outcomeDetails?: readonly string[];
    cost?: LiteExecutionEpisodeCostInputV1;
  }>,
): Readonly<{
  reward: EpisodeRewardV1;
  costReceipt: ExecutionCostReceiptV1;
  finalStateSnapshot: StateSnapshotV1;
  closedAt: string;
}> {
  assertEpisodeOpen(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.episodeId,
  });
  const closedAt = (options.now ?? (() => new Date().toISOString()))();
  assertCanonicalTimestamp(closedAt, "execution_episode_close");
  const episode = db.prepare(
    `SELECT opened_at, model_id, model_config_digest
     FROM lite_execution_episodes
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.episodeId,
  ) as {
    opened_at: string;
    model_id: string;
    model_config_digest: string;
  } | undefined;
  if (!episode) throw new Error("execution_episode_missing");
  const activeVerifierLaunch = db.prepare(
    `SELECT 1 AS present
     FROM lite_execution_verifier_launch_attempts AS attempt
     WHERE attempt.tenant_id = ? AND attempt.scope = ?
       AND attempt.episode_id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM lite_execution_verifier_launch_attempt_events AS terminal
         WHERE terminal.tenant_id = attempt.tenant_id
           AND terminal.scope = attempt.scope
           AND terminal.episode_id = attempt.episode_id
           AND terminal.launch_attempt_id = attempt.launch_attempt_id
           AND terminal.event_kind IN ('completed', 'interrupted')
       )
     LIMIT 1`,
  ).get(args.tenantId, args.scope, args.episodeId);
  if (activeVerifierLaunch) {
    throw new Error(
      "execution_episode_close_verifier_launch_active",
    );
  }
  const elapsedMs = Date.parse(closedAt) - Date.parse(episode.opened_at);
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    throw new Error("execution_episode_close_precedes_open");
  }
  const currentSnapshotId = currentStateSnapshotId(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.episodeId,
  });
  const finalStateSnapshot = storedStateSnapshot(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.episodeId,
    snapshotId: currentSnapshotId,
  });

  let verifiedSuccess: 0 | 1 | null;
  let outcomeClass: EpisodeRewardV1["outcome_class"];
  let rewardAuthority: EpisodeRewardV1["reward_authority"];
  let verifierReceiptId: string | undefined;
  let requiredReasons: string[];
  if (args.verifierReceiptId === undefined) {
    verifiedSuccess = 0;
    outcomeClass = "arm_caused_incomplete";
    rewardAuthority = "protocol_itt_failure";
    requiredReasons = [`termination_without_verifier:${args.termination}`];
  } else {
    const receipt = db.prepare(
      `SELECT receipt.status, receipt.verifier_kind,
              receipt.verified_state_snapshot_id,
              receipt.infrastructure_failure_attribution
       FROM lite_execution_verifier_receipts AS receipt
       JOIN lite_execution_episode_events AS event
         ON event.tenant_id = receipt.tenant_id
        AND event.scope = receipt.scope
        AND event.episode_id = receipt.episode_id
        AND event.verifier_receipt_id = receipt.verifier_receipt_id
        AND event.event_kind = 'verifier_recorded'
       WHERE receipt.tenant_id = ? AND receipt.scope = ?
         AND receipt.episode_id = ? AND receipt.verifier_receipt_id = ?`,
    ).get(
      args.tenantId,
      args.scope,
      args.episodeId,
      args.verifierReceiptId,
    ) as {
      status: VerifierOutcomeReceiptV1["status"];
      verifier_kind: VerifierOutcomeReceiptV1["verifier_kind"];
      verified_state_snapshot_id: string;
      infrastructure_failure_attribution:
        | "arm_caused"
        | "arm_independent"
        | null;
    } | undefined;
    if (!receipt) {
      throw new Error("execution_episode_close_verifier_missing");
    }
    if (receipt.verified_state_snapshot_id !== currentSnapshotId) {
      throw new Error("execution_episode_close_verifier_stale");
    }
    verifierReceiptId = args.verifierReceiptId;
    if (receipt.verifier_kind === "llm_judge_diagnostic") {
      verifiedSuccess = null;
      outcomeClass = "diagnostic_only";
      rewardAuthority = "diagnostic_only";
      requiredReasons = ["llm_judge_diagnostic_only"];
    } else if (receipt.status === "infrastructure_error") {
      if (receipt.infrastructure_failure_attribution === "arm_independent") {
        verifiedSuccess = null;
        outcomeClass = "arm_independent_infrastructure";
        rewardAuthority = "missing";
        requiredReasons = ["verifier_arm_independent_infrastructure"];
      } else {
        verifiedSuccess = 0;
        outcomeClass = "arm_caused_incomplete";
        rewardAuthority = "protocol_itt_failure";
        requiredReasons = ["verifier_arm_caused_infrastructure"];
      }
    } else if (receipt.status === "passed") {
      verifiedSuccess = 1;
      outcomeClass = "verified_pass";
      rewardAuthority = receipt.verifier_kind === "independent_executable"
        ? "independent_executable"
        : receipt.verifier_kind === "process_verifier"
          ? "process"
          : "deterministic";
      requiredReasons = [];
    } else if (receipt.status === "failed") {
      verifiedSuccess = 0;
      outcomeClass = "verified_failure";
      rewardAuthority = receipt.verifier_kind === "independent_executable"
        ? "independent_executable"
        : receipt.verifier_kind === "process_verifier"
          ? "process"
          : "deterministic";
      requiredReasons = ["verifier_failed"];
    } else {
      verifiedSuccess = 0;
      outcomeClass = "arm_caused_incomplete";
      rewardAuthority = "protocol_itt_failure";
      requiredReasons = [`verifier_${receipt.status}`];
    }
  }
  const toolCallCount = episodeToolCallCount(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.episodeId,
  });
  if (args.cost !== undefined && args.cost.model !== episode.model_id) {
    throw new Error("execution_episode_cost_model_identity_mismatch");
  }
  const costMaterial: ExecutionCostReceiptMaterialV1 = {
    cost_receipt_id: closeCostReceiptId(args),
    episode_id: args.episodeId,
    provider: args.cost?.provider ?? "unavailable",
    model: episode.model_id,
    model_config_sha256: episode.model_config_digest,
    input_tokens: args.cost?.inputTokens ?? null,
    output_tokens: args.cost?.outputTokens ?? null,
    cached_input_tokens: args.cost?.cachedInputTokens ?? null,
    token_usage_authority:
      args.cost?.tokenUsageAuthority ?? "unavailable",
    tool_calls: toolCallCount,
    elapsed_ms: elapsedMs,
    monetary_cost_micros: args.cost?.monetaryCostMicros ?? null,
    currency: args.cost?.currency ?? null,
    ...(args.cost ? { raw_usage_ref: args.cost.rawUsageRef } : {}),
    producer_id: args.cost?.producerId ?? "aionis-runtime",
    recorded_at: closedAt,
  };
  const costReceipt = ExecutionCostReceiptV1Schema.parse({
    ...costMaterial,
    receipt_sha256: executionCostReceiptDigest(costMaterial),
  });
  const tokenCount =
    costReceipt.input_tokens === null
    || costReceipt.output_tokens === null
      ? null
      : costReceipt.input_tokens + costReceipt.output_tokens;
  const rewardTokenAuthority =
    costReceipt.token_usage_authority === "unavailable"
      ? "unavailable"
      : costReceipt.token_usage_authority === "signed_host_receipt"
        ? "trusted_adapter_signature"
        : "provider_receipt";
  const reward = EpisodeRewardV1Schema.parse({
    reward_id: closeRewardId(args),
    episode_id: args.episodeId,
    reward_contract_version: "episode_reward_v1",
    verified_success: verifiedSuccess,
    outcome_class: outcomeClass,
    reward_authority: rewardAuthority,
    final_state_snapshot_id: currentSnapshotId,
    ...(verifierReceiptId ? { verifier_receipt_id: verifierReceiptId } : {}),
    token_count: tokenCount,
    token_usage_authority: rewardTokenAuthority,
    ...(costReceipt.raw_usage_ref
      ? { token_usage_ref: costReceipt.raw_usage_ref }
      : {}),
    tool_call_count: toolCallCount,
    elapsed_ms: elapsedMs,
    outcome_reasons: canonicalReasons([
      ...requiredReasons,
      ...(args.outcomeDetails ?? []),
    ]),
    // Public callers cannot classify their own failures as contaminated and
    // thereby remove them from future evidence. Runtime-derived contamination
    // will be introduced only with the complete Phase 2 attribution contract.
    contamination_reasons: [],
  });
  return { reward, costReceipt, finalStateSnapshot, closedAt };
}

function reserveVerifierInvocationInCurrentTransaction(
  db: SqliteDatabase,
  transaction: SqliteTransactionRunner,
  args: Readonly<{
    tenantId: string;
    scope: string;
    invocation: VerifierInvocationV1;
  }>,
): LiteExecutionVerifierInvocationReservationResult {
  if (!transaction.inTransaction()) {
    throw new Error(
      "execution_episode_mutation_requires_shared_runtime_transaction",
    );
  }
  const invocation = VerifierInvocationV1Schema.parse(args.invocation);
  if (
    invocation.launch_authority.kind === "runtime_launched"
    && invocation.launch_authority.runtime_reservation_digest
      !== expectedRuntimeVerifierInvocationReservationDigest(invocation)
  ) {
    throw new Error("execution_verifier_runtime_launch_receipt_mismatch");
  }
  assertEpisodeOpen(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: invocation.episode_id,
  });
  const requiredVerifier = db.prepare(
    `SELECT required_verifier_id, required_verifier_definition_sha256
     FROM lite_execution_episodes
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    invocation.episode_id,
  ) as {
    required_verifier_id: string;
    required_verifier_definition_sha256: string;
  } | undefined;
  if (
    !requiredVerifier
    || invocation.verifier_id !== requiredVerifier.required_verifier_id
    || invocation.verifier_definition_sha256
      !== requiredVerifier.required_verifier_definition_sha256
  ) {
    throw new Error("execution_verifier_required_definition_mismatch");
  }
  const currentState = currentStateSnapshotId(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: invocation.episode_id,
  });
  if (invocation.target_state_snapshot_id !== currentState) {
    throw new Error("execution_verifier_invocation_target_state_stale");
  }
  assertArtifactRef(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: invocation.episode_id,
    ref: invocation.verifier_input_ref,
  });
  const target = db.prepare(
    `SELECT environment_digest, algorithm_version
     FROM lite_execution_state_snapshots
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND snapshot_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    invocation.episode_id,
    invocation.target_state_snapshot_id,
  ) as {
    environment_digest: string;
    algorithm_version: string;
  } | undefined;
  if (!target) {
    throw new Error("execution_verifier_invocation_target_state_missing");
  }
  if (target.environment_digest !== invocation.verifier_environment_digest) {
    throw new Error(
      "execution_verifier_invocation_environment_digest_mismatch",
    );
  }
  if (
    target.algorithm_version
      !== invocation.target_state_snapshot_algorithm_version
  ) {
    throw new Error(
      "execution_verifier_invocation_snapshot_algorithm_version_mismatch",
    );
  }

  const operationKind =
    LITE_EXECUTION_EPISODE_OPERATION_KIND.verifierInvocation;
  const operationId = invocation.verifier_invocation_id;
  const requestSha256 = verifierInvocationDigest(invocation);
  const existingOperation = operationRow(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind,
    operationId,
  });
  if (existingOperation) {
    if (existingOperation.request_sha256 !== requestSha256) {
      throw new Error("execution_verifier_invocation_operation_conflict");
    }
    assertPersistedVerifierInvocation(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      invocation,
    });
    return { invocation, replayed: true };
  }
  const existingInvocation = db.prepare(
    `SELECT 1 AS present
     FROM lite_execution_verifier_invocations
     WHERE tenant_id = ? AND scope = ? AND verifier_invocation_id = ?`,
  ).get(args.tenantId, args.scope, invocation.verifier_invocation_id);
  if (existingInvocation) {
    throw new Error(
      "execution_verifier_invocation_without_operation_authority",
    );
  }

  appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction({
    db,
    transaction,
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind,
    operationId,
    requestSha256,
    receiptJson: verifierInvocationOperationReceiptJson(invocation),
    commitId: null,
    createdAt: invocation.invoked_at,
  });
  const expected = invocationExpectedRow({
    tenantId: args.tenantId,
    scope: args.scope,
    invocation,
  });
  db.prepare(
    `INSERT INTO lite_execution_verifier_invocations
       (tenant_id, scope, episode_id, verifier_invocation_id, verifier_id,
        verifier_definition_sha256, verifier_kind, verifier_version,
        verifier_issuer_id, verifier_runner_instance_id,
        launch_authority_kind, runtime_reservation_digest, principal_id,
        key_id, verifier_program_digest, verifier_config_digest,
        verifier_environment_digest, verified_state_snapshot_id,
        target_state_snapshot_algorithm_version, verifier_input_artifact_id,
        invocation_sha256, invoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?)`,
  ).run(...Object.values(expected));
  assertPersistedVerifierInvocation(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    invocation,
  });
  return { invocation, replayed: false };
}

function prepareVerifierLaunchAttemptInCurrentTransaction(
  db: SqliteDatabase,
  transaction: SqliteTransactionRunner,
  options: LiteExecutionEpisodeStoreOptions,
  args: Readonly<{
    tenantId: string;
    scope: string;
    outcomeOperationId: string;
    ownerInstanceId: string;
    ownerProcessId: number;
    preparedLaunch: RuntimeEpisodeVerifierPreparedLaunchV1;
    preparedAt?: string;
  }>,
): RuntimeEpisodeVerifierLaunchAttemptV1 {
  if (!transaction.inTransaction()) {
    throw new Error(
      "execution_episode_mutation_requires_shared_runtime_transaction",
    );
  }
  const prepared = args.preparedLaunch;
  const invocation = loadPersistedVerifierInvocation(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: prepared.episode_id,
    verifierInvocationId: prepared.verifier_invocation_id,
  });
  if (
    verifierInvocationDigest(invocation)
      !== prepared.verifier_invocation_digest
    || invocation.verifier_id !== prepared.verifier_id
    || invocation.verifier_definition_sha256
      !== prepared.verifier_definition_sha256
    || invocation.verifier_program_digest
      !== prepared.verifier_program_digest
    || invocation.verifier_config_digest
      !== prepared.verifier_config_digest
    || invocation.verifier_environment_digest
      !== prepared.verifier_environment_digest
  ) {
    throw new Error(
      "execution_verifier_prepared_launch_invocation_mismatch",
    );
  }
  const existing = launchAttemptRow(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: prepared.episode_id,
    launchAttemptId: prepared.launch_attempt_id,
  });
  if (existing) {
    const events = launchEventsForAttempt(db, existing);
    if (
      existing.outcome_operation_id !== args.outcomeOperationId
      || existing.owner_instance_id !== args.ownerInstanceId
      || existing.owner_process_id !== args.ownerProcessId
      || existing.invocation_sha256
        !== prepared.verifier_invocation_digest
      || existing.invocation_authority_sha256
        !== prepared.invocation_authority_sha256
      || existing.invocation_authority_channel_id
        !== prepared.invocation_authority_channel_id
      || existing.materialization_id !== prepared.materialization_id
      || existing.execution_pack_manifest_sha256
        !== prepared.execution_pack_manifest_sha256
      || existing.resolved_config_digest
        !== prepared.resolved_config_digest
      || existing.resolved_environment_digest
        !== prepared.resolved_environment_digest
      || events.length === 0
      || events[0]?.payload.event_kind !== "launch_committed"
    ) {
      throw new Error(
        "execution_verifier_launch_attempt_operation_conflict",
      );
    }
    return existing;
  }
  const open = openLaunchAttemptForInvocation(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: prepared.episode_id,
    verifierInvocationId: prepared.verifier_invocation_id,
  });
  if (open) {
    throw new Error("execution_verifier_launch_attempt_already_active");
  }
  const ordinalRow = db.prepare(
    `SELECT COALESCE(MAX(attempt_ordinal), 0) + 1 AS next_ordinal
     FROM lite_execution_verifier_launch_attempts
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND verifier_invocation_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    prepared.episode_id,
    prepared.verifier_invocation_id,
  ) as SqlRow;
  const preparedAt =
    args.preparedAt ?? (options.now ?? (() => new Date().toISOString()))();
  assertCanonicalTimestamp(
    preparedAt,
    "execution_verifier_launch_attempt",
  );
  const material = {
    contract_version:
      "runtime_episode_verifier_launch_attempt_v1" as const,
    tenant_id: args.tenantId,
    scope: args.scope,
    episode_id: prepared.episode_id,
    verifier_invocation_id: prepared.verifier_invocation_id,
    launch_attempt_id: prepared.launch_attempt_id,
    outcome_operation_id: args.outcomeOperationId,
    attempt_ordinal: requiredInteger(ordinalRow, "next_ordinal"),
    owner_instance_id: args.ownerInstanceId,
    owner_process_id: args.ownerProcessId,
    invocation_sha256: prepared.verifier_invocation_digest,
    invocation_authority_sha256:
      prepared.invocation_authority_sha256,
    invocation_authority_channel_id:
      prepared.invocation_authority_channel_id,
    materialization_id: prepared.materialization_id,
    materialized_subject_root: prepared.materialized_subject_root,
    materialized_scratch_root: prepared.materialized_scratch_root,
    source_content_digest: prepared.source_content_digest,
    source_environment_digest: prepared.source_environment_digest,
    subject_identity_sha256: prepared.subject_identity_sha256,
    subject_view_content_digest:
      prepared.subject_view_content_digest,
    subject_view_environment_digest:
      prepared.subject_view_environment_digest,
    verifier_definition_sha256:
      prepared.verifier_definition_sha256,
    verifier_program_digest: prepared.verifier_program_digest,
    verifier_config_digest: prepared.verifier_config_digest,
    verifier_environment_digest:
      prepared.verifier_environment_digest,
    execution_pack_manifest_sha256:
      prepared.execution_pack_manifest_sha256,
    resolved_config_digest: prepared.resolved_config_digest,
    resolved_environment_digest:
      prepared.resolved_environment_digest,
    prepared_at: preparedAt,
  };
  const attempt: RuntimeEpisodeVerifierLaunchAttemptV1 = Object.freeze({
    ...material,
    prepared_sha256:
      runtimeEpisodeVerifierLaunchAttemptDigest(material),
  });
  db.prepare(
    `INSERT INTO lite_execution_verifier_launch_attempts
       (tenant_id, scope, episode_id, verifier_invocation_id,
        launch_attempt_id, outcome_operation_id, attempt_ordinal,
        owner_instance_id, owner_process_id, invocation_sha256,
        invocation_authority_sha256, invocation_authority_channel_id,
        materialization_id, materialized_subject_root,
        materialized_scratch_root, source_content_digest,
        source_environment_digest, subject_identity_sha256,
        subject_view_content_digest, subject_view_environment_digest,
        verifier_definition_sha256, verifier_program_digest,
        verifier_config_digest, verifier_environment_digest,
        execution_pack_manifest_sha256, resolved_config_digest,
        resolved_environment_digest, prepared_sha256, prepared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attempt.tenant_id,
    attempt.scope,
    attempt.episode_id,
    attempt.verifier_invocation_id,
    attempt.launch_attempt_id,
    attempt.outcome_operation_id,
    attempt.attempt_ordinal,
    attempt.owner_instance_id,
    attempt.owner_process_id,
    attempt.invocation_sha256,
    attempt.invocation_authority_sha256,
    attempt.invocation_authority_channel_id,
    attempt.materialization_id,
    attempt.materialized_subject_root,
    attempt.materialized_scratch_root,
    attempt.source_content_digest,
    attempt.source_environment_digest,
    attempt.subject_identity_sha256,
    attempt.subject_view_content_digest,
    attempt.subject_view_environment_digest,
    attempt.verifier_definition_sha256,
    attempt.verifier_program_digest,
    attempt.verifier_config_digest,
    attempt.verifier_environment_digest,
    attempt.execution_pack_manifest_sha256,
    attempt.resolved_config_digest,
    attempt.resolved_environment_digest,
    attempt.prepared_sha256,
    attempt.prepared_at,
  );
  const committed = buildLaunchEvent(attempt, {
    previous: null,
    ownerInstanceId: attempt.owner_instance_id,
    ownerProcessId: attempt.owner_process_id,
    payload: Object.freeze({
      contract_version:
        "runtime_episode_verifier_launch_committed_payload_v1",
      event_kind: "launch_committed",
      prepared_sha256: attempt.prepared_sha256,
    }),
    recordedAt: attempt.prepared_at,
  });
  insertLaunchEvent(db, committed);
  const stored = launchAttemptRow(db, {
    tenantId: attempt.tenant_id,
    scope: attempt.scope,
    episodeId: attempt.episode_id,
    launchAttemptId: attempt.launch_attempt_id,
  });
  if (!stored || canonicalJson(stored) !== canonicalJson(attempt)) {
    throw new Error(
      "execution_verifier_launch_attempt_persistence_mismatch",
    );
  }
  return stored;
}

function appendVerifierSpawnObservationInCurrentTransaction(
  db: SqliteDatabase,
  transaction: SqliteTransactionRunner,
  args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    verifierInvocationId: string;
    launchAttemptId: string;
    ownerInstanceId: string;
    ownerProcessId: number;
    observation: RuntimeEpisodeVerifierSpawnObservationV1;
  }>,
): RuntimeEpisodeVerifierLaunchAttemptEventV1 {
  if (!transaction.inTransaction()) {
    throw new Error(
      "execution_episode_mutation_requires_shared_runtime_transaction",
    );
  }
  const attempt = launchAttemptRow(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.episodeId,
    launchAttemptId: args.launchAttemptId,
  });
  if (
    !attempt
    || attempt.verifier_invocation_id !== args.verifierInvocationId
    || attempt.owner_instance_id !== args.ownerInstanceId
    || attempt.owner_process_id !== args.ownerProcessId
    || args.observation.launch_attempt_id !== attempt.launch_attempt_id
  ) {
    throw new Error(
      "execution_verifier_spawn_observation_attempt_mismatch",
    );
  }
  const events = launchEventsForAttempt(db, attempt);
  const existing = events.find(
    (event) => event.payload.event_kind === "spawn_observed",
  );
  if (existing) {
    if (
      existing.payload.event_kind !== "spawn_observed"
      || existing.payload.child_process_id
        !== args.observation.process_id
      || existing.recorded_at !== args.observation.observed_at
    ) {
      throw new Error(
        "execution_verifier_spawn_observation_conflict",
      );
    }
    return existing;
  }
  if (
    events.some((event) =>
      event.payload.event_kind === "completed"
      || event.payload.event_kind === "interrupted")
  ) {
    throw new Error(
      "execution_verifier_spawn_observation_after_terminal",
    );
  }
  const event = buildLaunchEvent(attempt, {
    previous: events.at(-1) ?? null,
    ownerInstanceId: args.ownerInstanceId,
    ownerProcessId: args.ownerProcessId,
    payload: Object.freeze({
      contract_version:
        "runtime_episode_verifier_spawn_observed_payload_v1",
      event_kind: "spawn_observed",
      child_process_id: args.observation.process_id,
    }),
    recordedAt: args.observation.observed_at,
  });
  insertLaunchEvent(db, event);
  return event;
}

function ensureCompletedVerifierLaunchTerminal(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    operationId: string;
    invocation: VerifierInvocationV1;
    outcome: VerifierOutcomeReceiptV1;
    launch: RuntimeEpisodeVerifierLaunchV1;
  }>,
): RuntimeEpisodeVerifierLaunchAttemptEventV1 {
  const identity = args.launch.launch_identity;
  const attempt = launchAttemptRow(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.invocation.episode_id,
    launchAttemptId: identity.launch_attempt_id,
  });
  if (
    !attempt
    || attempt.verifier_invocation_id
      !== args.invocation.verifier_invocation_id
    || attempt.outcome_operation_id !== args.operationId
    || attempt.invocation_sha256
      !== verifierInvocationDigest(args.invocation)
    || attempt.invocation_authority_sha256
      !== identity.invocation_authority_sha256
    || attempt.invocation_authority_channel_id
      !== identity.invocation_authority_channel_id
    || attempt.materialization_id !== identity.materialization_id
    || attempt.source_content_digest !== identity.source_content_digest
    || attempt.source_environment_digest
      !== identity.source_environment_digest
    || attempt.subject_identity_sha256 !== identity.subject_identity_sha256
    || attempt.subject_view_content_digest
      !== identity.subject_view_content_digest
    || attempt.subject_view_environment_digest
      !== identity.subject_view_environment_digest
    || attempt.verifier_definition_sha256
      !== identity.verifier_definition_sha256
    || attempt.verifier_program_digest
      !== identity.verifier_program_digest
    || attempt.verifier_config_digest
      !== identity.verifier_config_digest
    || attempt.verifier_environment_digest
      !== identity.verifier_environment_digest
    || attempt.execution_pack_manifest_sha256
      !== identity.execution_pack_manifest_sha256
    || attempt.resolved_config_digest !== identity.resolved_config_digest
    || attempt.resolved_environment_digest
      !== identity.resolved_environment_digest
  ) {
    throw new Error(
      "execution_verifier_completed_launch_attempt_mismatch",
    );
  }
  const attribution = runtimeEpisodeVerifierFailureAttribution(
    args.launch,
  );
  const payload = Object.freeze({
    contract_version:
      "runtime_episode_verifier_launch_terminal_payload_v1" as const,
    event_kind: "completed" as const,
    verifier_output_artifact_id:
      args.outcome.verifier_output_ref.artifact_id,
    verifier_output_sha256: args.outcome.verifier_output_ref.sha256,
    runtime_launch_sha256: identity.launch_sha256,
    result_sha256: args.launch.result.result_sha256,
    effective_status: args.launch.effective_status,
    infrastructure_failure_reasons: Object.freeze(
      canonicalReasons(args.launch.infrastructure_failure_reasons),
    ),
    infrastructure_failure_attribution: attribution,
  });
  const events = launchEventsForAttempt(db, attempt);
  const existing = events.find((event) =>
    event.payload.event_kind === "completed"
    || event.payload.event_kind === "interrupted");
  if (existing) {
    if (
      existing.payload.event_kind !== "completed"
      || canonicalJson(existing.payload) !== canonicalJson(payload)
    ) {
      throw new Error(
        "execution_verifier_launch_terminal_conflict",
      );
    }
    return existing;
  }
  const terminal = buildLaunchEvent(attempt, {
    previous: events.at(-1) ?? null,
    ownerInstanceId: attempt.owner_instance_id,
    ownerProcessId: attempt.owner_process_id,
    payload,
    recordedAt: args.launch.result.completed_at,
  });
  insertLaunchEvent(db, terminal);
  return terminal;
}

function assertInterruptedVerifierOutputEvidence(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
    ref: EvidenceArtifactRefV1;
    evidence: RuntimeEpisodeVerifierInterruptedLaunchEvidenceV1;
  }>,
): void {
  assertArtifactRef(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.episodeId,
    ref: args.ref,
  });
  const row = db.prepare(
    `SELECT blob.content_bytes
     FROM lite_runtime_evidence_artifacts AS artifact
     JOIN lite_runtime_evidence_blobs AS blob
       ON blob.tenant_id = artifact.tenant_id
      AND blob.blob_sha256 = artifact.sha256
     WHERE artifact.tenant_id = ? AND artifact.scope = ?
       AND artifact.episode_id = ? AND artifact.artifact_id = ?
       AND artifact.kind = 'verifier_output'
       AND artifact.sha256 = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.episodeId,
    args.ref.artifact_id,
    args.ref.sha256,
  ) as { content_bytes: Uint8Array } | undefined;
  const expected = Buffer.from(canonicalJson(args.evidence), "utf8");
  if (!row || !Buffer.from(row.content_bytes).equals(expected)) {
    throw new Error(
      "execution_verifier_interrupted_output_artifact_mismatch",
    );
  }
}

function interruptedVerifierReceiptId(
  attempt: RuntimeEpisodeVerifierLaunchAttemptV1,
  terminalEventSha256: string,
): string {
  return `evc_${stableUuid(canonicalJson({
    contract_version:
      "execution_verifier_interrupted_receipt_identity_v1",
    tenant_id: attempt.tenant_id,
    scope: attempt.scope,
    episode_id: attempt.episode_id,
    verifier_invocation_id: attempt.verifier_invocation_id,
    launch_attempt_id: attempt.launch_attempt_id,
    terminal_event_sha256: terminalEventSha256,
  }))}`;
}

export function createLiteExecutionEpisodeStore(
  database: LiteRuntimeDatabase,
  options: LiteExecutionEpisodeStoreOptions = {},
): LiteExecutionEpisodeStore {
  const { db, transaction } = database;
  const appendWithSavepoint = async (
    label: string,
    args: Parameters<typeof appendEventInCurrentTransaction>[3],
  ): Promise<LiteExecutionEpisodeAppendResult> => (
    await withExecutionEpisodeMutationSavepoint(
      db,
      transaction,
      label,
      () => appendEventInCurrentTransaction(
        db,
        transaction,
        options,
        args,
      ),
    )
  );
  const recordVerifierOutcome: LiteExecutionEpisodeStore["recordVerifierOutcome"] =
    async (args) => await withExecutionEpisodeMutationSavepoint(
      db,
      transaction,
      "verifier_outcome",
      () => {
        if (args.runtimeExecutionEvidence !== undefined) {
          assertRuntimeExecutionEvidence(db, {
            tenantId: args.tenantId,
            scope: args.scope,
            invocation: args.invocation,
            outcome: args.outcome,
            options,
            runtimeExecutionEvidence: args.runtimeExecutionEvidence,
          });
          ensureCompletedVerifierLaunchTerminal(db, {
            tenantId: args.tenantId,
            scope: args.scope,
            operationId: args.operationId,
            invocation: args.invocation,
            outcome: args.outcome,
            launch: args.runtimeExecutionEvidence,
          });
        }
        return appendEventInCurrentTransaction(
          db,
          transaction,
          options,
          {
            ...args,
            operationKind:
              LITE_EXECUTION_EPISODE_OPERATION_KIND.verifierOutcome,
            payload: {
              event_kind: "verifier_recorded",
              invocation: args.invocation,
              outcome: args.outcome,
              verified_state_snapshot: args.verifiedStateSnapshot,
            },
          },
        );
      },
    );
  return {
    transactionRunner(): SqliteTransactionRunner {
      return transaction;
    },

    async beginEpisode(args) {
      const episode = DecisionEpisodeV1Schema.parse(args.episode);
      const initialStateSnapshot =
        StateSnapshotV1Schema.parse(args.initialStateSnapshot);
      if (
        episode.tenant_id !== args.tenantId
        || episode.store_scope !== args.scope
      ) {
        throw new Error("execution_episode_scope_identity_mismatch");
      }
      return await appendWithSavepoint("begin", {
        ...args,
        operationKind: LITE_EXECUTION_EPISODE_OPERATION_KIND.begin,
        payload: {
          event_kind: "episode_started",
          episode,
          initial_state_snapshot: initialStateSnapshot,
        },
      });
    },

    async appendDecision(args) {
      return await appendWithSavepoint("decision", {
        ...args,
        operationKind: LITE_EXECUTION_EPISODE_OPERATION_KIND.decision,
        payload: {
          event_kind: "decision_committed",
          decision: args.decision,
        },
      });
    },

    async appendAction(args) {
      const action = ActionMutationReceiptV1Schema.parse(args.action);
      if (
        actionMutationReceiptDigest(action)
        !== actionMutationReceiptDigest(args.action)
      ) {
        throw new Error("execution_episode_action_digest_unstable");
      }
      return await appendWithSavepoint("action", {
        ...args,
        operationKind: LITE_EXECUTION_EPISODE_OPERATION_KIND.action,
        payload: {
          event_kind: "action_observed",
          action,
          state_before_snapshot: args.stateBeforeSnapshot,
          state_after_snapshot: args.stateAfterSnapshot,
        },
      });
    },

    async appendSemanticObservation(args) {
      const operationKind =
        LITE_EXECUTION_EPISODE_OPERATION_KIND.semanticObservation;
      const observation = SemanticObservationEventV1Schema.parse({
        ...args.observation,
        semantic_event_id: eventIdFor({
          tenantId: args.tenantId,
          scope: args.scope,
          operationKind,
          operationId: args.operationId,
        }),
      });
      return await appendWithSavepoint("semantic_observation", {
        ...args,
        occurredAt: observation.recorded_at,
        operationKind,
        payload: {
          event_kind: "semantic_observation_recorded",
          observation,
        },
      });
    },

    async appendAgentDecision(args) {
      const operationKind =
        LITE_EXECUTION_EPISODE_OPERATION_KIND.agentDecision;
      const decision = AgentDecisionEventV1Schema.parse({
        ...args.decision,
        semantic_event_id: eventIdFor({
          tenantId: args.tenantId,
          scope: args.scope,
          operationKind,
          operationId: args.operationId,
        }),
      });
      return await appendWithSavepoint("agent_decision", {
        ...args,
        occurredAt: decision.recorded_at,
        operationKind,
        payload: {
          event_kind: "agent_decision_recorded",
          decision,
        },
      });
    },

    async appendProgressState(args) {
      const operationKind =
        LITE_EXECUTION_EPISODE_OPERATION_KIND.progressState;
      const progress = ProgressStateEventV1Schema.parse({
        ...args.progress,
        semantic_event_id: eventIdFor({
          tenantId: args.tenantId,
          scope: args.scope,
          operationKind,
          operationId: args.operationId,
        }),
      });
      return await appendWithSavepoint("progress_state", {
        ...args,
        occurredAt: progress.recorded_at,
        operationKind,
        payload: {
          event_kind: "progress_state_recorded",
          progress,
        },
      });
    },

    async appendPlannedAction(args) {
      const operationKind =
        LITE_EXECUTION_EPISODE_OPERATION_KIND.plannedAction;
      const plannedAction = PlannedActionEventV1Schema.parse({
        ...args.plannedAction,
        semantic_event_id: eventIdFor({
          tenantId: args.tenantId,
          scope: args.scope,
          operationKind,
          operationId: args.operationId,
        }),
      });
      return await appendWithSavepoint("planned_action", {
        ...args,
        occurredAt: plannedAction.recorded_at,
        operationKind,
        payload: {
          event_kind: "planned_action_recorded",
          planned_action: plannedAction,
        },
      });
    },

    async reserveVerifierInvocation(args) {
      return await withExecutionEpisodeMutationSavepoint(
        db,
        transaction,
        "verifier_invocation",
        () => reserveVerifierInvocationInCurrentTransaction(
          db,
          transaction,
          args,
        ),
      );
    },

    async getVerifierInvocation(args) {
      return await transaction.read(() => {
        const invocationRow = db.prepare(
          `SELECT 1 AS present
           FROM lite_execution_verifier_invocations
           WHERE tenant_id = ? AND scope = ? AND episode_id = ?
             AND verifier_invocation_id = ?`,
        ).get(
          args.tenantId,
          args.scope,
          args.episodeId,
          args.verifierInvocationId,
        );
        const operation = operationRow(db, {
          tenantId: args.tenantId,
          scope: args.scope,
          operationKind:
            LITE_EXECUTION_EPISODE_OPERATION_KIND.verifierInvocation,
          operationId: args.verifierInvocationId,
        });
        if (!invocationRow && !operation) return null;
        if (!invocationRow || !operation) {
          throw new Error(
            "execution_verifier_invocation_operation_authority_mismatch",
          );
        }
        return loadPersistedVerifierInvocation(db, args);
      });
    },

    async authorizeVerifierInvocationLaunch(args) {
      return await transaction.read(() => {
        const issuer = options.verifierInvocationAuthorityIssuer;
        const verifier = options.verifierInvocationAuthorityVerifier;
        if (!issuer || !verifier) {
          throw new Error(
            "execution_verifier_invocation_authority_channel_unavailable",
          );
        }
        const invocation = loadPersistedVerifierInvocation(db, args);
        if (invocation.launch_authority.kind !== "runtime_launched") {
          throw new Error(
            "execution_verifier_runtime_launch_authority_required",
          );
        }
        const completed = db.prepare(
          `SELECT 1 AS present
           FROM lite_execution_verifier_receipts
           WHERE tenant_id = ? AND scope = ? AND episode_id = ?
             AND verifier_invocation_id = ?`,
        ).get(
          args.tenantId,
          args.scope,
          args.episodeId,
          args.verifierInvocationId,
        );
        if (completed) {
          throw new Error("execution_verifier_invocation_already_completed");
        }
        if (openLaunchAttemptForInvocation(db, args)) {
          throw new Error(
            "execution_verifier_invocation_launch_already_active",
          );
        }
        const currentSnapshotId = currentStateSnapshotId(db, {
          tenantId: args.tenantId,
          scope: args.scope,
          episodeId: args.episodeId,
        });
        if (currentSnapshotId !== invocation.target_state_snapshot_id) {
          throw new Error("execution_verifier_invocation_target_state_stale");
        }
        const row = db.prepare(
          `SELECT episode.subject_identity_json,
                  snapshot.content_digest, snapshot.environment_digest
           FROM lite_execution_episodes AS episode
           JOIN lite_execution_state_snapshots AS snapshot
             ON snapshot.tenant_id = episode.tenant_id
            AND snapshot.scope = episode.scope
            AND snapshot.episode_id = episode.episode_id
            AND snapshot.snapshot_id = ?
           WHERE episode.tenant_id = ? AND episode.scope = ?
             AND episode.episode_id = ?`,
        ).get(
          invocation.target_state_snapshot_id,
          args.tenantId,
          args.scope,
          args.episodeId,
        ) as {
          subject_identity_json: string;
          content_digest: string;
          environment_digest: string;
        } | undefined;
        if (!row) {
          throw new Error("execution_verifier_invocation_target_state_missing");
        }
        const subjectIdentity = ExecutionEpisodeSubjectIdentityV1Schema.parse(
          parseCanonicalJson(
            row.subject_identity_json,
            "execution_episode_subject_identity",
          ),
        );
        const reservation = issuer.issuePersistedReservation({
          persisted_invocation: invocation,
          persisted_invocation_digest: verifierInvocationDigest(invocation),
        });
        const authority = issuer.authorizeMaterializedLaunch({
          persisted_reservation: reservation,
          subject_identity: subjectIdentity,
          source_subject_root: args.sourceSubjectRoot,
          source_content_digest: row.content_digest,
          source_environment_digest: row.environment_digest,
          materialization: args.materialization,
        });
        return { invocation, authority };
      });
    },

    async prepareVerifierLaunchAttempt(args) {
      return await withExecutionEpisodeMutationSavepoint(
        db,
        transaction,
        "verifier_launch_attempt",
        () => prepareVerifierLaunchAttemptInCurrentTransaction(
          db,
          transaction,
          options,
          args,
        ),
      );
    },

    async appendVerifierSpawnObservation(args) {
      return await withExecutionEpisodeMutationSavepoint(
        db,
        transaction,
        "verifier_spawn_observation",
        () => appendVerifierSpawnObservationInCurrentTransaction(
          db,
          transaction,
          args,
        ),
      );
    },

    async getOpenVerifierLaunchAttempt(args) {
      return await transaction.read(() =>
        openLaunchAttemptForInvocation(db, args));
    },

    async listOpenVerifierLaunchAttempts() {
      return await transaction.read(() => {
        const rows = db.prepare(
          `SELECT attempt.*
           FROM lite_execution_verifier_launch_attempts AS attempt
           WHERE NOT EXISTS (
             SELECT 1
             FROM lite_execution_verifier_launch_attempt_events AS terminal
             WHERE terminal.tenant_id = attempt.tenant_id
               AND terminal.scope = attempt.scope
               AND terminal.episode_id = attempt.episode_id
               AND terminal.verifier_invocation_id =
                 attempt.verifier_invocation_id
               AND terminal.launch_attempt_id = attempt.launch_attempt_id
               AND terminal.event_kind IN ('completed', 'interrupted')
           )
           ORDER BY attempt.tenant_id, attempt.scope, attempt.episode_id,
                    attempt.verifier_invocation_id,
                    attempt.attempt_ordinal`,
        ).all() as SqlRow[];
        return Object.freeze(rows.map((row) => {
          const attempt = launchAttemptFromRow(row);
          const events = launchEventsForAttempt(db, attempt);
          if (
            events.length === 0
            || events[0]?.payload.event_kind !== "launch_committed"
          ) {
            throw new Error(
              "execution_verifier_open_launch_attempt_invalid",
            );
          }
          return Object.freeze({ attempt, events });
        }));
      });
    },

    async recordInterruptedVerifierOutcome(args) {
      return await withExecutionEpisodeMutationSavepoint(
        db,
        transaction,
        "verifier_interrupted_outcome",
        () => {
          const attempt = launchAttemptRow(db, {
            tenantId: args.tenantId,
            scope: args.scope,
            episodeId: args.episodeId,
            launchAttemptId: args.launchAttemptId,
          });
          if (!attempt) {
            throw new Error(
              "execution_verifier_launch_attempt_missing",
            );
          }
          const events = launchEventsForAttempt(db, attempt);
          const existingTerminal = events.find((event) =>
            event.payload.event_kind === "completed"
            || event.payload.event_kind === "interrupted");
          if (existingTerminal) {
            throw new Error(
              "execution_verifier_launch_attempt_already_terminal",
            );
          }
          const ownerAborted =
            args.recoveryInstanceId === attempt.owner_instance_id;
          if (
            args.recoveryProcessId <= 0
            || (
              ownerAborted
              && args.recoveryProcessId !== attempt.owner_process_id
            )
          ) {
            throw new Error(
              "execution_verifier_launch_attempt_recovery_owner_invalid",
            );
          }
          const expectedReason = ownerAborted
            ? "runtime_episode_verifier_owner_aborted_before_result"
            : events.some((event) =>
              event.payload.event_kind === "spawn_observed")
              ? "runtime_episode_verifier_recovered_process_interrupted"
              : "runtime_episode_verifier_recovered_launch_ambiguous";
          if (
            args.interruptedEvidence.contract_version
              !== "runtime_episode_verifier_interrupted_launch_evidence_v1"
            || canonicalJson(args.interruptedEvidence.attempt)
              !== canonicalJson(attempt)
            || canonicalJson(args.interruptedEvidence.observed_events)
              !== canonicalJson(events)
            || args.interruptedEvidence.terminal_reason !== expectedReason
            || args.interruptedEvidence.recovery_instance_id
              !== args.recoveryInstanceId
            || args.interruptedEvidence.recovery_process_id
              !== args.recoveryProcessId
            || args.interruptedEvidence.recovered_at !== args.recoveredAt
          ) {
            throw new Error(
              "execution_verifier_interrupted_evidence_mismatch",
            );
          }
          assertCanonicalTimestamp(
            args.recoveredAt,
            "execution_verifier_launch_recovery",
          );
          const lastEvent = events.at(-1);
          if (
            !lastEvent
            || Date.parse(args.recoveredAt)
              < Date.parse(lastEvent.recorded_at)
          ) {
            throw new Error(
              "execution_verifier_launch_recovery_time_invalid",
            );
          }
          assertInterruptedVerifierOutputEvidence(db, {
            tenantId: args.tenantId,
            scope: args.scope,
            episodeId: args.episodeId,
            ref: args.verifierOutputRef,
            evidence: args.interruptedEvidence,
          });
          const terminalEvent = buildLaunchEvent(attempt, {
            previous: lastEvent,
            ownerInstanceId: args.recoveryInstanceId,
            ownerProcessId: args.recoveryProcessId,
            payload: Object.freeze({
              contract_version:
                "runtime_episode_verifier_launch_terminal_payload_v1",
              event_kind: "interrupted",
              verifier_output_artifact_id:
                args.verifierOutputRef.artifact_id,
              verifier_output_sha256: args.verifierOutputRef.sha256,
              runtime_launch_sha256: null,
              result_sha256: null,
              effective_status: "infrastructure_error",
              infrastructure_failure_reasons:
                Object.freeze([expectedReason]),
              infrastructure_failure_attribution: "arm_caused",
            }),
            recordedAt: args.recoveredAt,
          });
          insertLaunchEvent(db, terminalEvent);
          const invocation = loadPersistedVerifierInvocation(db, {
            tenantId: args.tenantId,
            scope: args.scope,
            episodeId: args.episodeId,
            verifierInvocationId: attempt.verifier_invocation_id,
          });
          const verifiedStateSnapshot = storedStateSnapshot(db, {
            tenantId: args.tenantId,
            scope: args.scope,
            episodeId: args.episodeId,
            snapshotId: invocation.target_state_snapshot_id,
          });
          const material = {
            contract_version: "verifier_outcome_receipt_v1" as const,
            verifier_receipt_id: interruptedVerifierReceiptId(
              attempt,
              terminalEvent.event_sha256,
            ),
            episode_id: attempt.episode_id,
            verifier_id: invocation.verifier_id,
            verifier_definition_sha256:
              invocation.verifier_definition_sha256,
            verifier_kind: invocation.verifier_kind,
            verifier_version: invocation.verifier_version,
            verifier_issuer_id: invocation.verifier_issuer_id,
            verifier_runner_instance_id:
              invocation.verifier_runner_instance_id,
            verifier_invocation_id:
              invocation.verifier_invocation_id,
            verifier_invocation_digest:
              verifierInvocationDigest(invocation),
            verifier_program_digest:
              invocation.verifier_program_digest,
            verifier_config_digest:
              invocation.verifier_config_digest,
            verifier_environment_digest:
              invocation.verifier_environment_digest,
            verified_state_snapshot_id:
              verifiedStateSnapshot.snapshot_id,
            verified_state_snapshot_algorithm_version:
              verifiedStateSnapshot.algorithm_version,
            verifier_input_ref: invocation.verifier_input_ref,
            verifier_output_ref: args.verifierOutputRef,
            execution_exit_code: null,
            status: "infrastructure_error" as const,
            infrastructure_failure_reasons: [expectedReason],
            infrastructure_failure_attribution:
              "arm_caused" as const,
            completed_at: args.recoveredAt,
          };
          const outcome = VerifierOutcomeReceiptV1Schema.parse({
            ...material,
            attestation: {
              kind: "runtime_launched",
              runtime_launch_sha256: terminalEvent.event_sha256,
            },
            evidence_digest: verifierOutcomeEvidenceDigest(material),
          });
          const append = appendEventInCurrentTransaction(
            db,
            transaction,
            options,
            {
              tenantId: args.tenantId,
              scope: args.scope,
              operationId: attempt.outcome_operation_id,
              operationKind:
                LITE_EXECUTION_EPISODE_OPERATION_KIND.verifierOutcome,
              payload: {
                event_kind: "verifier_recorded",
                invocation,
                outcome,
                verified_state_snapshot: verifiedStateSnapshot,
              },
            },
          );
          return Object.freeze({
            invocation,
            outcome,
            verifiedStateSnapshot,
            terminalEvent,
            append,
          });
        },
      );
    },

    recordVerifierOutcome,

    appendVerifier: recordVerifierOutcome,

    async closeEpisode(args) {
      return await withExecutionEpisodeMutationSavepoint(
        db,
        transaction,
        "close",
        () => {
      const outcomeDetails = canonicalOutcomeDetails(args.outcomeDetails);
      const existing = eventByOperation(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: LITE_EXECUTION_EPISODE_OPERATION_KIND.close,
        operationId: args.operationId,
      });
      if (existing) {
        if (
          existing.episode_id !== args.episodeId
          || existing.payload.event_kind !== "episode_closed"
          || existing.payload.termination !== args.termination
          || (existing.payload.reward.verifier_receipt_id
            ?? undefined) !== args.verifierReceiptId
          || canonicalJson(existing.payload.outcome_details)
            !== canonicalJson(outcomeDetails)
          || !costInputMatchesReceipt(
            args.cost,
            existing.payload.cost_receipt,
          )
        ) {
          throw new Error("execution_episode_operation_conflict");
        }
        return appendEventInCurrentTransaction(db, transaction, options, {
          tenantId: args.tenantId,
          scope: args.scope,
          operationId: args.operationId,
          operationKind: LITE_EXECUTION_EPISODE_OPERATION_KIND.close,
          occurredAt: existing.occurred_at,
          payload: existing.payload,
        });
      }
      const derived = deriveEpisodeClose(db, options, {
        ...args,
        outcomeDetails,
      });
      return appendEventInCurrentTransaction(db, transaction, options, {
        tenantId: args.tenantId,
        scope: args.scope,
        operationId: args.operationId,
        occurredAt: derived.closedAt,
        operationKind: LITE_EXECUTION_EPISODE_OPERATION_KIND.close,
        payload: {
          event_kind: "episode_closed",
          termination: args.termination,
          outcome_details: outcomeDetails,
          reward: derived.reward,
          cost_receipt: derived.costReceipt,
          final_state_snapshot: derived.finalStateSnapshot,
          closed_at: derived.closedAt,
        },
      });
        },
      );
    },

    async getEpisode(args) {
      return await transaction.read(() => inspectLiteExecutionEpisode(db, {
        ...args,
        options,
      }));
    },

    async replayEpisode(args) {
      return await transaction.read(() => assertLiteExecutionEpisodeIntegrity(
        db,
        { ...args, options },
      ));
    },

    async listMemoryCompilationCandidates(args) {
      const limit = Math.max(1, Math.min(500, Math.trunc(args.limit)));
      const offset = Math.max(0, Math.trunc(args.offset ?? 0));
      return await transaction.read(() => db.prepare(
        `SELECT reward.tenant_id,
                reward.scope AS store_scope,
                episode.public_scope,
                reward.episode_id,
                reward.reward_id,
                reward.reward_sha256,
                reward.outcome_class,
                reward.close_event_id,
                event.event_sha256 AS close_event_sha256,
                reward.created_at
         FROM lite_execution_episode_rewards AS reward
         JOIN lite_execution_episodes AS episode
           ON episode.tenant_id = reward.tenant_id
          AND episode.scope = reward.scope
          AND episode.episode_id = reward.episode_id
         JOIN lite_execution_episode_events AS event
           ON event.tenant_id = reward.tenant_id
          AND event.scope = reward.scope
          AND event.episode_id = reward.episode_id
          AND event.event_id = reward.close_event_id
         WHERE reward.outcome_class IN ('verified_pass', 'verified_failure')
         ORDER BY reward.created_at ASC,
                  reward.tenant_id ASC,
                  reward.scope ASC,
                  reward.episode_id ASC
         LIMIT ? OFFSET ?`,
      ).all(limit, offset) as LiteExecutionEpisodeMemoryCompilationCandidate[]);
    },

    async verifyEpisodeIntegrity(args) {
      return await transaction.read(() => assertLiteExecutionEpisodeIntegrity(
        db,
        { ...args, options },
      ));
    },

    async verifyIntegrity() {
      return await transaction.read(
        () => assertLiteExecutionEpisodeStoreIntegrity(db, options),
      );
    },
  };
}
