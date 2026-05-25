import type { AionisRequestPayload } from "./types.js";

export type AionisPassthroughObject = Record<string, unknown>;
export type AionisRuntimeResponse = AionisPassthroughObject;

export type AionisRuntimeBoundaryInventoryAuthorityEntry = {
  source: "authority";
  inventory_id: string;
  source_id: string;
  file: string;
  layer: "Contract Compiler" | "Trust Gate" | "Orchestrator" | "Learning Loop" | "Schema Boundary";
  role:
    | "registry_manifest"
    | "trust_gate_evaluator"
    | "authority_producer"
    | "authority_consumer"
    | "advisory_pattern_producer"
    | "read_side_summary"
    | "schema_boundary";
  producer_kind: "stable_workflow" | "authoritative_policy" | "advisory_pattern" | null;
  capabilities: {
    may_use_runtime_authority_gate: boolean;
    may_use_outcome_contract_gate: boolean;
    may_assess_execution_evidence: boolean;
    may_read_raw_authority_surface: boolean;
    may_use_stable_workflow_literal: boolean;
    may_use_stable_pattern_literal: boolean;
  };
  required_source_markers: string[];
};

export type AionisRuntimeBoundaryInventoryEntry = AionisRuntimeBoundaryInventoryAuthorityEntry;

export type AionisRuntimeBoundaryInventoryResponse = {
  surface_version: "runtime_boundary_inventory_response_v1";
  inventory_source: "source_boundary_manifests";
  surface_semantics: {
    read_only: true;
    persistence_effect: "none";
    authority_effect: "none";
    runtime_decision_effect: "none";
    intended_use: "operator_debug_boundary_audit";
  };
  summary: {
    total_entries: number;
    total_files: number;
    authority_entries: number;
    authority_producer_entries: number;
  };
  files: string[];
  entries: AionisRuntimeBoundaryInventoryEntry[];
  sources: {
    authority: AionisRuntimeBoundaryInventoryAuthorityEntry[];
  };
};

export type AionisWriteNode = {
  id?: string;
  client_id?: string;
  scope?: string;
  type: "event" | "entity" | "topic" | "rule" | "evidence" | "concept" | "procedure" | "self_model";
  tier?: "hot" | "warm" | "cold" | "archive";
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  title?: string;
  text_summary?: string;
  slots?: Record<string, unknown>;
  raw_ref?: string;
  evidence_ref?: string;
  embedding?: number[];
  embedding_model?: string;
  salience?: number;
  importance?: number;
  confidence?: number;
} & AionisPassthroughObject;

export type AionisWriteEdge = {
  id?: string;
  scope?: string;
  type: "part_of" | "related_to" | "derived_from";
  src: { id?: string; client_id?: string };
  dst: { id?: string; client_id?: string };
  weight?: number;
  confidence?: number;
  decay_rate?: number;
} & AionisPassthroughObject;

export type AionisMemoryWriteRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  parent_commit_id?: string;
  input_text?: string;
  input_sha256?: string;
  model_version?: string;
  prompt_version?: string;
  auto_embed?: boolean;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  force_reembed?: boolean;
  trigger_topic_cluster?: boolean;
  topic_cluster_async?: boolean;
  distill?: Record<string, unknown>;
  nodes?: AionisWriteNode[];
  edges?: AionisWriteEdge[];
} & AionisRequestPayload;

export type AionisMemoryWriteResponse = {
  tenant_id?: string;
  scope?: string;
  commit_id: string;
  commit_uri?: string;
  commit_hash?: string;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
} & AionisRuntimeResponse;

export type AionisMemoryRecallRequest = {
  tenant_id?: string;
  scope?: string;
  query_embedding: number[];
  recall_strategy?: "local" | "balanced" | "global";
  recall_mode?: "dense_edge";
  consumer_agent_id?: string;
  consumer_team_id?: string;
  limit?: number;
  neighborhood_hops?: number;
  return_debug?: boolean;
  include_embeddings?: boolean;
  include_meta?: boolean;
  include_slots?: boolean;
  include_slots_preview?: boolean;
  slots_preview_keys?: number;
  max_nodes?: number;
  max_edges?: number;
  ranked_limit?: number;
  min_edge_weight?: number;
  min_edge_confidence?: number;
  context_token_budget?: number;
  context_char_budget?: number;
  context_compaction_profile?: "balanced" | "aggressive";
  memory_layer_preference?: { allowed_layers: Array<"L0" | "L1" | "L2" | "L3" | "L4" | "L5"> };
  rules_context?: unknown;
  rules_include_shadow?: boolean;
  rules_limit?: number;
} & AionisRequestPayload;

export type AionisMemoryRecallTextRequest = {
  tenant_id?: string;
  scope?: string;
  query_text: string;
  recall_strategy?: "local" | "balanced" | "global";
  recall_mode?: "dense_edge";
  recall_class_aware?: boolean;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  limit?: number;
  neighborhood_hops?: number;
  return_debug?: boolean;
  include_embeddings?: boolean;
  include_meta?: boolean;
  include_slots?: boolean;
  include_slots_preview?: boolean;
  slots_preview_keys?: number;
  max_nodes?: number;
  max_edges?: number;
  ranked_limit?: number;
  min_edge_weight?: number;
  min_edge_confidence?: number;
  context_token_budget?: number;
  context_char_budget?: number;
  context_compaction_profile?: "balanced" | "aggressive";
  memory_layer_preference?: { allowed_layers: Array<"L0" | "L1" | "L2" | "L3" | "L4" | "L5"> };
  rules_context?: unknown;
  rules_include_shadow?: boolean;
  rules_limit?: number;
} & AionisRequestPayload;

