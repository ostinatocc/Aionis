import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCognitiveStructureV1,
  CognitiveStructureV1Schema,
  type CognitiveEvidenceNode,
} from "../../src/kernel/cognitive-structure.ts";
import {
  adjudicatePolicyMutationV1,
  PolicyMutationV1Schema,
  type PolicyMutationV1,
} from "../../src/kernel/policy-mutation-loop.ts";
import type { ExecutionSummaryV1 } from "../../src/memory/schemas.ts";

function executionSummaryFixture(): ExecutionSummaryV1 {
  return {
    summary_version: "execution_summary_v1",
    planner_packet: null,
    pattern_signals: [],
    workflow_signals: [],
    packet_assembly: {
      packet_source_mode: "packet_backed",
      state_first_assembly: true,
      execution_packet_v1_present: true,
      execution_state_v1_present: true,
    },
    strategy_summary: {
      summary_version: "execution_strategy_summary_v1",
      trust_signal: "evidence_backed",
      strategy_profile: "focused",
      validation_style: "required_verifier",
      task_family: "runtime_contract_repair",
      family_scope: "task_family",
      family_candidate_count: 2,
      selected_working_set: ["src/runtime.ts"],
      selected_validation_paths: ["npm test"],
      selected_pattern_summaries: [],
      preferred_artifact_refs: [],
      explanation: "Use evidence-backed workflow memory.",
    },
    collaboration_summary: {
      summary_version: "execution_collaboration_summary_v1",
      packet_present: true,
      coordination_mode: "single_agent",
      current_stage: "repair",
      active_role: "implementer",
      next_action: "inspect runtime contract",
      target_file_count: 1,
      pending_validation_count: 1,
      unresolved_blocker_count: 1,
      review_contract_present: true,
      review_standard: "required verifier passes",
      acceptance_check_count: 1,
      rollback_required: false,
      resume_anchor_present: true,
      resume_anchor_file_path: "src/runtime.ts",
      resume_anchor_symbol: "runRuntime",
      artifact_ref_count: 0,
      evidence_ref_count: 1,
      side_output_artifact_count: 0,
      side_output_evidence_count: 1,
      artifact_refs: [],
      evidence_refs: ["verifier:required"],
    },
    continuity_snapshot_summary: {
      summary_version: "execution_continuity_snapshot_v1",
      snapshot_mode: "packet_backed",
      coordination_mode: "single_agent",
      trust_signal: "evidence_backed",
      strategy_profile: "focused",
      validation_style: "required_verifier",
      task_family: "runtime_contract_repair",
      family_scope: "task_family",
      selected_tool: "read_file",
      current_stage: "repair",
      active_role: "implementer",
      next_action: "inspect runtime contract",
      working_set: ["src/runtime.ts"],
      validation_paths: ["npm test"],
      selected_pattern_summaries: [],
      preferred_artifact_refs: [],
      preferred_evidence_refs: ["verifier:required"],
      reviewer_ready: true,
      resume_anchor_file_path: "src/runtime.ts",
      selected_memory_layers: ["workflow", "policy"],
      recommended_action: "continue from verified contract evidence",
    },
    routing_signal_summary: {
      summary_version: "execution_routing_summary_v1",
      selected_tool: "read_file",
      task_family: "runtime_contract_repair",
      family_scope: "task_family",
      stable_workflow_anchor_ids: ["wf-stable-1"],
      candidate_workflow_anchor_ids: ["wf-candidate-1"],
      rehydration_anchor_ids: ["rehydrate-1"],
      workflow_source_kinds: ["stable_workflow"],
      same_family_rehydration_anchor_ids: ["rehydrate-1"],
      other_family_rehydration_anchor_ids: [],
      unknown_family_rehydration_anchor_ids: [],
    },
    maintenance_summary: {
      summary_version: "execution_maintenance_summary_v1",
      forgotten_items: 1,
      forgotten_by_reason: { stale_candidate: 1 },
      suppressed_pattern_count: 1,
      stable_workflow_count: 1,
      promotion_ready_workflow_count: 1,
      selected_memory_layers: ["workflow", "policy"],
      primary_savings_levers: ["forgetting"],
      recommended_action: "keep working set narrow",
    },
    forgetting_summary: {
      summary_version: "execution_forgetting_summary_v1",
      substrate_mode: "forgetting_active",
      forgotten_items: 1,
      forgotten_by_reason: { stale_candidate: 1 },
      primary_forgetting_reason: "stale_candidate",
      suppressed_pattern_count: 1,
      suppressed_pattern_anchor_ids: ["pattern-suppressed-1"],
      suppressed_pattern_sources: ["operator_overlay"],
      selected_memory_layers: ["workflow", "policy"],
      semantic_action_counts: { retain: 3, demote: 1, archive: 1, review: 0 },
      lifecycle_state_counts: { active: 2, contested: 1, retired: 1, archived: 1 },
      archive_relocation_state_counts: { none: 3, candidate: 1, cold_archive: 1 },
      archive_relocation_target_counts: { none: 3, local_cold_store: 1, external_object_store: 0 },
      archive_payload_scope_counts: { none: 3, anchor_payload: 1, node: 1 },
      rehydration_mode_counts: { summary_only: 1, partial: 1, full: 0, differential: 1 },
      differential_rehydration_candidate_count: 1,
      primary_savings_levers: ["forgetting"],
      stale_signal_count: 2,
      recommended_action: "avoid stale candidate reuse",
    },
    collaboration_routing_summary: {
      summary_version: "execution_collaboration_routing_v1",
      route_mode: "packet_backed",
      coordination_mode: "single_agent",
      route_intent: "resume",
      task_brief: "repair runtime contract",
      current_stage: "repair",
      active_role: "implementer",
      selected_tool: "read_file",
      task_family: "runtime_contract_repair",
      family_scope: "task_family",
      next_action: "inspect runtime contract",
      target_files: ["src/runtime.ts"],
      validation_paths: ["npm test"],
      unresolved_blockers: ["verifier failing"],
      hard_constraints: ["run required verifier"],
      review_standard: "required verifier passes",
      required_outputs: ["patch"],
      acceptance_checks: ["verifier passes"],
      preferred_artifact_refs: [],
      preferred_evidence_refs: ["verifier:required"],
      routing_drivers: ["execution_packet"],
    },
    delegation_records_summary: {
      summary_version: "execution_delegation_records_v1",
      record_mode: "packet_backed",
      route_role: "implementer",
      packet_count: 0,
      return_count: 0,
      artifact_routing_count: 0,
      missing_record_types: [],
      delegation_packets: [],
      delegation_returns: [],
      artifact_routing_records: [],
    },
    instrumentation_summary: {
      summary_version: "execution_instrumentation_summary_v1",
      task_family: "runtime_contract_repair",
      family_scope: "task_family",
      family_hit: true,
      family_reason: "same task family",
      selected_pattern_hit_count: 1,
      selected_pattern_miss_count: 0,
      rehydration_candidate_count: 1,
      known_family_rehydration_count: 1,
      same_family_rehydration_count: 1,
      other_family_rehydration_count: 0,
      unknown_family_rehydration_count: 0,
      rehydration_family_hit_rate: 1,
      same_family_rehydration_anchor_ids: ["rehydrate-1"],
      other_family_rehydration_anchor_ids: [],
    },
    pattern_signal_summary: {
      candidate_pattern_count: 1,
      candidate_pattern_tools: ["read_file"],
      trusted_pattern_count: 1,
      contested_pattern_count: 1,
      trusted_pattern_tools: ["read_file"],
      contested_pattern_tools: ["replace_text"],
    },
    workflow_signal_summary: {
      stable_workflow_count: 1,
      promotion_ready_workflow_count: 1,
      observing_workflow_count: 1,
      stable_workflow_titles: ["Stable runtime repair workflow"],
      promotion_ready_workflow_titles: ["Promotion-ready runtime workflow"],
      observing_workflow_titles: ["Observed runtime workflow"],
    },
    workflow_lifecycle_summary: {
      candidate_count: 2,
      stable_count: 1,
      replay_source_count: 1,
      rehydration_ready_count: 1,
      promotion_ready_count: 1,
      transition_counts: {
        candidate_observed: 2,
        promoted_to_stable: 1,
        normalized_latest_stable: 0,
      },
    },
    workflow_maintenance_summary: {
      model: "lazy_online_v1",
      observe_count: 2,
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
      stable_promotion_allowed_count: 1,
      stable_promotion_blocked_count: 1,
      execution_evidence_failed_count: 1,
      execution_evidence_incomplete_count: 0,
      false_confidence_count: 0,
      reason_counts: { weak_evidence: 1 },
      top_blockers: ["weak_evidence"],
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
        handoff_continuity_carrier: 0,
        session_event_continuity_carrier: 0,
        session_continuity_carrier: 0,
        replay_learning_episode: 0,
      },
      promotion_target_counts: { workflow: 1, pattern: 0, policy: 0 },
    },
    pattern_lifecycle_summary: {
      candidate_count: 1,
      trusted_count: 1,
      contested_count: 1,
      near_promotion_count: 1,
      counter_evidence_open_count: 1,
      transition_counts: {
        candidate_observed: 1,
        promoted_to_trusted: 1,
        counter_evidence_opened: 1,
        revalidated_to_trusted: 0,
      },
    },
    pattern_maintenance_summary: {
      model: "lazy_online_v1",
      observe_count: 1,
      retain_count: 1,
      review_count: 1,
      promote_candidate_count: 1,
      review_counter_evidence_count: 1,
      retain_trusted_count: 1,
    },
    policy_lifecycle_summary: {
      persisted_count: 2,
      active_count: 1,
      contested_count: 1,
      retired_count: 0,
      default_mode_count: 0,
      hint_mode_count: 2,
      stable_policy_count: 1,
      transition_counts: {
        materialized: 1,
        refreshed: 0,
        contested_by_feedback: 1,
        retired_by_feedback: 0,
        retired_by_learning_control: 0,
        reactivated_by_learning_control: 0,
      },
    },
    policy_maintenance_summary: {
      model: "lazy_online_v1",
      observe_count: 1,
      retain_count: 1,
      review_count: 1,
      promote_to_default_count: 0,
      retain_active_policy_count: 1,
      review_contested_policy_count: 1,
      retire_policy_count: 0,
      reactivate_policy_count: 0,
    },
    continuity_carrier_summary: {
      total_count: 1,
      handoff_count: 1,
      session_event_count: 0,
      session_count: 0,
    },
    action_packet_summary: {
      recommended_workflow_count: 1,
      candidate_workflow_count: 1,
      candidate_pattern_count: 1,
      trusted_pattern_count: 1,
      contested_pattern_count: 1,
      rehydration_candidate_count: 1,
      supporting_knowledge_count: 0,
      workflow_anchor_ids: ["wf-stable-1"],
      candidate_workflow_anchor_ids: ["wf-candidate-1"],
      candidate_pattern_anchor_ids: ["pattern-candidate-1"],
      trusted_pattern_anchor_ids: ["pattern-trusted-1"],
      contested_pattern_anchor_ids: ["pattern-contested-1"],
      rehydration_anchor_ids: ["rehydrate-1"],
    },
  };
}

