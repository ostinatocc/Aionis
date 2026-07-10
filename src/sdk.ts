// Canonical Aionis TypeScript SDK source.
// Sync this file to the standalone @aionis/sdk package with `npm run sdk:sync`.

export type AionisJsonObject = Record<string, unknown>;

export type AionisGuideMode = "standard" | "full_power";
export type AionisGuideContextMode = AionisGuideMode | "compact_agent";
export type AionisTaskContextProfile =
  | "general"
  | "coding_verifier"
  | "document_integrity"
  | "long_qa"
  | "multi_agent_handoff"
  | "loop_engineering";
export type AionisFeedbackOutcome = "positive" | "negative" | "neutral";
export type AionisFeedbackUsedSurface = "use_now" | "inspect_before_use" | "do_not_use" | "explicit_host_assertion";
export type AionisFeedbackStatus = "passed" | "failed" | "not_run" | "unknown";
export type AionisToolStatus = "succeeded" | "failed" | "not_run" | "unknown";
export type AionisRehydrateMode = "summary_only" | "partial" | "full" | "differential";
export type AionisForgetTarget = "pattern" | "archive" | "payload" | "memory";
export type AionisMemoryLane = "private" | "shared";
export type AionisRememberKind = "fact" | "preference" | "project_context" | "procedure" | "event" | "evidence";
export type AionisRememberLifecycleState = "active" | "candidate" | "contested" | "suppressed" | "demoted" | "archived";
export type AionisRememberTier = "hot" | "warm" | "cold" | "archive";
export type AionisExecutionAgentRole = "agent" | "planner" | "worker" | "verifier" | "reviewer";
export type AionisExecutionOutcomeStatus = "succeeded" | "failed" | "blocked" | "interrupted" | "unknown";
export type AionisHandoffKind = "patch_handoff" | "review_handoff" | "task_handoff";
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

export type AionisRouteContractSource = "target_files" | "should_continue" | "inspect_first" | "must_not";
export type AionisRouteContractTarget = {
  target: string;
  source_memory_id?: string;
  source: AionisRouteContractSource;
  reason?: string;
};
export type AionisRouteContractActiveTarget = AionisRouteContractTarget & {
  artifact_status: "unknown" | "may_be_absent";
  missing_policy: "restore_or_create_if_task_consistent_or_rehydrate";
};
export type AionisRouteContractMissingActiveAction = "create" | "restore" | "rehydrate" | "report_conflict";
export type AionisRouteContractPendingArtifact = AionisRouteContractTarget & {
  status: "unknown_until_host_observation";
  when: "if_active_target_is_missing";
  allowed_actions: AionisRouteContractMissingActiveAction[];
  preferred_action_order: AionisRouteContractMissingActiveAction[];
  terminal_inspect_allowed: false;
  executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate";
  after_rehydrate_policy: "continue_allowed_action_if_task_consistent";
  report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict";
};
export type AionisRouteContractEvidenceSource = AionisRouteContractTarget & {
  evidence_use: "reference_only";
  direction_policy: "must_not_be_primary_route";
};
export type AionisRouteContractBlockedRoute = AionisRouteContractTarget & {
  direction_policy: "blocked_route";
  evidence_use: "counter_evidence_only";
};
export type AionisRouteContractActionPolicy = {
  missing_active_target_preferred_order: AionisRouteContractMissingActiveAction[];
  terminal_inspect_allowed: false;
  reference_fallback_requires: "explicit_raw_evidence_or_operator_confirmation";
  executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate";
  after_rehydrate_policy: "continue_allowed_action_if_task_consistent";
  report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict";
};
export type AionisRouteContract = {
  active_targets: AionisRouteContractActiveTarget[];
  pending_artifacts: AionisRouteContractPendingArtifact[];
  reference_only_targets: AionisRouteContractTarget[];
  blocked_direction_targets: AionisRouteContractTarget[];
  evidence_sources: AionisRouteContractEvidenceSource[];
  blocked_routes: AionisRouteContractBlockedRoute[];
  conflict_policy: "do_not_treat_missing_active_target_as_superseded";
  fallback_policy: "do_not_promote_reference_or_blocked_targets";
  action_policy: AionisRouteContractActionPolicy;
};

export type AionisRehydrateHint = {
  memory_id: string;
  reason?: string;
  required: boolean;
};

export type AionisMemoryDecisionSummary = {
  memory_id: string;
  agent_surface: "use_now" | "inspect_before_use" | "do_not_use" | "rehydrate" | "not_agent_facing";
  decision_kind: "used" | "downgraded" | "blocked" | "rehydrate" | "not_agent_facing";
  actionable: boolean;
  reason_codes: string[];
};

export type AionisMemoryUseReceipt = {
  contract_version: "aionis_memory_use_receipt_v1";
  intended_use: "memory_use_audit";
  agent_prompt_included: false;
  runtime_mutation: false;
  guide_trace_id: string | null;
  history_used: boolean;
  actionable_history_used: boolean;
  prompt_char_count: number;
  exposed_memory_ids: string[];
  use_now_memory_ids: string[];
  inspect_before_use_memory_ids: string[];
  do_not_use_memory_ids: string[];
  rehydrate_memory_ids: string[];
  attributed_memory_ids: string[];
  unattributed_recalled_memory_ids: string[];
  read_only_signal_memory_ids: string[];
  decision_summaries: AionisMemoryDecisionSummary[];
  risk_flags: string[];
  summary: string;
};

export type AionisMemoryAdmissionRecordEntry = {
  memory_id: string;
  title: string | null;
  memory_origin?: "aionis" | "external";
  source_backend?: string;
  domain: "general" | "execution";
  memory_type:
    | "fact"
    | "preference"
    | "project_context"
    | "procedure"
    | "event"
    | "evidence"
    | "rule"
    | "execution_memory"
    | "unknown";
  lifecycle_state:
    | "active"
    | "candidate"
    | "contested"
    | "suppressed"
    | "demoted"
    | "archived"
    | "rehydration_candidate"
    | "unknown";
  authority: "none" | "advisory" | "trusted" | "blocked";
  admission_action: "use_now" | "inspect_before_use" | "do_not_use" | "rehydrate" | "not_agent_facing";
  decision_kind: "used" | "downgraded" | "blocked" | "rehydrate" | "not_agent_facing";
  actionable: boolean;
  prompt_included: boolean;
  agent_used: boolean;
  feedback_outcome: AionisFeedbackOutcome | null;
  attribution_strength:
    | "none"
    | "observed_feedback_only"
    | "positive_attribution"
    | "weak_below_threshold"
    | "repeated_weak_threshold_met"
    | "strong_signal_threshold_met"
    | null;
  reason_codes: string[];
  evidence_ids: string[];
};

export type AionisMemoryAdmissionRecord = {
  contract_version: "aionis_memory_admission_record_v1";
  intended_use: "memory_admission_audit_dataset";
  source: "memory_decision_trace" | "external_candidate_admission";
  agent_prompt_included: false;
  runtime_mutation: false;
  tenant_id: string;
  scope: string;
  guide_trace_id: string | null;
  prompt_char_count: number;
  history_used: boolean;
  actionable_history_used: boolean;
  candidate_memory_count: number;
  prompt_included_memory_count: number;
  agent_used_memory_count: number;
  entries: AionisMemoryAdmissionRecordEntry[];
  shadow_policy_report?: AionisMemoryAdmissionShadowPolicyReport;
  summary: string;
};

export type AionisExternalMemoryAuthority = {
  source_trust?: "trusted" | "known" | "untrusted" | "unknown";
  scope?: "user" | "project" | "team" | "org" | "global" | "unknown";
  evidence_requirement?: "none" | "inspect_before_use" | "rehydrate_before_use" | "blocked";
};

export type AionisExternalMemoryLifecycleHint =
  | "current"
  | "procedure"
  | "failed"
  | "stale"
  | "contested"
  | "suppressed"
  | "archived"
  | "unknown";

export type AionisExternalMemoryCandidate = {
  external_memory_id: string;
  source_backend: string;
  text: string;
  metadata?: AionisJsonObject;
  authority?: AionisExternalMemoryAuthority;
  lifecycle_hint?: AionisExternalMemoryLifecycleHint;
  evidence_refs?: string[];
};

export type AionisMemoryAdmissionGatewayMode = "standard" | "strict" | "firewall";

export type AionisMemoryAdmissionRequest = AionisJsonObject & {
  query_text: string;
  run_id?: string;
  mode?: AionisMemoryAdmissionGatewayMode;
  context_mode?: "standard" | "compact_agent";
  candidates: AionisExternalMemoryCandidate[];
  include_records?: boolean;
};

export type AionisMemoryFirewallSummary = {
  contract_version: "aionis_memory_firewall_summary_v1";
  intended_use: "memory_firewall_audit";
  mode: "firewall";
  candidate_count: number;
  direct_use_count: number;
  inspect_count: number;
  blocked_count: number;
  rehydrate_count: number;
  unsafe_candidate_count: number;
  unsafe_direct_use_count: number;
  runtime_mutation: false;
  agent_prompt_included: false;
  risk_flags: string[];
  claims: Array<{
    claim: string;
    status: "pass" | "warn" | "fail";
    evidence: string;
  }>;
  summary: string;
};

export type AionisMemoryAdmissionGatewayResponse = AionisJsonObject & {
  contract_version: "aionis_memory_admission_gateway_result_v1";
  tenant_id: string;
  scope: string;
  run_id: string | null;
  mode: AionisMemoryAdmissionGatewayMode;
  agent_context: AionisJsonObject;
  memory_use_receipt: AionisMemoryUseReceipt;
  memory_admission_records?: AionisMemoryAdmissionRecord;
  memory_firewall?: AionisMemoryFirewallSummary;
  admission_summary: AionisJsonObject;
  source_map: AionisJsonObject;
};

export type AionisMem0SearchResultRow = AionisJsonObject & {
  id?: string;
  memory?: unknown;
  text?: unknown;
  data?: unknown;
  content?: unknown;
  score?: number;
  metadata?: AionisJsonObject;
};

export type AionisMem0SearchResultsInput = {
  results?: AionisMem0SearchResultRow[];
} | AionisMem0SearchResultRow[];

export type AionisMem0CandidateMapperOptions = {
  source_backend?: string;
  id_prefix?: string;
  default_authority?: AionisExternalMemoryAuthority;
  default_lifecycle_hint?: AionisExternalMemoryLifecycleHint;
};

export type AionisGovernMem0SearchResultsInput = AionisJsonObject & {
  query_text: string;
  run_id?: string;
  mode?: AionisMemoryAdmissionGatewayMode;
  context_mode?: "standard" | "compact_agent";
  include_records?: boolean;
  mem0_results: AionisMem0SearchResultsInput;
  mapper?: AionisMem0CandidateMapperOptions;
};

export type AionisAgentFlightRecorderReport = AionisJsonObject & {
  contract_version: "aionis_agent_flight_recorder_report_v1";
  intended_use: "incident_replay_audit";
  agent_prompt_included: false;
  runtime_mutation: false;
  guide_trace_id: string | null;
  run_id: string | null;
  decision_time: string;
  agent_view: AionisJsonObject & {
    prompt_text_included: false;
    exposed_memory_ids: string[];
    use_now_memory_ids: string[];
    inspect_before_use_memory_ids: string[];
    do_not_use_memory_ids: string[];
    rehydrate_memory_ids: string[];
  };
  blocked_or_suppressed: AionisJsonObject[];
  attribution: AionisJsonObject & {
    present: boolean;
    outcome: AionisFeedbackOutcome | null;
    used_memory_ids: string[];
    attributed_memory_ids: string[];
    unattributed_memory_ids: string[];
    supported_memory_ids: string[];
    contradicted_memory_ids: string[];
  };
  replay_sources: AionisJsonObject;
  claims: AionisJsonObject[];
  source_map: AionisJsonObject;
  summary: string;
};

export type AionisAgentFlightRecorderRequest = AionisJsonObject & {
  guide_trace_id?: string;
  run_id?: string;
  product_trace?: AionisJsonObject;
  agent_context?: AionisJsonObject;
  memory_decision_trace?: AionisJsonObject;
  memory_use_receipt?: AionisJsonObject;
  memory_admission_record?: AionisJsonObject;
  operator_snapshot?: AionisJsonObject;
  feedback_result?: AionisJsonObject;
  decision_time?: string;
};

export type AionisAgentFlightRecorderResponse = AionisJsonObject & {
  contract_version: "aionis_agent_flight_recorder_result_v1";
  tenant_id: string;
  scope: string;
  agent_flight_recorder: AionisAgentFlightRecorderReport;
  source_map: AionisJsonObject;
};

export type AionisMemoryAdmissionDatasetOutcomeLabel =
  | "positive_use"
  | "negative_use"
  | "neutral_use"
  | "unused_exposed"
  | "blocked_or_suppressed"
  | "rehydrate_requested"
  | "not_agent_facing"
  | "unknown";

export type AionisMemoryAdmissionClosedLoopEffectState =
  | "no_prior"
  | "supported"
  | "contradicted"
  | "mixed"
  | "rehydrate_requested";

export type AionisMemoryAdmissionShadowPolicyId = "candidate_project_context_closed_loop_inspect";

