import test from "node:test";
import assert from "node:assert/strict";
import { buildActionRetrievalResponse } from "../../src/memory/action-retrieval.ts";
import { buildAdaptiveGuidanceDecomposition } from "../../src/memory/adaptive-guidance.ts";
import { buildRuntimeSignalLedgerFromSlots } from "../../src/memory/runtime-signal-ledger.ts";
import { buildRuntimeSignalTrendSummaryFromRows } from "../../src/memory/runtime-signal-trends.ts";
import { AdaptiveGuidanceDecompositionV1Schema, ExperienceIntelligenceRequest } from "../../src/memory/schemas.ts";

function executionContract(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "execution_contract_v1",
    contract_trust: "advisory",
    task_family: "task:adaptive_guidance",
    task_signature: "task:adaptive_guidance:runtime",
    workflow_signature: "workflow:adaptive_guidance:runtime",
    policy_memory_id: null,
    selected_tool: "edit",
    file_path: "src/memory/action-retrieval.ts",
    target_files: ["src/memory/action-retrieval.ts"],
    next_action: "Integrate the guidance compiler into action retrieval.",
    workflow_steps: [
      "Build the native guidance overlay from recalled execution memory.",
      "Expose selected guidance as observational evidence.",
    ],
    pattern_hints: ["do_not_promote_guidance_without_runtime_signal_attribution"],
    service_lifecycle_constraints: [],
    outcome: {
      acceptance_checks: ["npx tsc --noEmit"],
      success_invariants: ["guidance_remains_observational"],
      dependency_requirements: [],
      environment_assumptions: [],
      must_hold_after_exit: [],
      external_visibility_requirements: [],
    },
    provenance: {
      source_kind: "workflow_projection",
      source_summary_version: "execution_memory_introspection_v1",
      source_anchor: "candidate-guidance-1",
      evidence_refs: ["evidence://run/adaptive-guidance"],
      notes: [],
    },
    ...overrides,
  };
}

function tools(selected = "edit") {
  return {
    tenant_id: "tenant-a",
    scope: "scope-a",
    selection: {
      selected,
      ordered: [selected],
      preferred: [selected],
      allowed: [selected],
    },
    selection_summary: {
      provenance_explanation: `tools_select=${selected}`,
    },
    decision: {
      pattern_summary: {
        used_trusted_pattern_anchor_ids: [],
        skipped_contested_pattern_anchor_ids: [],
        skipped_suppressed_pattern_anchor_ids: [],
      },
    },
  } as any;
}

function introspection(overrides: Record<string, unknown> = {}) {
  return {
    recommended_workflows: [],
    candidate_workflows: [],
    trusted_patterns: [],
    contested_patterns: [],
    rehydration_candidates: [],
    supporting_knowledge: [],
    pattern_signal_summary: {
      trusted_pattern_count: 0,
    },
    workflow_signal_summary: {
      stable_workflow_count: 0,
    },
    authority_visibility_summary: {
      authoritative_blocked_count: 0,
      stable_promotion_blocked_count: 0,
    },
    distillation_signal_summary: {
      distilled_evidence_count: 0,
      distilled_fact_count: 0,
      projected_workflow_candidate_count: 0,
    },
    ...overrides,
  } as any;
}

test("adaptive guidance decomposition normalizes generated fields to its schema contract", () => {
  const longToken = "x".repeat(260);
  const longTool = `tool-${"y".repeat(260)}`;
  const longFile = `src/${"z".repeat(700)}.ts`;
  const longCheck = `verify ${"q".repeat(260)}`;
  const parsed = ExperienceIntelligenceRequest.parse({
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: `Fix ${longToken} and preserve verification behavior`,
    context: {
      task_family: "task:adaptive_guidance",
      file_path: longFile,
      acceptance_checks: [longCheck],
    },
    candidates: [longTool],
  });

  const decomposition = buildAdaptiveGuidanceDecomposition({ parsed });
  AdaptiveGuidanceDecompositionV1Schema.parse(decomposition);

  assert.ok(decomposition.query_terms.every((term) => term.length <= 128));
  assert.ok(decomposition.tool_hints.every((term) => term.length <= 128));
  assert.ok(decomposition.file_hints.every((term) => term.length <= 512));
  assert.ok(decomposition.subtasks.every((subtask) => subtask.query_text.length <= 2048));
  assert.ok(decomposition.subtasks.every((subtask) => subtask.match_terms.every((term) => term.length <= 128)));
});