export type AionisPlanningContextRequest = {
  tenant_id?: string;
  scope?: string;
  query_text: string;
  context: unknown;
  recall_strategy?: "local" | "balanced" | "global";
  recall_mode?: "dense_edge";
  recall_class_aware?: boolean;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  include_shadow?: boolean;
  rules_limit?: number;
  run_id?: string;
  tool_candidates?: string[];
  tool_strict?: boolean;
  limit?: number;
  neighborhood_hops?: number;
  return_debug?: boolean;
  include_embeddings?: boolean;
  include_meta?: boolean;
  include_slots?: boolean;
  include_slots_preview?: boolean;
  slots_preview_keys?: number;
  max_nodes?: number;
  max_edges?: number;
  ranked_limit?: number;
  min_edge_weight?: number;
  min_edge_confidence?: number;
  context_token_budget?: number;
  context_char_budget?: number;
  context_compaction_profile?: "balanced" | "aggressive";
  context_optimization_profile?: "balanced" | "aggressive";
  memory_layer_preference?: { allowed_layers: Array<"L0" | "L1" | "L2" | "L3" | "L4" | "L5"> };
  return_layered_context?: boolean;
  context_layers?: Record<string, unknown>;
  static_context_blocks?: Array<Record<string, unknown>>;
  static_injection?: Record<string, unknown>;
  execution_result_summary?: Record<string, unknown>;
  execution_artifacts?: Array<Record<string, unknown>>;
  execution_evidence?: Array<Record<string, unknown>>;
  execution_state_v1?: Record<string, unknown>;
  execution_packet_v1?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisKickoffRecommendation = {
  source_kind: "experience_intelligence" | "tool_selection";
  history_applied: boolean;
  selected_tool: string | null;
  file_path: string | null;
  next_action: string | null;
} & AionisPassthroughObject;

export type AionisKickoffRecommendationRequest = {
  tenant_id?: string;
  scope?: string;
  run_id?: string;
  query_text: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  context?: unknown;
  candidates?: string[];
  include_shadow?: boolean;
  rules_limit?: number;
  strict?: boolean;
  reorder_candidates?: boolean;
  execution_result_summary?: Record<string, unknown>;
  execution_artifacts?: Array<Record<string, unknown>>;
  execution_evidence?: Array<Record<string, unknown>>;
  execution_state_v1?: Record<string, unknown>;
  edit_boundary_context?: Record<string, unknown>;
  trajectory?: Record<string, unknown>;
  trajectory_hints?: Record<string, unknown>;
  policy_learning_control_apply_mode?: "manual" | "auto_apply";
  workflow_limit?: number;
} & AionisRequestPayload;

export type AionisKickoffRecommendationResponse = {
  summary_version: "kickoff_recommendation_v1";
  tenant_id: string;
  scope: string;
  query_text: string;
  kickoff_recommendation: AionisKickoffRecommendation | null;
  action_retrieval_uncertainty?: AionisActionRetrievalUncertainty | null;
  policy_contract?: AionisPolicyContract | null;
  rationale: {
    summary: string;
  } & AionisPassthroughObject;
} & AionisRuntimeResponse;

export type AionisActionRetrievalRequest = AionisKickoffRecommendationRequest;

export type AionisServiceLifecycleConstraintV1 = {
  version: 1;
  service_kind: "generic" | "http" | "tcp" | "process";
  label: string;
  launch_reference: string | null;
  endpoint: string | null;
  must_survive_agent_exit: boolean;
  revalidate_from_fresh_shell: boolean;
  detach_then_probe: boolean;
  health_checks: string[];
  teardown_notes: string[];
};

export type AionisRuntimeAuthorityVisibility = {
  surface_version: "runtime_authority_visibility_v1";
  node_id: string | null;
  node_kind: string | null;
  title: string | null;
  requested_trust: string | null;
  effective_trust: string | null;
  status: "sufficient" | "insufficient" | "unknown";
  allows_authoritative: boolean;
  allows_stable_promotion: boolean;
  authority_blocked: boolean;
  stable_promotion_blocked: boolean;
  primary_blocker: string | null;
  authority_reasons: string[];
  outcome_contract_reasons: string[];
  execution_evidence_reasons: string[];
  execution_evidence_status: string | null;
  false_confidence_detected: boolean;
};

export type AionisActionRecommendationTool = {
  selected_tool: string | null;
  ordered_tools: string[];
  preferred_tools: string[];
  allowed_tools: string[];
  trusted_pattern_anchor_ids: string[];
  candidate_pattern_anchor_ids: string[];
  suppressed_pattern_anchor_ids: string[];
};

export type AionisActionRecommendationPath = {
  source_kind: "recommended_workflow" | "candidate_workflow" | "none";
  anchor_id: string | null;
  contract_trust?: "authoritative" | "advisory" | "observational";
  task_family?: string | null;
  workflow_signature: string | null;
  title: string | null;
  summary: string | null;
  file_path: string | null;
  target_files: string[];
  next_action: string | null;
  workflow_steps?: string[];
  pattern_hints?: string[];
  service_lifecycle_constraints?: AionisServiceLifecycleConstraintV1[];
  confidence: number | null;
  tool_set: string[];
  authority_visibility?: AionisRuntimeAuthorityVisibility | null;
  authority_blocked?: boolean;
  authority_primary_blocker?: string | null;
};

export type AionisActionRetrievalEvidenceEntry = {
  source_kind:
    | "persisted_policy_memory"
    | "trusted_pattern"
    | "stable_workflow"
    | "candidate_workflow"
    | "contested_pattern"
    | "rehydration_candidate"
    | "adaptive_guidance_candidate";
  anchor_id: string | null;
  selected_tool: string | null;
  task_family?: string | null;
  workflow_signature: string | null;
  file_path: string | null;
  target_files: string[];
  workflow_steps?: string[];
  pattern_hints?: string[];
  service_lifecycle_constraints?: AionisServiceLifecycleConstraintV1[];
  authority_visibility?: AionisRuntimeAuthorityVisibility | null;
  authority_blocked?: boolean;
  authority_primary_blocker?: string | null;
  confidence: number | null;
  reason: string;
};

export type AionisActionRetrievalEvidence = {
  stable_workflow_count: number;
  candidate_workflow_count: number;
  trusted_pattern_count: number;
  contested_pattern_count: number;
  rehydration_candidate_count: number;
  adaptive_guidance_candidate_count: number;
  persisted_policy_memory_id: string | null;
  selected_path_anchor_id: string | null;
  entries: AionisActionRetrievalEvidenceEntry[];
};

export type AionisAdaptiveGuidanceSubtask = {
  subtask_id: string;
  role: "task_intent" | "tool_selection" | "file_focus" | "verification" | "continuity";
  query_text: string;
  match_terms: string[];
};

export type AionisAdaptiveGuidanceDecomposition = {
  summary_version: "adaptive_guidance_decomposition_v1";
  query_text: string;
  task_family: string | null;
  query_terms: string[];
  file_hints: string[];
  tool_hints: string[];
  subtasks: AionisAdaptiveGuidanceSubtask[];
};

export type AionisAdaptiveGuidanceCandidate = {
  summary_version: "adaptive_guidance_candidate_v1";
  candidate_id: string;
  source_kind:
    | "stable_workflow"
    | "candidate_workflow"
    | "trusted_pattern"
    | "contested_pattern"
    | "continuity_carrier"
    | "supporting_knowledge";
  source_anchor_id: string | null;
  authority: "advisory_candidate";
  contract_trust: "observational";
  selected_tool: string | null;
  task_family: string | null;
  workflow_signature: string | null;
  title: string | null;
  summary: string | null;
  file_path: string | null;
  target_files: string[];
  next_action: string | null;
  workflow_steps: string[];
  pattern_hints: string[];
  service_lifecycle_constraints: AionisServiceLifecycleConstraintV1[];
  evidence_refs: string[];
  source_refs: string[];
  confidence: number;
  score: number;
  match_reasons: string[];
  promotion_blockers: string[];
  source_code_change_allowed: false;
};

export type AionisAdaptiveGuidanceInstruction = {
  instruction_id: string;
  priority: "primary" | "supporting" | "verification";
  instruction: string;
  selected_tool: string | null;
  file_path: string | null;
  task_family: string | null;
  source_candidate_ids: string[];
  source_anchor_ids: string[];
  evidence_refs: string[];
  contract_trust: "observational";
};

export type AionisAdaptiveGuidanceOverlay = {
  summary_version: "adaptive_guidance_overlay_v1";
  activation_state: "active" | "empty" | "blocked";
  query_text: string;
  decomposition: AionisAdaptiveGuidanceDecomposition;
  candidate_count: number;
  selected_candidate_count: number;
  skipped_candidate_count: number;
  skipped_reasons: string[];
  selected_candidates: AionisAdaptiveGuidanceCandidate[];
  adapted_instructions: AionisAdaptiveGuidanceInstruction[];
  authority_visibility: {
    summary_version: "adaptive_guidance_authority_v1";
    contract_trust: "observational";
    may_override_policy: false;
    may_promote_directly: false;
    required_promotion_path: "runtime_signal_attribution_and_learning_control_gate";
    blocked_authority_levels: Array<"authoritative" | "advisory">;
  };
  attribution_plan: {
    summary_version: "adaptive_guidance_attribution_plan_v1";
    candidate_ids: string[];
    expected_signal_kind: "adaptive_guidance_outcome";
    feedback_slots: string[];
    positive_authority_effect: "promotion_evidence_candidate";
    negative_authority_effect: "counter_evidence";
  };
  uncertainty_adjustment: {
    summary_version: "adaptive_guidance_uncertainty_adjustment_v1";
    confidence_delta: number;
    recommended_actions: Array<"widen_recall" | "inspect_context" | "request_operator_review">;
    reason: string | null;
  };
  source_code_change_allowed: false;
};

export type AionisActionRetrievalUncertainty = {
  summary_version: "action_retrieval_uncertainty_v1";
  level: "low" | "moderate" | "high";
  confidence: number;
  evidence_gap_count: number;
  reasons: string[];
  recommended_actions:
	    Array<"proceed" | "widen_recall" | "rehydrate_payload" | "inspect_context" | "request_operator_review">;
};

export type AionisRuntimeSignalKind =
  | "verifier_result"
  | "recovery_cost"
  | "retry_count"
  | "repeated_discovery"
  | "repeated_failed_action"
  | "provider_protocol_failure"
  | "edit_boundary_rejection"
  | "tool_selection_outcome"
  | "workflow_reuse_outcome"
  | "adaptive_guidance_outcome"
  | "maintenance_effect"
  | "token_context_pressure"
  | "rehydration_usefulness";

export type AionisRuntimeEntropyProfile = {
  profile_version: "runtime_entropy_profile_v1";
  entropy_level: "low" | "medium" | "high" | "lockdown";
  exploration_budget: number;
  control_strength: number;
  plasticity_level: "low" | "medium" | "high";
  recall_breadth: "narrow" | "balanced" | "wide";
  verification_depth: "light" | "normal" | "strict";
  promotion_threshold: "low" | "normal" | "high" | "blocked";
  mutation_authority: "none" | "candidate_only" | "scoped" | "stable_allowed";
  runtime_signal_trend_posture: "none" | "reuse" | "explore" | "constrain" | "quarantine";
  reason_codes: string[];
  source_signals: AionisRuntimeSignalKind[];
  source_code_change_allowed: false;
};

export type AionisRuntimeEntropyControls = {
  controls_version: "runtime_entropy_controls_v1";
  recall: {
    breadth: "narrow" | "balanced" | "wide";
    recommended_limit: number;
    recommended_ranked_limit: number;
    recommended_max_nodes: number;
    recommended_max_edges: number;
    reason: string;
  };
  verifier: {
    verification_depth: "light" | "normal" | "strict";
    schedule: "skip" | "light" | "normal" | "strict" | "blocked";
    runtime_verifier_required: boolean;
    reason: string;
  };
  promotion: {
    promotion_threshold: "low" | "normal" | "high" | "blocked";
    mutation_authority: "none" | "candidate_only" | "scoped" | "stable_allowed";
    minimum_observations: number;
    stable_promotion_allowed: boolean;
    reason: string;
  };
  maintenance: {
    recommended_profile: "immediate" | "daily" | "long_horizon";
    run_after_task: boolean;
    reason: string;
  };
  source_code_change_allowed: false;
};

export type AionisRuntimeSignalTrendSummary = {
  summary_version: "runtime_signal_trend_summary_v1";
  scanned_node_count: number;
  included_ledger_count: number;
  entry_count: number;
  truncated: boolean;
  signal_counts: Array<{
    signal_kind: AionisRuntimeSignalKind;
    total: number;
    positive: number;
    neutral: number;
    negative: number;
    authority_effects: {
      none: number;
      promotion_evidence_candidate: number;
      counter_evidence: number;
      quarantine: number;
      forgetting_signal: number;
    };
  }>;
  polarity_counts: {
    positive: number;
    neutral: number;
    negative: number;
  };
  authority_effect_counts: {
    none: number;
    promotion_evidence_candidate: number;
    counter_evidence: number;
    quarantine: number;
    forgetting_signal: number;
  };
  capability_counts: {
    continuity: number;
    learning: number;
    forgetting: number;
    learning_control: number;
  };
  quarantine_signal_count: number;
  counter_evidence_count: number;
  promotion_evidence_candidate_count: number;
  forgetting_signal_count: number;
  numeric_trends: Array<{
    signal_kind: AionisRuntimeSignalKind;
    count: number;
    min: number;
    max: number;
    average: number;
  }>;
  dominant_negative_signals: AionisRuntimeSignalKind[];
  dominant_positive_signals: AionisRuntimeSignalKind[];
  recommended_runtime_posture: "reuse" | "explore" | "constrain" | "quarantine";
  findings: string[];
  source_node_ids: string[];
  source_code_change_allowed: false;
};

export type AionisPromotionQualitySummary = AionisPassthroughObject & {
  summary_version: "promotion_quality_summary_v1";
  recommended_learning_posture: "insufficient_evidence" | "candidate_only" | "promotion_ready" | "constrain" | "invalidate";
  source_code_change_allowed: false;
};

export type AionisRuntimeEffectSummary = AionisPassthroughObject & {
  summary_version: "runtime_effect_summary_v1";
  baseline_comparison_required: true;
  measurable_effect_posture: "insufficient_evidence" | "positive" | "mixed" | "constrained" | "blocked";
  source_code_change_allowed: false;
};

export type AionisActionIntelligenceRuntimeStage = {
  stage:
    | "recall"
    | "assess"
    | "retrieve"
    | "act"
    | "distill"
    | "evaluate"
    | "attribute"
    | "mutate"
    | "maintain"
    | "reuse";
  status: "observed" | "ready" | "pending" | "blocked";
  summary: string;
  source_refs: string[];
  evidence_refs: string[];
  required_next: string | null;
};

export type AionisActionIntelligenceRuntimeContract = {
  contract_version: "action_intelligence_runtime_contract_v1";
  loop_version: "action_intelligence_loop_v1";
  tenant_id: string;
  scope: string;
  run_id: string | null;
  query_text: string;
  source_code_change_allowed: false;
  selected_tool: string | null;
  recommended_next_action: string | null;
  target_files: string[];
  workflow_anchor_id: string | null;
  policy_memory_id: string | null;
  execution_contract_v1: AionisPassthroughObject | null;
  pre_action_gate: {
    gate_version: "action_intelligence_pre_action_gate_v1";
    known_enough: boolean;
    requires_recall: boolean;
    requires_rehydration: boolean;
    requires_operator_review: boolean;
    authority_blocked: boolean;
    uncertainty_level: "low" | "moderate" | "high";
    confidence: number;
    recommended_actions: Array<"proceed" | "widen_recall" | "rehydrate_payload" | "inspect_context" | "request_operator_review">;
    primary_reason: string | null;
  };
  runtime_entropy_profile: AionisRuntimeEntropyProfile;
  runtime_entropy_controls: AionisRuntimeEntropyControls;
  runtime_signal_trend_summary: AionisRuntimeSignalTrendSummary | null;
  promotion_quality_summary: AionisPromotionQualitySummary | null;
  runtime_effect_summary: AionisRuntimeEffectSummary | null;
  loop: {
    recall: AionisActionIntelligenceRuntimeStage;
    assess: AionisActionIntelligenceRuntimeStage;
    retrieve: AionisActionIntelligenceRuntimeStage;
    act: AionisActionIntelligenceRuntimeStage;
    distill: AionisActionIntelligenceRuntimeStage;
    evaluate: AionisActionIntelligenceRuntimeStage;
    attribute: AionisActionIntelligenceRuntimeStage;
    mutate: AionisActionIntelligenceRuntimeStage;
    maintain: AionisActionIntelligenceRuntimeStage;
    reuse: AionisActionIntelligenceRuntimeStage;
  };
  evidence_summary: AionisPassthroughObject & {
    summary_version: "action_intelligence_evidence_summary_v1";
    authority_blocked_count: number;
    evidence_refs: string[];
  };
  lifecycle: AionisPassthroughObject & {
    lifecycle_version: "action_intelligence_lifecycle_v1";
    history_applied: boolean;
    post_action_material_present: boolean;
    distillation_ready: boolean;
    workflow_candidate_available: boolean;
    policy_candidate_available: boolean;
    mutation_candidate_available: boolean;
    maintenance_ready: boolean;
    recommended_maintenance_profile: "immediate" | "daily" | "long_horizon";
  };
  rationale: {
    summary: string;
  };
};

export type AionisDelegationLearningSummary = {
  task_family: string | null;
  matched_records: number;
  truncated: boolean;
  route_role_counts: Record<string, number>;
  record_outcome_counts: Record<string, number>;
  recommendation_count: number;
} & AionisPassthroughObject;

export type AionisDelegationLearningProjection = {
  summary_version: "delegation_learning_projection_v1";
  learning_summary: AionisDelegationLearningSummary;
  learning_recommendations: AionisDelegationRecordsLearningRecommendation[];
} & AionisPassthroughObject;

export type AionisPolicyHintEntry = {
  hint_id: string;
  source_kind: "trusted_pattern" | "contested_pattern" | "stable_workflow" | "rehydration_candidate";
  hint_kind: "tool_preference" | "tool_avoidance" | "workflow_reuse" | "payload_rehydration";
  action: "prefer" | "avoid" | "reuse" | "rehydrate";
  source_anchor_id: string;
  source_anchor_level: string | null;
  selected_tool: string | null;
  workflow_signature: string | null;
  file_path: string | null;
  target_files: string[];
  rehydration_mode: string | null;
  confidence: number | null;
  priority: number;
  reason: string;
} & AionisPassthroughObject;

export type AionisPolicyHintPack = {
  summary_version: "policy_hint_pack_v1";
  total_hints: number;
  tool_preference_count: number;
  tool_avoidance_count: number;
  workflow_reuse_count: number;
  payload_rehydration_count: number;
  hints: AionisPolicyHintEntry[];
} & AionisPassthroughObject;

export type AionisDerivedPolicySurface = {
  summary_version: "derived_policy_v1";
  policy_kind: "tool_preference";
  source_kind: "trusted_pattern" | "stable_workflow" | "blended";
  policy_state: "candidate" | "stable";
  selected_tool: string;
  workflow_signature: string | null;
  file_path: string | null;
  target_files: string[];
  confidence: number;
  supporting_anchor_ids: string[];
  reason: string;
  evidence: {
    trusted_pattern_count: number;
    stable_workflow_count: number;
    usage_count: number;
    reuse_success_count: number;
    reuse_failure_count: number;
    feedback_quality: number | null;
  } & AionisPassthroughObject;
} & AionisPassthroughObject;

export type AionisPolicyContract = {
  summary_version: "policy_contract_v1";
  policy_kind: "tool_preference";
  source_kind: "trusted_pattern" | "stable_workflow" | "blended";
  policy_state: "candidate" | "stable";
  policy_memory_state: "active" | "contested" | "retired";
  activation_mode: "hint" | "default";
  materialization_state: "computed" | "persisted";
  history_applied: boolean;
  selected_tool: string;
  avoid_tools: string[];
  workflow_signature: string | null;
  file_path: string | null;
  target_files: string[];
  next_action: string | null;
  rehydration_mode: string | null;
  confidence: number;
  source_anchor_ids: string[];
  policy_memory_id: string | null;
  reason: string;
} & AionisPassthroughObject;

export type AionisPersistedPolicyMemory = {
  node_id: string;
  node_uri: string;
  client_id: string;
  policy_memory_signature: string;
  selected_tool: string;
  policy_state: "candidate" | "stable";
  policy_memory_state: "active" | "contested" | "retired";
  activation_mode: "hint" | "default";
  policy_contract: AionisPolicyContract;
} & AionisPassthroughObject;

export type AionisPolicyReviewSummary = {
  summary_version: "policy_review_summary_v1";
  persisted_policy_count: number;
  active_policy_count: number;
  contested_policy_count: number;
  retired_policy_count: number;
  review_recommended: boolean;
  selected_policy_memory_id: string | null;
  selected_policy_memory_state: "active" | "contested" | "retired" | null;
  attention_policy: ({
    node_id: string;
    policy_memory_state: "active" | "contested" | "retired";
    selected_tool: string | null;
    file_path: string | null;
    workflow_signature: string | null;
    summary: string | null;
    feedback_quality: number | null;
    last_feedback_at: string | null;
    last_materialized_at: string | null;
    review_reason: string;
  } & AionisPassthroughObject) | null;
} & AionisPassthroughObject;

export type AionisPolicyLearningControlContract = {
  contract_version: "policy_learning_control_contract_v1";
  action: "none" | "monitor" | "refresh" | "retire" | "reactivate";
  applies: boolean;
  review_required: boolean;
  policy_memory_id: string | null;
  current_state: "active" | "contested" | "retired" | null;
  target_state: "active" | "contested" | "retired" | null;
  selected_tool: string | null;
  file_path: string | null;
  workflow_signature: string | null;
  rationale: string;
  next_action: string | null;
} & AionisPassthroughObject;

export type AionisPolicyLearningControlApplyPayload = {
  payload_version: "policy_learning_control_apply_payload_v1";
  route: string;
  method: "POST";
  action: "refresh" | "retire" | "reactivate";
  policy_memory_id: string;
  selected_tool: string | null;
  current_state: "active" | "contested" | "retired" | null;
  target_state: "active" | "contested" | "retired" | null;
  requires_live_context: boolean;
  request_body: Record<string, unknown>;
  rationale: string;
} & AionisPassthroughObject;

export type AionisPolicyLearningControlApplyResult = {
  ok: boolean;
  auto_applied: boolean;
  attempted: boolean;
  trigger: string;
  surface: string;
  action: "refresh" | "retire" | "reactivate";
  policy_memory_id: string;
  previous_state?: "active" | "contested" | "retired";
  next_state?: "active" | "contested" | "retired";
  policy_memory?: AionisPersistedPolicyMemory | null;
  error?: { code: string; message: string } | null;
} & AionisPassthroughObject;

export type AionisContextOperatorProjection = {
  delegation_learning?: AionisDelegationLearningProjection;
  action_retrieval_gate?: AionisPassthroughObject;
  adaptive_guidance?: AionisAdaptiveGuidanceOverlay;
  action_hints?: Array<{
    summary_version: "context_operator_action_hint_v1";
    action: "inspect_context" | "widen_recall" | "rehydrate_payload" | "request_operator_review";
    priority: "required" | "recommended";
    instruction: string | null;
    selected_tool: string | null;
    file_path: string | null;
    tool_route: string | null;
    tool_method: "POST" | null;
    example_call: string | null;
    preferred_rehydration_anchor_id: string | null;
  } & AionisPassthroughObject>;
} & AionisPassthroughObject;

export type AionisExperienceIntelligenceResponse = {
  summary_version: "experience_intelligence_v1";
  tenant_id: string;
  scope: string;
  query_text: string;
  action_retrieval: AionisActionRetrievalResponse;
  action_intelligence_runtime_contract: AionisActionIntelligenceRuntimeContract;
  execution_contract_v1: AionisPassthroughObject | null;
  recommendation: {
    history_applied: boolean;
    tool: AionisActionRecommendationTool;
    path: AionisActionRecommendationPath;
    combined_next_action: string | null;
  } & AionisPassthroughObject;
  policy_hints: AionisPolicyHintPack;
  derived_policy: AionisDerivedPolicySurface | null;
  policy_contract: AionisPolicyContract | null;
  learning_summary: AionisDelegationLearningSummary;
  learning_recommendations: AionisDelegationRecordsLearningRecommendation[];
  rationale: {
    summary: string;
  } & AionisPassthroughObject;
} & AionisRuntimeResponse;

export type AionisActionRetrievalResponse = {
  summary_version: "action_retrieval_v1";
  tenant_id: string;
  scope: string;
  query_text: string;
  history_applied: boolean;
  tool_source_kind:
    | "tools_select"
    | "trusted_pattern"
    | "stable_workflow"
    | "persisted_policy_memory"
    | "adaptive_guidance"
    | "blended";
  selected_tool: string | null;
  recommended_file_path: string | null;
  recommended_next_action: string | null;
  execution_contract_v1: AionisPassthroughObject | null;
  tool: AionisActionRecommendationTool;
  path: AionisActionRecommendationPath;
  evidence: AionisActionRetrievalEvidence;
  adaptive_guidance: AionisAdaptiveGuidanceOverlay;
  uncertainty: AionisActionRetrievalUncertainty;
  rationale: {
    summary: string;
  };
};

export type AionisTaskStartRequest = AionisKickoffRecommendationRequest;

export type AionisExperienceIntelligenceRequest = AionisKickoffRecommendationRequest;

export type AionisTaskStartAction = {
  action_kind: "file_step" | "tool_step";
  source_kind: "experience_intelligence" | "tool_selection";
  history_applied: boolean;
  selected_tool: string;
  file_path: string | null;
  next_action: string | null;
} & AionisPassthroughObject;

export type AionisTaskStartResponse = Omit<AionisKickoffRecommendationResponse, "summary_version"> & {
  summary_version: "task_start_v1";
  first_action: AionisTaskStartAction | null;
};

export type AionisTaskStartGateAction = Exclude<
  AionisActionRetrievalUncertainty["recommended_actions"][number],
  "proceed"
>;

export type AionisTaskStartPlanRequest = AionisKickoffRecommendationRequest & Partial<Pick<
  AionisPlanningContextRequest,
  | "recall_strategy"
  | "recall_mode"
  | "recall_class_aware"
  | "include_shadow"
  | "rules_limit"
  | "run_id"
  | "tool_strict"
  | "limit"
  | "neighborhood_hops"
  | "return_debug"
  | "include_embeddings"
  | "include_meta"
  | "include_slots"
  | "include_slots_preview"
  | "slots_preview_keys"
  | "max_nodes"
  | "max_edges"
  | "ranked_limit"
  | "min_edge_weight"
  | "min_edge_confidence"
  | "context_token_budget"
  | "context_char_budget"
  | "context_compaction_profile"
  | "context_optimization_profile"
  | "memory_layer_preference"
  | "return_layered_context"
  | "context_layers"
  | "static_context_blocks"
  | "static_injection"
  | "execution_result_summary"
  | "execution_artifacts"
  | "execution_evidence"
  | "execution_state_v1"
  | "execution_packet_v1"
>>;

export type AionisTaskStartPlanResponse = {
  summary_version: "task_start_plan_v1";
  resolution_source: "kickoff" | "planning_context";
  tenant_id: string;
  scope: string;
  query_text: string;
  kickoff_recommendation: AionisKickoffRecommendation | null;
  gate_action: AionisTaskStartGateAction | null;
  action_retrieval_uncertainty: AionisActionRetrievalUncertainty | null;
  first_action: AionisTaskStartAction | null;
  planner_explanation: string | null;
  planner_packet: AionisPassthroughObject | null;
  rationale: {
    summary: string;
  } & AionisPassthroughObject;
} & AionisPassthroughObject;

export type AionisContextAssembleRequest = AionisPlanningContextRequest;
export type AionisExecutionIntrospectRequest = {
  tenant_id?: string;
  scope?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  run_id?: string;
  session_id?: string;
  limit?: number;
} & AionisRequestPayload;

export type AionisRetrieveWorkflowContractRequest = AionisExecutionIntrospectRequest & {
  anchor_id?: string;
  workflow_signature?: string;
  task_family?: string;
  file_path?: string;
  /**
   * Defaults to false. Set true only for operator/debug flows that need the full
   * execution introspection payload; normal host integrations should read the
   * stable workflow contract and authority_summary fields instead.
   */
  include_introspection?: boolean;
};

export type AionisWorkflowContractAuthoritySummary = {
  summary_version: "workflow_contract_authority_summary_v1";
  contract_trust: "authoritative" | "advisory" | "observational" | string | null;
  status: "sufficient" | "insufficient" | "unknown";
  allows_authoritative: boolean | null;
  allows_stable_promotion: boolean | null;
  authority_blocked: boolean | null;
  stable_promotion_blocked: boolean | null;
  primary_blocker: string | null;
  outcome_contract_status: "sufficient" | "insufficient" | "unknown";
  outcome_contract_allows_authoritative: boolean | null;
  outcome_contract_reasons: string[];
  execution_evidence_status: string | null;
  execution_evidence_reasons: string[];
  false_confidence_detected: boolean | null;
};

export type AionisRetrieveWorkflowContractResponse = {
  summary_version: "retrieve_workflow_contract_v1";
  tenant_id: string | null;
  scope: string | null;
  selected_source: "recommended_workflows" | "candidate_workflows" | "none";
  selected_workflow: AionisPassthroughObject | null;
  execution_contract_v1: AionisPassthroughObject | null;
  contract_trust: "authoritative" | "advisory" | "observational" | string | null;
  outcome_contract_gate: AionisPassthroughObject | null;
  authority_visibility: AionisRuntimeAuthorityVisibility | AionisPassthroughObject | null;
  authority_summary: AionisWorkflowContractAuthoritySummary;
  introspection: AionisExecutionIntrospectResponse | null;
};

export type AionisExecutionPacketAssemblySummary = {
  packet_source_mode: string | null;
  state_first_assembly: boolean | null;
  execution_packet_v1_present: boolean | null;
  execution_state_v1_present: boolean | null;
};

export type AionisExecutionStrategySummary = {
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

export type AionisExecutionCollaborationSummary = {
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

export type AionisExecutionContinuitySnapshotSummary = {
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

export type AionisExecutionForgettingSummary = {
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

export type AionisExecutionCollaborationRoutingSummary = {
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

export type AionisExecutionDelegationPacketRecord = {
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

export type AionisExecutionDelegationReturnRecord = {
  version: 1;
  role: string;
  status: string;
  summary: string;
  evidence: string[];
  working_set: string[];
  acceptance_checks: string[];
  source_mode: "memory_only" | "packet_backed";
};

export type AionisExecutionArtifactRoutingRecord = {
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

export type AionisExecutionDelegationRecordsSummary = {
  summary_version: "execution_delegation_records_v1";
  record_mode: "memory_only" | "packet_backed";
  route_role: string;
  packet_count: number;
  return_count: number;
  artifact_routing_count: number;
  missing_record_types: string[];
  delegation_packets: AionisExecutionDelegationPacketRecord[];
  delegation_returns: AionisExecutionDelegationReturnRecord[];
  artifact_routing_records: AionisExecutionArtifactRoutingRecord[];
};

export type AionisExecutionRoutingSignalSummary = {
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

export type AionisExecutionMaintenanceSummary = {
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

export type AionisExecutionInstrumentationSummary = {
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

export type AionisExecutionSummary = {
  summary_version: "execution_summary_v1";
  planner_packet: AionisPassthroughObject | null;
  pattern_signals: AionisPassthroughObject[];
  workflow_signals: AionisPassthroughObject[];
  packet_assembly: AionisExecutionPacketAssemblySummary;
  strategy_summary: AionisExecutionStrategySummary;
  collaboration_summary: AionisExecutionCollaborationSummary;
  continuity_snapshot_summary: AionisExecutionContinuitySnapshotSummary;
  routing_signal_summary: AionisExecutionRoutingSignalSummary;
  maintenance_summary: AionisExecutionMaintenanceSummary;
  forgetting_summary: AionisExecutionForgettingSummary;
  collaboration_routing_summary: AionisExecutionCollaborationRoutingSummary;
  delegation_records_summary: AionisExecutionDelegationRecordsSummary;
  instrumentation_summary: AionisExecutionInstrumentationSummary;
  action_packet_summary: AionisPassthroughObject;
  pattern_signal_summary: AionisPassthroughObject;
  workflow_signal_summary: AionisPassthroughObject;
  workflow_lifecycle_summary: AionisPassthroughObject;
  workflow_maintenance_summary: AionisPassthroughObject;
  authority_visibility_summary: AionisPassthroughObject;
  distillation_signal_summary: AionisPassthroughObject;
  pattern_lifecycle_summary: AionisPassthroughObject;
  pattern_maintenance_summary: AionisPassthroughObject;
  policy_lifecycle_summary: AionisPassthroughObject;
  policy_maintenance_summary: AionisPassthroughObject;
  continuity_carrier_summary: AionisPassthroughObject;
};

export type AionisExecutionIntrospectResponse = {
  summary_version: "execution_memory_introspection_v1";
  tenant_id: string;
  scope: string;
  inventory: AionisPassthroughObject;
  continuity_projection_report: AionisPassthroughObject;
  demo_surface: AionisPassthroughObject;
  execution_summary: AionisExecutionSummary;
  recommended_workflows: AionisPassthroughObject[];
  candidate_workflows: AionisPassthroughObject[];
  candidate_patterns: AionisPassthroughObject[];
  trusted_patterns: AionisPassthroughObject[];
  contested_patterns: AionisPassthroughObject[];
  rehydration_candidates: AionisPassthroughObject[];
  supporting_knowledge: AionisPassthroughObject[];
  pattern_signals: AionisPassthroughObject[];
  workflow_signals: AionisPassthroughObject[];
  action_packet_summary: AionisPassthroughObject;
  pattern_signal_summary: AionisPassthroughObject;
  workflow_signal_summary: AionisPassthroughObject;
  workflow_lifecycle_summary: AionisPassthroughObject;
  workflow_maintenance_summary: AionisPassthroughObject;
  pattern_lifecycle_summary: AionisPassthroughObject;
  pattern_maintenance_summary: AionisPassthroughObject;
} & AionisRuntimeResponse;

export type AionisPlanningContextResponse = {
  tenant_id: string;
  scope: string;
  execution_kernel: AionisPassthroughObject;
  execution_summary: AionisExecutionSummary;
  query: AionisPassthroughObject;
  recall: AionisPassthroughObject;
  rules?: AionisPassthroughObject;
  tools?: AionisPassthroughObject;
  runtime_tool_hints: AionisPassthroughObject[];
  planner_packet: AionisPassthroughObject;
  pattern_signals: AionisPassthroughObject[];
  workflow_signals: AionisPassthroughObject[];
  planning_summary: AionisPassthroughObject;
  kickoff_recommendation?: AionisKickoffRecommendation | null;
  operator_projection?: AionisContextOperatorProjection;
  layered_context: AionisPassthroughObject;
  cost_signals: AionisPassthroughObject;
} & AionisRuntimeResponse;

export type AionisContextAssembleResponse = {
  tenant_id: string;
  scope: string;
  execution_kernel: AionisPassthroughObject;
  execution_summary: AionisExecutionSummary;
  query: AionisPassthroughObject;
  recall: AionisPassthroughObject;
  rules?: AionisPassthroughObject;
  tools?: AionisPassthroughObject;
  runtime_tool_hints: AionisPassthroughObject[];
  planner_packet: AionisPassthroughObject;
  pattern_signals: AionisPassthroughObject[];
  workflow_signals: AionisPassthroughObject[];
  assembly_summary: AionisPassthroughObject;
  kickoff_recommendation?: AionisKickoffRecommendation | null;
  operator_projection?: AionisContextOperatorProjection;
  layered_context: AionisPassthroughObject;
  cost_signals: AionisPassthroughObject;
} & AionisRuntimeResponse;

export type AionisMemoryFindRequest = {
  tenant_id?: string;
  scope?: string;
  query_text?: string;
  node_ids?: string[];
  anchor_ids?: string[];
  limit?: number;
} & AionisRequestPayload;

export type AionisMemoryResolveRequest = {
  tenant_id?: string;
  scope?: string;
  uri: string;
  include_meta?: boolean;
  include_slots?: boolean;
  include_slots_preview?: boolean;
  slots_preview_keys?: number;
} & AionisRequestPayload;

export type AionisMemoryFeedbackRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  input_text?: string;
  input_sha256?: string;
  note?: string;
  labels?: string[];
} & AionisRequestPayload;

export type AionisRuleStateRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  rule_id?: string;
  state?: string;
  note?: string;
} & AionisRequestPayload;

export type AionisRulesEvaluateRequest = {
  tenant_id?: string;
  scope?: string;
  context: unknown;
  include_shadow?: boolean;
  limit?: number;
} & AionisRequestPayload;

export type AionisToolsSelectRequest = {
  tenant_id?: string;
  scope?: string;
  context: unknown;
  candidates: string[];
  tool_strict?: boolean;
  include_shadow?: boolean;
  rules_limit?: number;
  run_id?: string;
} & AionisRequestPayload;

export type AionisToolsDecisionRequest = {
  tenant_id?: string;
  scope?: string;
  decision_id?: string;
  decision_uri?: string;
  run_id?: string;
} & AionisRequestPayload;

export type AionisToolsRunRequest = {
  tenant_id?: string;
  scope?: string;
  run_id: string;
  decision_limit?: number;
  include_feedback?: boolean;
  feedback_limit?: number;
} & AionisRequestPayload;

export type AionisToolsRunsListRequest = {
  tenant_id?: string;
  scope?: string;
  limit?: number;
} & AionisRequestPayload;

export type AionisToolsFeedbackRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  run_id?: string;
  decision_id?: string;
  decision_uri?: string;
  outcome: "positive" | "negative" | "neutral";
  context: unknown;
  candidates: string[];
  selected_tool: string;
  include_shadow?: boolean;
  rules_limit?: number;
  target?: "tool" | "all";
  note?: string;
  input_text?: string;
  input_sha256?: string;
  learning_control_review?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisToolsFeedbackResponse = {
  ok: true;
  scope: string;
  tenant_id: string;
  updated_rules: number;
  rule_node_ids: string[];
  commit_id: string | null;
  commit_uri?: string | null;
  commit_hash?: string | null;
  decision_id: string;
  decision_uri: string;
  decision_link_mode: "provided" | "inferred" | "created_from_feedback";
  decision_policy_sha256: string;
  pattern_anchor?: AionisPassthroughObject | null;
  policy_memory?: AionisPersistedPolicyMemory | null;
  learning_control_preview?: AionisPassthroughObject | null;
} & AionisRuntimeResponse;

export type AionisPolicyLearningControlApplyRequest = AionisKickoffRecommendationRequest & {
  actor?: string;
  policy_memory_id: string;
  action: "refresh" | "retire" | "reactivate";
  reason?: string;
};

export type AionisPolicyLearningControlApplyResponse = {
  ok: true;
  tenant_id: string;
  scope: string;
  action: "refresh" | "retire" | "reactivate";
  applied: boolean;
  actor: string | null;
  reason: string | null;
  policy_memory_id: string;
  previous_state: "active" | "contested" | "retired";
  next_state: "active" | "contested" | "retired";
  learning_control_contract: AionisPolicyLearningControlContract;
  live_policy_contract: AionisPolicyContract | null;
  policy_memory: AionisPersistedPolicyMemory;
} & AionisRuntimeResponse;

export type AionisPatternSuppressRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  anchor_id: string;
  reason: string;
  until?: string;
  mode?: "shadow_learn" | "hard_freeze";
} & AionisRequestPayload;

export type AionisPatternUnsuppressRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  anchor_id: string;
  reason?: string;
} & AionisRequestPayload;

export type AionisAnchorRehydratePayloadRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  anchor_id?: string;
  anchor_uri?: string;
  mode?: "summary_only" | "partial" | "full" | "differential";
  include_linked_decisions?: boolean;
  reason?: string;
  adjudication?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisSessionCreateRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  session_id?: string;
  title?: string;
  text_summary?: string;
  input_text?: string;
  metadata?: Record<string, unknown>;
  execution_result_summary?: Record<string, unknown>;
  execution_evidence?: Array<Record<string, unknown>>;
  auto_embed?: boolean;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  execution_state_v1?: Record<string, unknown>;
  execution_packet_v1?: Record<string, unknown>;
  execution_transitions_v1?: Array<Record<string, unknown>>;
} & AionisRequestPayload;

export type AionisSessionListQuery = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  limit?: number;
  cursor?: string;
} & Record<string, string | number | boolean | null | undefined>;

export type AionisSessionEventWriteRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  session_id: string;
  event_text?: string;
  event_id?: string;
  title?: string;
  text_summary?: string;
  input_text?: string;
  input_sha256?: string;
  metadata?: Record<string, unknown>;
  execution_result_summary?: Record<string, unknown>;
  execution_evidence?: Array<Record<string, unknown>>;
  execution_state_v1?: Record<string, unknown>;
  execution_packet_v1?: Record<string, unknown>;
  execution_transitions_v1?: Array<Record<string, unknown>>;
  auto_embed?: boolean;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  edge_weight?: number;
  edge_confidence?: number;
} & AionisRequestPayload;

export type AionisSessionEventsQuery = {
  session_id: string;
  tenant_id?: string;
  scope?: string;
  limit?: number;
  cursor?: string;
} & Record<string, string | number | boolean | null | undefined>;

export type AionisMemoryPackExportRequest = {
  tenant_id?: string;
  scope?: string;
  node_ids?: string[];
  edge_ids?: string[];
  include_embeddings?: boolean;
} & AionisRequestPayload;

export type AionisMemoryPackImportRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  pack: Record<string, unknown>;
  mode?: "merge" | "replace";
} & AionisRequestPayload;

export type AionisArchiveRehydrateRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  node_ids?: string[];
  client_ids?: string[];
  target_tier?: "warm" | "hot";
  reason?: string;
  input_text?: string;
  input_sha256?: string;
} & AionisRequestPayload;

export type AionisNodesActivateRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  node_ids?: string[];
  client_ids?: string[];
  run_id?: string;
  outcome?: "positive" | "negative" | "neutral";
  activate?: boolean;
  reason?: string;
  input_text?: string;
  input_sha256?: string;
} & AionisRequestPayload;

export type AionisDelegationRecordsWriteRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  record_id?: string;
  run_id?: string;
  handoff_anchor?: string;
  handoff_uri?: string;
  route_role?: string;
  task_family?: string;
  title?: string;
  summary?: string;
  input_text?: string;
  tags?: string[];
  delegation_records_v1: AionisExecutionDelegationRecordsSummary;
  execution_result_summary?: Record<string, unknown>;
  execution_artifacts?: Array<Record<string, unknown>>;
  execution_evidence?: Array<Record<string, unknown>>;
  execution_state_v1?: Record<string, unknown>;
  execution_packet_v1?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisDelegationRecordsWriteResponse = {
  summary_version: "delegation_records_write_v1";
  tenant_id: string;
  scope: string;
  commit_id: string;
  commit_uri: string | null;
  record_event: {
    node_id: string;
    uri: string;
    client_id: string;
    record_id: string;
    memory_lane: "private" | "shared";
    run_id: string | null;
    handoff_anchor: string | null;
    route_role: string;
    task_family: string | null;
    family_scope: string;
    record_mode: "memory_only" | "packet_backed";
  } | null;
  delegation_records_v1: AionisExecutionDelegationRecordsSummary;
  execution_result_summary: Record<string, unknown> | null;
  execution_artifacts: Array<Record<string, unknown>>;
  execution_evidence: Array<Record<string, unknown>>;
  execution_state_v1: Record<string, unknown> | null;
  execution_packet_v1: Record<string, unknown> | null;
} & AionisRuntimeResponse;

export type AionisDelegationRecordsFindRequest = {
  tenant_id?: string;
  scope?: string;
  record_id?: string;
  run_id?: string;
  handoff_anchor?: string;
  handoff_uri?: string;
  route_role?: string;
  task_family?: string;
  family_scope?: string;
  record_mode?: "memory_only" | "packet_backed";
  memory_lane?: "private" | "shared";
  consumer_agent_id?: string;
  consumer_team_id?: string;
  include_payload?: boolean;
  limit?: number;
  offset?: number;
} & AionisRequestPayload;

export type AionisDelegationRecordSideOutputSummary = {
  result_present: boolean;
  artifact_count: number;
  evidence_count: number;
  execution_state_v1_present: boolean;
  execution_packet_v1_present: boolean;
} & Record<string, string | number | boolean | null | undefined>;

export type AionisDelegationRecordFindEntry = {
  uri: string;
  node_id: string;
  client_id: string | null;
  record_id: string | null;
  title: string | null;
  text_summary: string | null;
  memory_lane: "private" | "shared";
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  created_at: string;
  updated_at: string;
  commit_id: string | null;
  run_id: string | null;
  handoff_anchor: string | null;
  handoff_uri: string | null;
  route_role: string;
  task_family: string | null;
  family_scope: string;
  record_mode: "memory_only" | "packet_backed";
  tags: string[];
  delegation_records_v1: AionisExecutionDelegationRecordsSummary;
  execution_side_outputs: AionisDelegationRecordSideOutputSummary;
  execution_result_summary?: Record<string, unknown> | null;
  execution_artifacts?: Array<Record<string, unknown>>;
  execution_evidence?: Array<Record<string, unknown>>;
  execution_state_v1?: Record<string, unknown> | null;
  execution_packet_v1?: Record<string, unknown> | null;
} & AionisRuntimeResponse;

export type AionisDelegationRecordsFindSummary = {
  summary_version: "delegation_records_find_summary_v1";
  returned_records: number;
  has_more: boolean;
  invalid_records: number;
  filters_applied: string[];
  record_mode_counts: Record<string, number>;
  memory_lane_counts: Record<string, number>;
  route_role_counts: Record<string, number>;
  task_family_counts: Record<string, number>;
  missing_record_type_counts: Record<string, number>;
  return_status_counts: Record<string, number>;
  artifact_source_counts: Record<string, number>;
  packet_count: number;
  return_count: number;
  artifact_routing_count: number;
  run_id_count: number;
  handoff_anchor_count: number;
} & AionisRuntimeResponse;

export type AionisDelegationRecordsFindResponse = {
  summary_version: "delegation_records_find_v1";
  tenant_id: string;
  scope: string;
  records: AionisDelegationRecordFindEntry[];
  summary: AionisDelegationRecordsFindSummary;
} & AionisRuntimeResponse;

export type AionisDelegationRecordsAggregateRequest = {
  tenant_id?: string;
  scope?: string;
  record_id?: string;
  run_id?: string;
  handoff_anchor?: string;
  handoff_uri?: string;
  route_role?: string;
  task_family?: string;
  family_scope?: string;
  record_mode?: "memory_only" | "packet_backed";
  memory_lane?: "private" | "shared";
  consumer_agent_id?: string;
  consumer_team_id?: string;
  limit?: number;
} & AionisRequestPayload;

export type AionisDelegationRecordsAggregateBucket = {
  key: string;
  record_count: number;
  packet_count: number;
  return_count: number;
  artifact_routing_count: number;
  record_mode_counts: Record<string, number>;
  task_family_counts?: Record<string, number>;
  route_role_counts?: Record<string, number>;
  return_status_counts: Record<string, number>;
  artifact_source_counts: Record<string, number>;
} & AionisRuntimeResponse;

export type AionisDelegationRecordsAggregateRefStat = {
  ref: string;
  ref_kind: "artifact" | "evidence";
  count: number;
  source_counts: Record<string, number>;
} & AionisRuntimeResponse;

export type AionisDelegationRecordsAggregateStringStat = {
  value: string;
  count: number;
} & AionisRuntimeResponse;

export type AionisDelegationRecordsReusablePattern = {
  route_role: string;
  task_family: string;
  record_count: number;
  record_mode_counts: Record<string, number>;
  record_outcome_counts: Record<string, number>;
  sample_mission: string | null;
  sample_acceptance_checks: string[];
  sample_working_set_files: string[];
  sample_artifact_refs: string[];
} & AionisRuntimeResponse;

export type AionisDelegationRecordsLearningRecommendation = {
  recommendation_kind:
    | "capture_missing_returns"
    | "review_blocked_pattern"
    | "increase_artifact_capture"
    | "promote_reusable_pattern";
  priority: "high" | "medium" | "low";
  route_role: string | null;
  task_family: string | null;
  recommended_action: string;
  rationale: string;
  sample_mission: string | null;
  sample_acceptance_checks: string[];
  sample_working_set_files: string[];
  sample_artifact_refs: string[];
} & AionisRuntimeResponse;

export type AionisDelegationRecordsAggregateSummary = {
  summary_version: "delegation_records_aggregate_summary_v1";
  matched_records: number;
  truncated: boolean;
  invalid_records: number;
  filters_applied: string[];
  record_mode_counts: Record<string, number>;
  memory_lane_counts: Record<string, number>;
  route_role_counts: Record<string, number>;
  task_family_counts: Record<string, number>;
  missing_record_type_counts: Record<string, number>;
  return_status_counts: Record<string, number>;
  normalized_return_status_counts: Record<string, number>;
  record_outcome_counts: Record<string, number>;
  artifact_source_counts: Record<string, number>;
  packet_count: number;
  return_count: number;
  artifact_routing_count: number;
  run_id_count: number;
  handoff_anchor_count: number;
  records_with_returns: number;
  records_with_missing_types: number;
  records_with_payload_result: number;
  records_with_payload_artifacts: number;
  records_with_payload_evidence: number;
  records_with_payload_state: number;
  records_with_payload_packet: number;
  completion_rate: number;
  blocked_rate: number;
  missing_return_rate: number;
  route_role_buckets: AionisDelegationRecordsAggregateBucket[];
  task_family_buckets: AionisDelegationRecordsAggregateBucket[];
  top_reusable_patterns: AionisDelegationRecordsReusablePattern[];
  learning_recommendations: AionisDelegationRecordsLearningRecommendation[];
  top_artifact_refs: AionisDelegationRecordsAggregateRefStat[];
  top_acceptance_checks: AionisDelegationRecordsAggregateStringStat[];
  top_working_set_files: AionisDelegationRecordsAggregateStringStat[];
} & AionisRuntimeResponse;

export type AionisDelegationRecordsAggregateResponse = {
  summary_version: "delegation_records_aggregate_v1";
  tenant_id: string;
  scope: string;
  summary: AionisDelegationRecordsAggregateSummary;
} & AionisRuntimeResponse;

export type AionisHandoffStoreRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  handoff_kind: string;
  anchor: string;
  summary: string;
  handoff_text: string;
  memory_lane?: "private" | "shared";
  file_path?: string;
  repo_root?: string;
  symbol?: string;
  risk?: string;
  acceptance_checks?: string[];
  tags?: string[];
  target_files?: string[];
  next_action?: string;
  must_change?: string[];
  must_remove?: string[];
  must_keep?: string[];
  execution_result_summary?: Record<string, unknown>;
  execution_artifacts?: Array<Record<string, unknown>>;
  execution_evidence?: Array<Record<string, unknown>>;
  execution_state_v1?: Record<string, unknown>;
  execution_packet_v1?: Record<string, unknown>;
  control_profile_v1?: Record<string, unknown>;
  execution_transitions_v1?: Array<Record<string, unknown>>;
} & AionisRequestPayload;