export type AionisMemoryAdmissionShadowPolicyDecision = {
  memory_id: string;
  title: string | null;
  recorded_action: AionisMemoryAdmissionRecordEntry["admission_action"];
  shadow_action: AionisMemoryAdmissionRecordEntry["admission_action"];
  would_change_action: boolean;
  memory_origin: AionisMemoryAdmissionRecordEntry["memory_origin"];
  source_backend: string;
  memory_type: AionisMemoryAdmissionRecordEntry["memory_type"];
  closed_loop_effect_state: AionisMemoryAdmissionClosedLoopEffectState;
  repeated_negative_posture: boolean;
  prior_state_available: boolean;
  used_fields: string[];
  reason_codes: string[];
};

export type AionisMemoryAdmissionShadowPolicyReport = {
  contract_version: "aionis_memory_admission_shadow_policy_report_v1";
  intended_use: "admission_policy_shadow_audit";
  policy_id: AionisMemoryAdmissionShadowPolicyId;
  policy_version: string;
  mode: "shadow_only";
  source: "memory_admission_record" | "memory_decision_trace" | "external_candidate_admission";
  agent_prompt_included: false;
  runtime_mutation: false;
  hard_boundary_policy: "preserve_recorded_non_use_now";
  decision_count: number;
  changed_count: number;
  would_downgrade_use_now_count: number;
  hard_boundary_upgrade_count: number;
  direct_use_recorded_count: number;
  direct_use_shadow_count: number;
  policy_changed_memory_ids: string[];
  downgraded_memory_ids: string[];
  hard_boundary_preserved_memory_ids: string[];
  decisions: AionisMemoryAdmissionShadowPolicyDecision[];
  summary: string;
};

export type AionisMemoryAdmissionDatasetRow = {
  contract_version: "aionis_memory_admission_dataset_row_v1";
  intended_use: "memory_admission_policy_training_or_audit";
  source: "memory_admission_record";
  agent_prompt_included: false;
  runtime_mutation: false;
  policy_id: string;
  policy_version: string;
  policy_mode: string;
  runtime_version: string | null;
  tenant_id: string | null;
  scope: string | null;
  guide_trace_id: string | null;
  run_id: string | null;
  task_id: string | null;
  task_signature: string | null;
  row_index: number;
  memory_id: string;
  title: string | null;
  memory_origin: AionisMemoryAdmissionRecordEntry["memory_origin"];
  source_backend: string | null;
  domain: AionisMemoryAdmissionRecordEntry["domain"];
  memory_type: AionisMemoryAdmissionRecordEntry["memory_type"];
  lifecycle_state: AionisMemoryAdmissionRecordEntry["lifecycle_state"];
  authority: AionisMemoryAdmissionRecordEntry["authority"];
  admission_action: AionisMemoryAdmissionRecordEntry["admission_action"];
  decision_kind: AionisMemoryAdmissionRecordEntry["decision_kind"];
  actionable: boolean;
  prompt_included: boolean;
  agent_used: boolean;
  feedback_outcome: AionisFeedbackOutcome | null;
  attribution_strength: AionisMemoryAdmissionRecordEntry["attribution_strength"];
  outcome_label: AionisMemoryAdmissionDatasetOutcomeLabel;
  reason_codes: string[];
  evidence_ids: string[];
  prompt_char_count: number;
  history_used: boolean;
  actionable_history_used: boolean;
  prior_supported_use_count: number;
  prior_contradicted_use_count: number;
  prior_rehydrate_requested_count: number;
  closed_loop_effect_state: AionisMemoryAdmissionClosedLoopEffectState;
  repeated_negative_posture: boolean;
};

export type AionisMemoryAdmissionDatasetExportOptions = {
  run_id?: string | null;
  task_id?: string | null;
  task_signature?: string | null;
  policy_id?: string | null;
  policy_version?: string | null;
  policy_mode?: string | null;
  runtime_version?: string | null;
};

export const AIONIS_ADMISSION_POLICY_ID = "AIONIS_ADMISSION_POLICY_V1";
export const AIONIS_ADMISSION_POLICY_VERSION = "2026-06-17";
export const AIONIS_ADMISSION_POLICY_MODE = "deterministic_admission";

export type AionisExecutionContextBudgetProfile = "compact" | "balanced" | "high_recall";
export type AionisAgentPromptFormat = "contract" | "runtime_compact";

export type AionisExecutionFilePresence = {
  target: string;
  exists: boolean;
  reason?: string;
};

export type AionisExecutionRepoState = {
  existing_files?: string[];
  missing_files?: string[];
  files?: AionisExecutionFilePresence[];
};

export type AionisAgentPromptTaskInput = {
  task_id?: string;
  run_id?: string;
  task_signature?: string;
  query_text?: string;
  goal?: string;
};

export type AionisExecutionContextTask = AionisAgentPromptTaskInput;

export type AionisGuideExecutionContextInput = AionisJsonObject & {
  task_id?: string;
  task_signature?: string;
  task_family?: string;
  workflow_signature?: string;
};

export type AionisExecutionAgentContextCompileInput = {
  guide: unknown;
  task?: string | AionisAgentPromptTaskInput;
  repo_state?: AionisExecutionRepoState;
  budget_profile?: AionisExecutionContextBudgetProfile;
  max_prompt_chars?: number;
  prompt_format?: AionisAgentPromptFormat;
  additional_instructions?: string[];
};

export type AionisExecutionContextWarning = {
  code:
    | "missing_active_target"
    | "blocked_route_present"
    | "reference_only_target_present"
    | "rehydrate_recommended";
  message: string;
  targets?: string[];
  memory_ids?: string[];
};

export type AionisCompiledExecutionAgentContext = {
  contract_version: "aionis_execution_agent_context_v1";
  prompt_format: AionisAgentPromptFormat;
  budget_profile: AionisExecutionContextBudgetProfile;
  agent_prompt: string;
  base_prompt: string;
  prompt_char_count: number;
  route_contract: AionisRouteContract | null;
  command_posture: AionisCommandPosture[];
  memory_use_receipt: AionisMemoryUseReceipt;
  memory_admission_record: AionisMemoryAdmissionRecord;
  rehydrate_requests: AionisRehydrateHint[];
  use_now_memory_ids: string[];
  inspect_before_use_memory_ids: string[];
  do_not_use_memory_ids: string[];
  active_targets: string[];
  missing_active_targets: string[];
  pending_artifacts: string[];
  reference_only_targets: string[];
  blocked_direction_targets: string[];
  execution_warnings: AionisExecutionContextWarning[];
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
  task?: AionisExecutionAgentContextCompileInput["task"];
  repo_state?: AionisExecutionAgentContextCompileInput["repo_state"];
  budget_profile?: AionisExecutionContextBudgetProfile;
  max_prompt_chars?: number;
  prompt_format?: AionisAgentPromptFormat;
  include_resolved_evidence_in_prompt?: boolean;
  evidence_limit?: number;
  evidence_char_budget?: number;
  include_inspect_before_use?: boolean;
  include_rehydrate?: boolean;
  resolve_types?: AionisMemoryResolveType[];
  on_resolve_error?: "include_placeholder" | "skip" | "throw";
  additional_instructions?: string[];
};

export type AionisGuideAgentContextResult<TGuide = unknown> = {
  contract_version: "aionis_sdk_agent_context_with_evidence_v1";
  guide: TGuide;
  compiled_context: AionisCompiledExecutionAgentContext;
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
  default_guide_mode?: AionisGuideMode | null;
  fetchImpl?: typeof fetch;
};

export type AionisRequestOptions = {
  tenant_id?: string;
  scope?: string;
  headers?: Record<string, string>;
};

export type AionisGuideRequestOptions = AionisRequestOptions & {
  guide_mode?: AionisGuideMode | null;
};

