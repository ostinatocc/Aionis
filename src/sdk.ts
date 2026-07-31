// Runtime reference SDK implementation.
// This file is the canonical source for the standalone SDK.

// <aionis-runtime-owned:public-contracts>

import { createHash } from "node:crypto";

export type AionisJsonObject = Record<string, unknown>;

export type AionisFeedbackOutcome = "positive" | "negative" | "neutral";
export type AionisFeedbackUsedSurface = "use_now" | "inspect_before_use" | "do_not_use" | "explicit_host_assertion";
export type AionisFeedbackStatus = "passed" | "failed" | "not_run" | "unknown";
export type AionisToolStatus = "succeeded" | "failed" | "not_run" | "unknown";
export type AionisRehydrateMode = "summary_only" | "partial" | "full" | "differential";
export type AionisForgetTarget = "archive" | "payload" | "memory";
export type AionisMemoryLane = "private" | "shared";
export type AionisRememberKind = "fact" | "preference" | "project_context" | "procedure" | "event" | "evidence";
export type AionisRememberLifecycleState = "active" | "candidate" | "contested" | "suppressed" | "demoted" | "archived";
export type AionisRememberTier = "hot" | "warm" | "cold" | "archive";
export type AionisExecutionAgentRole = "agent" | "planner" | "worker" | "verifier" | "reviewer";
export type AionisExecutionOutcomeStatus = "succeeded" | "failed" | "blocked" | "interrupted" | "unknown";
export type AionisCommandPostureKind =
  | "must_not"
  | "should_continue"
  | "inspect_first"
  | "rehydrate_first"
  | "optional_context";
export type AionisCommandPostureSurface =
  | "current"
  | "procedure"
  | "use_now"
  | "inspect_before_use"
  | "do_not_use"
  | "rehydrate"
  | "context";

export type AionisCommandPosture = {
  posture: AionisCommandPostureKind;
  surface: AionisCommandPostureSurface;
  memory_id: string;
  instruction: string;
  reason: string;
  target_files: string[];
  workflow_steps?: string[];
  acceptance_checks?: string[];
  verification_summary?: string[];
  artifact_hints?: string[];
  execution_state?: {
    summary_kind: string | null;
    transition_kind: string | null;
    actor_role: string | null;
    handoff_target: string | null;
    next_action_hint: string | null;
    execution_outcome_role: "passed_solution" | "failed_branch" | "blocked" | "unknown" | null;
  };
};

export type AionisRehydrateHint = {
  memory_id: string;
  reason?: string;
  required: boolean;
};

export type AionisGuideExecutionContextInput = AionisJsonObject & {
  task_id?: string;
  task_signature?: string;
  task_family?: string;
  workflow_signature?: string;
};

export type AionisMemoryResolveType =
  | "event"
  | "entity"
  | "topic"
  | "rule"
  | "evidence"
  | "concept"
  | "procedure"
  | "self_model";

export type AionisMemoryResolveRequest = AionisJsonObject & {
  uri: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  include_meta?: boolean;
  include_slots?: boolean;
  include_slots_preview?: boolean;
  slots_preview_keys?: number;
};

export type AionisResolvedAgentEvidenceSurface = "inspect_before_use" | "rehydrate";

export type AionisResolvedAgentEvidence = {
  memory_id: string;
  surface: AionisResolvedAgentEvidenceSurface;
  uri: string | null;
  resolved_type: AionisMemoryResolveType | null;
  resolved: boolean;
  source: "handoff_text" | "text_summary" | "slots_json" | "node_title" | "unresolved";
  evidence_text: string;
  response?: unknown;
  error?: {
    message: string;
    status?: number;
  };
};

export type AionisGuideAgentContextOptions = {
  evidence_limit?: number;
  include_inspect_before_use?: boolean;
  include_rehydrate?: boolean;
  resolve_types?: AionisMemoryResolveType[];
  on_resolve_error?: "include_placeholder" | "skip" | "throw";
};

export type AionisGuideAgentContextResult<TGuide = unknown> = {
  contract_version: "aionis_sdk_agent_context_with_evidence_v1";
  guide: TGuide;
  agent_context: unknown | null;
  agent_prompt: string;
  resolved_evidence: AionisResolvedAgentEvidence[];
  unresolved_memory_ids: string[];
  evidence_char_count: number;
  prompt_char_count: number;
  guide_trace_id: string | null;
};

export type AionisAgentContext<TGuide = unknown> = AionisGuideAgentContextResult<TGuide>;
export type AionisAgentContextOptions = AionisGuideAgentContextOptions;
export type AionisAgentContextResult<TGuide = unknown> = AionisGuideAgentContextResult<TGuide>;

export type AionisClientOptions = {
  baseUrl: string;
  apiKey?: string;
  tenant_id?: string;
  scope?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
};

export type AionisRequestOptions = {
  tenant_id?: string;
  scope?: string;
  headers?: Record<string, string>;
};

export type AionisGuideRequestOptions = AionisRequestOptions;

export type AionisHostTaskEnvelopeV1 = {
  contract_version: "host_task_envelope_v1";
  host_task_id: string;
  collector_id: string;
  collector_version: string;
  task_family: string;
  task_signature: string;
  repository_signature: string;
  source_task_sha256: string;
  source_event_sha256: string;
  created_at: string;
};

export type AionisHostUseReceiptSurface = "use_now" | "inspect_before_use" | "do_not_use";
export type AionisHostUseReceiptActionOutcome =
  | "accepted_completed"
  | "accepted_incomplete"
  | "rejected"
  | "not_applicable";
export type AionisHostUseReceiptVerifierKind = "instrumented_agent_trace" | "deterministic_scorer";

export type AionisHostUseReceiptItemV1 = {
  memory_id: string;
  used_surface: AionisHostUseReceiptSurface;
  outcome: AionisFeedbackOutcome;
  action_outcome: AionisHostUseReceiptActionOutcome;
  verifier_kind: AionisHostUseReceiptVerifierKind;
  verifier_version: string;
  verifier_config_sha256: string;
  verifier_status: "passed";
  content_evidence_sha256: string;
  evidence_ref_sha256: string;
};

export type AionisHostUseReceiptV1Body = {
  contract_version: "host_use_receipt_v1";
  receipt_id: string;
  guide_trace_id: string;
  episode_id: string;
  operation_id: string;
  run_id: string;
  host_task_id: string;
  host_task_envelope_sha256: string;
  collector_id: string;
  collector_version: string;
  host_trace_sha256: string;
  observed_at: string;
  items: AionisHostUseReceiptItemV1[];
};

export type AionisHostUseReceiptV1 = AionisHostUseReceiptV1Body & {
  receipt_sha256: string;
};

export type AionisGuideFeedbackAttributionSurface =
  | AionisHostUseReceiptSurface
  | "rehydrate";

export type AionisGuideFeedbackAttributionItemV1 = {
  memory_id: string;
  served_surface: AionisGuideFeedbackAttributionSurface;
};

export type AionisGuideFeedbackAttributionAvailableV1 = {
  contract_version: "aionis_guide_feedback_attribution_v1";
  status: "available";
  guide_trace_id: string;
  episode_id: string;
  exposure_event_id: string;
  item_set_sha256: string;
  served_surface_sha256: string;
  projection_complete: boolean;
  projection_incomplete_reason_codes: string[];
  items: AionisGuideFeedbackAttributionItemV1[];
};

export type AionisGuideFeedbackAttributionUnavailableV1 = {
  contract_version: "aionis_guide_feedback_attribution_v1";
  status: "unavailable";
  guide_trace_id: string;
  reason_code: "learning_exposure_not_persisted";
};

export type AionisGuideFeedbackAttributionV1 =
  | AionisGuideFeedbackAttributionAvailableV1
  | AionisGuideFeedbackAttributionUnavailableV1;

export type AionisGuideFeedbackErrorCode =
  | "guide_feedback_attribution_missing"
  | "guide_feedback_attribution_invalid"
  | "guide_feedback_attribution_unavailable"
  | "guide_feedback_context_only_memory"
  | "guide_feedback_unknown_memory"
  | "guide_feedback_duplicate_memory"
  | "guide_feedback_mixed_served_surfaces"
  | "guide_feedback_served_surface_mismatch"
  | "guide_feedback_rehydrate_not_feedbackable"
  | "guide_feedback_explicit_assertion_not_exact"
  | "guide_feedback_host_receipt_required";

export class AionisGuideFeedbackError extends Error {
  readonly code: AionisGuideFeedbackErrorCode;

  constructor(code: AionisGuideFeedbackErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AionisGuideFeedbackError";
    this.code = code;
  }
}

export type AionisExecutionSessionLeaseContextV1 = {
  contract_version: "execution_session_lease_context_v1";
  session_key: string;
  continuation_id: string;
  holder_id: string;
  lease_id: string;
  lease_revision: number;
  lease_operation_id: string;
  lease_ttl_ms?: number;
};

export type AionisGuideRequest = AionisJsonObject & {
  operation_id?: string;
  episode_id?: string;
  expected_current_state_snapshot_id?: string;
  tenant_id?: string;
  scope?: string;
  host_task_envelope_v1?: AionisHostTaskEnvelopeV1;
  query_text: string;
  agent_role?: AionisExecutionAgentRole;
  context?: AionisJsonObject;
  run_id?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  context_char_budget?: number;
  execution_state_v1?: AionisJsonObject;
  execution_packet_v1?: AionisJsonObject;
  include_packets?: boolean;
  session_lease_v1?: AionisExecutionSessionLeaseContextV1;
};

export type AionisGuideResult<TGuide extends AionisJsonObject = AionisJsonObject> = TGuide & {
  operation_id?: string;
  feedback_attribution_v1?: AionisGuideFeedbackAttributionV1;
};

export type AionisObserveRequest = AionisJsonObject & {
  operation_id?: string;
};

export type AionisObserveResult = AionisJsonObject & {
  contract_version: "aionis_observe_result_v1";
  operation_id: string;
  tenant_id: string;
  scope: string;
  observed: AionisJsonObject & {
    memory_written: boolean;
    general_memory_count: number;
    execution_memory_count: number;
    auto_text_memory_count: number;
    execution_observation_count: number;
  };
  post_commit_projections: {
    semantic_commit: "committed";
    embedding: "scheduled" | "not_requested";
    ann_sync: "scheduled" | "not_requested";
  };
};

export type AionisExecutionEpisodeBudgetV1 = {
  max_steps: number;
  max_tokens: number;
  max_cost_micros?: number;
  deadline_ms?: number;
};

export type AionisExecutionEpisodeSubjectStateSpecV2 =
  | {
    contract_version: "workspace_subject_state_spec_v2";
    additional_state_roots: string[];
  }
  | {
    contract_version: "structured_artifact_subject_state_spec_v1";
    format: "json";
    capture_scope: "entire_artifact";
  }
  | {
    contract_version: "sqlite_database_subject_state_spec_v1";
    capture_scope: "entire_database";
  };

export type AionisExecutionEpisodeRequiredVerifierV1 = {
  contract_version: "execution_episode_required_verifier_v1";
  verifier_id: string;
  verifier_definition_sha256: string;
};

export type AionisExecutionSubjectV1 = {
  contract_version: "execution_subject_v1";
  subject_id: string;
  kind: string;
  adapter_id: string;
  adapter_version: string;
  identity_sha256: string;
  capability_descriptor_ref: string;
  capability_descriptor_sha256: string;
};

export type AionisStateSnapshotV2 = {
  contract_version: "state_snapshot_v2";
  snapshot_id: string;
  subject: AionisExecutionSubjectV1;
  captured_at: string;
  algorithm_id: string;
  algorithm_version: string;
  environment_sha256: string;
  content_ref: string;
  content_sha256: string;
  content_media_type: string;
  content_encoding: string;
  capture_authority: "runtime_adapter" | "signed_host_adapter";
  attestation_ref: string | null;
};

export type AionisExecutionEpisodeHandleV2 = {
  contract_version: "aionis_execution_episode_handle_v2";
  episode_id: string;
  tenant_id: string;
  scope: string;
  task_id: string;
  task_envelope_digest: string;
  run_id: string;
  workspace_root: string;
  workspace_root_sha256: string;
  subject: AionisExecutionSubjectV1;
  current_state_snapshot_id: string;
  current_state: AionisStateSnapshotV2;
  required_verifier: AionisExecutionEpisodeRequiredVerifierV1;
  closed: boolean;
};

export type AionisAgentSessionHandleV1 = {
  contract_version: "aionis_agent_session_handle_v1";
  session_key: string;
  continuation_id: string;
  holder_id: string;
  lease_id: string;
  lease_revision: number;
  lease_status: "active" | "released" | "expired";
  lease_expires_at: string | null;
  episode: AionisExecutionEpisodeHandleV2;
};

export type AionisBeginAgentSessionInput =
  Omit<AionisBeginEpisodeInput, "operation_id"> & {
    operation_id: string;
    session_key: string;
    continuation_id: string;
    holder_id: string;
    lease_ttl_ms?: number;
  };

export type AionisResumeAgentSessionInput = {
  operation_id: string;
  session_key: string;
  holder_id: string;
  workspace_root: string;
  lease_ttl_ms?: number;
  tenant_id?: string;
  scope?: string;
};

export type AionisAgentSessionLeaseOperationInput = {
  handle: AionisAgentSessionHandleV1;
  operation_id: string;
  lease_ttl_ms?: number;
};

export type AionisAgentSessionHandoffInput =
  AionisAgentSessionLeaseOperationInput & {
    to_holder_id: string;
    evidence_refs?: string[];
  };

export type AionisAgentSessionOperationResult<T = unknown> = {
  handle: AionisAgentSessionHandleV1;
  response: T;
};

export type AionisAgentSessionTurnInput = {
  operation_id: string;
  observation: string;
  authority: AionisSemanticEventAuthorityV1;
  evidence_kind: AionisSemanticEvidenceKindV1;
  evidence: string | Uint8Array | AionisJsonObject;
  evidence_media_type?: string;
  evidence_encoding?: string;
  guide: Omit<AionisGuideRequest, "operation_id">;
  lease_ttl_ms?: number;
};

export type AionisAgentSessionTurnResult<TGuide = unknown> = {
  observation: unknown;
  context: AionisGuideAgentContextResult<TGuide>;
};

export type AionisAgentSessionAroundActionInput<TResult> = {
  operation_id: string;
  action_kind: string;
  tool_name?: string;
  request: string | Uint8Array | AionisJsonObject;
  execute: () => Promise<TResult>;
  serialize_result?: (
    result: TResult,
  ) => string | Uint8Array | AionisJsonObject;
  lease_ttl_ms?: number;
};

export type AionisAgentSessionAroundActionResult<TResult, TReceipt> = {
  result: TResult;
  receipt: TReceipt;
};

export type AionisAgentSessionFinishInput =
  Omit<
    AionisCloseEpisodeInput,
    | "handle"
    | "operation_id"
    | "session_lease_v1"
    | "verifier_receipt_id"
  > & {
    verifier_operation_id: string;
    close_operation_id: string;
    recovery_mode?: "automatic" | "manual";
    recovery_operation_id?: string;
    lease_ttl_ms?: number;
  };

export type AionisAgentSessionVerifierStatus =
  | "passed"
  | "failed"
  | "infrastructure_error"
  | "inconclusive"
  | "unknown";

export type AionisAgentSessionRecoveryResult<TRecovery = unknown> =
  Readonly<{
    contract_version: "aionis_agent_session_recovery_result_v1";
    status: "restored";
    operation_id: string;
    failed_snapshot_id: string;
    failed_verifier_receipt_id: string;
    restored_snapshot_id: string;
    accepted_verifier_receipt_id: string;
    response: TRecovery;
  }>;

export type AionisAgentSessionFinishResult<
  TVerifier = unknown,
  TClose = unknown,
  TRecovery = unknown,
> =
  | Readonly<{
    contract_version: "aionis_agent_session_finish_result_v1";
    status: "completed";
    verifier_status: "passed";
    verifier: TVerifier;
    close: TClose;
    continuation: null;
  }>
  | Readonly<{
    contract_version: "aionis_agent_session_finish_result_v1";
    status: "continue";
    verifier_status: Exclude<
      AionisAgentSessionVerifierStatus,
      "passed"
    >;
    verifier: TVerifier;
    close: null;
    continuation: Readonly<{
      reason:
        | "verifier_failed"
        | "verifier_infrastructure_error"
        | "verifier_inconclusive"
        | "verifier_outcome_unavailable"
        | "verified_branch_restored";
      current_state_snapshot_id: string;
      verifier_receipt_id: string | null;
      recovery:
        AionisAgentSessionRecoveryResult<TRecovery> | null;
    }>;
  }>
  | Readonly<{
    contract_version: "aionis_agent_session_finish_result_v1";
    status: "terminated";
    verifier_status: AionisAgentSessionVerifierStatus;
    verifier: TVerifier;
    close: TClose;
    continuation: null;
  }>;