export type AionisHandoffRecoverRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  handoff_id?: string;
  handoff_uri?: string;
  anchor?: string;
  handoff_kind?: string;
  repo_root?: string;
  file_path?: string;
  symbol?: string;
  include_payload?: boolean;
} & AionisRequestPayload;

export type AionisContinuityReviewPackRequest = AionisHandoffRecoverRequest;

export type AionisContinuityFocusItem = {
  source_kind: string;
  continuity_kind: string;
  continuity_phase: string;
  occurred_at: string | null;
  title: string | null;
  text_summary: string | null;
  anchor?: string | null;
  handoff_kind?: string | null;
  file_path?: string | null;
  repo_root?: string | null;
  symbol?: string | null;
  next_action?: string | null;
} & AionisPassthroughObject;

export type AionisContinuityInspectSummary = {
  inspect_version: "continuity_inspect_v1";
  latest_handoff: AionisContinuityFocusItem | null;
  latest_resume: AionisContinuityFocusItem | null;
  latest_terminal_run: AionisContinuityFocusItem | null;
} & AionisPassthroughObject;

export type AionisContinuityReviewContract = {
  target_files: string[];
  next_action: string | null;
  acceptance_checks: string[];
  must_change: string[];
  must_remove: string[];
  must_keep: string[];
  rollback_required: boolean;
} & AionisPassthroughObject;

