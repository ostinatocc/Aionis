import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExecutionMemorySummaryBundle,
  buildAssemblySummary,
  buildExecutionSummarySurface,
  buildPlanningSummary,
  summarizeActionRecallPacket,
  summarizeDistillationSignalSurface,
  summarizePolicyLifecycleSurface,
  summarizePolicyMaintenanceSurface,
  summarizeWorkflowSignalSurface,
  summarizeWorkflowLifecycleSurface,
  summarizeWorkflowMaintenanceSurface,
  summarizeAuthorityVisibilitySurface,
  summarizePatternSignals,
} from "../../src/app/planning-summary.ts";
import { resolveContractTrustForSteering } from "../../src/memory/contract-trust.ts";
import { buildExecutionContractFromProjection } from "../../src/memory/execution-contract.ts";
import {
  ExecutionCollaborationRoutingSummarySchema,
  ExecutionCollaborationSummarySchema,
  ExecutionContinuitySnapshotSummarySchema,
  ExecutionDelegationRecordsSummarySchema,
  ExecutionForgettingSummarySchema,
  ExecutionInstrumentationSummarySchema,
  ExecutionMaintenanceSummarySchema,
  ExecutionPacketAssemblySummarySchema,
  ExecutionRoutingSignalSummarySchema,
  ExecutionStrategySummarySchema,
  ExecutionSummaryV1Schema,
  HistoryImpactSummarySchema,
  RuntimeVerificationRepairRecommendationSchema,
} from "../../src/memory/schemas.ts";

const layeredContextFixture = {
  action_recall_packet: {
    packet_version: "action_recall_v1",
    recommended_workflows: [
      {
        anchor_id: "wf_123",
        uri: "aionis://default/default/procedure/wf_123",
        type: "procedure",
        title: "Recover workflow validation failure",
        summary: "Inspect failing test and patch export",
        anchor_level: "L2",
        source_kind: "playbook",
        promotion_origin: "replay_promote",
        required_observations: 2,
        observed_count: 2,
        last_transition: "promoted_to_stable",
        last_transition_at: "2026-03-20T00:00:00Z",
        rehydration_default_mode: "partial",
        tool_set: ["edit", "test"],
        maintenance_state: "retain",
        offline_priority: "retain_workflow",
        last_maintenance_at: "2026-03-20T00:00:00Z",
        confidence: 0.72,
      },
    ],
    candidate_workflows: [
      {
        anchor_id: "wf_candidate_1",
        uri: "aionis://default/default/event/wf_candidate_1",
        type: "event",
        title: "Replay Episode: Recover workflow validation failure",
        summary: "Replay repair learning episode for validation failure",
        anchor_level: "L1",
        promotion_state: "candidate",
        source_kind: "playbook",
        promotion_origin: "replay_learning_episode",
        required_observations: 2,
        observed_count: 1,
        last_transition: "candidate_observed",
        last_transition_at: "2026-03-20T00:00:00Z",
        rehydration_default_mode: null,
        tool_set: ["edit", "test"],
        maintenance_state: "observe",
        offline_priority: "promote_candidate",
        last_maintenance_at: "2026-03-20T00:00:00Z",
        confidence: 0.61,
      },
    ],
    candidate_patterns: [],
    trusted_patterns: [
      {
        anchor_id: "p_stable",
        uri: "aionis://default/default/concept/p_stable",
        type: "concept",
        title: "Prefer edit for export repair",
        summary: "Stable edit pattern",
        anchor_level: "L3",
        selected_tool: "edit",
        pattern_state: "stable",
        credibility_state: "trusted",
        last_transition: "promoted_to_trusted",
        distinct_run_count: 2,
        required_distinct_runs: 2,
        trusted: true,
        confidence: 0.81,
      },
    ],
    contested_patterns: [
      {
        anchor_id: "p_contested",
        uri: "aionis://default/default/concept/p_contested",
        type: "concept",
        title: "Prefer bash for export repair",
        summary: "Contested bash pattern",
        anchor_level: "L3",
        selected_tool: "bash",
        pattern_state: "provisional",
        credibility_state: "contested",
        distinct_run_count: 2,
        required_distinct_runs: 2,
        trusted: false,
        counter_evidence_open: true,
        last_transition: "counter_evidence_opened",
        confidence: 0.54,
      },
    ],
    rehydration_candidates: [
      {
        anchor_id: "wf_123",
        anchor_uri: "aionis://default/default/procedure/wf_123",
        anchor_kind: "workflow",
        anchor_level: "L2",
        title: "Recover workflow validation failure",
        summary: "Inspect failing test and patch export",
        mode: "partial",
        payload_cost_hint: "medium",
        recommended_when: ["missing_log_detail"],
        trusted: false,
        selected_tool: null,
        example_call: "rehydrate_payload(anchor_id='wf_123', mode='partial')",
      },
    ],
    supporting_knowledge: [
      {
        node_id: "k_123",
        uri: "aionis://default/default/concept/k_123",
        kind: "concept",
        title: "Exports often break on stale default export wiring",
        summary: "Generic export debugging note",
        lifecycle_state: "retired",
        semantic_forgetting_action: "archive",
        archive_relocation_state: "cold_archive",
        archive_relocation_target: "local_cold_store",
        archive_payload_scope: "anchor_payload",
        rehydration_default_mode: "differential",
        confidence: 0.42,
      },
    ],
  },
  pattern_signals: [
    {
      anchor_id: "p_stable",
      anchor_level: "L3",
      selected_tool: "edit",
      pattern_state: "stable",
      credibility_state: "trusted",
      trusted: true,
      distinct_run_count: 2,
      required_distinct_runs: 2,
      counter_evidence_count: 0,
      counter_evidence_open: false,
      summary: "Stable edit pattern",
    },
    {
      anchor_id: "p_contested",
      anchor_level: "L3",
      selected_tool: "bash",
      pattern_state: "provisional",
      credibility_state: "contested",
      trusted: false,
      distinct_run_count: 2,
      required_distinct_runs: 2,
      counter_evidence_count: 1,
      counter_evidence_open: true,
      summary: "Contested bash pattern",
    },
  ],
  workflow_signals: [
    {
      anchor_id: "wf_123",
      anchor_level: "L2",
      title: "Recover workflow validation failure",
      summary: "Inspect failing test and patch export",
      promotion_state: "stable",
      promotion_ready: false,
      observed_count: 2,
      required_observations: 2,
      source_kind: "playbook",
      promotion_origin: "replay_promote",
      last_transition: "promoted_to_stable",
      maintenance_state: "retain",
      offline_priority: "retain_workflow",
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
    {
      anchor_id: "wf_candidate_1",
      anchor_level: "L1",
      title: "Replay Episode: Recover workflow validation failure",
      summary: "Replay repair learning episode for validation failure",
      promotion_state: "candidate",
      promotion_ready: false,
      observed_count: 1,
      required_observations: 2,
      source_kind: "playbook",
      promotion_origin: "replay_learning_episode",
      last_transition: "candidate_observed",
      maintenance_state: "observe",
      offline_priority: "promote_candidate",
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
  ],
  stats: {
    forgotten_items: 1,
  },
  static_injection: {
    selected_blocks: 2,
  },
};

test("contract trust steering requires explicit authoritative trust and outcome signal", () => {
  const targetOnlyContract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    target_files: ["src/routes/export.ts"],
    provenance: {
      source_kind: "manual_context",
    },
  });
  const outcomeContract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    target_files: ["src/routes/export.ts"],
    acceptance_checks: ["npm run -s test:lite -- export"],
    provenance: {
      source_kind: "manual_context",
    },
  });
  const incompleteServiceContract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    service_lifecycle_constraints: [
      {
        version: 1,
        service_kind: "process",
        label: "background package index",
        launch_reference: "python -m pypi_server -p 8080 ./packages",
        endpoint: null,
        must_survive_agent_exit: false,
        revalidate_from_fresh_shell: true,
        detach_then_probe: true,
        health_checks: [],
        teardown_notes: [],
      },
    ],
    success_invariants: ["service_process_started"],
    provenance: {
      source_kind: "manual_context",
    },
  });
  const serviceOutcomeContract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    service_lifecycle_constraints: [
      {
        version: 1,
        service_kind: "http",
        label: "local package index",
        launch_reference: "python -m pypi_server -p 8080 ./packages",
        endpoint: "http://localhost:8080/simple/",
        must_survive_agent_exit: true,
        revalidate_from_fresh_shell: true,
        detach_then_probe: true,
        health_checks: ["curl -fsS http://localhost:8080/simple/"],
        teardown_notes: [],
      },
    ],
    success_invariants: ["clean_consumer_install_succeeds"],
    must_hold_after_exit: ["service_survives_agent_exit:local package index"],
    external_visibility_requirements: ["endpoint_reachable:http://localhost:8080/simple/"],
    provenance: {
      source_kind: "manual_context",
    },
  });
  const thinContract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    workflow_signature: "execution_workflow:thin",
    provenance: {
      source_kind: "manual_context",
    },
  });

  assert.equal(
    resolveContractTrustForSteering({
      computedTrust: "authoritative",
      explicitTrust: null,
      executionContract: outcomeContract,
    }),
    "advisory",
  );
  assert.equal(
    resolveContractTrustForSteering({
      computedTrust: "authoritative",
      explicitTrust: "authoritative",
      executionContract: thinContract,
    }),
    "advisory",
  );
  assert.equal(
    resolveContractTrustForSteering({
      computedTrust: "authoritative",
      explicitTrust: "authoritative",
      executionContract: targetOnlyContract,
    }),
    "advisory",
  );
  assert.equal(
    resolveContractTrustForSteering({
      computedTrust: "authoritative",
      explicitTrust: "authoritative",
      executionContract: outcomeContract,
    }),
    "authoritative",
  );
  assert.equal(
    resolveContractTrustForSteering({
      computedTrust: "authoritative",
      explicitTrust: "authoritative",
      executionContract: incompleteServiceContract,
    }),
    "advisory",
  );
  assert.equal(
    resolveContractTrustForSteering({
      computedTrust: "authoritative",
      explicitTrust: "authoritative",
      executionContract: serviceOutcomeContract,
    }),
    "authoritative",
  );
  assert.equal(
    resolveContractTrustForSteering({
      computedTrust: "authoritative",
      explicitTrust: "observational",
      executionContract: outcomeContract,
    }),
    "observational",
  );
});

