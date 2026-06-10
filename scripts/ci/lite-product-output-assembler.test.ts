import test from "node:test";
import assert from "node:assert/strict";
import type { PlanningSummary } from "../../src/app/planning-summary.ts";
import { evaluateAionisEffect } from "../../src/kernel/effect-evaluator.ts";
import {
  applyAionisInspectBeforeUseActiveProjection,
  buildAionisAgentContext,
  buildAionisEffectReport,
  buildAionisGuidePacket,
  buildAionisLearningPacket,
  buildAionisMemoryDecisionAuditReport,
  buildAionisMemoryDecisionTrace,
  buildAionisMemoryPacket,
} from "../../src/memory/product-output-assembler.ts";

function planningSummaryFixture(): PlanningSummary {
  return {
    summary_version: "planning_summary_v1",
    planner_explanation: "History points to a resumable verifier-backed path.",
    continuity_guidance: {
      source_kind: "experience_intelligence",
      history_applied: true,
      contract_trust: "advisory",
      execution_contract_v1: null,
      continuity_signal_v1: {
        summary_version: "runtime_continuity_signal_v1",
        action: "read_file",
        priority: "recommended",
        contract_trust: "advisory",
        tool_name: "shell",
        learned_tool: "shell",
        file_path: "src/runtime.ts",
        target_files: ["src/runtime.ts"],
        reason: "Recovered handoff points to this file.",
        instruction: "Inspect src/runtime.ts before editing.",
      },
      edit_boundary_v1: {
        summary_version: "runtime_edit_boundary_v1",
        contract_trust: "advisory",
        allowed_edit_files: ["src/runtime.ts"],
        forbidden_edit_files: ["src/other.ts"],
        required_verifiers: ["npm test"],
        anti_shortcut_rules: ["do not persist learning from failed verifier evidence"],
        reason: "Keep the continuation local to recovered evidence.",
      },
      verification_repair_v1: null,
      selected_tool: "shell",
      task_family: "coding",
      workflow_signature: "runtime-continuation",
      policy_memory_id: "policy-1",
      file_path: "src/runtime.ts",
      next_action: "Inspect recovered file.",
    },
    action_intelligence_pre_action_gate: {
      gate_version: "action_intelligence_pre_action_gate_v1",
      known_enough: true,
      requires_recall: false,
      requires_rehydration: true,
      requires_operator_review: false,
      authority_blocked: false,
      uncertainty_level: "moderate",
      confidence: 0.72,
      recommended_actions: ["rehydrate_payload"],
      primary_reason: "Payload may be needed before mutation.",
    },
    runtime_entropy_profile: null,
    runtime_entropy_controls: null,
    action_retrieval_uncertainty: {
      summary_version: "action_retrieval_uncertainty_v1",
      level: "moderate",
      confidence: 0.69,
      evidence_gap_count: 1,
      reasons: ["candidate memory needs payload check"],
      recommended_actions: ["rehydrate_payload"],
    },
    action_retrieval_gate: {
      summary_version: "action_retrieval_gate_v1",
      gate_action: "rehydrate_payload",
      escalates_task_start: false,
      confidence: 0.7,
      primary_reason: "Need a compact payload before action.",
      recommended_actions: ["rehydrate_payload"],
      instruction: "Rehydrate only the relevant payload.",
      rehydration_candidate_count: 1,
      preferred_rehydration: null,
    },
    history_impact_summary: {
      summary_version: "history_impact_summary_v1",
      history_applied: true,
      changed_next_run: true,
      impact_level: "action_shaping",
      affected_capabilities: ["continuity", "learning", "forgetting", "learning_control"],
      continuity: {
        continuity_carrier_count: 1,
        static_blocks_selected: 2,
        selected_memory_layer_count: 2,
      },
      learning: {
        stable_workflow_count: 1,
        candidate_workflow_count: 1,
        promotion_ready_workflow_count: 1,
        trusted_pattern_count: 1,
        contested_pattern_count: 1,
        active_policy_count: 1,
        contested_policy_count: 0,
      },
      forgetting: {
        substrate_mode: "suppression_present",
        forgotten_items: 1,
        suppressed_pattern_count: 1,
        differential_rehydration_candidate_count: 1,
        stale_signal_count: 1,
      },
      learning_control: {
        contract_trust: "advisory",
        action_start_blocked: false,
        authoritative_allowed_count: 1,
        authoritative_blocked_count: 1,
        stable_promotion_allowed_count: 0,
        stable_promotion_blocked_count: 1,
        primary_blockers: ["promotion lacks holdout evidence"],
      },
      runtime_entropy: {
        profile_present: false,
        controls_present: false,
        entropy_level: null,
        plasticity_level: null,
        exploration_budget: null,
        control_strength: null,
      },
      next_run_changes: ["continuity_state_available", "continuity_signal_shaped_by_history"],
      primary_reason: "History shaped the next action.",
    },
    selected_tool: "shell",
    decision_id: "decision-1",
    rules_considered: 0,
    rules_matched: 0,
    context_est_tokens: 1200,
    layered_output: false,
    forgotten_items: 1,
    static_blocks_selected: 2,
    selected_memory_layers: ["continuity", "workflow"],
    optimization_profile: "balanced",
    context_compaction_profile: "balanced",
    recall_mode: "execution_memory",
    trusted_pattern_count: 1,
    contested_pattern_count: 1,
    trusted_pattern_tools: ["shell"],
    contested_pattern_tools: ["search"],
    workflow_signal_summary: {
      stable_workflow_count: 1,
      promotion_ready_workflow_count: 1,
      observing_workflow_count: 0,
      stable_workflow_titles: ["resume verifier-backed file inspection"],
      promotion_ready_workflow_titles: ["candidate local repair"],
      observing_workflow_titles: [],
    },
    action_packet_summary: {
      recommended_workflow_count: 1,
      candidate_workflow_count: 1,
      candidate_pattern_count: 0,
      trusted_pattern_count: 1,
      contested_pattern_count: 1,
      rehydration_candidate_count: 1,
      supporting_knowledge_count: 0,
      workflow_anchor_ids: ["wf-stable-1"],
      candidate_workflow_anchor_ids: ["wf-candidate-1"],
      candidate_pattern_anchor_ids: [],
      trusted_pattern_anchor_ids: ["pat-trusted-1"],
      contested_pattern_anchor_ids: ["pat-contested-1"],
      rehydration_anchor_ids: ["mem-rehydrate-1"],
    },
    workflow_lifecycle_summary: {
      candidate_count: 1,
      stable_count: 1,
      replay_source_count: 1,
      rehydration_ready_count: 1,
      promotion_ready_count: 1,
      transition_counts: {
        candidate_observed: 1,
        promoted_to_stable: 1,
        normalized_latest_stable: 0,
      },
    },
    workflow_maintenance_summary: {
      model: "lazy_online_v1",
      observe_count: 1,
      retain_count: 1,
      promote_candidate_count: 1,
      retain_workflow_count: 1,
    },
    authority_visibility_summary: {
      summary_version: "runtime_authority_visibility_summary_v1",
      surface_count: 2,
      sufficient_count: 1,
      insufficient_count: 1,
      authoritative_allowed_count: 1,
      authoritative_blocked_count: 1,
      stable_promotion_allowed_count: 0,
      stable_promotion_blocked_count: 1,
      execution_evidence_failed_count: 0,
      execution_evidence_incomplete_count: 1,
      false_confidence_count: 0,
      reason_counts: { holdout_required: 1 },
      top_blockers: ["promotion lacks holdout evidence"],
    },
    distillation_signal_summary: {
      distilled_evidence_count: 1,
      distilled_fact_count: 1,
      projected_workflow_candidate_count: 1,
      origin_counts: {
        write_distillation_input_text: 0,
        write_distillation_event_node: 0,
        write_distillation_evidence_node: 1,
        execution_write_projection: 0,
        handoff_continuity_carrier: 1,
        session_event_continuity_carrier: 0,
        session_continuity_carrier: 0,
        replay_learning_episode: 1,
      },
      promotion_target_counts: {
        workflow: 1,
        pattern: 0,
        policy: 0,
      },
    },
    pattern_lifecycle_summary: {
      candidate_count: 0,
      trusted_count: 1,
      contested_count: 1,
      near_promotion_count: 0,
      counter_evidence_open_count: 1,
      transition_counts: {
        candidate_observed: 0,
        promoted_to_trusted: 1,
        counter_evidence_opened: 1,
        revalidated_to_trusted: 0,
      },
    },
    pattern_maintenance_summary: {
      model: "lazy_online_v1",
      observe_count: 0,
      retain_count: 1,
      review_count: 1,
      promote_candidate_count: 0,
      review_counter_evidence_count: 1,
      retain_trusted_count: 1,
    },
    policy_lifecycle_summary: {
      persisted_count: 1,
      active_count: 1,
      contested_count: 0,
      retired_count: 0,
      default_mode_count: 0,
      hint_mode_count: 1,
      stable_policy_count: 0,
      transition_counts: {
        materialized: 1,
        refreshed: 0,
        contested_by_feedback: 0,
        retired_by_feedback: 0,
        retired_by_learning_control: 0,
        reactivated_by_learning_control: 0,
      },
    },
    policy_maintenance_summary: {
      model: "lazy_online_v1",
      observe_count: 1,
      retain_count: 1,
      review_count: 0,
      promote_to_default_count: 0,
      retain_active_policy_count: 1,
      review_contested_policy_count: 0,
      retire_policy_count: 0,
      reactivate_policy_count: 0,
    },
    continuity_carrier_summary: {
      total_count: 1,
      handoff_count: 1,
      session_event_count: 0,
      session_count: 0,
    },
    forgetting_summary: {
      summary_version: "execution_forgetting_summary_v1",
      substrate_mode: "suppression_present",
      forgotten_items: 1,
      forgotten_by_reason: { stale: 1 },
      primary_forgetting_reason: "stale memory suppressed",
      suppressed_pattern_count: 1,
      suppressed_pattern_anchor_ids: ["mem-suppressed-1"],
      suppressed_pattern_sources: ["pattern"],
      selected_memory_layers: ["continuity", "workflow"],
      semantic_action_counts: {
        retain: 2,
        demote: 0,
        archive: 0,
        review: 1,
      },
      lifecycle_state_counts: {
        active: 2,
        contested: 1,
        retired: 0,
        archived: 0,
      },
      archive_relocation_state_counts: {
        none: 3,
        candidate: 0,
        cold_archive: 0,
      },
      archive_relocation_target_counts: {
        none: 3,
        local_cold_store: 0,
        external_object_store: 0,
      },
      archive_payload_scope_counts: {
        none: 3,
        anchor_payload: 0,
        node: 0,
      },
      rehydration_mode_counts: {
        summary_only: 0,
        partial: 0,
        full: 0,
        differential: 1,
      },
      differential_rehydration_candidate_count: 1,
      primary_savings_levers: ["suppression"],
      stale_signal_count: 1,
      recommended_action: "rehydrate only if needed",
    },
    primary_savings_levers: ["suppression"],
  };
}

test("product guide assembler converts planning summary into stable GuidePacket", () => {
  const packet = buildAionisGuidePacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-1",
      run_id: "run-1",
      task_signature: "runtime-continuation",
      task_family: "coding",
    },
    planning: planningSummaryFixture(),
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
      internal_surfaces_used: ["planning_summary"],
    },
  });

  assert.equal(packet.contract_version, "aionis_guide_packet_v1");
  assert.equal(packet.guide_brief.history_used, true);
  assert.equal(packet.guide_brief.recommended_posture, "rehydrate_before_use");
  assert.equal(packet.guide_brief.authority, "trusted");
  assert.ok(packet.guide_brief.use_now.some((entry) => entry.includes("src/runtime.ts")));
  assert.ok(packet.guide_brief.inspect_before_use.some((entry) => entry.includes("Verify before relying on history")));
  assert.ok(packet.guide_brief.do_not_use.includes("Suppressed memory: mem-suppressed-1"));
  assert.equal(packet.guide_brief.expected_product_effects.reduces_repeated_discovery, true);
  assert.equal(packet.guide_brief.expected_product_effects.reduces_context_replay, true);
  assert.equal(packet.guide_brief.expected_product_effects.controls_negative_transfer, true);
  assert.deepEqual(packet.recovered_state.target_files, ["src/runtime.ts"]);
  assert.deepEqual(packet.recovered_state.acceptance_checks, ["npm test"]);
  assert.equal(packet.guidance.workflow_candidates[0]?.workflow_id, "wf-stable-1");
  assert.equal(packet.guidance.workflow_candidates[0]?.authority, "trusted");
  assert.equal(packet.history_contributions.handoff.used, true);
  assert.equal(packet.history_contributions.handoff.source_count, 2);
  assert.equal(packet.history_contributions.replay.used, true);
  assert.equal(packet.history_contributions.replay.source_count, 2);
  assert.ok(packet.history_contributions.replay.source_ids.includes("wf-stable-1"));
  assert.ok(packet.memory_lifecycle.suppressed_memory_ids.includes("mem-suppressed-1"));
  assert.equal(packet.memory_lifecycle.rehydration_hints[0]?.required, true);
  assert.equal(packet.risk.negative_transfer_risk, "high");
  assert.ok(packet.source_map.omitted_internal_surfaces.includes("raw_find_resolve"));
});