export type AionisContinuityReviewPackSummary = {
  pack_version: "continuity_review_pack_v1";
  latest_handoff: AionisContinuityFocusItem | null;
  latest_resume: AionisContinuityFocusItem | null;
  latest_terminal_run: AionisContinuityFocusItem | null;
  recovered_handoff: AionisPassthroughObject | null;
  review_contract: AionisContinuityReviewContract | null;
} & AionisPassthroughObject;

export type AionisContinuityReviewPackResponse = {
  tenant_id: string;
  scope: string;
  sources: AionisPassthroughObject[];
  items: AionisPassthroughObject[];
  page: {
    limit: number;
    offset: number;
    returned: number;
    has_more: boolean;
  };
  counters?: {
    total_items?: number;
    returned_items?: number;
    source_count?: number;
  } & AionisPassthroughObject;
  continuity_inspect: AionisContinuityInspectSummary;
  continuity_review_pack: AionisContinuityReviewPackSummary;
} & AionisRuntimeResponse;

export type AionisEvolutionReviewPackRequest = AionisKickoffRecommendationRequest & {
  limit?: number;
};

export type AionisEvolutionInspectSummary = {
  summary_version: "evolution_inspect_summary_v1";
  history_applied: boolean;
  selected_tool: string | null;
  recommended_file_path: string | null;
  recommended_next_action: string | null;
  stable_workflow_count: number;
  promotion_ready_workflow_count: number;
  trusted_pattern_count: number;
  contested_pattern_count: number;
  suppressed_pattern_count: number;
} & AionisPassthroughObject;

