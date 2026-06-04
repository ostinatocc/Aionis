import test from "node:test";
import assert from "node:assert/strict";
import { buildActionIntelligenceRuntimeContractV1 } from "../../src/memory/action-intelligence-runtime-contract.ts";
import { buildExecutionContractFromProjection } from "../../src/memory/execution-contract.ts";
import {
  ActionRetrievalResponseSchema,
  ExperienceIntelligenceRequest,
  PromotionQualitySummaryV1Schema,
  RuntimeEffectSummaryV1Schema,
  RuntimeSignalTrendSummaryV1Schema,
  type ExecutionMemoryIntrospectionResponse,
} from "../../src/memory/schemas.ts";

function emptyAdaptiveGuidance(queryText: string) {
  return {
    summary_version: "adaptive_guidance_overlay_v1",
    activation_state: "empty",
    query_text: queryText,
    decomposition: {
      summary_version: "adaptive_guidance_decomposition_v1",
      query_text: queryText,
      task_family: null,
      query_terms: [],
      file_hints: [],
      tool_hints: [],
      subtasks: [{
        subtask_id: "test-empty-guidance",
        role: "task_intent",
        query_text: queryText,
        match_terms: [],
      }],
    },
    candidate_count: 0,
    selected_candidate_count: 0,
    skipped_candidate_count: 0,
    skipped_reasons: [],
    selected_candidates: [],
    adapted_instructions: [],
    authority_visibility: {
      summary_version: "adaptive_guidance_authority_v1",
      contract_trust: "observational",
      may_override_policy: false,
      may_promote_directly: false,
      required_promotion_path: "runtime_signal_attribution_and_learning_control_gate",
      blocked_authority_levels: ["authoritative", "advisory"],
    },
    attribution_plan: {
      summary_version: "adaptive_guidance_attribution_plan_v1",
      candidate_ids: [],
      expected_signal_kind: "adaptive_guidance_outcome",
      feedback_slots: ["adaptive_guidance_outcome_v1"],
      positive_authority_effect: "promotion_evidence_candidate",
      negative_authority_effect: "counter_evidence",
    },
    uncertainty_adjustment: {
      summary_version: "adaptive_guidance_uncertainty_adjustment_v1",
      confidence_delta: 0,
      recommended_actions: [],
      reason: null,
    },
    source_code_change_allowed: false,
  };
}

function emptyExperienceAdaptationTrace(queryText: string) {
  const adaptiveGuidance = emptyAdaptiveGuidance(queryText);
  return {
    summary_version: "execution_experience_adaptation_trace_v1",
    activation_state: "empty",
    trajectory: {
      present: false,
      compiled: false,
      task_family: null,
      task_signature: null,
      workflow_signature: null,
      target_file_count: 0,
      acceptance_check_count: 0,
      service_constraint_count: 0,
      likely_tool: null,
    },
    experience_sources: {
      stable_workflow_count: 0,
      candidate_workflow_count: 0,
      trusted_pattern_count: 0,
      contested_pattern_count: 0,
      rehydration_candidate_count: 0,
      supporting_knowledge_count: 0,
      adaptive_guidance_candidate_count: 0,
      delegation_recommendation_count: 0,
    },
    task_decomposition: adaptiveGuidance.decomposition,
    retrieval: {
      selected_tool: null,
      tool_source_kind: "tools_select",
      path_source_kind: "none",
      selected_path_anchor_id: null,
      evidence_entry_count: 0,
      uncertainty_level: "high",
      confidence: 0.22,
    },
    adaptation: {
      activation_state: "empty",
      selected_candidate_ids: [],
      adapted_instruction_count: 0,
      primary_instruction: null,
      recommended_actions: [],
      confidence_delta: 0,
      feedback_slots: ["adaptive_guidance_outcome_v1"],
      expected_signal_kind: "adaptive_guidance_outcome",
      promotion_requires_candidate_binding: true,
    },
    authority: {
      contract_trust: "observational",
      may_promote_directly: false,
      required_promotion_path: "runtime_signal_attribution_and_learning_control_gate",
      source_code_change_allowed: false,
    },
    stages: [
      { stage: "trajectory_compile", status: "empty", summary: "no trajectory input present", source_refs: [], evidence_refs: [] },
      { stage: "experience_intelligence", status: "empty", summary: "no execution experience sources matched", source_refs: [], evidence_refs: [] },
      { stage: "task_decomposition", status: "ready", summary: "task decomposition produced 1 subtasks", source_refs: ["test-empty-guidance"], evidence_refs: [] },
      { stage: "action_retrieval", status: "empty", summary: "action retrieval selected tools_select", source_refs: [], evidence_refs: [] },
      { stage: "adaptive_guidance", status: "empty", summary: "adaptive guidance selected 0 candidates", source_refs: [], evidence_refs: [] },
      { stage: "feedback_attribution", status: "empty", summary: "feedback attribution requires selected candidate binding before promotion", source_refs: ["adaptive_guidance_outcome_v1"], evidence_refs: [] },
    ],
    source_code_change_allowed: false,
  };
}

