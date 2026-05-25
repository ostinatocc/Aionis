import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeEntropyProfileV1 } from "../../src/memory/runtime-entropy-profile.ts";
import {
  ActionIntelligenceRuntimeEvidenceSummarySchema,
  ActionIntelligenceRuntimeGateSchema,
  ActionIntelligenceRuntimeLifecycleSchema,
  ActionRetrievalResponseSchema,
  RuntimeSignalLedgerV1Schema,
  RuntimeSignalTrendSummaryV1Schema,
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

const baseActionRetrieval = ActionRetrievalResponseSchema.parse({
  summary_version: "action_retrieval_v1",
  tenant_id: "tenant-a",
  scope: "scope-a",
  query_text: "repair runtime behavior",
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
    reason: "no learned workflow matched",
  },
  evidence: {
    stable_workflow_count: 0,
    candidate_workflow_count: 1,
    trusted_pattern_count: 0,
    contested_pattern_count: 0,
    rehydration_candidate_count: 0,
    adaptive_guidance_candidate_count: 0,
    persisted_policy_memory_id: null,
    selected_path_anchor_id: null,
    entries: [],
  },
  uncertainty: {
    summary_version: "action_retrieval_uncertainty_v1",
    level: "high",
    confidence: 0.22,
    evidence_gap_count: 3,
    reasons: ["unknown task with no stable execution memory"],
    recommended_actions: ["widen_recall", "inspect_context"],
  },
  adaptive_guidance: emptyAdaptiveGuidance("repair runtime behavior"),
  experience_adaptation_trace: emptyExperienceAdaptationTrace("repair runtime behavior"),
  rationale: { summary: "unknown task" },
});

const baseGate = ActionIntelligenceRuntimeGateSchema.parse({
  gate_version: "action_intelligence_pre_action_gate_v1",
  known_enough: false,
  requires_recall: true,
  requires_rehydration: false,
  requires_operator_review: false,
  authority_blocked: false,
  uncertainty_level: "high",
  confidence: 0.22,
  recommended_actions: ["widen_recall", "inspect_context"],
  primary_reason: "unknown task with no stable execution memory",
});

const baseEvidence = ActionIntelligenceRuntimeEvidenceSummarySchema.parse({
  summary_version: "action_intelligence_evidence_summary_v1",
  stable_workflow_count: 0,
  candidate_workflow_count: 1,
  trusted_pattern_count: 0,
  contested_pattern_count: 0,
  rehydration_candidate_count: 0,
  adaptive_guidance_candidate_count: 0,
  persisted_policy_memory_id: null,
  execution_artifact_count: 0,
  execution_evidence_count: 0,
  verifier_evidence_count: 0,
  distilled_evidence_count: 0,
  distilled_fact_count: 0,
  projected_workflow_candidate_count: 0,
  authority_blocked_count: 0,
  evidence_refs: [],
});

const baseLifecycle = ActionIntelligenceRuntimeLifecycleSchema.parse({
  lifecycle_version: "action_intelligence_lifecycle_v1",
  history_applied: false,
  post_action_material_present: false,
  distillation_ready: false,
  workflow_candidate_available: true,
  policy_candidate_available: false,
  mutation_candidate_available: true,
  maintenance_ready: true,
  recommended_maintenance_profile: "daily",
});

