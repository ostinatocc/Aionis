import type { ExecutionContractV1 } from "../memory/execution-contract.js";
import type {
  RuntimeEntropyControlsV1,
  RuntimeEntropyProfileV1,
} from "../memory/schemas.js";

export {
  buildAssemblySummary,
  buildExecutionSummarySurface,
  buildPlanningSummary,
} from "./planning-summary-assembly.js";

export {
  buildExecutionMemorySummaryBundle,
  isPromotionReadyWorkflowSignal,
  summarizeActionRecallPacket,
  summarizeActionRecallPacketSurface,
  summarizeAuthorityVisibilitySurface,
  summarizeContinuityCarrierSurface,
  summarizeDistillationSignalSurface,
  summarizePatternLifecycleSurface,
  summarizePatternMaintenanceSurface,
  summarizePatternSignalSurface,
  summarizePatternSignals,
  summarizePolicyLifecycleSurface,
  summarizePolicyMaintenanceSurface,
  summarizeWorkflowLifecycleSurface,
  summarizeWorkflowMaintenanceSurface,
  summarizeWorkflowSignalSurface,
} from "./planning-summary-surfaces.js";

export type PlanningSummary = {
  summary_version: "planning_summary_v1";
  planner_explanation: string | null;
  continuity_guidance: ContinuityGuidance | null;
  action_intelligence_pre_action_gate: ActionIntelligencePreActionGateSummary | null;
  runtime_entropy_profile: RuntimeEntropyProfileV1 | null;
  runtime_entropy_controls: RuntimeEntropyControlsV1 | null;
  action_retrieval_uncertainty: ActionRetrievalUncertaintySummary | null;
  action_retrieval_gate: ActionRetrievalGateSummary | null;
  history_impact_summary: HistoryImpactSummary;
  selected_tool: string | null;
  decision_id: string | null;
  rules_considered: number;
  rules_matched: number;
  context_est_tokens: number;
  layered_output: boolean;
  forgotten_items: number;
  static_blocks_selected: number;
  selected_memory_layers: string[];
  optimization_profile: "balanced" | "aggressive" | null;
  context_compaction_profile: "balanced" | "aggressive";
  recall_mode?: string | null;
  trusted_pattern_count: number;
  contested_pattern_count: number;
  trusted_pattern_tools: string[];
  contested_pattern_tools: string[];
  workflow_signal_summary: WorkflowSignalSummary;
  action_packet_summary: ActionPacketSummary;
  workflow_lifecycle_summary: WorkflowLifecycleSummary;
  workflow_maintenance_summary: WorkflowMaintenanceSummary;
  authority_visibility_summary: AuthorityVisibilitySummary;
  distillation_signal_summary: DistillationSignalSummary;
  pattern_lifecycle_summary: PatternLifecycleSummary;
  pattern_maintenance_summary: PatternMaintenanceSummary;
  policy_lifecycle_summary: PolicyLifecycleSummary;
  policy_maintenance_summary: PolicyMaintenanceSummary;
  continuity_carrier_summary: ContinuityCarrierSummary;
  forgetting_summary: ExecutionForgettingSummary;
  primary_savings_levers: string[];
};