export type AionisBeginEpisodeInput = {
  operation_id: string;
  task_envelope_v1: AionisHostTaskEnvelopeV1;
  source_task: string | Uint8Array;
  run_id: string;
  model_id: string;
  model_config: unknown;
  budget: AionisExecutionEpisodeBudgetV1;
  workspace_root: string;
  subject_state_spec_v2?: AionisExecutionEpisodeSubjectStateSpecV2;
  required_verifier_id: string;
  tenant_id?: string;
  scope?: string;
};

export type AionisResumeEpisodeInput = {
  episode_id: string;
  workspace_root: string;
  tenant_id?: string;
  scope?: string;
};

export type AionisRecordEpisodeActionInput = {
  handle: AionisExecutionEpisodeHandleV2;
  operation_id: string;
  expected_current_state_snapshot_id?: string;
  action_kind: string;
  tool_name?: string;
  request: string | Uint8Array | AionisJsonObject;
  result: string | Uint8Array | AionisJsonObject;
  session_lease_v1?: AionisExecutionSessionLeaseContextV1;
};

export type AionisRestoreEpisodeSnapshotInput = {
  handle: AionisExecutionEpisodeHandleV2;
  operation_id: string;
  target_snapshot_id: string;
  expected_current_state_snapshot_id?: string;
  session_lease_v1?: AionisExecutionSessionLeaseContextV1;
};

export type AionisSemanticEventAuthorityV1 =
  | {
    kind: "host_declared";
    actor_id: string;
  }
  | {
    kind: "model_derived";
    actor_id: string;
    model_id: string;
    derivation_sha256: string;
    uncertainty: number;
  };

export type AionisSemanticEvidenceKindV1 =
  | "feature_vector"
  | "prompt"
  | "tool_request"
  | "tool_result"
  | "manifest";

export type AionisDecisiveEvidenceExcerptInputV1 = {
  source_ref: string;
  excerpt: string;
};

type AionisRecordEpisodeSemanticInputBase = {
  handle: AionisExecutionEpisodeHandleV2;
  operation_id: string;
  expected_current_state_snapshot_id?: string;
  authority: AionisSemanticEventAuthorityV1;
  evidence_kind: AionisSemanticEvidenceKindV1;
  evidence: string | Uint8Array | AionisJsonObject;
  evidence_media_type?: string;
  evidence_encoding?: string;
  decisive_evidence?: AionisDecisiveEvidenceExcerptInputV1[];
  session_lease_v1?: AionisExecutionSessionLeaseContextV1;
};

export type AionisRecordEpisodeObservationInput =
  AionisRecordEpisodeSemanticInputBase & {
    observation: string;
  };

export type AionisRecordEpisodeDecisionInput =
  AionisRecordEpisodeSemanticInputBase & {
    decision: string;
    reasons: string[];
    alternatives_rejected: string[];
  };

export type AionisRecordEpisodeProgressInput =
  AionisRecordEpisodeSemanticInputBase & {
    item_id: string;
    state: "completed" | "failed" | "unresolved" | "blocked";
    statement: string;
  };

export type AionisRecordEpisodePlannedActionInput =
  AionisRecordEpisodeSemanticInputBase & {
    action_id: string;
    intent: string;
    justification: string;
    preconditions: string[];
  };

export type AionisGuideEpisodeInput = {
  handle: AionisExecutionEpisodeHandleV2;
  operation_id: string;
  guide: AionisGuideRequest;
};

export type AionisRecordEpisodeMutationInput = {
  handle: AionisExecutionEpisodeHandleV2;
  operation_id: string;
  expected_current_state_snapshot_id?: string;
  mutation_kind: string;
  details?: AionisJsonObject;
  session_lease_v1?: AionisExecutionSessionLeaseContextV1;
};

export type AionisRunEpisodeVerifierInput = {
  handle: AionisExecutionEpisodeHandleV2;
  operation_id: string;
  expected_current_state_snapshot_id?: string;
  session_lease_v1?: AionisExecutionSessionLeaseContextV1;
};

export type AionisExecutionEpisodeTermination =
  | "completed"
  | "agent_error"
  | "timeout"
  | "cancelled"
  | "missing_verifier";

export type AionisExecutionCostInputV1 = {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
  token_usage_authority: "provider_total" | "signed_host_receipt";
  usage_receipt: string | Uint8Array | AionisJsonObject;
  usage_receipt_media_type?: string;
  usage_receipt_encoding?: string;
  monetary_cost_micros?: number;
  currency?: string;
  producer_id: string;
};

export type AionisCloseEpisodeInput = {
  handle: AionisExecutionEpisodeHandleV2;
  operation_id: string;
  expected_current_state_snapshot_id?: string;
  termination: AionisExecutionEpisodeTermination;
  verifier_receipt_id?: string;
  outcome_details?: string[];
  cost?: AionisExecutionCostInputV1;
  session_lease_v1?: AionisExecutionSessionLeaseContextV1;
};

export type AionisExecutionEpisodeOperationResult<T = unknown> = {
  handle: AionisExecutionEpisodeHandleV2;
  response: T;
};

export type AionisRememberRequest = AionisJsonObject & {
  text: string;
  kind?: AionisRememberKind;
  title?: string;
  client_id?: string;
  memory_lane?: AionisMemoryLane;
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  lifecycle_state?: AionisRememberLifecycleState;
  tier?: AionisRememberTier;
  confidence?: number;
  salience?: number;
  importance?: number;
  auto_embed?: boolean;
  raw_ref?: string;
  evidence_ref?: string;
  target_files?: string[];
  slots?: AionisJsonObject;
};

export type AionisMemoryFeedbackRequest = AionisJsonObject & {
  feedback_kind?: "memory";
  operation_id?: string;
  host_use_receipt_v1?: AionisHostUseReceiptV1;
  reason: string;
  run_id: string;
  outcome: AionisFeedbackOutcome;
  used_surface: AionisFeedbackUsedSurface;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  guide_trace_id?: string;
  used_memory_ids?: string[];
  memory_ids?: string[];
  node_ids?: string[];
  verifier_status?: AionisFeedbackStatus;
  tool_status?: AionisToolStatus;
  runtime_signal_refs?: string[];
  target?: "memory";
};

export type AionisFeedbackRequest = AionisMemoryFeedbackRequest;

export type AionisRehydrateRequest = AionisJsonObject & {
  reason: string;
  memory_ids?: string[];
  node_ids?: string[];
  client_ids?: string[];
  anchor_id?: string;
  anchor_uri?: string;
  target_tier?: "warm" | "hot";
  mode?: AionisRehydrateMode;
  include_linked_decisions?: boolean;
  target?: Extract<AionisForgetTarget, "archive" | "payload" | "memory">;
};

export type AionisProductTask = {
  task_id: string;
  run_id: string;
  task_signature: string;
  task_family?: string;
  workflow_signature?: string;
};

export type AionisFeedbackFromGuideInput = {
  guide: unknown;
  operation_id?: string;
  host_use_receipt_v1?: AionisHostUseReceiptV1;
  reason: string;
  run_id: string;
  outcome: AionisFeedbackOutcome;
  used_memory_ids: string[];
  used_surface?: AionisFeedbackUsedSurface;
  actor?: string;
  verifier_status?: AionisFeedbackStatus;
  tool_status?: AionisToolStatus;
  runtime_signal_refs?: string[];
};

// </aionis-runtime-owned:public-contracts>

export class AionisClientError extends Error {
  readonly status: number;
  readonly path: string;
  readonly response: unknown;

  constructor(status: number, path: string, response: unknown) {
    super(`Aionis request failed: ${status} ${path}`);
    this.name = "AionisClientError";
    this.status = status;
    this.path = path;
    this.response = response;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("AionisClient requires a non-empty baseUrl");
  return trimmed.replace(/\/+$/, "");
}

function scopedBody(
  body: AionisJsonObject,
  defaults: { tenant_id?: string; scope?: string },
  options?: AionisRequestOptions,
): AionisJsonObject {
  return {
    ...(defaults.tenant_id && body.tenant_id === undefined ? { tenant_id: defaults.tenant_id } : {}),
    ...(defaults.scope && body.scope === undefined ? { scope: defaults.scope } : {}),
    ...body,
    ...(options?.tenant_id ? { tenant_id: options.tenant_id } : {}),
    ...(options?.scope ? { scope: options.scope } : {}),
  };
}

function stripUndefined(value: AionisJsonObject): AionisJsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function coerceString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? value
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function rehydrateHintMemoryIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry)?.memory_id)
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function rehydrateHintArray(value: unknown): AionisRehydrateHint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const memoryId = record?.memory_id;
    if (!record || typeof memoryId !== "string" || memoryId.length === 0) return [];
    const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : undefined;
    return [{
      memory_id: memoryId,
      ...(reason ? { reason } : {}),
      required: record.required === undefined ? true : record.required !== false,
    }];
  });
}

function commandPostureArray(value: unknown): AionisCommandPosture[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const posture = record.posture;
    const surface = record.surface;
    const memoryId = record.memory_id;
    const instruction = record.instruction;
    const reason = record.reason;
    if (
      !isCommandPostureKind(posture)
      || !isCommandPostureSurface(surface)
      || typeof memoryId !== "string"
      || memoryId.length === 0
      || typeof instruction !== "string"
      || instruction.length === 0
      || typeof reason !== "string"
      || reason.length === 0
    ) {
      return [];
    }
    const executionState = asRecord(record.execution_state);
    const outcomeRole = executionState?.execution_outcome_role;
    const parsedExecutionState: AionisCommandPosture["execution_state"] | null = executionState ? {
      summary_kind: coerceString(executionState.summary_kind) ?? null,
      transition_kind: coerceString(executionState.transition_kind) ?? null,
      actor_role: coerceString(executionState.actor_role) ?? null,
      handoff_target: coerceString(executionState.handoff_target) ?? null,
      next_action_hint: coerceString(executionState.next_action_hint) ?? null,
      execution_outcome_role: outcomeRole === "passed_solution"
        || outcomeRole === "failed_branch"
        || outcomeRole === "blocked"
        || outcomeRole === "unknown"
          ? outcomeRole
          : null,
    } : null;
    return [{
      posture,
      surface,
      memory_id: memoryId,
      instruction,
      reason,
      target_files: stringArray(record.target_files),
      workflow_steps: stringArray(record.workflow_steps),
      acceptance_checks: stringArray(record.acceptance_checks),
      verification_summary: stringArray(record.verification_summary),
      artifact_hints: stringArray(record.artifact_hints),
      ...(parsedExecutionState ? { execution_state: parsedExecutionState } : {}),
    }];
  });
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((entry) => entry.length > 0)));
}

function guideTraceId(value: unknown): string | null {
  const entry = asRecord(value)?.guide_trace_id;
  return typeof entry === "string" && entry.length > 0 ? entry : null;
}

function rehydrateRequestsFromGuide(guide: unknown): AionisRehydrateHint[] {
  const context = asRecord(agentContextFromGuide(guide));
  const fromHints = rehydrateHintArray(context?.rehydrate_hints);
  const fromPosture = commandPostureArray(context?.command_posture)
    .filter((entry) => entry.posture === "rehydrate_first")
    .map((entry) => ({
      memory_id: entry.memory_id,
      reason: entry.reason || entry.instruction,
      required: true,
    }));
  const byId = new Map<string, AionisRehydrateHint>();
  for (const entry of [...fromHints, ...fromPosture]) {
    const previous = byId.get(entry.memory_id);
    byId.set(entry.memory_id, {
      memory_id: entry.memory_id,
      reason: previous?.reason ?? entry.reason,
      required: (previous?.required ?? false) || entry.required,
    });
  }
  return Array.from(byId.values());
}

function isCommandPostureKind(value: unknown): value is AionisCommandPostureKind {
  return value === "must_not"
    || value === "should_continue"
    || value === "inspect_first"
    || value === "rehydrate_first"
    || value === "optional_context";
}

function isCommandPostureSurface(value: unknown): value is AionisCommandPostureSurface {
  return value === "current"
    || value === "procedure"
    || value === "use_now"
    || value === "inspect_before_use"
    || value === "do_not_use"
    || value === "rehydrate"
    || value === "context";
}

function rememberNodeType(kind: AionisRememberKind): string {
  switch (kind) {
    case "preference": return "self_model";
    case "project_context": return "topic";
    case "procedure": return "procedure";
    case "event": return "event";
    case "evidence": return "evidence";
    case "fact": return "concept";
  }
}

function rememberTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93)}...`;
}

function rememberBody(body: AionisRememberRequest): AionisJsonObject {
  const text = body.text.trim();
  if (!text) throw new Error("AionisClient.remember requires non-empty text");
  const kind = body.kind ?? "fact";
  const lifecycleState = body.lifecycle_state ?? "active";
  const slots = stripUndefined({
    ...(body.slots ?? {}),
    memory_kind: "general_memory",
    lifecycle_state: lifecycleState,
    compression_layer: body.slots?.compression_layer ?? "L2",
  });
  return stripUndefined({
    auto_embed: body.auto_embed ?? true,
    input_text: text,
    memory_kind: "general_memory",
    memory_lane: body.memory_lane,
    producer_agent_id: body.producer_agent_id,
    owner_agent_id: body.owner_agent_id,
    owner_team_id: body.owner_team_id,
    memory: stripUndefined({
      client_id: body.client_id,
      type: rememberNodeType(kind),
      memory_kind: "general_memory",
      title: body.title ?? rememberTitle(text),
      text_summary: text,
      confidence: body.confidence,
      salience: body.salience,
      importance: body.importance,
      tier: body.tier,
      raw_ref: body.raw_ref,
      evidence_ref: body.evidence_ref,
      target_files: body.target_files,
      slots,
    }),
  });
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const AIONIS_REPLAY_SAFE_POST_PATHS = new Set([
  "/v1/observe",
  "/v1/guide",
  "/v1/feedback",
]);

const AIONIS_RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

function isRetryableAionisTransportError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
    if (typeof current !== "object") return false;
    const candidate = current as {
      code?: unknown;
      cause?: unknown;
    };
    if (
      typeof candidate.code === "string"
      && AIONIS_RETRYABLE_TRANSPORT_CODES.has(candidate.code)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

const AIONIS_MEMORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_RESOLVE_TYPES: AionisMemoryResolveType[] = ["event", "procedure", "evidence", "concept", "rule", "entity", "topic", "self_model"];

function buildClientAionisUri(args: {
  tenant_id: string;
  scope: string;
  type: AionisMemoryResolveType;
  id: string;
}): string {
  return `aionis://${encodeURIComponent(args.tenant_id)}/${encodeURIComponent(args.scope)}/${args.type}/${encodeURIComponent(args.id)}`;
}

function guideTenantScope(guide: unknown, fallback: { tenant_id?: string; scope?: string }): { tenant_id: string; scope: string } {
  const record = asRecord(guide);
  return {
    tenant_id: coerceString(record?.tenant_id) ?? fallback.tenant_id ?? "default",
    scope: coerceString(record?.scope) ?? fallback.scope ?? "default",
  };
}

function guideTraceIdValue(guide: unknown): string | null {
  return coerceString(asRecord(guide)?.guide_trace_id);
}