function introspectionSlice(args?: {
  authoritativeBlocked?: number;
  stablePromotionBlocked?: number;
  distilledEvidence?: number;
  distilledFact?: number;
  projectedWorkflow?: number;
}): ExecutionMemoryIntrospectionResponse {
  return {
    authority_visibility_summary: {
      authoritative_blocked_count: args?.authoritativeBlocked ?? 0,
      stable_promotion_blocked_count: args?.stablePromotionBlocked ?? 0,
    },
    distillation_signal_summary: {
      distilled_evidence_count: args?.distilledEvidence ?? 0,
      distilled_fact_count: args?.distilledFact ?? 0,
      projected_workflow_candidate_count: args?.projectedWorkflow ?? 0,
    },
  } as ExecutionMemoryIntrospectionResponse;
}

function constrainingTrendSummary() {
  return RuntimeSignalTrendSummaryV1Schema.parse({
    summary_version: "runtime_signal_trend_summary_v1",
    scanned_node_count: 4,
    included_ledger_count: 2,
    entry_count: 2,
    truncated: false,
    signal_counts: [
      {
        signal_kind: "repeated_failed_action",
        total: 2,
        positive: 0,
        neutral: 0,
        negative: 2,
        authority_effects: {
          none: 0,
          promotion_evidence_candidate: 0,
          counter_evidence: 2,
          quarantine: 0,
          forgetting_signal: 0,
        },
      },
    ],
    polarity_counts: { positive: 0, neutral: 0, negative: 2 },
    authority_effect_counts: {
      none: 0,
      promotion_evidence_candidate: 0,
      counter_evidence: 2,
      quarantine: 0,
      forgetting_signal: 0,
    },
    capability_counts: {
      continuity: 0,
      learning: 2,
      forgetting: 2,
      learning_control: 2,
    },
    quarantine_signal_count: 0,
    counter_evidence_count: 2,
    promotion_evidence_candidate_count: 0,
    forgetting_signal_count: 0,
    numeric_trends: [
      {
        signal_kind: "repeated_failed_action",
        count: 2,
        min: 1,
        max: 1,
        average: 1,
      },
    ],
    dominant_negative_signals: ["repeated_failed_action"],
    dominant_positive_signals: [],
    recommended_runtime_posture: "constrain",
    findings: ["Counter-evidence exceeds promotion candidates; learning should remain constrained."],
    source_node_ids: ["node:counter-evidence"],
    source_code_change_allowed: false,
  });
}