test("product agent context assembler compacts GuidePacket for direct Agent use", () => {
  const guidePacket = buildAionisGuidePacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-1",
      run_id: "run-1",
      task_signature: "runtime-continuation",
      task_family: "coding",
    },
    planning: planningSummaryFixture(),
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
      internal_surfaces_used: ["planning_summary"],
    },
  });
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    actor: {
      consumer_agent_id: "agent-b",
      consumer_team_id: "team-a",
      producer_agent_ids: ["agent-a"],
    },
    query: {
      text: "Recover runtime continuation",
      intent: "planning",
    },
    nodes: [{
      id: "mem-1",
      type: "procedure",
      title: "Runtime continuation memory",
      text_summary: "Inspect src/runtime.ts before editing.",
      compression_layer: "L2",
      memory_kind: "execution_memory",
      authority: "advisory",
      confidence: 0.82,
      salience: 0.9,
      tier: "warm",
      evidence_ids: ["ev-1"],
    }],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
      internal_surfaces_used: ["recall"],
    },
  });

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    guide_packet: guidePacket,
  });

  assert.equal(context.contract_version, "aionis_agent_context_v1");
  assert.equal(context.history_used, true);
  assert.equal(context.actionable_history_used, true);
  assert.equal(context.recommended_posture, "rehydrate_before_use");
  assert.equal(context.authority, "trusted");
  assert.deepEqual(context.target_files, ["src/runtime.ts"]);
  assert.ok(context.memory_ids.includes("wf-stable-1"));
  assert.ok(context.prompt_text.includes("AIONIS_AGENT_CONTEXT v1"));
  assert.ok(context.prompt_text.length < JSON.stringify({ memoryPacket, guidePacket }).length);
  assert.equal("guide_packet" in context, false);
  assert.equal("memory_packet" in context, false);
});

test("product agent context assembler enforces explicit prompt character budget", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      text: "Recover compact budget memories",
      intent: "planning",
    },
    nodes: Array.from({ length: 6 }, (_, index) => ({
      id: `mem-budget-${index}`,
      type: "concept",
      title: `Budget memory ${index}`,
      text_summary: [
        `Budget memory ${index} carries a long reusable context line for src/budget-${index}.ts.`,
        "The host needs the memory id and compact guidance, not the full repeated narrative.",
        "This sentence intentionally repeats product context so the unbudgeted prompt exceeds a small budget.",
        "This sentence intentionally repeats product context so the unbudgeted prompt exceeds a small budget.",
      ].join(" "),
      tier: "hot",
      slots: {
        memory_kind: "general_memory",
        compression_layer: "L2",
        target_files: [`src/budget-${index}.ts`],
      },
      confidence: 0.91,
      salience: 0.9,
      created_at: "2026-06-01T00:00:00.000Z",
    })),
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
      internal_surfaces_used: ["recall"],
    },
  });

  const fullContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const budgetedContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    context_char_budget: 420,
    context_compaction_profile: "aggressive",
  });

  assert.ok(fullContext.prompt_text.length > 420);
  assert.ok(budgetedContext.prompt_text.length <= 420);
  assert.equal(budgetedContext.history_used, true);
  assert.equal(budgetedContext.actionable_history_used, true);
  assert.ok(budgetedContext.memory_ids.includes("mem-budget-0"));
  assert.ok(budgetedContext.use_now_memory_ids.length > 0);
});

test("product agent context contract renderer preserves execution state surfaces", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue checkout execution-state contract renderer",
    },
    nodes: [
      {
        id: "mem-contract-current",
        type: "concept",
        title: "Checkout adapter current state",
        text_summary: "Continue from the current checkout adapter boundary in src/checkout/adapter.ts.",
        tier: "hot",
        slots: {
          memory_kind: "execution_state",
          compression_layer: "L2",
          contract_trust: "authoritative",
          execution_native_v1: {
            schema_version: "execution_native_v1",
            execution_kind: "execution_native",
            summary_kind: "current_state",
            compression_layer: "L2",
            contract_trust: "authoritative",
            task_signature: "checkout-contract-renderer",
            workflow_signature: "checkout-contract-renderer:wf",
            anchor_kind: "execution",
            anchor_level: "L2",
            target_files: ["src/checkout/adapter.ts"],
          },
        },
        confidence: 0.94,
        salience: 0.92,
      },
      {
        id: "mem-contract-procedure",
        type: "procedure",
        title: "Checkout adapter replay procedure",
        text_summary: "Reusable procedure: inspect adapter boundary, update the checkout mapping, then run focused tests.",
        tier: "hot",
        slots: {
          memory_kind: "execution_workflow",
          compression_layer: "L3",
          contract_trust: "advisory",
          execution_native_v1: {
            schema_version: "execution_native_v1",
            execution_kind: "workflow_anchor",
            summary_kind: "workflow_anchor",
            compression_layer: "L3",
            contract_trust: "advisory",
            task_signature: "checkout-contract-renderer",
            workflow_signature: "checkout-contract-renderer:wf",
            anchor_kind: "workflow",
            anchor_level: "L3",
            target_files: ["src/checkout/adapter.ts"],
            workflow_steps: ["Inspect adapter boundary.", "Run focused tests."],
          },
        },
        confidence: 0.88,
        salience: 0.9,
      },
      {
        id: "mem-contract-failed-branch",
        type: "concept",
        title: "Checkout broad search failed branch",
        text_summary: "Failed branch: broad legacy search touched unrelated modules and must not be reused.",
        tier: "warm",
        slots: {
          memory_kind: "execution_state",
          lifecycle_state: "suppressed",
          compression_layer: "L2",
          contract_trust: "authoritative",
          execution_native_v1: {
            schema_version: "execution_native_v1",
            execution_kind: "execution_native",
            summary_kind: "failed_branch",
            compression_layer: "L2",
            contract_trust: "authoritative",
            task_signature: "checkout-contract-renderer",
            workflow_signature: "checkout-contract-renderer:failed",
            anchor_kind: "execution",
            anchor_level: "L2",
            target_files: ["src/legacy/search.ts"],
          },
        },
        confidence: 0.9,
        salience: 0.84,
      },
      {
        id: "mem-contract-rehydrate",
        type: "concept",
        title: "Checkout detailed trace payload",
        text_summary: "Cold detailed trace payload exists for checkout migration and should be expanded only if needed.",
        tier: "cold",
        slots: {
          memory_kind: "execution_trace",
          compression_layer: "L1",
          contract_trust: "advisory",
          execution_native_v1: {
            schema_version: "execution_native_v1",
            execution_kind: "execution_native",
            summary_kind: "raw_trace_pointer",
            compression_layer: "L1",
            contract_trust: "advisory",
            task_signature: "checkout-contract-renderer",
            workflow_signature: "checkout-contract-renderer:wf",
            anchor_kind: "execution",
            anchor_level: "L1",
            target_files: ["src/checkout/trace.jsonl"],
            rehydration: {
              default_mode: "partial",
            },
          },
        },
        confidence: 0.78,
        salience: 0.72,
      },
    ],
  });

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    context_compaction_profile: "aggressive",
  });

  assert.ok(context.prompt_text.includes("AIONIS_CTX v2"));
  assert.equal(context.prompt_text.includes("AIONIS_AGENT_CONTEXT v1"), false);
  assert.ok(context.prompt_text.includes("current: id=m1"));
  assert.ok(context.prompt_text.includes("procedure: id=m2"));
  assert.match(context.prompt_text, /avoid: id=m\d+/);
  assert.match(context.prompt_text, /rehydrate: id=m\d+/);
  assert.ok(context.prompt_text.includes("m1=mem-contract-current"));
  assert.ok(context.prompt_text.includes("m2=mem-contract-procedure"));
  assert.ok(context.prompt_text.includes("mem-contract-failed-branch"));
  assert.ok(context.prompt_text.includes("mem-contract-rehydrate"));
  assert.ok(context.use_now_memory_ids.includes("mem-contract-current"));
  assert.ok(context.use_now_memory_ids.includes("mem-contract-procedure"));
  assert.ok(context.do_not_use_memory_ids.includes("mem-contract-failed-branch"));
  assert.ok(context.rehydrate_hints.some((entry) => entry.memory_id === "mem-contract-rehydrate"));
});

test("product agent context preserves guide-only recovered target files", () => {
  const guidePacket = buildAionisGuidePacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-guide-only",
      run_id: "run-guide-only",
      task_signature: "runtime-continuation",
      task_family: "coding",
    },
    planning: planningSummaryFixture(),
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
      internal_surfaces_used: ["planning_summary"],
    },
  });

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    guide_packet: guidePacket,
  });

  assert.equal(context.history_used, true);
  assert.equal(context.actionable_history_used, true);
  assert.deepEqual(context.target_files, ["src/runtime.ts"]);
  assert.ok(context.prompt_text.includes("target_files: src/runtime.ts"));
  assert.ok(context.memory_ids.includes("wf-stable-1"));
});

test("product agent context surfaces active general memory without execution guidance", () => {
  const guidePacket = buildAionisGuidePacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-general-memory",
      run_id: "run-general-memory",
      task_signature: "ordinary-memory",
      task_family: "memory",
    },
    planning: planningSummaryFixture(),
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
      internal_surfaces_used: ["planning_summary"],
    },
  });
  const noExecutionGuidePacket = {
    ...guidePacket,
    guide_brief: {
      ...guidePacket.guide_brief,
      summary: "No execution workflow history was recovered.",
      history_used: false,
      recommended_posture: "ignore_history" as const,
      authority: "none" as const,
      use_now: [],
      inspect_before_use: [],
      do_not_use: [],
    },
    recovered_state: {
      ...guidePacket.recovered_state,
      state_summary: null,
      resumable: false,
      target_files: [],
      acceptance_checks: [],
    },
    guidance: {
      workflow_candidates: [],
      tool_preferences: [],
    },
    risk: {
      ...guidePacket.risk,
      negative_transfer_risk: "low" as const,
      blocked_authority_count: 0,
      reasons: [],
    },
  };
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      text: "Recover ordinary memory",
      intent: "ordinary_memory",
    },
    nodes: [
      {
        id: "mem-general-active",
        type: "concept",
        title: "Current project memory",
        text_summary: "ACTIVE_GENERAL_MARKER: Current project fact says inspect src/context.ts before broad search.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "active",
          compression_layer: "L2",
        },
        confidence: 0.86,
        salience: 0.9,
        evidence_ref: "ev-general-active",
      },
      {
        id: "mem-preference-active",
        type: "rule",
        title: "Current response preference",
        text_summary: "PREFERENCE_MARKER: Keep the guidance concise and cite evidence.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "active",
          compression_layer: "L2",
        },
        confidence: 0.82,
        salience: 0.85,
        evidence_ref: "ev-preference-active",
      },
      {
        id: "mem-general-suppressed",
        type: "concept",
        title: "Suppressed ordinary memory",
        text_summary: "STALE_GENERAL_MARKER: Old ordinary memory points at src/stale.ts.",
        tier: "warm",
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "suppressed",
          compression_layer: "L2",
        },
        confidence: 0.91,
        salience: 0.8,
        evidence_ref: "ev-general-suppressed",
      },
      {
        id: "mem-general-candidate",
        type: "concept",
        title: "Candidate ordinary memory",
        text_summary: "CANDIDATE_GENERAL_MARKER: Candidate ordinary memory should be inspected before use.",
        tier: "warm",
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "candidate",
          compression_layer: "L2",
        },
        confidence: 0.55,
        salience: 0.79,
        evidence_ref: "ev-general-candidate",
      },
    ],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
      internal_surfaces_used: ["recall"],
    },
  });

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    guide_packet: noExecutionGuidePacket,
  });
  const activeMemory = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-general-active");
  const candidateMemory = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-general-candidate");
  const suppressedMemory = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-general-suppressed");

  assert.equal(activeMemory?.memory_contract.use_policy, "direct_use");
  assert.equal(activeMemory?.memory_contract.source_trust, "scoped_advisory");
  assert.equal(candidateMemory?.memory_contract.use_policy, "inspect_before_use");
  assert.equal(candidateMemory?.memory_contract.confirmation_required, true);
  assert.equal(suppressedMemory?.memory_contract.use_policy, "do_not_use");
  assert.equal(context.history_used, true);
  assert.equal(context.recommended_posture, "inspect_before_use");
  assert.equal(context.authority, "advisory");
  assert.ok(context.target_files.includes("src/context.ts"));
  assert.ok(context.use_now.some((entry) => entry.includes("ACTIVE_GENERAL_MARKER")));
  assert.ok(context.use_now.some((entry) => entry.includes("PREFERENCE_MARKER")));
  assert.equal(context.use_now.some((entry) => entry.includes("STALE_GENERAL_MARKER")), false);
  assert.equal(context.use_now.some((entry) => entry.includes("CANDIDATE_GENERAL_MARKER")), false);
  assert.ok(context.inspect_before_use.some((entry) => entry.includes("Candidate ordinary memory")));
  assert.ok(context.do_not_use.some((entry) => entry.includes("Suppressed ordinary memory")));
  assert.ok(context.use_now_memory_ids.includes("mem-general-active"));
  assert.ok(context.use_now_memory_ids.includes("mem-preference-active"));
  assert.equal(context.use_now_memory_ids.includes("mem-general-candidate"), false);
  assert.ok(context.inspect_before_use_memory_ids.includes("mem-general-candidate"));
  assert.ok(context.do_not_use_memory_ids.includes("mem-general-suppressed"));
  assert.ok(context.prompt_text.includes("ACTIVE_GENERAL_MARKER"));
  assert.ok(context.prompt_text.includes("PREFERENCE_MARKER"));
  assert.ok(context.prompt_text.includes("do_not_use"));
  assert.equal(context.prompt_text.includes("use_now_memory_ids"), false);
  assert.equal(context.prompt_text.includes("inspect_before_use_memory_ids"), false);
});