export type AionisEvolutionInspectResponse = {
  summary_version: "evolution_inspect_v1";
  tenant_id: string;
  scope: string;
  query_text: string;
  experience_intelligence: AionisExperienceIntelligenceResponse;
  policy_hints?: AionisPolicyHintPack;
  derived_policy: AionisDerivedPolicySurface | null;
  policy_contract: AionisPolicyContract | null;
  policy_review: AionisPolicyReviewSummary;
  policy_learning_control_contract: AionisPolicyLearningControlContract;
  policy_learning_control_apply_payload: AionisPolicyLearningControlApplyPayload | null;
  policy_learning_control_apply_result: AionisPolicyLearningControlApplyResult | null;
  kickoff_recommendation: AionisKickoffRecommendationResponse;
  execution_introspection: AionisExecutionIntrospectResponse;
  evolution_summary: AionisEvolutionInspectSummary;
} & AionisPassthroughObject;

export type AionisEvolutionReviewContract = {
  selected_tool: string | null;
  file_path: string | null;
  target_files: string[];
  next_action: string | null;
  stable_workflow_anchor_id: string | null;
  promotion_ready_anchor_ids: string[];
  trusted_pattern_anchor_ids: string[];
  contested_pattern_anchor_ids: string[];
  suppressed_pattern_anchor_ids: string[];
} & AionisPassthroughObject;