function invalidatingPromotionQualitySummary() {
  return PromotionQualitySummaryV1Schema.parse({
    summary_version: "promotion_quality_summary_v1",
    scanned_node_count: 4,
    included_ledger_count: 4,
    evidence_entry_count: 4,
    truncated: false,
    verdict_counts: {
      candidate_only: 1,
      promotion_admitted: 1,
      promotion_blocked: 1,
      contested: 1,
    },
    transition_counts: [
      {
        transition: "L1_to_L2",
        total: 2,
        candidate_only: 1,
        promotion_admitted: 1,
        promotion_blocked: 0,
        contested: 0,
        counter_evidence_count: 0,
      },
      {
        transition: "L2_to_L3",
        total: 1,
        candidate_only: 0,
        promotion_admitted: 0,
        promotion_blocked: 0,
        contested: 1,
        counter_evidence_count: 1,
      },
      {
        transition: "L3_to_L4",
        total: 1,
        candidate_only: 0,
        promotion_admitted: 0,
        promotion_blocked: 1,
        contested: 0,
        counter_evidence_count: 0,
      },
    ],
    target_kind_counts: [
      {
        target_kind: "workflow",
        total: 2,
        candidate_only: 1,
        promotion_admitted: 1,
        promotion_blocked: 0,
        contested: 0,
        counter_evidence_count: 0,
      },
      {
        target_kind: "pattern",
        total: 1,
        candidate_only: 0,
        promotion_admitted: 0,
        promotion_blocked: 0,
        contested: 1,
        counter_evidence_count: 1,
      },
      {
        target_kind: "policy",
        total: 1,
        candidate_only: 0,
        promotion_admitted: 0,
        promotion_blocked: 1,
        contested: 0,
        counter_evidence_count: 0,
      },
    ],
    authority_gate_counts: { admitted: 2, rejected: 1, unknown: 1 },
    learning_control_counts: { admitted: 2, rejected: 1, unknown: 1 },
    verifier_status_counts: { succeeded: 2, failed: 1, incomplete: 0, unknown: 1, missing: 0 },
    contract_trust_counts: { authoritative: 2, advisory: 1, observational: 1, missing: 0 },
    promotion_evidence_ref_count: 5,
    counter_evidence_ref_count: 1,
    distinct_target_count: 4,
    distinct_source_run_count: 5,
    distinct_source_commit_count: 4,
    promotion_admission_rate: 0.25,
    contested_rate: 0.25,
    invalidation_pressure: "high",
    recommended_learning_posture: "invalidate",
    findings: ["Counter-evidence or contested ledgers are present and should feed invalidation review."],
    source_node_ids: ["node:promotion-quality"],
    source_code_change_allowed: false,
  });
}

function constrainedRuntimeEffectSummary() {
  return RuntimeEffectSummaryV1Schema.parse({
    summary_version: "runtime_effect_summary_v1",
    scanned_node_count: 3,
    included_signal_ledger_count: 2,
    included_promotion_ledger_count: 1,
    context_cost_observation_count: 1,
    truncated: false,
    baseline_comparison_required: true,
    token_context: {
      observed_count: 1,
      within_budget_count: 0,
      over_budget_count: 1,
      unknown_budget_count: 0,
      average_est_tokens: 18000,
      average_token_budget: 12000,
      max_est_tokens: 18000,
      context_items_reduced_count: 1,
      primary_savings_levers: ["token_budget"],
    },
    continuity: {
      repeated_discovery_count: 2,
      repeated_failed_action_count: 0,
      continuity_ready_signal_count: 0,
    },
    verification: {
      verifier_success_count: 0,
      verifier_failure_count: 1,
      retry_count_total: 1,
      recovery_cost_total: 2,
      provider_quarantine_count: 0,
    },
    learning: {
      workflow_reuse_success_count: 0,
      workflow_reuse_failure_count: 1,
      tool_selection_success_count: 0,
      tool_selection_failure_count: 0,
      promotion_admission_rate: 0,
      promotion_contested_rate: 0,
      promotion_invalidation_pressure: "medium",
      recommended_learning_posture: "constrain",
    },
    forgetting: {
      forgetting_signal_count: 1,
      memory_demotions: 0,
      memory_archives: 0,
      rehydration_useful_count: 0,
      rehydration_unhelpful_count: 0,
    },
    measurable_effect_posture: "constrained",
    findings: ["Baseline comparison is still required before claiming product-level effectiveness."],
    source_node_ids: ["node:runtime-effect"],
    source_code_change_allowed: false,
  });
}