test("product memory contract keeps low-level evidence out of direct use", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "Use supporting evidence for release notes.",
    },
    nodes: [
      {
        id: "mem-evidence-event",
        type: "event",
        title: "Raw release note event",
        text_summary: "RAW_EVIDENCE_MARKER A low-level observation from a prior run.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L0",
        },
        confidence: 0.88,
        salience: 0.84,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "mem-stable-context",
        type: "concept",
        title: "Stable release note context",
        text_summary: "STABLE_CONTEXT_MARKER Use the current release-note outline.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.9,
        salience: 0.86,
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ],
  });
  const evidenceMemory = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-evidence-event");
  assert.equal(evidenceMemory?.memory_contract.use_policy, "evidence_only");
  assert.equal(evidenceMemory?.memory_contract.allowed_scope, "supporting_evidence_only");
  assert.equal(memoryPacket.source_map.internal_surfaces_used.includes("memory_contract_projection"), true);

  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  assert.equal(agentContext.use_now_memory_ids.includes("mem-evidence-event"), false);
  assert.equal(agentContext.inspect_before_use_memory_ids.includes("mem-evidence-event"), true);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-stable-context"), true);
  assert.ok(agentContext.inspect_before_use.some((entry) =>
    entry.startsWith("Memory contract:")
    && entry.includes("mem-evidence-event")
    && entry.includes("evidence_only")
  ));
  assert.ok(agentContext.risk.reasons.includes("memory_contract_evidence_only_kept_out_of_use_now"));

  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });
  const evidenceDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-evidence-event");
  assert.equal(evidenceDecision?.agent_surface, "inspect_before_use");
  assert.ok(evidenceDecision?.reason_codes.includes("memory_contract_evidence_only"));
  assert.ok(evidenceDecision?.reason_codes.includes("memory_contract_supporting_evidence_only"));
  assert.ok(trace.memory_use_receipt?.risk_flags.includes("memory_contract_evidence_only"));
  assert.ok(trace.source_map.internal_surfaces_used.includes("memory_contract"));
});

test("product memory lifecycle adjudication demotes corrected prior memory without explicit labels", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "recover project memory",
    },
    nodes: [
      {
        id: "mem-revised-checkout",
        type: "concept",
        title: "Revised checkout investigation",
        text_summary: "Later corrected project memory for the checkout validation issue. Subsequent evidence contradicted the earlier initial working note; the earlier change surface should be treated as an unverified prior, not direct action context. Current change surface: src/payments/checkout.ts, tests/checkout.test.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.91,
        salience: 0.9,
        evidence_ref: "ev-revised-checkout",
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "mem-initial-checkout",
        type: "concept",
        title: "Initial checkout investigation",
        text_summary: "Initial working note for the checkout validation issue. At that time the likely change surface looked like: legacy/payments/old-checkout.ts, obsolete/tests/old-checkout.test.ts. This note was written before later repository evidence was examined.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.9,
        salience: 0.86,
        evidence_ref: "ev-initial-checkout",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
    },
  });

  const revised = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-revised-checkout");
  const initial = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-initial-checkout");
  assert.equal(revised?.lifecycle_state, "active");
  assert.equal(revised?.authority, "advisory");
  assert.equal(initial?.lifecycle_state, "contested");
  assert.equal(initial?.authority, "candidate");
  assert.ok(memoryPacket.lifecycle.candidate_memory_ids.includes("mem-initial-checkout"));
  assert.ok(memoryPacket.contradiction_warnings.some((warning) => warning.memory_id === "mem-initial-checkout"));
  assert.ok(memoryPacket.evidence_trail.some((entry) =>
    entry.source === "edge"
    && entry.relation === "contradicts"
    && entry.memory_id === "mem-initial-checkout"
  ));

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  assert.equal(context.history_used, true);
  assert.equal(context.recommended_posture, "inspect_before_use");
  assert.equal(context.authority, "advisory");
  assert.equal(context.risk.negative_transfer_risk, "high");
  assert.ok(context.use_now.some((entry) => entry.includes("Later corrected project memory")));
  assert.equal(context.use_now.some((entry) => entry.includes("Initial checkout investigation")), false);
  assert.ok(context.inspect_before_use.some((entry) => entry.includes("Initial checkout investigation")));
  assert.ok(context.target_files.includes("src/payments/checkout.ts"));
  assert.ok(context.target_files.includes("tests/checkout.test.ts"));
  assert.equal(context.target_files.includes("legacy/payments/old-checkout.ts"), false);
  assert.equal(context.prompt_text.includes("legacy/payments/old-checkout.ts"), false);
});

test("product memory decision trace explains lifecycle and agent-context surface decisions", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "recover project memory",
    },
    nodes: [
      {
        id: "mem-current-route",
        type: "concept",
        title: "Current checkout route",
        text_summary: "Follow-up project memory. The route through legacy/payments/old-checkout.ts became a dead end. Current work sits in: src/payments/checkout.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.92,
        salience: 0.91,
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "mem-old-route",
        type: "concept",
        title: "Old checkout route",
        text_summary: "First-pass checkout memory. The suspected work area was: legacy/payments/old-checkout.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.9,
        salience: 0.87,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    lifecycle_edges: [{
      id: "edge-current-contradicts-old",
      type: "contradicts",
      src_id: "mem-current-route",
      dst_id: "mem-old-route",
      confidence: 0.86,
    }],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
    },
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
    source_map: {
      routes_used: ["/v1/debug/memory-decision-trace"],
    },
  });

  assert.equal(trace.contract_version, "aionis_memory_decision_trace_v1");
  assert.equal(trace.agent_prompt_included, false);
  assert.equal(trace.runtime_mutation, false);
  assert.equal(trace.summary.learning_control_visible, true);
  assert.equal(trace.summary.relation_count, 1);
  assert.equal(trace.context_decision.prompt_char_count, agentContext.prompt_text.length);
  assert.ok(trace.memory_use_receipt);
  assert.equal(trace.memory_use_receipt.agent_prompt_included, false);
  assert.equal(trace.memory_use_receipt.runtime_mutation, false);
  assert.equal(trace.memory_use_receipt.prompt_char_count, agentContext.prompt_text.length);
  assert.deepEqual(trace.memory_use_receipt.use_now_memory_ids, ["mem-current-route"]);
  assert.deepEqual(trace.memory_use_receipt.inspect_before_use_memory_ids, ["mem-old-route"]);
  assert.deepEqual(trace.memory_use_receipt.read_only_signal_memory_ids, ["mem-old-route"]);
  assert.equal(trace.memory_use_receipt.risk_flags.includes("relation:contradicts"), true);
  assert.equal(trace.relation_decisions[0]?.memory_id, "mem-old-route");
  assert.equal(trace.relation_decisions[0]?.source_memory_id, "mem-current-route");
  assert.equal(trace.relation_decisions[0]?.target_memory_id, "mem-old-route");
  assert.equal(trace.relation_decisions[0]?.lifecycle_relation, "contradicts");
  assert.equal(trace.relation_decisions[0]?.producer, "persisted_relation");
  assert.equal(trace.relation_decisions[0]?.gate.accepted, true);
  const currentDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-current-route");
  assert.equal(
    currentDecision?.agent_surface,
    "use_now",
  );
  assert.equal(currentDecision?.decision_kind, "used");
  assert.equal(currentDecision?.used_detail?.not_superseded, true);
  const oldDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-old-route");
  assert.equal(oldDecision?.agent_surface, "inspect_before_use");
  assert.equal(oldDecision?.decision_kind, "downgraded");
  assert.equal(oldDecision?.downgraded_detail?.by_memory_id, "mem-current-route");
  assert.equal(oldDecision?.downgraded_detail?.relation.lifecycle_relation, "contradicts");
  assert.equal(oldDecision?.downgraded_detail?.relation.producer, "persisted_relation");
  assert.ok(oldDecision?.reason_codes.includes("lifecycle_contested"));
  assert.ok(oldDecision?.reason_codes.includes("lifecycle_relation_evidence"));
  assert.equal(agentContext.prompt_text.includes("legacy/payments/old-checkout.ts"), false);
  assert.equal(trace.feedback_attribution.sparse_feedback_signal_summary.present, true);
  assert.deepEqual(trace.feedback_attribution.sparse_feedback_signal_summary.relation_counter_signal_memory_ids, ["mem-old-route"]);
  assert.deepEqual(trace.feedback_attribution.sparse_feedback_signal_summary.contradiction_warning_memory_ids, ["mem-old-route"]);
  assert.ok(trace.feedback_attribution.sparse_feedback_signal_summary.read_only_signal_memory_ids.includes("mem-old-route"));

  const audit = buildAionisMemoryDecisionAuditReport({ trace });
  assert.equal(audit.contract_version, "aionis_memory_decision_audit_report_v1");
  assert.equal(audit.verdict, "learning_control_visible");
  assert.equal(audit.counters.controlled_memory_count, 1);
  assert.equal(audit.decision_reviews.used_memories.some((entry) => entry.memory_id === "mem-current-route"), true);
  assert.equal(audit.decision_reviews.downgraded_memories[0]?.memory_id, "mem-old-route");
  assert.equal(audit.decision_reviews.downgraded_memories[0]?.by_memory_id, "mem-current-route");
  assert.equal(audit.decision_reviews.downgraded_memories[0]?.lifecycle_relation, "contradicts");
  assert.equal(audit.decision_reviews.downgraded_memories[0]?.gate.accepted, true);
  assert.deepEqual(audit.feedback_signal_review.relation_counter_signal_memories.map((entry) => entry.memory_id), ["mem-old-route"]);
  assert.deepEqual(audit.feedback_signal_review.contradiction_warning_memories.map((entry) => entry.memory_id), ["mem-old-route"]);
  assert.equal(audit.claims.some((claim) => claim.claim === "agent_prompt_excluded" && claim.status === "pass"), true);
});

test("product premise firewall flags query premises contradicted by newer memory", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "Continue from legacy/payments/old-checkout.ts for checkout validation.",
    },
    nodes: [
      {
        id: "mem-current-route",
        type: "concept",
        title: "Current checkout route",
        text_summary: "Follow-up project memory. The route through legacy/payments/old-checkout.ts became a dead end. Current work sits in: src/payments/checkout.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.92,
        salience: 0.91,
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "mem-old-route",
        type: "concept",
        title: "Old checkout route",
        text_summary: "First-pass checkout memory. The suspected work area was: legacy/payments/old-checkout.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.9,
        salience: 0.87,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    lifecycle_edges: [{
      id: "edge-current-contradicts-old",
      type: "contradicts",
      src_id: "mem-current-route",
      dst_id: "mem-old-route",
      confidence: 0.86,
    }],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  assert.equal(agentContext.risk.reasons.includes("premise_firewall_query_conflicts_with_current_memory"), true);
  assert.equal(agentContext.risk.negative_transfer_risk, "high");
  assert.deepEqual(agentContext.use_now_memory_ids, ["mem-current-route"]);
  assert.deepEqual(agentContext.inspect_before_use_memory_ids, ["mem-old-route"]);
  assert.ok(agentContext.inspect_before_use.some((entry) =>
    entry.startsWith("Premise risk:")
    && entry.includes("mem-current-route")
    && entry.includes("contradicts")
  ));

  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });
  const oldDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-old-route");
  assert.ok(oldDecision?.reason_codes.includes("premise_firewall_query_risk"));
  assert.ok(trace.source_map.internal_surfaces_used.includes("premise_firewall"));
  assert.ok(trace.memory_use_receipt?.risk_flags.includes("premise_firewall_query_risk"));
});