export type AionisGuideRequest = AionisJsonObject & {
  query_text: string;
  mode?: AionisGuideMode;
  context_mode?: AionisGuideContextMode;
  task_context_profile?: AionisTaskContextProfile;
  agent_role?: AionisExecutionAgentRole;
  run_id?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  context_char_budget?: number;
  context_compaction_profile?: "balanced" | "aggressive";
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

export type AionisFeedbackRequest = AionisJsonObject & {
  reason: string;
  run_id: string;
  outcome: AionisFeedbackOutcome;
  used_surface: AionisFeedbackUsedSurface;
  actor?: string;
  guide_trace_id?: string;
  used_memory_ids?: string[];
  memory_ids?: string[];
  node_ids?: string[];
  verifier_status?: AionisFeedbackStatus;
  tool_status?: AionisToolStatus;
  runtime_signal_refs?: string[];
  target?: "memory";
};

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

export type AionisTrainingCandidateLabel =
  | "positive"
  | "negative"
  | "neutral"
  | "blocked"
  | "insufficient_evidence";

export type AionisTrainingCandidateType =
  | "handoff_distillation"
  | "transfer_judge"
  | "workflow_selector"
  | "forgetting_suppression"
  | "authority_judgment"
  | "trace_derived_skill";

export type AionisTraceDerivedSkillCandidate = {
  contract_version: "aionis_trace_derived_skill_candidate_v1";
  skill_name: string;
  source_trace_ids: string[];
  source_signal_ids: string[];
  applies_when: string[];
  does_not_apply_when: string[];
  procedure_steps: string[];
  target_files: string[];
  acceptance_checks: string[];
  failure_counterexamples: string[];
  evidence_refs: string[];
  authority_state: "candidate";
  promotion_status: "candidate_only" | "needs_feedback_attribution" | "promotion_ready";
  export_policy: {
    agent_prompt_included: false;
    runtime_mutation: false;
    required_gate: "admission_and_promotion_gate";
  };
};

export type AionisGenericTrainingCandidate = {
  candidate_type: Exclude<AionisTrainingCandidateType, "trace_derived_skill">;
  source_ids: string[];
  label: AionisTrainingCandidateLabel;
  export_ready: boolean;
  reason: string;
};

export type AionisTraceDerivedSkillTrainingCandidate = {
  candidate_type: "trace_derived_skill";
  source_ids: string[];
  label: AionisTrainingCandidateLabel;
  export_ready: boolean;
  reason: string;
  trace_derived_skill: AionisTraceDerivedSkillCandidate;
};

export type AionisTrainingCandidate =
  | AionisGenericTrainingCandidate
  | AionisTraceDerivedSkillTrainingCandidate;

export type AionisTraceDerivedSkillReviewItem = {
  candidate_type: "trace_derived_skill";
  review_action: "review_for_promotion";
  skill_name: string;
  label: AionisTrainingCandidateLabel;
  export_ready: boolean;
  promotion_status: AionisTraceDerivedSkillCandidate["promotion_status"];
  reason: string;
  source_ids: string[];
  source_trace_ids: string[];
  source_signal_ids: string[];
  applies_when: string[];
  does_not_apply_when: string[];
  procedure_steps: string[];
  target_files: string[];
  acceptance_checks: string[];
  failure_counterexamples: string[];
  evidence_refs: string[];
  safety: {
    authority_state: "candidate";
    agent_prompt_included: false;
    runtime_mutation: false;
    required_gate: "admission_and_promotion_gate";
  };
  candidate: AionisTraceDerivedSkillTrainingCandidate;
};

export type AionisProcedureMemoryDraftV1 = {
  contract_version: "aionis_procedure_memory_draft_v1";
  source_candidate_id: string;
  source: "trace_derived_skill";
  memory_kind: "procedure";
  authority_state: "reviewed_candidate";
  skill_name: string;
  title: string;
  summary: string;
  source_trace_ids: string[];
  source_signal_ids: string[];
  applies_when: string[];
  does_not_apply_when: string[];
  procedure_steps: string[];
  target_files: string[];
  acceptance_checks: string[];
  failure_counterexamples: string[];
  evidence_refs: string[];
  review: {
    review_status: "promoted";
    reviewer_id: string | null;
    review_reason: string | null;
    reviewed_at: string | null;
    candidate_reason: string;
    label: AionisTrainingCandidateLabel;
    promotion_status: "promotion_ready";
    export_ready: true;
  };
  write_policy: {
    requires_observe_commit: true;
    agent_prompt_included: false;
    runtime_mutation: false;
    required_gate: "observe_commit_and_admission_gate";
  };
};

export type AionisSkillCandidateMaterializeResult = AionisJsonObject & {
  contract_version: "aionis_skill_candidate_materialize_result_v1";
  tenant_id: string;
  scope: string;
  candidate_id: string;
  draft: AionisProcedureMemoryDraftV1;
  recommended_observe_payload: AionisJsonObject;
  safety: {
    agent_prompt_included: false;
    memory_runtime_mutation: false;
    requires_observe_commit: true;
    required_gate: "observe_commit_and_admission_gate";
  };
};

export type AionisEffectReport = AionisJsonObject & {
  contract_version: "aionis_effect_report_v1";
  tenant_id: string;
  scope: string;
  task: {
    task_id?: string | null;
    run_id?: string | null;
    task_signature?: string | null;
    task_family?: string | null;
  };
  comparison: {
    mode: "baseline_vs_aionis" | "observe_only_vs_active" | "single_run_history_impact";
    baseline_run_id?: string | null;
    aionis_run_id?: string | null;
    sufficient_evidence: boolean;
  };
  history_impact: {
    changed_future_behavior: boolean;
    impact_direction: "positive" | "negative" | "neutral" | "insufficient_evidence";
    changed_fields: string[];
    explanation: string;
  };
  training_candidates: AionisTrainingCandidate[];
  evidence: {
    evidence_ids: string[];
    replay_run_ids: string[];
    signal_summary_ids: string[];
    promotion_quality_summary_ids: string[];
  };
};

export type AionisMeasureResult = AionisJsonObject & {
  contract_version: "aionis_measure_result_v1";
  tenant_id: string;
  scope: string;
  measurement_input: {
    source: string;
    baseline: AionisJsonObject;
    aionis: AionisJsonObject;
  };
  effect_report: AionisEffectReport;
  memory_decision_trace?: AionisJsonObject;
  memory_decision_audit?: AionisJsonObject;
  kernel_report?: AionisJsonObject;
  source_map: AionisJsonObject;
};

export type AionisFeedbackFromGuideInput = {
  guide: unknown;
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

export type AionisMeasureFromGuideLoopInput = {
  task: AionisProductTask;
  after_guide: unknown;
  before_guide?: unknown;
  feedback_result?: unknown;
  sufficient_evidence?: boolean;
  evidence_ids?: string[];
  tenant_id?: string;
  scope?: string;
  product_trace?: AionisJsonObject;
};

export type AionisSnapshotFromGuideLoopInput = {
  run_id: string;
  task_signature: string;
  task_family?: string;
  guide: unknown;
  measure_result: unknown;
  include_markdown?: boolean;
  tenant_id?: string;
  scope?: string;
  extra?: AionisJsonObject;
};

export type AionisExecutionRunRef = {
  run_id: string;
  task_id?: string;
  task_signature: string;
  task_family?: string;
  workflow_signature?: string;
};

export type AionisExecutionAgentRef = {
  agent_id?: string;
  team_id?: string;
  role?: AionisExecutionAgentRole;
};

export type AionisExecutionBaseInput = AionisExecutionRunRef & AionisExecutionAgentRef & {
  tenant_id?: string;
  scope?: string;
  memory_lane?: AionisMemoryLane;
  auto_embed?: boolean;
};

export type AionisExecutionStepInput = AionisExecutionBaseInput & {
  title: string;
  summary: string;
  outcome?: AionisExecutionOutcomeStatus;
  target_files?: string[];
  workflow_steps?: string[];
  tool_set?: string[];
  acceptance_checks?: string[];
  continuation_hint?: string;
  resume_hint?: string;
  reuse_hint?: string;
  salience?: number;
  importance?: number;
  confidence?: number;
  raw_ref?: string;
  evidence_ref?: string;
  evidence?: AionisJsonObject[];
  artifacts?: AionisJsonObject[];
  verification?: AionisJsonObject;
  slots?: AionisJsonObject;
  input_text?: string;
  execution?: AionisJsonObject;
};

export type AionisPlanAssetDecision = {
  decision_id: string;
  statement: string;
  rationale?: string;
  alternatives_rejected?: string[];
  target_files?: string[];
};

export type AionisPlanAssetFailedBranch = {
  branch_id: string;
  statement: string;
  reason: string;
  target_files?: string[];
};

export type AionisPlanAsset = {
  plan_id?: string;
  title: string;
  summary: string;
  artifact_ref?: string;
  decisions: AionisPlanAssetDecision[];
  acceptance_checks: string[];
  execution_boundaries: string[];
  failed_branches?: AionisPlanAssetFailedBranch[];
};

export type AionisPlanAssetPlanner = {
  agent_id: string;
  team_id?: string;
  model?: string;
};

export type AionisPlanAssetObserveInput = AionisExecutionRunRef & {
  tenant_id?: string;
  scope?: string;
  memory_lane?: AionisMemoryLane;
  auto_embed?: boolean;
  planner: AionisPlanAssetPlanner;
  plan: AionisPlanAsset;
};

export type AionisExecutionHandoffInput = AionisExecutionStepInput & {
  handoff_kind?: AionisHandoffKind;
  anchor?: string;
  file_path?: string;
  repo_root?: string;
  symbol?: string;
  handoff_text?: string;
  risk?: string;
  tags?: string[];
  next_action?: string;
  must_change?: string[];
  must_remove?: string[];
  must_keep?: string[];
  execution_state_v1?: AionisJsonObject;
  execution_packet_v1?: AionisJsonObject;
  control_profile_v1?: AionisJsonObject;
  execution_transitions_v1?: unknown[];
  execution_tree_disabled?: boolean;
  execution_tree_default_disabled?: boolean;
  execution_tree_v1?: AionisJsonObject;
  execution_tree_operations_v1?: unknown[];
  trajectory?: AionisJsonObject;
  trajectory_hints?: AionisJsonObject;
  handoff?: AionisJsonObject;
};

export type AionisExecutionGuideForRoleInput = AionisExecutionRunRef & AionisExecutionAgentRef & {
  tenant_id?: string;
  scope?: string;
  query_text: string;
  context?: AionisGuideExecutionContextInput;
  execution_tree_v1?: AionisJsonObject | null;
  tool_candidates?: string[];
  limit?: number;
  include_packets?: boolean;
  mode?: AionisGuideMode;
  context_mode?: AionisGuideContextMode;
  task_context_profile?: AionisTaskContextProfile;
  context_char_budget?: number;
  context_token_budget?: number;
  context_compaction_profile?: "balanced" | "aggressive";
  context_optimization_profile?: "balanced" | "aggressive";
  guide?: AionisJsonObject;
};

export type AionisExecutionOutcomeInput = AionisExecutionStepInput & {
  guide?: unknown;
  guide_trace_id?: string;
  used_memory_ids?: string[];
  feedback?: boolean;
  feedback_outcome?: AionisFeedbackOutcome;
  used_surface?: AionisFeedbackUsedSurface;
  verifier_status?: AionisFeedbackStatus;
  tool_status?: AionisToolStatus;
  runtime_signal_refs?: string[];
  feedback_reason?: string;
};

export type AionisExecutionMeasureRunInput = AionisExecutionRunRef & {
  tenant_id?: string;
  scope?: string;
  before_guide?: unknown;
  after_guide: unknown;
  feedback_result?: unknown;
  sufficient_evidence?: boolean;
  evidence_ids?: string[];
  product_trace?: AionisJsonObject;
};

export type AionisExecutionSnapshotRunInput = AionisExecutionRunRef & {
  tenant_id?: string;
  scope?: string;
  guide: unknown;
  measure_result: unknown;
  include_markdown?: boolean;
  extra?: AionisJsonObject;
};

export type AionisExecutionOutcomeResult<TObserve = unknown, TFeedback = unknown> = {
  observe: TObserve;
  feedback: TFeedback | null;
};

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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function coerceString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function stableTextHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return stringArray(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return stringArray(parsed);
    } catch {
      return trimmed.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [];
}

function mem0Rows(input: AionisMem0SearchResultsInput): AionisMem0SearchResultRow[] {
  if (Array.isArray(input)) return input;
  const results = asRecord(input)?.results;
  return Array.isArray(results) ? results.filter((entry): entry is AionisMem0SearchResultRow => Boolean(asRecord(entry))) : [];
}

function mem0RowText(row: AionisMem0SearchResultRow): string {
  for (const key of ["memory", "text", "data", "content"] as const) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (value !== undefined && value !== null && typeof value === "object") return JSON.stringify(value);
  }
  return JSON.stringify(row);
}

function externalMemoryAuthorityFromMetadata(
  metadata: Record<string, unknown>,
  fallback?: AionisExternalMemoryAuthority,
): AionisExternalMemoryAuthority {
  const embedded = asRecord(metadata.authority);
  const sourceTrust = metadata.authority_source_trust ?? metadata.source_trust ?? embedded?.source_trust ?? fallback?.source_trust;
  const scope = metadata.authority_scope ?? metadata.scope ?? embedded?.scope ?? fallback?.scope;
  const evidence = metadata.authority_evidence_requirement
    ?? metadata.evidence_requirement
    ?? embedded?.evidence_requirement
    ?? fallback?.evidence_requirement;
  return {
    source_trust: sourceTrust === "trusted" || sourceTrust === "known" || sourceTrust === "untrusted" || sourceTrust === "unknown"
      ? sourceTrust
      : "unknown",
    scope: scope === "user" || scope === "project" || scope === "team" || scope === "org" || scope === "global" || scope === "unknown"
      ? scope
      : "unknown",
    evidence_requirement: evidence === "none"
      || evidence === "inspect_before_use"
      || evidence === "rehydrate_before_use"
      || evidence === "blocked"
      ? evidence
      : "inspect_before_use",
  };
}

function externalMemoryLifecycleFromMetadata(
  metadata: Record<string, unknown>,
  fallback?: AionisExternalMemoryLifecycleHint,
): AionisExternalMemoryLifecycleHint {
  const value = metadata.lifecycle_hint ?? metadata.lifecycle_state ?? metadata.status ?? fallback;
  return value === "current"
    || value === "procedure"
    || value === "failed"
    || value === "stale"
    || value === "contested"
    || value === "suppressed"
    || value === "archived"
    || value === "unknown"
    ? value
    : "unknown";
}

function mem0ExternalMemoryId(row: AionisMem0SearchResultRow, metadata: Record<string, unknown>, index: number, prefix: string): string {
  const explicit = coerceString(metadata.external_memory_id)
    ?? coerceString(metadata.memory_id)
    ?? coerceString(row.id)
    ?? coerceString(metadata.id);
  if (explicit) return explicit.startsWith(`${prefix}:`) || explicit.includes(":") ? explicit : `${prefix}:${explicit}`;
  return `${prefix}:result-${index + 1}-${stableTextHash(mem0RowText(row)).slice(0, 10)}`;
}

export function mem0SearchResultsToAionisCandidates(
  input: AionisMem0SearchResultsInput,
  options: AionisMem0CandidateMapperOptions = {},
): AionisExternalMemoryCandidate[] {
  const sourceBackend = options.source_backend ?? "mem0";
  const idPrefix = options.id_prefix ?? sourceBackend;
  return mem0Rows(input).map((row, index) => {
    const metadata = asRecord(row.metadata) ?? {};
    const text = mem0RowText(row);
    const targetFiles = [
      ...parseStringArray(metadata.target_files),
      ...parseStringArray(metadata.target_files_json),
    ];
    const evidenceRefs = [
      ...parseStringArray(metadata.evidence_refs),
      ...parseStringArray(metadata.evidence_refs_json),
    ];
    return {
      external_memory_id: mem0ExternalMemoryId(row, metadata, index, idPrefix),
      source_backend: sourceBackend,
      text,
      metadata: stripUndefined({
        ...metadata,
        ...(targetFiles.length > 0 ? { target_files: Array.from(new Set(targetFiles)) } : {}),
        ...(typeof row.score === "number" ? { mem0_score: row.score } : {}),
        ...(row.id !== undefined ? { mem0_row_id: row.id } : {}),
      }),
      authority: externalMemoryAuthorityFromMetadata(metadata, options.default_authority),
      lifecycle_hint: externalMemoryLifecycleFromMetadata(metadata, options.default_lifecycle_hint),
      evidence_refs: evidenceRefs,
    };
  });
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

function isRouteContractSource(value: unknown): value is AionisRouteContractSource {
  return value === "target_files"
    || value === "should_continue"
    || value === "inspect_first"
    || value === "must_not";
}

function routeContractTargetArray(value: unknown): AionisRouteContractTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record || typeof record.target !== "string" || record.target.length === 0 || !isRouteContractSource(record.source)) {
      return [];
    }
    const sourceMemoryId = typeof record.source_memory_id === "string" && record.source_memory_id.length > 0
      ? record.source_memory_id
      : undefined;
    const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : undefined;
    return [{
      target: record.target,
      ...(sourceMemoryId ? { source_memory_id: sourceMemoryId } : {}),
      source: record.source,
      ...(reason ? { reason } : {}),
    }];
  });
}

function routeContractActiveTargetArray(value: unknown): AionisRouteContractActiveTarget[] {
  const records = Array.isArray(value) ? value : [];
  return routeContractTargetArray(records).map((entry, index) => {
    const record = asRecord(records[index]);
    return {
      ...entry,
      artifact_status: record?.artifact_status === "may_be_absent" ? "may_be_absent" : "unknown",
      missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
    };
  });
}

function routeContractPendingArtifactArray(value: unknown): AionisRouteContractPendingArtifact[] {
  const records = Array.isArray(value) ? value : [];
  return routeContractTargetArray(records).map((entry, index) => {
    const record = asRecord(records[index]);
    const actions = stringArray(record?.allowed_actions).filter((action): action is AionisRouteContractMissingActiveAction =>
      action === "create" || action === "restore" || action === "rehydrate" || action === "report_conflict"
    );
    const preferred = stringArray(record?.preferred_action_order).filter((action): action is AionisRouteContractMissingActiveAction =>
      action === "create" || action === "restore" || action === "rehydrate" || action === "report_conflict"
    );
    return {
      ...entry,
      status: "unknown_until_host_observation",
      when: "if_active_target_is_missing",
      allowed_actions: actions.length > 0 ? actions : ["create", "restore", "rehydrate", "report_conflict"],
      preferred_action_order: preferred.length > 0 ? preferred : ["create", "restore", "rehydrate", "report_conflict"],
      terminal_inspect_allowed: false,
      executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate",
      after_rehydrate_policy: "continue_allowed_action_if_task_consistent",
      report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict",
    };
  });
}

function routeContractEvidenceSourceArray(value: unknown): AionisRouteContractEvidenceSource[] {
  return routeContractTargetArray(value).map((entry) => ({
    ...entry,
    evidence_use: "reference_only",
    direction_policy: "must_not_be_primary_route",
  }));
}

function routeContractBlockedRouteArray(value: unknown): AionisRouteContractBlockedRoute[] {
  return routeContractTargetArray(value).map((entry) => ({
    ...entry,
    direction_policy: "blocked_route",
    evidence_use: "counter_evidence_only",
  }));
}