test("summarizePatternSignals splits trusted and contested pattern signals", () => {
  const summary = summarizePatternSignals(layeredContextFixture);
  assert.equal(summary.candidate_pattern_count, 0);
  assert.equal(summary.trusted_pattern_count, 1);
  assert.equal(summary.contested_pattern_count, 1);
  assert.deepEqual(summary.candidate_pattern_tools, []);
  assert.deepEqual(summary.trusted_pattern_tools, ["edit"]);
  assert.deepEqual(summary.contested_pattern_tools, ["bash"]);
});

test("summarizeActionRecallPacket reports execution-memory-first packet sections", () => {
  const summary = summarizeActionRecallPacket(layeredContextFixture);
  assert.equal(summary.recommended_workflow_count, 1);
  assert.equal(summary.candidate_workflow_count, 1);
  assert.equal(summary.candidate_pattern_count, 0);
  assert.equal(summary.trusted_pattern_count, 1);
  assert.equal(summary.contested_pattern_count, 1);
  assert.equal(summary.rehydration_candidate_count, 1);
  assert.equal(summary.supporting_knowledge_count, 1);
  assert.deepEqual(summary.workflow_anchor_ids, ["wf_123"]);
  assert.deepEqual(summary.candidate_workflow_anchor_ids, ["wf_candidate_1"]);
  assert.deepEqual(summary.candidate_pattern_anchor_ids, []);
  assert.deepEqual(summary.trusted_pattern_anchor_ids, ["p_stable"]);
  assert.deepEqual(summary.contested_pattern_anchor_ids, ["p_contested"]);
  assert.deepEqual(summary.rehydration_anchor_ids, ["wf_123"]);
});

test("buildExecutionMemorySummaryBundle aligns all execution-memory summaries from one surface", () => {
  const bundle = buildExecutionMemorySummaryBundle({
    action_recall_packet: layeredContextFixture.action_recall_packet,
    pattern_signals: layeredContextFixture.pattern_signals,
    workflow_signals: layeredContextFixture.workflow_signals,
    recommended_workflows: layeredContextFixture.action_recall_packet.recommended_workflows,
    candidate_workflows: layeredContextFixture.action_recall_packet.candidate_workflows,
    candidate_patterns: layeredContextFixture.action_recall_packet.candidate_patterns,
    trusted_patterns: layeredContextFixture.action_recall_packet.trusted_patterns,
    contested_patterns: layeredContextFixture.action_recall_packet.contested_patterns,
    rehydration_candidates: layeredContextFixture.action_recall_packet.rehydration_candidates,
    supporting_knowledge: layeredContextFixture.action_recall_packet.supporting_knowledge,
  });
  assert.deepEqual(bundle.pattern_signal_summary, summarizePatternSignals(layeredContextFixture));
  assert.deepEqual(bundle.workflow_signal_summary, summarizeWorkflowSignalSurface({
    action_recall_packet: layeredContextFixture.action_recall_packet,
    workflow_signals: layeredContextFixture.workflow_signals,
    recommended_workflows: layeredContextFixture.action_recall_packet.recommended_workflows,
    candidate_workflows: layeredContextFixture.action_recall_packet.candidate_workflows,
  }));
  assert.deepEqual(bundle.workflow_lifecycle_summary, summarizeWorkflowLifecycleSurface({
    action_recall_packet: layeredContextFixture.action_recall_packet,
    recommended_workflows: layeredContextFixture.action_recall_packet.recommended_workflows,
    candidate_workflows: layeredContextFixture.action_recall_packet.candidate_workflows,
  }));
  assert.deepEqual(bundle.workflow_maintenance_summary, summarizeWorkflowMaintenanceSurface({
    action_recall_packet: layeredContextFixture.action_recall_packet,
    recommended_workflows: layeredContextFixture.action_recall_packet.recommended_workflows,
    candidate_workflows: layeredContextFixture.action_recall_packet.candidate_workflows,
  }));
  assert.deepEqual(bundle.action_packet_summary, summarizeActionRecallPacket(layeredContextFixture));
});

test("workflow lifecycle and maintenance summaries reflect stable replay workflow guidance", () => {
  const lifecycle = summarizeWorkflowLifecycleSurface(layeredContextFixture);
  const maintenance = summarizeWorkflowMaintenanceSurface(layeredContextFixture);
  assert.deepEqual(lifecycle, {
    candidate_count: 1,
    stable_count: 1,
    replay_source_count: 2,
    rehydration_ready_count: 1,
    promotion_ready_count: 0,
    transition_counts: {
      candidate_observed: 1,
      promoted_to_stable: 1,
      normalized_latest_stable: 0,
    },
  });
  assert.deepEqual(maintenance, {
    model: "lazy_online_v1",
    observe_count: 1,
    retain_count: 1,
    promote_candidate_count: 1,
    retain_workflow_count: 1,
  });
});

test("workflow signal summary separates stable, promotion-ready, and observing workflows", () => {
  const summary = summarizeWorkflowSignalSurface(layeredContextFixture);
  assert.deepEqual(summary, {
    stable_workflow_count: 1,
    promotion_ready_workflow_count: 0,
    observing_workflow_count: 1,
    stable_workflow_titles: ["Recover workflow validation failure"],
    promotion_ready_workflow_titles: [],
    observing_workflow_titles: ["Replay Episode: Recover workflow validation failure"],
  });
});

test("authority visibility summary exposes blocked authoritative workflow evidence", () => {
  const authorityFixture = structuredClone(layeredContextFixture);
  const candidateWorkflow = (authorityFixture.action_recall_packet.candidate_workflows as any[])[0];
  candidateWorkflow.authority_visibility = {
    surface_version: "runtime_authority_visibility_v1",
    node_id: "wf_candidate_1",
    node_kind: "workflow",
    title: "Replay Episode: Recover workflow validation failure",
    requested_trust: "authoritative",
    effective_trust: "advisory",
    status: "insufficient",
    allows_authoritative: false,
    allows_stable_promotion: false,
    authority_blocked: true,
    stable_promotion_blocked: true,
    primary_blocker: "execution_evidence:after_exit_revalidation_failed",
    authority_reasons: ["execution_evidence:after_exit_revalidation_failed"],
    outcome_contract_reasons: [],
    execution_evidence_reasons: ["after_exit_revalidation_failed"],
    execution_evidence_status: "failed",
    false_confidence_detected: true,
  };

  const directSummary = summarizeAuthorityVisibilitySurface({
    candidate_workflows: authorityFixture.action_recall_packet.candidate_workflows,
  });
  assert.equal(directSummary.surface_count, 1);
  assert.equal(directSummary.authoritative_blocked_count, 1);
  assert.equal(directSummary.stable_promotion_blocked_count, 1);
  assert.equal(directSummary.execution_evidence_failed_count, 1);
  assert.equal(directSummary.false_confidence_count, 1);
  assert.deepEqual(directSummary.top_blockers, ["execution_evidence:after_exit_revalidation_failed"]);

  const planning = buildPlanningSummary({
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_authority_visibility",
        pattern_summary: {
          used_trusted_pattern_tools: ["edit"],
          skipped_contested_pattern_tools: ["bash"],
        },
      },
    },
    layered_context: authorityFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
  });
  assert.equal(planning.authority_visibility_summary.authoritative_blocked_count, 1);
  assert.equal(planning.authority_visibility_summary.execution_evidence_failed_count, 1);
  assert.match(planning.planner_explanation ?? "", /authority blocked: 1; blocker=execution_evidence:after_exit_revalidation_failed/);
  assert.match(planning.planner_explanation ?? "", /execution evidence failed: 1/);
});

test("policy lifecycle and maintenance summaries reflect persisted policy memory state", () => {
  const policyFixture = structuredClone(layeredContextFixture);
  (policyFixture.action_recall_packet.supporting_knowledge as any[]).push(
    {
      kind: "policy_memory",
      summary_kind: "policy_memory",
      node_id: "pm_active_default",
      selected_tool: "edit",
      policy_state: "stable",
      policy_memory_state: "active",
      activation_mode: "default",
      materialization_state: "persisted",
      maintenance_state: "retain",
      offline_priority: "retain_active_policy",
      last_transition: "materialized",
    },
    {
      kind: "policy_memory",
      summary_kind: "policy_memory",
      node_id: "pm_contested_hint",
      selected_tool: "bash",
      policy_state: "candidate",
      policy_memory_state: "contested",
      activation_mode: "hint",
      materialization_state: "persisted",
      maintenance_state: "review",
      offline_priority: "review_contested_policy",
      last_transition: "contested_by_feedback",
    },
  );

  assert.deepEqual(summarizePolicyLifecycleSurface(policyFixture), {
    persisted_count: 2,
    active_count: 1,
    contested_count: 1,
    retired_count: 0,
    default_mode_count: 1,
    hint_mode_count: 1,
    stable_policy_count: 1,
    transition_counts: {
      materialized: 1,
      refreshed: 0,
      contested_by_feedback: 1,
      retired_by_feedback: 0,
      retired_by_learning_control: 0,
      reactivated_by_learning_control: 0,
    },
  });
  assert.deepEqual(summarizePolicyMaintenanceSurface(policyFixture), {
    model: "lazy_online_v1",
    observe_count: 0,
    retain_count: 1,
    review_count: 1,
    promote_to_default_count: 0,
    retain_active_policy_count: 1,
    review_contested_policy_count: 1,
    retire_policy_count: 0,
    reactivate_policy_count: 0,
  });
});