test("product premise firewall stays quiet when query does not carry the stale premise", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "Recover checkout validation project memory.",
    },
    nodes: [
      {
        id: "mem-current-route",
        type: "concept",
        title: "Current checkout route",
        text_summary: "Follow-up project memory. The route through legacy/payments/old-checkout.ts became a dead end. Current work sits in: src/payments/checkout.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.92,
        salience: 0.91,
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "mem-old-route",
        type: "concept",
        title: "Old checkout route",
        text_summary: "First-pass checkout memory. The suspected work area was: legacy/payments/old-checkout.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.9,
        salience: 0.87,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    lifecycle_edges: [{
      id: "edge-current-contradicts-old",
      type: "contradicts",
      src_id: "mem-current-route",
      dst_id: "mem-old-route",
      confidence: 0.86,
    }],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  assert.equal(agentContext.risk.reasons.includes("premise_firewall_query_conflicts_with_current_memory"), false);
  assert.equal(agentContext.inspect_before_use.some((entry) => entry.startsWith("Premise risk:")), false);
  assert.deepEqual(agentContext.inspect_before_use_memory_ids, ["mem-old-route"]);

  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });
  const oldDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-old-route");
  assert.equal(oldDecision?.reason_codes.includes("premise_firewall_query_risk"), false);
  assert.equal(trace.source_map.internal_surfaces_used.includes("premise_firewall"), false);
});

test("product memory decision trace observes neighborhood drift without changing guide authority", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "observe sparse feedback drift",
    },
    nodes: [
      {
        id: "mem-old-checkout-parser",
        type: "concept",
        title: "Checkout validation parser baseline",
        text_summary: "Checkout validation in src/payments/checkout.ts uses callback parser totals tax flow.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/payments/checkout.ts"],
        },
        confidence: 0.88,
        salience: 0.86,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "mem-new-checkout-schema",
        type: "concept",
        title: "Checkout validation schema path",
        text_summary: "Checkout validation in src/payments/checkout.ts centers schema normalization payment totals flow.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/payments/checkout.ts"],
        },
        confidence: 0.87,
        salience: 0.84,
        created_at: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "mem-new-checkout-idempotency",
        type: "concept",
        title: "Checkout validation idempotency path",
        text_summary: "Checkout validation in src/payments/checkout.ts centers idempotency guard payment totals flow.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/payments/checkout.ts"],
        },
        confidence: 0.86,
        salience: 0.83,
        created_at: "2026-01-04T00:00:00.000Z",
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });

  const oldDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-old-checkout-parser");
  assert.equal(oldDecision?.lifecycle_state, "active");
  assert.equal(oldDecision?.authority, "advisory");
  assert.equal(oldDecision?.agent_surface, "use_now");
  assert.equal(trace.neighborhood_drift_observation.present, true);
  assert.equal(trace.neighborhood_drift_observation.mode, "read_only_measure");
  assert.equal(trace.neighborhood_drift_observation.authority_mutation, false);
  assert.deepEqual(trace.neighborhood_drift_observation.signal_memory_ids, ["mem-old-checkout-parser"]);
  assert.equal(trace.confidence_decay_candidate_summary.present, true);
  assert.equal(trace.confidence_decay_candidate_summary.authority_mutation, false);
  assert.deepEqual(trace.confidence_decay_candidate_summary.decay_candidate_memory_ids, []);
  assert.deepEqual(trace.confidence_decay_candidate_summary.drift_only_observation_memory_ids, [
    "mem-old-checkout-parser",
  ]);
  assert.equal(trace.neighborhood_drift_observation.candidates[0]?.directional_drift_count, 2);
  assert.deepEqual(trace.neighborhood_drift_observation.candidates[0]?.directional_drift_memory_ids, [
    "mem-new-checkout-schema",
    "mem-new-checkout-idempotency",
  ]);
  assert.equal(agentContext.prompt_text.includes("neighborhood_drift"), false);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-old-checkout-parser"), true);

  const audit = buildAionisMemoryDecisionAuditReport({ trace });
  assert.equal(audit.neighborhood_drift_review.present, true);
  assert.deepEqual(audit.neighborhood_drift_review.signal_memory_ids, ["mem-old-checkout-parser"]);
  assert.deepEqual(audit.confidence_decay_candidate_review.decay_candidate_memory_ids, []);
  assert.deepEqual(audit.confidence_decay_candidate_review.drift_only_observation_memory_ids, [
    "mem-old-checkout-parser",
  ]);

  const evaluatorReport = evaluateAionisEffect({
    baseline: {
      continuity: {
        repeatedDiscoverySteps: 1,
        recoveredStateFacts: 0,
        expectedStateFacts: 1,
      },
    },
    aionis: {
      continuity: {
        repeatedDiscoverySteps: 1,
        recoveredStateFacts: 1,
        expectedStateFacts: 1,
        continuityGuidanceCorrect: true,
      },
    },
  });
  const effect = buildAionisEffectReport({
    tenant_id: "tenant-local",
    scope: "repo-a",
    report: evaluatorReport,
    neighborhood_drift_review: audit.neighborhood_drift_review,
    confidence_decay_review: audit.confidence_decay_candidate_review,
  });
  assert.equal(effect.neighborhood_drift_summary.present, true);
  assert.equal(effect.neighborhood_drift_summary.authority_mutation, false);
  assert.deepEqual(effect.neighborhood_drift_summary.signal_memory_ids, ["mem-old-checkout-parser"]);
  assert.equal(effect.confidence_decay_summary.present, true);
  assert.equal(effect.confidence_decay_summary.authority_mutation, false);
  assert.deepEqual(effect.confidence_decay_summary.decay_candidate_memory_ids, []);
});

test("product memory decision trace surfaces repeated unused memory as confidence-decay shadow candidate", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "measure repeated unused sparse feedback",
    },
    nodes: [
      {
        id: "mem-used-status",
        type: "concept",
        title: "Status update severity labels",
        text_summary: "Status updates should use customer-facing severity labels.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.88,
        salience: 0.86,
      },
      {
        id: "mem-unused-owner",
        type: "concept",
        title: "Obsolete owner names",
        text_summary: "Status updates should include obsolete escalation owner names.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.84,
        salience: 0.8,
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
    forget_result: {
      forget_effect: {
        action: "activate",
        affected_memory_ids: ["mem-used-status"],
        attribution: {
          run_id: "run:repeated-unused-shadow",
          outcome: "positive",
          used_surface: "use_now",
        },
        guide_trace: {
          guide_trace_id: "guide:repeated-unused-shadow",
          exposed_memory_count: 2,
          attributed_memory_count: 1,
          unattributed_recalled_memory_count: 1,
          unattributed_recalled_memory_ids: ["mem-unused-owner"],
          unattributed_use_now_memory_ids: ["mem-unused-owner"],
          unattributed_inspect_before_use_memory_ids: [],
          unattributed_do_not_use_memory_ids: [],
          unattributed_rehydrate_memory_ids: [],
          unused_exposure_observation: {
            contract_version: "aionis_unused_exposure_observation_v1",
            exposure_threshold: 2,
            guide_trace_count: 2,
            tracked_memory_count: 2,
            repeated_unattributed_memory_ids: ["mem-unused-owner"],
            repeated_unattributed_without_positive_memory_ids: ["mem-unused-owner"],
            memory_stats: [{
              memory_id: "mem-unused-owner",
              current_unattributed: true,
              exposure_count: 2,
              use_now_exposure_count: 2,
              inspect_before_use_exposure_count: 0,
              do_not_use_exposure_count: 0,
              rehydrate_exposure_count: 0,
              positive_attributed_use_count: 0,
              feedback_positive_count: 0,
              feedback_negative_count: 0,
              repeated_without_positive_attribution: true,
            }],
            reason: "Repeated guide exposure without positive attribution.",
          },
        },
      },
      result: {
        activated: {
          feedback_attributions: [{
            memory_id: "mem-used-status",
            run_id: "run:repeated-unused-shadow",
            outcome: "positive",
            used_surface: "use_now",
            attribution_strength: "positive_attribution",
          }],
        },
      },
    },
  });

  assert.equal(trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary.authority_mutation, false);
  assert.deepEqual(
    trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
      .candidate_from_repeated_unused_without_positive_memory_ids,
    ["mem-unused-owner"],
  );
  assert.equal(trace.confidence_decay_candidate_summary.present, true);
  assert.equal(trace.confidence_decay_candidate_summary.mode, "shadow_candidate");
  assert.equal(trace.confidence_decay_candidate_summary.authority_mutation, false);
  assert.equal(trace.confidence_decay_candidate_summary.agent_prompt_included, false);
  assert.deepEqual(trace.confidence_decay_candidate_summary.decay_candidate_memory_ids, ["mem-unused-owner"]);
  assert.deepEqual(trace.confidence_decay_candidate_summary.candidate_from_learning_control_memory_ids, ["mem-unused-owner"]);
  assert.equal(trace.inspect_before_use_shadow_delta.present, true);
  assert.equal(trace.inspect_before_use_shadow_delta.enabled, false);
  assert.equal(trace.inspect_before_use_shadow_delta.authority_mutation, false);
  assert.equal(trace.inspect_before_use_shadow_delta.agent_prompt_included, false);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.candidate_memory_ids, ["mem-unused-owner"]);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.would_move_to_inspect_before_use_memory_ids, ["mem-unused-owner"]);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.already_inspect_before_use_memory_ids, []);
  assert.equal(trace.inspect_before_use_shadow_delta.entries[0]?.current_surface, "use_now");
  assert.deepEqual(trace.inspect_before_use_shadow_delta.entries[0]?.sources, ["learning_control"]);
  assert.equal(agentContext.prompt_text.includes("confidence_decay"), false);
  assert.equal(agentContext.prompt_text.includes("inspect_before_use_shadow_delta"), false);

  const audit = buildAionisMemoryDecisionAuditReport({ trace });
  assert.deepEqual(audit.confidence_decay_candidate_review.decay_candidate_memory_ids, ["mem-unused-owner"]);
  assert.deepEqual(audit.inspect_before_use_shadow_delta_review.would_move_to_inspect_before_use_memory_ids, [
    "mem-unused-owner",
  ]);

  const effect = buildAionisEffectReport({
    tenant_id: "tenant-local",
    scope: "repo-a",
    report: evaluateAionisEffect({
      baseline: { continuity: { repeatedDiscoverySteps: 1, recoveredStateFacts: 0, expectedStateFacts: 1 } },
      aionis: {
        continuity: {
          repeatedDiscoverySteps: 1,
          recoveredStateFacts: 1,
          expectedStateFacts: 1,
          continuityGuidanceCorrect: true,
        },
      },
    }),
    confidence_decay_review: audit.confidence_decay_candidate_review,
  });
  assert.deepEqual(effect.confidence_decay_summary.decay_candidate_memory_ids, ["mem-unused-owner"]);
  assert.equal(effect.confidence_decay_summary.authority_mutation, false);
});

test("product confidence decay shadow candidate admits threshold-met negative feedback", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "measure threshold-met negative sparse feedback",
    },
    nodes: [{
      id: "mem-threshold-negative",
      type: "procedure",
      title: "Verifier-sensitive workflow",
      text_summary: "Use the prior verifier-sensitive workflow only when the current run confirms it.",
      tier: "hot",
      slots: {
        memory_kind: "execution_workflow",
        compression_layer: "L2",
        contract_trust: "authoritative",
        execution_native_v1: {
          schema_version: "execution_native_v1",
          execution_kind: "workflow_anchor",
          summary_kind: "workflow_anchor",
          compression_layer: "L2",
          contract_trust: "authoritative",
          task_family: "feedback_threshold",
          task_signature: "feedback_threshold:current",
          workflow_signature: "feedback_threshold:workflow",
          anchor_kind: "workflow",
          anchor_level: "L2",
          selected_tool: "read",
          target_files: ["src/runtime.ts"],
          workflow_steps: ["Read src/runtime.ts before changing behavior."],
        },
      },
      confidence: 0.9,
      salience: 0.86,
    }],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
    forget_result: {
      forget_effect: {
        action: "activate",
        affected_memory_ids: ["mem-threshold-negative"],
        attribution: {
          run_id: "run:threshold-negative",
          outcome: "negative",
          used_surface: "use_now",
          verifier_status: "failed",
          tool_status: "failed",
          runtime_signal_refs: ["verifier:failed"],
        },
        guide_trace: {
          guide_trace_id: "guide:threshold-negative",
          exposed_memory_count: 1,
          attributed_memory_count: 1,
          unattributed_recalled_memory_count: 0,
          unattributed_recalled_memory_ids: [],
          unattributed_use_now_memory_ids: [],
          unattributed_inspect_before_use_memory_ids: [],
          unattributed_do_not_use_memory_ids: [],
          unattributed_rehydrate_memory_ids: [],
        },
      },
      result: {
        activated: {
          feedback_attributions: [{
            memory_id: "mem-threshold-negative",
            run_id: "run:threshold-negative",
            outcome: "negative",
            used_surface: "use_now",
            verifier_status: "failed",
            tool_status: "failed",
            runtime_signal_refs: ["verifier:failed"],
            attribution_strength: "strong_counter_signal",
            strong_counter_signal_count: 1,
          }],
        },
      },
    },
  });

  assert.deepEqual(trace.feedback_attribution.threshold_met_memory_ids, ["mem-threshold-negative"]);
  assert.deepEqual(
    trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
      .candidate_from_threshold_met_memory_ids,
    ["mem-threshold-negative"],
  );
  assert.deepEqual(trace.confidence_decay_candidate_summary.decay_candidate_memory_ids, ["mem-threshold-negative"]);
  assert.deepEqual(trace.confidence_decay_candidate_summary.blocked_by_positive_attribution_memory_ids, []);
  assert.equal(trace.confidence_decay_candidate_summary.authority_mutation, false);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.would_move_to_inspect_before_use_memory_ids, [
    "mem-threshold-negative",
  ]);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.entries[0]?.sources, ["learning_control"]);
});