function selectedAdaptiveGuidance(candidateId: string) {
  return {
    summary_version: "adaptive_guidance_overlay_v1",
    activation_state: "active",
    query_text: "Use selected runtime guidance",
    decomposition: {
      summary_version: "adaptive_guidance_decomposition_v1",
      query_text: "Use selected runtime guidance",
      task_family: "task:adaptive_guidance",
      query_terms: ["runtime", "guidance"],
      file_hints: ["src/memory/runtime-signal-ledger.ts"],
      tool_hints: ["edit"],
      subtasks: [{
        subtask_id: "adaptive-guidance-test-subtask",
        role: "task_intent",
        query_text: "Use selected runtime guidance",
        match_terms: ["runtime", "guidance"],
      }],
    },
    candidate_count: 1,
    selected_candidate_count: 1,
    skipped_candidate_count: 0,
    skipped_reasons: [],
    selected_candidates: [{
      summary_version: "adaptive_guidance_candidate_v1",
      candidate_id: candidateId,
      source_kind: "candidate_workflow",
      source_anchor_id: "anchor-guidance-1",
      authority: "advisory_candidate",
      contract_trust: "observational",
      selected_tool: "edit",
      task_family: "task:adaptive_guidance",
      workflow_signature: "workflow:adaptive_guidance:runtime",
      title: "Runtime guidance candidate",
      summary: "Candidate guidance selected for this action.",
      file_path: "src/memory/runtime-signal-ledger.ts",
      target_files: ["src/memory/runtime-signal-ledger.ts"],
      next_action: "Bind the observed outcome to the selected candidate.",
      workflow_steps: ["Record the selected candidate before promoting evidence."],
      pattern_hints: ["require_candidate_bound_outcome"],
      service_lifecycle_constraints: [],
      evidence_refs: ["evidence://adaptive-guidance/candidate"],
      source_refs: ["anchor-guidance-1"],
      confidence: 0.72,
      score: 0.7,
      match_reasons: ["task_family_aligned=task:adaptive_guidance"],
      promotion_blockers: [
        "requires_runtime_signal_attribution",
        "requires_learning_control_gate",
        "requires_repeated_outcome_evidence",
      ],
      source_code_change_allowed: false,
    }],
    adapted_instructions: [{
      instruction_id: "adaptive-guidance-test-instruction",
      priority: "primary",
      instruction: "Bind the observed outcome to the selected candidate.",
      selected_tool: "edit",
      file_path: "src/memory/runtime-signal-ledger.ts",
      task_family: "task:adaptive_guidance",
      source_candidate_ids: [candidateId],
      source_anchor_ids: ["anchor-guidance-1"],
      evidence_refs: ["evidence://adaptive-guidance/candidate"],
      contract_trust: "observational",
    }],
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
      candidate_ids: [candidateId],
      expected_signal_kind: "adaptive_guidance_outcome",
      feedback_slots: [
        "adaptive_guidance_outcome_v1",
        "execution_result_summary.adaptive_guidance_outcome_v1",
        "execution_evidence[].adaptive_guidance_outcome_v1",
      ],
      positive_authority_effect: "promotion_evidence_candidate",
      negative_authority_effect: "counter_evidence",
    },
    uncertainty_adjustment: {
      summary_version: "adaptive_guidance_uncertainty_adjustment_v1",
      confidence_delta: 0.04,
      recommended_actions: ["inspect_context"],
      reason: "adaptive_guidance_selected=1",
    },
    source_code_change_allowed: false,
  };
}