export type AssemblySummary = {
  summary_version: "assembly_summary_v1";
  planner_explanation: string | null;
  continuity_guidance: ContinuityGuidance | null;
  action_intelligence_pre_action_gate: ActionIntelligencePreActionGateSummary | null;
  runtime_entropy_profile: RuntimeEntropyProfileV1 | null;
  runtime_entropy_controls: RuntimeEntropyControlsV1 | null;
  action_retrieval_uncertainty: ActionRetrievalUncertaintySummary | null;
  action_retrieval_gate: ActionRetrievalGateSummary | null;
  history_impact_summary: HistoryImpactSummary;
  selected_tool: string | null;
  decision_id: string | null;
  rules_considered: number;
  rules_matched: number;
  include_rules: boolean;
  context_est_tokens: number;
  layered_output: boolean;
  forgotten_items: number;
  static_blocks_selected: number;
  selected_memory_layers: string[];
  optimization_profile: "balanced" | "aggressive" | null;
  context_compaction_profile: "balanced" | "aggressive";
  recall_mode?: string | null;
  trusted_pattern_count: number;
  contested_pattern_count: number;
  trusted_pattern_tools: string[];
  contested_pattern_tools: string[];
  workflow_signal_summary: WorkflowSignalSummary;
  action_packet_summary: ActionPacketSummary;
  workflow_lifecycle_summary: WorkflowLifecycleSummary;
  workflow_maintenance_summary: WorkflowMaintenanceSummary;
  authority_visibility_summary: AuthorityVisibilitySummary;
  distillation_signal_summary: DistillationSignalSummary;
  pattern_lifecycle_summary: PatternLifecycleSummary;
  pattern_maintenance_summary: PatternMaintenanceSummary;
  policy_lifecycle_summary: PolicyLifecycleSummary;
  policy_maintenance_summary: PolicyMaintenanceSummary;
  continuity_carrier_summary: ContinuityCarrierSummary;
  forgetting_summary: ExecutionForgettingSummary;
  primary_savings_levers: string[];
};

export type ContinuityGuidance = {
  source_kind: "experience_intelligence" | "tool_selection";
  history_applied: boolean;
  contract_trust: ContractTrust;
  execution_contract_v1: ExecutionContractV1 | null;
  continuity_signal_v1: RuntimeContinuitySignal | null;
  edit_boundary_v1: RuntimeEditBoundaryRecommendation | null;
  verification_repair_v1: RuntimeVerificationRepairRecommendation | null;
  selected_tool: string | null;
  task_family: string | null;
  workflow_signature: string | null;
  policy_memory_id: string | null;
  file_path: string | null;
  next_action: string | null;
};

export type ContractTrust = "authoritative" | "advisory" | "observational";

export type HistoryImpactCapability =
  | "continuity"
  | "learning"
  | "forgetting"
  | "learning_control";

export type HistoryImpactLevel =
  | "none"
  | "context_shaping"
  | "action_shaping"
  | "learning_controlled";

export type HistoryImpactNextRunChange =
  | "continuity_state_available"
  | "trusted_evidence_available"
  | "workflow_reuse_available"
  | "candidate_learning_visible"
  | "contested_memory_visible"
  | "memory_suppressed_or_forgotten"
  | "rehydration_available"
  | "learning_control_limited_authority"
  | "continuity_signal_shaped_by_history"
  | "runtime_entropy_visible";

export type HistoryImpactSummary = {
  summary_version: "history_impact_summary_v1";
  history_applied: boolean;
  changed_next_run: boolean;
  impact_level: HistoryImpactLevel;
  affected_capabilities: HistoryImpactCapability[];
  continuity: {
    continuity_carrier_count: number;
    static_blocks_selected: number;
    selected_memory_layer_count: number;
  };
  learning: {
    stable_workflow_count: number;
    candidate_workflow_count: number;
    promotion_ready_workflow_count: number;
    trusted_pattern_count: number;
    contested_pattern_count: number;
    active_policy_count: number;
    contested_policy_count: number;
  };
  forgetting: {
    substrate_mode: ExecutionForgettingSummary["substrate_mode"];
    forgotten_items: number;
    suppressed_pattern_count: number;
    differential_rehydration_candidate_count: number;
    stale_signal_count: number;
  };
  learning_control: {
    contract_trust: ContractTrust | null;
    action_start_blocked: boolean;
    authoritative_allowed_count: number;
    authoritative_blocked_count: number;
    stable_promotion_allowed_count: number;
    stable_promotion_blocked_count: number;
    primary_blockers: string[];
  };
  runtime_entropy: {
    profile_present: boolean;
    controls_present: boolean;
    entropy_level: RuntimeEntropyProfileV1["entropy_level"] | null;
    plasticity_level: RuntimeEntropyProfileV1["plasticity_level"] | null;
    exploration_budget: number | null;
    control_strength: number | null;
  };
  next_run_changes: HistoryImpactNextRunChange[];
  primary_reason: string;
};