test("product confidence decay shadow candidate observes temporal staleness without authority mutation", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "measure temporal confidence decay candidate",
    },
    nodes: [
      {
        id: "mem-old-runtime-note",
        type: "concept",
        title: "Runtime parser old convention",
        text_summary: "Runtime parser convention in src/runtime/parser.ts used legacy tuple decoding.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/runtime/parser.ts"],
        },
        confidence: 0.88,
        salience: 0.86,
        created_at: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "mem-current-runtime-note",
        type: "concept",
        title: "Runtime parser current context",
        text_summary: "Runtime parser context in src/runtime/parser.ts now uses object payload decoding.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/runtime/parser.ts"],
        },
        confidence: 0.9,
        salience: 0.88,
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });

  const oldDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-old-runtime-note");
  assert.equal(oldDecision?.lifecycle_state, "active");
  assert.equal(oldDecision?.agent_surface, "use_now");
  assert.equal(trace.confidence_decay_candidate_summary.present, true);
  assert.equal(trace.confidence_decay_candidate_summary.authority_mutation, false);
  assert.equal(trace.confidence_decay_candidate_summary.agent_prompt_included, false);
  assert.equal(trace.confidence_decay_candidate_summary.time_decay_age_threshold_days, 90);
  assert.deepEqual(trace.confidence_decay_candidate_summary.candidate_from_time_decay_memory_ids, [
    "mem-old-runtime-note",
  ]);
  assert.deepEqual(trace.confidence_decay_candidate_summary.decay_candidate_memory_ids, [
    "mem-old-runtime-note",
  ]);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.candidate_memory_ids, [
    "mem-old-runtime-note",
  ]);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.would_move_to_inspect_before_use_memory_ids, [
    "mem-old-runtime-note",
  ]);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.entries[0]?.sources, ["time_decay"]);
  assert.equal(trace.inspect_before_use_shadow_delta.enabled, false);
  assert.equal(
    trace.confidence_decay_candidate_summary.time_decay_candidate_details[0]?.blocked_by_positive_attribution,
    false,
  );
  assert.equal(
    trace.confidence_decay_candidate_summary.time_decay_candidate_details[0]?.reference_observed_at,
    "2026-06-01T00:00:00.000Z",
  );
  assert.equal(agentContext.prompt_text.includes("confidence_decay"), false);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-old-runtime-note"), true);

  const audit = buildAionisMemoryDecisionAuditReport({ trace });
  assert.deepEqual(audit.confidence_decay_candidate_review.candidate_from_time_decay_memory_ids, [
    "mem-old-runtime-note",
  ]);
  assert.deepEqual(audit.inspect_before_use_shadow_delta_review.would_move_to_inspect_before_use_memory_ids, [
    "mem-old-runtime-note",
  ]);

  const effect = buildAionisEffectReport({
    tenant_id: "tenant-local",
    scope: "repo-a",
    report: evaluateAionisEffect({
      baseline: { continuity: { repeatedDiscoverySteps: 1, recoveredStateFacts: 0, expectedStateFacts: 1 } },
      aionis: {
        continuity: {
          repeatedDiscoverySteps: 1,
          recoveredStateFacts: 1,
          expectedStateFacts: 1,
          continuityGuidanceCorrect: true,
        },
      },
    }),
    confidence_decay_review: audit.confidence_decay_candidate_review,
  });
  assert.equal(effect.confidence_decay_summary.authority_mutation, false);
  assert.deepEqual(effect.confidence_decay_summary.candidate_from_time_decay_memory_ids, [
    "mem-old-runtime-note",
  ]);
});

test("active inspect-before-use projection moves only selected direct-use memories", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    nodes: [
      {
        id: "mem-active-projection-old",
        type: "concept",
        title: "Active projection old note",
        text_summary: "AIONIS_ACTIVE_PROJECTION keep using the old operator summary format.",
        tier: "warm",
        slots: {
          memory_kind: "general_memory",
        },
        confidence: 0.92,
        salience: 0.88,
        created_at: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "mem-active-projection-current",
        type: "concept",
        title: "Active projection current note",
        text_summary: "AIONIS_ACTIVE_PROJECTION current summaries must keep customer severity labels.",
        tier: "warm",
        slots: {
          memory_kind: "general_memory",
        },
        confidence: 0.9,
        salience: 0.86,
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  assert.equal(agentContext.use_now_memory_ids.includes("mem-active-projection-old"), true);
  assert.equal(agentContext.inspect_before_use_memory_ids.includes("mem-active-projection-old"), false);

  const projected = applyAionisInspectBeforeUseActiveProjection({
    agent_context: agentContext,
    memory_packet: memoryPacket,
    candidate_memory_ids: ["mem-active-projection-old", "mem-not-present"],
    reason: "inspect_before_use_active_projection",
  });

  assert.equal(projected.use_now_memory_ids.includes("mem-active-projection-old"), false);
  assert.equal(projected.inspect_before_use_memory_ids.includes("mem-active-projection-old"), true);
  assert.equal(projected.use_now_memory_ids.includes("mem-active-projection-current"), true);
  assert.equal(projected.recommended_posture, "inspect_before_use");
  assert.equal(projected.authority, "advisory");
  assert.equal(projected.risk.negative_transfer_risk, "medium");
  assert.ok(projected.risk.reasons.includes("inspect_before_use_active_projection"));
  assert.equal(projected.prompt_text.includes("Inspect memory before use: Active projection old note"), true);
  assert.equal(projected.prompt_text.includes("confidence_decay"), false);
  assert.equal(projected.prompt_text.includes("inspect_before_use_shadow_delta"), false);
});

test("inspect-before-use active projection preserves explicit prompt character budget", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "measure active projection budget",
    },
    nodes: [
      {
        id: "mem-active-budget-old",
        type: "concept",
        title: "Active budget old note",
        text_summary: "AIONIS_ACTIVE_BUDGET old guidance is long and should move to inspect before use after projection.",
        tier: "warm",
        slots: {
          memory_kind: "general_memory",
        },
        confidence: 0.92,
        salience: 0.88,
        created_at: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "mem-active-budget-current",
        type: "concept",
        title: "Active budget current note",
        text_summary: "AIONIS_ACTIVE_BUDGET current guidance remains directly usable and includes compact customer severity context.",
        tier: "warm",
        slots: {
          memory_kind: "general_memory",
        },
        confidence: 0.9,
        salience: 0.86,
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    context_char_budget: 520,
    context_compaction_profile: "aggressive",
  });

  const projected = applyAionisInspectBeforeUseActiveProjection({
    agent_context: agentContext,
    memory_packet: memoryPacket,
    candidate_memory_ids: ["mem-active-budget-old"],
    reason: "inspect_before_use_active_projection",
    context_char_budget: 520,
    context_compaction_profile: "aggressive",
  });

  assert.ok(projected.prompt_text.length <= 520);
  assert.equal(projected.use_now_memory_ids.includes("mem-active-budget-old"), false);
  assert.equal(projected.inspect_before_use_memory_ids.includes("mem-active-budget-old"), true);
});

test("product confidence decay temporal staleness is blocked by positive attribution", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "measure temporal confidence decay positive boundary",
    },
    nodes: [
      {
        id: "mem-old-validated-runtime-note",
        type: "concept",
        title: "Runtime parser validated convention",
        text_summary: "Runtime parser convention in src/runtime/parser.ts still applies after validation.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/runtime/parser.ts"],
        },
        confidence: 0.88,
        salience: 0.86,
        created_at: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "mem-current-validator-note",
        type: "concept",
        title: "Runtime parser current validator context",
        text_summary: "Runtime parser validation in src/runtime/parser.ts was checked during the current run.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/runtime/parser.ts"],
        },
        confidence: 0.9,
        salience: 0.88,
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
    forget_result: {
      forget_effect: {
        action: "activate",
        affected_memory_ids: ["mem-old-validated-runtime-note"],
        attribution: {
          run_id: "run:temporal-positive-boundary",
          outcome: "positive",
          used_surface: "use_now",
        },
      },
      result: {
        activated: {
          feedback_attributions: [{
            memory_id: "mem-old-validated-runtime-note",
            run_id: "run:temporal-positive-boundary",
            outcome: "positive",
            used_surface: "use_now",
            attribution_strength: "positive_attribution",
          }],
        },
      },
    },
  });

  assert.deepEqual(trace.confidence_decay_candidate_summary.candidate_from_time_decay_memory_ids, []);
  assert.deepEqual(trace.confidence_decay_candidate_summary.decay_candidate_memory_ids, []);
  assert.deepEqual(trace.confidence_decay_candidate_summary.blocked_by_positive_attribution_memory_ids, [
    "mem-old-validated-runtime-note",
  ]);
  assert.deepEqual(trace.confidence_decay_candidate_summary.blocked_by_recent_validation_memory_ids, [
    "mem-old-validated-runtime-note",
  ]);
  assert.equal(trace.inspect_before_use_shadow_delta.present, true);
  assert.equal(trace.inspect_before_use_shadow_delta.enabled, false);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.candidate_memory_ids, []);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.would_move_to_inspect_before_use_memory_ids, []);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.blocked_by_positive_attribution_memory_ids, [
    "mem-old-validated-runtime-note",
  ]);
  assert.equal(
    trace.confidence_decay_candidate_summary.time_decay_candidate_details[0]?.blocked_by_positive_attribution,
    true,
  );
  assert.equal(trace.confidence_decay_candidate_summary.authority_mutation, false);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-old-validated-runtime-note"), true);
});

test("product confidence decay temporal staleness ignores recent memory", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "measure temporal confidence decay recent boundary",
    },
    nodes: [
      {
        id: "mem-recent-runtime-note",
        type: "concept",
        title: "Runtime parser recent convention",
        text_summary: "Runtime parser convention in src/runtime/parser.ts was recently validated.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/runtime/parser.ts"],
        },
        confidence: 0.88,
        salience: 0.86,
        created_at: "2026-05-01T00:00:00.000Z",
      },
      {
        id: "mem-current-runtime-validator",
        type: "concept",
        title: "Runtime parser current note",
        text_summary: "Runtime parser context in src/runtime/parser.ts remains aligned.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/runtime/parser.ts"],
        },
        confidence: 0.9,
        salience: 0.88,
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });

  assert.deepEqual(trace.confidence_decay_candidate_summary.candidate_from_time_decay_memory_ids, []);
  assert.deepEqual(trace.confidence_decay_candidate_summary.decay_candidate_memory_ids, []);
  assert.deepEqual(trace.confidence_decay_candidate_summary.time_decay_candidate_details, []);
  assert.equal(trace.inspect_before_use_shadow_delta.present, false);
  assert.deepEqual(trace.inspect_before_use_shadow_delta.would_move_to_inspect_before_use_memory_ids, []);
  assert.equal(trace.confidence_decay_candidate_summary.authority_mutation, false);
});

test("product confidence decay shadow candidate is blocked by positive attribution", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "measure positive attribution boundary",
    },
    nodes: [{
      id: "mem-recently-used",
      type: "concept",
      title: "Recently validated status memory",
      text_summary: "Status updates should use customer-facing severity labels.",
      tier: "hot",
      slots: {
        memory_kind: "general_memory",
        compression_layer: "L2",
      },
      confidence: 0.9,
      salience: 0.86,
    }],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
    forget_result: {
      forget_effect: {
        action: "activate",
        affected_memory_ids: ["mem-recently-used"],
        attribution: {
          run_id: "run:positive-boundary",
          outcome: "positive",
          used_surface: "use_now",
        },
        guide_trace: {
          guide_trace_id: "guide:positive-boundary",
          exposed_memory_count: 1,
          attributed_memory_count: 1,
          unattributed_recalled_memory_count: 0,
          unattributed_recalled_memory_ids: [],
          unattributed_use_now_memory_ids: [],
          unattributed_inspect_before_use_memory_ids: [],
          unattributed_do_not_use_memory_ids: [],
          unattributed_rehydrate_memory_ids: [],
          unused_exposure_observation: {
            contract_version: "aionis_unused_exposure_observation_v1",
            exposure_threshold: 2,
            guide_trace_count: 2,
            tracked_memory_count: 1,
            repeated_unattributed_memory_ids: ["mem-recently-used"],
            repeated_unattributed_without_positive_memory_ids: [],
            memory_stats: [{
              memory_id: "mem-recently-used",
              current_unattributed: false,
              exposure_count: 2,
              use_now_exposure_count: 2,
              inspect_before_use_exposure_count: 0,
              do_not_use_exposure_count: 0,
              rehydrate_exposure_count: 0,
              positive_attributed_use_count: 1,
              feedback_positive_count: 1,
              feedback_negative_count: 0,
              repeated_without_positive_attribution: false,
            }],
            reason: "Repeated exposure has positive attribution.",
          },
        },
      },
      result: {
        activated: {
          feedback_attributions: [{
            memory_id: "mem-recently-used",
            run_id: "run:positive-boundary",
            outcome: "positive",
            used_surface: "use_now",
            attribution_strength: "positive_attribution",
          }],
        },
      },
    },
  });

  assert.deepEqual(trace.confidence_decay_candidate_summary.decay_candidate_memory_ids, []);
  assert.deepEqual(trace.confidence_decay_candidate_summary.blocked_by_positive_attribution_memory_ids, [
    "mem-recently-used",
  ]);
  assert.deepEqual(trace.confidence_decay_candidate_summary.blocked_by_recent_validation_memory_ids, [
    "mem-recently-used",
  ]);
  assert.equal(trace.confidence_decay_candidate_summary.authority_mutation, false);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-recently-used"), true);
});