test("action retrieval surfaces native adaptive guidance as observational evidence", () => {
  const parsed = ExperienceIntelligenceRequest.parse({
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: "Add adaptive guidance to action retrieval in src/memory/action-retrieval.ts",
    context: {
      task_family: "task:adaptive_guidance",
      file_path: "src/memory/action-retrieval.ts",
    },
    candidates: ["edit"],
  });
  const response = buildActionRetrievalResponse({
    parsed,
    tools: tools("edit"),
    introspection: introspection({
      candidate_workflows: [{
        anchor_id: "candidate-guidance-1",
        promotion_state: "candidate",
        contract_trust: "advisory",
        task_family: "task:adaptive_guidance",
        workflow_signature: "workflow:adaptive_guidance:runtime",
        title: "Guidance compiler integration",
        summary: "Prior run identified action retrieval as the correct integration point.",
        tool_set: ["edit"],
        file_path: "src/memory/action-retrieval.ts",
        target_files: ["src/memory/action-retrieval.ts"],
        confidence: 0.74,
        execution_contract_v1: executionContract(),
      }],
    }),
    delegationRecommendationCount: 2,
  });

  assert.equal(response.tool_source_kind, "adaptive_guidance");
  assert.equal(response.adaptive_guidance?.activation_state, "active");
  assert.equal(response.adaptive_guidance?.selected_candidate_count, 1);
  assert.equal(response.evidence.adaptive_guidance_candidate_count, 1);
  assert.ok(response.evidence.entries.some((entry) => entry.source_kind === "adaptive_guidance_candidate"));
  const selected = response.adaptive_guidance?.selected_candidates[0];
  assert.equal(selected?.authority, "advisory_candidate");
  assert.equal(selected?.contract_trust, "observational");
  assert.equal(selected?.source_code_change_allowed, false);
  assert.equal(response.adaptive_guidance?.authority_visibility.may_promote_directly, false);
  assert.equal(
    response.adaptive_guidance?.authority_visibility.required_promotion_path,
    "runtime_signal_attribution_and_learning_control_gate",
  );
  assert.equal(response.experience_adaptation_trace.summary_version, "execution_experience_adaptation_trace_v1");
  assert.equal(response.experience_adaptation_trace.activation_state, "active");
  assert.equal(response.experience_adaptation_trace.task_decomposition.summary_version, "adaptive_guidance_decomposition_v1");
  assert.equal(response.experience_adaptation_trace.retrieval.tool_source_kind, "adaptive_guidance");
  assert.equal(response.experience_adaptation_trace.experience_sources.delegation_recommendation_count, 2);
  assert.equal(response.experience_adaptation_trace.adaptation.promotion_requires_candidate_binding, true);
});

test("adaptive guidance does not override stable workflow authority", () => {
  const parsed = ExperienceIntelligenceRequest.parse({
    tenant_id: "tenant-a",
    scope: "scope-a",
    query_text: "Continue the stable runtime retrieval workflow",
    context: {
      task_family: "task:adaptive_guidance",
      file_path: "src/memory/action-retrieval.ts",
    },
    candidates: ["edit"],
  });
  const stableContract = executionContract({
    contract_trust: "authoritative",
    next_action: "Use the stable workflow step.",
    provenance: {
      source_kind: "workflow_projection",
      source_summary_version: "execution_memory_introspection_v1",
      source_anchor: "stable-guidance-1",
      evidence_refs: ["evidence://run/stable-guidance"],
      notes: [],
    },
  });
  const response = buildActionRetrievalResponse({
    parsed,
    tools: tools("edit"),
    introspection: introspection({
      recommended_workflows: [{
        anchor_id: "stable-guidance-1",
        promotion_state: "stable",
        anchor_level: "L2",
        contract_trust: "authoritative",
        task_family: "task:adaptive_guidance",
        workflow_signature: "workflow:adaptive_guidance:runtime",
        title: "Stable guidance integration",
        summary: "Stable workflow controls the retrieval integration.",
        tool_set: ["edit"],
        file_path: "src/memory/action-retrieval.ts",
        target_files: ["src/memory/action-retrieval.ts"],
        confidence: 0.9,
        execution_contract_v1: stableContract,
      }],
      candidate_workflows: [{
        anchor_id: "candidate-guidance-2",
        promotion_state: "candidate",
        contract_trust: "advisory",
        task_family: "task:adaptive_guidance",
        workflow_signature: "workflow:adaptive_guidance:candidate",
        title: "Candidate guidance integration",
        summary: "Candidate guidance should remain advisory.",
        tool_set: ["edit"],
        file_path: "src/memory/action-retrieval.ts",
        target_files: ["src/memory/action-retrieval.ts"],
        confidence: 0.95,
        execution_contract_v1: executionContract({
          workflow_signature: "workflow:adaptive_guidance:candidate",
          next_action: "Use the candidate guidance step.",
          provenance: {
            source_kind: "workflow_projection",
            source_summary_version: "execution_memory_introspection_v1",
            source_anchor: "candidate-guidance-2",
            evidence_refs: ["evidence://run/candidate-guidance"],
            notes: [],
          },
        }),
      }],
      workflow_signal_summary: {
        stable_workflow_count: 1,
      },
    }),
  });

  assert.equal(response.path.source_kind, "recommended_workflow");
  assert.equal(response.path.anchor_id, "stable-guidance-1");
  assert.equal(response.tool_source_kind, "stable_workflow");
  assert.equal(response.recommended_next_action, "Use the stable workflow step.");
  assert.ok((response.adaptive_guidance?.selected_candidate_count ?? 0) >= 1);
  assert.equal(response.adaptive_guidance?.authority_visibility.may_override_policy, false);
});