function routeContractActionPolicy(value: unknown): AionisRouteContractActionPolicy {
  const record = asRecord(value);
  const preferred = stringArray(record?.missing_active_target_preferred_order).filter((action): action is AionisRouteContractMissingActiveAction =>
    action === "create" || action === "restore" || action === "rehydrate" || action === "report_conflict"
  );
  return {
    missing_active_target_preferred_order: preferred.length > 0 ? preferred : ["create", "restore", "rehydrate", "report_conflict"],
    terminal_inspect_allowed: false,
    reference_fallback_requires: "explicit_raw_evidence_or_operator_confirmation",
    executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate",
    after_rehydrate_policy: "continue_allowed_action_if_task_consistent",
    report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict",
  };
}

function routeContractMemoryIds(value: unknown): string[] {
  const contract = asRecord(value);
  if (!contract) return [];
  const rows = [
    ...routeContractTargetArray(contract.active_targets),
    ...routeContractTargetArray(contract.pending_artifacts),
    ...routeContractTargetArray(contract.reference_only_targets),
    ...routeContractTargetArray(contract.blocked_direction_targets),
    ...routeContractTargetArray(contract.evidence_sources),
    ...routeContractTargetArray(contract.blocked_routes),
  ];
  return rows
    .map((entry) => entry.source_memory_id)
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((entry) => entry.length > 0)));
}