test("distillation summary counts workflow and policy promotion targets", () => {
  const distillationFixture = structuredClone(layeredContextFixture);
  (distillationFixture.action_recall_packet.supporting_knowledge as any[]).push(
    {
      kind: "distilled_fact",
      summary_kind: "write_distillation_fact",
      distillation_origin: "write_distillation_input_text",
      preferred_promotion_target: "policy",
    },
  );
  const summary = summarizeDistillationSignalSurface(distillationFixture);
  assert.equal(summary.distilled_fact_count, 1);
  assert.equal(summary.promotion_target_counts.policy, 1);
});

test("buildPlanningSummary includes pattern trust totals and tool lists", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 5, matched: 2 },
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_123",
        pattern_summary: {
          used_trusted_pattern_tools: ["edit"],
          skipped_contested_pattern_tools: ["bash"],
        },
      },
    },
    layered_context: layeredContextFixture,
    cost_signals: {
      selected_memory_layers: ["L2", "L3"],
      primary_savings_levers: ["anchor_first_recall"],
    },
    context_est_tokens: 512,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "tool_first",
  });
  assert.equal(summary.trusted_pattern_count, 1);
  assert.equal(summary.contested_pattern_count, 1);
  assert.deepEqual(summary.trusted_pattern_tools, ["edit"]);
  assert.deepEqual(summary.contested_pattern_tools, ["bash"]);
  assert.deepEqual(summary.workflow_lifecycle_summary, {
    candidate_count: 1,
    stable_count: 1,
    replay_source_count: 2,
    rehydration_ready_count: 1,
    promotion_ready_count: 0,
    transition_counts: {
      candidate_observed: 1,
      promoted_to_stable: 1,
      normalized_latest_stable: 0,
    },
  });
  assert.deepEqual(summary.workflow_maintenance_summary, {
    model: "lazy_online_v1",
    observe_count: 1,
    retain_count: 1,
    promote_candidate_count: 1,
    retain_workflow_count: 1,
  });
  assert.deepEqual(summary.workflow_signal_summary, {
    stable_workflow_count: 1,
    promotion_ready_workflow_count: 0,
    observing_workflow_count: 1,
    stable_workflow_titles: ["Recover workflow validation failure"],
    promotion_ready_workflow_titles: [],
    observing_workflow_titles: ["Replay Episode: Recover workflow validation failure"],
  });
  assert.equal(summary.pattern_lifecycle_summary.candidate_count, 0);
  assert.equal(summary.pattern_lifecycle_summary.trusted_count, 1);
  assert.equal(summary.pattern_lifecycle_summary.contested_count, 1);
  assert.equal(summary.pattern_lifecycle_summary.near_promotion_count, 0);
  assert.equal(summary.pattern_lifecycle_summary.counter_evidence_open_count, 1);
  assert.deepEqual(summary.pattern_lifecycle_summary.transition_counts, {
    candidate_observed: 0,
    promoted_to_trusted: 1,
    counter_evidence_opened: 1,
    revalidated_to_trusted: 0,
  });
  assert.deepEqual(summary.pattern_maintenance_summary, {
    model: "lazy_online_v1",
    observe_count: 0,
    retain_count: 1,
    review_count: 1,
    promote_candidate_count: 0,
    review_counter_evidence_count: 1,
    retain_trusted_count: 1,
  });
  assert.equal(summary.action_packet_summary.recommended_workflow_count, 1);
  assert.equal(summary.action_packet_summary.candidate_workflow_count, 1);
  assert.equal(summary.action_packet_summary.rehydration_candidate_count, 1);
  assert.deepEqual(summary.action_packet_summary.workflow_anchor_ids, ["wf_123"]);
  assert.deepEqual(summary.action_packet_summary.candidate_workflow_anchor_ids, ["wf_candidate_1"]);
  assert.deepEqual(summary.action_packet_summary.trusted_pattern_anchor_ids, ["p_stable"]);
  assert.deepEqual(summary.selected_memory_layers, ["L2", "L3"]);
  assert.deepEqual(summary.primary_savings_levers, ["anchor_first_recall"]);
  assert.deepEqual(HistoryImpactSummarySchema.parse(summary.history_impact_summary), summary.history_impact_summary);
  assert.deepEqual(summary.history_impact_summary, {
    summary_version: "history_impact_summary_v1",
    history_applied: true,
    changed_next_run: true,
    impact_level: "context_shaping",
    affected_capabilities: ["continuity", "learning", "forgetting"],
    continuity: {
      continuity_carrier_count: 0,
      static_blocks_selected: 2,
      selected_memory_layer_count: 2,
    },
    learning: {
      stable_workflow_count: 1,
      candidate_workflow_count: 1,
      promotion_ready_workflow_count: 0,
      trusted_pattern_count: 1,
      contested_pattern_count: 1,
      active_policy_count: 0,
      contested_policy_count: 0,
    },
    forgetting: {
      substrate_mode: "stable",
      forgotten_items: 0,
      suppressed_pattern_count: 0,
      differential_rehydration_candidate_count: 1,
      stale_signal_count: 0,
    },
    learning_control: {
      contract_trust: "advisory",
      action_start_blocked: false,
      authoritative_allowed_count: 0,
      authoritative_blocked_count: 0,
      stable_promotion_allowed_count: 0,
      stable_promotion_blocked_count: 0,
      primary_blockers: [],
    },
    runtime_entropy: {
      profile_present: false,
      controls_present: false,
      entropy_level: null,
      plasticity_level: null,
      exploration_budget: null,
      control_strength: null,
    },
    next_run_changes: [
      "continuity_state_available",
      "trusted_evidence_available",
      "workflow_reuse_available",
      "candidate_learning_visible",
      "contested_memory_visible",
      "rehydration_available",
    ],
    primary_reason: "prior memory changed the guide packet",
  });
  assert.deepEqual(summary.continuity_carrier_summary, {
    total_count: 0,
    handoff_count: 0,
    session_event_count: 0,
    session_count: 0,
  });
  assert.equal(summary.action_retrieval_uncertainty, null);
  assert.equal(summary.action_retrieval_gate, null);
  assert.equal(summary.forgotten_items, 1);
  assert.equal(summary.static_blocks_selected, 2);
  assert.equal(summary.recall_mode, "tool_first");
  assert.deepEqual(summary.forgetting_summary.semantic_action_counts, {
    retain: 0,
    demote: 0,
    archive: 1,
    review: 0,
  });
  assert.deepEqual(summary.forgetting_summary.rehydration_mode_counts, {
    summary_only: 0,
    partial: 2,
    full: 0,
    differential: 1,
  });
  assert.equal(
    summary.planner_explanation,
    "workflow guidance: Recover workflow validation failure; candidate workflows visible but not yet promoted: Replay Episode: Recover workflow validation failure; selected tool: edit; trusted pattern support: edit; contested patterns visible but not trusted: bash; rehydration available: Recover workflow validation failure; supporting knowledge appended: 1",
  );
});

test("buildPlanningSummary makes continuity-guidance and planner explanation uncertainty-aware", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 4, matched: 1 },
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_uncertain",
        pattern_summary: {
          used_trusted_pattern_tools: ["edit"],
          skipped_contested_pattern_tools: ["bash"],
        },
      },
    },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 384,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    experience_intelligence: {
      recommendation: {
        history_applied: true,
        tool: {
          selected_tool: "edit",
        },
        path: {
          source_kind: "candidate_workflow",
          file_path: "src/routes/export.ts",
        },
        combined_next_action: "Patch src/routes/export.ts and rerun export tests.",
      },
      action_retrieval: {
        uncertainty: {
          summary_version: "action_retrieval_uncertainty_v1",
          level: "moderate",
          confidence: 0.58,
          evidence_gap_count: 2,
          reasons: [
            "workflow guidance is still candidate-grade and has not stabilized yet",
          ],
          recommended_actions: ["inspect_context"],
        },
      },
    },
  });

  assert.deepEqual(summary.action_retrieval_uncertainty, {
    summary_version: "action_retrieval_uncertainty_v1",
    level: "moderate",
    confidence: 0.58,
    evidence_gap_count: 2,
    reasons: [
      "workflow guidance is still candidate-grade and has not stabilized yet",
    ],
    recommended_actions: ["inspect_context"],
  });
  assert.deepEqual(summary.action_retrieval_gate, {
    summary_version: "action_retrieval_gate_v1",
    gate_action: "inspect_context",
    escalates_task_start: false,
    confidence: 0.58,
    primary_reason: "workflow guidance is still candidate-grade and has not stabilized yet",
    recommended_actions: ["inspect_context"],
    instruction: "Inspect src/routes/export.ts and the current context before using edit.",
    rehydration_candidate_count: 1,
    preferred_rehydration: null,
  });
  assert.deepEqual(summary.continuity_guidance, {
    source_kind: "experience_intelligence",
    history_applied: true,
    contract_trust: "advisory",
    execution_contract_v1: null,
    continuity_signal_v1: {
      summary_version: "runtime_continuity_signal_v1",
      action: "read_file",
      priority: "required",
      contract_trust: "advisory",
      tool_name: "read_file",
      learned_tool: "edit",
      file_path: "src/routes/export.ts",
      target_files: ["src/routes/export.ts"],
      reason: "Learned execution memory selected a concrete target file; inspect it before broad discovery.",
      instruction: "Read src/routes/export.ts before list/search discovery, then apply the learned path only if the file matches the task.",
    },
    edit_boundary_v1: {
      summary_version: "runtime_edit_boundary_v1",
      contract_trust: "advisory",
      allowed_edit_files: ["src/routes/export.ts"],
      forbidden_edit_files: [],
      required_verifiers: [],
      anti_shortcut_rules: [
        "Only edit files in allowed_edit_files unless current file content or verifier output proves the boundary is wrong.",
        "Treat learned edit boundaries as advisory until current file content confirms them.",
      ],
      reason: "Runtime derived the edit boundary from learned execution memory.",
      instruction: "Restrict writes to: src/routes/export.ts.",
    },
    verification_repair_v1: null,
    selected_tool: "edit",
    task_family: null,
    workflow_signature: null,
    policy_memory_id: null,
    file_path: "src/routes/export.ts",
    next_action: "Inspect src/routes/export.ts and the current context before using edit.",
  });
  assert.equal(
    summary.planner_explanation,
    "workflow guidance: Recover workflow validation failure; candidate workflows visible but not yet promoted: Replay Episode: Recover workflow validation failure; selected tool: edit; trusted pattern support: edit; contested patterns visible but not trusted: bash; rehydration available: Recover workflow validation failure; supporting knowledge appended: 1; action retrieval uncertainty: moderate; workflow guidance is still candidate-grade and has not stabilized yet; recommended follow-up: inspect_context",
  );
});