export type AionisEvolutionDelegationLearningSummary = AionisDelegationLearningSummary;

export type AionisEvolutionReviewPackSummary = {
  pack_version: "evolution_review_pack_v1";
  stable_workflow: AionisPassthroughObject | null;
  promotion_ready_workflow: AionisPassthroughObject | null;
  trusted_pattern: AionisPassthroughObject | null;
  contested_pattern: AionisPassthroughObject | null;
  derived_policy: AionisDerivedPolicySurface | null;
  policy_contract: AionisPolicyContract | null;
  policy_review: AionisPolicyReviewSummary;
  policy_learning_control_contract: AionisPolicyLearningControlContract;
  policy_learning_control_apply_payload: AionisPolicyLearningControlApplyPayload | null;
  policy_learning_control_apply_result: AionisPolicyLearningControlApplyResult | null;
  review_contract: AionisEvolutionReviewContract;
  learning_summary: AionisEvolutionDelegationLearningSummary;
  learning_recommendations: AionisDelegationRecordsLearningRecommendation[];
} & AionisPassthroughObject;

export type AionisEvolutionReviewPackResponse = {
  summary_version: "evolution_review_pack_v1";
  tenant_id: string;
  scope: string;
  query_text: string;
  evolution_inspect: AionisEvolutionInspectResponse;
  evolution_review_pack: AionisEvolutionReviewPackSummary;
} & AionisRuntimeResponse;