function admittedPolicyMutation(): PolicyMutationV1 {
  return PolicyMutationV1Schema.parse({
    mutation_version: "policy_mutation_v1",
    mutation_id: "mutation-1",
    stage: "adjudicate",
    target: {
      kind: "workflow_memory",
      target_id: "wf-candidate-1",
      scope: "task_family",
      scope_ref: "runtime_contract_repair",
      memory_key: "workflow:runtime_contract_repair",
    },
    proposed_effect: "active",
    source_event_ref: "run:1",
    evidence: [{
      evidence_id: "ev-pass-1",
      grade: "real_verifier_pass",
      outcome: "success",
      source_ref: "verifier:required",
      verifier_command: "npm test",
      confidence: 0.93,
      claims: ["required verifier passed"],
    }],
    evidence_refs: ["verifier:required"],
    promotion_evidence_refs: [],
    holdout_evidence_refs: [],
    counter_evidence_refs: [],
    confidence: 0.86,
    rationale: "Successful verified workflow can become active scoped memory.",
    expected_effect: "Future runs reuse the verified workflow at task-family scope.",
    escape_conditions: ["next verifier failure contradicts the workflow"],
    rollback_plan: ["return workflow to candidate state"],
    forgetting_plan: ["demote after repeated contradiction"],
    adjudication: {
      decision: "admit",
      reviewer: "learning_control",
      reasons: ["real verifier success"],
      confidence: 0.88,
    },
    source_code_change_allowed: false,
    project_specific_content_destination: "workflow_candidate",
  });
}