test("buildPlanningSummary does not count entropy visibility as history impact", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 0, matched: 0 },
    tools: {
      selection: { selected: "inspect" },
    },
    layered_context: {
      action_recall_packet: {
        recommended_workflows: [],
        candidate_workflows: [],
        candidate_patterns: [],
        trusted_patterns: [],
        contested_patterns: [],
        rehydration_candidates: [],
        supporting_knowledge: [],
      },
    },
    cost_signals: null,
    context_est_tokens: 128,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    experience_intelligence: {
      action_intelligence_runtime_contract: {
        runtime_entropy_profile: {
          profile_version: "runtime_entropy_profile_v1",
          entropy_level: "high",
          exploration_budget: 1,
          control_strength: 0.63,
          plasticity_level: "high",
          recall_breadth: "wide",
          verification_depth: "normal",
          promotion_threshold: "normal",
          mutation_authority: "candidate_only",
          runtime_signal_trend_posture: "none",
          reason_codes: ["empty_history_requires_exploration"],
          source_signals: [],
          source_code_change_allowed: false,
        },
      },
    },
  });

  assert.deepEqual(HistoryImpactSummarySchema.parse(summary.history_impact_summary), summary.history_impact_summary);
  assert.equal(summary.history_impact_summary.history_applied, false);
  assert.equal(summary.history_impact_summary.changed_next_run, false);
  assert.equal(summary.history_impact_summary.impact_level, "none");
  assert.deepEqual(summary.history_impact_summary.affected_capabilities, []);
  assert.deepEqual(summary.history_impact_summary.next_run_changes, ["runtime_entropy_visible"]);
  assert.equal(
    summary.history_impact_summary.primary_reason,
    "no prior execution history changed this packet",
  );
});

test("buildPlanningSummary enforces action intelligence pre-action gate before learned action reuse", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 2, matched: 1 },
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_pre_action_gate",
      },
    },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 384,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    experience_intelligence: {
      recommendation: {
        history_applied: true,
        tool: {
          selected_tool: "edit",
        },
        path: {
          source_kind: "recommended_workflow",
          file_path: "src/routes/export.ts",
        },
        combined_next_action: "Patch src/routes/export.ts and rerun export tests.",
      },
      action_intelligence_runtime_contract: {
        pre_action_gate: {
          gate_version: "action_intelligence_pre_action_gate_v1",
          known_enough: false,
          requires_recall: true,
          requires_rehydration: false,
          requires_operator_review: false,
          authority_blocked: false,
          uncertainty_level: "low",
          confidence: 0.31,
          recommended_actions: ["widen_recall"],
          primary_reason: "contract gate requires more recall before action reuse",
        },
        runtime_entropy_profile: {
          profile_version: "runtime_entropy_profile_v1",
          entropy_level: "high",
          exploration_budget: 0.82,
          control_strength: 0.61,
          plasticity_level: "high",
          recall_breadth: "wide",
          verification_depth: "strict",
          promotion_threshold: "high",
          mutation_authority: "candidate_only",
          reason_codes: ["pre_action_requires_wider_recall"],
          source_signals: [],
          source_code_change_allowed: false,
        },
        runtime_entropy_controls: {
          controls_version: "runtime_entropy_controls_v1",
          recall: {
            breadth: "wide",
            recommended_limit: 20,
            recommended_ranked_limit: 160,
            recommended_max_nodes: 160,
            recommended_max_edges: 100,
            reason: "High entropy or recall gaps require wider retrieval before committing to action.",
          },
          verifier: {
            verification_depth: "strict",
            schedule: "strict",
            runtime_verifier_required: true,
            reason: "Strict verification is required before the task can produce promotion evidence.",
          },
          promotion: {
            promotion_threshold: "high",
            mutation_authority: "candidate_only",
            minimum_observations: 3,
            stable_promotion_allowed: false,
            reason: "Learning may continue as scoped or candidate memory until broader evidence lowers promotion risk.",
          },
          maintenance: {
            recommended_profile: "immediate",
            run_after_task: true,
            reason: "High entropy should preserve fresh exploration material while keeping mutations controlled.",
          },
          source_code_change_allowed: false,
        },
      },
      action_retrieval: {
        uncertainty: {
          summary_version: "action_retrieval_uncertainty_v1",
          level: "low",
          confidence: 0.86,
          evidence_gap_count: 0,
          reasons: ["stable workflow and learned execution memory agree on the next step"],
          recommended_actions: ["proceed"],
        },
      },
    },
  });

  assert.deepEqual(summary.action_intelligence_pre_action_gate, {
    gate_version: "action_intelligence_pre_action_gate_v1",
    known_enough: false,
    requires_recall: true,
    requires_rehydration: false,
    requires_operator_review: false,
    authority_blocked: false,
    uncertainty_level: "low",
    confidence: 0.31,
    recommended_actions: ["widen_recall"],
    primary_reason: "contract gate requires more recall before action reuse",
  });
  assert.equal(summary.runtime_entropy_profile?.entropy_level, "high");
  assert.equal(summary.runtime_entropy_profile?.recall_breadth, "wide");
  assert.equal(summary.runtime_entropy_profile?.mutation_authority, "candidate_only");
  assert.equal(summary.runtime_entropy_controls?.recall.recommended_limit, 20);
  assert.equal(summary.runtime_entropy_controls?.verifier.schedule, "strict");
  assert.equal(summary.runtime_entropy_controls?.promotion.minimum_observations, 3);
  assert.equal(summary.runtime_entropy_controls?.promotion.stable_promotion_allowed, false);
  assert.deepEqual(summary.action_retrieval_gate, {
    summary_version: "action_retrieval_gate_v1",
    gate_action: "widen_recall",
    escalates_task_start: true,
    confidence: 0.31,
    primary_reason: "contract gate requires more recall before action reuse",
    recommended_actions: ["widen_recall"],
    instruction: "Widen recall before committing to edit on src/routes/export.ts.",
    rehydration_candidate_count: 1,
    preferred_rehydration: null,
  });
  assert.equal(summary.continuity_guidance?.continuity_signal_v1?.action, "widen_recall");
  assert.equal(summary.continuity_guidance?.continuity_signal_v1?.priority, "required");
  assert.equal(
    summary.continuity_guidance?.continuity_signal_v1?.reason,
    "Action intelligence pre-action gate does not have enough evidence to commit to one execution path.",
  );
  assert.equal(
    summary.continuity_guidance?.next_action,
    "Widen recall before committing to edit on src/routes/export.ts.",
  );
});

test("buildPlanningSummary downgrades high-uncertainty identity-poor guidance to observational trust", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 3, matched: 1 },
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_high_uncertainty",
      },
    },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    experience_intelligence: {
      recommendation: {
        history_applied: true,
        tool: {
          selected_tool: "edit",
        },
        path: {
          source_kind: "candidate_workflow",
          file_path: "src/routes/export.ts",
        },
        combined_next_action: "Patch src/routes/export.ts and rerun export tests.",
      },
      action_retrieval: {
        uncertainty: {
          summary_version: "action_retrieval_uncertainty_v1",
          level: "high",
          confidence: 0.34,
          evidence_gap_count: 4,
          reasons: [
            "workflow guidance is weak and the prior path lacks a stable identity",
          ],
          recommended_actions: ["inspect_context", "widen_recall"],
        },
      },
    },
  });

  assert.deepEqual(summary.continuity_guidance, {
    source_kind: "experience_intelligence",
    history_applied: true,
    contract_trust: "observational",
    execution_contract_v1: null,
    continuity_signal_v1: {
      summary_version: "runtime_continuity_signal_v1",
      action: "widen_recall",
      priority: "required",
      contract_trust: "observational",
      tool_name: "widen_recall",
      learned_tool: "edit",
      file_path: null,
      target_files: [],
      reason: "Action retrieval does not have enough evidence to commit to one execution path.",
      instruction: "Widen recall before committing to a file or tool.",
    },
    edit_boundary_v1: null,
    verification_repair_v1: null,
    selected_tool: "edit",
    task_family: null,
    workflow_signature: null,
    policy_memory_id: null,
    file_path: null,
    next_action: "Inspect the current context before starting with edit.",
  });
});