function resolveEvidenceIds(guide: unknown, options: AionisGuideAgentContextOptions): Array<{
  memory_id: string;
  surface: AionisResolvedAgentEvidenceSurface;
}> {
  const context = asRecord(agentContextFromGuide(guide));
  const rows: Array<{ memory_id: string; surface: AionisResolvedAgentEvidenceSurface }> = [];
  const includeInspectBeforeUse = options.include_inspect_before_use ?? false;
  if (includeInspectBeforeUse) {
    for (const memoryId of stringArray(context?.inspect_before_use_memory_ids)) {
      rows.push({ memory_id: memoryId, surface: "inspect_before_use" });
    }
  }
  if (options.include_rehydrate !== false) {
    for (const memoryId of rehydrateHintMemoryIds(context?.rehydrate_hints)) {
      rows.push({ memory_id: memoryId, surface: "rehydrate" });
    }
  }
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.surface}:${row.memory_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nodeEvidenceText(response: unknown): {
  text: string;
  source: AionisResolvedAgentEvidence["source"];
} {
  const node = asRecord(asRecord(response)?.node);
  if (!node) return { text: "", source: "unresolved" };
  const slots = asRecord(node.slots);
  const handoffText = coerceString(slots?.handoff_text)
    ?? coerceString(slots?.continuation_hint)
    ?? coerceString(slots?.next_action);
  if (handoffText) return { text: handoffText, source: "handoff_text" };
  const textSummary = coerceString(node.text_summary);
  if (textSummary) return { text: textSummary, source: "text_summary" };
  if (slots && Object.keys(slots).length > 0) return { text: JSON.stringify(slots), source: "slots_json" };
  const title = coerceString(node.title);
  if (title) return { text: title, source: "node_title" };
  return { text: "", source: "unresolved" };
}

// <aionis-runtime-owned:execution-episode-client>

function agentSessionVerifierStatus(
  verifier: unknown,
): AionisAgentSessionVerifierStatus {
  const outcome = asRecord(asRecord(verifier)?.outcome);
  const status = coerceString(outcome?.status);
  if (
    status === "passed"
    || status === "failed"
    || status === "infrastructure_error"
    || status === "inconclusive"
  ) {
    return status;
  }
  return "unknown";
}

function verifierContinuationReason(
  status: Exclude<AionisAgentSessionVerifierStatus, "passed">,
):
  | "verifier_failed"
  | "verifier_infrastructure_error"
  | "verifier_inconclusive"
  | "verifier_outcome_unavailable" {
  if (status === "failed") return "verifier_failed";
  if (status === "infrastructure_error") {
    return "verifier_infrastructure_error";
  }
  if (status === "inconclusive") return "verifier_inconclusive";
  return "verifier_outcome_unavailable";
}

type AgentSessionRecoveryTarget = Readonly<{
  failed_snapshot_id: string;
  failed_verifier_receipt_id: string;
  target_snapshot_id: string;
  target_verifier_receipt_id: string;
}>;

function agentSessionRecoveryTarget(
  verifier: unknown,
  currentStateSnapshotId: string,
  verifierReceiptId: string | undefined,
): AgentSessionRecoveryTarget | null {
  if (verifierReceiptId === undefined) return null;
  const verifierRecord = asRecord(verifier);
  const currentState = asRecord(
    verifierRecord?.current_execution_state,
  );
  const continuity = asRecord(currentState?.continuity_projection);
  const branch = asRecord(continuity?.branch_state);
  const recommendation = asRecord(branch?.recovery_recommendation);
  const failed = asRecord(
    recommendation?.current_failed_candidate,
  );
  const target = asRecord(
    recommendation?.target_accepted_candidate,
  );
  const failedSnapshotId = coerceString(failed?.snapshot_id);
  const failedReceiptId = coerceString(failed?.verifier_receipt_id);
  const failedVerifierId = coerceString(failed?.verifier_id);
  const targetSnapshotId = coerceString(target?.snapshot_id);
  const targetReceiptId = coerceString(target?.verifier_receipt_id);
  const targetVerifierId = coerceString(target?.verifier_id);
  if (
    recommendation?.recommended_action !== "restore_snapshot"
    || recommendation?.reason_code
      !== "current_verifier_failed_prior_snapshot_passed"
    || failed?.verification_status !== "failed"
    || failedSnapshotId !== currentStateSnapshotId
    || failedReceiptId !== verifierReceiptId
    || failedVerifierId === null
    || targetVerifierId !== failedVerifierId
    || targetSnapshotId === null
    || targetReceiptId === null
    || targetSnapshotId === failedSnapshotId
  ) {
    return null;
  }
  return {
    failed_snapshot_id: failedSnapshotId,
    failed_verifier_receipt_id: failedReceiptId,
    target_snapshot_id: targetSnapshotId,
    target_verifier_receipt_id: targetReceiptId,
  };
}

function agentSessionRecoveryOperationId(args: {
  episode_id: string;
  verifier_operation_id: string;
  failed_snapshot_id: string;
  target_snapshot_id: string;
}): string {
  const digest = createHash("sha256")
    .update([
      "aionis-agent-session-finish-recovery-v1",
      args.episode_id,
      args.verifier_operation_id,
      args.failed_snapshot_id,
      args.target_snapshot_id,
    ].join("\u0000"))
    .digest("hex");
  return `finish-recovery-${digest.slice(0, 48)}`;
}

function executionEpisodeBytes(
  value: string | Uint8Array | AionisJsonObject,
  label: string,
): Buffer {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  try {
    return Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw new Error(`${label} must be serializable as exact bytes`);
  }
}

function exactExecutionContractString(
  value: unknown,
  maxBytes: number,
): string | null {
  return (
    typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !value.includes("\u0000")
    && !value.includes("\r")
    && !value.includes("\n")
    && Buffer.byteLength(value, "utf8") <= maxBytes
  )
    ? value
    : null;
}

function exactExecutionContractKeys(
  value: unknown,
  expectedKeys: readonly string[],
): boolean {
  const record = asRecord(value);
  if (record === null) return false;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function executionSubjectFromResponse(
  value: unknown,
): AionisExecutionSubjectV1 {
  const subject = asRecord(value);
  const subjectId = exactExecutionContractString(subject?.subject_id, 256);
  const kind = exactExecutionContractString(subject?.kind, 120);
  const adapterId = exactExecutionContractString(subject?.adapter_id, 120);
  const adapterVersion = exactExecutionContractString(
    subject?.adapter_version,
    120,
  );
  const identitySha256 = exactExecutionContractString(
    subject?.identity_sha256,
    64,
  );
  const capabilityDescriptorRef = exactExecutionContractString(
    subject?.capability_descriptor_ref,
    2_048,
  );
  const capabilityDescriptorSha256 = exactExecutionContractString(
    subject?.capability_descriptor_sha256,
    64,
  );
  if (
    subject?.contract_version !== "execution_subject_v1"
    || !exactExecutionContractKeys(subject, [
      "contract_version",
      "subject_id",
      "kind",
      "adapter_id",
      "adapter_version",
      "identity_sha256",
      "capability_descriptor_ref",
      "capability_descriptor_sha256",
    ])
    || !subjectId
    || !kind
    || !adapterId
    || !adapterVersion
    || !identitySha256
    || !capabilityDescriptorRef
    || !capabilityDescriptorSha256
    || !/^[0-9a-f]{64}$/.test(identitySha256)
    || !/^[0-9a-f]{64}$/.test(capabilityDescriptorSha256)
    || subjectId !== `esub_${identitySha256}`
    || capabilityDescriptorRef
      !== `urn:aionis:subject-capability:sha256:${capabilityDescriptorSha256}`
  ) {
    throw new Error("Runtime returned an invalid execution subject");
  }
  return {
    contract_version: "execution_subject_v1",
    subject_id: subjectId,
    kind,
    adapter_id: adapterId,
    adapter_version: adapterVersion,
    identity_sha256: identitySha256,
    capability_descriptor_ref: capabilityDescriptorRef,
    capability_descriptor_sha256: capabilityDescriptorSha256,
  };
}

function executionSubjectsEqual(
  left: AionisExecutionSubjectV1,
  right: AionisExecutionSubjectV1,
): boolean {
  return left.contract_version === right.contract_version
    && left.subject_id === right.subject_id
    && left.kind === right.kind
    && left.adapter_id === right.adapter_id
    && left.adapter_version === right.adapter_version
    && left.identity_sha256 === right.identity_sha256
    && left.capability_descriptor_ref === right.capability_descriptor_ref
    && left.capability_descriptor_sha256
      === right.capability_descriptor_sha256;
}

function stateSnapshotV2FromResponse(
  value: unknown,
): AionisStateSnapshotV2 {
  const snapshot = asRecord(value);
  const snapshotId = exactExecutionContractString(
    snapshot?.snapshot_id,
    256,
  );
  const subject = executionSubjectFromResponse(snapshot?.subject);
  const capturedAt = exactExecutionContractString(
    snapshot?.captured_at,
    128,
  );
  const algorithmId = exactExecutionContractString(
    snapshot?.algorithm_id,
    120,
  );
  const algorithmVersion = exactExecutionContractString(
    snapshot?.algorithm_version,
    120,
  );
  const environmentSha256 = exactExecutionContractString(
    snapshot?.environment_sha256,
    64,
  );
  const contentRef = exactExecutionContractString(
    snapshot?.content_ref,
    2_048,
  );
  const contentSha256 = exactExecutionContractString(
    snapshot?.content_sha256,
    64,
  );
  const contentMediaType = exactExecutionContractString(
    snapshot?.content_media_type,
    2_048,
  );
  const contentEncoding = exactExecutionContractString(
    snapshot?.content_encoding,
    120,
  );
  const captureAuthority = snapshot?.capture_authority;
  const attestationRef = snapshot?.attestation_ref === null
    ? null
    : exactExecutionContractString(snapshot?.attestation_ref, 2_048);
  const parsedCapturedAt = capturedAt === null
    ? null
    : new Date(capturedAt);
  if (
    snapshot?.contract_version !== "state_snapshot_v2"
    || !exactExecutionContractKeys(snapshot, [
      "contract_version",
      "snapshot_id",
      "subject",
      "captured_at",
      "algorithm_id",
      "algorithm_version",
      "environment_sha256",
      "content_ref",
      "content_sha256",
      "content_media_type",
      "content_encoding",
      "capture_authority",
      "attestation_ref",
    ])
    || !snapshotId
    || !capturedAt
    || parsedCapturedAt === null
    || !Number.isFinite(parsedCapturedAt.getTime())
    || parsedCapturedAt.toISOString() !== capturedAt
    || !algorithmId
    || !algorithmVersion
    || !environmentSha256
    || !/^[0-9a-f]{64}$/.test(environmentSha256)
    || !contentRef
    || !contentSha256
    || !/^[0-9a-f]{64}$/.test(contentSha256)
    || contentRef !== `urn:aionis:state:sha256:${contentSha256}`
    || !contentMediaType
    || !contentEncoding
    || (
      captureAuthority !== "runtime_adapter"
      && captureAuthority !== "signed_host_adapter"
    )
    || (
      captureAuthority === "runtime_adapter"
        ? attestationRef !== null
        : attestationRef === null
    )
  ) {
    throw new Error("Runtime returned an invalid V2 state snapshot");
  }
  return {
    contract_version: "state_snapshot_v2",
    snapshot_id: snapshotId,
    subject,
    captured_at: capturedAt,
    algorithm_id: algorithmId,
    algorithm_version: algorithmVersion,
    environment_sha256: environmentSha256,
    content_ref: contentRef,
    content_sha256: contentSha256,
    content_media_type: contentMediaType,
    content_encoding: contentEncoding,
    capture_authority: captureAuthority,
    attestation_ref: attestationRef,
  };
}

function executionEpisodeHandleFromResponse(
  response: unknown,
  workspaceRoot: string,
): AionisExecutionEpisodeHandleV2 {
  const root = asRecord(response);
  const episode = asRecord(root?.episode);
  const subject = asRecord(episode?.subject_identity);
  const executionSubject = executionSubjectFromResponse(
    episode?.execution_subject,
  );
  const requiredVerifier = asRecord(episode?.required_verifier);
  const current = asRecord(root?.current_state_snapshot);
  const currentState = stateSnapshotV2FromResponse(
    root?.current_state_snapshot_v2,
  );
  const episodeId = coerceString(episode?.episode_id);
  const tenantId = coerceString(episode?.tenant_id);
  const scope = coerceString(episode?.public_scope);
  const taskId = coerceString(episode?.task_id);
  const taskEnvelopeDigest = coerceString(episode?.task_envelope_digest);
  const runId = coerceString(episode?.run_id);
  const workspaceRootSha256 = coerceString(subject?.canonical_root_sha256);
  const currentStateSnapshotId = coerceString(current?.snapshot_id);
  const verifierId = coerceString(requiredVerifier?.verifier_id);
  const verifierDefinitionSha256 = coerceString(
    requiredVerifier?.verifier_definition_sha256,
  );
  if (
    taskEnvelopeDigest !== null
    && !/^[0-9a-f]{64}$/.test(taskEnvelopeDigest)
  ) {
    throw new Error(
      "Runtime returned an invalid execution episode task envelope digest",
    );
  }
  if (
    !episodeId
    || !tenantId
    || !scope
    || !taskId
    || !taskEnvelopeDigest
    || !runId
    || !workspaceRootSha256
    || !currentStateSnapshotId
    || !verifierId
    || !verifierDefinitionSha256
    || currentState.snapshot_id !== currentStateSnapshotId
    || !executionSubjectsEqual(currentState.subject, executionSubject)
  ) {
    throw new Error(
      "Runtime returned an incomplete execution episode identity",
    );
  }
  return {
    contract_version: "aionis_execution_episode_handle_v2",
    episode_id: episodeId,
    tenant_id: tenantId,
    scope,
    task_id: taskId,
    task_envelope_digest: taskEnvelopeDigest,
    run_id: runId,
    workspace_root: workspaceRoot,
    workspace_root_sha256: workspaceRootSha256,
    subject: executionSubject,
    current_state_snapshot_id: currentStateSnapshotId,
    current_state: currentState,
    required_verifier: {
      contract_version: "execution_episode_required_verifier_v1",
      verifier_id: verifierId,
      verifier_definition_sha256: verifierDefinitionSha256,
    },
    closed: root?.closed === true,
  };
}

function updateExecutionEpisodeHandle(
  handle: AionisExecutionEpisodeHandleV2,
  response: unknown,
  closed = handle.closed,
): AionisExecutionEpisodeHandleV2 {
  const responseRecord = asRecord(response);
  const current = asRecord(responseRecord?.current_state_snapshot);
  const currentStateSnapshotId =
    coerceString(current?.snapshot_id) ?? handle.current_state_snapshot_id;
  const currentState = responseRecord?.current_state_snapshot_v2 === undefined
    ? null
    : stateSnapshotV2FromResponse(
        responseRecord.current_state_snapshot_v2,
      );
  if (
    currentState !== null
    && (
      currentState.snapshot_id !== currentStateSnapshotId
      || !executionSubjectsEqual(currentState.subject, handle.subject)
    )
  ) {
    throw new Error(
      "Runtime V2 state snapshot does not match its execution episode handle",
    );
  }
  if (
    currentState === null
    && currentStateSnapshotId !== handle.current_state_snapshot_id
  ) {
    throw new Error(
      "Runtime changed execution state without returning its V2 snapshot",
    );
  }
  return {
    ...handle,
    current_state_snapshot_id: currentStateSnapshotId,
    current_state: currentState ?? handle.current_state,
    closed,
  };
}

function agentSessionHandleFromResponse(
  response: unknown,
  workspaceRoot: string,
  episodeFallback?: AionisExecutionEpisodeHandleV2,
): AionisAgentSessionHandleV1 {
  const root = asRecord(response);
  const operation = asRecord(root?.session);
  const lease = asRecord(operation?.lease);
  const binding = asRecord(lease?.binding);
  const sessionKey = coerceString(binding?.session_key);
  const continuationId = coerceString(binding?.continuation_id);
  const holderId = coerceString(lease?.holder_id);
  const leaseId = coerceString(lease?.lease_id);
  const leaseRevision =
    typeof lease?.lease_revision === "number"
    && Number.isSafeInteger(lease.lease_revision)
    && lease.lease_revision > 0
      ? lease.lease_revision
      : null;
  const leaseStatus = lease?.status;
  const leaseExpiresAt =
    lease?.expires_at === null
      ? null
      : coerceString(lease?.expires_at);
  if (
    !sessionKey
    || !continuationId
    || !holderId
    || !leaseId
    || leaseRevision === null
    || (
      leaseStatus !== "active"
      && leaseStatus !== "released"
      && leaseStatus !== "expired"
    )
    || (leaseStatus === "active" && !leaseExpiresAt)
  ) {
    throw new Error(
      "Runtime returned an incomplete execution-session lease",
    );
  }
  const episode = asRecord(root?.episode)
    ? executionEpisodeHandleFromResponse(response, workspaceRoot)
    : episodeFallback
      ? updateExecutionEpisodeHandle(
          episodeFallback,
          response,
          episodeFallback.closed,
        )
      : null;
  if (
    !episode
    || coerceString(binding?.episode_id) !== episode.episode_id
    || coerceString(binding?.public_scope) !== episode.scope
    || coerceString(binding?.tenant_id) !== episode.tenant_id
  ) {
    throw new Error(
      "Runtime execution-session binding does not match its episode",
    );
  }
  return {
    contract_version: "aionis_agent_session_handle_v1",
    session_key: sessionKey,
    continuation_id: continuationId,
    holder_id: holderId,
    lease_id: leaseId,
    lease_revision: leaseRevision,
    lease_status: leaseStatus,
    lease_expires_at: leaseExpiresAt,
    episode,
  };
}

function canonicalAgentSessionHandle(
  value: AionisAgentSessionHandleV1,
): AionisAgentSessionHandleV1 {
  const exactString = (candidate: unknown): candidate is string =>
    typeof candidate === "string"
    && candidate.length > 0
    && candidate === candidate.trim()
    && !candidate.includes("\u0000");
  if (
    value === null
    || typeof value !== "object"
    || value.contract_version !== "aionis_agent_session_handle_v1"
    || !exactString(value.session_key)
    || !exactString(value.continuation_id)
    || !exactString(value.holder_id)
    || !exactString(value.lease_id)
    || !Number.isSafeInteger(value.lease_revision)
    || value.lease_revision < 1
    || (
      value.lease_status !== "active"
      && value.lease_status !== "released"
      && value.lease_status !== "expired"
    )
    || (
      value.lease_status === "active"
      && !exactString(value.lease_expires_at)
    )
    || (
      value.lease_status === "released"
      && value.lease_expires_at !== null
    )
  ) {
    throw new Error("Invalid serialized Aionis Agent session handle");
  }
  return {
    ...value,
    episode: canonicalExecutionEpisodeHandle(value.episode),
  };
}

function sessionLeaseContext(
  handle: AionisAgentSessionHandleV1,
  leaseOperationId: string,
  leaseTtlMs?: number,
): AionisExecutionSessionLeaseContextV1 {
  if (handle.lease_status !== "active" || handle.episode.closed) {
    throw new Error("Cannot use a closed Aionis Agent session");
  }
  return stripUndefined({
    contract_version: "execution_session_lease_context_v1" as const,
    session_key: handle.session_key,
    continuation_id: handle.continuation_id,
    holder_id: handle.holder_id,
    lease_id: handle.lease_id,
    lease_revision: handle.lease_revision,
    lease_operation_id: leaseOperationId,
    lease_ttl_ms: leaseTtlMs,
  }) as AionisExecutionSessionLeaseContextV1;
}

function agentSessionSuboperationId(
  operationId: string,
  kind: string,
): string {
  return `ass_${createHash("sha256").update(
    JSON.stringify({
      contract_version: "aionis_agent_session_suboperation_v1",
      operation_id: operationId,
      kind,
    }),
  ).digest("hex")}`;
}

function executionEpisodeOptions(
  handle: AionisExecutionEpisodeHandleV2,
  options?: AionisRequestOptions,
): AionisRequestOptions {
  if (
    options?.tenant_id !== undefined
    && options.tenant_id !== handle.tenant_id
  ) {
    throw new Error("Execution episode tenant identity cannot change");
  }
  if (options?.scope !== undefined && options.scope !== handle.scope) {
    throw new Error("Execution episode scope identity cannot change");
  }
  return {
    ...(options ?? {}),
    tenant_id: handle.tenant_id,
    scope: handle.scope,
  };
}

async function guideAgentContextFromGuideResponse<TGuide>(args: {
  guide: TGuide;
  body: AionisGuideRequest;
  options?: AionisGuideRequestOptions;
  contextOptions: AionisGuideAgentContextOptions;
  defaultTenantId?: string | null;
  defaultScope?: string | null;
  resolveMemory: (
    body: AionisMemoryResolveRequest,
    options?: AionisRequestOptions,
  ) => Promise<unknown>;
}): Promise<AionisGuideAgentContextResult<TGuide>> {
  const bodyRecord = asRecord(args.body) ?? {};
  const effectiveContextOptions = { ...args.contextOptions };
  const { tenant_id: tenantId, scope } = guideTenantScope(args.guide, {
    tenant_id:
      args.options?.tenant_id
      ?? coerceString(bodyRecord.tenant_id)
      ?? args.defaultTenantId
      ?? undefined,
    scope:
      args.options?.scope
      ?? coerceString(bodyRecord.scope)
      ?? args.defaultScope
      ?? undefined,
  });
  const evidenceLimit = effectiveContextOptions.evidence_limit ?? 6;
  const resolveTypes =
    effectiveContextOptions.resolve_types ?? DEFAULT_RESOLVE_TYPES;
  const onResolveError =
    effectiveContextOptions.on_resolve_error ?? "include_placeholder";
  const evidenceRows = resolveEvidenceIds(
    args.guide,
    effectiveContextOptions,
  ).slice(0, evidenceLimit);
  const resolvedEvidence: AionisResolvedAgentEvidence[] = [];
  const consumerAgentId = coerceString(bodyRecord.consumer_agent_id);
  const consumerTeamId = coerceString(bodyRecord.consumer_team_id);

  for (const row of evidenceRows) {
    if (!AIONIS_MEMORY_ID_RE.test(row.memory_id)) {
      if (onResolveError === "throw") {
        throw new Error(
          `Cannot resolve non-Aionis memory id: ${row.memory_id}`,
        );
      }
      if (onResolveError === "include_placeholder") {
        resolvedEvidence.push({
          memory_id: row.memory_id,
          surface: row.surface,
          uri: null,
          resolved_type: null,
          resolved: false,
          source: "unresolved",
          evidence_text: "",
          error: {
            message:
              "memory id is not an Aionis UUID; external memory ids are adjudicated but not resolvable through /v1/memory/resolve",
          },
        });
      }
      continue;
    }

    let lastError: unknown = null;
    let resolved = false;
    for (const type of resolveTypes) {
      const uri = buildClientAionisUri({
        tenant_id: tenantId,
        scope,
        type,
        id: row.memory_id,
      });
      try {
        const response = await args.resolveMemory({
          uri,
          include_meta: true,
          include_slots: true,
          ...(consumerAgentId
            ? { consumer_agent_id: consumerAgentId }
            : {}),
          ...(consumerTeamId
            ? { consumer_team_id: consumerTeamId }
            : {}),
        }, args.options);
        const extracted = nodeEvidenceText(response);
        resolvedEvidence.push({
          memory_id: row.memory_id,
          surface: row.surface,
          uri,
          resolved_type: type,
          resolved: true,
          source: extracted.source,
          evidence_text: extracted.text,
          response,
        });
        resolved = true;
        break;
      } catch (error) {
        lastError = error;
        if (error instanceof AionisClientError && error.status === 404) {
          continue;
        }
        if (onResolveError === "throw") throw error;
        break;
      }
    }
    if (!resolved && onResolveError !== "skip") {
      resolvedEvidence.push({
        memory_id: row.memory_id,
        surface: row.surface,
        uri: null,
        resolved_type: null,
        resolved: false,
        source: "unresolved",
        evidence_text: "",
        error: {
          message:
            lastError instanceof Error
              ? lastError.message
              : "memory resolve failed",
          ...(lastError instanceof AionisClientError
            ? { status: lastError.status }
            : {}),
        },
      });
    }
  }

  const agentPrompt = agentPromptFromGuide(args.guide);
  const unresolvedMemoryIds = resolvedEvidence
    .filter((entry) => !entry.resolved)
    .map((entry) => entry.memory_id);

  return {
    contract_version: "aionis_sdk_agent_context_with_evidence_v1",
    guide: args.guide,
    agent_context: asRecord(args.guide)?.agent_context ?? null,
    agent_prompt: agentPrompt,
    resolved_evidence: resolvedEvidence,
    unresolved_memory_ids: unresolvedMemoryIds,
    evidence_char_count: resolvedEvidence.reduce(
      (total, entry) => total + entry.evidence_text.length,
      0,
    ),
    prompt_char_count: agentPrompt.length,
    guide_trace_id: guideTraceIdValue(args.guide),
  };
}

function assertExecutionEpisodeRequestScope(
  input: { tenant_id?: string; scope?: string },
  options?: AionisRequestOptions,
): void {
  if (
    input.tenant_id !== undefined
    && options?.tenant_id !== undefined
    && input.tenant_id !== options.tenant_id
  ) {
    throw new Error("Execution episode tenant identity cannot change");
  }
  if (
    input.scope !== undefined
    && options?.scope !== undefined
    && input.scope !== options.scope
  ) {
    throw new Error("Execution episode scope identity cannot change");
  }
}

function canonicalExecutionEpisodeHandle(
  value: AionisExecutionEpisodeHandleV2,
): AionisExecutionEpisodeHandleV2 {
  const subject = executionSubjectFromResponse(value?.subject);
  const currentState = stateSnapshotV2FromResponse(value?.current_state);
  const sha256 = /^[0-9a-f]{64}$/;
  const exactString = (candidate: unknown): candidate is string =>
    typeof candidate === "string"
    && candidate.length > 0
    && candidate === candidate.trim()
    && !candidate.includes("\u0000");
  if (
    value === null
    || typeof value !== "object"
    || value.contract_version !== "aionis_execution_episode_handle_v2"
    || !exactString(value.episode_id)
    || !exactString(value.tenant_id)
    || !exactString(value.scope)
    || !exactString(value.task_id)
    || !sha256.test(value.task_envelope_digest)
    || !exactString(value.run_id)
    || !exactString(value.workspace_root)
    || !sha256.test(value.workspace_root_sha256)
    || !exactString(value.current_state_snapshot_id)
    || currentState.snapshot_id !== value.current_state_snapshot_id
    || !executionSubjectsEqual(currentState.subject, subject)
    || value.required_verifier?.contract_version
      !== "execution_episode_required_verifier_v1"
    || !exactString(value.required_verifier.verifier_id)
    || !sha256.test(
      value.required_verifier.verifier_definition_sha256,
    )
    || typeof value.closed !== "boolean"
  ) {
    throw new Error("Invalid serialized execution episode handle");
  }
  return {
    ...value,
    subject,
    current_state: currentState,
    required_verifier: { ...value.required_verifier },
  };
}

function canonicalAttachedExecutionEpisodeHandle(
  value: AionisExecutionEpisodeHandleV2,
): AionisExecutionEpisodeHandleV2 {
  const exactKeys = (
    candidate: unknown,
    expectedKeys: readonly string[],
  ): boolean => {
    const record = asRecord(candidate);
    if (record === null) return false;
    const actualKeys = Object.keys(record).sort();
    const expected = [...expectedKeys].sort();
    return actualKeys.length === expected.length
      && actualKeys.every((key, index) => key === expected[index]);
  };
  if (
    !exactKeys(value, [
      "contract_version",
      "episode_id",
      "tenant_id",
      "scope",
      "task_id",
      "task_envelope_digest",
      "run_id",
      "workspace_root",
      "workspace_root_sha256",
      "subject",
      "current_state_snapshot_id",
      "current_state",
      "required_verifier",
      "closed",
    ])
    || !exactKeys(value?.required_verifier, [
      "contract_version",
      "verifier_id",
      "verifier_definition_sha256",
    ])
    || !exactKeys(value?.subject, [
      "contract_version",
      "subject_id",
      "kind",
      "adapter_id",
      "adapter_version",
      "identity_sha256",
      "capability_descriptor_ref",
      "capability_descriptor_sha256",
    ])
    || !exactKeys(value?.current_state, [
      "contract_version",
      "snapshot_id",
      "subject",
      "captured_at",
      "algorithm_id",
      "algorithm_version",
      "environment_sha256",
      "content_ref",
      "content_sha256",
      "content_media_type",
      "content_encoding",
      "capture_authority",
      "attestation_ref",
    ])
    || !exactKeys(value?.current_state?.subject, [
      "contract_version",
      "subject_id",
      "kind",
      "adapter_id",
      "adapter_version",
      "identity_sha256",
      "capability_descriptor_ref",
      "capability_descriptor_sha256",
    ])
  ) {
    throw new Error("Invalid serialized execution episode handle");
  }
  return canonicalExecutionEpisodeHandle(value);
}

function assertResumedExecutionEpisodeIdentity(
  expected: AionisExecutionEpisodeHandleV2,
  actual: AionisExecutionEpisodeHandleV2,
): void {
  if (
    actual.episode_id !== expected.episode_id
    || actual.tenant_id !== expected.tenant_id
    || actual.scope !== expected.scope
    || actual.task_id !== expected.task_id
    || actual.task_envelope_digest !== expected.task_envelope_digest
    || actual.run_id !== expected.run_id
    || actual.workspace_root !== expected.workspace_root
    || actual.workspace_root_sha256 !== expected.workspace_root_sha256
    || !executionSubjectsEqual(actual.subject, expected.subject)
    || actual.required_verifier.verifier_id
      !== expected.required_verifier.verifier_id
    || actual.required_verifier.verifier_definition_sha256
      !== expected.required_verifier.verifier_definition_sha256
  ) {
    throw new Error(
      "Runtime execution episode identity changed while resuming a serialized handle",
    );
  }
}

/**
 * Canonical stateful Host Episode Protocol.
 *
 * Calls are serialized so concurrent Host callbacks cannot apply out-of-order
 * responses to the local handle. `toJSON()` returns the portable handle that
 * another process can pass to `aionis.execution.resumeEpisode(...)`.
 */
export class AionisAgentSession {
  private readonly client: AionisClient;
  private currentHandle: AionisAgentSessionHandleV1;
  private operationTail: Promise<void> = Promise.resolve();
  private stateCaptureInFlight = false;

  constructor(
    client: AionisClient,
    handle: AionisAgentSessionHandleV1,
  ) {
    this.client = client;
    this.currentHandle = canonicalAgentSessionHandle(handle);
    this.turn = this.turn.bind(this);
    this.guide = this.guide.bind(this);
    this.guideAgentContext = this.guideAgentContext.bind(this);
    this.aroundAction = this.aroundAction.bind(this);
    this.restoreSnapshot = this.restoreSnapshot.bind(this);
    this.recordObservation = this.recordObservation.bind(this);
    this.recordDecision = this.recordDecision.bind(this);
    this.recordProgress = this.recordProgress.bind(this);
    this.recordPlannedAction = this.recordPlannedAction.bind(this);
    this.runVerifier = this.runVerifier.bind(this);
    this.finish = this.finish.bind(this);
    this.handoff = this.handoff.bind(this);
    this.release = this.release.bind(this);
  }

  get handle(): AionisAgentSessionHandleV1 {
    return canonicalAgentSessionHandle(this.currentHandle);
  }

  get episodeId(): string {
    return this.currentHandle.episode.episode_id;
  }

  get continuationId(): string {
    return this.currentHandle.continuation_id;
  }

  get currentStateSnapshotId(): string {
    return this.currentHandle.episode.current_state_snapshot_id;
  }

  get active(): boolean {
    return this.currentHandle.lease_status === "active"
      && !this.currentHandle.episode.closed;
  }

  toJSON(): AionisAgentSessionHandleV1 {
    return this.handle;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private enqueueEpisode<T>(
    operation: (
      handle: AionisAgentSessionHandleV1,
    ) => Promise<AionisExecutionEpisodeOperationResult<T>>,
    episodeClosed = false,
  ): Promise<T> {
    return this.enqueue(async () => {
      const previous = this.currentHandle;
      const result = await operation(previous);
      let next = agentSessionHandleFromResponse(
        result.response,
        previous.episode.workspace_root,
        result.handle,
      );
      if (episodeClosed) {
        next = {
          ...next,
          episode: {
            ...next.episode,
            closed: true,
          },
        };
      }
      this.currentHandle = canonicalAgentSessionHandle(next);
      return result.response;
    });
  }

  private context(
    parentOperationId: string,
    kind: string,
    leaseTtlMs?: number,
  ): AionisExecutionSessionLeaseContextV1 {
    return sessionLeaseContext(
      this.currentHandle,
      agentSessionSuboperationId(parentOperationId, kind),
      leaseTtlMs,
    );
  }

  guide<T = unknown>(
    input: AionisGuideRequest & {
      operation_id: string;
      lease_ttl_ms?: number;
    },
    options?: AionisGuideRequestOptions,
  ): Promise<T> {
    return this.enqueueEpisode((handle) =>
      this.client.guideEpisode<T>({
        handle: handle.episode,
        operation_id: input.operation_id,
        guide: {
          ...input,
          session_lease_v1: this.context(
            input.operation_id,
            "guide_lease",
            input.lease_ttl_ms,
          ),
        },
      }, options));
  }

  guideAgentContext<TGuide = unknown>(
    input: AionisGuideRequest & {
      operation_id: string;
      lease_ttl_ms?: number;
    },
    options?: AionisGuideRequestOptions,
    contextOptions: AionisGuideAgentContextOptions = {},
  ): Promise<AionisGuideAgentContextResult<TGuide>> {
    return this.enqueue(async () => {
      const previous = this.currentHandle;
      const guideInput: AionisGuideRequest = {
        ...input,
        session_lease_v1: this.context(
          input.operation_id,
          "guide_context_lease",
          input.lease_ttl_ms,
        ),
      };
      const result = await this.client.guideEpisode<TGuide>({
        handle: previous.episode,
        operation_id: input.operation_id,
        guide: guideInput,
      }, options);
      const next = agentSessionHandleFromResponse(
        result.response,
        previous.episode.workspace_root,
        result.handle,
      );
      this.currentHandle = canonicalAgentSessionHandle(next);
      const scopedOptions = executionEpisodeOptions(
        next.episode,
        options,
      );
      return await guideAgentContextFromGuideResponse({
        guide: result.response,
        body: guideInput,
        options: scopedOptions,
        contextOptions,
        defaultTenantId: next.episode.tenant_id,
        defaultScope: next.episode.scope,
        resolveMemory: (body, requestOptions) =>
          this.client.resolveMemory(body, requestOptions),
      });
    });
  }

  async turn<TGuide = unknown>(
    input: AionisAgentSessionTurnInput,
    options?: AionisGuideRequestOptions,
    contextOptions: AionisGuideAgentContextOptions = {},
  ): Promise<AionisAgentSessionTurnResult<TGuide>> {
    const observation = await this.recordObservation({
      operation_id: agentSessionSuboperationId(
        input.operation_id,
        "turn_observation",
      ),
      observation: input.observation,
      authority: input.authority,
      evidence_kind: input.evidence_kind,
      evidence: input.evidence,
      evidence_media_type: input.evidence_media_type,
      evidence_encoding: input.evidence_encoding,
      lease_ttl_ms: input.lease_ttl_ms,
    }, options);
    const guideInput = {
      ...input.guide,
      operation_id: agentSessionSuboperationId(
        input.operation_id,
        "turn_guide",
      ),
      lease_ttl_ms: input.lease_ttl_ms,
    } as AionisGuideRequest & {
      operation_id: string;
      lease_ttl_ms?: number;
    };
    const context = await this.guideAgentContext<TGuide>(
      guideInput,
      options,
      contextOptions,
    );
    return { observation, context };
  }

  recordObservation<T = unknown>(
    input: Omit<
      AionisRecordEpisodeObservationInput,
      "handle" | "session_lease_v1"
    > & { lease_ttl_ms?: number },
    options?: AionisRequestOptions,
  ): Promise<T> {
    return this.enqueueEpisode((handle) =>
      this.client.recordEpisodeObservation<T>({
        ...input,
        handle: handle.episode,
        session_lease_v1: this.context(
          input.operation_id,
          "observation_lease",
          input.lease_ttl_ms,
        ),
      }, options));
  }

  recordDecision<T = unknown>(
    input: Omit<
      AionisRecordEpisodeDecisionInput,
      "handle" | "session_lease_v1"
    > & { lease_ttl_ms?: number },
    options?: AionisRequestOptions,
  ): Promise<T> {
    return this.enqueueEpisode((handle) =>
      this.client.recordEpisodeDecision<T>({
        ...input,
        handle: handle.episode,
        session_lease_v1: this.context(
          input.operation_id,
          "decision_lease",
          input.lease_ttl_ms,
        ),
      }, options));
  }

  recordProgress<T = unknown>(
    input: Omit<
      AionisRecordEpisodeProgressInput,
      "handle" | "session_lease_v1"
    > & { lease_ttl_ms?: number },
    options?: AionisRequestOptions,
  ): Promise<T> {
    return this.enqueueEpisode((handle) =>
      this.client.recordEpisodeProgress<T>({
        ...input,
        handle: handle.episode,
        session_lease_v1: this.context(
          input.operation_id,
          "progress_lease",
          input.lease_ttl_ms,
        ),
      }, options));
  }

  recordPlannedAction<T = unknown>(
    input: Omit<
      AionisRecordEpisodePlannedActionInput,
      "handle" | "session_lease_v1"
    > & { lease_ttl_ms?: number },
    options?: AionisRequestOptions,
  ): Promise<T> {
    return this.enqueueEpisode((handle) =>
      this.client.recordEpisodePlannedAction<T>({
        ...input,
        handle: handle.episode,
        session_lease_v1: this.context(
          input.operation_id,
          "planned_action_lease",
          input.lease_ttl_ms,
        ),
      }, options));
  }

  aroundAction<TResult, TReceipt = unknown>(
    input: AionisAgentSessionAroundActionInput<TResult>,
    options?: AionisRequestOptions,
  ): Promise<AionisAgentSessionAroundActionResult<TResult, TReceipt>> {
    if (this.stateCaptureInFlight) {
      return Promise.reject(new Error(
        "Aionis Agent session action callbacks must be awaited before the Host mutates workspace state again",
      ));
    }
    this.stateCaptureInFlight = true;
    return this.enqueue(async () => {
      const previous = this.currentHandle;
      const result = await input.execute();
      const serialized = input.serialize_result
        ? input.serialize_result(result)
        : (
          typeof result === "string"
          || result instanceof Uint8Array
          || (
            result !== null
            && typeof result === "object"
            && !Array.isArray(result)
          )
        )
          ? result as string | Uint8Array | AionisJsonObject
          : { value: result } as AionisJsonObject;
      const recorded = await this.client.recordAction<TReceipt>({
        handle: previous.episode,
        operation_id: input.operation_id,
        action_kind: input.action_kind,
        tool_name: input.tool_name,
        request: input.request,
        result: serialized,
        session_lease_v1: this.context(
          input.operation_id,
          "action_lease",
          input.lease_ttl_ms,
        ),
      }, options);
      this.currentHandle = canonicalAgentSessionHandle(
        agentSessionHandleFromResponse(
          recorded.response,
          previous.episode.workspace_root,
          recorded.handle,
        ),
      );
      return {
        result,
        receipt: recorded.response,
      };
    }).finally(() => {
      this.stateCaptureInFlight = false;
    });
  }

  restoreSnapshot<T = unknown>(
    input: Omit<
      AionisRestoreEpisodeSnapshotInput,
      "handle" | "session_lease_v1"
    > & { lease_ttl_ms?: number },
    options?: AionisRequestOptions,
  ): Promise<T> {
    if (this.stateCaptureInFlight) {
      return Promise.reject(new Error(
        "Aionis Agent session snapshot recovery must be awaited before the Host mutates subject state again",
      ));
    }
    this.stateCaptureInFlight = true;
    return this.enqueueEpisode((handle) =>
      this.client.restoreEpisodeSnapshot<T>({
        ...input,
        handle: handle.episode,
        session_lease_v1: this.context(
          input.operation_id,
          "snapshot_restore_lease",
          input.lease_ttl_ms,
        ),
      }, options)).finally(() => {
        this.stateCaptureInFlight = false;
      });
  }

  runVerifier<T = unknown>(
    input: Omit<
      AionisRunEpisodeVerifierInput,
      "handle" | "session_lease_v1"
    > & { lease_ttl_ms?: number },
    options?: AionisRequestOptions,
  ): Promise<T> {
    return this.enqueueEpisode((handle) =>
      this.client.runEpisodeVerifier<T>({
        ...input,
        handle: handle.episode,
        session_lease_v1: this.context(
          input.operation_id,
          "verifier_lease",
          input.lease_ttl_ms,
        ),
      }, options));
  }

  async finish<
    TVerifier = unknown,
    TClose = unknown,
    TRecovery = unknown,
  >(
    input: AionisAgentSessionFinishInput,
    options?: AionisRequestOptions,
  ): Promise<
    AionisAgentSessionFinishResult<TVerifier, TClose, TRecovery>
  > {
    const recoveryMode = input.recovery_mode ?? "automatic";
    if (
      recoveryMode !== "automatic"
      && recoveryMode !== "manual"
    ) {
      throw new Error(
        "Aionis Agent session recovery_mode must be automatic or manual",
      );
    }
    const verifier = await this.runVerifier<TVerifier>({
      operation_id: input.verifier_operation_id,
      lease_ttl_ms: input.lease_ttl_ms,
    }, options);
    const verifierRecord = asRecord(verifier);
    const outcome = asRecord(verifierRecord?.outcome);
    const verifierStatus = agentSessionVerifierStatus(verifier);
    const verifierReceiptId =
      coerceString(outcome?.verifier_receipt_id)
      ?? undefined;
    if (
      input.termination === "completed"
      && verifierStatus !== "passed"
    ) {
      const recoveryTarget = verifierStatus === "failed"
        && recoveryMode === "automatic"
        ? agentSessionRecoveryTarget(
          verifier,
          this.currentStateSnapshotId,
          verifierReceiptId,
        )
        : null;
      if (recoveryTarget !== null) {
        const recoveryOperationId =
          input.recovery_operation_id
          ?? agentSessionRecoveryOperationId({
            episode_id: this.episodeId,
            verifier_operation_id: input.verifier_operation_id,
            failed_snapshot_id: recoveryTarget.failed_snapshot_id,
            target_snapshot_id: recoveryTarget.target_snapshot_id,
          });
        const recovery = await this.restoreSnapshot<TRecovery>({
          operation_id: recoveryOperationId,
          target_snapshot_id: recoveryTarget.target_snapshot_id,
          lease_ttl_ms: input.lease_ttl_ms,
        }, options);
        if (
          this.currentStateSnapshotId
          !== recoveryTarget.target_snapshot_id
        ) {
          throw new Error(
            "Aionis Agent session recovery did not restore the accepted snapshot",
          );
        }
        return {
          contract_version: "aionis_agent_session_finish_result_v1",
          status: "continue",
          verifier_status: verifierStatus,
          verifier,
          close: null,
          continuation: {
            reason: "verified_branch_restored",
            current_state_snapshot_id: this.currentStateSnapshotId,
            verifier_receipt_id: verifierReceiptId ?? null,
            recovery: {
              contract_version:
                "aionis_agent_session_recovery_result_v1",
              status: "restored",
              operation_id: recoveryOperationId,
              failed_snapshot_id:
                recoveryTarget.failed_snapshot_id,
              failed_verifier_receipt_id:
                recoveryTarget.failed_verifier_receipt_id,
              restored_snapshot_id:
                recoveryTarget.target_snapshot_id,
              accepted_verifier_receipt_id:
                recoveryTarget.target_verifier_receipt_id,
              response: recovery,
            },
          },
        };
      }
      return {
        contract_version: "aionis_agent_session_finish_result_v1",
        status: "continue",
        verifier_status: verifierStatus,
        verifier,
        close: null,
        continuation: {
          reason: verifierContinuationReason(verifierStatus),
          current_state_snapshot_id: this.currentStateSnapshotId,
          verifier_receipt_id: verifierReceiptId ?? null,
          recovery: null,
        },
      };
    }
    const close = await this.enqueueEpisode((handle) =>
      this.client.closeEpisode<TClose>({
        handle: handle.episode,
        operation_id: input.close_operation_id,
        expected_current_state_snapshot_id:
          input.expected_current_state_snapshot_id,
        termination: input.termination,
        verifier_receipt_id: verifierReceiptId,
        outcome_details: input.outcome_details,
        cost: input.cost,
        session_lease_v1: this.context(
          input.close_operation_id,
          "finish_release",
          input.lease_ttl_ms,
        ),
      }, options), true);
    if (input.termination === "completed") {
      return {
        contract_version: "aionis_agent_session_finish_result_v1",
        status: "completed",
        verifier_status: "passed",
        verifier,
        close,
        continuation: null,
      };
    }
    return {
      contract_version: "aionis_agent_session_finish_result_v1",
      status: "terminated",
      verifier_status: verifierStatus,
      verifier,
      close,
      continuation: null,
    };
  }

  handoff<T = unknown>(
    input: {
      operation_id: string;
      to_holder_id: string;
      evidence_refs?: string[];
      lease_ttl_ms?: number;
    },
    options?: AionisRequestOptions,
  ): Promise<T> {
    return this.enqueue(async () => {
      const result = await this.client.handoffAgentSession<T>({
        handle: this.currentHandle,
        operation_id: input.operation_id,
        to_holder_id: input.to_holder_id,
        evidence_refs: input.evidence_refs,
        lease_ttl_ms: input.lease_ttl_ms,
      }, options);
      this.currentHandle = canonicalAgentSessionHandle(result.handle);
      return result.response;
    });
  }

  release<T = unknown>(
    input: { operation_id: string },
    options?: AionisRequestOptions,
  ): Promise<T> {
    return this.enqueue(async () => {
      const result = await this.client.releaseAgentSession<T>({
        handle: this.currentHandle,
        operation_id: input.operation_id,
      }, options);
      this.currentHandle = canonicalAgentSessionHandle(result.handle);
      return result.response;
    });
  }
}

export class AionisClient {
  readonly agentSession: AionisAgentSessionClient;

  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly tenantId: string | null;
  private readonly scope: string | null;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AionisClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey?.trim() || null;
    this.tenantId = options.tenant_id?.trim() || null;
    this.scope = options.scope?.trim() || null;
    this.headers = { ...(options.headers ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.agentSession = new AionisAgentSessionClient(this);
  }

  async observe<T = AionisObserveResult>(body: AionisObserveRequest, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/observe", body, options);
  }

  async beginEpisode<T = unknown>(
    input: AionisBeginEpisodeInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    assertExecutionEpisodeRequestScope(input, options);
    const sourceTaskBytes = executionEpisodeBytes(
      input.source_task,
      "beginEpisode source_task",
    );
    const sourceTaskSha256 = createHash("sha256")
      .update(sourceTaskBytes)
      .digest("hex");
    if (sourceTaskSha256 !== input.task_envelope_v1.source_task_sha256) {
      throw new Error(
        "beginEpisode source_task bytes do not match task_envelope_v1.source_task_sha256",
      );
    }
    const response = await this.post<T>("/v1/observe", {
      ...stripUndefined({
      observation_kind: "execution_episode",
      event_kind: "episode_started",
      operation_id: input.operation_id,
      task_envelope_v1: input.task_envelope_v1,
      source_task_base64: sourceTaskBytes.toString("base64"),
      run_id: input.run_id,
      model_id: input.model_id,
      budget: input.budget,
      workspace_root: input.workspace_root,
      subject_state_spec_v2: input.subject_state_spec_v2,
      required_verifier_id: input.required_verifier_id,
      tenant_id: input.tenant_id,
      scope: input.scope,
      }),
      // null is a valid JSON model configuration. The general SDK compactor
      // intentionally strips nullish optional fields, so bind this required
      // field after compaction.
      model_config: input.model_config,
    }, options);
    const handle = executionEpisodeHandleFromResponse(
      response,
      input.workspace_root,
    );
    const taskEnvelopeDigest = hostTaskEnvelopeDigest(
      input.task_envelope_v1,
    );
    if (
      handle.task_id !== input.task_envelope_v1.host_task_id
      || handle.task_envelope_digest !== taskEnvelopeDigest
    ) {
      throw new Error(
        "Runtime execution episode task identity does not match beginEpisode input",
      );
    }
    const expectedTenantId =
      options?.tenant_id ?? input.tenant_id ?? this.tenantId;
    const expectedScope = options?.scope ?? input.scope ?? this.scope;
    if (
      (expectedTenantId !== null && expectedTenantId !== undefined
        && handle.tenant_id !== expectedTenantId)
      || (expectedScope !== null && expectedScope !== undefined
        && handle.scope !== expectedScope)
    ) {
      throw new Error(
        "Runtime execution episode scope identity does not match beginEpisode input",
      );
    }
    return { handle, response };
  }

  async resumeEpisode<T = unknown>(
    input: AionisResumeEpisodeInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    assertExecutionEpisodeRequestScope(input, options);
    const response = await this.post<T>("/v1/observe", stripUndefined({
      observation_kind: "execution_episode",
      event_kind: "episode_resumed",
      episode_id: input.episode_id,
      workspace_root: input.workspace_root,
      tenant_id: input.tenant_id,
      scope: input.scope,
    }), options);
    const handle = executionEpisodeHandleFromResponse(
      response,
      input.workspace_root,
    );
    if (handle.episode_id !== input.episode_id) {
      throw new Error(
        "Runtime execution episode identity does not match resumeEpisode input",
      );
    }
    const expectedTenantId =
      options?.tenant_id ?? input.tenant_id ?? this.tenantId;
    const expectedScope = options?.scope ?? input.scope ?? this.scope;
    if (
      (expectedTenantId !== null && expectedTenantId !== undefined
        && handle.tenant_id !== expectedTenantId)
      || (expectedScope !== null && expectedScope !== undefined
        && handle.scope !== expectedScope)
    ) {
      throw new Error(
        "Runtime execution episode scope identity does not match resumeEpisode input",
      );
    }
    return { handle, response };
  }

  async beginAgentSession<T = unknown>(
    input: AionisBeginAgentSessionInput,
    options?: AionisRequestOptions,
  ): Promise<AionisAgentSessionOperationResult<T>> {
    assertExecutionEpisodeRequestScope(input, options);
    const sourceTaskBytes = executionEpisodeBytes(
      input.source_task,
      "beginAgentSession source_task",
    );
    const sourceTaskSha256 = createHash("sha256")
      .update(sourceTaskBytes)
      .digest("hex");
    if (sourceTaskSha256 !== input.task_envelope_v1.source_task_sha256) {
      throw new Error(
        "beginAgentSession source_task bytes do not match task_envelope_v1.source_task_sha256",
      );
    }
    const response = await this.post<T>("/v1/observe", {
      ...stripUndefined({
        observation_kind: "execution_session",
        event_kind: "session_begin",
        operation_id: input.operation_id,
        session_key: input.session_key,
        continuation_id: input.continuation_id,
        holder_id: input.holder_id,
        lease_ttl_ms: input.lease_ttl_ms,
        task_envelope_v1: input.task_envelope_v1,
        source_task_base64: sourceTaskBytes.toString("base64"),
        run_id: input.run_id,
        model_id: input.model_id,
        budget: input.budget,
        workspace_root: input.workspace_root,
        subject_state_spec_v2: input.subject_state_spec_v2,
        required_verifier_id: input.required_verifier_id,
        tenant_id: input.tenant_id,
        scope: input.scope,
      }),
      model_config: input.model_config,
    }, options);
    const handle = agentSessionHandleFromResponse(
      response,
      input.workspace_root,
    );
    if (
      handle.session_key !== input.session_key
      || handle.continuation_id !== input.continuation_id
    ) {
      throw new Error(
        "Runtime execution-session identity does not match begin input",
      );
    }
    return { handle, response };
  }

  async resumeAgentSession<T = unknown>(
    input: AionisResumeAgentSessionInput,
    options?: AionisRequestOptions,
  ): Promise<AionisAgentSessionOperationResult<T>> {
    assertExecutionEpisodeRequestScope(input, options);
    const response = await this.post<T>(
      "/v1/observe",
      stripUndefined({
        observation_kind: "execution_session",
        event_kind: "session_resume",
        operation_id: input.operation_id,
        session_key: input.session_key,
        holder_id: input.holder_id,
        lease_ttl_ms: input.lease_ttl_ms,
        workspace_root: input.workspace_root,
        tenant_id: input.tenant_id,
        scope: input.scope,
      }),
      options,
    );
    const handle = agentSessionHandleFromResponse(
      response,
      input.workspace_root,
    );
    if (
      handle.session_key !== input.session_key
      || handle.holder_id !== input.holder_id
    ) {
      throw new Error(
        "Runtime execution-session identity does not match resume input",
      );
    }
    return { handle, response };
  }

  private async mutateAgentSession<T>(
    eventKind: "session_renew" | "session_handoff" | "session_release",
    input:
      | AionisAgentSessionLeaseOperationInput
      | AionisAgentSessionHandoffInput,
    options?: AionisRequestOptions,
  ): Promise<AionisAgentSessionOperationResult<T>> {
    const handle = canonicalAgentSessionHandle(input.handle);
    const handoff = eventKind === "session_handoff"
      ? input as AionisAgentSessionHandoffInput
      : null;
    const response = await this.post<T>(
      "/v1/observe",
      stripUndefined({
        observation_kind: "execution_session",
        event_kind: eventKind,
        operation_id: input.operation_id,
        session_key: handle.session_key,
        holder_id: handle.holder_id,
        lease_id: handle.lease_id,
        lease_revision: handle.lease_revision,
        lease_ttl_ms: input.lease_ttl_ms,
        to_holder_id: handoff?.to_holder_id,
        evidence_refs: handoff?.evidence_refs,
      }),
      executionEpisodeOptions(handle.episode, options),
    );
    return {
      handle: agentSessionHandleFromResponse(
        response,
        handle.episode.workspace_root,
        handle.episode,
      ),
      response,
    };
  }

  async renewAgentSession<T = unknown>(
    input: AionisAgentSessionLeaseOperationInput,
    options?: AionisRequestOptions,
  ): Promise<AionisAgentSessionOperationResult<T>> {
    return await this.mutateAgentSession("session_renew", input, options);
  }

  async handoffAgentSession<T = unknown>(
    input: AionisAgentSessionHandoffInput,
    options?: AionisRequestOptions,
  ): Promise<AionisAgentSessionOperationResult<T>> {
    return await this.mutateAgentSession("session_handoff", input, options);
  }

  async releaseAgentSession<T = unknown>(
    input: AionisAgentSessionLeaseOperationInput,
    options?: AionisRequestOptions,
  ): Promise<AionisAgentSessionOperationResult<T>> {
    return await this.mutateAgentSession("session_release", input, options);
  }

  async guideEpisode<T = unknown>(
    input: AionisGuideEpisodeInput,
    options?: AionisGuideRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    if (input.handle.closed) {
      throw new Error("Cannot guide a closed execution episode");
    }
    if (
      input.guide.operation_id !== undefined
      && input.guide.operation_id !== input.operation_id
    ) {
      throw new Error("Execution episode guide operation identity cannot change");
    }
    if (
      input.guide.episode_id !== undefined
      && input.guide.episode_id !== input.handle.episode_id
    ) {
      throw new Error("Execution episode guide identity cannot change");
    }
    if (
      input.guide.expected_current_state_snapshot_id !== undefined
      && input.guide.expected_current_state_snapshot_id
        !== input.handle.current_state_snapshot_id
    ) {
      throw new Error(
        "Execution episode guide target state cannot change",
      );
    }
    if (
      input.guide.run_id !== undefined
      && input.guide.run_id !== input.handle.run_id
    ) {
      throw new Error("Execution episode guide run identity cannot change");
    }
    if (
      input.guide.host_task_envelope_v1 !== undefined
      && (
        input.guide.host_task_envelope_v1.host_task_id
          !== input.handle.task_id
        || hostTaskEnvelopeDigest(
          input.guide.host_task_envelope_v1,
        ) !== input.handle.task_envelope_digest
      )
    ) {
      throw new Error("Execution episode guide task identity cannot change");
    }
    executionEpisodeOptions(input.handle, options);
    const response = await this.guide<T>({
      ...input.guide,
      operation_id: input.operation_id,
      episode_id: input.handle.episode_id,
      expected_current_state_snapshot_id:
        input.handle.current_state_snapshot_id,
      run_id: input.handle.run_id,
    }, {
      ...(options ?? {}),
      tenant_id: input.handle.tenant_id,
      scope: input.handle.scope,
    });
    return {
      handle: input.handle,
      response,
    };
  }

  async recordAction<T = unknown>(
    input: AionisRecordEpisodeActionInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    if (input.handle.closed) {
      throw new Error("Cannot record an action on a closed execution episode");
    }
    const requestBytes = executionEpisodeBytes(
      input.request,
      "recordAction request",
    );
    const resultBytes = executionEpisodeBytes(
      input.result,
      "recordAction result",
    );
    const response = await this.post<T>("/v1/observe", {
      observation_kind: "execution_episode",
      event_kind: "action_observed",
      operation_id: input.operation_id,
      episode_id: input.handle.episode_id,
      workspace_root: input.handle.workspace_root,
      expected_current_state_snapshot_id:
        input.expected_current_state_snapshot_id
        ?? input.handle.current_state_snapshot_id,
      action_kind: input.action_kind,
      tool_name: input.tool_name,
      request_base64: requestBytes.toString("base64"),
      result_base64: resultBytes.toString("base64"),
      session_lease_v1: input.session_lease_v1,
    }, executionEpisodeOptions(input.handle, options));
    return {
      handle: updateExecutionEpisodeHandle(input.handle, response),
      response,
    };
  }

  async recordEpisodeObservation<T = unknown>(
    input: AionisRecordEpisodeObservationInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    if (input.handle.closed) {
      throw new Error(
        "Cannot record an observation on a closed execution episode",
      );
    }
    const evidenceBytes = executionEpisodeBytes(
      input.evidence,
      "recordObservation evidence",
    );
    const response = await this.post<T>("/v1/observe", stripUndefined({
      observation_kind: "execution_episode",
      event_kind: "semantic_observation_recorded",
      operation_id: input.operation_id,
      episode_id: input.handle.episode_id,
      workspace_root: input.handle.workspace_root,
      expected_current_state_snapshot_id:
        input.expected_current_state_snapshot_id
        ?? input.handle.current_state_snapshot_id,
      observation: input.observation,
      authority: input.authority,
      evidence_kind: input.evidence_kind,
      evidence_base64: evidenceBytes.toString("base64"),
      evidence_media_type: input.evidence_media_type,
      evidence_encoding: input.evidence_encoding,
      decisive_evidence: input.decisive_evidence,
      session_lease_v1: input.session_lease_v1,
    }), executionEpisodeOptions(input.handle, options));
    return {
      handle: updateExecutionEpisodeHandle(input.handle, response),
      response,
    };
  }

  async recordEpisodeDecision<T = unknown>(
    input: AionisRecordEpisodeDecisionInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    if (input.handle.closed) {
      throw new Error(
        "Cannot record a decision on a closed execution episode",
      );
    }
    const evidenceBytes = executionEpisodeBytes(
      input.evidence,
      "recordDecision evidence",
    );
    const response = await this.post<T>("/v1/observe", stripUndefined({
      observation_kind: "execution_episode",
      event_kind: "agent_decision_recorded",
      operation_id: input.operation_id,
      episode_id: input.handle.episode_id,
      workspace_root: input.handle.workspace_root,
      expected_current_state_snapshot_id:
        input.expected_current_state_snapshot_id
        ?? input.handle.current_state_snapshot_id,
      decision: input.decision,
      reasons: input.reasons,
      alternatives_rejected: input.alternatives_rejected,
      authority: input.authority,
      evidence_kind: input.evidence_kind,
      evidence_base64: evidenceBytes.toString("base64"),
      evidence_media_type: input.evidence_media_type,
      evidence_encoding: input.evidence_encoding,
      decisive_evidence: input.decisive_evidence,
      session_lease_v1: input.session_lease_v1,
    }), executionEpisodeOptions(input.handle, options));
    return {
      handle: updateExecutionEpisodeHandle(input.handle, response),
      response,
    };
  }

  async recordEpisodeProgress<T = unknown>(
    input: AionisRecordEpisodeProgressInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    if (input.handle.closed) {
      throw new Error(
        "Cannot record progress on a closed execution episode",
      );
    }
    const evidenceBytes = executionEpisodeBytes(
      input.evidence,
      "recordProgress evidence",
    );
    const response = await this.post<T>("/v1/observe", stripUndefined({
      observation_kind: "execution_episode",
      event_kind: "progress_state_recorded",
      operation_id: input.operation_id,
      episode_id: input.handle.episode_id,
      workspace_root: input.handle.workspace_root,
      expected_current_state_snapshot_id:
        input.expected_current_state_snapshot_id
        ?? input.handle.current_state_snapshot_id,
      item_id: input.item_id,
      state: input.state,
      statement: input.statement,
      authority: input.authority,
      evidence_kind: input.evidence_kind,
      evidence_base64: evidenceBytes.toString("base64"),
      evidence_media_type: input.evidence_media_type,
      evidence_encoding: input.evidence_encoding,
      decisive_evidence: input.decisive_evidence,
      session_lease_v1: input.session_lease_v1,
    }), executionEpisodeOptions(input.handle, options));
    return {
      handle: updateExecutionEpisodeHandle(input.handle, response),
      response,
    };
  }

  async recordEpisodePlannedAction<T = unknown>(
    input: AionisRecordEpisodePlannedActionInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    if (input.handle.closed) {
      throw new Error(
        "Cannot record a planned action on a closed execution episode",
      );
    }
    const evidenceBytes = executionEpisodeBytes(
      input.evidence,
      "recordPlannedAction evidence",
    );
    const response = await this.post<T>("/v1/observe", stripUndefined({
      observation_kind: "execution_episode",
      event_kind: "planned_action_recorded",
      operation_id: input.operation_id,
      episode_id: input.handle.episode_id,
      workspace_root: input.handle.workspace_root,
      expected_current_state_snapshot_id:
        input.expected_current_state_snapshot_id
        ?? input.handle.current_state_snapshot_id,
      action_id: input.action_id,
      intent: input.intent,
      justification: input.justification,
      preconditions: input.preconditions,
      authority: input.authority,
      evidence_kind: input.evidence_kind,
      evidence_base64: evidenceBytes.toString("base64"),
      evidence_media_type: input.evidence_media_type,
      evidence_encoding: input.evidence_encoding,
      decisive_evidence: input.decisive_evidence,
      session_lease_v1: input.session_lease_v1,
    }), executionEpisodeOptions(input.handle, options));
    return {
      handle: updateExecutionEpisodeHandle(input.handle, response),
      response,
    };
  }

  async recordMutation<T = unknown>(
    input: AionisRecordEpisodeMutationInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    if (input.handle.closed) {
      throw new Error(
        "Cannot record a mutation on a closed execution episode",
      );
    }
    const response = await this.post<T>("/v1/observe", {
      observation_kind: "execution_episode",
      event_kind: "state_mutation",
      operation_id: input.operation_id,
      episode_id: input.handle.episode_id,
      workspace_root: input.handle.workspace_root,
      expected_current_state_snapshot_id:
        input.expected_current_state_snapshot_id
        ?? input.handle.current_state_snapshot_id,
      action_kind: input.mutation_kind,
      request_base64: executionEpisodeBytes(
        {
          mutation_kind: input.mutation_kind,
          details: input.details ?? {},
        },
        "recordMutation details",
      ).toString("base64"),
      result_base64: executionEpisodeBytes(
        { observed: true },
        "recordMutation result",
      ).toString("base64"),
      session_lease_v1: input.session_lease_v1,
    }, executionEpisodeOptions(input.handle, options));
    return {
      handle: updateExecutionEpisodeHandle(input.handle, response),
      response,
    };
  }

  async restoreEpisodeSnapshot<T = unknown>(
    input: AionisRestoreEpisodeSnapshotInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    if (input.handle.closed) {
      throw new Error(
        "Cannot restore a snapshot on a closed execution episode",
      );
    }
    if (
      input.expected_current_state_snapshot_id !== undefined
      && input.expected_current_state_snapshot_id
        !== input.handle.current_state_snapshot_id
    ) {
      throw new Error(
        "Execution episode snapshot recovery source state cannot change",
      );
    }
    const response = await this.post<T>(
      "/v1/observe",
      stripUndefined({
        observation_kind: "execution_episode",
        event_kind: "snapshot_restored",
        operation_id: input.operation_id,
        episode_id: input.handle.episode_id,
        workspace_root: input.handle.workspace_root,
        expected_current_state_snapshot_id:
          input.expected_current_state_snapshot_id
          ?? input.handle.current_state_snapshot_id,
        target_snapshot_id: input.target_snapshot_id,
        session_lease_v1: input.session_lease_v1,
      }),
      executionEpisodeOptions(input.handle, options),
    );
    return {
      handle: updateExecutionEpisodeHandle(input.handle, response),
      response,
    };
  }

  async runEpisodeVerifier<T = unknown>(
    input: AionisRunEpisodeVerifierInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    if (input.handle.closed) {
      throw new Error("Cannot run a verifier on a closed execution episode");
    }
    if (
      input.expected_current_state_snapshot_id !== undefined
      && input.expected_current_state_snapshot_id
        !== input.handle.current_state_snapshot_id
    ) {
      throw new Error(
        "Execution episode verifier target state cannot change",
      );
    }
    const response = await this.post<T>("/v1/feedback", {
      feedback_kind: "episode_outcome",
      event_kind: "run_verifier",
      operation_id: input.operation_id,
      episode_id: input.handle.episode_id,
      workspace_root: input.handle.workspace_root,
      expected_current_state_snapshot_id:
        input.handle.current_state_snapshot_id,
      session_lease_v1: input.session_lease_v1,
    }, executionEpisodeOptions(input.handle, options));
    const responseRecord = asRecord(response);
    const invocation = asRecord(responseRecord?.invocation);
    const targetStateSnapshotId = coerceString(
      invocation?.target_state_snapshot_id,
    );
    if (
      targetStateSnapshotId !== input.handle.current_state_snapshot_id
    ) {
      throw new Error(
        "Runtime verifier target state does not match the execution episode handle",
      );
    }
    return {
      handle: updateExecutionEpisodeHandle(input.handle, response),
      response,
    };
  }

  async closeEpisode<T = unknown>(
    input: AionisCloseEpisodeInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionEpisodeOperationResult<T>> {
    const cost = input.cost
      ? stripUndefined({
        provider: input.cost.provider,
        model: input.cost.model,
        input_tokens: input.cost.input_tokens,
        output_tokens: input.cost.output_tokens,
        cached_input_tokens: input.cost.cached_input_tokens,
        token_usage_authority: input.cost.token_usage_authority,
        usage_receipt_base64: executionEpisodeBytes(
          input.cost.usage_receipt,
          "closeEpisode usage_receipt",
        ).toString("base64"),
        usage_receipt_media_type:
          input.cost.usage_receipt_media_type,
        usage_receipt_encoding: input.cost.usage_receipt_encoding,
        monetary_cost_micros: input.cost.monetary_cost_micros,
        currency: input.cost.currency,
        producer_id: input.cost.producer_id,
      })
      : undefined;
    const response = await this.post<T>("/v1/feedback", stripUndefined({
      feedback_kind: "episode_outcome",
      event_kind: "episode_closed",
      operation_id: input.operation_id,
      episode_id: input.handle.episode_id,
      workspace_root: input.handle.workspace_root,
      expected_current_state_snapshot_id:
        input.expected_current_state_snapshot_id
        ?? input.handle.current_state_snapshot_id,
      termination: input.termination,
      verifier_receipt_id: input.verifier_receipt_id,
      outcome_details: input.outcome_details,
      cost,
      session_lease_v1: input.session_lease_v1,
    }), executionEpisodeOptions(input.handle, options));
    return {
      handle: updateExecutionEpisodeHandle(input.handle, response, true),
      response,
    };
  }

// </aionis-runtime-owned:execution-episode-client>

  async remember<T = unknown>(body: AionisRememberRequest, options?: AionisRequestOptions): Promise<T> {
    return this.observe<T>(rememberBody(body), options);
  }

  async guide<T = unknown>(body: AionisGuideRequest, options?: AionisGuideRequestOptions): Promise<T> {
    return this.post<T>("/v1/guide", stripUndefined(body), options);
  }

  async resolveMemory<T = unknown>(body: AionisMemoryResolveRequest, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/memory/resolve", body, options);
  }

  async guideAgentContext<TGuide = unknown>(
    body: AionisGuideRequest,
    options?: AionisGuideRequestOptions,
    contextOptions: AionisGuideAgentContextOptions = {},
  ): Promise<AionisGuideAgentContextResult<TGuide>> {
    const guide = await this.guide<TGuide>(body, options);
    return guideAgentContextFromGuideResponse({
      guide,
      body,
      options,
      contextOptions,
      defaultTenantId: this.tenantId,
      defaultScope: this.scope,
      resolveMemory: (resolveBody, requestOptions) =>
        this.resolveMemory(resolveBody, requestOptions),
    });
  }

  async guideWithEvidence<TGuide = unknown>(
    body: AionisGuideRequest,
    options?: AionisGuideRequestOptions,
    contextOptions?: AionisGuideAgentContextOptions,
  ): Promise<AionisGuideAgentContextResult<TGuide>> {
    return this.guideAgentContext<TGuide>(body, options, contextOptions);
  }

  async forget<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/forget", body, options);
  }

  async feedback<T = unknown>(body: AionisFeedbackRequest, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/feedback", body, options);
  }

  async rehydrate<T = unknown>(body: AionisRehydrateRequest, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/rehydrate", body, options);
  }

  async health<T = unknown>(): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`, {
      method: "GET",
      headers: this.requestHeaders(),
    });
    const payload = await readResponseBody(response);
    if (!response.ok) throw new AionisClientError(response.status, "/health", payload);
    return payload as T;
  }

  private async post<T>(path: string, body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    const requestBody = scopedBody(body, {
      tenant_id: this.tenantId ?? undefined,
      scope: this.scope ?? undefined,
    }, options);
    const serializedBody = JSON.stringify(requestBody);
    const replaySafe = (
      AIONIS_REPLAY_SAFE_POST_PATHS.has(path)
      && typeof requestBody.operation_id === "string"
      && requestBody.operation_id.trim().length > 0
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.requestHeaders(options),
          body: serializedBody,
        });
        const payload = await readResponseBody(response);
        if (!response.ok) {
          throw new AionisClientError(response.status, path, payload);
        }
        return payload as T;
      } catch (error) {
        if (
          attempt === 0
          && replaySafe
          && isRetryableAionisTransportError(error)
        ) {
          continue;
        }
        throw error;
      }
    }

    throw new Error("Aionis replay-safe request retry exhausted");
  }

  private requestHeaders(options?: AionisRequestOptions): Record<string, string> {
    return {
      "content-type": "application/json",
      ...this.headers,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}`, "x-api-key": this.apiKey } : {}),
      ...(options?.headers ?? {}),
    };
  }
}