test("CognitiveStructureV1 aggregates execution, evidence, workflow, policy, forgetting, and authority state", () => {
  const verifierNode: CognitiveEvidenceNode = {
    evidence_id: "verifier-pass-node",
    kind: "verifier_result",
    grade: "real_verifier_pass",
    outcome: "success",
    source_refs: ["verifier:required"],
    claims: ["required verifier passed"],
    files: ["src/runtime.ts"],
    verifier_command: "npm test",
    confidence: 0.94,
  };
  const structure = buildCognitiveStructureV1({
    tenant_id: "default",
    scope: "default",
    runtime_version: "runtime-test-version",
    generated_at: "2026-05-23T00:00:00.000Z",
    execution_summary: executionSummaryFixture(),
    evidence_nodes: [verifierNode],
    evidence_edges: [{
      from: "verifier-pass-node",
      to: "execution_evidence_ref_1",
      relation: "supports",
      reason: "verifier node supports the execution evidence reference",
    }],
    policy_mutations: [admittedPolicyMutation()],
  });

  assert.deepEqual(CognitiveStructureV1Schema.parse(structure), structure);
  assert.equal(structure.source_code_change_allowed, false);
  assert.equal(structure.execution_state.current_stage, "repair");
  assert.equal(structure.evidence_graph.proven_fact_count, 1);
  assert.equal(structure.workflow_memory.stable_count, 1);
  assert.equal(structure.policy_memory.mutation_count, 1);
  assert.equal(structure.forgetting_state.stale_signal_count, 2);
  assert.equal(structure.authority_state.authoritative_blocked_count, 1);
});