test("buildPlanningSummary respects explicit advisory trust from persisted policy memory", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 2, matched: 1 },
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_advisory_policy",
      },
    },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    experience_intelligence: {
      recommendation: {
        history_applied: true,
        tool: {
          selected_tool: "edit",
        },
        path: {
          source_kind: "recommended_workflow",
          workflow_signature: "workflow-validation-recovery-workflow",
          file_path: "src/routes/export.ts",
          contract_trust: "advisory",
        },
        combined_next_action: "Patch src/routes/export.ts and rerun export tests.",
      },
      policy_contract: {
        summary_version: "policy_contract_v1",
        policy_kind: "tool_preference",
        source_kind: "stable_workflow",
        policy_state: "candidate",
        contract_trust: "advisory",
        activation_mode: "hint",
        materialization_state: "persisted",
        history_applied: true,
        selected_tool: "edit",
        avoid_tools: [],
        task_family: "task:workflow_validation_recovery",
        workflow_signature: "workflow-validation-recovery-workflow",
        file_path: "src/routes/export.ts",
        target_files: ["src/routes/export.ts"],
        next_action: "Patch src/routes/export.ts and rerun export tests.",
        confidence: 0.72,
        source_anchor_ids: ["wf_123"],
        reason: "Advisory persisted policy memory suggests edit but should not strongly steer continuity guidance.",
      },
      action_retrieval: {
        uncertainty: {
          summary_version: "action_retrieval_uncertainty_v1",
          level: "low",
          confidence: 0.84,
          evidence_gap_count: 0,
          reasons: [],
          recommended_actions: ["proceed"],
        },
      },
    },
  });

  assert.deepEqual(summary.continuity_guidance, {
    source_kind: "experience_intelligence",
    history_applied: true,
    contract_trust: "advisory",
    execution_contract_v1: null,
    continuity_signal_v1: {
      summary_version: "runtime_continuity_signal_v1",
      action: "read_file",
      priority: "required",
      contract_trust: "advisory",
      tool_name: "read_file",
      learned_tool: "edit",
      file_path: "src/routes/export.ts",
      target_files: ["src/routes/export.ts"],
      reason: "Learned execution memory selected a concrete target file; inspect it before broad discovery.",
      instruction: "Read src/routes/export.ts before list/search discovery, then apply the learned path only if the file matches the task.",
    },
    edit_boundary_v1: {
      summary_version: "runtime_edit_boundary_v1",
      contract_trust: "advisory",
      allowed_edit_files: ["src/routes/export.ts"],
      forbidden_edit_files: [],
      required_verifiers: [],
      anti_shortcut_rules: [
        "Only edit files in allowed_edit_files unless current file content or verifier output proves the boundary is wrong.",
        "Treat learned edit boundaries as advisory until current file content confirms them.",
      ],
      reason: "Runtime derived the edit boundary from learned execution memory.",
      instruction: "Restrict writes to: src/routes/export.ts.",
    },
    verification_repair_v1: null,
    selected_tool: "edit",
    task_family: "task:workflow_validation_recovery",
    workflow_signature: "workflow-validation-recovery-workflow",
    policy_memory_id: null,
    file_path: "src/routes/export.ts",
    next_action: "Patch src/routes/export.ts and rerun export tests.",
  });
});

test("buildPlanningSummary demotes blocked authoritative workflow to inspect-first continuity guidance", () => {
  const executionContract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    task_family: "task:workflow_validation_recovery",
    workflow_signature: "workflow-validation-recovery-workflow",
    selected_tool: "edit",
    file_path: "src/routes/export.ts",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests.",
    acceptance_checks: ["npm test -- export"],
    success_invariants: ["export route returns valid serialized payload"],
    provenance: {
      source_kind: "workflow_projection",
      source_summary_version: "planning-summary-test",
      source_anchor: "wf_authority_blocked",
      evidence_refs: ["wf_authority_blocked"],
      notes: ["test authoritative workflow projection"],
    },
  });
  const summary = buildPlanningSummary({
    rules: { considered: 2, matched: 1 },
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_blocked_authority",
      },
    },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    experience_intelligence: {
      execution_contract_v1: executionContract,
      recommendation: {
        history_applied: true,
        tool: {
          selected_tool: "edit",
        },
        path: {
          source_kind: "recommended_workflow",
          workflow_signature: "workflow-validation-recovery-workflow",
          file_path: "src/routes/export.ts",
          contract_trust: "authoritative",
          authority_blocked: true,
          authority_primary_blocker: "execution_evidence:after_exit_revalidation_failed",
        },
        combined_next_action: "Patch src/routes/export.ts and rerun export tests.",
      },
      action_retrieval: {
        uncertainty: {
          summary_version: "action_retrieval_uncertainty_v1",
          level: "moderate",
          confidence: 0.42,
          evidence_gap_count: 1,
          reasons: [
            "selected workflow authority is blocked: execution_evidence:after_exit_revalidation_failed",
          ],
          recommended_actions: ["inspect_context"],
        },
      },
    },
  });

  assert.equal(summary.continuity_guidance?.contract_trust, "advisory");
  assert.equal(summary.continuity_guidance?.execution_contract_v1?.contract_trust, "advisory");
  assert.equal(summary.continuity_guidance?.file_path, "src/routes/export.ts");
  assert.equal(
    summary.continuity_guidance?.next_action,
    "Inspect src/routes/export.ts and revalidate current context before reusing edit; authority blocked by execution_evidence:after_exit_revalidation_failed.",
  );
  assert.equal(
    summary.continuity_guidance?.execution_contract_v1?.next_action,
    summary.continuity_guidance?.next_action,
  );
});

test("buildPlanningSummary classifies verifier lint/type phase and forces line-local repair", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["index.js", "test.js", "index.d.ts", "index.test-d.ts"],
      forbidden_edit_files: ["package.json", "readme.md"],
      required_verifiers: ["npm test"],
    },
    execution_evidence: [{
      verifier: {
        command: "npm test",
        passed: false,
        exit_code: 1,
        stderr_tail: [
          "> async-tools@1.0.0 test",
          "> xo && ava && tsd",
          "",
          "  index.js:210:8",
          "  ✖  210:8  It's not necessary to initialize abortReason to undefined.  no-undef-init",
          "",
          "  1 error",
        ].join("\n"),
      },
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.verifier_failure_phase_v1.phase, "lint_type_failure");
  assert.equal(repair.verifier_failure_phase_v1.failing_command, "npm test");
  assert.deepEqual(repair.verifier_failure_phase_v1.primary_files, ["index.js"]);
  assert.equal(repair.verifier_failure_phase_v1.line_hints[0]?.path, "index.js");
  assert.equal(repair.verifier_failure_phase_v1.line_hints[0]?.line, 210);
  assert.match(repair.verifier_failure_phase_v1.recommended_focus, /index\.js:210:8/);
  assert.ok(repair.verifier_failure_phase_v1.forbidden_next_actions.includes("list_files"));
  assert.ok(repair.next_actions[0]?.startsWith("Use verifier_failure_phase_v1 as evidence focus"));
});

test("buildPlanningSummary parses XO block diagnostics without crossing file-header newlines", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["index.js", "test.js", "index.d.ts", "index.test-d.ts"],
      forbidden_edit_files: ["package.json", "readme.md"],
      required_verifiers: ["npm test"],
    },
    execution_evidence: [{
      verifier: {
        command: "npm test",
        passed: false,
        exit_code: 1,
        stderr_tail: [
          "  index.js:25:36",
          "  ⚠   73:5   Unused eslint-disable directive.  no-warning-comments",
          "  ✖   25:36  Expected method shorthand.       object-shorthand",
          "",
          "  index.d.ts:11:1",
          "  ✖   11:1   Expected indentation of 1 tab but found 2.  @stylistic/indent",
          "",
          "  1 warning",
          "  2 errors",
        ].join("\n"),
      },
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.verifier_failure_phase_v1.phase, "lint_type_failure");
  assert.equal(repair.verifier_failure_phase_v1.line_hints[0]?.path, "index.js");
  assert.equal(repair.verifier_failure_phase_v1.line_hints[0]?.line, 25);
  assert.equal(repair.verifier_failure_phase_v1.line_hints[0]?.column, 36);
  assert.match(repair.verifier_failure_phase_v1.line_hints[0]?.message ?? "", /Expected method shorthand/);
  assert.match(repair.verifier_failure_phase_v1.recommended_focus, /index\.js:25:36/);
  assert.ok(!repair.verifier_failure_phase_v1.line_hints.some((hint) => (
    hint.path === "index.js"
    && hint.line === 25
    && /Unused eslint-disable/.test(hint.message ?? "")
  )));
});

test("buildPlanningSummary classifies hidden contract phase separately from self-authored test failures", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["index.js", "test.js", "index.d.ts", "index.test-d.ts"],
      forbidden_edit_files: ["package.json", "readme.md"],
      required_verifiers: ["node verifier.mjs async-helper-abort-signal"],
    },
    execution_evidence: [{
      verifier: {
        command: "node verifier.mjs async-helper-abort-signal",
        passed: false,
        exit_code: 1,
        stderr_tail: [
          "AssertionError [ERR_ASSERTION]: pLocate must reject with signal.reason when aborted during pending work: expected promise to reject",
          "    at expectRejectsWithExactReason (file:///repo/external-verifiers/execution-contracts.mjs:178:10)",
          "    at async verifyAsyncHelperAbortSignal (file:///repo/external-verifiers/execution-contracts.mjs:211:3)",
        ].join("\n"),
      },
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.verifier_failure_phase_v1.phase, "hidden_contract_failure");
  assert.ok(repair.verifier_failure_phase_v1.primary_files.includes("index.js"));
  assert.ok(repair.verifier_failure_phase_v1.forbidden_next_actions.includes("write_tests_only"));
  assert.match(repair.verifier_failure_phase_v1.recommended_focus, /hidden verifier contract|index\.js/);
});