export type AionisAgentMemoryInspectRequest = AionisExperienceIntelligenceRequest & {
  handoff_id?: string;
  handoff_uri?: string;
  anchor?: string;
  repo_root?: string;
  file_path?: string;
  symbol?: string;
  handoff_kind?: string;
  memory_lane?: "private" | "shared";
  include_payload?: boolean;
  session_id?: string;
  source_kind?: string;
  continuity_kind?: string;
  continuity_phase?: string;
  include_meta?: boolean;
  limit?: number;
  offset?: number;
};

export type AionisAgentMemoryInspectSummary = {
  summary_version: "agent_memory_inspect_summary_v1";
  has_continuity: boolean;
  latest_handoff_anchor: string | null;
  latest_resume_source_kind: string | null;
  selected_tool: string | null;
  recommended_file_path: string | null;
  recommended_next_action: string | null;
  history_applied: boolean;
  stable_workflow_count: number;
  promotion_ready_workflow_count: number;
  trusted_pattern_count: number;
  suppressed_pattern_count: number;
  handoff_related_items: number;
  resume_related_items: number;
  derived_policy_source_kind: "trusted_pattern" | "stable_workflow" | "blended" | null;
  derived_policy_selected_tool: string | null;
  derived_policy_state: "candidate" | "stable" | null;
  policy_activation_mode: "hint" | "default" | null;
  policy_review_recommended: boolean;
  contested_policy_count: number;
  retired_policy_count: number;
  selected_policy_memory_state: "active" | "contested" | "retired" | null;
  policy_learning_control_action: "none" | "monitor" | "refresh" | "retire" | "reactivate";
  policy_learning_control_review_required: boolean;
  policy_learning_control_apply_payload: AionisPolicyLearningControlApplyPayload | null;
  policy_learning_control_auto_applied: boolean;
};

export type AionisAgentMemoryInspectResponse = {
  summary_version: "agent_memory_inspect_v1";
  tenant_id: string;
  scope: string;
  query_text: string;
  continuity_inspect: AionisContinuityInspectSummary | null;
  continuity_review_pack: AionisContinuityReviewPackSummary | null;
  evolution_inspect: AionisEvolutionInspectResponse;
  evolution_review_pack: AionisEvolutionReviewPackSummary;
  derived_policy: AionisDerivedPolicySurface | null;
  policy_contract: AionisPolicyContract | null;
  policy_review: AionisPolicyReviewSummary;
  policy_learning_control_contract: AionisPolicyLearningControlContract;
  policy_learning_control_apply_payload: AionisPolicyLearningControlApplyPayload | null;
  policy_learning_control_apply_result: AionisPolicyLearningControlApplyResult | null;
  agent_memory_summary: AionisAgentMemoryInspectSummary;
} & AionisRuntimeResponse;

export type AionisAgentMemoryReviewPackRequest = AionisAgentMemoryInspectRequest;

export type AionisAgentMemoryReviewPackSummary = {
  pack_version: "agent_memory_review_pack_v1";
  selected_tool: string | null;
  recommended_file_path: string | null;
  recommended_next_action: string | null;
  latest_handoff_anchor: string | null;
  latest_resume_source_kind: string | null;
  stable_workflow_anchor_id: string | null;
  promotion_ready_anchor_ids: string[];
  trusted_pattern_anchor_ids: string[];
  contested_pattern_anchor_ids: string[];
  suppressed_pattern_anchor_ids: string[];
  handoff_target_files: string[];
  acceptance_checks: string[];
  must_change: string[];
  must_remove: string[];
  must_keep: string[];
  rollback_required: boolean;
  derived_policy: AionisDerivedPolicySurface | null;
  policy_contract: AionisPolicyContract | null;
  policy_review: AionisPolicyReviewSummary;
  policy_learning_control_contract: AionisPolicyLearningControlContract;
  policy_learning_control_apply_payload: AionisPolicyLearningControlApplyPayload | null;
  policy_learning_control_apply_result: AionisPolicyLearningControlApplyResult | null;
} & AionisPassthroughObject;

export type AionisAgentMemoryReviewPackResponse = {
  summary_version: "agent_memory_review_pack_v1";
  tenant_id: string;
  scope: string;
  query_text: string;
  agent_memory_inspect: AionisAgentMemoryInspectResponse;
  agent_memory_review_pack: AionisAgentMemoryReviewPackSummary;
} & AionisRuntimeResponse;

export type AionisAgentMemoryResumePackRequest = AionisAgentMemoryInspectRequest;