test("action intelligence runtime contract records the full loop from action retrieval and execution evidence", () => {
  const executionContract = buildExecutionContractFromProjection({
    task_family: "runtime_contract_repair",
    workflow_signature: "inspect_patch_verify",
    selected_tool: "edit",
    target_files: ["src/runtime-contract.ts"],
    next_action: "Patch src/runtime-contract.ts and run the targeted verifier.",
    acceptance_checks: ["npm test -- runtime-contract"],
    provenance: {
      source_kind: "action_retrieval",
      source_summary_version: "action_retrieval_v1",
      source_anchor: "wf_runtime_contract",
      evidence_refs: ["verifier:runtime-contract"],
      notes: [],
    },
  });
  const actionRetrieval = ActionRetrievalResponseSchema.parse({
    summary_version: "action_retrieval_v1",
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: "repair the runtime contract",
    history_applied: true,
    tool_source_kind: "stable_workflow",
    selected_tool: "edit",
    recommended_file_path: "src/runtime-contract.ts",
    recommended_next_action: "Patch src/runtime-contract.ts and run the targeted verifier.",
    execution_contract_v1: executionContract,
    tool: {
      selected_tool: "edit",
      ordered_tools: ["edit", "test"],
      preferred_tools: ["edit"],
      allowed_tools: ["edit", "test"],
      trusted_pattern_anchor_ids: ["pattern_edit"],
      candidate_pattern_anchor_ids: [],
      suppressed_pattern_anchor_ids: [],
    },
    path: {
      source_kind: "recommended_workflow",
      anchor_id: "wf_runtime_contract",
      contract_trust: "advisory",
      task_family: "runtime_contract_repair",
      workflow_signature: "inspect_patch_verify",
      title: "Inspect, patch, verify",
      summary: "Stable workflow for contract repair.",
      file_path: "src/runtime-contract.ts",
      target_files: ["src/runtime-contract.ts"],
      next_action: "Patch src/runtime-contract.ts and run the targeted verifier.",
      confidence: 0.82,
      tool_set: ["edit", "test"],
      reason: "stable workflow matched the request",
    },
    evidence: {
      stable_workflow_count: 1,
      candidate_workflow_count: 0,
      trusted_pattern_count: 1,
      contested_pattern_count: 0,
      rehydration_candidate_count: 0,
      adaptive_guidance_candidate_count: 0,
      persisted_policy_memory_id: "policy_runtime_contract",
      selected_path_anchor_id: "wf_runtime_contract",
      entries: [
        {
          source_kind: "stable_workflow",
          anchor_id: "wf_runtime_contract",
          selected_tool: "edit",
          task_family: "runtime_contract_repair",
          workflow_signature: "inspect_patch_verify",
          file_path: "src/runtime-contract.ts",
          target_files: ["src/runtime-contract.ts"],
          confidence: 0.82,
          reason: "stable workflow evidence",
        },
      ],
    },
    adaptive_guidance: emptyAdaptiveGuidance("repair the runtime contract"),
    experience_adaptation_trace: emptyExperienceAdaptationTrace("repair the runtime contract"),
    uncertainty: {
      summary_version: "action_retrieval_uncertainty_v1",
      level: "low",
      confidence: 0.86,
      evidence_gap_count: 0,
      reasons: ["stable workflow and learned execution memory agree on the next step"],
      recommended_actions: ["proceed"],
    },
    rationale: {
      summary: "stable workflow selected",
    },
  });
  const parsed = ExperienceIntelligenceRequest.parse({
    tenant_id: "tenant-a",
    scope: "scope-a",
    run_id: "run-runtime-contract",
    query_text: "repair the runtime contract",
    context: { file_path: "src/runtime-contract.ts" },
    candidates: ["read_file", "edit", "test"],
    execution_result_summary: {
      ref: "verifier:runtime-contract",
      kind: "verifier",
      status: "passed",
    },
    execution_artifacts: [{ ref: "artifact:patch" }],
    execution_evidence: [
      {
        ref: "evidence:targeted-verifier",
        kind: "verifier_result",
        verifier_command: "npm test -- runtime-contract",
      },
    ],
  });

  const contract = buildActionIntelligenceRuntimeContractV1({
    parsed,
    actionRetrieval,
    introspection: introspectionSlice({ distilledEvidence: 1, projectedWorkflow: 1 }),
    derivedPolicy: null,
    policyContract: null,
  });

  assert.equal(contract.contract_version, "action_intelligence_runtime_contract_v1");
  assert.equal(contract.source_code_change_allowed, false);
  assert.equal(contract.pre_action_gate.known_enough, true);
  assert.equal(contract.pre_action_gate.requires_rehydration, false);
  assert.equal(contract.runtime_entropy_profile.profile_version, "runtime_entropy_profile_v1");
  assert.equal(contract.runtime_entropy_profile.entropy_level, "low");
  assert.equal(contract.runtime_entropy_profile.recall_breadth, "narrow");
  assert.equal(contract.runtime_entropy_profile.verification_depth, "light");
  assert.equal(contract.runtime_entropy_profile.mutation_authority, "stable_allowed");
  assert.equal(contract.runtime_entropy_controls.controls_version, "runtime_entropy_controls_v1");
  assert.equal(contract.runtime_entropy_controls.recall.recommended_limit, 6);
  assert.equal(contract.runtime_entropy_controls.verifier.schedule, "light");
  assert.equal(contract.runtime_entropy_controls.promotion.stable_promotion_allowed, true);
  assert.equal(contract.runtime_entropy_controls.maintenance.recommended_profile, "immediate");
  assert.equal(contract.loop.recall.status, "observed");
  assert.equal(contract.loop.retrieve.status, "ready");
  assert.equal(contract.loop.act.status, "observed");
  assert.equal(contract.loop.distill.status, "ready");
  assert.equal(contract.loop.evaluate.status, "observed");
  assert.equal(contract.loop.maintain.status, "ready");
  assert.deepEqual(contract.target_files, ["src/runtime-contract.ts"]);
  assert.equal(contract.workflow_anchor_id, "wf_runtime_contract");
  assert.equal(contract.policy_memory_id, "policy_runtime_contract");
  assert.equal(contract.evidence_summary.execution_evidence_count, 1);
  assert.equal(contract.evidence_summary.verifier_evidence_count, 2);
  assert.equal(contract.lifecycle.recommended_maintenance_profile, "immediate");
});