function guideTraceId(value: unknown): string | null {
  const entry = asRecord(value)?.guide_trace_id;
  return typeof entry === "string" && entry.length > 0 ? entry : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function guideTenantId(value: unknown): string {
  const guideRecord = asRecord(value);
  const agentContext = asRecord(guideRecord?.agent_context);
  const trace = asRecord(guideRecord?.memory_decision_trace);
  return nonEmptyString(guideRecord?.tenant_id)
    ?? nonEmptyString(agentContext?.tenant_id)
    ?? nonEmptyString(trace?.tenant_id)
    ?? "default";
}

function guideScope(value: unknown): string {
  const guideRecord = asRecord(value);
  const agentContext = asRecord(guideRecord?.agent_context);
  const trace = asRecord(guideRecord?.memory_decision_trace);
  return nonEmptyString(guideRecord?.scope)
    ?? nonEmptyString(agentContext?.scope)
    ?? nonEmptyString(trace?.scope)
    ?? "default";
}

function safeAgentPromptFromGuide(guide: unknown): string {
  try {
    return agentPromptFromGuide(guide);
  } catch {
    return "";
  }
}

function receiptFromGuideTrace(guide: unknown): AionisMemoryUseReceipt | null {
  const guideRecord = asRecord(guide);
  const candidates = [
    asRecord(asRecord(guideRecord?.memory_decision_trace)?.memory_use_receipt),
    asRecord(guideRecord?.memory_use_receipt),
    asRecord(asRecord(guideRecord?.agent_context)?.memory_use_receipt),
  ];
  const receipt = candidates.find((entry) => entry?.contract_version === "aionis_memory_use_receipt_v1");
  return receipt ? receipt as unknown as AionisMemoryUseReceipt : null;
}

function admissionRecordFromGuideTrace(guide: unknown): AionisMemoryAdmissionRecord | null {
  const guideRecord = asRecord(guide);
  const candidates = [
    asRecord(asRecord(guideRecord?.memory_decision_trace)?.admission_record),
    asRecord(guideRecord?.memory_admission_record),
    asRecord(asRecord(guideRecord?.agent_context)?.memory_admission_record),
  ];
  const record = candidates.find((entry) => entry?.contract_version === "aionis_memory_admission_record_v1");
  if (!record) return null;
  return {
    ...(record as unknown as AionisMemoryAdmissionRecord),
    tenant_id: nonEmptyString(record.tenant_id) ?? guideTenantId(guide),
    scope: nonEmptyString(record.scope) ?? guideScope(guide),
  };
}

function decisionSummariesFromSurfaces(input: {
  useNow: string[];
  inspect: string[];
  doNotUse: string[];
  rehydrate: string[];
}): AionisMemoryDecisionSummary[] {
  const rows: AionisMemoryDecisionSummary[] = [];
  const seen = new Set<string>();
  const push = (entry: AionisMemoryDecisionSummary) => {
    if (seen.has(entry.memory_id)) return;
    seen.add(entry.memory_id);
    rows.push(entry);
  };
  for (const memoryId of input.useNow) {
    push({
      memory_id: memoryId,
      agent_surface: "use_now",
      decision_kind: "used",
      actionable: true,
      reason_codes: ["agent_context.use_now_memory_ids"],
    });
  }
  for (const memoryId of input.inspect) {
    push({
      memory_id: memoryId,
      agent_surface: "inspect_before_use",
      decision_kind: "downgraded",
      actionable: false,
      reason_codes: ["agent_context.inspect_before_use_memory_ids"],
    });
  }
  for (const memoryId of input.doNotUse) {
    push({
      memory_id: memoryId,
      agent_surface: "do_not_use",
      decision_kind: "blocked",
      actionable: false,
      reason_codes: ["agent_context.do_not_use_memory_ids"],
    });
  }
  for (const memoryId of input.rehydrate) {
    push({
      memory_id: memoryId,
      agent_surface: "rehydrate",
      decision_kind: "rehydrate",
      actionable: false,
      reason_codes: ["agent_context.rehydrate_hints"],
    });
  }
  return rows;
}

function generatedMemoryUseReceipt(guide: unknown): AionisMemoryUseReceipt {
  const context = asRecord(agentContextFromGuide(guide));
  const useNow = uniqueStrings(stringArray(context?.use_now_memory_ids));
  const inspect = uniqueStrings(stringArray(context?.inspect_before_use_memory_ids));
  const doNotUse = uniqueStrings(stringArray(context?.do_not_use_memory_ids));
  const rehydrate = uniqueStrings(rehydrateHintMemoryIds(context?.rehydrate_hints));
  const exposed = uniqueStrings([
    ...stringArray(context?.memory_ids),
    ...useNow,
    ...inspect,
    ...doNotUse,
    ...rehydrate,
    ...commandPostureArray(context?.command_posture).map((entry) => entry.memory_id),
    ...routeContractMemoryIds(context?.route_contract),
  ]);
  const prompt = safeAgentPromptFromGuide(guide);
  return {
    contract_version: "aionis_memory_use_receipt_v1",
    intended_use: "memory_use_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    guide_trace_id: guideTraceId(guide),
    history_used: exposed.length > 0,
    actionable_history_used: useNow.length > 0,
    prompt_char_count: prompt.length,
    exposed_memory_ids: exposed,
    use_now_memory_ids: useNow,
    inspect_before_use_memory_ids: inspect,
    do_not_use_memory_ids: doNotUse,
    rehydrate_memory_ids: rehydrate,
    attributed_memory_ids: [],
    unattributed_recalled_memory_ids: [],
    read_only_signal_memory_ids: uniqueStrings([...inspect, ...doNotUse, ...rehydrate]),
    decision_summaries: decisionSummariesFromSurfaces({ useNow, inspect, doNotUse, rehydrate }),
    risk_flags: stringArray(asRecord(context?.risk)?.reasons),
    summary: useNow.length > 0
      ? "Aionis exposed adjudicated actionable execution memory."
      : exposed.length > 0
        ? "Aionis exposed adjudicated non-actionable memory surfaces."
        : "Aionis did not expose reusable memory for this guide.",
  };
}

function targetList<T extends { target: string }>(rows: T[]): string[] {
  return uniqueStrings(rows.map((entry) => entry.target));
}

function repoPresenceMap(state?: AionisExecutionRepoState): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const target of state?.existing_files ?? []) out.set(target, true);
  for (const target of state?.missing_files ?? []) out.set(target, false);
  for (const entry of state?.files ?? []) out.set(entry.target, entry.exists);
  return out;
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const marker = "\n...[truncated by Aionis SDK context budget]...";
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return `${text.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
}

function defaultExecutionPromptBudget(profile: AionisExecutionContextBudgetProfile): number {
  switch (profile) {
    case "compact": return 6_000;
    case "high_recall": return 24_000;
    case "balanced": return 12_000;
  }
}

function executionEvidenceBudget(profile: AionisExecutionContextBudgetProfile): { items: number; chars: number } {
  switch (profile) {
    case "compact": return { items: 2, chars: 160 };
    case "high_recall": return { items: 8, chars: 260 };
    case "balanced": return { items: 4, chars: 220 };
  }
}

type CommandPostureEvidenceField = "workflow_steps" | "acceptance_checks" | "verification_summary" | "artifact_hints";

function commandPostureEvidenceValues(
  entry: AionisCommandPosture,
  field: CommandPostureEvidenceField,
): string[] {
  switch (field) {
    case "workflow_steps": return entry.workflow_steps ?? [];
    case "acceptance_checks": return entry.acceptance_checks ?? [];
    case "verification_summary": return entry.verification_summary ?? [];
    case "artifact_hints": return entry.artifact_hints ?? [];
  }
}

function commandPostureEvidenceBullets(args: {
  commandPosture: AionisCommandPosture[];
  field: CommandPostureEvidenceField;
  postures: Set<AionisCommandPostureKind>;
  limit: number;
  maxChars: number;
}): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const entry of args.commandPosture) {
    if (!args.postures.has(entry.posture)) continue;
    for (const value of commandPostureEvidenceValues(entry, args.field)) {
      const text = value.replace(/\s+/g, " ").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      lines.push(`- ${truncateText(text, args.maxChars)}`);
      if (lines.length >= args.limit) return lines;
    }
  }
  return lines;
}

function agentContextTextBullets(args: {
  guide: unknown;
  field: "use_now" | "inspect_before_use" | "do_not_use";
  limit: number;
  maxChars: number;
}): string[] {
  if (args.limit <= 0 || args.maxChars <= 0) return [];
  const context = asRecord(agentContextFromGuide(args.guide));
  const values = stringArray(context?.[args.field]);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = value.replace(/\s+/g, " ").trim();
    if (/^Recovered state:\s+no prior execution history changed this packet\.?$/i.test(text)) continue;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(`- ${truncateText(text, args.maxChars)}`);
    if (lines.length >= args.limit) return lines;
  }
  return lines;
}

function optionalPromptSection(title: string, lines: string[]): string[] {
  return lines.length > 0 ? ["", title, ...lines] : [];
}

function taskLines(task: string | AionisExecutionContextTask | undefined): string[] {
  if (!task) return [];
  if (typeof task === "string") return [`- ${task}`];
  return [
    task.task_signature ? `- task_signature: ${task.task_signature}` : "",
    task.run_id ? `- run_id: ${task.run_id}` : "",
    task.query_text ? `- query: ${task.query_text}` : "",
    task.goal ? `- goal: ${task.goal}` : "",
  ].filter((entry) => entry.length > 0);
}

function bulletLines(values: string[], empty: string): string[] {
  return values.length > 0 ? values.map((entry) => `- ${entry}`) : [`- ${empty}`];
}

function postureLines(rows: AionisCommandPosture[], posture: AionisCommandPostureKind, empty: string): string[] {
  const filtered = rows.filter((entry) => entry.posture === posture);
  if (filtered.length === 0) return [`- ${empty}`];
  return filtered.map((entry) => {
    const targets = entry.target_files.length > 0 ? ` targets=${entry.target_files.join(", ")}` : "";
    return `- ${entry.memory_id}: ${entry.instruction} (${entry.reason})${targets}`;
  });
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

function requiredString(value: string | undefined, message: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function executionMemoryLane(input: { memory_lane?: AionisMemoryLane; team_id?: string }): AionisMemoryLane {
  if (input.memory_lane) return input.memory_lane;
  return input.team_id?.trim() ? "shared" : "private";
}

function executionResultSummary(input: AionisExecutionStepInput): AionisJsonObject | undefined {
  if (!input.outcome || input.outcome === "unknown") return undefined;
  return stripUndefined({
    status: input.outcome === "succeeded" ? "passed" : input.outcome,
    summary: input.summary,
    evidence_refs: input.evidence_ref ? [input.evidence_ref] : undefined,
  });
}

function executionFeedbackOutcome(input: AionisExecutionOutcomeInput): AionisFeedbackOutcome {
  if (input.feedback_outcome) return input.feedback_outcome;
  if (input.outcome === "succeeded") return "positive";
  if (input.outcome === "failed" || input.outcome === "blocked" || input.outcome === "interrupted") return "negative";
  return "neutral";
}

function executionVerifierStatus(input: AionisExecutionOutcomeInput): AionisFeedbackStatus {
  if (input.verifier_status) return input.verifier_status;
  if (input.outcome === "succeeded") return "passed";
  if (input.outcome === "failed" || input.outcome === "blocked" || input.outcome === "interrupted") return "failed";
  return "unknown";
}

function executionToolStatus(input: AionisExecutionOutcomeInput): AionisToolStatus {
  if (input.tool_status) return input.tool_status;
  if (input.outcome === "succeeded") return "succeeded";
  if (input.outcome === "failed" || input.outcome === "blocked" || input.outcome === "interrupted") return "failed";
  return "unknown";
}

function executionAgentId(input: AionisExecutionAgentRef): string {
  return requiredString(input.agent_id, "Aionis execution helper requires agent_id.");
}

function executionRole(input: AionisExecutionAgentRef): AionisExecutionAgentRole {
  return input.role ?? "agent";
}

function executionScopeOptions(input: { tenant_id?: string; scope?: string }): AionisRequestOptions {
  return stripUndefined({
    tenant_id: input.tenant_id,
    scope: input.scope,
  }) as AionisRequestOptions;
}

function executionObserveBase(input: AionisExecutionBaseInput): AionisJsonObject {
  const memoryLane = executionMemoryLane(input);
  if (memoryLane === "shared" && !input.team_id?.trim()) {
    throw new Error("Aionis shared execution memory requires team_id. Use memory_lane: \"private\" for single-agent memory.");
  }
  const agentId = executionAgentId(input);
  return stripUndefined({
    auto_embed: input.auto_embed ?? true,
    memory_lane: memoryLane,
    producer_agent_id: agentId,
    owner_agent_id: memoryLane === "private" ? agentId : undefined,
    owner_team_id: input.team_id,
  });
}

function executionPayload(input: AionisExecutionStepInput): AionisJsonObject {
  const result = executionResultSummary(input);
  return stripUndefined({
    run_id: input.run_id,
    task_id: input.task_id,
    task_family: input.task_family,
    task_signature: input.task_signature,
    workflow_signature: input.workflow_signature,
    title: input.title,
    summary: input.summary,
    outcome: input.outcome ?? "unknown",
    target_files: input.target_files,
    workflow_steps: input.workflow_steps,
    tool_set: input.tool_set,
    acceptance_checks: input.acceptance_checks,
    continuation_hint: input.continuation_hint,
    resume_hint: input.resume_hint,
    reuse_hint: input.reuse_hint,
    salience: input.salience,
    importance: input.importance,
    confidence: input.confidence,
    raw_ref: input.raw_ref,
    evidence_ref: input.evidence_ref,
    evidence: input.evidence,
    artifacts: input.artifacts,
    verification: input.verification,
    slots: stripUndefined({
      task_signature: input.task_signature,
      ...(result ? { execution_result_summary: result } : {}),
      ...(input.slots ?? {}),
    }),
    ...(input.execution ?? {}),
  });
}

function executionHandoffPayload(input: AionisExecutionHandoffInput): AionisJsonObject {
  const agentId = executionAgentId(input);
  const memoryLane = executionMemoryLane(input);
  const anchor = input.anchor ?? `${input.task_signature}:${input.run_id}:${agentId}`;
  const handoffKind = input.handoff_kind ?? "task_handoff";
  return stripUndefined({
    memory_lane: memoryLane,
    actor: agentId,
    producer_agent_id: agentId,
    owner_agent_id: memoryLane === "private" ? agentId : undefined,
    owner_team_id: input.team_id,
    anchor,
    handoff_kind: handoffKind,
    file_path: input.file_path,
    repo_root: input.repo_root,
    symbol: input.symbol,
    task_family: input.task_family,
    task_signature: input.task_signature,
    workflow_signature: input.workflow_signature,
    title: input.title,
    summary: input.summary,
    handoff_text: input.handoff_text ?? input.continuation_hint ?? input.summary,
    salience: input.salience,
    importance: input.importance,
    confidence: input.confidence,
    risk: input.risk,
    acceptance_checks: input.acceptance_checks,
    tags: input.tags,
    target_files: input.target_files,
    next_action: input.next_action ?? input.continuation_hint,
    must_change: input.must_change,
    must_remove: input.must_remove,
    must_keep: input.must_keep,
    execution_result_summary: executionResultSummary(input),
    execution_artifacts: input.artifacts,
    execution_evidence: input.evidence,
    execution_state_v1: input.execution_state_v1,
    execution_packet_v1: input.execution_packet_v1,
    control_profile_v1: input.control_profile_v1,
    execution_transitions_v1: input.execution_transitions_v1,
    execution_tree_disabled: input.execution_tree_disabled,
    execution_tree_default_disabled: input.execution_tree_default_disabled,
    execution_tree_v1: input.execution_tree_v1,
    execution_tree_operations_v1: input.execution_tree_operations_v1,
    trajectory: input.trajectory,
    trajectory_hints: input.trajectory_hints,
    ...(input.handoff ?? {}),
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
  const receipt = memoryUseReceiptFromGuide(guide);
  const rows: Array<{ memory_id: string; surface: AionisResolvedAgentEvidenceSurface }> = [];
  if (options.include_inspect_before_use !== false) {
    for (const memoryId of receipt.inspect_before_use_memory_ids) {
      rows.push({ memory_id: memoryId, surface: "inspect_before_use" });
    }
  }
  if (options.include_rehydrate !== false) {
    for (const memoryId of receipt.rehydrate_memory_ids) {
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

function renderResolvedEvidenceBlock(
  evidence: AionisResolvedAgentEvidence[],
  maxChars: number,
): { text: string; evidence_char_count: number } {
  const resolved = evidence.filter((entry) => entry.resolved && entry.evidence_text.trim().length > 0);
  if (resolved.length === 0) return { text: "", evidence_char_count: 0 };
  const sections = [
    "AIONIS_RESOLVED_EVIDENCE v1",
    "Resolved evidence below was explicitly surfaced by Aionis as inspect_before_use or rehydrate. Use it as evidence, not as a bypass around the admission decision.",
    "",
    ...resolved.flatMap((entry, index) => [
      `[${index + 1}] memory_id=${entry.memory_id} surface=${entry.surface} source=${entry.source}${entry.uri ? ` uri=${entry.uri}` : ""}`,
      truncateText(entry.evidence_text, Math.max(400, Math.floor(maxChars / Math.max(1, resolved.length)))),
      "",
    ]),
  ];
  const text = truncateText(sections.join("\n").trim(), maxChars);
  return { text, evidence_char_count: text.length };
}

function mergeCompiledContextWithEvidence(args: {
  guide: unknown;
  resolvedEvidence: AionisResolvedAgentEvidence[];
  options: AionisGuideAgentContextOptions;
}): {
  compiled_context: AionisCompiledExecutionAgentContext;
  agent_prompt: string;
  evidence_char_count: number;
} {
  const maxPromptChars = args.options.max_prompt_chars ?? 50_000;
  const evidenceBudget = args.options.evidence_char_budget ?? Math.min(20_000, Math.max(4_000, Math.floor(maxPromptChars * 0.4)));
  const { text: evidenceBlock, evidence_char_count: evidenceCharCount } = renderResolvedEvidenceBlock(
    args.resolvedEvidence,
    evidenceBudget,
  );
  const promptFormat = args.options.prompt_format ?? "contract";
  const includeEvidence = promptFormat === "runtime_compact"
    ? args.options.include_resolved_evidence_in_prompt === true
    : args.options.include_resolved_evidence_in_prompt ?? true;
  const compiledMaxPromptChars = includeEvidence && evidenceBlock
    ? Math.max(4_000, maxPromptChars - evidenceBlock.length - 2)
    : maxPromptChars;
  if (promptFormat === "runtime_compact") {
    const compiled = compileExecutionAgentContext({
      guide: args.guide,
      task: args.options.task,
      repo_state: args.options.repo_state,
      budget_profile: args.options.budget_profile ?? "compact",
      max_prompt_chars: compiledMaxPromptChars,
      prompt_format: "runtime_compact",
      additional_instructions: args.options.additional_instructions,
    });
    const agentPrompt = includeEvidence && evidenceBlock
      ? truncateText(`${compiled.agent_prompt}\n\n${evidenceBlock}`, maxPromptChars)
      : compiled.agent_prompt;
    return {
      compiled_context: {
        ...compiled,
        agent_prompt: agentPrompt,
        prompt_char_count: agentPrompt.length,
      },
      agent_prompt: agentPrompt,
      evidence_char_count: evidenceCharCount,
    };
  }
  const compiled = compileExecutionAgentContext({
    guide: args.guide,
    task: args.options.task,
    repo_state: args.options.repo_state,
    budget_profile: args.options.budget_profile ?? "balanced",
    max_prompt_chars: compiledMaxPromptChars,
    prompt_format: "contract",
    additional_instructions: args.options.additional_instructions,
  });
  const agentPrompt = includeEvidence && evidenceBlock
    ? truncateText(`${compiled.agent_prompt}\n\n${evidenceBlock}`, maxPromptChars)
    : compiled.agent_prompt;
  return {
    compiled_context: {
      ...compiled,
      agent_prompt: agentPrompt,
      prompt_char_count: agentPrompt.length,
    },
    agent_prompt: agentPrompt,
    evidence_char_count: evidenceCharCount,
  };
}

export class AionisClient {
  readonly execution: AionisExecutionClient;

  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly tenantId: string | null;
  private readonly scope: string | null;
  private readonly headers: Record<string, string>;
  private readonly defaultGuideMode: AionisGuideMode | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AionisClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey?.trim() || null;
    this.tenantId = options.tenant_id?.trim() || null;
    this.scope = options.scope?.trim() || null;
    this.headers = { ...(options.headers ?? {}) };
    this.defaultGuideMode = options.default_guide_mode === undefined ? "full_power" : options.default_guide_mode;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.execution = new AionisExecutionClient(this);
  }

  async observe<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/observe", body, options);
  }

  async remember<T = unknown>(body: AionisRememberRequest, options?: AionisRequestOptions): Promise<T> {
    return this.observe<T>(rememberBody(body), options);
  }

  async guide<T = unknown>(body: AionisGuideRequest, options?: AionisGuideRequestOptions): Promise<T> {
    return this.post<T>("/v1/guide", this.guideBody(body, options), options);
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
    const bodyRecord = asRecord(body) ?? {};
    const effectiveContextOptions = { ...contextOptions };
    const { tenant_id: tenantId, scope } = guideTenantScope(guide, {
      tenant_id: options?.tenant_id ?? coerceString(bodyRecord.tenant_id) ?? this.tenantId ?? undefined,
      scope: options?.scope ?? coerceString(bodyRecord.scope) ?? this.scope ?? undefined,
    });
    const evidenceLimit = effectiveContextOptions.evidence_limit ?? 6;
    const resolveTypes = effectiveContextOptions.resolve_types ?? DEFAULT_RESOLVE_TYPES;
    const onResolveError = effectiveContextOptions.on_resolve_error ?? "include_placeholder";
    const evidenceRows = resolveEvidenceIds(guide, effectiveContextOptions).slice(0, evidenceLimit);
    const resolvedEvidence: AionisResolvedAgentEvidence[] = [];
    const consumerAgentId = coerceString(bodyRecord.consumer_agent_id);
    const consumerTeamId = coerceString(bodyRecord.consumer_team_id);

    for (const row of evidenceRows) {
      if (!AIONIS_MEMORY_ID_RE.test(row.memory_id)) {
        if (onResolveError === "throw") {
          throw new Error(`Cannot resolve non-Aionis memory id: ${row.memory_id}`);
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
            error: { message: "memory id is not an Aionis UUID; external memory ids are adjudicated but not resolvable through /v1/memory/resolve" },
          });
        }
        continue;
      }

      let lastError: unknown = null;
      let resolved = false;
      for (const type of resolveTypes) {
        const uri = buildClientAionisUri({ tenant_id: tenantId, scope, type, id: row.memory_id });
        try {
          const response = await this.resolveMemory<unknown>({
            uri,
            include_meta: true,
            include_slots: true,
            ...(consumerAgentId ? { consumer_agent_id: consumerAgentId } : {}),
            ...(consumerTeamId ? { consumer_team_id: consumerTeamId } : {}),
          }, options);
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
          if (error instanceof AionisClientError && error.status === 404) continue;
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
            message: lastError instanceof Error ? lastError.message : "memory resolve failed",
            ...(lastError instanceof AionisClientError ? { status: lastError.status } : {}),
          },
        });
      }
    }

    const merged = mergeCompiledContextWithEvidence({
      guide,
      resolvedEvidence,
      options: effectiveContextOptions,
    });
    const unresolvedMemoryIds = resolvedEvidence
      .filter((entry) => !entry.resolved)
      .map((entry) => entry.memory_id);

    return {
      contract_version: "aionis_sdk_agent_context_with_evidence_v1",
      guide,
      compiled_context: merged.compiled_context,
      agent_context: asRecord(guide)?.agent_context ?? null,
      agent_prompt: merged.agent_prompt,
      resolved_evidence: resolvedEvidence,
      unresolved_memory_ids: unresolvedMemoryIds,
      evidence_char_count: merged.evidence_char_count,
      prompt_char_count: merged.agent_prompt.length,
      guide_trace_id: guideTraceIdValue(guide),
    };
  }

  async guideWithEvidence<TGuide = unknown>(
    body: AionisGuideRequest,
    options?: AionisGuideRequestOptions,
    contextOptions?: AionisGuideAgentContextOptions,
  ): Promise<AionisGuideAgentContextResult<TGuide>> {
    return this.guideAgentContext<TGuide>(body, options, contextOptions);
  }

  async governMemory<T = AionisMemoryAdmissionGatewayResponse>(
    body: AionisMemoryAdmissionRequest,
    options?: AionisRequestOptions,
  ): Promise<T> {
    return this.post<T>("/v1/memory/govern", body, options);
  }

  async governMem0SearchResults<T = AionisMemoryAdmissionGatewayResponse>(
    input: AionisGovernMem0SearchResultsInput,
    options?: AionisRequestOptions,
  ): Promise<T> {
    const rawBody = { ...(input as AionisJsonObject) };
    delete rawBody.mem0_results;
    delete rawBody.mapper;
    delete rawBody.candidates;
    const requestBody: AionisMemoryAdmissionRequest = {
      ...rawBody,
      query_text: input.query_text,
      mode: input.mode ?? "firewall",
      context_mode: input.context_mode ?? "compact_agent",
      include_records: input.include_records ?? true,
      candidates: mem0SearchResultsToAionisCandidates(input.mem0_results, input.mapper),
    };
    return this.governMemory<T>(requestBody, options);
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

  async measure<T = AionisMeasureResult>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/measure", body, options);
  }

  async materializeSkillCandidate<T = AionisSkillCandidateMaterializeResult>(
    candidateId: string,
    body: AionisJsonObject = {},
    options?: AionisRequestOptions,
  ): Promise<T> {
    const id = candidateId.trim();
    if (!id) throw new Error("candidateId is required");
    return this.post<T>(`/v1/skills/candidates/${encodeURIComponent(id)}/materialize`, body, options);
  }

  async observeMaterializedSkillCandidate<T = unknown>(
    materialized: AionisSkillCandidateMaterializeResult,
    options?: AionisRequestOptions,
  ): Promise<T> {
    return this.observe<T>(materialized.recommended_observe_payload, options);
  }

  async operatorSnapshot<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/operator/snapshot", body, options);
  }

  async flightRecorder<T = AionisAgentFlightRecorderResponse>(
    body: AionisAgentFlightRecorderRequest,
    options?: AionisRequestOptions,
  ): Promise<T> {
    return this.post<T>("/v1/audit/flight-recorder", body, options);
  }

  async snapshot<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.operatorSnapshot<T>(body, options);
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
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.requestHeaders(options),
      body: JSON.stringify(scopedBody(body, {
        tenant_id: this.tenantId ?? undefined,
        scope: this.scope ?? undefined,
      }, options)),
    });
    const payload = await readResponseBody(response);
    if (!response.ok) throw new AionisClientError(response.status, path, payload);
    return payload as T;
  }

  private guideBody(body: AionisJsonObject, options?: AionisGuideRequestOptions): AionisJsonObject {
    const compactBody = stripUndefined(body);
    const guideMode = options?.guide_mode === undefined ? this.defaultGuideMode : options.guide_mode;
    if (compactBody.mode !== undefined) return compactBody;
    if (compactBody.context_mode !== undefined) {
      if (compactBody.context_mode === "compact_agent" && guideMode) {
        return {
          mode: guideMode,
          ...compactBody,
        };
      }
      return compactBody;
    }
    if (!guideMode) return compactBody;
    return {
      mode: guideMode,
      ...compactBody,
    };
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

export class AionisExecutionClient {
  private readonly client: AionisClient;

  constructor(client: AionisClient) {
    this.client = client;
  }

  compileAgentContext(input: AionisExecutionAgentContextCompileInput): AionisCompiledExecutionAgentContext {
    return compileExecutionAgentContext(input);
  }

  async observeStep<T = unknown>(input: AionisExecutionStepInput, options?: AionisRequestOptions): Promise<T> {
    return this.client.observe<T>({
      ...executionObserveBase(input),
      input_text: input.input_text ?? `${input.title}\n${input.summary}`,
      execution: executionPayload(input),
    }, {
      ...executionScopeOptions(input),
      ...(options ?? {}),
    });
  }

  async handoff<T = unknown>(input: AionisExecutionHandoffInput, options?: AionisRequestOptions): Promise<T> {
    return this.client.observe<T>({
      ...executionObserveBase(input),
      handoff: executionHandoffPayload(input),
    }, {
      ...executionScopeOptions(input),
      ...(options ?? {}),
    });
  }

  async guideForRole<T = unknown>(
    input: AionisExecutionGuideForRoleInput,
    options?: AionisGuideRequestOptions,
  ): Promise<T> {
    const agentId = executionAgentId(input);
    return this.client.guide<T>({
      query_text: input.query_text,
      agent_role: executionRole(input),
      consumer_agent_id: agentId,
      consumer_team_id: input.team_id,
      run_id: input.run_id,
      context: {
        task_id: input.task_id,
        task_signature: input.task_signature,
        task_family: input.task_family,
        workflow_signature: input.workflow_signature,
        ...(input.context ?? {}),
      },
      execution_tree_v1: input.execution_tree_v1 ?? undefined,
      tool_candidates: input.tool_candidates,
      limit: input.limit ?? 10,
      include_packets: input.include_packets ?? true,
      mode: input.mode,
      context_mode: input.context_mode,
      context_char_budget: input.context_char_budget,
      context_token_budget: input.context_token_budget,
      context_compaction_profile: input.context_compaction_profile,
      context_optimization_profile: input.context_optimization_profile,
      ...(input.guide ?? {}),
      ...(input.task_context_profile ? { task_context_profile: input.task_context_profile } : {}),
    }, {
      ...executionScopeOptions(input),
      ...(options ?? {}),
    });
  }

  async guideAgentContextForRole<TGuide = unknown>(
    input: AionisExecutionGuideForRoleInput,
    options?: AionisGuideRequestOptions,
    contextOptions: AionisGuideAgentContextOptions = {},
  ): Promise<AionisGuideAgentContextResult<TGuide>> {
    const agentId = executionAgentId(input);
    return this.client.guideAgentContext<TGuide>({
      query_text: input.query_text,
      agent_role: executionRole(input),
      consumer_agent_id: agentId,
      consumer_team_id: input.team_id,
      run_id: input.run_id,
      context: {
        task_id: input.task_id,
        task_signature: input.task_signature,
        task_family: input.task_family,
        workflow_signature: input.workflow_signature,
        ...(input.context ?? {}),
      },
      execution_tree_v1: input.execution_tree_v1 ?? undefined,
      tool_candidates: input.tool_candidates,
      limit: input.limit ?? 10,
      include_packets: input.include_packets ?? true,
      mode: input.mode,
      context_mode: input.context_mode,
      context_char_budget: input.context_char_budget,
      context_token_budget: input.context_token_budget,
      context_compaction_profile: input.context_compaction_profile,
      context_optimization_profile: input.context_optimization_profile,
      ...(input.guide ?? {}),
      ...(input.task_context_profile ? { task_context_profile: input.task_context_profile } : {}),
    }, {
      ...executionScopeOptions(input),
      ...(options ?? {}),
    }, {
      task: contextOptions.task ?? {
        task_id: input.task_id,
        run_id: input.run_id,
        task_signature: input.task_signature,
        query_text: input.query_text,
      },
      ...contextOptions,
    });
  }

  async observeOutcome<TObserve = unknown, TFeedback = unknown>(
    input: AionisExecutionOutcomeInput,
    options?: AionisRequestOptions,
  ): Promise<AionisExecutionOutcomeResult<TObserve, TFeedback>> {
    const observe = await this.observeStep<TObserve>(input, options);
    const feedback = input.feedback === false ? null : await this.feedbackFromOutcome<TFeedback>(input, options);
    return { observe, feedback };
  }

  async feedbackFromOutcome<T = unknown>(
    input: AionisExecutionOutcomeInput,
    options?: AionisRequestOptions,
  ): Promise<T | null> {
    const usedMemoryIds = input.used_memory_ids ?? [];
    if (usedMemoryIds.length === 0) return null;
    if (input.guide) {
      return this.client.feedback<T>(feedbackFromGuide({
        guide: input.guide,
        reason: input.feedback_reason ?? input.summary,
        run_id: input.run_id,
        outcome: executionFeedbackOutcome(input),
        used_memory_ids: usedMemoryIds,
        used_surface: input.used_surface ?? "use_now",
        actor: input.agent_id,
        verifier_status: executionVerifierStatus(input),
        tool_status: executionToolStatus(input),
        runtime_signal_refs: input.runtime_signal_refs,
      }), {
        ...executionScopeOptions(input),
        ...(options ?? {}),
      });
    }
    if (!input.guide_trace_id) return null;
    return this.client.feedback<T>({
      target: "memory",
      reason: input.feedback_reason ?? input.summary,
      run_id: input.run_id,
      outcome: executionFeedbackOutcome(input),
      used_surface: input.used_surface ?? "use_now",
      actor: input.agent_id,
      guide_trace_id: input.guide_trace_id,
      used_memory_ids: usedMemoryIds,
      verifier_status: executionVerifierStatus(input),
      tool_status: executionToolStatus(input),
      runtime_signal_refs: input.runtime_signal_refs,
    }, {
      ...executionScopeOptions(input),
      ...(options ?? {}),
    });
  }

  async measureRun<T = AionisMeasureResult>(input: AionisExecutionMeasureRunInput, options?: AionisRequestOptions): Promise<T> {
    return this.client.measure<T>(measureInputFromGuideLoop({
      task: {
        task_id: input.task_id ?? input.run_id,
        run_id: input.run_id,
        task_signature: input.task_signature,
        task_family: input.task_family,
        workflow_signature: input.workflow_signature,
      },
      before_guide: input.before_guide,
      after_guide: input.after_guide,
      feedback_result: input.feedback_result,
      sufficient_evidence: input.sufficient_evidence,
      evidence_ids: input.evidence_ids,
      tenant_id: input.tenant_id,
      scope: input.scope,
      product_trace: input.product_trace,
    }), options);
  }

  async snapshotRun<T = unknown>(input: AionisExecutionSnapshotRunInput, options?: AionisRequestOptions): Promise<T> {
    return this.client.snapshot<T>(snapshotInputFromGuideLoop({
      run_id: input.run_id,
      task_signature: input.task_signature,
      task_family: input.task_family,
      guide: input.guide,
      measure_result: input.measure_result,
      include_markdown: input.include_markdown,
      tenant_id: input.tenant_id,
      scope: input.scope,
      extra: {
        workflow_signature: input.workflow_signature,
        ...(input.extra ?? {}),
      },
    }), options);
  }
}

export function createAionisClient(options: AionisClientOptions): AionisClient {
  return new AionisClient(options);
}

function planAssetId(input: AionisPlanAssetObserveInput): string {
  return input.plan.plan_id ?? `plan:${stableTextHash([
    input.run_id,
    input.task_signature,
    input.workflow_signature ?? "",
    input.plan.title,
    input.plan.summary,
  ].join("\n"))}`;
}

function planAssetTargetFiles(plan: AionisPlanAsset): string[] {
  return uniqueStrings(plan.decisions.flatMap((decision) => decision.target_files ?? []));
}

function planAssetSummary(input: AionisPlanAssetObserveInput, planId: string): string {
  const decisionLines = input.plan.decisions.map((decision) => [
    `PLAN_DECISION ${decision.decision_id}: ${decision.statement}`,
    decision.rationale ? `Rationale: ${decision.rationale}` : "",
    ...(decision.alternatives_rejected ?? []).map((entry) => `Rejected alternative: ${entry}`),
  ].filter(Boolean).join(" "));
  return [
    "PLAN_AS_MEMORY_ASSET",
    `Plan ID: ${planId}`,
    input.plan.artifact_ref ? `Artifact: ${input.plan.artifact_ref}` : "",
    input.planner.model ? `Planner model: ${input.planner.model}` : "",
    input.plan.summary,
    ...decisionLines,
    ...input.plan.acceptance_checks.map((check, index) => `PLAN_ACCEPTANCE_CHECK ${index + 1}: ${check}`),
    ...input.plan.execution_boundaries.map((boundary, index) => `PLAN_EXECUTION_BOUNDARY ${index + 1}: ${boundary}`),
    `Rejected branch count: ${input.plan.failed_branches?.length ?? 0}`,
  ].filter(Boolean).join("\n");
}

export function planAssetObserveEvents(input: AionisPlanAssetObserveInput): AionisExecutionStepInput[] {
  const planId = planAssetId(input);
  const targetFiles = planAssetTargetFiles(input.plan);
  const base = {
    run_id: input.run_id,
    task_id: input.task_id,
    task_signature: input.task_signature,
    task_family: input.task_family,
    workflow_signature: input.workflow_signature,
    tenant_id: input.tenant_id,
    scope: input.scope,
    memory_lane: input.memory_lane,
    auto_embed: input.auto_embed,
    agent_id: input.planner.agent_id,
    team_id: input.planner.team_id,
    role: "planner" as const,
  };
  const planEvent: AionisExecutionStepInput = {
    ...base,
    title: input.plan.title,
    summary: planAssetSummary(input, planId),
    outcome: "succeeded",
    target_files: targetFiles,
    acceptance_checks: input.plan.acceptance_checks,
    continuation_hint: "Use this plan as adjudicated execution memory; preserve decisions, acceptance checks, boundaries, and rejected branches.",
    slots: stripUndefined({
      plan_asset_v1: stripUndefined({
        plan_id: planId,
        artifact_ref: input.plan.artifact_ref,
        planner_model: input.planner.model,
        decision_ids: input.plan.decisions.map((decision) => decision.decision_id),
        acceptance_check_count: input.plan.acceptance_checks.length,
        execution_boundary_count: input.plan.execution_boundaries.length,
        rejected_branch_count: input.plan.failed_branches?.length ?? 0,
      }),
      evidence_kind: "plan_asset",
    }),
  };
  const rejectedBranchEvents = (input.plan.failed_branches ?? []).map((branch): AionisExecutionStepInput => ({
    ...base,
    title: `Rejected plan branch: ${branch.branch_id}`,
    summary: [
      "PLAN_REJECTED_BRANCH",
      `Plan ID: ${planId}`,
      `${branch.branch_id}: rejected branch.`,
      `Reason: ${truncateText(branch.reason, 120)}`,
      "counter-evidence only; do not use as primary route.",
    ].join("\n"),
    outcome: "failed",
    target_files: branch.target_files ?? [],
    acceptance_checks: input.plan.acceptance_checks,
    continuation_hint: "Do not continue this rejected plan branch as the primary route.",
    slots: stripUndefined({
      plan_asset_v1: stripUndefined({
        plan_id: planId,
        rejected_branch_id: branch.branch_id,
        artifact_ref: input.plan.artifact_ref,
        planner_model: input.planner.model,
        rejected_branch_statement: branch.statement,
        rejected_branch_reason: branch.reason,
      }),
      evidence_kind: "plan_rejected_branch",
    }),
  }));
  return [planEvent, ...rejectedBranchEvents];
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

export function memoryUseReceiptFromGuide(guide: unknown): AionisMemoryUseReceipt {
  return receiptFromGuideTrace(guide) ?? generatedMemoryUseReceipt(guide);
}

export function memoryAdmissionRecordFromGuide(guide: unknown): AionisMemoryAdmissionRecord {
  const record = admissionRecordFromGuideTrace(guide);
  if (record) return record;
  const receipt = memoryUseReceiptFromGuide(guide);
  const entries = receipt.decision_summaries.map((summary) => ({
    memory_id: summary.memory_id,
    title: null,
    domain: "execution" as const,
    memory_type: "unknown" as const,
    lifecycle_state: "unknown" as const,
    authority: "none" as const,
    admission_action: summary.agent_surface,
    decision_kind: summary.decision_kind,
    actionable: summary.actionable,
    prompt_included: summary.agent_surface !== "not_agent_facing",
    agent_used: receipt.attributed_memory_ids.includes(summary.memory_id),
    feedback_outcome: null,
    attribution_strength: null,
    reason_codes: summary.reason_codes,
    evidence_ids: [],
  }));
  return {
    contract_version: "aionis_memory_admission_record_v1",
    intended_use: "memory_admission_audit_dataset",
    source: "memory_decision_trace",
    agent_prompt_included: false,
    runtime_mutation: false,
    tenant_id: guideTenantId(guide),
    scope: guideScope(guide),
    guide_trace_id: receipt.guide_trace_id,
    prompt_char_count: receipt.prompt_char_count,
    history_used: receipt.history_used,
    actionable_history_used: receipt.actionable_history_used,
    candidate_memory_count: entries.length,
    prompt_included_memory_count: entries.filter((entry) => entry.prompt_included).length,
    agent_used_memory_count: entries.filter((entry) => entry.agent_used).length,
    entries,
    summary: `Aionis generated ${entries.length} compact admission records from memory use receipt surfaces; full decision details require Runtime memory_decision_trace.`,
  };
}

function admissionDatasetOutcomeLabel(entry: AionisMemoryAdmissionRecordEntry): AionisMemoryAdmissionDatasetOutcomeLabel {
  if (entry.agent_used && entry.feedback_outcome === "positive") return "positive_use";
  if (entry.agent_used && entry.feedback_outcome === "negative") return "negative_use";
  if (entry.agent_used && entry.feedback_outcome === "neutral") return "neutral_use";
  if (entry.admission_action === "do_not_use") return "blocked_or_suppressed";
  if (entry.admission_action === "rehydrate") return "rehydrate_requested";
  if (entry.admission_action === "not_agent_facing") return "not_agent_facing";
  if (entry.prompt_included && !entry.agent_used) return "unused_exposed";
  return "unknown";
}

function admissionDatasetString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

type AdmissionDatasetPriorCounters = {
  supported: number;
  contradicted: number;
  rehydrateRequested: number;
};

function emptyAdmissionDatasetPriorCounters(): AdmissionDatasetPriorCounters {
  return {
    supported: 0,
    contradicted: 0,
    rehydrateRequested: 0,
  };
}

function closedLoopEffectStateFromPrior(
  prior: AdmissionDatasetPriorCounters,
): AionisMemoryAdmissionClosedLoopEffectState {
  if (prior.supported > 0 && prior.contradicted > 0) return "mixed";
  if (prior.contradicted > 0) return "contradicted";
  if (prior.supported > 0) return "supported";
  if (prior.rehydrateRequested > 0) return "rehydrate_requested";
  return "no_prior";
}

function admissionDatasetPriorKey(row: Pick<AionisMemoryAdmissionDatasetRow, "memory_id">): string | null {
  return admissionDatasetString(row.memory_id);
}

function updateAdmissionDatasetPriorCounters(
  prior: AdmissionDatasetPriorCounters,
  row: Pick<AionisMemoryAdmissionDatasetRow, "outcome_label">,
): AdmissionDatasetPriorCounters {
  const next = { ...prior };
  if (row.outcome_label === "positive_use") next.supported += 1;
  if (row.outcome_label === "negative_use") next.contradicted += 1;
  if (row.outcome_label === "rehydrate_requested") next.rehydrateRequested += 1;
  return next;
}

export function memoryAdmissionDatasetRowsWithClosedLoopPrior(
  rows: AionisMemoryAdmissionDatasetRow[],
): AionisMemoryAdmissionDatasetRow[] {
  const priorByMemoryId = new Map<string, AdmissionDatasetPriorCounters>();
  return rows.map((row) => {
    const key = admissionDatasetPriorKey(row);
    const prior = key ? (priorByMemoryId.get(key) ?? emptyAdmissionDatasetPriorCounters()) : emptyAdmissionDatasetPriorCounters();
    const enriched: AionisMemoryAdmissionDatasetRow = {
      ...row,
      prior_supported_use_count: prior.supported,
      prior_contradicted_use_count: prior.contradicted,
      prior_rehydrate_requested_count: prior.rehydrateRequested,
      closed_loop_effect_state: closedLoopEffectStateFromPrior(prior),
      repeated_negative_posture: prior.contradicted >= 2,
    };
    if (key) {
      priorByMemoryId.set(key, updateAdmissionDatasetPriorCounters(prior, row));
    }
    return enriched;
  });
}

function baseMemoryAdmissionDatasetRowsFromRecord(
  record: AionisMemoryAdmissionRecord,
  options: AionisMemoryAdmissionDatasetExportOptions = {},
): AionisMemoryAdmissionDatasetRow[] {
  return record.entries.map((entry, index) => ({
    contract_version: "aionis_memory_admission_dataset_row_v1",
    intended_use: "memory_admission_policy_training_or_audit",
    source: "memory_admission_record",
    agent_prompt_included: false,
    runtime_mutation: false,
    policy_id: admissionDatasetString(options.policy_id) ?? AIONIS_ADMISSION_POLICY_ID,
    policy_version: admissionDatasetString(options.policy_version) ?? AIONIS_ADMISSION_POLICY_VERSION,
    policy_mode: admissionDatasetString(options.policy_mode) ?? AIONIS_ADMISSION_POLICY_MODE,
    runtime_version: admissionDatasetString(options.runtime_version),
    tenant_id: admissionDatasetString(record.tenant_id),
    scope: admissionDatasetString(record.scope),
    guide_trace_id: admissionDatasetString(record.guide_trace_id),
    run_id: admissionDatasetString(options.run_id),
    task_id: admissionDatasetString(options.task_id),
    task_signature: admissionDatasetString(options.task_signature),
    row_index: index,
    memory_id: entry.memory_id,
    title: entry.title,
    memory_origin: entry.memory_origin ?? "aionis",
    source_backend: admissionDatasetString(entry.source_backend ?? null),
    domain: entry.domain,
    memory_type: entry.memory_type,
    lifecycle_state: entry.lifecycle_state,
    authority: entry.authority,
    admission_action: entry.admission_action,
    decision_kind: entry.decision_kind,
    actionable: entry.actionable,
    prompt_included: entry.prompt_included,
    agent_used: entry.agent_used,
    feedback_outcome: entry.feedback_outcome,
    attribution_strength: entry.attribution_strength,
    outcome_label: admissionDatasetOutcomeLabel(entry),
    reason_codes: [...entry.reason_codes],
    evidence_ids: [...entry.evidence_ids],
    prompt_char_count: record.prompt_char_count,
    history_used: record.history_used,
    actionable_history_used: record.actionable_history_used,
    prior_supported_use_count: 0,
    prior_contradicted_use_count: 0,
    prior_rehydrate_requested_count: 0,
    closed_loop_effect_state: "no_prior",
    repeated_negative_posture: false,
  }));
}

export function memoryAdmissionDatasetRowsFromRecord(
  record: AionisMemoryAdmissionRecord,
  options: AionisMemoryAdmissionDatasetExportOptions = {},
): AionisMemoryAdmissionDatasetRow[] {
  return memoryAdmissionDatasetRowsWithClosedLoopPrior(baseMemoryAdmissionDatasetRowsFromRecord(record, options));
}

export function memoryAdmissionDatasetRowsFromRecords(
  records: AionisMemoryAdmissionRecord[],
  options: AionisMemoryAdmissionDatasetExportOptions = {},
): AionisMemoryAdmissionDatasetRow[] {
  return memoryAdmissionDatasetRowsWithClosedLoopPrior(
    records.flatMap((record) => baseMemoryAdmissionDatasetRowsFromRecord(record, options)),
  );
}

export function memoryAdmissionDatasetRowsFromGuide(
  guide: unknown,
  options: AionisMemoryAdmissionDatasetExportOptions = {},
): AionisMemoryAdmissionDatasetRow[] {
  return memoryAdmissionDatasetRowsFromRecord(memoryAdmissionRecordFromGuide(guide), options);
}

export function memoryAdmissionDatasetJsonlFromRows(rows: AionisMemoryAdmissionDatasetRow[]): string {
  const enrichedRows = memoryAdmissionDatasetRowsWithClosedLoopPrior(rows);
  return enrichedRows.length > 0 ? `${enrichedRows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
}