test("buildPlanningSummary keeps TypeScript diagnostics ahead of hidden verifier stack frames", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: [
        "source/core/index.ts",
        "package.json",
        "test/progress.ts",
        "test/hooks.ts",
        "test/redirects.ts",
        "documentation/3-streams.md",
      ],
      forbidden_edit_files: ["readme.md", "package-lock.json"],
      required_verifiers: ["node verifier.mjs stream-client-contract-failure"],
    },
    execution_evidence: [{
      verifier: {
        command: "node verifier.mjs stream-client-contract-failure",
        passed: false,
        exit_code: 1,
        stderr_tail: [
          "Error: command failed: npm run build",
          "source/core/index.ts(7,8): error TS1192: Module 'node_modules/stream-parts/index' has no default export.",
          "    at verifyStreamClientContractFailure (file:///repo/external-verifiers/execution-contracts.mjs:320:3)",
        ].join("\n"),
      },
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.verifier_failure_phase_v1.phase, "lint_type_failure");
  assert.equal(repair.verifier_failure_phase_v1.primary_files[0], "source/core/index.ts");
  assert.equal(repair.verifier_failure_phase_v1.line_hints[0]?.path, "source/core/index.ts");
  assert.equal(repair.verifier_failure_phase_v1.line_hints[0]?.line, 7);
  assert.equal(repair.verifier_failure_phase_v1.line_hints[0]?.column, 8);
  assert.match(repair.verifier_failure_phase_v1.recommended_focus, /source\/core\/index\.ts:7:8/);
});

test("buildPlanningSummary keeps hidden verifier assertion repair guidance generic", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["lib/matcher.js", "test/api.matcher.js"],
      forbidden_edit_files: ["package.json", "README.md", "lib/parse.js"],
      required_verifiers: ["node verifier.mjs matcher-object-contract"],
    },
    execution_evidence: [{
      verifier: {
        command: "node verifier.mjs matcher-object-contract",
        passed: false,
        exit_code: 1,
        stderr_tail: [
          "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
          "false !== true",
          "    at verifyMatcherObjectContract (file:///repo/external-verifiers/execution-contracts.mjs:182:10)",
          "operator: 'strictEqual'",
        ].join("\n"),
      },
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.verifier_failure_phase_v1.phase, "hidden_contract_failure");
  assert.equal(repair.verifier_failure_phase_v1.primary_files[0], "lib/matcher.js");
  assert.ok(repair.verifier_failure_phase_v1.forbidden_next_actions.includes("write_tests_only"));
  assert.ok(repair.next_actions.some((action) => /Verifier assertion evidence/.test(action)));
  assert.match(repair.instruction, /scoped acceptance evidence/);
  assert.ok(!repair.next_actions.some((action) => /\.isMatch|continue past non-matching result objects/.test(action)));
});

test("buildPlanningSummary lets latest test-contract evidence supersede older lint evidence", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["index.js", "test.js", "index.d.ts", "index.test-d.ts"],
      forbidden_edit_files: ["package.json", "readme.md"],
      required_verifiers: ["node verifier.mjs async-helper-abort-signal"],
    },
    execution_evidence: [
      {
        verifier: {
          command: "node verifier.mjs async-helper-abort-signal",
          passed: false,
          exit_code: 1,
          stderr_tail: [
            "  index.js:20:1",
            "  ✖  20:1  Expected indentation of 1 tab but found 3.  @stylistic/indent",
          ].join("\n"),
        },
      },
      {
        verifier: {
          command: "node verifier.mjs async-helper-abort-signal",
          passed: false,
          exit_code: 1,
          stderr_tail: [
            "AssertionError [ERR_ASSERTION]: index.test-d.ts must assert pLocate accepts an AbortSignal option.",
            "expected: /signal:\\s*new AbortController\\(\\)\\.signal|signal:\\s*abortController\\.signal/",
          ].join("\n"),
        },
      },
    ],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.verifier_failure_phase_v1.phase, "authored_test_failure");
  assert.equal(repair.verifier_failure_phase_v1.primary_files[0], "index.test-d.ts");
  assert.match(repair.verifier_failure_phase_v1.recommended_focus, /index\.test-d\.ts/);
  assert.ok(!repair.verifier_failure_phase_v1.line_hints.some((hint) => hint.path === "index.js" && hint.line === 20));
});

test("buildPlanningSummary keeps verifier test coverage evidence generic", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["lib/core/HeaderBag.js", "tests/unit/headerBag.test.js"],
      forbidden_edit_files: ["package.json", "README.md"],
      required_verifiers: ["node verifier.mjs header-bag-array-serialization"],
    },
    execution_evidence: [{
      verifier: {
        command: "node verifier.mjs header-bag-array-serialization",
        passed: false,
        exit_code: 1,
        stderr_tail: [
          "AssertionError [ERR_ASSERTION]: HeaderBag tests must preserve normal array header serialization coverage.",
          "    at verifyHeaderBagArraySerialization (file:///repo/external-verifiers/execution-contracts.mjs:141:10)",
        ].join("\n"),
      },
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.verifier_failure_phase_v1.phase, "authored_test_failure");
  assert.equal(repair.verifier_failure_phase_v1.primary_files[0], "lib/core/HeaderBag.js");
  assert.match(repair.verifier_failure_phase_v1.recommended_focus, /lib\/core\/HeaderBag\.js/);
  assert.ok(!repair.verifier_failure_phase_v1.forbidden_next_actions.includes("write_tests_only"));
  assert.ok(repair.next_actions.some((action) => /Verifier assertion evidence/.test(action)));
  assert.match(repair.instruction, /do not promote this as a project-specific rule/);
  assert.doesNotMatch(repair.instruction, /application\/json/);
  assert.doesNotMatch(repair.instruction, /accept: application\/json,text\/plain/);
});

test("buildPlanningSummary keeps async assertion repair guidance generic", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["index.js", "test.js", "index.d.ts", "index.test-d.ts"],
      forbidden_edit_files: ["package.json", "readme.md"],
      required_verifiers: ["node verifier.mjs async-iterable-abort-signal"],
    },
    execution_evidence: [{
      verifier: {
        command: "node verifier.mjs async-iterable-abort-signal",
        passed: false,
        exit_code: 1,
        stderr_tail: [
          "AssertionError [ERR_ASSERTION]: pMapIterable must reject with signal.reason when aborted while mapper work is pending: expected promise to reject",
          "    at expectRejectsWithExactReason (file:///repo/external-verifiers/execution-contracts.mjs:178:10)",
          "    at async verifyAsyncIterableAbortSignal (file:///repo/external-verifiers/execution-contracts.mjs:323:3)",
        ].join("\n"),
      },
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.verifier_failure_phase_v1.phase, "hidden_contract_failure");
  assert.equal(repair.verifier_failure_phase_v1.primary_files[0], "index.js");
  assert.ok(repair.next_actions.some((action) => /Verifier assertion evidence/.test(action)));
  assert.match(repair.instruction, /scoped acceptance evidence/);
  assert.ok(!repair.next_actions.some((action) => /race iterator\/value\/mapper awaits|mapper work is still pending/.test(action)));
});

test("buildPlanningSummary classifies provider failures without turning them into code repair", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["index.js", "test.js"],
      forbidden_edit_files: ["package.json"],
      required_verifiers: ["npm test"],
    },
    execution_evidence: [{
      verifier: {
        command: "npm test",
        passed: false,
        exit_code: 1,
      },
      metrics: {
        llm_api_error_count: 1,
        failure_categories: ["llm_api_error"],
      },
      failed_tool_calls: [{
        tool_name: "read_file",
        output_signature: {
          llm_api_error: "LLM provider returned 429",
        },
      }],
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.verifier_failure_phase_v1.phase, "provider_failure");
  assert.deepEqual(repair.verifier_failure_phase_v1.primary_files, []);
  assert.ok(repair.verifier_failure_phase_v1.allowed_next_actions.includes("request_operator_review"));
  assert.ok(repair.verifier_failure_phase_v1.forbidden_next_actions.includes("persist_learning"));
  assert.match(repair.verifier_failure_phase_v1.recommended_focus, /Do not edit code/);
});

test("buildPlanningSummary classifies LLM tool protocol failures without code repair learning", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["index.js", "test.js"],
      forbidden_edit_files: ["package.json"],
      required_verifiers: ["npm test"],
    },
    execution_evidence: [{
      verifier: {
        command: "npm test",
        passed: false,
        exit_code: 1,
      },
      metrics: {
        llm_protocol_error_count: 3,
        failure_categories: ["llm_protocol_error", "llm_protocol_fatal", "tool_protocol_failure"],
      },
      failed_tool_calls: [{
        tool_name: "llm_protocol",
        output_signature: {
          llm_protocol_exhausted: "LLM did not return a valid tool JSON object after configured protocol retries.",
          failure_phase: "tool_protocol_failure",
        },
      }],
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.verifier_failure_phase_v1.phase, "tool_protocol_failure");
  assert.deepEqual(repair.verifier_failure_phase_v1.primary_files, []);
  assert.ok(repair.verifier_failure_phase_v1.allowed_next_actions.includes("request_operator_review"));
  assert.ok(repair.verifier_failure_phase_v1.forbidden_next_actions.includes("persist_learning"));
  assert.match(repair.verifier_failure_phase_v1.recommended_focus, /protocol/i);
  assert.doesNotMatch(repair.verifier_failure_phase_v1.recommended_focus, /index\.js|test\.js/);
});