test("action intelligence runtime contract blocks action when recall or authority gaps remain", () => {
  const actionRetrieval = ActionRetrievalResponseSchema.parse({
    summary_version: "action_retrieval_v1",
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: "unknown repair task",
    history_applied: false,
    tool_source_kind: "tools_select",
    selected_tool: null,
    recommended_file_path: null,
    recommended_next_action: null,
    execution_contract_v1: null,
    tool: {
      selected_tool: null,
      ordered_tools: ["read_file"],
      preferred_tools: [],
      allowed_tools: ["read_file"],
      trusted_pattern_anchor_ids: [],
      candidate_pattern_anchor_ids: [],
      suppressed_pattern_anchor_ids: [],
    },
    path: {
      source_kind: "none",
      anchor_id: null,
      workflow_signature: null,
      title: null,
      summary: null,
      file_path: null,
      target_files: [],
      next_action: null,
      confidence: null,
      tool_set: [],
      authority_blocked: true,
      authority_primary_blocker: "unverified_authority",
      reason: "no learned workflow matched",
    },
    evidence: {
      stable_workflow_count: 0,
      candidate_workflow_count: 1,
      trusted_pattern_count: 0,
      contested_pattern_count: 1,
      rehydration_candidate_count: 1,
      adaptive_guidance_candidate_count: 0,
      persisted_policy_memory_id: null,
      selected_path_anchor_id: null,
      entries: [
        {
          source_kind: "rehydration_candidate",
          anchor_id: "wf_cold",
          selected_tool: null,
          workflow_signature: null,
          file_path: null,
          target_files: [],
          confidence: null,
          authority_blocked: true,
          authority_primary_blocker: "unverified_authority",
          reason: "payload rehydration may be needed",
        },
      ],
    },
    adaptive_guidance: emptyAdaptiveGuidance("unknown repair task"),
    experience_adaptation_trace: emptyExperienceAdaptationTrace("unknown repair task"),
    uncertainty: {
      summary_version: "action_retrieval_uncertainty_v1",
      level: "high",
      confidence: 0.24,
      evidence_gap_count: 4,
      reasons: ["no learned workflow matched this request yet"],
      recommended_actions: ["widen_recall", "rehydrate_payload", "inspect_context", "request_operator_review"],
    },
    rationale: {
      summary: "insufficient action memory",
    },
  });
  const parsed = ExperienceIntelligenceRequest.parse({
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: "unknown repair task",
    context: {},
    candidates: ["read_file"],
  });

  const contract = buildActionIntelligenceRuntimeContractV1({
    parsed,
    actionRetrieval,
    introspection: introspectionSlice({ authoritativeBlocked: 1 }),
    derivedPolicy: null,
    policyContract: null,
  });

  assert.equal(contract.pre_action_gate.known_enough, false);
  assert.equal(contract.pre_action_gate.requires_recall, true);
  assert.equal(contract.pre_action_gate.requires_rehydration, true);
  assert.equal(contract.pre_action_gate.requires_operator_review, true);
  assert.equal(contract.pre_action_gate.authority_blocked, true);
  assert.equal(contract.runtime_entropy_profile.entropy_level, "lockdown");
  assert.equal(contract.runtime_entropy_profile.control_strength, 1);
  assert.equal(contract.runtime_entropy_profile.promotion_threshold, "blocked");
  assert.equal(contract.runtime_entropy_profile.mutation_authority, "none");
  assert.equal(contract.runtime_entropy_controls.recall.breadth, "narrow");
  assert.equal(contract.runtime_entropy_controls.verifier.schedule, "blocked");
  assert.equal(contract.runtime_entropy_controls.promotion.minimum_observations, 32);
  assert.equal(contract.runtime_entropy_controls.promotion.stable_promotion_allowed, false);
  assert.equal(contract.loop.assess.status, "blocked");
  assert.equal(contract.loop.retrieve.status, "blocked");
  assert.equal(contract.loop.act.status, "blocked");
  assert.equal(contract.loop.distill.status, "pending");
  assert.equal(contract.lifecycle.distillation_ready, false);
  assert.equal(contract.lifecycle.recommended_maintenance_profile, "daily");
  assert.equal(contract.evidence_summary.authority_blocked_count, 3);
});