export class AionisAgentSessionClient {
  private readonly client: AionisClient;

  constructor(client: AionisClient) {
    this.client = client;
  }

  async begin(
    input: AionisBeginAgentSessionInput,
    options?: AionisRequestOptions,
  ): Promise<AionisAgentSession> {
    const result = await this.client.beginAgentSession(input, options);
    return new AionisAgentSession(this.client, result.handle);
  }

  attach(
    serializedHandle: AionisAgentSessionHandleV1,
  ): AionisAgentSession {
    return new AionisAgentSession(
      this.client,
      canonicalAgentSessionHandle(serializedHandle),
    );
  }

  async resume(
    serializedHandle: AionisAgentSessionHandleV1,
    input: Readonly<{
      operation_id: string;
      lease_ttl_ms?: number;
    }>,
    options?: AionisRequestOptions,
  ): Promise<AionisAgentSession> {
    const expected = canonicalAgentSessionHandle(serializedHandle);
    const result = await this.client.resumeAgentSession({
      operation_id: input.operation_id,
      session_key: expected.session_key,
      holder_id: expected.holder_id,
      workspace_root: expected.episode.workspace_root,
      lease_ttl_ms: input.lease_ttl_ms,
      tenant_id: expected.episode.tenant_id,
      scope: expected.episode.scope,
    }, executionEpisodeOptions(expected.episode, options));
    if (
      result.handle.session_key !== expected.session_key
      || result.handle.continuation_id !== expected.continuation_id
      || result.handle.episode.episode_id !== expected.episode.episode_id
    ) {
      throw new Error(
        "Runtime execution-session identity changed while resuming a serialized handle",
      );
    }
    return new AionisAgentSession(this.client, result.handle);
  }
}