export type RuntimeContinuitySignalKind =
  | "read_file"
  | "inspect_context"
  | "widen_recall"
  | "rehydrate_payload"
  | "request_operator_review";

export type RuntimeContinuitySignal = {
  summary_version: "runtime_continuity_signal_v1";
  action: RuntimeContinuitySignalKind;
  priority: "required" | "recommended";
  contract_trust: ContractTrust;
  tool_name: string | null;
  learned_tool: string | null;
  file_path: string | null;
  target_files: string[];
  reason: string;
  instruction: string;
};

export type RuntimeEditBoundaryContext = {
  allowed_edit_files?: string[];
  forbidden_edit_files?: string[];
  required_verifiers?: string[];
  anti_shortcut_rules?: string[];
};

export type RuntimeEditBoundaryRecommendation = {
  summary_version: "runtime_edit_boundary_v1";
  contract_trust: ContractTrust;
  allowed_edit_files: string[];
  forbidden_edit_files: string[];
  required_verifiers: string[];
  anti_shortcut_rules: string[];
  reason: string;
  instruction: string;
};

export type RuntimeVerificationRepairFileHint = {
  path: string;
  line: number | null;
  column: number | null;
  message: string | null;
};

export type RuntimeVerifierFailurePhaseKind =
  | "hidden_contract_failure"
  | "authored_test_failure"
  | "lint_type_failure"
  | "provider_failure"
  | "tool_protocol_failure"
  | "edit_operation_failure"
  | "environment_failure"
  | "unknown_verifier_failure";

export type RuntimeVerifierFailurePhaseAction =
  | "read_file"
  | "replace_text"
  | "replace_lines"
  | "apply_patch"
  | "run_command"
  | "request_operator_review";

export type RuntimeVerifierFailurePhaseRestriction =
  | "list_files"
  | "search"
  | "edit_unrelated_files"
  | "run_unrelated_command"
  | "write_tests_only"
  | "persist_learning";

export type RuntimeVerifierFailurePhase = {
  summary_version: "verifier_failure_phase_v1";
  phase: RuntimeVerifierFailurePhaseKind;
  confidence: number;
  primary_reason: string;
  failing_command: string | null;
  primary_files: string[];
  line_hints: RuntimeVerificationRepairFileHint[];
  allowed_next_actions: RuntimeVerifierFailurePhaseAction[];
  forbidden_next_actions: RuntimeVerifierFailurePhaseRestriction[];
  recommended_focus: string;
};

export type RuntimeEditFailurePhaseKind =
  | "stale_line_anchor"
  | "unchanged_edit"
  | "apply_patch_payload_failure"
  | "replace_text_anchor_failure"
  | "replace_lines_payload_failure"
  | "edit_policy_block"
  | "edit_tool_schema_failure"
  | "edit_operation_failure";

export type RuntimeEditFailureTool =
  | "replace_text"
  | "replace_lines"
  | "apply_patch";

export type RuntimeEditFailurePhaseRestriction =
  | "list_files"
  | "search"
  | "edit_unrelated_files"
  | "run_unrelated_command"
  | "reuse_stale_anchor"
  | "repeat_same_edit"
  | "repeat_same_patch"
  | "persist_learning";

export type RuntimeEditFailurePhase = {
  summary_version: "edit_failure_phase_v1";
  phase: RuntimeEditFailurePhaseKind;
  confidence: number;
  source_tool: RuntimeEditFailureTool;
  failure_count: number;
  primary_file: string | null;
  line_hints: RuntimeVerificationRepairFileHint[];
  allowed_next_actions: RuntimeVerifierFailurePhaseAction[];
  forbidden_next_actions: RuntimeEditFailurePhaseRestriction[];
  recommended_focus: string;
  evidence_summary: string;
};