test("action intelligence carries promotion quality summary into mutation and maintenance posture", () => {
  const actionRetrieval = ActionRetrievalResponseSchema.parse({
    summary_version: "action_retrieval_v1",
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: "review promotion quality before new learning",
    history_applied: false,
    tool_source_kind: "tools_select",
    selected_tool: "inspect_memory",
    recommended_file_path: null,
    recommended_next_action: "Review promotion quality before promoting new memory.",
    execution_contract_v1: null,
    tool: {
      selected_tool: "inspect_memory",
      ordered_tools: ["inspect_memory"],
      preferred_tools: [],
      allowed_tools: ["inspect_memory"],
      trusted_pattern_anchor_ids: [],
      candidate_pattern_anchor_ids: [],
      suppressed_pattern_anchor_ids: [],
    },
    path: {
      source_kind: "none",
      anchor_id: null,
      workflow_signature: null,
      title: null,
      summary: null,
      file_path: null,
      target_files: [],
      next_action: "Review promotion quality before promoting new memory.",
      confidence: null,
      tool_set: ["inspect_memory"],
      authority_blocked: false,
      authority_primary_blocker: null,
      reason: "promotion quality summary requires learning-control review",
    },
    evidence: {
      stable_workflow_count: 0,
      candidate_workflow_count: 0,
      trusted_pattern_count: 0,
      contested_pattern_count: 0,
      rehydration_candidate_count: 0,
      adaptive_guidance_candidate_count: 0,
      persisted_policy_memory_id: null,
      selected_path_anchor_id: null,
      entries: [],
    },
    adaptive_guidance: emptyAdaptiveGuidance("review promotion quality before new learning"),
    experience_adaptation_trace: emptyExperienceAdaptationTrace("review promotion quality before new learning"),
    uncertainty: {
      summary_version: "action_retrieval_uncertainty_v1",
      level: "low",
      confidence: 0.78,
      evidence_gap_count: 0,
      reasons: ["promotion quality summary is available"],
      recommended_actions: ["proceed"],
    },
    rationale: {
      summary: "promotion quality review selected",
    },
  });
  const parsed = ExperienceIntelligenceRequest.parse({
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: "review promotion quality before new learning",
    context: {
      promotion_quality_summary_v1: invalidatingPromotionQualitySummary(),
    },
    candidates: ["inspect_memory"],
  });

  const contract = buildActionIntelligenceRuntimeContractV1({
    parsed,
    actionRetrieval,
    introspection: introspectionSlice(),
    derivedPolicy: null,
    policyContract: null,
  });

  assert.equal(contract.promotion_quality_summary?.summary_version, "promotion_quality_summary_v1");
  assert.equal(contract.promotion_quality_summary?.recommended_learning_posture, "invalidate");
  assert.equal(contract.lifecycle.mutation_candidate_available, true);
  assert.equal(contract.lifecycle.maintenance_ready, true);
  assert.equal(contract.lifecycle.recommended_maintenance_profile, "long_horizon");
  assert.equal(contract.loop.mutate.status, "ready");
  assert.equal(contract.loop.maintain.status, "ready");
  assert.equal(contract.source_code_change_allowed, false);
});