export function memoryAdmissionDatasetJsonlFromRecord(
  record: AionisMemoryAdmissionRecord,
  options: AionisMemoryAdmissionDatasetExportOptions = {},
): string {
  return memoryAdmissionDatasetJsonlFromRows(memoryAdmissionDatasetRowsFromRecord(record, options));
}

export function memoryAdmissionDatasetJsonlFromRecords(
  records: AionisMemoryAdmissionRecord[],
  options: AionisMemoryAdmissionDatasetExportOptions = {},
): string {
  return memoryAdmissionDatasetJsonlFromRows(memoryAdmissionDatasetRowsFromRecords(records, options));
}

export function memoryAdmissionDatasetJsonlFromGuide(
  guide: unknown,
  options: AionisMemoryAdmissionDatasetExportOptions = {},
): string {
  return memoryAdmissionDatasetJsonlFromRows(memoryAdmissionDatasetRowsFromGuide(guide, options));
}

export function effectReportFromMeasure(measure: unknown): AionisEffectReport {
  const effectReport = asRecord(asRecord(measure)?.effect_report);
  if (!effectReport) {
    throw new Error("Aionis measure response is missing effect_report");
  }
  return effectReport as AionisEffectReport;
}

export function traceDerivedSkillCandidatesFromMeasure(
  measure: unknown,
): AionisTraceDerivedSkillTrainingCandidate[] {
  const candidates = asRecord(effectReportFromMeasure(measure))?.training_candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((candidate): candidate is AionisTraceDerivedSkillTrainingCandidate => {
    const record = asRecord(candidate);
    return record?.candidate_type === "trace_derived_skill"
      && asRecord(record.trace_derived_skill)?.contract_version === "aionis_trace_derived_skill_candidate_v1";
  });
}