test("product neighborhood drift observation keeps same-direction and unrelated growth negative controls quiet", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "observe drift negative controls",
    },
    nodes: [
      {
        id: "mem-old-checkout-schema",
        type: "concept",
        title: "Checkout schema validation baseline",
        text_summary: "Checkout schema validation in src/payments/checkout.ts uses normalization payment totals flow.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/payments/checkout.ts"],
        },
        confidence: 0.88,
        salience: 0.86,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "mem-new-checkout-schema-a",
        type: "concept",
        title: "Checkout schema validation extension",
        text_summary: "Checkout schema validation in src/payments/checkout.ts keeps normalization payment totals flow with typed coverage.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/payments/checkout.ts"],
        },
        confidence: 0.87,
        salience: 0.84,
        created_at: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "mem-new-checkout-schema-b",
        type: "concept",
        title: "Checkout schema validation regression",
        text_summary: "Checkout schema validation in src/payments/checkout.ts keeps normalization payment totals flow with regression coverage.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/payments/checkout.ts"],
        },
        confidence: 0.86,
        salience: 0.83,
        created_at: "2026-01-04T00:00:00.000Z",
      },
      {
        id: "mem-new-checkout-theme",
        type: "concept",
        title: "Checkout visual theme",
        text_summary: "Checkout button spacing theme in src/payments/checkout.ts adjusts color padding layout.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          target_files: ["src/payments/checkout.ts"],
        },
        confidence: 0.86,
        salience: 0.82,
        created_at: "2026-01-05T00:00:00.000Z",
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });

  assert.equal(trace.neighborhood_drift_observation.present, false);
  assert.equal(trace.neighborhood_drift_observation.authority_mutation, false);
  assert.deepEqual(trace.neighborhood_drift_observation.signal_memory_ids, []);
  assert.equal(trace.memory_decisions.every((entry) => entry.lifecycle_state === "active"), true);
  assert.equal(trace.memory_decisions.every((entry) => entry.authority === "advisory"), true);
  assert.equal(agentContext.prompt_text.includes("neighborhood_drift"), false);
});

test("product memory decision trace distinguishes blocked and rehydrate causes", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "debug memory lifecycle trace",
    },
    nodes: [
      {
        id: "mem-active-note",
        type: "concept",
        title: "Active project note",
        text_summary: "Active note for src/current.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "active",
          compression_layer: "L2",
        },
        confidence: 0.86,
        salience: 0.82,
      },
      {
        id: "mem-suppressed-note",
        type: "concept",
        title: "Suppressed project note",
        text_summary: "Suppressed old note for src/old.ts.",
        tier: "warm",
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "suppressed",
          compression_layer: "L2",
        },
        confidence: 0.9,
        salience: 0.75,
      },
      {
        id: "mem-archive-note",
        type: "concept",
        title: "Archived payload note",
        text_summary: "Archived payload may contain full historical context for src/archive.ts.",
        tier: "cold",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
          execution_native_v1: {
            rehydration_default_mode: "differential",
          },
        },
        confidence: 0.8,
        salience: 0.79,
      },
    ],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
    },
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });

  const suppressed = trace.memory_decisions.find((entry) => entry.memory_id === "mem-suppressed-note");
  assert.equal(suppressed?.decision_kind, "blocked");
  assert.equal(suppressed?.blocked_detail?.blocked_by, "suppressed_lifecycle");
  assert.equal(suppressed?.blocked_detail?.lifecycle_state, "suppressed");
  assert.equal(suppressed?.downgraded_detail, null);

  const archived = trace.memory_decisions.find((entry) => entry.memory_id === "mem-archive-note");
  assert.equal(archived?.decision_kind, "rehydrate");
  assert.equal(archived?.rehydrate_detail?.mode, "differential");
  assert.equal(archived?.rehydrate_detail?.payload_status, "cold_payload");
  assert.equal(archived?.blocked_detail, null);

  const audit = buildAionisMemoryDecisionAuditReport({ trace });
  assert.equal(audit.decision_reviews.blocked_memories[0]?.memory_id, "mem-suppressed-note");
  assert.equal(audit.decision_reviews.blocked_memories[0]?.blocked_by, "suppressed_lifecycle");
  assert.equal(audit.decision_reviews.rehydrate_memories[0]?.memory_id, "mem-archive-note");
  assert.equal(audit.decision_reviews.rehydrate_memories[0]?.mode, "differential");
});

test("product agent context strips contested target paths from active counter-evidence summaries", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "recover project memory",
    },
    nodes: [
      {
        id: "mem-current-route",
        type: "concept",
        title: "Current checkout route",
        text_summary: "Follow-up project memory. The route through legacy/payments/old-checkout.ts and obsolete/tests/old-checkout.test.ts became a dead end. The next useful work sits in: src/payments/checkout.ts and tests/checkout.test.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.92,
        salience: 0.91,
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "mem-old-route",
        type: "concept",
        title: "Old checkout route",
        text_summary: "First-pass checkout memory. The suspected work area was: legacy/payments/old-checkout.ts and obsolete/tests/old-checkout.test.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.9,
        salience: 0.87,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    lifecycle_edges: [{
      id: "edge-current-contradicts-old",
      type: "contradicts",
      src_id: "mem-current-route",
      dst_id: "mem-old-route",
      confidence: 0.86,
    }],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
    },
  });

  const current = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-current-route");
  const old = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-old-route");
  assert.equal(current?.lifecycle_state, "active");
  assert.equal(old?.lifecycle_state, "contested");

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  assert.ok(context.use_now.some((entry) => entry.includes("src/payments/checkout.ts")));
  assert.equal(context.use_now.some((entry) => entry.includes("legacy/payments/old-checkout.ts")), false);
  assert.equal(context.use_now.some((entry) => entry.includes("obsolete/tests/old-checkout.test.ts")), false);
  assert.deepEqual(context.target_files, ["src/payments/checkout.ts", "tests/checkout.test.ts"]);
  assert.equal(context.prompt_text.includes("legacy/payments/old-checkout.ts"), false);
  assert.equal(context.prompt_text.includes("obsolete/tests/old-checkout.test.ts"), false);
});

test("product memory lifecycle adjudication ignores task-domain fault words without correction context", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "recover project memory",
    },
    nodes: [
      {
        id: "mem-current-invalid-title",
        type: "concept",
        title: "current memory for redux toolkit",
        text_summary: "AIONIS_INVALID_TITLE_CURRENT: Valid test-side note for reduxjs/redux-toolkit, issue \"Skill name is invalid with slash\". This note adds another still-valid working surface: packages/toolkit/src/query/createApi.ts and packages/toolkit/vitest.config.mts. It should coexist with the other note because both describe active context for the same task.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.91,
        salience: 0.9,
        evidence_ref: "ev-current-invalid-title",
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "mem-old-invalid-title",
        type: "concept",
        title: "old memory for redux toolkit",
        text_summary: "AIONIS_INVALID_TITLE_OLD: Valid source-side note for reduxjs/redux-toolkit, issue \"Skill name is invalid with slash\". This note remains useful for the next session and points at: yarn.lock and packages/toolkit/tsup.config.mts. It is a complementary working memory, not a deprecated or failed route.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.9,
        salience: 0.86,
        evidence_ref: "ev-old-invalid-title",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
    },
  });

  const current = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-current-invalid-title");
  const old = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-old-invalid-title");
  assert.equal(current?.lifecycle_state, "active");
  assert.equal(current?.authority, "advisory");
  assert.equal(old?.lifecycle_state, "active");
  assert.equal(old?.authority, "advisory");
  assert.equal(memoryPacket.contradiction_warnings.length, 0);
  assert.equal(memoryPacket.evidence_trail.some((entry) => entry.source === "edge"), false);

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  assert.equal(context.recommended_posture, "use_as_context");
  assert.ok(context.use_now.some((entry) => entry.includes("AIONIS_INVALID_TITLE_CURRENT")));
  assert.ok(context.use_now.some((entry) => entry.includes("AIONIS_INVALID_TITLE_OLD")));
  assert.equal(context.inspect_before_use.length, 0);
});

test("product memory lifecycle adjudication ignores task-domain corrected and fix words in workflow titles", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "recover execution workflow",
    },
    nodes: [
      {
        id: "mem-current-pr-fix-title",
        type: "procedure",
        title: "Current workflow: manual Backport of Stub updates and fix plugin stub",
        text_summary: "AIONIS_PR_TITLE_CURRENT: Current reusable execution workflow for a repo PR. Current changed target files: vault/extended_system_view.go, vault/logical_system.go, vault/logical_system_stubs_oss.go. Reusable procedure: inspect the current target files before patching.",
        tier: "hot",
        slots: {
          memory_kind: "execution_workflow",
          target_files: ["vault/extended_system_view.go", "vault/logical_system.go", "vault/logical_system_stubs_oss.go"],
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "authoritative",
            task_signature: "pr-title-current",
            workflow_signature: "pr-title-current-workflow",
            target_files: ["vault/extended_system_view.go", "vault/logical_system.go", "vault/logical_system_stubs_oss.go"],
          },
        },
        confidence: 0.92,
        salience: 0.9,
      },
      {
        id: "mem-prior-corrected-title",
        type: "procedure",
        title: "Earlier workflow: Backport of Typo Corrected same typo in docs",
        text_summary: "AIONIS_PR_TITLE_PRIOR: Earlier reusable execution workflow for a repo PR. Earlier changed target files: website/content/docs/agent/index.mdx, website/content/docs/auth/approle.mdx, website/next.config.js. Reusable procedure: inspect the earlier target files before patching.",
        tier: "hot",
        slots: {
          memory_kind: "execution_workflow",
          target_files: ["website/content/docs/agent/index.mdx", "website/content/docs/auth/approle.mdx", "website/next.config.js"],
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "authoritative",
            task_signature: "pr-title-prior",
            workflow_signature: "pr-title-prior-workflow",
            target_files: ["website/content/docs/agent/index.mdx", "website/content/docs/auth/approle.mdx", "website/next.config.js"],
          },
        },
        confidence: 0.82,
        salience: 0.9,
      },
    ],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
    },
  });

  const current = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-current-pr-fix-title");
  const prior = memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-prior-corrected-title");
  assert.equal(current?.lifecycle_state, "active");
  assert.equal(current?.authority, "trusted");
  assert.equal(prior?.lifecycle_state, "active");
  assert.equal(prior?.authority, "trusted");
  assert.equal(memoryPacket.contradiction_warnings.length, 0);
  assert.equal(memoryPacket.evidence_trail.some((entry) => entry.source === "edge"), false);

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  assert.equal(context.recommended_posture, "inspect_before_use");
  assert.equal(context.authority, "advisory");
  assert.equal(context.use_now_memory_ids.length, 0);
  assert.ok(context.inspect_before_use_memory_ids.includes("mem-current-pr-fix-title"));
  assert.ok(context.inspect_before_use_memory_ids.includes("mem-prior-corrected-title"));
});