test("buildPlanningSummary classifies stale replace_lines anchors as edit failure phase", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["index.js", "test.js"],
      forbidden_edit_files: ["package.json"],
      required_verifiers: ["npm test"],
    },
    execution_evidence: [{
      verifier: {
        command: "npm test",
        passed: false,
        exit_code: 1,
      },
      failed_tool_calls: [{
        tool_name: "replace_lines",
        tool_input: {
          path: "index.js",
          start_line: 20,
          end_line: 24,
        },
        output_signature: {
          expected_old_lines_match: false,
          error: "replace_lines expected_old_lines did not match current file content",
          edit_operation_next_action: {
            reason: "current anchor required before another write",
            instruction: "Read the target range before retrying replace_lines.",
          },
        },
      }],
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.edit_failure_phase_v1?.phase, "stale_line_anchor");
  assert.equal(repair.edit_failure_phase_v1?.primary_file, "index.js");
  assert.equal(repair.edit_failure_phase_v1?.source_tool, "replace_lines");
  assert.equal(repair.edit_failure_phase_v1?.line_hints[0]?.path, "index.js");
  assert.equal(repair.edit_failure_phase_v1?.line_hints[0]?.line, 20);
  assert.ok(repair.edit_failure_phase_v1?.allowed_next_actions.includes("read_file"));
  assert.ok(repair.edit_failure_phase_v1?.allowed_next_actions.includes("replace_lines"));
  assert.ok(repair.edit_failure_phase_v1?.forbidden_next_actions.includes("reuse_stale_anchor"));
  assert.match(repair.edit_failure_phase_v1?.recommended_focus ?? "", /index\.js:20/);
  assert.match(repair.edit_failure_phase_v1?.recommended_focus ?? "", /latest read_file output/);
  assert.ok(repair.next_actions[0]?.startsWith("Use edit_failure_phase_v1 as evidence focus"));
});

test("buildPlanningSummary classifies unchanged edit failures as non-repeatable edit phase", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["index.js", "test.js"],
      forbidden_edit_files: ["package.json"],
      required_verifiers: ["npm test"],
    },
    execution_evidence: [{
      verifier: {
        command: "npm test",
        passed: false,
        exit_code: 1,
      },
      failed_tool_calls: [{
        tool_name: "replace_text",
        tool_input: {
          path: "index.js",
        },
        output_signature: {
          edit_unchanged: true,
          error: "replacement produced no changes",
        },
      }],
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.edit_failure_phase_v1?.phase, "unchanged_edit");
  assert.equal(repair.edit_failure_phase_v1?.source_tool, "replace_text");
  assert.ok(repair.edit_failure_phase_v1?.forbidden_next_actions.includes("repeat_same_edit"));
  assert.match(repair.edit_failure_phase_v1?.recommended_focus ?? "", /meaningful semantic edit/);
  assert.match(repair.edit_failure_phase_v1?.recommended_focus ?? "", /Do not repeat the identical replacement/);
});

test("buildPlanningSummary classifies apply_patch payload failures without project-specific repair rules", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 1, matched: 0 },
    tools: { selection: { selected: "edit" } },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
    edit_boundary_context: {
      allowed_edit_files: ["index.js", "test.js"],
      forbidden_edit_files: ["package.json"],
      required_verifiers: ["npm test"],
    },
    execution_evidence: [{
      verifier: {
        command: "npm test",
        passed: false,
        exit_code: 1,
      },
      failed_tool_calls: [{
        tool_name: "apply_patch",
        output_signature: {
          error: "patch failed: index.js:45 context does not apply",
          edit_operation_next_action: {
            reason: "patch context is stale",
            instruction: "Read current context before retrying.",
          },
        },
      }],
    }],
  });

  const repair = summary.continuity_guidance?.verification_repair_v1;
  assert.ok(repair);
  assert.deepEqual(RuntimeVerificationRepairRecommendationSchema.parse(repair), repair);
  assert.equal(repair.edit_failure_phase_v1?.phase, "apply_patch_payload_failure");
  assert.equal(repair.edit_failure_phase_v1?.source_tool, "apply_patch");
  assert.equal(repair.edit_failure_phase_v1?.primary_file, "index.js");
  assert.equal(repair.edit_failure_phase_v1?.line_hints[0]?.line, 45);
  assert.ok(repair.edit_failure_phase_v1?.forbidden_next_actions.includes("repeat_same_patch"));
  assert.match(repair.edit_failure_phase_v1?.recommended_focus ?? "", /compact replace_lines|small apply_patch hunk/);
  assert.doesNotMatch(repair.edit_failure_phase_v1?.recommended_focus ?? "", /project-specific recipe|literal verifier answer/);
});

test("buildAssemblySummary surfaces semantic forgetting, relocation, and rehydration counts", () => {
  const summary = buildAssemblySummary({
    rules: { considered: 2, matched: 1 },
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_123",
        pattern_summary: {
          skipped_suppressed_pattern_anchor_ids: ["p_stable"],
        },
      },
    },
    layered_context: layeredContextFixture,
    cost_signals: {
      forgotten_items: 1,
      forgotten_by_reason: {
        "stale_context": 1,
      },
      selected_memory_layers: ["L2", "L3"],
      primary_savings_levers: ["anchor_first_recall"],
    },
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "tool_first",
  });

  assert.equal(summary.forgetting_summary.substrate_mode, "forgetting_active");
  assert.equal(summary.forgetting_summary.forgotten_items, 1);
  assert.deepEqual(summary.forgetting_summary.forgotten_by_reason, { stale_context: 1 });
  assert.equal(summary.forgetting_summary.primary_forgetting_reason, "stale_context");
  assert.deepEqual(summary.forgetting_summary.semantic_action_counts, {
    retain: 0,
    demote: 0,
    archive: 1,
    review: 0,
  });
  assert.deepEqual(summary.forgetting_summary.lifecycle_state_counts, {
    active: 0,
    contested: 0,
    retired: 1,
    archived: 0,
  });
  assert.deepEqual(summary.forgetting_summary.archive_relocation_state_counts, {
    none: 0,
    candidate: 0,
    cold_archive: 1,
  });
  assert.deepEqual(summary.forgetting_summary.archive_relocation_target_counts, {
    none: 0,
    local_cold_store: 1,
    external_object_store: 0,
  });
  assert.deepEqual(summary.forgetting_summary.archive_payload_scope_counts, {
    none: 0,
    anchor_payload: 1,
    node: 0,
  });
  assert.deepEqual(summary.forgetting_summary.rehydration_mode_counts, {
    summary_only: 0,
    partial: 2,
    full: 0,
    differential: 1,
  });
  assert.equal(summary.action_retrieval_uncertainty, null);
  assert.equal(summary.action_retrieval_gate, null);
  assert.equal(summary.forgetting_summary.differential_rehydration_candidate_count, 1);
  assert.equal(summary.forgetting_summary.stale_signal_count, 2);
  assert.equal(
    summary.forgetting_summary.recommended_action,
    "rehydrate archived execution memory only when the task proves it still needs the colder payload",
  );
});

test("execution forgetting summary contract rejects passthrough fields", () => {
  const summary = buildAssemblySummary({
    rules: { considered: 1, matched: 0 },
    tools: null,
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "tool_first",
  }).forgetting_summary;

  assert.deepEqual(ExecutionForgettingSummarySchema.parse(summary), summary);
  assert.throws(() =>
    ExecutionForgettingSummarySchema.parse({
      ...summary,
      debug_passthrough: true,
    }),
  );
  assert.throws(() =>
    ExecutionForgettingSummarySchema.parse({
      ...summary,
      semantic_action_counts: {
        ...summary.semantic_action_counts,
        hidden_count: 1,
      },
    }),
  );
  assert.throws(() =>
    ExecutionForgettingSummarySchema.parse({
      ...summary,
      rehydration_mode_counts: {
        ...summary.rehydration_mode_counts,
        speculative: 1,
      },
    }),
  );
});