export function traceDerivedSkillReviewItemsFromMeasure(
  measure: unknown,
): AionisTraceDerivedSkillReviewItem[] {
  return traceDerivedSkillCandidatesFromMeasure(measure).map((candidate) => {
    const skill = candidate.trace_derived_skill;
    return {
      candidate_type: "trace_derived_skill",
      review_action: "review_for_promotion",
      skill_name: skill.skill_name,
      label: candidate.label,
      export_ready: candidate.export_ready,
      promotion_status: skill.promotion_status,
      reason: candidate.reason,
      source_ids: candidate.source_ids,
      source_trace_ids: skill.source_trace_ids,
      source_signal_ids: skill.source_signal_ids,
      applies_when: skill.applies_when,
      does_not_apply_when: skill.does_not_apply_when,
      procedure_steps: skill.procedure_steps,
      target_files: skill.target_files,
      acceptance_checks: skill.acceptance_checks,
      failure_counterexamples: skill.failure_counterexamples,
      evidence_refs: skill.evidence_refs,
      safety: {
        authority_state: skill.authority_state,
        agent_prompt_included: skill.export_policy.agent_prompt_included,
        runtime_mutation: skill.export_policy.runtime_mutation,
        required_gate: skill.export_policy.required_gate,
      },
      candidate,
    };
  });
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
    ...routeContractMemoryIds(context?.route_contract),
  ];
  return Array.from(new Set(ids));
}

function actorFromGuide(guide: unknown): string | undefined {
  const record = asRecord(guide);
  const topLevel = coerceString(record?.consumer_agent_id);
  if (topLevel) return topLevel;
  const memoryPacketActor = asRecord(asRecord(record?.memory_packet)?.actor);
  const memoryPacketAgent = coerceString(memoryPacketActor?.consumer_agent_id);
  if (memoryPacketAgent) return memoryPacketAgent;
  const guidePacketActor = asRecord(asRecord(record?.guide_packet)?.actor);
  const guidePacketAgent = coerceString(guidePacketActor?.consumer_agent_id);
  return guidePacketAgent ?? undefined;
}