export type RuntimeVerificationRepairRecommendation = {
  summary_version: "runtime_verification_repair_v1";
  priority: "required" | "recommended";
  contract_trust: ContractTrust;
  failed_verifier_count: number;
  failed_commands: string[];
  categories: string[];
  affected_files: RuntimeVerificationRepairFileHint[];
  verifier_failure_phase_v1: RuntimeVerifierFailurePhase;
  edit_failure_phase_v1: RuntimeEditFailurePhase | null;
  failed_tool_schema_hints: string[];
  next_actions: string[];
  reason: string;
  instruction: string;
};

export type ActionRetrievalUncertaintySummary = {
  summary_version: "action_retrieval_uncertainty_v1";
  level: "low" | "moderate" | "high";
  confidence: number;
  evidence_gap_count: number;
  reasons: string[];
  recommended_actions: Array<
    "proceed"
    | "widen_recall"
    | "rehydrate_payload"
    | "inspect_context"
    | "request_operator_review"
  >;
};

export type ActionRetrievalGateAction =
  | "inspect_context"
  | "widen_recall"
  | "rehydrate_payload"
  | "request_operator_review";

export type ActionIntelligencePreActionGateSummary = {
  gate_version: "action_intelligence_pre_action_gate_v1";
  known_enough: boolean;
  requires_recall: boolean;
  requires_rehydration: boolean;
  requires_operator_review: boolean;
  authority_blocked: boolean;
  uncertainty_level: "low" | "moderate" | "high";
  confidence: number;
  recommended_actions: Array<
    "proceed"
    | "widen_recall"
    | "rehydrate_payload"
    | "inspect_context"
    | "request_operator_review"
  >;
  primary_reason: string | null;
};

export type ActionRetrievalGateRehydrationHint = {
  anchor_id: string | null;
  anchor_kind: string | null;
  anchor_level: string | null;
  title: string | null;
  summary: string | null;
  mode: "summary_only" | "partial" | "full" | "differential" | null;
  example_call: string | null;
  payload_cost_hint: "low" | "medium" | "high" | null;
};

export type ActionRetrievalGateSummary = {
  summary_version: "action_retrieval_gate_v1";
  gate_action: ActionRetrievalGateAction;
  escalates_task_start: boolean;
  confidence: number;
  primary_reason: string | null;
  recommended_actions: ActionRetrievalGateAction[];
  instruction: string | null;
  rehydration_candidate_count: number;
  preferred_rehydration: ActionRetrievalGateRehydrationHint | null;
};

export type PatternSignalSummary = {
  candidate_pattern_count: number;
  candidate_pattern_tools: string[];
  trusted_pattern_count: number;
  contested_pattern_count: number;
  trusted_pattern_tools: string[];
  contested_pattern_tools: string[];
};

export type WorkflowSignalSummary = {
  stable_workflow_count: number;
  promotion_ready_workflow_count: number;
  observing_workflow_count: number;
  stable_workflow_titles: string[];
  promotion_ready_workflow_titles: string[];
  observing_workflow_titles: string[];
};

export type PlannerPacketSummarySurface = {
  action_recall_packet?: unknown;
  pattern_signals?: unknown;
  workflow_signals?: unknown;
  recommended_workflows?: unknown;
  candidate_workflows?: unknown;
  authority_visibility_summary?: unknown;
  candidate_patterns?: unknown;
  trusted_patterns?: unknown;
  contested_patterns?: unknown;
  rehydration_candidates?: unknown;
  supporting_knowledge?: unknown;
};

export type PatternLifecycleSummary = {
  candidate_count: number;
  trusted_count: number;
  contested_count: number;
  near_promotion_count: number;
  counter_evidence_open_count: number;
  transition_counts: {
    candidate_observed: number;
    promoted_to_trusted: number;
    counter_evidence_opened: number;
    revalidated_to_trusted: number;
  };
};

export type PatternMaintenanceSummary = {
  model: "lazy_online_v1";
  observe_count: number;
  retain_count: number;
  review_count: number;
  promote_candidate_count: number;
  review_counter_evidence_count: number;
  retain_trusted_count: number;
};