test("candidate-bound adaptive guidance outcome becomes promotion evidence candidate", () => {
  const candidateId = "adaptive-guidance-candidate:test-bound";
  const ledger = buildRuntimeSignalLedgerFromSlots({
    slots: {
      adaptive_guidance: selectedAdaptiveGuidance(candidateId),
      adaptive_guidance_outcome_v1: {
        success: true,
        id: "guidance-outcome-1",
        candidate_ids: [candidateId],
      },
    },
  });
  assert.ok(ledger);
  const signal = ledger.entries.find((entry) => entry.signal_kind === "adaptive_guidance_outcome");
  assert.equal(signal?.polarity, "positive");
  assert.equal(signal?.authority_effect, "promotion_evidence_candidate");
  assert.deepEqual(signal?.affected_capabilities, ["continuity", "learning"]);
  assert.ok(signal?.source_refs.includes(candidateId));
});

test("unbound positive adaptive guidance outcome does not promote learning evidence", () => {
  const ledger = buildRuntimeSignalLedgerFromSlots({
    slots: {
      adaptive_guidance_outcome_v1: {
        success: true,
        id: "guidance-outcome-unbound",
      },
    },
  });
  assert.ok(ledger);
  const signal = ledger.entries.find((entry) => entry.signal_kind === "adaptive_guidance_outcome");
  assert.equal(signal?.polarity, "positive");
  assert.equal(signal?.authority_effect, "none");
  assert.equal(signal?.text_value, "adaptive guidance outcome observed without selected candidate attribution");
  assert.deepEqual(signal?.affected_capabilities, ["continuity", "learning_control"]);
});

test("execution evidence adaptive guidance outcome is attributed through selected candidate ids", () => {
  const candidateId = "adaptive-guidance-candidate:test-execution-evidence";
  const ledger = buildRuntimeSignalLedgerFromSlots({
    slots: {
      adaptive_guidance: selectedAdaptiveGuidance(candidateId),
      execution_evidence: [{
        id: "execution-evidence-guidance-1",
        adaptive_guidance_outcome_v1: {
          success: true,
          id: "guidance-outcome-execution-evidence",
          selected_candidate_ids: [candidateId],
        },
      }],
    },
  });
  assert.ok(ledger);
  const signal = ledger.entries.find((entry) => entry.signal_kind === "adaptive_guidance_outcome");
  assert.equal(signal?.polarity, "positive");
  assert.equal(signal?.authority_effect, "promotion_evidence_candidate");
  assert.ok(signal?.source_refs.includes("execution_evidence[].adaptive_guidance_outcome_v1"));
  assert.ok(signal?.source_refs.includes(candidateId));
});

test("runtime signal trends include adaptive guidance outcomes", () => {
  const candidateId = "adaptive-guidance-candidate:test-trend";
  const ledger = buildRuntimeSignalLedgerFromSlots({
    slots: {
      adaptive_guidance: selectedAdaptiveGuidance(candidateId),
      adaptive_guidance_outcome_v1: {
        success: true,
        id: "guidance-outcome-trend",
        candidate_ids: [candidateId],
      },
    },
  });
  assert.ok(ledger);
  const summary = buildRuntimeSignalTrendSummaryFromRows({
    rows: [{
      id: "node:adaptive-guidance-trend",
      slots: {
        runtime_signal_ledger_v1: ledger,
      },
    }] as any,
  });
  const adaptiveGuidanceCount = summary.signal_counts.find((count) => count.signal_kind === "adaptive_guidance_outcome");
  assert.equal(adaptiveGuidanceCount?.positive, 1);
  assert.equal(summary.numeric_trends.find((trend) => trend.signal_kind === "adaptive_guidance_outcome")?.average, 1);
  assert.ok(summary.dominant_positive_signals.includes("adaptive_guidance_outcome"));
});