export function routeContractFromGuide(guide: unknown): AionisRouteContract | null {
  const contract = asRecord(asRecord(agentContextFromGuide(guide))?.route_contract);
  if (!contract) return null;
  return {
    active_targets: routeContractActiveTargetArray(contract.active_targets),
    pending_artifacts: routeContractPendingArtifactArray(contract.pending_artifacts),
    reference_only_targets: routeContractTargetArray(contract.reference_only_targets),
    blocked_direction_targets: routeContractTargetArray(contract.blocked_direction_targets),
    evidence_sources: routeContractEvidenceSourceArray(
      Array.isArray(contract.evidence_sources) ? contract.evidence_sources : contract.reference_only_targets,
    ),
    blocked_routes: routeContractBlockedRouteArray(
      Array.isArray(contract.blocked_routes) ? contract.blocked_routes : contract.blocked_direction_targets,
    ),
    conflict_policy: "do_not_treat_missing_active_target_as_superseded",
    fallback_policy: "do_not_promote_reference_or_blocked_targets",
    action_policy: routeContractActionPolicy(contract.action_policy),
  };
}

export function activeRouteTargetsFromGuide(guide: unknown): string[] {
  return routeContractFromGuide(guide)?.active_targets.map((entry) => entry.target) ?? [];
}

export function pendingArtifactTargetsFromGuide(guide: unknown): string[] {
  return routeContractFromGuide(guide)?.pending_artifacts.map((entry) => entry.target) ?? [];
}

export function referenceOnlyRouteTargetsFromGuide(guide: unknown): string[] {
  return routeContractFromGuide(guide)?.reference_only_targets.map((entry) => entry.target) ?? [];
}

export function blockedDirectionRouteTargetsFromGuide(guide: unknown): string[] {
  return routeContractFromGuide(guide)?.blocked_direction_targets.map((entry) => entry.target) ?? [];
}

export function evidenceSourcesFromGuide(guide: unknown): AionisRouteContractEvidenceSource[] {
  return routeContractFromGuide(guide)?.evidence_sources ?? [];
}

export function blockedRoutesFromGuide(guide: unknown): AionisRouteContractBlockedRoute[] {
  return routeContractFromGuide(guide)?.blocked_routes ?? [];
}

export function compileExecutionAgentContext(
  input: AionisExecutionAgentContextCompileInput,
): AionisCompiledExecutionAgentContext {
  const profile = input.budget_profile ?? "balanced";
  const promptFormat = input.prompt_format ?? "contract";
  const maxPromptChars = input.max_prompt_chars ?? defaultExecutionPromptBudget(profile);
  const basePrompt = safeAgentPromptFromGuide(input.guide);
  const routeContract = routeContractFromGuide(input.guide);
  const commandPosture = commandPostureFromGuide(input.guide);
  const receipt = memoryUseReceiptFromGuide(input.guide);
  const admissionRecord = memoryAdmissionRecordFromGuide(input.guide);
  const rehydrateRequests = rehydrateHintsFromGuide(input.guide);
  const evidenceBudget = executionEvidenceBudget(profile);
  const activePostures = new Set<AionisCommandPostureKind>(["should_continue"]);
  const blockedPostures = new Set<AionisCommandPostureKind>(["must_not"]);
  const routeStepLines = commandPostureEvidenceBullets({
    commandPosture,
    field: "workflow_steps",
    postures: activePostures,
    limit: evidenceBudget.items,
    maxChars: evidenceBudget.chars,
  });
  const acceptanceCheckLines = commandPostureEvidenceBullets({
    commandPosture,
    field: "acceptance_checks",
    postures: activePostures,
    limit: evidenceBudget.items,
    maxChars: evidenceBudget.chars,
  });
  const verificationLines = commandPostureEvidenceBullets({
    commandPosture,
    field: "verification_summary",
    postures: activePostures,
    limit: Math.max(1, Math.min(3, evidenceBudget.items)),
    maxChars: evidenceBudget.chars,
  });
  const artifactHintLines = commandPostureEvidenceBullets({
    commandPosture,
    field: "artifact_hints",
    postures: activePostures,
    limit: Math.max(1, Math.min(3, evidenceBudget.items)),
    maxChars: evidenceBudget.chars,
  });
  const failedBranchLines = commandPostureEvidenceBullets({
    commandPosture,
    field: "verification_summary",
    postures: blockedPostures,
    limit: Math.max(1, Math.min(3, evidenceBudget.items)),
    maxChars: evidenceBudget.chars,
  });
  const activeContextLines = promptFormat === "contract" ? agentContextTextBullets({
    guide: input.guide,
    field: "use_now",
    limit: evidenceBudget.items,
    maxChars: evidenceBudget.chars,
  }) : [];
  const blockedContextLines = promptFormat === "contract" ? agentContextTextBullets({
    guide: input.guide,
    field: "do_not_use",
    limit: Math.max(1, Math.min(3, evidenceBudget.items)),
    maxChars: evidenceBudget.chars,
  }) : [];
  const useNowMemoryIds = receipt.use_now_memory_ids;
  const inspectMemoryIds = receipt.inspect_before_use_memory_ids;
  const doNotUseMemoryIds = receipt.do_not_use_memory_ids;
  const activeTargets = routeContract ? targetList(routeContract.active_targets) : [];
  const pendingArtifacts = routeContract ? targetList(routeContract.pending_artifacts) : [];
  const referenceOnlyTargets = routeContract ? targetList(routeContract.evidence_sources.length > 0
    ? routeContract.evidence_sources
    : routeContract.reference_only_targets) : [];
  const blockedDirectionTargets = routeContract ? targetList(routeContract.blocked_routes.length > 0
    ? routeContract.blocked_routes
    : routeContract.blocked_direction_targets) : [];
  const presence = repoPresenceMap(input.repo_state);
  const missingActiveTargets = activeTargets.filter((target) => presence.get(target) === false);
  const warnings: AionisExecutionContextWarning[] = [];
  if (missingActiveTargets.length > 0) {
    warnings.push({
      code: "missing_active_target",
      message: "An active route target is absent in the observed workspace; treat it as pending work, not stale memory.",
      targets: missingActiveTargets,
    });
  }
  if (blockedDirectionTargets.length > 0) {
    warnings.push({
      code: "blocked_route_present",
      message: "Blocked or retired targets are counter-evidence only and must not become the primary route.",
      targets: blockedDirectionTargets,
    });
  }
  if (referenceOnlyTargets.length > 0) {
    warnings.push({
      code: "reference_only_target_present",
      message: "Reference-only targets may be inspected for evidence but must not be promoted into the chosen route.",
      targets: referenceOnlyTargets,
    });
  }
  if (rehydrateRequests.length > 0) {
    warnings.push({
      code: "rehydrate_recommended",
      message: "Aionis exposed rehydrate pointers for evidence that should be expanded before exact use.",
      memory_ids: rehydrateRequests.map((entry) => entry.memory_id),
    });
  }

  const contractSections = [
    "AIONIS_EXECUTION_AGENT_CONTEXT v1",
    "Treat this as the SDK-compiled execution-memory contract. Runtime remains the authority for memory admission.",
    "",
    "TASK",
    ...taskLines(input.task),
    ...(taskLines(input.task).length === 0 ? ["- Continue the current host task."] : []),
    "",
    "EXECUTION CONTRACT",
    "- Follow active targets and should_continue memories as the current execution route.",
    "- If an active target is missing, treat it as pending work to create or restore when task-consistent; do not fall back to blocked or reference-only paths because they exist.",
    "- Reference-only targets may be read for evidence, but they are not valid primary routes without explicit host confirmation.",
    "- Blocked, must_not, stale, failed, or retired routes are counter-evidence only.",
    "- If compact evidence is insufficient for a precise edit, request rehydrate instead of guessing.",
    ...(input.additional_instructions ?? []).map((entry) => `- ${entry}`),
    ...optionalPromptSection("ROUTE_STEPS", routeStepLines),
    ...optionalPromptSection("ACCEPTANCE_CHECKS", acceptanceCheckLines),
    ...optionalPromptSection("VERIFY_BEFORE_DONE", verificationLines),
    ...optionalPromptSection("ARTIFACT_HINTS", artifactHintLines),
    ...optionalPromptSection("KNOWN_FAILED_BRANCHES", failedBranchLines),
    ...optionalPromptSection("ACTIVE_CONTEXT", activeContextLines),
    ...optionalPromptSection("BLOCKED_CONTEXT", blockedContextLines),
    "",
    "ACTIVE_TARGETS",
    ...bulletLines(activeTargets, "none"),
    "",
    "MISSING_ACTIVE_TARGETS",
    ...bulletLines(missingActiveTargets, "none observed"),
    "",
    "PENDING_ARTIFACTS",
    ...bulletLines(pendingArtifacts, "none"),
    "",
    "SHOULD_CONTINUE",
    ...postureLines(commandPosture, "should_continue", "none"),
    "",
    "INSPECT_BEFORE_USE",
    ...postureLines(commandPosture, "inspect_first", "none"),
    "",
    "DO_NOT_USE",
    ...postureLines(commandPosture, "must_not", "none"),
    "",
    "REFERENCE_ONLY_TARGETS",
    ...bulletLines(referenceOnlyTargets, "none"),
    "",
    "BLOCKED_DIRECTION_TARGETS",
    ...bulletLines(blockedDirectionTargets, "none"),
    "",
    "REHYDRATE_REQUESTS",
    ...(rehydrateRequests.length > 0
      ? rehydrateRequests.map((entry) => `- ${entry.memory_id}${entry.reason ? `: ${entry.reason}` : ""}`)
      : ["- none"]),
  ];
  const contractPrompt = contractSections.join("\n");
  const agentPrompt = promptFormat === "runtime_compact"
    ? truncateText(basePrompt, maxPromptChars)
    : truncateText(contractPrompt, maxPromptChars);

  return {
    contract_version: "aionis_execution_agent_context_v1",
    prompt_format: promptFormat,
    budget_profile: profile,
    agent_prompt: agentPrompt,
    base_prompt: basePrompt,
    prompt_char_count: agentPrompt.length,
    route_contract: routeContract,
    command_posture: commandPosture,
    memory_use_receipt: receipt,
    memory_admission_record: admissionRecord,
    rehydrate_requests: rehydrateRequests,
    use_now_memory_ids: useNowMemoryIds,
    inspect_before_use_memory_ids: inspectMemoryIds,
    do_not_use_memory_ids: doNotUseMemoryIds,
    active_targets: activeTargets,
    missing_active_targets: missingActiveTargets,
    pending_artifacts: pendingArtifacts,
    reference_only_targets: referenceOnlyTargets,
    blocked_direction_targets: blockedDirectionTargets,
    execution_warnings: warnings,
  };
}

export function compileCodingAgentContext(
  input: AionisExecutionAgentContextCompileInput,
): AionisCompiledExecutionAgentContext {
  return compileExecutionAgentContext(input);
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

export function feedbackFromGuide(input: AionisFeedbackFromGuideInput): AionisFeedbackRequest {
  const guide = asRecord(input.guide);
  const guideTraceId = guide?.guide_trace_id;
  if (typeof guideTraceId !== "string" || guideTraceId.length === 0) {
    throw new Error("feedbackFromGuide requires guide.guide_trace_id");
  }
  if (input.used_memory_ids.length === 0) {
    throw new Error("feedbackFromGuide requires at least one host-used memory id");
  }
  const exposedMemoryIds = new Set(memoryIdsFromGuide(input.guide));
  const unexposed = input.used_memory_ids.filter((id) => !exposedMemoryIds.has(id));
  if (unexposed.length > 0) {
    throw new Error(`feedbackFromGuide received memory ids not exposed by guide: ${unexposed.join(", ")}`);
  }
  return stripUndefined({
    reason: input.reason,
    run_id: input.run_id,
    outcome: input.outcome,
    used_surface: input.used_surface ?? "use_now",
    actor: input.actor ?? actorFromGuide(input.guide),
    guide_trace_id: guideTraceId,
    used_memory_ids: input.used_memory_ids,
    verifier_status: input.verifier_status,
    tool_status: input.tool_status,
    runtime_signal_refs: input.runtime_signal_refs,
  }) as AionisFeedbackRequest;
}

export function measureInputFromGuideLoop(input: AionisMeasureFromGuideLoopInput): AionisJsonObject {
  return stripUndefined({
    tenant_id: input.tenant_id,
    scope: input.scope,
    task: stripUndefined({
      task_id: input.task.task_id,
      run_id: input.task.run_id,
      task_signature: input.task.task_signature,
      task_family: input.task.task_family,
      workflow_signature: input.task.workflow_signature,
    }),
    product_trace: stripUndefined({
      before_guide: input.before_guide,
      after_guide: input.after_guide,
      forget_result: input.feedback_result,
      sufficient_evidence: input.sufficient_evidence,
      evidence_ids: input.evidence_ids,
      ...(input.product_trace ?? {}),
    }),
  });
}

export function snapshotInputFromGuideLoop(input: AionisSnapshotFromGuideLoopInput): AionisJsonObject {
  const guide = asRecord(input.guide);
  const measure = asRecord(input.measure_result);
  if (!guide) throw new Error("snapshotInputFromGuideLoop requires a guide response object");
  if (!measure) throw new Error("snapshotInputFromGuideLoop requires a measure result object");
  return stripUndefined({
    tenant_id: input.tenant_id,
    scope: input.scope,
    run_id: input.run_id,
    task_signature: input.task_signature,
    task_family: input.task_family,
    agent_context: agentContextFromGuide(input.guide),
    guide_packet: guide.guide_packet,
    memory_decision_trace: measure.memory_decision_trace,
    memory_decision_audit: measure.memory_decision_audit,
    effect_report: measure.effect_report,
    guide_trace_id: guide.guide_trace_id,
    include_markdown: input.include_markdown,
    ...(input.extra ?? {}),
  });
}