export type WorkflowLifecycleSummary = {
  candidate_count: number;
  stable_count: number;
  replay_source_count: number;
  rehydration_ready_count: number;
  promotion_ready_count: number;
  transition_counts: {
    candidate_observed: number;
    promoted_to_stable: number;
    normalized_latest_stable: number;
  };
};

export type WorkflowMaintenanceSummary = {
  model: "lazy_online_v1";
  observe_count: number;
  retain_count: number;
  promote_candidate_count: number;
  retain_workflow_count: number;
};

export type AuthorityVisibilitySummary = {
  summary_version: "runtime_authority_visibility_summary_v1";
  surface_count: number;
  sufficient_count: number;
  insufficient_count: number;
  authoritative_allowed_count: number;
  authoritative_blocked_count: number;
  stable_promotion_allowed_count: number;
  stable_promotion_blocked_count: number;
  execution_evidence_failed_count: number;
  execution_evidence_incomplete_count: number;
  false_confidence_count: number;
  reason_counts: Record<string, number>;
  top_blockers: string[];
};

export type DistillationSignalSummary = {
  distilled_evidence_count: number;
  distilled_fact_count: number;
  projected_workflow_candidate_count: number;
  origin_counts: {
    write_distillation_input_text: number;
    write_distillation_event_node: number;
    write_distillation_evidence_node: number;
    execution_write_projection: number;
    handoff_continuity_carrier: number;
    session_event_continuity_carrier: number;
    session_continuity_carrier: number;
    replay_learning_episode: number;
  };
  promotion_target_counts: {
    workflow: number;
    pattern: number;
    policy: number;
  };
};

export type PolicyLifecycleSummary = {
  persisted_count: number;
  active_count: number;
  contested_count: number;
  retired_count: number;
  default_mode_count: number;
  hint_mode_count: number;
  stable_policy_count: number;
  transition_counts: {
    materialized: number;
    refreshed: number;
    contested_by_feedback: number;
    retired_by_feedback: number;
    retired_by_learning_control: number;
    reactivated_by_learning_control: number;
  };
};

export type PolicyMaintenanceSummary = {
  model: "lazy_online_v1";
  observe_count: number;
  retain_count: number;
  review_count: number;
  promote_to_default_count: number;
  retain_active_policy_count: number;
  review_contested_policy_count: number;
  retire_policy_count: number;
  reactivate_policy_count: number;
};

export type ContinuityCarrierSummary = {
  total_count: number;
  handoff_count: number;
  session_event_count: number;
  session_count: number;
};

export type ActionPacketSummary = {
  recommended_workflow_count: number;
  candidate_workflow_count: number;
  candidate_pattern_count: number;
  trusted_pattern_count: number;
  contested_pattern_count: number;
  rehydration_candidate_count: number;
  supporting_knowledge_count: number;
  workflow_anchor_ids: string[];
  candidate_workflow_anchor_ids: string[];
  candidate_pattern_anchor_ids: string[];
  trusted_pattern_anchor_ids: string[];
  contested_pattern_anchor_ids: string[];
  rehydration_anchor_ids: string[];
};

export type ExecutionMemorySummaryBundle = {
  pattern_signal_summary: PatternSignalSummary;
  workflow_signal_summary: WorkflowSignalSummary;
  workflow_lifecycle_summary: WorkflowLifecycleSummary;
  workflow_maintenance_summary: WorkflowMaintenanceSummary;
  authority_visibility_summary: AuthorityVisibilitySummary;
  distillation_signal_summary: DistillationSignalSummary;
  pattern_lifecycle_summary: PatternLifecycleSummary;
  pattern_maintenance_summary: PatternMaintenanceSummary;
  policy_lifecycle_summary: PolicyLifecycleSummary;
  policy_maintenance_summary: PolicyMaintenanceSummary;
  continuity_carrier_summary: ContinuityCarrierSummary;
  action_packet_summary: ActionPacketSummary;
};