export function createAionisClient(options: AionisClientOptions): AionisClient {
  return new AionisClient(options);
}

export function agentContextFromGuide<T = AionisJsonObject>(guide: unknown): T {
  const context = asRecord(guide)?.agent_context;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error("Aionis guide response is missing agent_context");
  }
  return context as T;
}

export function agentPromptFromGuide(guide: unknown): string {
  const promptText = asRecord(agentContextFromGuide(guide))?.prompt_text;
  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("Aionis guide response is missing agent_context.prompt_text");
  }
  return promptText;
}

export function rehydrateHintsFromGuide(guide: unknown): AionisRehydrateHint[] {
  return rehydrateRequestsFromGuide(guide);
}

export function memoryIdsFromGuide(guide: unknown): string[] {
  const context = asRecord(agentContextFromGuide(guide));
  const ids = [
    ...stringArray(context?.memory_ids),
    ...stringArray(context?.use_now_memory_ids),
    ...stringArray(context?.inspect_before_use_memory_ids),
    ...stringArray(context?.do_not_use_memory_ids),
    ...rehydrateHintMemoryIds(context?.rehydrate_hints),
    ...commandPostureArray(context?.command_posture).map((entry) => entry.memory_id),
  ];
  return Array.from(new Set(ids));
}

function actorFromGuide(guide: unknown): string | undefined {
  const record = asRecord(guide);
  const topLevel = coerceString(record?.consumer_agent_id);
  if (topLevel) return topLevel;
  const memoryPacketActor = asRecord(asRecord(record?.memory_packet)?.actor);
  const memoryPacketAgent = coerceString(memoryPacketActor?.consumer_agent_id);
  return memoryPacketAgent ?? undefined;
}