test("action intelligence carries runtime effect summary into maintenance posture without claiming proof", () => {
  const actionRetrieval = ActionRetrievalResponseSchema.parse({
    summary_version: "action_retrieval_v1",
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: "measure runtime effect after maintenance",
    history_applied: false,
    tool_source_kind: "tools_select",
    selected_tool: "inspect_memory",
    recommended_file_path: null,
    recommended_next_action: "Inspect runtime effect measurements before claiming improvement.",
    execution_contract_v1: null,
    tool: {
      selected_tool: "inspect_memory",
      ordered_tools: ["inspect_memory"],
      preferred_tools: [],
      allowed_tools: ["inspect_memory"],
      trusted_pattern_anchor_ids: [],
      candidate_pattern_anchor_ids: [],
      suppressed_pattern_anchor_ids: [],
    },
    path: {
      source_kind: "none",
      anchor_id: null,
      workflow_signature: null,
      title: null,
      summary: null,
      file_path: null,
      target_files: [],
      next_action: "Inspect runtime effect measurements before claiming improvement.",
      confidence: null,
      tool_set: ["inspect_memory"],
      authority_blocked: false,
      authority_primary_blocker: null,
      reason: "runtime effect summary requires measurement review",
    },
    evidence: {
      stable_workflow_count: 0,
      candidate_workflow_count: 0,
      trusted_pattern_count: 0,
      contested_pattern_count: 0,
      rehydration_candidate_count: 0,
      adaptive_guidance_candidate_count: 0,
      persisted_policy_memory_id: null,
      selected_path_anchor_id: null,
      entries: [],
    },
    adaptive_guidance: emptyAdaptiveGuidance("measure runtime effect after maintenance"),
    experience_adaptation_trace: emptyExperienceAdaptationTrace("measure runtime effect after maintenance"),
    uncertainty: {
      summary_version: "action_retrieval_uncertainty_v1",
      level: "low",
      confidence: 0.72,
      evidence_gap_count: 0,
      reasons: ["runtime effect summary is available"],
      recommended_actions: ["proceed"],
    },
    rationale: {
      summary: "runtime effect review selected",
    },
  });
  const parsed = ExperienceIntelligenceRequest.parse({
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: "measure runtime effect after maintenance",
    context: {
      runtime_effect_summary_v1: constrainedRuntimeEffectSummary(),
    },
    candidates: ["inspect_memory"],
  });

  const contract = buildActionIntelligenceRuntimeContractV1({
    parsed,
    actionRetrieval,
    introspection: introspectionSlice(),
    derivedPolicy: null,
    policyContract: null,
  });

  assert.equal(contract.runtime_effect_summary?.summary_version, "runtime_effect_summary_v1");
  assert.equal(contract.runtime_effect_summary?.baseline_comparison_required, true);
  assert.equal(contract.runtime_effect_summary?.measurable_effect_posture, "constrained");
  assert.equal(contract.lifecycle.maintenance_ready, true);
  assert.equal(contract.lifecycle.recommended_maintenance_profile, "long_horizon");
  assert.equal(contract.loop.maintain.status, "ready");
  assert.equal(contract.source_code_change_allowed, false);
});