export type ExecutionPacketAssemblySummary = {
  packet_source_mode: string | null;
  state_first_assembly: boolean | null;
  execution_packet_v1_present: boolean | null;
  execution_state_v1_present: boolean | null;
};

export type ExecutionStrategySummary = {
  summary_version: "execution_strategy_summary_v1";
  trust_signal: string;
  strategy_profile: string;
  validation_style: string;
  task_family: string | null;
  family_scope: string;
  family_candidate_count: number;
  selected_working_set: string[];
  selected_validation_paths: string[];
  selected_pattern_summaries: string[];
  preferred_artifact_refs: string[];
  explanation: string;
};

export type ExecutionCollaborationSummary = {
  summary_version: "execution_collaboration_summary_v1";
  packet_present: boolean;
  coordination_mode: string;
  current_stage: string | null;
  active_role: string | null;
  next_action: string | null;
  target_file_count: number;
  pending_validation_count: number;
  unresolved_blocker_count: number;
  review_contract_present: boolean;
  review_standard: string | null;
  acceptance_check_count: number;
  rollback_required: boolean;
  resume_anchor_present: boolean;
  resume_anchor_file_path: string | null;
  resume_anchor_symbol: string | null;
  artifact_ref_count: number;
  evidence_ref_count: number;
  side_output_artifact_count: number;
  side_output_evidence_count: number;
  artifact_refs: string[];
  evidence_refs: string[];
};

export type ExecutionContinuitySnapshotSummary = {
  summary_version: "execution_continuity_snapshot_v1";
  snapshot_mode: "memory_only" | "packet_backed";
  coordination_mode: string;
  trust_signal: string;
  strategy_profile: string;
  validation_style: string;
  task_family: string | null;
  family_scope: string;
  selected_tool: string | null;
  current_stage: string | null;
  active_role: string | null;
  next_action: string | null;
  working_set: string[];
  validation_paths: string[];
  selected_pattern_summaries: string[];
  preferred_artifact_refs: string[];
  preferred_evidence_refs: string[];
  reviewer_ready: boolean;
  resume_anchor_file_path: string | null;
  selected_memory_layers: string[];
  recommended_action: string;
};

export type ExecutionForgettingSummary = {
  summary_version: "execution_forgetting_summary_v1";
  substrate_mode: "stable" | "suppression_present" | "forgetting_active";
  forgotten_items: number;
  forgotten_by_reason: Record<string, number>;
  primary_forgetting_reason: string | null;
  suppressed_pattern_count: number;
  suppressed_pattern_anchor_ids: string[];
  suppressed_pattern_sources: string[];
  selected_memory_layers: string[];
  semantic_action_counts: {
    retain: number;
    demote: number;
    archive: number;
    review: number;
  };
  lifecycle_state_counts: {
    active: number;
    contested: number;
    retired: number;
    archived: number;
  };
  archive_relocation_state_counts: {
    none: number;
    candidate: number;
    cold_archive: number;
  };
  archive_relocation_target_counts: {
    none: number;
    local_cold_store: number;
    external_object_store: number;
  };
  archive_payload_scope_counts: {
    none: number;
    anchor_payload: number;
    node: number;
  };
  rehydration_mode_counts: {
    summary_only: number;
    partial: number;
    full: number;
    differential: number;
  };
  differential_rehydration_candidate_count: number;
  primary_savings_levers: string[];
  stale_signal_count: number;
  recommended_action: string;
};

export type ExecutionCollaborationRoutingSummary = {
  summary_version: "execution_collaboration_routing_v1";
  route_mode: "memory_only" | "packet_backed";
  coordination_mode: string;
  route_intent: string;
  task_brief: string | null;
  current_stage: string | null;
  active_role: string | null;
  selected_tool: string | null;
  task_family: string | null;
  family_scope: string;
  next_action: string | null;
  target_files: string[];
  validation_paths: string[];
  unresolved_blockers: string[];
  hard_constraints: string[];
  review_standard: string | null;
  required_outputs: string[];
  acceptance_checks: string[];
  preferred_artifact_refs: string[];
  preferred_evidence_refs: string[];
  routing_drivers: string[];
};