export function commandPostureFromGuide(
  guide: unknown,
  posture?: AionisCommandPostureKind,
): AionisCommandPosture[] {
  const rows = commandPostureArray(asRecord(agentContextFromGuide(guide))?.command_posture);
  return posture ? rows.filter((entry) => entry.posture === posture) : rows;
}

export function commandPostureMemoryIdsFromGuide(
  guide: unknown,
  posture?: AionisCommandPostureKind,
): string[] {
  return Array.from(new Set(commandPostureFromGuide(guide, posture).map((entry) => entry.memory_id)));
}

export function mustNotMemoryIdsFromGuide(guide: unknown): string[] {
  return commandPostureMemoryIdsFromGuide(guide, "must_not");
}

export function shouldContinueMemoryIdsFromGuide(guide: unknown): string[] {
  return commandPostureMemoryIdsFromGuide(guide, "should_continue");
}

export function inspectFirstMemoryIdsFromGuide(guide: unknown): string[] {
  return commandPostureMemoryIdsFromGuide(guide, "inspect_first");
}

export function rehydrateFirstMemoryIdsFromGuide(guide: unknown): string[] {
  return commandPostureMemoryIdsFromGuide(guide, "rehydrate_first");
}

export function optionalContextMemoryIdsFromGuide(guide: unknown): string[] {
  return commandPostureMemoryIdsFromGuide(guide, "optional_context");
}