test("action intelligence carries runtime signal trends into entropy and learning-control posture", () => {
  const executionContract = buildExecutionContractFromProjection({
    task_family: "runtime_contract_repair",
    workflow_signature: "inspect_patch_verify",
    selected_tool: "edit",
    target_files: ["src/runtime-contract.ts"],
    next_action: "Patch src/runtime-contract.ts and run the targeted verifier.",
    acceptance_checks: ["npm test -- runtime-contract"],
    provenance: {
      source_kind: "action_retrieval",
      source_summary_version: "action_retrieval_v1",
      source_anchor: "wf_runtime_contract",
      evidence_refs: ["verifier:runtime-contract"],
      notes: [],
    },
  });
  const actionRetrieval = ActionRetrievalResponseSchema.parse({
    summary_version: "action_retrieval_v1",
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: "repair the runtime contract",
    history_applied: true,
    tool_source_kind: "stable_workflow",
    selected_tool: "edit",
    recommended_file_path: "src/runtime-contract.ts",
    recommended_next_action: "Patch src/runtime-contract.ts and run the targeted verifier.",
    execution_contract_v1: executionContract,
    tool: {
      selected_tool: "edit",
      ordered_tools: ["edit", "test"],
      preferred_tools: ["edit"],
      allowed_tools: ["edit", "test"],
      trusted_pattern_anchor_ids: ["pattern_edit"],
      candidate_pattern_anchor_ids: [],
      suppressed_pattern_anchor_ids: [],
    },
    path: {
      source_kind: "recommended_workflow",
      anchor_id: "wf_runtime_contract",
      contract_trust: "advisory",
      task_family: "runtime_contract_repair",
      workflow_signature: "inspect_patch_verify",
      title: "Inspect, patch, verify",
      summary: "Stable workflow for contract repair.",
      file_path: "src/runtime-contract.ts",
      target_files: ["src/runtime-contract.ts"],
      next_action: "Patch src/runtime-contract.ts and run the targeted verifier.",
      confidence: 0.82,
      tool_set: ["edit", "test"],
      reason: "stable workflow matched the request",
    },
    evidence: {
      stable_workflow_count: 1,
      candidate_workflow_count: 0,
      trusted_pattern_count: 1,
      contested_pattern_count: 0,
      rehydration_candidate_count: 0,
      adaptive_guidance_candidate_count: 0,
      persisted_policy_memory_id: "policy_runtime_contract",
      selected_path_anchor_id: "wf_runtime_contract",
      entries: [],
    },
    adaptive_guidance: emptyAdaptiveGuidance("repair the runtime contract"),
    experience_adaptation_trace: emptyExperienceAdaptationTrace("repair the runtime contract"),
    uncertainty: {
      summary_version: "action_retrieval_uncertainty_v1",
      level: "low",
      confidence: 0.86,
      evidence_gap_count: 0,
      reasons: ["stable workflow and learned execution memory agree on the next step"],
      recommended_actions: ["proceed"],
    },
    rationale: {
      summary: "stable workflow selected",
    },
  });
  const parsed = ExperienceIntelligenceRequest.parse({
    tenant_id: "tenant-a",
    scope: "scope-a",
    run_id: "run-runtime-contract",
    query_text: "repair the runtime contract",
    context: {
      file_path: "src/runtime-contract.ts",
      runtime_signal_trend_summary_v1: constrainingTrendSummary(),
    },
    candidates: ["read_file", "edit", "test"],
    execution_result_summary: {
      ref: "verifier:runtime-contract",
      kind: "verifier",
      status: "passed",
    },
  });

  const contract = buildActionIntelligenceRuntimeContractV1({
    parsed,
    actionRetrieval,
    introspection: introspectionSlice({ distilledEvidence: 1, projectedWorkflow: 1 }),
    derivedPolicy: null,
    policyContract: null,
  });

  assert.equal(contract.runtime_signal_trend_summary?.recommended_runtime_posture, "constrain");
  assert.equal(contract.runtime_entropy_profile.runtime_signal_trend_posture, "constrain");
  assert.equal(contract.runtime_entropy_profile.promotion_threshold, "high");
  assert.equal(contract.runtime_entropy_profile.mutation_authority, "candidate_only");
  assert.equal(contract.runtime_entropy_controls.promotion.stable_promotion_allowed, false);
  assert.equal(contract.runtime_entropy_controls.promotion.mutation_authority, "candidate_only");
  assert.ok(contract.runtime_entropy_profile.reason_codes.includes("runtime_signal_trend_counter_evidence"));
});