test("PolicyMutationV1 admits scoped successful policy memory changes without source-code authority", () => {
  const mutation = admittedPolicyMutation();
  const adjudication = adjudicatePolicyMutationV1(mutation);

  assert.equal(mutation.source_code_change_allowed, false);
  assert.equal(mutation.target.kind, "workflow_memory");
  assert.equal(adjudication.admissible, true);
  assert.equal(adjudication.next_stage, "apply");
  assert.equal(adjudication.source_code_change_allowed, false);
  assert.ok(adjudication.reasons.includes("policy_mutation_targets_runtime_memory_not_source_code"));
});

test("PolicyMutationV1 rejects failed evidence promoted as stable authority", () => {
  const invalid = {
    ...admittedPolicyMutation(),
    mutation_id: "mutation-failed-stable",
    stage: "promote",
    proposed_effect: "stable",
    evidence: [{
      evidence_id: "ev-fail-1",
      grade: "failed_verifier",
      outcome: "failure",
      source_ref: "verifier:failed",
      verifier_command: "npm test",
      confidence: 0.91,
      claims: ["required verifier failed"],
    }],
    evidence_refs: ["verifier:failed"],
    promotion_evidence_refs: ["verifier:failed"],
  };

  assert.equal(PolicyMutationV1Schema.safeParse(invalid).success, false);
  const adjudication = adjudicatePolicyMutationV1(invalid);
  assert.equal(adjudication.admissible, false);
  assert.equal(adjudication.next_stage, "reject");
  assert.equal(adjudication.blocked_authority, true);
});

test("PolicyMutationV1 rejects source-code targets instead of treating project experience as system code", () => {
  const invalid = {
    ...admittedPolicyMutation(),
    mutation_id: "mutation-source-code",
    target: {
      kind: "source_code",
      target_id: "src/runtime.ts",
      scope: "exact_task",
      scope_ref: "task-1",
      memory_key: "source:runtime",
    },
  };

  const parsed = PolicyMutationV1Schema.safeParse(invalid);
  assert.equal(parsed.success, false);
  const adjudication = adjudicatePolicyMutationV1(invalid);
  assert.equal(adjudication.source_code_change_allowed, false);
  assert.equal(adjudication.next_stage, "reject");
});

test("PolicyMutationV1 requires holdout evidence before global stable authority", () => {
  const invalid = {
    ...admittedPolicyMutation(),
    mutation_id: "mutation-global-stable",
    stage: "promote",
    proposed_effect: "stable",
    target: {
      kind: "policy_memory",
      target_id: "policy-1",
      scope: "global",
      scope_ref: null,
      memory_key: "policy:global",
    },
    promotion_evidence_refs: ["verifier:required"],
    holdout_evidence_refs: [],
  };

  assert.equal(PolicyMutationV1Schema.safeParse(invalid).success, false);
});