// <aionis-runtime-owned:host-receipt-helpers>

const SDK_GUIDE_FEEDBACK_ATTRIBUTION_AVAILABLE_FIELDS = [
  "contract_version",
  "status",
  "guide_trace_id",
  "episode_id",
  "exposure_event_id",
  "item_set_sha256",
  "served_surface_sha256",
  "projection_complete",
  "projection_incomplete_reason_codes",
  "items",
] as const;

const SDK_GUIDE_FEEDBACK_ATTRIBUTION_UNAVAILABLE_FIELDS = [
  "contract_version",
  "status",
  "guide_trace_id",
  "reason_code",
] as const;

const SDK_GUIDE_FEEDBACK_ATTRIBUTION_ITEM_FIELDS = [
  "memory_id",
  "served_surface",
] as const;

const SDK_HOST_TASK_ENVELOPE_FIELDS = [
  "contract_version",
  "host_task_id",
  "collector_id",
  "collector_version",
  "task_family",
  "task_signature",
  "repository_signature",
  "source_task_sha256",
  "source_event_sha256",
  "created_at",
] as const;

const SDK_HOST_USE_RECEIPT_ITEM_FIELDS = [
  "memory_id",
  "used_surface",
  "outcome",
  "action_outcome",
  "verifier_kind",
  "verifier_version",
  "verifier_config_sha256",
  "verifier_status",
  "content_evidence_sha256",
  "evidence_ref_sha256",
] as const;

const SDK_HOST_USE_RECEIPT_BODY_FIELDS = [
  "contract_version",
  "receipt_id",
  "guide_trace_id",
  "episode_id",
  "operation_id",
  "run_id",
  "host_task_id",
  "host_task_envelope_sha256",
  "collector_id",
  "collector_version",
  "host_trace_sha256",
  "observed_at",
  "items",
] as const;

const SDK_HOST_USE_RECEIPT_FIELDS = [
  ...SDK_HOST_USE_RECEIPT_BODY_FIELDS,
  "receipt_sha256",
] as const;

function sdkContractRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function sdkAssertExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(value).find((field) => !allowed.has(field));
  if (unexpected) throw new Error(`${label} has unexpected field ${unexpected}`);
}

function sdkBoundedString(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const canonical = value.trim();
  if (canonical.length === 0 || canonical.length > maxLength) {
    throw new Error(`${label} must contain 1-${maxLength} characters after trimming`);
  }
  return canonical;
}

function sdkUtf8BoundedString(value: unknown, maxBytes: number, label: string): string {
  const canonical = sdkBoundedString(value, maxBytes, label);
  if (Buffer.byteLength(canonical, "utf8") > maxBytes) {
    throw new Error(`${label} must contain 1-${maxBytes} UTF-8 bytes after trimming`);
  }
  return canonical;
}

function sdkDigestSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function sdkEpisodeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^lep_[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a canonical learning episode id`);
  }
  return value;
}

function sdkExposureEventId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^lexposure_[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a canonical learning exposure event id`);
  }
  return value;
}

function sdkCanonicalUtcTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp with millisecond precision`);
  }
  return value;
}

function sdkEnumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function sdkCompareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sdkCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => sdkCanonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sdkCanonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("SDK canonical JSON accepts only finite JSON values");
}

function sdkCanonicalSha256(value: unknown): string {
  return createHash("sha256").update(sdkCanonicalJson(value)).digest("hex");
}

function sdkCanonicalReasonCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(
      "feedback_attribution_v1.projection_incomplete_reason_codes must contain 0-32 entries",
    );
  }
  const reasons = value.map((reason) => sdkBoundedString(
    reason,
    120,
    "feedback_attribution_v1.projection_incomplete_reason_codes[]",
  ));
  if (new Set(reasons).size !== reasons.length) {
    throw new Error("feedback_attribution_v1 reason codes must be unique");
  }
  const canonical = [...reasons].sort(sdkCompareUtf8);
  if (canonical.some((reason, index) => reason !== reasons[index])) {
    throw new Error("feedback_attribution_v1 reason codes must be sorted by UTF-8 bytes");
  }
  return reasons;
}

function sdkParseGuideFeedbackAttributionItemV1(
  value: unknown,
): AionisGuideFeedbackAttributionItemV1 {
  const record = sdkContractRecord(value, "feedback_attribution_v1.items[]");
  sdkAssertExactFields(
    record,
    SDK_GUIDE_FEEDBACK_ATTRIBUTION_ITEM_FIELDS,
    "feedback_attribution_v1.items[]",
  );
  return {
    memory_id: sdkBoundedString(record.memory_id, 256, "feedback_attribution_v1.items[].memory_id"),
    served_surface: sdkEnumValue(
      record.served_surface,
      ["use_now", "inspect_before_use", "do_not_use", "rehydrate"] as const,
      "feedback_attribution_v1.items[].served_surface",
    ),
  };
}

export function parseGuideFeedbackAttributionV1(
  value: unknown,
): AionisGuideFeedbackAttributionV1 {
  const record = sdkContractRecord(value, "feedback_attribution_v1");
  const contractVersion = sdkEnumValue(
    record.contract_version,
    ["aionis_guide_feedback_attribution_v1"] as const,
    "feedback_attribution_v1.contract_version",
  );
  const status = sdkEnumValue(
    record.status,
    ["available", "unavailable"] as const,
    "feedback_attribution_v1.status",
  );
  const guideTraceId = sdkBoundedString(
    record.guide_trace_id,
    256,
    "feedback_attribution_v1.guide_trace_id",
  );
  if (status === "unavailable") {
    sdkAssertExactFields(
      record,
      SDK_GUIDE_FEEDBACK_ATTRIBUTION_UNAVAILABLE_FIELDS,
      "feedback_attribution_v1",
    );
    return {
      contract_version: contractVersion,
      status,
      guide_trace_id: guideTraceId,
      reason_code: sdkEnumValue(
        record.reason_code,
        ["learning_exposure_not_persisted"] as const,
        "feedback_attribution_v1.reason_code",
      ),
    };
  }
  sdkAssertExactFields(
    record,
    SDK_GUIDE_FEEDBACK_ATTRIBUTION_AVAILABLE_FIELDS,
    "feedback_attribution_v1",
  );
  if (!Array.isArray(record.items) || record.items.length > 200) {
    throw new Error("feedback_attribution_v1.items must contain 0-200 entries");
  }
  const items = record.items.map((item) => sdkParseGuideFeedbackAttributionItemV1(item));
  const ids = items.map((item) => item.memory_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("feedback_attribution_v1 items must have unique memory_id values");
  }
  if (ids.some((memoryId, index) => index > 0 && sdkCompareUtf8(ids[index - 1]!, memoryId) >= 0)) {
    throw new Error("feedback_attribution_v1 items must be sorted by UTF-8 memory_id bytes");
  }
  const servedSurfaceSha256 = sdkDigestSha256(
    record.served_surface_sha256,
    "feedback_attribution_v1.served_surface_sha256",
  );
  const expectedServedSurfaceSha256 = sdkCanonicalSha256(items.map((item) => ({
    memory_id: item.memory_id,
    action: item.served_surface,
  })));
  if (servedSurfaceSha256 !== expectedServedSurfaceSha256) {
    throw new Error("feedback_attribution_v1 served surface digest does not match its canonical items");
  }
  const projectionComplete = record.projection_complete;
  if (typeof projectionComplete !== "boolean") {
    throw new Error("feedback_attribution_v1.projection_complete must be a boolean");
  }
  const reasonCodes = sdkCanonicalReasonCodes(record.projection_incomplete_reason_codes);
  if (projectionComplete === (reasonCodes.length > 0)) {
    throw new Error("feedback_attribution_v1 completeness and reason codes are inconsistent");
  }
  return {
    contract_version: contractVersion,
    status,
    guide_trace_id: guideTraceId,
    episode_id: sdkEpisodeId(record.episode_id, "feedback_attribution_v1.episode_id"),
    exposure_event_id: sdkExposureEventId(
      record.exposure_event_id,
      "feedback_attribution_v1.exposure_event_id",
    ),
    item_set_sha256: sdkDigestSha256(
      record.item_set_sha256,
      "feedback_attribution_v1.item_set_sha256",
    ),
    served_surface_sha256: servedSurfaceSha256,
    projection_complete: projectionComplete,
    projection_incomplete_reason_codes: reasonCodes,
    items,
  };
}

export function parseHostTaskEnvelopeV1(value: unknown): AionisHostTaskEnvelopeV1 {
  const record = sdkContractRecord(value, "host_task_envelope_v1");
  sdkAssertExactFields(record, SDK_HOST_TASK_ENVELOPE_FIELDS, "host_task_envelope_v1");
  return {
    contract_version: sdkEnumValue(record.contract_version, ["host_task_envelope_v1"] as const, "contract_version"),
    host_task_id: sdkBoundedString(record.host_task_id, 256, "host_task_id"),
    collector_id: sdkBoundedString(record.collector_id, 256, "collector_id"),
    collector_version: sdkBoundedString(record.collector_version, 120, "collector_version"),
    task_family: sdkBoundedString(record.task_family, 120, "task_family"),
    task_signature: sdkBoundedString(record.task_signature, 256, "task_signature"),
    repository_signature: sdkBoundedString(record.repository_signature, 256, "repository_signature"),
    source_task_sha256: sdkDigestSha256(record.source_task_sha256, "source_task_sha256"),
    source_event_sha256: sdkDigestSha256(record.source_event_sha256, "source_event_sha256"),
    created_at: sdkCanonicalUtcTimestamp(record.created_at, "created_at"),
  };
}

export function buildHostTaskEnvelopeV1(value: unknown): AionisHostTaskEnvelopeV1 {
  return parseHostTaskEnvelopeV1(value);
}

export function hostTaskEnvelopeDigest(value: AionisHostTaskEnvelopeV1): string {
  return sdkCanonicalSha256(parseHostTaskEnvelopeV1(value));
}

function sdkParseHostUseReceiptItemV1(value: unknown): AionisHostUseReceiptItemV1 {
  const record = sdkContractRecord(value, "host_use_receipt_v1.items[]");
  sdkAssertExactFields(record, SDK_HOST_USE_RECEIPT_ITEM_FIELDS, "host_use_receipt_v1.items[]");
  return {
    memory_id: sdkBoundedString(record.memory_id, 256, "items[].memory_id"),
    used_surface: sdkEnumValue(
      record.used_surface,
      ["use_now", "inspect_before_use", "do_not_use"] as const,
      "items[].used_surface",
    ),
    outcome: sdkEnumValue(record.outcome, ["positive", "negative", "neutral"] as const, "items[].outcome"),
    action_outcome: sdkEnumValue(
      record.action_outcome,
      ["accepted_completed", "accepted_incomplete", "rejected", "not_applicable"] as const,
      "items[].action_outcome",
    ),
    verifier_kind: sdkEnumValue(
      record.verifier_kind,
      ["instrumented_agent_trace", "deterministic_scorer"] as const,
      "items[].verifier_kind",
    ),
    verifier_version: sdkUtf8BoundedString(record.verifier_version, 120, "items[].verifier_version"),
    verifier_config_sha256: sdkDigestSha256(
      record.verifier_config_sha256,
      "items[].verifier_config_sha256",
    ),
    verifier_status: sdkEnumValue(record.verifier_status, ["passed"] as const, "items[].verifier_status"),
    content_evidence_sha256: sdkDigestSha256(
      record.content_evidence_sha256,
      "items[].content_evidence_sha256",
    ),
    evidence_ref_sha256: sdkDigestSha256(record.evidence_ref_sha256, "items[].evidence_ref_sha256"),
  };
}

function sdkValidateCanonicalReceiptItems(items: readonly AionisHostUseReceiptItemV1[]): void {
  const seen = new Set<string>();
  let previousMemoryId: string | null = null;
  for (const item of items) {
    if (seen.has(item.memory_id)) {
      throw new Error(`Duplicate host-use receipt memory_id: ${item.memory_id}`);
    }
    if (previousMemoryId !== null && sdkCompareUtf8(previousMemoryId, item.memory_id) >= 0) {
      throw new Error("Host-use receipt items must be unique and sorted by UTF-8 memory_id bytes");
    }
    seen.add(item.memory_id);
    previousMemoryId = item.memory_id;
  }
}

function sdkParseHostUseReceiptV1Body(
  value: unknown,
  canonicalizeItems: boolean,
): AionisHostUseReceiptV1Body {
  const record = sdkContractRecord(value, "host_use_receipt_v1 body");
  sdkAssertExactFields(record, SDK_HOST_USE_RECEIPT_BODY_FIELDS, "host_use_receipt_v1 body");
  if (!Array.isArray(record.items) || record.items.length < 1 || record.items.length > 96) {
    throw new Error("host_use_receipt_v1.items must contain 1-96 entries");
  }
  const parsedItems = record.items.map((item) => sdkParseHostUseReceiptItemV1(item));
  const items = canonicalizeItems
    ? [...parsedItems].sort((left, right) => sdkCompareUtf8(left.memory_id, right.memory_id))
    : parsedItems;
  sdkValidateCanonicalReceiptItems(items);
  return {
    contract_version: sdkEnumValue(record.contract_version, ["host_use_receipt_v1"] as const, "contract_version"),
    receipt_id: sdkBoundedString(record.receipt_id, 256, "receipt_id"),
    guide_trace_id: sdkBoundedString(record.guide_trace_id, 256, "guide_trace_id"),
    episode_id: sdkEpisodeId(record.episode_id, "episode_id"),
    operation_id: sdkBoundedString(record.operation_id, 256, "operation_id"),
    run_id: sdkBoundedString(record.run_id, 256, "run_id"),
    host_task_id: sdkBoundedString(record.host_task_id, 256, "host_task_id"),
    host_task_envelope_sha256: sdkDigestSha256(
      record.host_task_envelope_sha256,
      "host_task_envelope_sha256",
    ),
    collector_id: sdkBoundedString(record.collector_id, 256, "collector_id"),
    collector_version: sdkBoundedString(record.collector_version, 120, "collector_version"),
    host_trace_sha256: sdkDigestSha256(record.host_trace_sha256, "host_trace_sha256"),
    observed_at: sdkCanonicalUtcTimestamp(record.observed_at, "observed_at"),
    items,
  };
}

export function hostUseReceiptDigest(value: AionisHostUseReceiptV1Body): string {
  return sdkCanonicalSha256(sdkParseHostUseReceiptV1Body(value, false));
}

export function buildHostUseReceiptV1(value: unknown): AionisHostUseReceiptV1 {
  const body = sdkParseHostUseReceiptV1Body(value, true);
  return {
    ...body,
    receipt_sha256: sdkCanonicalSha256(body),
  };
}

export function parseHostUseReceiptV1(value: unknown): AionisHostUseReceiptV1 {
  const record = sdkContractRecord(value, "host_use_receipt_v1");
  sdkAssertExactFields(record, SDK_HOST_USE_RECEIPT_FIELDS, "host_use_receipt_v1");
  const { receipt_sha256: rawReceiptSha256, ...rawBody } = record;
  const body = sdkParseHostUseReceiptV1Body(rawBody, false);
  const receiptSha256 = sdkDigestSha256(rawReceiptSha256, "receipt_sha256");
  if (receiptSha256 !== sdkCanonicalSha256(body)) {
    throw new Error("Host-use receipt digest does not match its canonical body");
  }
  return { ...body, receipt_sha256: receiptSha256 };
}

function sdkLearningEpisodeId(tenantId: unknown, scope: unknown, guideTraceId: string): string {
  return `lep_${sdkCanonicalSha256({
    tenant_id: sdkBoundedString(tenantId, 256, "guide.tenant_id"),
    scope: sdkBoundedString(scope, 256, "guide.scope"),
    guide_trace_id: sdkBoundedString(guideTraceId, 256, "guide.guide_trace_id"),
  })}`;
}

function sdkLearningExposureEventId(tenantId: unknown, scope: unknown, guideTraceId: string): string {
  return `lexposure_${sdkCanonicalSha256({
    tenant_id: sdkBoundedString(tenantId, 256, "guide.tenant_id"),
    scope: sdkBoundedString(scope, 256, "guide.scope"),
    guide_trace_id: sdkBoundedString(guideTraceId, 256, "guide.guide_trace_id"),
  })}`;
}

export function feedbackAttributionFromGuide(guide: unknown): AionisGuideFeedbackAttributionV1 {
  const record = asRecord(guide);
  if (record?.feedback_attribution_v1 === undefined) {
    throw new AionisGuideFeedbackError(
      "guide_feedback_attribution_missing",
      "guide response has no feedback_attribution_v1; request a new guide from a compatible Runtime",
    );
  }
  try {
    const attribution = parseGuideFeedbackAttributionV1(record.feedback_attribution_v1);
    const guideTraceId = sdkBoundedString(record.guide_trace_id, 256, "guide.guide_trace_id");
    if (attribution.guide_trace_id !== guideTraceId) {
      throw new Error("feedback_attribution_v1 guide_trace_id does not match the guide");
    }
    if (attribution.status === "available") {
      const expectedEpisodeId = sdkLearningEpisodeId(record.tenant_id, record.scope, guideTraceId);
      const expectedEventId = sdkLearningExposureEventId(record.tenant_id, record.scope, guideTraceId);
      if (attribution.episode_id !== expectedEpisodeId) {
        throw new Error("feedback_attribution_v1 episode_id does not match the guide identity");
      }
      if (attribution.exposure_event_id !== expectedEventId) {
        throw new Error("feedback_attribution_v1 exposure_event_id does not match the guide identity");
      }
    }
    return attribution;
  } catch (error) {
    throw new AionisGuideFeedbackError(
      "guide_feedback_attribution_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function sdkFormalFeedbackMemoryIds(inputMemoryIds: readonly string[], receiptMemoryIds: readonly string[]): string[] {
  const normalized = inputMemoryIds.map((memoryId) => sdkBoundedString(memoryId, 256, "used_memory_ids[]"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Formal host-use feedback does not allow duplicate used_memory_ids");
  }
  const sorted = [...normalized].sort(sdkCompareUtf8);
  if (
    sorted.length !== receiptMemoryIds.length
    || sorted.some((memoryId, index) => memoryId !== receiptMemoryIds[index])
  ) {
    throw new Error("used_memory_ids must exactly match the canonical host-use receipt item set");
  }
  return [...receiptMemoryIds];
}

function sdkResolveExactFeedbackSurface(
  guide: unknown,
  memoryIds: readonly string[],
  requestedSurface: AionisFeedbackUsedSurface | undefined,
): AionisHostUseReceiptSurface {
  const attribution = feedbackAttributionFromGuide(guide);
  if (attribution.status !== "available") {
    throw new AionisGuideFeedbackError(
      "guide_feedback_attribution_unavailable",
      `Runtime did not persist a learning exposure for this guide (${attribution.reason_code})`,
    );
  }
  const attributable = new Map(attribution.items.map((item) => [item.memory_id, item.served_surface]));
  const missing = memoryIds.filter((memoryId) => !attributable.has(memoryId));
  if (missing.length > 0) {
    let visible = new Set<string>();
    try {
      visible = new Set(memoryIdsFromGuide(guide));
    } catch {
      // Agent context is diagnostic only. Missing or malformed context must not
      // replace the stable attribution error or become an authorization source.
    }
    const contextOnly = missing.filter((memoryId) => visible.has(memoryId));
    if (contextOnly.length === missing.length) {
      throw new AionisGuideFeedbackError(
        "guide_feedback_context_only_memory",
        `memory ids are visible only in agent context, not in the persisted learning exposure: ${contextOnly.join(", ")}`,
      );
    }
    throw new AionisGuideFeedbackError(
      "guide_feedback_unknown_memory",
      `memory ids are not attributable by the persisted guide exposure: ${missing.join(", ")}`,
    );
  }
  const surfaces = new Set(memoryIds.map((memoryId) => attributable.get(memoryId)!));
  if (surfaces.size !== 1) {
    throw new AionisGuideFeedbackError(
      "guide_feedback_mixed_served_surfaces",
      "one feedback request may reference only one persisted served surface",
    );
  }
  const servedSurface = [...surfaces][0]!;
  if (servedSurface === "rehydrate") {
    throw new AionisGuideFeedbackError(
      "guide_feedback_rehydrate_not_feedbackable",
      "rehydrate the memory and request a new guide before submitting use feedback",
    );
  }
  if (requestedSurface === "explicit_host_assertion") {
    throw new AionisGuideFeedbackError(
      "guide_feedback_explicit_assertion_not_exact",
      "feedbackFromGuide accepts only the exact served surface signed by the guide",
    );
  }
  if (requestedSurface !== undefined && requestedSurface !== servedSurface) {
    throw new AionisGuideFeedbackError(
      "guide_feedback_served_surface_mismatch",
      `requested surface ${requestedSurface} does not match persisted served surface ${servedSurface}`,
    );
  }
  return servedSurface;
}

export function feedbackFromGuide(input: AionisFeedbackFromGuideInput): AionisFeedbackRequest {
  const guide = asRecord(input.guide);
  const guideTraceId = guide?.guide_trace_id;
  if (typeof guideTraceId !== "string" || guideTraceId.length === 0) {
    throw new Error("feedbackFromGuide requires guide.guide_trace_id");
  }
  if (input.used_memory_ids.length === 0) {
    throw new Error("feedbackFromGuide requires at least one host-used memory id");
  }
  if (input.host_use_receipt_v1) {
    const receipt = parseHostUseReceiptV1(input.host_use_receipt_v1);
    const formalGuideTraceId = sdkBoundedString(guideTraceId, 256, "guide.guide_trace_id");
    const runId = sdkBoundedString(input.run_id, 256, "feedbackFromGuide run_id");
    const operationId = sdkBoundedString(
      input.operation_id,
      256,
      "feedbackFromGuide operation_id for host_use_receipt_v1",
    );
    if (operationId !== receipt.operation_id) {
      throw new Error("feedbackFromGuide operation_id must match host_use_receipt_v1.operation_id");
    }
    if (formalGuideTraceId !== receipt.guide_trace_id) {
      throw new Error("feedbackFromGuide guide_trace_id must match host_use_receipt_v1.guide_trace_id");
    }
    if (runId !== receipt.run_id) {
      throw new Error("feedbackFromGuide run_id must match host_use_receipt_v1.run_id");
    }
    const expectedEpisodeId = sdkLearningEpisodeId(guide?.tenant_id, guide?.scope, formalGuideTraceId);
    if (receipt.episode_id !== expectedEpisodeId) {
      throw new Error("feedbackFromGuide host_use_receipt_v1.episode_id does not match the guide identity");
    }
    const outcomes = new Set(receipt.items.map((item) => item.outcome));
    const surfaces = new Set(receipt.items.map((item) => item.used_surface));
    if (outcomes.size !== 1 || surfaces.size !== 1) {
      throw new Error("Formal feedback requires homogeneous receipt outcome and used_surface values");
    }
    const receiptOutcome = receipt.items[0]!.outcome;
    const receiptSurface = receipt.items[0]!.used_surface;
    if (input.outcome !== receiptOutcome) {
      throw new Error("feedbackFromGuide outcome must match the homogeneous host-use receipt outcome");
    }
    if (input.used_surface !== undefined && input.used_surface !== receiptSurface) {
      throw new Error("feedbackFromGuide used_surface must match the homogeneous host-use receipt used_surface");
    }
    if (input.verifier_status !== undefined && input.verifier_status !== "passed") {
      throw new Error("feedbackFromGuide host_use_receipt_v1 requires verifier_status passed");
    }
    const receiptMemoryIds = receipt.items.map((item) => item.memory_id);
    const usedMemoryIds = sdkFormalFeedbackMemoryIds(input.used_memory_ids, receiptMemoryIds);
    sdkResolveExactFeedbackSurface(input.guide, usedMemoryIds, receiptSurface);
    return stripUndefined({
      operation_id: operationId,
      host_use_receipt_v1: receipt,
      reason: input.reason,
      run_id: receipt.run_id,
      outcome: receiptOutcome,
      used_surface: receiptSurface,
      actor: input.actor ?? actorFromGuide(input.guide),
      guide_trace_id: receipt.guide_trace_id,
      used_memory_ids: usedMemoryIds,
      verifier_status: "passed",
      tool_status: input.tool_status,
      runtime_signal_refs: input.runtime_signal_refs,
    }) as AionisFeedbackRequest;
  }
  const usedMemoryIds = input.used_memory_ids.map((memoryId) =>
    sdkBoundedString(memoryId, 256, "feedbackFromGuide used_memory_ids[]")
  );
  if (new Set(usedMemoryIds).size !== usedMemoryIds.length) {
    throw new AionisGuideFeedbackError(
      "guide_feedback_duplicate_memory",
      "feedbackFromGuide does not allow duplicate used_memory_ids",
    );
  }
  usedMemoryIds.sort(sdkCompareUtf8);
  const usedSurface = sdkResolveExactFeedbackSurface(input.guide, usedMemoryIds, input.used_surface);
  if (input.outcome !== "neutral" && usedSurface !== "use_now") {
    throw new AionisGuideFeedbackError(
      "guide_feedback_host_receipt_required",
      `non-neutral ${usedSurface} feedback requires a verified host-use receipt`,
    );
  }
  return stripUndefined({
    operation_id: input.operation_id === undefined
      ? undefined
      : sdkBoundedString(input.operation_id, 256, "feedbackFromGuide operation_id"),
    reason: input.reason,
    run_id: input.run_id,
    outcome: input.outcome,
    used_surface: usedSurface,
    actor: input.actor ?? actorFromGuide(input.guide),
    guide_trace_id: guideTraceId,
    used_memory_ids: usedMemoryIds,
    verifier_status: input.verifier_status,
    tool_status: input.tool_status,
    runtime_signal_refs: input.runtime_signal_refs,
  }) as AionisFeedbackRequest;
}

// </aionis-runtime-owned:host-receipt-helpers>