const stableActionRetrieval = ActionRetrievalResponseSchema.parse({
  ...baseActionRetrieval,
  history_applied: true,
  tool_source_kind: "stable_workflow",
  selected_tool: "edit",
  recommended_file_path: "src/runtime.ts",
  recommended_next_action: "Patch src/runtime.ts and run verifier.",
  tool: {
    selected_tool: "edit",
    ordered_tools: ["edit", "test"],
    preferred_tools: ["edit"],
    allowed_tools: ["edit", "test"],
    trusted_pattern_anchor_ids: ["pattern:edit-test"],
    candidate_pattern_anchor_ids: [],
    suppressed_pattern_anchor_ids: [],
  },
  path: {
    source_kind: "recommended_workflow",
    anchor_id: "workflow:stable",
    contract_trust: "advisory",
    task_family: "runtime_repair",
    workflow_signature: "inspect_patch_verify",
    title: "Inspect patch verify",
    summary: "Stable workflow for runtime repair.",
    file_path: "src/runtime.ts",
    target_files: ["src/runtime.ts"],
    next_action: "Patch src/runtime.ts and run verifier.",
    confidence: 0.86,
    tool_set: ["edit", "test"],
    reason: "stable workflow matched",
  },
  evidence: {
    stable_workflow_count: 1,
    candidate_workflow_count: 0,
    trusted_pattern_count: 1,
    contested_pattern_count: 0,
    rehydration_candidate_count: 0,
    adaptive_guidance_candidate_count: 0,
    persisted_policy_memory_id: "policy:runtime",
    selected_path_anchor_id: "workflow:stable",
    entries: [
      {
        source_kind: "stable_workflow",
        anchor_id: "workflow:stable",
        selected_tool: "edit",
        task_family: "runtime_repair",
        workflow_signature: "inspect_patch_verify",
        file_path: "src/runtime.ts",
        target_files: ["src/runtime.ts"],
        confidence: 0.86,
        reason: "stable workflow evidence",
      },
    ],
  },
  uncertainty: {
    summary_version: "action_retrieval_uncertainty_v1",
    level: "low",
    confidence: 0.88,
    evidence_gap_count: 0,
    reasons: ["stable workflow and trusted pattern matched"],
    recommended_actions: ["proceed"],
  },
  rationale: { summary: "stable workflow selected" },
});

const stableGate = ActionIntelligenceRuntimeGateSchema.parse({
  ...baseGate,
  known_enough: true,
  requires_recall: false,
  uncertainty_level: "low",
  confidence: 0.88,
  recommended_actions: ["proceed"],
  primary_reason: "stable workflow and trusted pattern matched",
});

const stableEvidence = ActionIntelligenceRuntimeEvidenceSummarySchema.parse({
  ...baseEvidence,
  stable_workflow_count: 1,
  candidate_workflow_count: 0,
  trusted_pattern_count: 1,
  evidence_refs: ["workflow:stable", "verifier:passed"],
});

const stableLifecycle = ActionIntelligenceRuntimeLifecycleSchema.parse({
  ...baseLifecycle,
  history_applied: true,
  post_action_material_present: true,
  distillation_ready: true,
  workflow_candidate_available: false,
  mutation_candidate_available: true,
  maintenance_ready: true,
  recommended_maintenance_profile: "immediate",
});

function positiveVerifierLedger() {
  return RuntimeSignalLedgerV1Schema.parse({
    ledger_version: "runtime_signal_ledger_v1",
    signal_count: 1,
    positive_signal_count: 1,
    negative_signal_count: 0,
    quarantine_signal_count: 0,
    source_code_change_allowed: false,
    entries: [
      {
        signal_id: "sig-verifier-positive",
        signal_kind: "verifier_result",
        polarity: "positive",
        numeric_value: 1,
        text_value: "verification passed",
        evidence_refs: ["verifier:passed"],
        source_refs: ["execution_evidence_v1"],
        affected_capabilities: ["learning", "learning_control"],
        authority_effect: "promotion_evidence_candidate",
      },
    ],
  });
}

function constrainingTrendSummary() {
  return RuntimeSignalTrendSummaryV1Schema.parse({
    summary_version: "runtime_signal_trend_summary_v1",
    scanned_node_count: 5,
    included_ledger_count: 3,
    entry_count: 4,
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
    source_node_ids: ["node:failed-action-1", "node:failed-action-2"],
    source_code_change_allowed: false,
  });
}