export type AionisAgentMemoryResumePackSummary = {
  pack_version: "agent_memory_resume_pack_v1";
  latest_handoff_anchor: string | null;
  latest_resume_source_kind: string | null;
  resume_selected_tool: string | null;
  resume_file_path: string | null;
  resume_target_files: string[];
  resume_next_action: string | null;
  stable_workflow_anchor_id: string | null;
  promotion_ready_anchor_ids: string[];
  trusted_pattern_anchor_ids: string[];
  suppressed_pattern_anchor_ids: string[];
  rollback_required: boolean;
  recovered_handoff: AionisPassthroughObject | null;
  execution_ready_handoff: AionisPassthroughObject | null;
  derived_policy: AionisDerivedPolicySurface | null;
  policy_contract: AionisPolicyContract | null;
  policy_learning_control_apply_payload: AionisPolicyLearningControlApplyPayload | null;
  policy_learning_control_apply_result: AionisPolicyLearningControlApplyResult | null;
} & AionisPassthroughObject;

export type AionisAgentMemoryResumePackResponse = {
  summary_version: "agent_memory_resume_pack_v1";
  tenant_id: string;
  scope: string;
  query_text: string;
  agent_memory_inspect: AionisAgentMemoryInspectResponse;
  agent_memory_resume_pack: AionisAgentMemoryResumePackSummary;
} & AionisRuntimeResponse;

export type AionisAgentMemoryHandoffPackRequest = AionisAgentMemoryInspectRequest;

export type AionisAgentMemoryHandoffPackSummary = {
  pack_version: "agent_memory_handoff_pack_v1";
  latest_handoff_anchor: string | null;
  handoff_kind: string | null;
  handoff_file_path: string | null;
  handoff_repo_root: string | null;
  handoff_symbol: string | null;
  handoff_target_files: string[];
  handoff_next_action: string | null;
  acceptance_checks: string[];
  must_change: string[];
  must_remove: string[];
  must_keep: string[];
  rollback_required: boolean;
  stable_workflow_anchor_id: string | null;
  trusted_pattern_anchor_ids: string[];
  suppressed_pattern_anchor_ids: string[];
  recovered_handoff: AionisPassthroughObject | null;
  execution_ready_handoff: AionisPassthroughObject | null;
  derived_policy: AionisDerivedPolicySurface | null;
  policy_contract: AionisPolicyContract | null;
  policy_learning_control_apply_payload: AionisPolicyLearningControlApplyPayload | null;
  policy_learning_control_apply_result: AionisPolicyLearningControlApplyResult | null;
} & AionisPassthroughObject;

export type AionisAgentMemoryHandoffPackResponse = {
  summary_version: "agent_memory_handoff_pack_v1";
  tenant_id: string;
  scope: string;
  query_text: string;
  agent_memory_inspect: AionisAgentMemoryInspectResponse;
  agent_memory_handoff_pack: AionisAgentMemoryHandoffPackSummary;
} & AionisRuntimeResponse;

export type AionisReplayRunStartRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  run_id?: string;
  goal: string;
  context_snapshot_ref?: string;
  context_snapshot_hash?: string;
  metadata?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisReplayStepBeforeRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  run_id: string;
  step_id?: string;
  decision_id?: string;
  step_index: number;
  tool_name: string;
  tool_input: unknown;
  expected_output_signature?: unknown;
  preconditions?: Array<Record<string, unknown>>;
  retry_policy?: Record<string, unknown>;
  safety_level?: "auto_ok" | "needs_confirm" | "manual_only";
  metadata?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisReplayStepAfterRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  run_id: string;
  step_id?: string;
  step_index?: number;
  status: "success" | "failed" | "skipped" | "partial";
  output_signature?: unknown;
  postconditions?: Array<Record<string, unknown>>;
  artifact_refs?: string[];
  repair_applied?: boolean;
  repair_note?: string;
  error?: string;
  metadata?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisReplayRunEndRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  run_id: string;
  status: "success" | "failed" | "partial";
  summary?: string;
  success_criteria?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisStoreExecutionOutcomeStep = {
  step_id?: string;
  decision_id?: string;
  step_index?: number;
  tool_name: string;
  tool_input: unknown;
  expected_output_signature?: unknown;
  preconditions?: Array<Record<string, unknown>>;
  retry_policy?: Record<string, unknown>;
  safety_level?: "auto_ok" | "needs_confirm" | "manual_only";
  status: "success" | "failed" | "skipped" | "partial";
  output_signature?: unknown;
  postconditions?: Array<Record<string, unknown>>;
  artifact_refs?: string[];
  repair_applied?: boolean;
  repair_note?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type AionisStoreExecutionOutcomeRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  run_id?: string;
  goal: string;
  status: "success" | "failed" | "partial";
  summary?: string;
  context_snapshot_ref?: string;
  context_snapshot_hash?: string;
  success_criteria?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  steps?: AionisStoreExecutionOutcomeStep[];
  compile_playbook?: boolean;
  compile?: Pick<
    AionisReplayPlaybookCompileFromRunRequest,
    "playbook_id" | "name" | "version" | "matchers" | "success_criteria" | "risk_profile" | "allow_partial" | "metadata"
  >;
  simulate_playbook?: boolean;
  simulate?: Pick<AionisReplayPlaybookRunRequest, "version" | "deterministic_gate" | "params" | "max_steps">;
} & AionisRequestPayload;

export type AionisStoreExecutionOutcomeResponse = {
  summary_version: "store_execution_outcome_v1";
  tenant_id: string | null;
  scope: string | null;
  run_id: string;
  status: "success" | "failed" | "partial";
  started: AionisRuntimeResponse;
  steps: Array<{
    step_index: number;
    step_id: string | null;
    before: AionisRuntimeResponse;
    after: AionisRuntimeResponse;
  }>;
  ended: AionisRuntimeResponse;
  playbook_compile: AionisRuntimeResponse | null;
  playbook_simulation: AionisRuntimeResponse | null;
};

export type AionisReplayRunGetRequest = {
  tenant_id?: string;
  scope?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  run_id: string;
  include_steps?: boolean;
  include_artifacts?: boolean;
} & AionisRequestPayload;

export type AionisReplayPlaybookCompileFromRunRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  run_id: string;
  playbook_id?: string;
  name?: string;
  version?: number;
  matchers?: Record<string, unknown>;
  success_criteria?: Record<string, unknown>;
  risk_profile?: "low" | "medium" | "high";
  allow_partial?: boolean;
  metadata?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisReplayPlaybookGetRequest = {
  tenant_id?: string;
  scope?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  playbook_id: string;
} & AionisRequestPayload;

export type AionisReplayPlaybookCandidateRequest = {
  tenant_id?: string;
  scope?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  playbook_id: string;
  version?: number;
  deterministic_gate?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisReplayPlaybookPromoteRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  playbook_id: string;
  from_version?: number;
  target_status: "draft" | "shadow" | "active" | "disabled";
  note?: string;
  metadata?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisReplayPlaybookRunRequest = {
  tenant_id?: string;
  scope?: string;
  project_id?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  playbook_id: string;
  mode?: "strict" | "guided" | "simulate";
  version?: number;
  deterministic_gate?: Record<string, unknown>;
  params?: Record<string, unknown>;
  max_steps?: number;
} & AionisRequestPayload;

export type AionisReplayPlaybookDispatchRequest = {
  tenant_id?: string;
  scope?: string;
  project_id?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  playbook_id: string;
  version?: number;
  deterministic_gate?: Record<string, unknown>;
  fallback_mode?: "strict" | "guided" | "simulate";
  execute_fallback?: boolean;
  params?: Record<string, unknown>;
  max_steps?: number;
} & AionisRequestPayload;

export type AionisReplayPlaybookRepairRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  playbook_id: string;
  from_version?: number;
  patch: Record<string, unknown>;
  note?: string;
  review_required?: boolean;
  target_status?: "draft" | "shadow" | "active" | "disabled";
  metadata?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisReplayPlaybookRepairReviewRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  playbook_id: string;
  version?: number;
  action: "approve" | "reject";
  note?: string;
  auto_shadow_validate?: boolean;
  shadow_validation_mode?: "readiness" | "execute" | "execute_sandbox";
  shadow_validation_max_steps?: number;
  shadow_validation_params?: Record<string, unknown>;
  target_status_on_approve?: "draft" | "shadow" | "active" | "disabled";
  auto_promote_on_pass?: boolean;
  auto_promote_target_status?: "draft" | "shadow" | "active" | "disabled";
  auto_promote_gate?: Record<string, unknown>;
  learning_projection?: Record<string, unknown>;
  learning_control_review?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisSandboxSessionCreateRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  profile?: "default" | "restricted";
  ttl_seconds?: number;
  metadata?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisSandboxExecuteRequest = {
  tenant_id?: string;
  scope?: string;
  project_id?: string;
  actor?: string;
  session_id: string;
  planner_run_id?: string;
  decision_id?: string;
  mode?: "async" | "sync";
  timeout_ms?: number;
  action: {
    kind: "command";
    argv: string[];
  };
  metadata?: Record<string, unknown>;
} & AionisRequestPayload;

export type AionisSandboxRunGetRequest = {
  tenant_id?: string;
  scope?: string;
  run_id: string;
} & AionisRequestPayload;

export type AionisSandboxRunLogsRequest = {
  tenant_id?: string;
  scope?: string;
  run_id: string;
  tail_bytes?: number;
} & AionisRequestPayload;

export type AionisSandboxRunArtifactRequest = {
  tenant_id?: string;
  scope?: string;
  run_id: string;
  tail_bytes?: number;
  include_action?: boolean;
  include_output?: boolean;
  include_result?: boolean;
  include_metadata?: boolean;
  bundle_inline?: boolean;
} & AionisRequestPayload;

export type AionisSandboxRunCancelRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  run_id: string;
  reason?: string;
} & AionisRequestPayload;

export type AionisHealthResponse = {
  ok: boolean;
  runtime?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  lite?: Record<string, unknown>;
} & AionisRuntimeResponse;