test("product agent context keeps candidate and suppressed memory out of use_now", () => {
  const guidePacket = buildAionisGuidePacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-1",
      run_id: "run-1",
      task_signature: "runtime-continuation",
      task_family: "coding",
    },
    planning: planningSummaryFixture(),
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
      internal_surfaces_used: ["planning_summary"],
    },
  });
  const unsafeGuidePacket = {
    ...guidePacket,
    guide_brief: {
      ...guidePacket.guide_brief,
      use_now: [
        ...guidePacket.guide_brief.use_now,
        "Workflow trusted: Candidate wrong workflow",
        "Workflow trusted: Suppressed wrong workflow",
      ],
      inspect_before_use: [],
      do_not_use: [],
    },
  };
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    actor: {
      consumer_agent_id: "agent-b",
      consumer_team_id: "team-a",
      producer_agent_ids: ["agent-a"],
    },
    query: {
      text: "Recover runtime continuation",
      intent: "planning",
    },
    nodes: [
      {
        id: "mem-good",
        type: "procedure",
        title: "Runtime continuation memory",
        text_summary: "Inspect src/runtime.ts before editing.",
        tier: "warm",
        slots: {
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "authoritative",
          },
        },
        confidence: 0.86,
        salience: 0.9,
        evidence_ref: "ev-good",
      },
      {
        id: "mem-candidate",
        type: "procedure",
        title: "Candidate wrong workflow",
        text_summary: "This candidate workflow is not validated.",
        tier: "warm",
        slots: {
          lifecycle_state: "candidate",
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "observational",
          },
        },
        confidence: 0.42,
        salience: 0.8,
        evidence_ref: "ev-candidate",
      },
      {
        id: "mem-suppressed",
        type: "procedure",
        title: "Suppressed wrong workflow",
        text_summary: "This suppressed workflow must not drive Agent action.",
        tier: "warm",
        slots: {
          lifecycle_state: "suppressed",
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "authoritative",
          },
        },
        confidence: 0.9,
        salience: 0.8,
        evidence_ref: "ev-suppressed",
      },
    ],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
      internal_surfaces_used: ["recall"],
    },
  });

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    guide_packet: unsafeGuidePacket,
  });

  assert.equal(context.history_used, true);
  assert.equal(context.recommended_posture, "inspect_before_use");
  assert.equal(context.risk.negative_transfer_risk, "high");
  assert.equal(context.use_now.some((entry) => entry.includes("Candidate wrong workflow")), false);
  assert.equal(context.use_now.some((entry) => entry.includes("Suppressed wrong workflow")), false);
  assert.ok(context.inspect_before_use.some((entry) => entry.includes("Candidate wrong workflow")));
  assert.ok(context.do_not_use.some((entry) => entry.includes("Suppressed wrong workflow")));
  assert.equal(context.prompt_text.includes("Workflow trusted: Candidate wrong workflow"), false);
  assert.equal(context.prompt_text.includes("Workflow trusted: Suppressed wrong workflow"), false);
});

test("product agent context downgrades conflicting trusted workflows to inspect-first", () => {
  const guidePacket = buildAionisGuidePacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-1",
      run_id: "run-1",
      task_signature: "runtime-continuation",
      task_family: "coding",
    },
    planning: planningSummaryFixture(),
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
      internal_surfaces_used: ["planning_summary"],
    },
  });
  const unsafeGuidePacket = {
    ...guidePacket,
    guide_brief: {
      ...guidePacket.guide_brief,
      recommended_posture: "reuse_supported_history" as const,
      authority: "trusted" as const,
      use_now: [
        "Recovered state: prior execution shaped evidence-backed guidance",
        "Workflow trusted: Trusted workflow A: connection runtime path",
        "Workflow trusted: Trusted workflow B: conflicting legacy adapter path",
      ],
      inspect_before_use: [],
      do_not_use: [],
    },
  };
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    actor: {
      consumer_agent_id: "agent-b",
      consumer_team_id: "team-a",
      producer_agent_ids: ["agent-a"],
    },
    query: {
      text: "Recover runtime continuation",
      intent: "planning",
    },
    nodes: [
      {
        id: "mem-trusted-a",
        type: "procedure",
        title: "Trusted workflow A: connection runtime path",
        text_summary: "Trusted workflow A says to inspect src/client/connection.ts and its retry test.",
        tier: "warm",
        slots: {
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "authoritative",
          },
        },
        confidence: 0.9,
        salience: 0.9,
        evidence_ref: "ev-trusted-a",
      },
      {
        id: "mem-trusted-b",
        type: "procedure",
        title: "Trusted workflow B: conflicting legacy adapter path",
        text_summary: "Trusted workflow B is a conflicting old path and should be inspected before reuse.",
        tier: "warm",
        slots: {
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "authoritative",
          },
        },
        confidence: 0.88,
        salience: 0.88,
        evidence_ref: "ev-trusted-b",
      },
    ],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
      internal_surfaces_used: ["recall"],
    },
  });

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    guide_packet: unsafeGuidePacket,
  });

  assert.equal(context.history_used, true);
  assert.equal(context.recommended_posture, "inspect_before_use");
  assert.equal(context.authority, "advisory");
  assert.equal(context.risk.negative_transfer_risk, "high");
  assert.ok(context.risk.reasons.includes("trusted_workflow_conflict_requires_inspection"));
  assert.equal(context.use_now.some((entry) => entry.includes("conflicting legacy adapter")), false);
  assert.ok(context.inspect_before_use.some((entry) => entry.includes("conflicting legacy adapter")));
  assert.equal(context.use_now_memory_ids.includes("mem-trusted-a"), false);
  assert.equal(context.use_now_memory_ids.includes("mem-trusted-b"), false);
  assert.ok(context.inspect_before_use_memory_ids.includes("mem-trusted-a"));
  assert.ok(context.inspect_before_use_memory_ids.includes("mem-trusted-b"));
  assert.equal(context.use_now.some((entry) => entry.includes("connection runtime path")), false);
  assert.equal(context.prompt_text.includes("Workflow trusted: Trusted workflow B: conflicting legacy adapter path"), false);
});

test("product agent context uses structured target files for trusted workflow conflict detection", () => {
  const guidePacket = buildAionisGuidePacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-1",
      run_id: "run-1",
      task_signature: "runtime-continuation",
      task_family: "coding",
    },
    planning: planningSummaryFixture(),
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
      internal_surfaces_used: ["planning_summary"],
    },
  });
  const unsafeGuidePacket = {
    ...guidePacket,
    guide_brief: {
      ...guidePacket.guide_brief,
      recommended_posture: "reuse_supported_history" as const,
      authority: "trusted" as const,
      use_now: [
        "Workflow trusted: Trusted workflow A: runtime target",
        "Workflow trusted: Trusted workflow B: adapter target",
      ],
      inspect_before_use: [],
      do_not_use: [],
    },
  };
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    actor: {
      consumer_agent_id: "agent-b",
      consumer_team_id: "team-a",
      producer_agent_ids: ["agent-a"],
    },
    query: {
      text: "Recover runtime continuation",
      intent: "planning",
    },
    nodes: [
      {
        id: "mem-target-a",
        type: "procedure",
        title: "Trusted workflow A: runtime target",
        text_summary: "Use the runtime procedure and recover local test/build conventions for this workflow.",
        tier: "warm",
        slots: {
          target_files: ["src/runtime/current.ts"],
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "authoritative",
          },
        },
        confidence: 0.9,
        salience: 0.9,
        evidence_ref: "ev-target-a",
      },
      {
        id: "mem-target-b",
        type: "procedure",
        title: "Trusted workflow B: adapter target",
        text_summary: "Use the adapter procedure and recover local test/build conventions for this workflow.",
        tier: "warm",
        slots: {
          target_files: ["src/adapter/other.ts"],
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "authoritative",
          },
        },
        confidence: 0.88,
        salience: 0.88,
        evidence_ref: "ev-target-b",
      },
    ],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
      internal_surfaces_used: ["recall"],
    },
  });

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    guide_packet: unsafeGuidePacket,
  });

  assert.equal(context.history_used, true);
  assert.equal(context.recommended_posture, "inspect_before_use");
  assert.equal(context.authority, "advisory");
  assert.ok(context.risk.reasons.includes("trusted_workflow_target_conflict"));
  assert.equal(context.use_now_memory_ids.includes("mem-target-a"), false);
  assert.equal(context.use_now_memory_ids.includes("mem-target-b"), false);
  assert.ok(context.inspect_before_use_memory_ids.includes("mem-target-a"));
  assert.ok(context.inspect_before_use_memory_ids.includes("mem-target-b"));
  assert.equal(context.use_now.some((entry) => entry.includes("Trusted workflow A: runtime target")), false);
  assert.equal(context.use_now.some((entry) => entry.includes("Trusted workflow B: adapter target")), false);
});

test("product agent context keeps multiple trusted workflows inspect-first when direct-use selection is ambiguous", () => {
  const guidePacket = buildAionisGuidePacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-1",
      run_id: "run-1",
      task_signature: "runtime-continuation",
      task_family: "coding",
    },
    planning: planningSummaryFixture(),
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
      internal_surfaces_used: ["planning_summary"],
    },
  });
  const unsafeGuidePacket = {
    ...guidePacket,
    guide_brief: {
      ...guidePacket.guide_brief,
      recommended_posture: "reuse_supported_history" as const,
      authority: "trusted" as const,
      use_now: [
        "Workflow trusted: Trusted workflow A: shared target",
        "Workflow trusted: Trusted workflow B: shared target",
      ],
      inspect_before_use: [],
      do_not_use: [],
    },
  };
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    actor: {
      consumer_agent_id: "agent-b",
      consumer_team_id: "team-a",
      producer_agent_ids: ["agent-a"],
    },
    query: {
      text: "Recover runtime continuation",
      intent: "planning",
    },
    nodes: [
      {
        id: "mem-shared-a",
        type: "procedure",
        title: "Trusted workflow A: shared target",
        text_summary: "Use workflow A for the shared file.",
        tier: "warm",
        slots: {
          target_files: ["src/shared/current.ts"],
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "authoritative",
          },
        },
        confidence: 0.9,
        salience: 0.9,
        evidence_ref: "ev-shared-a",
      },
      {
        id: "mem-shared-b",
        type: "procedure",
        title: "Trusted workflow B: shared target",
        text_summary: "Use workflow B for the shared file.",
        tier: "warm",
        slots: {
          target_files: ["src/shared/current.ts"],
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L2",
            contract_trust: "authoritative",
          },
        },
        confidence: 0.88,
        salience: 0.88,
        evidence_ref: "ev-shared-b",
      },
    ],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
      internal_surfaces_used: ["recall"],
    },
  });

  const context = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    guide_packet: unsafeGuidePacket,
  });

  assert.equal(context.history_used, true);
  assert.equal(context.recommended_posture, "inspect_before_use");
  assert.equal(context.authority, "advisory");
  assert.ok(context.risk.reasons.includes("multiple_trusted_workflows_require_inspection"));
  assert.equal(context.use_now_memory_ids.includes("mem-shared-a"), false);
  assert.equal(context.use_now_memory_ids.includes("mem-shared-b"), false);
  assert.ok(context.inspect_before_use_memory_ids.includes("mem-shared-a"));
  assert.ok(context.inspect_before_use_memory_ids.includes("mem-shared-b"));
});

test("product memory assembler converts recall output into evidence-scoped MemoryPacket", () => {
  const packet = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    actor: {
      consumer_agent_id: "agent-b",
      consumer_team_id: "team-a",
      producer_agent_ids: ["agent-a"],
    },
    query: {
      source: "text",
      intent: "recover user preference and project context",
      embedding_dims: 1536,
    },
    nodes: [
      {
        id: "mem-pref-1",
        type: "rule",
        title: "Direct answers",
        text_summary: "The user prefers direct answers before long explanation.",
        tier: "warm",
        slots: {
          compression_layer: "L2",
        },
        confidence: 0.86,
        salience: 0.72,
        commit_id: "commit-pref-1",
        raw_ref: "turn-1",
        evidence_ref: "evidence-pref-1",
      },
      {
        id: "mem-fact-1",
        type: "concept",
        title: "Product positioning",
        text_summary: "Aionis is positioned as an evidence-gated cognitive memory Runtime.",
        tier: "hot",
        slots: {
          summary_kind: "write_distillation_fact",
        },
        confidence: 0.55,
        salience: 0.66,
        commit_id: "commit-fact-1",
      },
      {
        id: "wf-1",
        type: "procedure",
        title: "Replay-backed workflow",
        text_summary: "Use replay evidence only as candidate workflow guidance.",
        tier: "cold",
        slots: {
          execution_native_v1: {
            execution_kind: "workflow_candidate",
            compression_layer: "L3",
            rehydration_default_mode: "differential",
          },
        },
        confidence: 0.74,
        salience: 0.6,
        commit_id: "commit-wf-1",
      },
    ],
    context_items: [
      {
        kind: "rule",
        node_id: "mem-pref-1",
        summary: "The user prefers direct answers before long explanation.",
        compression_layer: "L2",
        commit_id: "commit-pref-1",
      },
      {
        kind: "concept",
        node_id: "mem-fact-1",
        summary: "Aionis is positioned as an evidence-gated cognitive memory Runtime.",
        compression_layer: "L1",
        commit_id: "commit-fact-1",
      },
      {
        kind: "procedure",
        node_id: "wf-1",
        summary: "Use replay evidence only as candidate workflow guidance.",
        compression_layer: "L3",
        execution_kind: "workflow_candidate",
        commit_id: "commit-wf-1",
      },
    ],
    ranked: [
      { id: "mem-pref-1", score: 0.82 },
      { id: "mem-fact-1", score: 0.7 },
      { id: "wf-1", score: 0.64 },
    ],
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
    },
  });

  assert.equal(packet.contract_version, "aionis_memory_packet_v1");
  assert.equal(packet.memory_family, "mixed");
  assert.equal(packet.relevant_memories[0]?.memory_type, "preference");
  assert.equal(packet.relevant_memories[0]?.authority, "advisory");
  assert.equal(packet.relevant_memories[1]?.source_layer, "L1");
  assert.equal(packet.relevant_memories[1]?.authority, "candidate");
  assert.equal(packet.relevant_memories[2]?.domain, "execution");
  assert.ok(packet.lifecycle.candidate_memory_ids.includes("mem-fact-1"));
  assert.ok(packet.behavior_impact.expected_effects.includes("answer_style"));
  assert.ok(packet.behavior_impact.expected_effects.includes("fact_recall"));
  assert.ok(packet.behavior_impact.expected_effects.includes("tool_or_workflow_guidance"));
  assert.equal(packet.risk.low_confidence_count, 1);
  assert.equal(packet.risk.negative_transfer_risk, "medium");
  assert.ok(packet.source_map.omitted_internal_surfaces.includes("raw_embedding_vectors"));
});