export type ExecutionDelegationPacketRecord = {
  version: 1;
  role: string;
  mission: string;
  working_set: string[];
  acceptance_checks: string[];
  output_contract: string;
  preferred_artifact_refs: string[];
  inherited_evidence: string[];
  routing_reason: string;
  task_family: string | null;
  family_scope: string;
  source_mode: "memory_only" | "packet_backed";
};

export type ExecutionDelegationReturnRecord = {
  version: 1;
  role: string;
  status: string;
  summary: string;
  evidence: string[];
  working_set: string[];
  acceptance_checks: string[];
  source_mode: "memory_only" | "packet_backed";
};

export type ExecutionArtifactRoutingRecord = {
  version: 1;
  ref: string;
  ref_kind: "artifact" | "evidence";
  route_role: string;
  route_intent: string;
  route_mode: "memory_only" | "packet_backed";
  task_family: string | null;
  family_scope: string;
  routing_reason: string;
  source: "strategy_summary" | "execution_packet" | "collaboration_summary";
};

export type ExecutionDelegationRecordsSummary = {
  summary_version: "execution_delegation_records_v1";
  record_mode: "memory_only" | "packet_backed";
  route_role: string;
  packet_count: number;
  return_count: number;
  artifact_routing_count: number;
  missing_record_types: string[];
  delegation_packets: ExecutionDelegationPacketRecord[];
  delegation_returns: ExecutionDelegationReturnRecord[];
  artifact_routing_records: ExecutionArtifactRoutingRecord[];
};

export type ExecutionRoutingSignalSummary = {
  summary_version: "execution_routing_summary_v1";
  selected_tool: string | null;
  task_family: string | null;
  family_scope: string;
  stable_workflow_anchor_ids: string[];
  candidate_workflow_anchor_ids: string[];
  rehydration_anchor_ids: string[];
  workflow_source_kinds: string[];
  same_family_rehydration_anchor_ids: string[];
  other_family_rehydration_anchor_ids: string[];
  unknown_family_rehydration_anchor_ids: string[];
};

export type ExecutionMaintenanceSummary = {
  summary_version: "execution_maintenance_summary_v1";
  forgotten_items: number;
  forgotten_by_reason: Record<string, number>;
  suppressed_pattern_count: number;
  stable_workflow_count: number;
  promotion_ready_workflow_count: number;
  selected_memory_layers: string[];
  primary_savings_levers: string[];
  recommended_action: string;
};

export type ExecutionInstrumentationSummary = {
  summary_version: "execution_instrumentation_summary_v1";
  task_family: string | null;
  family_scope: string;
  family_hit: boolean;
  family_reason: string;
  selected_pattern_hit_count: number;
  selected_pattern_miss_count: number;
  rehydration_candidate_count: number;
  known_family_rehydration_count: number;
  same_family_rehydration_count: number;
  other_family_rehydration_count: number;
  unknown_family_rehydration_count: number;
  rehydration_family_hit_rate: number;
  same_family_rehydration_anchor_ids: string[];
  other_family_rehydration_anchor_ids: string[];
};

export type ExecutionSummary = ExecutionMemorySummaryBundle & {
  summary_version: "execution_summary_v1";
  planner_packet: unknown | null;
  pattern_signals: unknown[];
  workflow_signals: unknown[];
  packet_assembly: ExecutionPacketAssemblySummary;
  strategy_summary: ExecutionStrategySummary;
  collaboration_summary: ExecutionCollaborationSummary;
  continuity_snapshot_summary: ExecutionContinuitySnapshotSummary;
  routing_signal_summary: ExecutionRoutingSignalSummary;
  maintenance_summary: ExecutionMaintenanceSummary;
  forgetting_summary: ExecutionForgettingSummary;
  collaboration_routing_summary: ExecutionCollaborationRoutingSummary;
  delegation_records_summary: ExecutionDelegationRecordsSummary;
  instrumentation_summary: ExecutionInstrumentationSummary;
};