test("runtime entropy profile raises exploration without granting mutation authority for unknown tasks", () => {
  const profile = buildRuntimeEntropyProfileV1({
    actionRetrieval: baseActionRetrieval,
    preActionGate: baseGate,
    evidenceSummary: baseEvidence,
    lifecycle: baseLifecycle,
    runtimeSignalLedger: RuntimeSignalLedgerV1Schema.parse({
      ledger_version: "runtime_signal_ledger_v1",
      signal_count: 1,
      positive_signal_count: 0,
      negative_signal_count: 1,
      quarantine_signal_count: 0,
      source_code_change_allowed: false,
      entries: [
        {
          signal_id: "sig-repeated-discovery",
          signal_kind: "repeated_discovery",
          polarity: "negative",
          numeric_value: 2,
          text_value: "repeated discovery observed",
          evidence_refs: ["run:1", "run:2"],
          source_refs: ["runtime_repeated_discovery"],
          affected_capabilities: ["continuity", "learning"],
          authority_effect: "promotion_evidence_candidate",
        },
      ],
    }),
  });

  assert.equal(profile.profile_version, "runtime_entropy_profile_v1");
  assert.equal(profile.entropy_level, "high");
  assert.equal(profile.plasticity_level, "high");
  assert.equal(profile.recall_breadth, "wide");
  assert.equal(profile.verification_depth, "strict");
  assert.equal(profile.promotion_threshold, "high");
  assert.equal(profile.mutation_authority, "candidate_only");
  assert.equal(profile.source_code_change_allowed, false);
  assert.ok(profile.reason_codes.includes("runtime_signal_repeated_discovery"));
});

test("runtime entropy profile enters lockdown for provider quarantine", () => {
  const profile = buildRuntimeEntropyProfileV1({
    actionRetrieval: baseActionRetrieval,
    preActionGate: baseGate,
    evidenceSummary: baseEvidence,
    lifecycle: baseLifecycle,
    runtimeSignalLedger: RuntimeSignalLedgerV1Schema.parse({
      ledger_version: "runtime_signal_ledger_v1",
      signal_count: 1,
      positive_signal_count: 0,
      negative_signal_count: 1,
      quarantine_signal_count: 1,
      source_code_change_allowed: false,
      entries: [
        {
          signal_id: "sig-provider-protocol",
          signal_kind: "provider_protocol_failure",
          polarity: "negative",
          numeric_value: 1,
          text_value: "provider protocol failure observed",
          evidence_refs: ["provider:run"],
          source_refs: ["provider_protocol_failure"],
          affected_capabilities: ["learning_control"],
          authority_effect: "quarantine",
        },
      ],
    }),
  });

  assert.equal(profile.entropy_level, "lockdown");
  assert.equal(profile.control_strength, 1);
  assert.equal(profile.promotion_threshold, "blocked");
  assert.equal(profile.mutation_authority, "none");
  assert.ok(profile.reason_codes.includes("runtime_signal_quarantine"));
});

test("runtime entropy trend constrains learning-control without granting stable promotion", () => {
  const profile = buildRuntimeEntropyProfileV1({
    actionRetrieval: stableActionRetrieval,
    preActionGate: stableGate,
    evidenceSummary: stableEvidence,
    lifecycle: stableLifecycle,
    runtimeSignalLedger: positiveVerifierLedger(),
    runtimeSignalTrendSummary: constrainingTrendSummary(),
  });

  assert.equal(profile.runtime_signal_trend_posture, "constrain");
  assert.equal(profile.promotion_threshold, "high");
  assert.equal(profile.mutation_authority, "candidate_only");
  assert.equal(profile.source_code_change_allowed, false);
  assert.ok(profile.source_signals.includes("repeated_failed_action"));
  assert.ok(profile.reason_codes.includes("runtime_signal_trend_constrain"));
  assert.ok(profile.reason_codes.includes("runtime_signal_trend_counter_evidence"));
});