test("product memory assembler only marks execution memory trusted through authoritative contract trust", () => {
  const packet = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "embedding",
      embedding_dims: 1536,
    },
    nodes: [
      {
        id: "wf-high-confidence-without-contract",
        type: "procedure",
        title: "High confidence workflow without authority",
        text_summary: "High confidence execution memory can guide but is not authoritative without contract trust.",
        tier: "warm",
        slots: {
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L3",
          },
        },
        confidence: 0.95,
        salience: 0.8,
      },
      {
        id: "wf-authoritative-contract",
        type: "procedure",
        title: "Authoritative workflow",
        text_summary: "Authoritative execution contract can become trusted product memory.",
        tier: "warm",
        slots: {
          execution_contract_v1: {
            schema_version: "execution_contract_v1",
            contract_trust: "authoritative",
            task_signature: "repo-a:verified-workflow",
            workflow_signature: "repo-a:verified-workflow",
            selected_tool: "test",
            outcome: {
              acceptance_checks: ["npm test"],
              success_invariants: ["all_acceptance_checks_pass"],
              dependency_requirements: [],
              environment_assumptions: [],
              must_hold_after_exit: [],
              external_visibility_requirements: [],
            },
            provenance: {
              source_kind: "manual_context",
              source_summary_version: null,
              source_anchor: "wf-authoritative-contract",
              evidence_refs: ["evidence-authoritative"],
              notes: [],
            },
          },
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L3",
          },
        },
        confidence: 0.92,
        salience: 0.86,
      },
      {
        id: "wf-observational-contract",
        type: "procedure",
        title: "Observational workflow",
        text_summary: "Observational execution memory stays candidate-level.",
        tier: "warm",
        slots: {
          execution_contract_v1: {
            schema_version: "execution_contract_v1",
            contract_trust: "observational",
            task_signature: "repo-a:observed-workflow",
            workflow_signature: "repo-a:observed-workflow",
            selected_tool: "test",
            outcome: {
              acceptance_checks: ["npm test"],
              success_invariants: ["all_acceptance_checks_pass"],
              dependency_requirements: [],
              environment_assumptions: [],
              must_hold_after_exit: [],
              external_visibility_requirements: [],
            },
            provenance: {
              source_kind: "manual_context",
              source_summary_version: null,
              source_anchor: "wf-observational-contract",
              evidence_refs: ["evidence-observational"],
              notes: [],
            },
          },
          execution_native_v1: {
            execution_kind: "workflow_anchor",
            compression_layer: "L3",
          },
        },
        confidence: 0.93,
        salience: 0.81,
      },
    ],
  });

  const noContract = packet.relevant_memories.find((entry) => entry.memory_id === "wf-high-confidence-without-contract");
  const authoritative = packet.relevant_memories.find((entry) => entry.memory_id === "wf-authoritative-contract");
  const observational = packet.relevant_memories.find((entry) => entry.memory_id === "wf-observational-contract");

  assert.equal(noContract?.authority, "advisory");
  assert.equal(authoritative?.authority, "trusted");
  assert.equal(observational?.authority, "candidate");
});

test("product learning assembler exposes scoped learning state without export authority", () => {
  const packet = buildAionisLearningPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-1",
      run_id: "run-1",
      task_signature: "runtime-continuation",
      task_family: "coding",
    },
    planning: planningSummaryFixture(),
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
    },
  });

  assert.equal(packet.contract_version, "aionis_learning_packet_v1");
  assert.equal(packet.posture.source_code_change_allowed, false);
  assert.equal(packet.posture.recommended_learning_posture, "constrain");
  assert.equal(packet.posture.authority, "blocked");
  assert.equal(packet.learning_control.stable_promotion_blocked_count, 1);
  assert.equal(packet.export_readiness.training_export_ready, false);
  assert.equal(packet.export_readiness.positive_transfer_required, true);
  assert.equal(packet.candidates.some((candidate) => candidate.candidate_id === "wf-stable-1"), false);
  assert.ok(packet.candidates.some((candidate) => candidate.candidate_id === "wf-candidate-1"));
  assert.ok(packet.evidence.workflow_anchor_ids.includes("wf-stable-1"));
  assert.ok(packet.evidence.promotion_denied_reasons.includes("promotion lacks holdout evidence"));
  assert.ok(packet.lifecycle_effect.suppressed_memory_ids.includes("mem-suppressed-1"));
  assert.ok(packet.source_map.omitted_internal_surfaces.includes("task_specific_repair_content"));
});

test("product effect assembler converts evaluator proof into measurable EffectReport", () => {
  const evaluatorReport = evaluateAionisEffect({
    baseline: {
      continuity: {
        repeatedDiscoverySteps: 4,
        continuityGuidanceCorrect: false,
        recoveredStateFacts: 1,
        expectedStateFacts: 4,
      },
      learning: {
        workflowReused: false,
        provisionalMemoriesWritten: 0,
      },
      forgetting: {
        contextItems: 8,
        usefulContextItems: 3,
        staleMemorySurfaced: 2,
      },
      learning_control: {
        weakEvidenceBlocked: 0,
        authorityRequiresEvidence: false,
        blockedAuthorityVisible: false,
        unverifiedAuthorityApplied: 1,
      },
    },
    aionis: {
      continuity: {
        repeatedDiscoverySteps: 1,
        continuityGuidanceCorrect: true,
        recoveredStateFacts: 4,
        expectedStateFacts: 4,
        verifiedFactsCarried: 2,
        verifiedFactsExpected: 2,
      },
      learning: {
        workflowReused: true,
        stableWorkflowReused: true,
        trustedPromotions: 1,
        counterEvidenceDemotions: 1,
      },
      forgetting: {
        contextItems: 4,
        usefulContextItems: 4,
        staleMemorySurfaced: 0,
        staleMemorySuppressed: 2,
        archivedMemoryRehydratedOnDemand: 1,
      },
      learning_control: {
        weakEvidenceBlocked: 1,
        authorityRequiresEvidence: true,
        blockedAuthorityVisible: true,
        unverifiedAuthorityApplied: 0,
      },
    },
  });

  const productReport = buildAionisEffectReport({
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-1",
      run_id: "run-aionis",
      task_signature: "runtime-continuation",
      task_family: "coding",
    },
    report: evaluatorReport,
    comparison: {
      mode: "baseline_vs_aionis",
      baseline_run_id: "run-base",
      aionis_run_id: "run-aionis",
    },
  });

  assert.equal(productReport.contract_version, "aionis_effect_report_v1");
  assert.equal(productReport.history_impact.impact_direction, "positive");
  assert.equal(productReport.history_impact.changed_future_behavior, true);
  assert.equal(productReport.efficiency.repeated_discovery_delta, -3);
  assert.equal(productReport.quality.negative_transfer_detected, false);
  assert.equal(productReport.history_contributions.handoff.used, true);
  assert.equal(productReport.history_contributions.replay.used, true);
  assert.equal(productReport.feedback_signal_summary.present, false);
  assert.equal(productReport.feedback_signal_summary.source, "not_supplied");
  assert.equal(productReport.feedback_signal_summary.authority_mutation, false);
  assert.ok(productReport.training_candidates.some((candidate) => candidate.label === "positive"));
  assert.ok(productReport.evidence.evidence_ids.includes("effect_kernel:continuity"));
});

test("product effect assembler projects audit feedback signals into product summary without mutation authority", () => {
  const evaluatorReport = evaluateAionisEffect({
    baseline: {
      continuity: {
        repeatedDiscoverySteps: 4,
        recoveredStateFacts: 0,
        expectedStateFacts: 2,
      },
    },
    aionis: {
      continuity: {
        repeatedDiscoverySteps: 1,
        recoveredStateFacts: 2,
        expectedStateFacts: 2,
        continuityGuidanceCorrect: true,
      },
    },
  });

  const productReport = buildAionisEffectReport({
    tenant_id: "tenant-local",
    scope: "repo-a",
    report: evaluatorReport,
    feedback_signal_review: {
      present: true,
      mode: "read_only_measure",
      authority_mutation: false,
      positive_attributed_memories: [
        {
          memory_id: "mem-positive",
          title: "Positive memory",
          reason: "Host outcome positively attributed this memory as used evidence.",
        },
      ],
      weak_counter_signal_memories: [
        {
          memory_id: "mem-weak",
          title: "Weak counter signal",
          reason: "Host outcome produced a weak counter-signal.",
        },
      ],
      strong_counter_signal_memories: [],
      relation_counter_signal_memories: [
        {
          memory_id: "mem-relation",
          title: "Relation counter signal",
          reason: "Newer relation evidence contradicted this memory.",
        },
      ],
      contradiction_warning_memories: [
        {
          memory_id: "mem-contradiction",
          title: "Contradiction warning",
          reason: "Memory carried contradiction warning evidence.",
        },
      ],
      repeated_unattributed_memories: [
        {
          memory_id: "mem-unused",
          title: "Repeated unused memory",
          reason: "Memory was repeatedly shown but not used.",
        },
      ],
      repeated_unattributed_without_positive_memories: ["mem-unused"].map((memoryId) => ({
        memory_id: memoryId,
        title: "Repeated unused memory",
        reason: "Memory was repeatedly shown without positive attributed use.",
      })),
      read_only_signal_memory_ids: ["mem-positive", "mem-weak", "mem-relation", "mem-contradiction", "mem-unused"],
      reason: "Sparse feedback signals are summarized for measure/debug/audit only.",
    },
  });

  assert.equal(productReport.feedback_signal_summary.present, true);
  assert.equal(productReport.feedback_signal_summary.source, "memory_decision_audit");
  assert.equal(productReport.feedback_signal_summary.authority_mutation, false);
  assert.deepEqual(productReport.feedback_signal_summary.positive_attributed_memory_ids, ["mem-positive"]);
  assert.deepEqual(productReport.feedback_signal_summary.weak_counter_signal_memory_ids, ["mem-weak"]);
  assert.deepEqual(productReport.feedback_signal_summary.relation_counter_signal_memory_ids, ["mem-relation"]);
  assert.deepEqual(productReport.feedback_signal_summary.contradiction_warning_memory_ids, ["mem-contradiction"]);
  assert.deepEqual(productReport.feedback_signal_summary.repeated_unattributed_memory_ids, ["mem-unused"]);
  assert.deepEqual(productReport.feedback_signal_summary.repeated_unattributed_without_positive_memory_ids, ["mem-unused"]);
  assert.deepEqual(productReport.feedback_signal_summary.read_only_signal_memory_ids, ["mem-positive", "mem-weak", "mem-relation", "mem-contradiction", "mem-unused"]);
});

test("product effect assembler refuses to overclaim single-run evidence", () => {
  const evaluatorReport = evaluateAionisEffect({
    baseline: {},
    aionis: {
      continuity: {
        repeatedDiscoverySteps: 1,
        continuityGuidanceCorrect: true,
      },
    },
  });

  const productReport = buildAionisEffectReport({
    tenant_id: "tenant-local",
    scope: "repo-a",
    report: evaluatorReport,
    comparison: {
      mode: "single_run_history_impact",
    },
  });

  assert.equal(productReport.comparison.sufficient_evidence, false);
  assert.equal(productReport.history_impact.impact_direction, "insufficient_evidence");
  assert.equal(productReport.history_impact.changed_future_behavior, false);
  assert.ok(productReport.training_candidates.every((candidate) => candidate.export_ready === false));
});

test("product effect assembler honors explicit insufficient-evidence comparison", () => {
  const evaluatorReport = evaluateAionisEffect({
    baseline: {},
    aionis: {
      continuity: {
        repeatedDiscoverySteps: 0,
        continuityGuidanceCorrect: true,
      },
    },
  });

  const productReport = buildAionisEffectReport({
    tenant_id: "tenant-local",
    scope: "repo-a",
    report: evaluatorReport,
    comparison: {
      mode: "baseline_vs_aionis",
      sufficient_evidence: false,
    },
  });

  assert.equal(productReport.comparison.sufficient_evidence, false);
  assert.equal(productReport.history_impact.impact_direction, "insufficient_evidence");
});