test("execution summary top-level and child contracts reject passthrough fields", () => {
  const summary = buildExecutionSummarySurface({
    planner_packet: null,
    surface: layeredContextFixture,
    packet_assembly: {
      packet_source_mode: "memory_only",
      state_first_assembly: false,
      execution_packet_v1_present: false,
      execution_state_v1_present: false,
    },
    tools: { selection: { selected: "edit" } },
    cost_signals: null,
    execution_packet: null,
    execution_artifacts: null,
    execution_evidence: null,
    delegation_records: null,
  });

  assert.deepEqual(ExecutionSummaryV1Schema.parse(summary), summary);
  assert.throws(() =>
    ExecutionSummaryV1Schema.parse({
      ...summary,
      debug_passthrough: true,
    }),
  );

  const strictContracts = [
    [ExecutionPacketAssemblySummarySchema, summary.packet_assembly],
    [ExecutionStrategySummarySchema, summary.strategy_summary],
    [ExecutionCollaborationSummarySchema, summary.collaboration_summary],
    [ExecutionContinuitySnapshotSummarySchema, summary.continuity_snapshot_summary],
    [ExecutionCollaborationRoutingSummarySchema, summary.collaboration_routing_summary],
    [ExecutionDelegationRecordsSummarySchema, summary.delegation_records_summary],
    [ExecutionRoutingSignalSummarySchema, summary.routing_signal_summary],
    [ExecutionMaintenanceSummarySchema, summary.maintenance_summary],
    [ExecutionInstrumentationSummarySchema, summary.instrumentation_summary],
  ] as const;

  for (const [schema, contract] of strictContracts) {
    assert.deepEqual(schema.parse(contract), contract);
    assert.throws(() =>
      schema.parse({
        ...contract,
        debug_passthrough: true,
      }),
    );
  }

  const delegationSummary = summary.delegation_records_summary;
  const packetRecord = delegationSummary.delegation_packets[0];
  assert.ok(packetRecord);
  assert.throws(() =>
    ExecutionDelegationRecordsSummarySchema.parse({
      ...delegationSummary,
      delegation_packets: [{
        ...packetRecord,
        debug_passthrough: true,
      }],
    }),
  );

  const returnRecord = {
    version: 1 as const,
    role: "patch",
    status: "completed",
    summary: "Patch completed",
    evidence: ["test output"],
    working_set: ["src/routes/example.ts"],
    acceptance_checks: ["npm test"],
    source_mode: delegationSummary.record_mode,
  };
  assert.deepEqual(
    ExecutionDelegationRecordsSummarySchema.parse({
      ...delegationSummary,
      return_count: 1,
      delegation_returns: [returnRecord],
    }).delegation_returns[0],
    returnRecord,
  );
  assert.throws(() =>
    ExecutionDelegationRecordsSummarySchema.parse({
      ...delegationSummary,
      return_count: 1,
      delegation_returns: [{
        ...returnRecord,
        debug_passthrough: true,
      }],
    }),
  );

  const artifactRecord = delegationSummary.artifact_routing_records[0] ?? {
    version: 1 as const,
    ref: "artifact://example",
    ref_kind: "artifact" as const,
    route_role: delegationSummary.route_role,
    route_intent: "handoff",
    route_mode: delegationSummary.record_mode,
    task_family: null,
    family_scope: "unknown",
    routing_reason: "strategy_summary",
    source: "strategy_summary" as const,
  };
  assert.throws(() =>
    ExecutionDelegationRecordsSummarySchema.parse({
      ...delegationSummary,
      artifact_routing_count: 1,
      artifact_routing_records: [{
        ...artifactRecord,
        debug_passthrough: true,
      }],
    }),
  );
});

test("buildAssemblySummary carries pattern trust summary through from planning summary", () => {
  const summary = buildAssemblySummary({
    rules: { considered: 3, matched: 1 },
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_123",
        pattern_summary: {
          used_trusted_pattern_tools: ["edit"],
          skipped_contested_pattern_tools: ["bash"],
        },
      },
    },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 420,
    context_compaction_profile: "aggressive",
    optimization_profile: "aggressive",
    recall_mode: "balanced",
    include_rules: true,
  });
  assert.equal(summary.trusted_pattern_count, 1);
  assert.equal(summary.contested_pattern_count, 1);
  assert.deepEqual(summary.trusted_pattern_tools, ["edit"]);
  assert.deepEqual(summary.contested_pattern_tools, ["bash"]);
  assert.equal(summary.workflow_lifecycle_summary.candidate_count, 1);
  assert.equal(summary.workflow_lifecycle_summary.stable_count, 1);
  assert.equal(summary.workflow_lifecycle_summary.transition_counts.candidate_observed, 1);
  assert.equal(summary.workflow_lifecycle_summary.transition_counts.promoted_to_stable, 1);
  assert.equal(summary.workflow_maintenance_summary.observe_count, 1);
  assert.equal(summary.workflow_maintenance_summary.retain_count, 1);
  assert.equal(summary.workflow_maintenance_summary.promote_candidate_count, 1);
  assert.equal(summary.workflow_maintenance_summary.retain_workflow_count, 1);
  assert.equal(summary.workflow_signal_summary.stable_workflow_count, 1);
  assert.equal(summary.workflow_signal_summary.observing_workflow_count, 1);
  assert.equal(summary.workflow_signal_summary.promotion_ready_workflow_count, 0);
  assert.equal(summary.pattern_lifecycle_summary.trusted_count, 1);
  assert.equal(summary.pattern_lifecycle_summary.contested_count, 1);
  assert.equal(summary.pattern_maintenance_summary.retain_count, 1);
  assert.equal(summary.pattern_maintenance_summary.review_count, 1);
  assert.equal(summary.action_packet_summary.supporting_knowledge_count, 1);
  assert.deepEqual(summary.action_packet_summary.rehydration_anchor_ids, ["wf_123"]);
  assert.equal(
    summary.planner_explanation,
    "workflow guidance: Recover workflow validation failure; candidate workflows visible but not yet promoted: Replay Episode: Recover workflow validation failure; selected tool: edit; trusted pattern support: edit; contested patterns visible but not trusted: bash; rehydration available: Recover workflow validation failure; supporting knowledge appended: 1",
  );
});

test("buildPlanningSummary explains packet state even when no trusted pattern was consumed", () => {
  const summary = buildPlanningSummary({
    rules: { considered: 2, matched: 0 },
    tools: {
      selection: { selected: "bash" },
      decision: {
        decision_id: "d_456",
      },
    },
    layered_context: layeredContextFixture,
    cost_signals: null,
    context_est_tokens: 256,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
  });
  assert.equal(
    summary.planner_explanation,
    "workflow guidance: Recover workflow validation failure; candidate workflows visible but not yet promoted: Replay Episode: Recover workflow validation failure; selected tool: bash; trusted patterns available but not used: edit; contested patterns visible but not trusted: bash; rehydration available: Recover workflow validation failure; supporting knowledge appended: 1",
  );
});

test("buildPlanningSummary surfaces promotion-ready workflow candidates ahead of generic candidate wording", () => {
  const readyFixture = structuredClone(layeredContextFixture);
  const candidateWorkflow = (readyFixture.action_recall_packet.candidate_workflows as any[])[0];
  candidateWorkflow.observed_count = 2;
  const summary = buildPlanningSummary({
    rules: { considered: 2, matched: 1 },
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_ready",
        pattern_summary: {
          used_trusted_pattern_tools: ["edit"],
          skipped_contested_pattern_tools: ["bash"],
        },
      },
    },
    layered_context: readyFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
  });
  assert.equal(summary.workflow_lifecycle_summary.promotion_ready_count, 1);
  assert.deepEqual(summary.workflow_signal_summary, {
    stable_workflow_count: 1,
    promotion_ready_workflow_count: 1,
    observing_workflow_count: 0,
    stable_workflow_titles: ["Recover workflow validation failure"],
    promotion_ready_workflow_titles: ["Replay Episode: Recover workflow validation failure"],
    observing_workflow_titles: [],
  });
  assert.equal(
    summary.planner_explanation,
    "workflow guidance: Recover workflow validation failure; promotion-ready workflow candidates: Replay Episode: Recover workflow validation failure; selected tool: edit; trusted pattern support: edit; contested patterns visible but not trusted: bash; rehydration available: Recover workflow validation failure; supporting knowledge appended: 1",
  );
});

test("buildPlanningSummary does not count failed-authority candidates as promotion-ready", () => {
  const blockedFixture = structuredClone(layeredContextFixture);
  const candidateWorkflow = (blockedFixture.action_recall_packet.candidate_workflows as any[])[0];
  candidateWorkflow.observed_count = 2;
  candidateWorkflow.promotion_ready = true;
  candidateWorkflow.authority_visibility = {
    surface_version: "runtime_authority_visibility_v1",
    node_id: "wf_candidate_1",
    node_kind: "workflow",
    title: "Replay Episode: Recover workflow validation failure",
    requested_trust: "advisory",
    effective_trust: "advisory",
    status: "insufficient",
    allows_authoritative: false,
    allows_stable_promotion: false,
    authority_blocked: false,
    stable_promotion_blocked: true,
    primary_blocker: "execution_evidence:after_exit_revalidation_failed",
    authority_reasons: ["execution_evidence:after_exit_revalidation_failed"],
    outcome_contract_reasons: [],
    execution_evidence_reasons: ["after_exit_revalidation_failed"],
    execution_evidence_status: "failed",
    false_confidence_detected: true,
  };
  const workflowSignal = (blockedFixture.workflow_signals as any[])[1];
  workflowSignal.observed_count = 2;
  workflowSignal.promotion_ready = true;
  workflowSignal.authority_visibility = candidateWorkflow.authority_visibility;

  const summary = buildPlanningSummary({
    rules: { considered: 2, matched: 1 },
    tools: {
      selection: { selected: "edit" },
      decision: {
        decision_id: "d_blocked_ready",
        pattern_summary: {
          used_trusted_pattern_tools: ["edit"],
          skipped_contested_pattern_tools: ["bash"],
        },
      },
    },
    layered_context: blockedFixture,
    cost_signals: null,
    context_est_tokens: 320,
    context_compaction_profile: "balanced",
    optimization_profile: "balanced",
    recall_mode: "balanced",
  });

  assert.equal(summary.workflow_lifecycle_summary.promotion_ready_count, 0);
  assert.equal(summary.workflow_maintenance_summary.promote_candidate_count, 0);
  assert.deepEqual(summary.workflow_signal_summary, {
    stable_workflow_count: 1,
    promotion_ready_workflow_count: 0,
    observing_workflow_count: 1,
    stable_workflow_titles: ["Recover workflow validation failure"],
    promotion_ready_workflow_titles: [],
    observing_workflow_titles: ["Replay Episode: Recover workflow validation failure"],
  });
  assert.equal(
    summary.planner_explanation,
    "workflow guidance: Recover workflow validation failure; candidate workflows visible but not yet promoted: Replay Episode: Recover workflow validation failure; selected tool: edit; trusted pattern support: edit; contested patterns visible but not trusted: bash; rehydration available: Recover workflow validation failure; supporting knowledge appended: 1; execution evidence failed: 1",
  );
});
