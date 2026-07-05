import test from "node:test";
import assert from "node:assert/strict";
import {
  AionisAgentFlightRecorderReportSchema,
  AionisAgentContextSchema,
  AionisEffectReportSchema,
  AionisExternalMemoryCandidateSchema,
  AionisGuidePacketSchema,
  AionisLearningPacketSchema,
  AionisMemoryAdmissionRecordSchema,
  AionisMemoryDecisionAuditReportSchema,
  AionisMemoryDecisionTraceSchema,
  AionisMemoryFirewallSummarySchema,
  AionisMemoryUseReceiptSchema,
  AionisMemoryPacketSchema,
  AionisOperatorSnapshotSchema,
  AionisProcedureMemoryDraftV1Schema,
} from "../../src/memory/product-output-contract.ts";

function validGuidePacket() {
  return {
    contract_version: "aionis_guide_packet_v1",
    tenant_id: "tenant-local",
    scope: "repo-a",
    actor: {
      consumer_agent_id: "agent-b",
      producer_agent_ids: ["agent-a"],
    },
    task: {
      task_id: "task-1",
      run_id: "run-2",
      task_signature: "fix-build",
      task_family: "coding",
    },
    guide_brief: {
      summary: "Relevant history exists, but authority, stale-memory, or contradiction risk requires inspection before reuse.",
      history_used: true,
      actionable_history_used: true,
      recommended_posture: "inspect_before_use",
      authority: "advisory",
      use_now: [
        "Recovered state: Previous run found the failing file and verifier command.",
      ],
      inspect_before_use: [
        "Candidate workflow: line-local verifier repair",
        "workflow candidate is not promoted",
      ],
      do_not_use: [
        "Suppressed memory: mem-2",
      ],
      rehydrate: [
        {
          memory_id: "mem-3",
          reason: "Archived payload may contain the old verifier output.",
          required: false,
        },
      ],
      expected_product_effects: {
        reduces_repeated_discovery: true,
        reduces_context_replay: true,
        controls_negative_transfer: true,
        reason: "Guide includes recovered targets or workflow evidence that can reduce repeated discovery.",
      },
    },
    recovered_state: {
      state_summary: "Previous run found the failing file and verifier command.",
      resumable: true,
      handoff_ids: ["handoff-1"],
      execution_state_revision: 2,
      target_files: ["src/index.ts"],
      acceptance_checks: ["npm test"],
    },
    proven_facts: [
      {
        fact: "The verifier failed before the patch was applied.",
        source: "verifier",
        evidence_id: "ev-1",
        confidence: 0.92,
      },
    ],
    guidance: {
      workflow_candidates: [
        {
          workflow_id: "wf-1",
          title: "line-local verifier repair",
          authority: "candidate",
          evidence_count: 2,
          last_outcome: "mixed",
          reuse_reason: "Similar verifier phase evidence exists but is not stable.",
        },
      ],
      tool_preferences: [
        {
          tool: "shell",
          preference: "inspect_first",
          authority: "advisory",
          reason: "Prior evidence is incomplete.",
        },
      ],
    },
    memory_lifecycle: {
      used_memory_ids: ["mem-1"],
      suppressed_memory_ids: ["mem-2"],
      archived_memory_ids: [],
      rehydration_hints: [
        {
          memory_id: "mem-3",
          reason: "Archived payload may contain the old verifier output.",
          required: false,
        },
      ],
    },
    history_contributions: {
      handoff: {
        used: true,
        source_count: 1,
        source_ids: ["handoff-1"],
        changed_fields: ["recovered_state"],
        reason: "Recovered state came from a stored handoff.",
      },
      replay: {
        used: true,
        source_count: 1,
        source_ids: ["replay-1"],
        changed_fields: ["guidance.workflow_candidates"],
        reason: "Replay playbook contributed a workflow candidate.",
      },
    },
    risk: {
      negative_transfer_risk: "medium",
      blocked_authority_count: 1,
      stale_memory_count: 1,
      provider_or_protocol_quarantine: false,
      reasons: ["workflow candidate is not promoted"],
    },
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
      internal_surfaces_used: ["action_retrieval"],
      omitted_internal_surfaces: ["raw_find", "replay_repair"],
    },
  };
}

function validEffectReport() {
  return {
    contract_version: "aionis_effect_report_v1",
    tenant_id: "tenant-local",
    scope: "repo-a",
    task: {
      task_id: "task-1",
      run_id: "run-2",
      task_signature: "fix-build",
      task_family: "coding",
    },
    comparison: {
      mode: "baseline_vs_aionis",
      baseline_run_id: "run-base",
      aionis_run_id: "run-aionis",
      sufficient_evidence: true,
    },
    history_impact: {
      changed_future_behavior: true,
      impact_direction: "positive",
      changed_fields: ["guidance.workflow_candidates", "memory_lifecycle.suppressed_memory_ids"],
      explanation: "Aionis skipped repeated discovery and suppressed stale memory.",
    },
    efficiency: {
      repeated_discovery_delta: -3,
      useful_continuity_delta: -2,
      token_delta: -850,
      context_size_delta: -1200,
      recovery_step_delta: -1,
    },
    quality: {
      verifier_outcome: "pass",
      recovered_fact_accuracy: "positive",
      workflow_reuse_outcome: "success",
      negative_transfer_detected: false,
    },
    history_contributions: {
      handoff: {
        used: true,
        source_count: 1,
        source_ids: ["handoff-1"],
        changed_fields: ["recovered_state"],
        reason: "Recovered state was used successfully.",
      },
      replay: {
        used: true,
        source_count: 1,
        source_ids: ["replay-1"],
        changed_fields: ["learning_effect.workflow_reuse"],
        reason: "Replay workflow reuse improved the assisted run.",
      },
    },
    learning_effect: {
      promoted_workflow_ids: ["wf-2"],
      candidate_workflow_ids: ["wf-1"],
      demoted_memory_ids: ["mem-2"],
      blocked_authority_ids: ["auth-1"],
      promotion_denied_reasons: ["candidate lacked holdout evidence"],
    },
    forgetting_effect: {
      suppressed_memory_ids: ["mem-2"],
      archived_memory_ids: ["mem-4"],
      rehydrated_memory_ids: ["mem-3"],
      stale_memory_filtered_count: 2,
    },
    feedback_signal_summary: {
      present: true,
      source: "memory_decision_audit",
      authority_mutation: false,
      positive_attributed_memory_ids: ["mem-1"],
      weak_counter_signal_memory_ids: ["mem-2"],
      strong_counter_signal_memory_ids: [],
      repeated_unattributed_memory_ids: ["mem-3"],
      repeated_unattributed_without_positive_memory_ids: ["mem-3"],
      read_only_signal_memory_ids: ["mem-1", "mem-2", "mem-3"],
      explanation: "Feedback signals were summarized from the memory decision audit.",
    },
    training_candidates: [
      {
        candidate_type: "handoff_distillation",
        source_ids: ["handoff-1", "run-aionis"],
        label: "positive",
        export_ready: true,
        reason: "Recovered state was used successfully without old chat.",
      },
    ],
    evidence: {
      evidence_ids: ["ev-1"],
      replay_run_ids: ["replay-1"],
      signal_summary_ids: ["sig-1"],
      promotion_quality_summary_ids: ["pqs-1"],
    },
  };
}

function validAgentContext() {
  return {
    contract_version: "aionis_agent_context_v1",
    tenant_id: "tenant-local",
    scope: "repo-a",
    agent_role: "reviewer",
    prompt_text: "AIONIS_AGENT_CONTEXT v1\nstate: role=reviewer history=yes actionable_history=yes posture=inspect_before_use authority=advisory risk=medium\nrole_focus: review branch status, continue the active passed path, and keep failed branches as counter-evidence\nsummary: Use recovered execution context.",
    summary: "Use recovered execution context.",
    history_used: true,
    actionable_history_used: true,
    recommended_posture: "inspect_before_use",
    authority: "advisory",
    target_files: ["src/index.ts"],
    use_now: ["Relevant target files: src/index.ts"],
    inspect_before_use: ["Candidate workflow: line-local verifier repair"],
    do_not_use: ["Suppressed memory: mem-2"],
    memory_ids: ["mem-1", "mem-3"],
    use_now_memory_ids: ["mem-1"],
    inspect_before_use_memory_ids: ["mem-3"],
    do_not_use_memory_ids: ["mem-2"],
    command_posture: [
      {
        posture: "should_continue",
        surface: "current",
        memory_id: "mem-1",
        instruction: "Continue the current active state.",
        reason: "Memory passed lifecycle and authority gates.",
        target_files: ["src/index.ts"],
      },
      {
        posture: "must_not",
        surface: "do_not_use",
        memory_id: "mem-2",
        instruction: "Do not reuse this memory.",
        reason: "Memory is suppressed.",
        target_files: [],
      },
    ],
    route_contract: {
      active_targets: [
        {
          target: "src/index.ts",
          source_memory_id: "mem-1",
          source: "should_continue",
          artifact_status: "may_be_absent",
          missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
          reason: "Continue the current active state.",
        },
      ],
      pending_artifacts: [
        {
          target: "src/index.ts",
          source_memory_id: "mem-1",
          source: "should_continue",
          status: "unknown_until_host_observation",
          when: "if_active_target_is_missing",
          allowed_actions: ["create", "restore", "rehydrate", "report_conflict"],
          preferred_action_order: ["create", "restore", "rehydrate", "report_conflict"],
          terminal_inspect_allowed: false,
          reason: "If the active route target is absent, restore or create it before falling back.",
        },
      ],
      reference_only_targets: [],
      blocked_direction_targets: [],
      evidence_sources: [
        {
          target: "src/reference.ts",
          source_memory_id: "mem-3",
          source: "inspect_first",
        },
      ],
      blocked_routes: [
        {
          target: "src/legacy.ts",
          source_memory_id: "mem-2",
          source: "must_not",
        },
      ],
      fallback_policy: "do_not_promote_reference_or_blocked_targets",
      action_policy: {
        missing_active_target_preferred_order: ["create", "restore", "rehydrate", "report_conflict"],
        terminal_inspect_allowed: false,
        reference_fallback_requires: "explicit_raw_evidence_or_operator_confirmation",
      },
    },
    rehydrate_hints: [{
      memory_id: "mem-3",
      reason: "Archived payload may contain the old verifier output.",
      required: false,
    }],
    risk: {
      negative_transfer_risk: "medium",
      blocked_authority_count: 1,
      stale_memory_count: 1,
      reasons: ["workflow candidate is not promoted"],
    },
    evidence_refs: {
      memory_ids: ["mem-1", "mem-3"],
      workflow_ids: ["wf-1"],
      evidence_count: 3,
    },
  };
}

function validMemoryPacket() {
  return {
    contract_version: "aionis_memory_packet_v1",
    tenant_id: "tenant-local",
    scope: "repo-a",
    actor: {
      consumer_agent_id: "agent-b",
      consumer_team_id: "team-a",
      producer_agent_ids: ["agent-a"],
    },
    query: {
      source: "text",
      intent: "answer with remembered project preferences",
      embedding_dims: 1536,
    },
    memory_family: "general_cognitive",
    relevant_memories: [
      {
        memory_id: "mem-pref-1",
        title: "User prefers direct answers",
        summary: "The user prefers direct, factual answers before detail.",
        memory_type: "preference",
        domain: "general",
        source_layer: "L2",
        authority: "advisory",
        confidence: 0.86,
        salience: 0.77,
        lifecycle_state: "active",
        evidence_ids: ["commit-1"],
        scope_hint: "general cognitive memory; apply inside the current tenant and scope",
      },
    ],
    evidence_trail: [
      {
        evidence_id: "memory_node:mem-pref-1",
        memory_id: "mem-pref-1",
        source: "node",
        relation: "direct_match",
        reason: "Retrieved memory node contributed to the cognitive memory packet.",
      },
    ],
    lifecycle: {
      used_memory_ids: ["mem-pref-1"],
      candidate_memory_ids: [],
      suppressed_memory_ids: [],
      archived_memory_ids: [],
      rehydration_hints: [],
    },
    contradiction_warnings: [],
    forgetting_state: {
      stale_memory_count: 0,
      suppressed_count: 0,
      archived_count: 0,
      rehydration_candidate_count: 0,
    },
    behavior_impact: {
      will_shape_behavior: true,
      changed_fields: ["relevant_memories", "behavior_impact.expected_effects"],
      expected_effects: ["answer_style"],
      explanation: "Recall produced evidence-scoped memories that can shape future behavior without granting source-code authority.",
    },
    risk: {
      negative_transfer_risk: "low",
      contradiction_count: 0,
      low_confidence_count: 0,
      stale_memory_count: 0,
      reasons: [],
    },
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
      internal_surfaces_used: ["recall_ranked_nodes"],
      omitted_internal_surfaces: ["raw_embedding_vectors", "raw_slots", "full_payloads"],
    },
  };
}

function validLearningPacket() {
  return {
    contract_version: "aionis_learning_packet_v1",
    tenant_id: "tenant-local",
    scope: "repo-a",
    actor: {
      consumer_agent_id: "agent-b",
      consumer_team_id: "team-a",
      producer_agent_ids: ["agent-a"],
    },
    task: {
      task_id: "task-1",
      run_id: "run-2",
      task_signature: "fix-build",
      task_family: "coding",
    },
    posture: {
      recommended_learning_posture: "candidate_only",
      authority: "candidate",
      source_code_change_allowed: false,
      stable_promotion_allowed: false,
      reason: "Candidate evidence is visible but not promotion-ready.",
    },
    candidates: [
      {
        candidate_id: "wf-candidate-1",
        kind: "workflow",
        authority: "candidate",
        evidence_count: 1,
        promotion_state: "candidate",
        source_ids: ["wf-candidate-1"],
        reason: "Workflow candidate needs more evidence before stable reuse.",
      },
    ],
    learning_control: {
      contract_trust: "advisory",
      action_start_blocked: false,
      authoritative_allowed_count: 1,
      authoritative_blocked_count: 0,
      stable_promotion_allowed_count: 0,
      stable_promotion_blocked_count: 1,
      blocked_reasons: ["candidate lacks holdout evidence"],
    },
    lifecycle_effect: {
      promoted_workflow_count: 0,
      candidate_workflow_count: 1,
      trusted_pattern_count: 1,
      contested_pattern_count: 0,
      active_policy_count: 1,
      contested_policy_count: 0,
      suppressed_memory_ids: ["mem-suppressed-1"],
      demote_count: 0,
      archive_count: 0,
      review_count: 1,
    },
    evidence: {
      workflow_anchor_ids: ["wf-stable-1"],
      candidate_workflow_anchor_ids: ["wf-candidate-1"],
      trusted_pattern_anchor_ids: ["pat-trusted-1"],
      candidate_pattern_anchor_ids: [],
      contested_pattern_anchor_ids: [],
      promotion_denied_reasons: ["candidate lacks holdout evidence"],
    },
    export_readiness: {
      training_export_ready: false,
      positive_transfer_required: true,
      reason: "EffectReport evidence is required before export.",
    },
    source_map: {
      routes_used: ["/v1/memory/context/assemble"],
      internal_surfaces_used: ["history_impact_summary.learning"],
      omitted_internal_surfaces: ["raw_slots", "task_specific_repair_content"],
    },
  };
}

function validMemoryDecisionTrace() {
  return {
    contract_version: "aionis_memory_decision_trace_v1",
    tenant_id: "tenant-local",
    scope: "repo-a",
    intended_use: "measure_debug_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    input: {
      before_guide_present: true,
      after_guide_present: true,
      memory_packet_present: true,
      guide_packet_present: true,
      agent_context_present: true,
      forget_result_present: false,
    },
    summary: {
      total_memory_count: 1,
      direct_use_count: 1,
      inspect_before_use_count: 0,
      do_not_use_count: 0,
      rehydrate_count: 0,
      relation_count: 0,
      contradiction_warning_count: 0,
      feedback_attribution_count: 0,
      feedback_threshold_met_count: 0,
      unattributed_recalled_memory_count: 2,
      prompt_char_count: 81,
      history_used: true,
      actionable_history_used: true,
      recommended_posture: "inspect_before_use",
      authority: "advisory",
      negative_transfer_risk: "medium",
      learning_control_visible: true,
    },
    memory_decisions: [
      {
        memory_id: "mem-pref-1",
        title: "User prefers direct answers",
        domain: "general",
        memory_type: "preference",
        lifecycle_state: "active",
        authority: "advisory",
        agent_surface: "use_now",
        decision_kind: "used",
        reason_codes: ["lifecycle_active", "authority_advisory", "available_for_agent_use"],
        evidence_ids: ["commit-1"],
        used_detail: {
          authority: "advisory",
          confidence: 0.86,
          salience: 0.77,
          source_layer: "L2",
          not_superseded: true,
        },
        downgraded_detail: null,
        blocked_detail: null,
        feedback_detail: null,
        rehydrate_detail: null,
      },
    ],
    relation_decisions: [],
    feedback_attribution: {
      present: false,
      guide_trace_id: null,
      run_id: null,
      outcome: null,
      used_surface: null,
      verifier_status: null,
      tool_status: null,
      runtime_signal_refs: [],
      affected_memory_ids: [],
      exposed_memory_count: 0,
      attributed_memory_count: 0,
      unattributed_recalled_memory_count: 2,
      attributed_memory_ids: [],
      unattributed_recalled_memory_ids: ["mem-1", "mem-3"],
      unattributed_use_now_memory_ids: [],
      unattributed_inspect_before_use_memory_ids: [],
      unattributed_do_not_use_memory_ids: [],
      unattributed_rehydrate_memory_ids: [],
      unused_exposure_observation: {
        present: false,
        contract_version: null,
        mode: null,
        exposure_threshold: 0,
        guide_trace_count: 0,
        tracked_memory_count: 0,
        repeated_unattributed_memory_ids: [],
        repeated_unattributed_without_positive_memory_ids: [],
        memory_stats: [],
        reason: "No guide exposure observation was supplied for this trace.",
      },
      sparse_feedback_signal_summary: {
        present: false,
        mode: null,
        authority_mutation: false,
        positive_attributed_memory_ids: [],
        weak_counter_signal_memory_ids: [],
        strong_counter_signal_memory_ids: [],
        repeated_unattributed_memory_ids: [],
        repeated_unattributed_without_positive_memory_ids: [],
        read_only_signal_memory_ids: [],
        reason: "No activate feedback or unused exposure signal was supplied for this trace.",
      },
      weak_counter_signal_memory_ids: [],
      strong_counter_signal_memory_ids: [],
      threshold_met_memory_ids: [],
      reason: "No activate feedback attribution was supplied for this trace.",
    },
    context_decision: {
      prompt_char_count: 81,
      target_files: ["src/index.ts"],
      use_now_count: 1,
      inspect_before_use_count: 1,
      do_not_use_count: 1,
      rehydrate_hint_count: 1,
      actionable_history_used: true,
      memory_ids: ["mem-1", "mem-3"],
    },
    memory_use_receipt: {
      contract_version: "aionis_memory_use_receipt_v1",
      intended_use: "memory_use_audit",
      agent_prompt_included: false,
      runtime_mutation: false,
      guide_trace_id: null,
      history_used: true,
      actionable_history_used: true,
      prompt_char_count: 81,
      exposed_memory_ids: ["mem-1", "mem-3", "mem-pref-1"],
      use_now_memory_ids: ["mem-pref-1"],
      inspect_before_use_memory_ids: [],
      do_not_use_memory_ids: [],
      rehydrate_memory_ids: [],
      attributed_memory_ids: [],
      unattributed_recalled_memory_ids: ["mem-1", "mem-3"],
      read_only_signal_memory_ids: [],
      decision_summaries: [
        {
          memory_id: "mem-pref-1",
          agent_surface: "use_now",
          decision_kind: "used",
          actionable: true,
          reason_codes: ["memory_contract_direct_use", "available_for_agent_use"],
        },
        {
          memory_id: "mem-3",
          agent_surface: "inspect_before_use",
          decision_kind: "downgraded",
          actionable: false,
          reason_codes: ["memory_contract_inspect_before_use", "kept_out_of_direct_use"],
        },
      ],
      risk_flags: ["negative_transfer_risk:medium"],
      summary: "Aionis compiled memory decisions into a read-only memory use receipt.",
    },
    admission_record: {
      contract_version: "aionis_memory_admission_record_v1",
      intended_use: "memory_admission_audit_dataset",
      source: "memory_decision_trace",
      agent_prompt_included: false,
      runtime_mutation: false,
      tenant_id: "tenant-local",
      scope: "repo-a",
      guide_trace_id: null,
      prompt_char_count: 81,
      history_used: true,
      actionable_history_used: true,
      candidate_memory_count: 1,
      prompt_included_memory_count: 1,
      agent_used_memory_count: 0,
      entries: [
        {
          memory_id: "mem-pref-1",
          title: "User prefers direct answers",
          domain: "general",
          memory_type: "preference",
          lifecycle_state: "active",
          authority: "advisory",
          admission_action: "use_now",
          decision_kind: "used",
          actionable: true,
          prompt_included: true,
          agent_used: false,
          feedback_outcome: null,
          attribution_strength: null,
          reason_codes: ["lifecycle_active", "authority_advisory", "available_for_agent_use"],
          evidence_ids: ["commit-1"],
        },
      ],
      summary: "Aionis recorded memory admission decisions for dataset export.",
    },
    forget_decisions: [],
    source_map: {
      routes_used: ["/v1/measure"],
      internal_surfaces_used: ["memory_decision_trace"],
      omitted_internal_surfaces: ["raw_memory_rows", "raw_slots"],
    },
  };
}

function validMemoryDecisionAuditReport() {
  return {
    contract_version: "aionis_memory_decision_audit_report_v1",
    tenant_id: "tenant-local",
    scope: "repo-a",
    intended_use: "operator_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    verdict: "learning_control_visible",
    claims: [
      {
        claim: "agent_prompt_excluded",
        status: "pass",
        evidence: "Trace is returned on audit surfaces, not embedded in prompt.",
      },
      {
        claim: "runtime_state_unchanged",
        status: "pass",
        evidence: "Trace is read-only.",
      },
      {
        claim: "feedback_attribution_visible",
        status: "not_applicable",
        evidence: "No activate feedback attribution was supplied for this trace.",
      },
    ],
    counters: {
      total_memory_count: 1,
      controlled_memory_count: 1,
      relation_count: 0,
      feedback_attribution_count: 0,
      feedback_threshold_met_count: 0,
      prompt_char_count: 81,
    },
    risks: {
      negative_transfer_risk: "medium",
      unresolved_inspection_count: 1,
      blocked_or_suppressed_count: 0,
      reasons: ["candidate memory requires inspection"],
    },
    feedback_signal_review: {
      present: false,
      mode: null,
      authority_mutation: false,
      positive_attributed_memories: [],
      weak_counter_signal_memories: [],
      strong_counter_signal_memories: [],
      repeated_unattributed_memories: [],
      repeated_unattributed_without_positive_memories: [],
      read_only_signal_memory_ids: [],
      reason: "No activate feedback or unused exposure signal was supplied for this trace.",
    },
    decision_reviews: {
      used_memories: [
        {
          memory_id: "mem-pref-1",
          title: "User prefers direct answers",
          authority: "advisory",
          confidence: 0.86,
          salience: 0.77,
          source_layer: "L2",
          evidence_ids: ["commit-1"],
          reason: "Memory entered direct use because it has usable authority and no accepted lifecycle relation superseded it.",
        },
      ],
      downgraded_memories: [],
      blocked_memories: [],
      rehydrate_memories: [],
    },
    source_map: {
      routes_used: ["/v1/audit/memory-decision-report"],
      internal_surfaces_used: ["memory_decision_audit_report"],
      omitted_internal_surfaces: ["raw_memory_rows", "raw_slots"],
    },
  };
}

test("AionisMemoryPacket accepts evidence-scoped general cognitive memory output", () => {
  const parsed = AionisMemoryPacketSchema.parse(validMemoryPacket());
  assert.equal(parsed.contract_version, "aionis_memory_packet_v1");
  assert.equal(parsed.memory_family, "general_cognitive");
  assert.equal(parsed.relevant_memories[0]?.memory_type, "preference");
  assert.equal(parsed.relevant_memories[0]?.authority, "advisory");
  assert.equal(parsed.relevant_memories[0]?.memory_contract.use_policy, "direct_use");
  assert.equal(parsed.relevant_memories[0]?.memory_contract.source_trust, "scoped_advisory");
  assert.deepEqual(parsed.behavior_impact.expected_effects, ["answer_style"]);
});

test("AionisMemoryPacket accepts strict execution-state memory projection", () => {
  const packet: any = validMemoryPacket();
  packet.memory_family = "execution";
  packet.relevant_memories[0] = {
    ...packet.relevant_memories[0],
    memory_id: "mem-exec-1",
    title: "Reviewer handoff current state",
    summary: "Reviewer should continue the passed branch and avoid the rejected path.",
    memory_type: "execution_memory",
    domain: "execution",
    target_files: ["src/runtime.ts"],
    execution_state: {
      summary_kind: "current_state",
      execution_kind: "execution_native",
      task_signature: "runtime-handoff",
      workflow_signature: "planner-worker-reviewer",
      next_action_hint: "Continue the passed branch.",
      transition_kind: "handoff_to_actor",
      actor_role: "worker",
      handoff_target: "reviewer",
      source_agent_id: "worker-1",
      source_team_id: "runtime-team",
    },
  };

  const parsed = AionisMemoryPacketSchema.parse(packet);
  assert.equal(parsed.memory_family, "execution");
  assert.equal(parsed.relevant_memories[0]?.execution_state?.summary_kind, "current_state");
  assert.equal(parsed.relevant_memories[0]?.execution_state?.next_action_hint, "Continue the passed branch.");
  assert.equal(parsed.relevant_memories[0]?.execution_state?.transition_kind, "handoff_to_actor");

  assert.throws(
    () =>
      AionisMemoryPacketSchema.parse({
        ...packet,
        relevant_memories: [{
          ...packet.relevant_memories[0],
          execution_state: {
            ...packet.relevant_memories[0].execution_state,
            raw_trace: "must stay out of product output",
          },
        }],
      }),
    /Unrecognized key/,
  );
});

test("AionisMemoryPacket rejects raw memory leakage and loose fields", () => {
  assert.throws(
    () =>
      AionisMemoryPacketSchema.parse({
        ...validMemoryPacket(),
        raw_chat_transcript: "do not expose full user transcript",
      }),
    /Unrecognized key/,
  );

  const packet = validMemoryPacket();
  assert.throws(
    () =>
      AionisMemoryPacketSchema.parse({
        ...packet,
        raw_embedding: [0.1, 0.2],
      }),
    /Unrecognized key/,
  );
});

test("AionisGuidePacket accepts compact authority-aware product output", () => {
  const parsed = AionisGuidePacketSchema.parse(validGuidePacket());
  assert.equal(parsed.contract_version, "aionis_guide_packet_v1");
  assert.equal(parsed.memory_lifecycle.suppressed_memory_ids.length, 1);
  assert.equal(parsed.guide_brief.recommended_posture, "inspect_before_use");
  assert.equal(parsed.guide_brief.expected_product_effects.controls_negative_transfer, true);
  assert.equal(parsed.history_contributions.handoff.used, true);
  assert.equal(parsed.history_contributions.replay.source_count, 1);
  assert.ok(parsed.source_map.omitted_internal_surfaces.includes("replay_repair"));
});

test("AionisGuidePacket rejects raw product leakage and loose fields", () => {
  assert.throws(
    () =>
      AionisGuidePacketSchema.parse({
        ...validGuidePacket(),
        raw_chat_transcript: "full transcript should not be a product output",
      }),
    /Unrecognized key/,
  );

  const guide = validGuidePacket();
  assert.throws(
    () =>
      AionisGuidePacketSchema.parse({
        ...guide,
        guidance: {
          ...guide.guidance,
          semantic_patch: "do not put task patches in guide packet",
        },
      }),
    /Unrecognized key/,
  );
});

test("AionisAgentContext accepts compact agent-facing output", () => {
  const parsed = AionisAgentContextSchema.parse(validAgentContext());
  assert.equal(parsed.contract_version, "aionis_agent_context_v1");
  assert.equal(parsed.history_used, true);
  assert.equal(parsed.actionable_history_used, true);
  assert.equal(parsed.agent_role, "reviewer");
  assert.equal(parsed.agent_context_mode, "standard");
  assert.equal(parsed.task_context_profile, "general");
  assert.equal(parsed.authority, "advisory");
  assert.deepEqual(parsed.target_files, ["src/index.ts"]);
  assert.deepEqual(parsed.use_now_memory_ids, ["mem-1"]);
  assert.deepEqual(parsed.inspect_before_use_memory_ids, ["mem-3"]);
  assert.deepEqual(parsed.do_not_use_memory_ids, ["mem-2"]);
  assert.deepEqual(parsed.command_posture.map((entry) => entry.posture), ["should_continue", "must_not"]);
  assert.deepEqual(parsed.route_contract.active_targets.map((entry) => entry.target), ["src/index.ts"]);
  assert.equal(parsed.route_contract.pending_artifacts[0]?.when, "if_active_target_is_missing");
  assert.deepEqual(parsed.route_contract.pending_artifacts[0]?.allowed_actions, ["create", "restore", "rehydrate", "report_conflict"]);
  assert.deepEqual(parsed.route_contract.pending_artifacts[0]?.preferred_action_order, ["create", "restore", "rehydrate", "report_conflict"]);
  assert.equal(parsed.route_contract.pending_artifacts[0]?.terminal_inspect_allowed, false);
  assert.equal(parsed.route_contract.pending_artifacts[0]?.executable_evidence_policy, "route_safe_but_patch_may_require_rehydrate");
  assert.equal(parsed.route_contract.pending_artifacts[0]?.after_rehydrate_policy, "continue_allowed_action_if_task_consistent");
  assert.equal(parsed.route_contract.pending_artifacts[0]?.report_conflict_requires, "rehydrate_unavailable_or_evidence_conflict");
  assert.deepEqual(parsed.route_contract.evidence_sources, [
    {
      target: "src/reference.ts",
      source_memory_id: "mem-3",
      source: "inspect_first",
      evidence_use: "reference_only",
      direction_policy: "must_not_be_primary_route",
    },
  ]);
  assert.deepEqual(parsed.route_contract.blocked_routes, [
    {
      target: "src/legacy.ts",
      source_memory_id: "mem-2",
      source: "must_not",
      direction_policy: "blocked_route",
      evidence_use: "counter_evidence_only",
    },
  ]);
  assert.equal(parsed.route_contract.conflict_policy, "do_not_treat_missing_active_target_as_superseded");
  assert.equal(parsed.route_contract.fallback_policy, "do_not_promote_reference_or_blocked_targets");
  assert.deepEqual(parsed.route_contract.action_policy.missing_active_target_preferred_order, ["create", "restore", "rehydrate", "report_conflict"]);
  assert.equal(parsed.route_contract.action_policy.terminal_inspect_allowed, false);
  assert.equal(parsed.route_contract.action_policy.reference_fallback_requires, "explicit_raw_evidence_or_operator_confirmation");
  assert.equal(parsed.route_contract.action_policy.executable_evidence_policy, "route_safe_but_patch_may_require_rehydrate");
  assert.equal(parsed.route_contract.action_policy.after_rehydrate_policy, "continue_allowed_action_if_task_consistent");
  assert.equal(parsed.route_contract.action_policy.report_conflict_requires, "rehydrate_unavailable_or_evidence_conflict");
  assert.equal(parsed.risk.negative_transfer_risk, "medium");

  const compactParsed = AionisAgentContextSchema.parse({
    ...validAgentContext(),
    agent_context_mode: "compact_agent",
    prompt_text: "AIONIS_CTX compact_agent\nstate r=reviewer h=1 a=1 p=inspect auth=adv risk=med\navoid: note=Suppressed memory",
  });
  assert.equal(compactParsed.agent_context_mode, "compact_agent");
  assert.equal(compactParsed.prompt_text.includes("AIONIS_CTX compact_agent"), true);

  const legacyParsed = AionisAgentContextSchema.parse({
    ...validAgentContext(),
    command_posture: undefined,
  });
  assert.deepEqual(legacyParsed.command_posture, []);

  const defaultRouteParsed = AionisAgentContextSchema.parse({
    ...validAgentContext(),
    route_contract: undefined,
  });
  assert.deepEqual(defaultRouteParsed.route_contract.active_targets, []);
  assert.deepEqual(defaultRouteParsed.route_contract.evidence_sources, []);
  assert.deepEqual(defaultRouteParsed.route_contract.blocked_routes, []);
  assert.equal(defaultRouteParsed.route_contract.conflict_policy, "do_not_treat_missing_active_target_as_superseded");
  assert.deepEqual(defaultRouteParsed.route_contract.action_policy.missing_active_target_preferred_order, ["create", "restore", "rehydrate", "report_conflict"]);
  assert.equal(defaultRouteParsed.route_contract.action_policy.after_rehydrate_policy, "continue_allowed_action_if_task_consistent");
});

test("AionisAgentContext rejects packet leakage and loose fields", () => {
  assert.throws(
    () =>
      AionisAgentContextSchema.parse({
        ...validAgentContext(),
        memory_packet: validMemoryPacket(),
      }),
    /Unrecognized key/,
  );

  assert.throws(
    () =>
      AionisAgentContextSchema.parse({
        ...validAgentContext(),
        guide_packet: validGuidePacket(),
      }),
    /Unrecognized key/,
  );
});

test("AionisLearningPacket accepts scoped learning state without promotion overclaim", () => {
  const parsed = AionisLearningPacketSchema.parse(validLearningPacket());
  assert.equal(parsed.contract_version, "aionis_learning_packet_v1");
  assert.equal(parsed.posture.recommended_learning_posture, "candidate_only");
  assert.equal(parsed.posture.source_code_change_allowed, false);
  assert.equal(parsed.export_readiness.training_export_ready, false);
  assert.equal(parsed.export_readiness.positive_transfer_required, true);
  assert.equal(parsed.candidates[0]?.kind, "workflow");
});

test("AionisLearningPacket rejects task-specific patches and source-code authority", () => {
  assert.throws(
    () =>
      AionisLearningPacketSchema.parse({
        ...validLearningPacket(),
        semantic_patch: "change src/index.ts line 10",
      }),
    /Unrecognized key/,
  );

  const packet = validLearningPacket();
  assert.throws(
    () =>
      AionisLearningPacketSchema.parse({
        ...packet,
        posture: {
          ...packet.posture,
          source_code_change_allowed: true,
        },
      }),
  );
});

test("AionisEffectReport accepts measured positive impact and training candidates", () => {
  const parsed = AionisEffectReportSchema.parse(validEffectReport());
  assert.equal(parsed.contract_version, "aionis_effect_report_v1");
  assert.equal(parsed.history_impact.impact_direction, "positive");
  assert.equal(parsed.history_contributions.handoff.used, true);
  assert.equal(parsed.history_contributions.replay.used, true);
  assert.equal(parsed.feedback_signal_summary.present, true);
  assert.equal(parsed.feedback_signal_summary.authority_mutation, false);
  assert.deepEqual(parsed.feedback_signal_summary.read_only_signal_memory_ids, ["mem-1", "mem-2", "mem-3"]);
  assert.equal(parsed.confidence_decay_summary.present, false);
  assert.equal(parsed.confidence_decay_summary.authority_mutation, false);
  assert.equal(parsed.confidence_decay_summary.time_decay_age_threshold_days, 0);
  assert.deepEqual(parsed.confidence_decay_summary.candidate_from_time_decay_memory_ids, []);
  assert.equal(parsed.training_candidates[0]?.candidate_type, "handoff_distillation");
});

test("AionisEffectReport validates trace-derived skill training candidates", () => {
  const parsed = AionisEffectReportSchema.parse({
    ...validEffectReport(),
    training_candidates: [
      {
        candidate_type: "trace_derived_skill",
        source_ids: ["effect_kernel:continuity", "run:run-aionis"],
        label: "positive",
        export_ready: true,
        reason: "Positive continuity evidence produced a governed trace-derived skill candidate.",
        trace_derived_skill: {
          contract_version: "aionis_trace_derived_skill_candidate_v1",
          skill_name: "Continue verified execution state across sessions",
          source_trace_ids: ["effect_kernel:continuity", "run:run-aionis"],
          source_signal_ids: ["continuity_guidance_matches_expected"],
          applies_when: ["task_family:coding", "future_session_needs_verified_continuation"],
          does_not_apply_when: ["No validation evidence is available for the source trace."],
          procedure_steps: [
            "Recover the current Aionis guide before continuing the task.",
            "Run the recorded acceptance checks before treating the continuation as reusable.",
          ],
          target_files: ["src/runtime.ts"],
          acceptance_checks: ["npm test passed"],
          failure_counterexamples: ["legacy route failed verifier"],
          evidence_refs: ["ev-1"],
          authority_state: "candidate",
          promotion_status: "promotion_ready",
          export_policy: {
            agent_prompt_included: false,
            runtime_mutation: false,
            required_gate: "admission_and_promotion_gate",
          },
        },
      },
    ],
  });

  const candidate = parsed.training_candidates[0];
  assert.equal(candidate?.candidate_type, "trace_derived_skill");
  assert.equal(candidate?.trace_derived_skill?.authority_state, "candidate");
  assert.equal(candidate?.trace_derived_skill?.export_policy.agent_prompt_included, false);

  assert.throws(
    () =>
      AionisEffectReportSchema.parse({
        ...validEffectReport(),
        training_candidates: [
          {
            candidate_type: "trace_derived_skill",
            source_ids: ["effect_kernel:continuity"],
            label: "positive",
            export_ready: true,
            reason: "Missing payload should be rejected.",
          },
        ],
      }),
    /trace_derived_skill payload is required/,
  );
});

test("AionisProcedureMemoryDraftV1 validates explicit observe-commit policy", () => {
  const parsed = AionisProcedureMemoryDraftV1Schema.parse({
    contract_version: "aionis_procedure_memory_draft_v1",
    source_candidate_id: "skillcand_123",
    source: "trace_derived_skill",
    memory_kind: "procedure",
    authority_state: "reviewed_candidate",
    skill_name: "Continue verified execution state across sessions",
    title: "Trace-derived procedure: Continue verified execution state",
    summary: "Apply only after the host accepts the reviewed trace-derived procedure draft.",
    source_trace_ids: ["trace-1"],
    source_signal_ids: ["signal-1"],
    applies_when: ["future session needs verified continuation"],
    does_not_apply_when: ["source trace evidence is absent"],
    procedure_steps: [
      "Recover the current Aionis guide before continuing the task.",
      "Run recorded acceptance checks before treating the continuation as reusable.",
    ],
    target_files: ["src/runtime.ts"],
    acceptance_checks: ["npm test passed"],
    failure_counterexamples: ["legacy route failed verifier"],
    evidence_refs: ["ev-1"],
    review: {
      review_status: "promoted",
      reviewer_id: "operator-1",
      review_reason: "Evidence is narrow and verifier-backed.",
      reviewed_at: "2026-07-05T00:00:00.000Z",
      candidate_reason: "Positive continuity evidence produced a governed trace-derived skill candidate.",
      label: "positive",
      promotion_status: "promotion_ready",
      export_ready: true,
    },
    write_policy: {
      requires_observe_commit: true,
      agent_prompt_included: false,
      runtime_mutation: false,
      required_gate: "observe_commit_and_admission_gate",
    },
  });

  assert.equal(parsed.contract_version, "aionis_procedure_memory_draft_v1");
  assert.equal(parsed.write_policy.requires_observe_commit, true);
  assert.equal(parsed.write_policy.runtime_mutation, false);

  assert.throws(
    () =>
      AionisProcedureMemoryDraftV1Schema.parse({
        ...parsed,
        write_policy: {
          ...parsed.write_policy,
          runtime_mutation: true,
        },
      }),
    /Invalid literal value/,
  );
});

test("AionisEffectReport can honestly report insufficient evidence", () => {
  const report = validEffectReport();
  const parsed = AionisEffectReportSchema.parse({
    ...report,
    comparison: {
      mode: "single_run_history_impact",
      sufficient_evidence: false,
    },
    history_impact: {
      changed_future_behavior: false,
      impact_direction: "insufficient_evidence",
      changed_fields: [],
      explanation: "No baseline or observe-only control was available.",
    },
    quality: {
      verifier_outcome: "unknown",
      negative_transfer_detected: false,
    },
    training_candidates: [
      {
        candidate_type: "transfer_judge",
        source_ids: ["run-aionis"],
        label: "insufficient_evidence",
        export_ready: false,
        reason: "No comparison arm exists.",
      },
    ],
  });

  assert.equal(parsed.comparison.sufficient_evidence, false);
  assert.equal(parsed.history_impact.impact_direction, "insufficient_evidence");
  assert.equal(parsed.training_candidates[0]?.export_ready, false);
});

test("AionisEffectReport rejects unverified broad claims", () => {
  assert.throws(
    () =>
      AionisEffectReportSchema.parse({
        ...validEffectReport(),
        investor_claim: "Aionis improves all issue success rates",
      }),
    /Unrecognized key/,
  );
});

test("AionisMemoryDecisionTrace accepts read-only measure/debug/audit output", () => {
  const parsed = AionisMemoryDecisionTraceSchema.parse(validMemoryDecisionTrace());
  assert.equal(parsed.contract_version, "aionis_memory_decision_trace_v1");
  assert.equal(parsed.intended_use, "measure_debug_audit");
  assert.equal(parsed.agent_prompt_included, false);
  assert.equal(parsed.runtime_mutation, false);
  assert.equal(parsed.memory_use_receipt?.contract_version, "aionis_memory_use_receipt_v1");
  assert.equal(parsed.memory_use_receipt?.agent_prompt_included, false);
  assert.equal(parsed.memory_use_receipt?.runtime_mutation, false);
  assert.deepEqual(parsed.memory_use_receipt?.use_now_memory_ids, ["mem-pref-1"]);
  assert.deepEqual(parsed.memory_use_receipt?.unattributed_recalled_memory_ids, ["mem-1", "mem-3"]);
  assert.equal(parsed.admission_record?.contract_version, "aionis_memory_admission_record_v1");
  assert.equal(parsed.admission_record?.agent_prompt_included, false);
  assert.equal(parsed.admission_record?.runtime_mutation, false);
  assert.equal(parsed.admission_record?.entries[0]?.admission_action, "use_now");
  assert.equal(parsed.admission_record?.entries[0]?.prompt_included, true);
  assert.equal(parsed.admission_record?.entries[0]?.agent_used, false);
  assert.equal(parsed.memory_decisions[0]?.agent_surface, "use_now");
  assert.equal(parsed.memory_decisions[0]?.feedback_detail, null);
  assert.equal(parsed.feedback_attribution.present, false);
  assert.equal(parsed.summary.feedback_attribution_count, 0);
  assert.equal(parsed.confidence_decay_candidate_summary.present, false);
  assert.equal(parsed.confidence_decay_candidate_summary.authority_mutation, false);
  assert.equal(parsed.confidence_decay_candidate_summary.agent_prompt_included, false);
  assert.equal(parsed.confidence_decay_candidate_summary.time_decay_age_threshold_days, 0);
  assert.deepEqual(parsed.confidence_decay_candidate_summary.candidate_from_time_decay_memory_ids, []);
  assert.deepEqual(parsed.confidence_decay_candidate_summary.time_decay_candidate_details, []);
  assert.equal(parsed.inspect_before_use_shadow_delta.present, false);
  assert.equal(parsed.inspect_before_use_shadow_delta.enabled, false);
  assert.equal(parsed.inspect_before_use_shadow_delta.authority_mutation, false);
  assert.equal(parsed.inspect_before_use_shadow_delta.agent_prompt_included, false);
  assert.deepEqual(parsed.inspect_before_use_shadow_delta.would_move_to_inspect_before_use_memory_ids, []);
});

test("AionisMemoryAdmissionRecord accepts read-only admission dataset rows", () => {
  const parsed = AionisMemoryAdmissionRecordSchema.parse(validMemoryDecisionTrace().admission_record);
  assert.equal(parsed.contract_version, "aionis_memory_admission_record_v1");
  assert.equal(parsed.intended_use, "memory_admission_audit_dataset");
  assert.equal(parsed.source, "memory_decision_trace");
  assert.equal(parsed.agent_prompt_included, false);
  assert.equal(parsed.runtime_mutation, false);
  assert.equal(parsed.entries[0]?.memory_id, "mem-pref-1");
  assert.equal(parsed.entries[0]?.memory_origin, "aionis");
  assert.equal(parsed.entries[0]?.source_backend, "aionis");
  assert.equal(parsed.entries[0]?.admission_action, "use_now");
});

test("AionisExternalMemoryCandidate defaults to inspectable unknown authority", () => {
  const parsed = AionisExternalMemoryCandidateSchema.parse({
    external_memory_id: "mem0:checkout-route",
    source_backend: "mem0",
    text: "Legacy route using fullBundleEnvironment.ts failed verification.",
  });
  assert.equal(parsed.external_memory_id, "mem0:checkout-route");
  assert.equal(parsed.source_backend, "mem0");
  assert.deepEqual(parsed.metadata, {});
  assert.equal(parsed.authority.source_trust, "unknown");
  assert.equal(parsed.authority.scope, "unknown");
  assert.equal(parsed.authority.evidence_requirement, "inspect_before_use");
  assert.equal(parsed.lifecycle_hint, "unknown");
  assert.deepEqual(parsed.evidence_refs, []);

  assert.throws(
    () => AionisExternalMemoryCandidateSchema.parse({
      external_memory_id: "",
      source_backend: "mem0",
      text: "invalid",
    }),
    /String must contain at least 1 character/,
  );
});

test("AionisMemoryAdmissionRecord accepts external candidate admission source", () => {
  const parsed = AionisMemoryAdmissionRecordSchema.parse({
    contract_version: "aionis_memory_admission_record_v1",
    intended_use: "memory_admission_audit_dataset",
    source: "external_candidate_admission",
    agent_prompt_included: false,
    runtime_mutation: false,
    tenant_id: "default",
    scope: "default",
    guide_trace_id: "external-admission:run-1",
    prompt_char_count: 512,
    history_used: true,
    actionable_history_used: false,
    candidate_memory_count: 1,
    prompt_included_memory_count: 1,
    agent_used_memory_count: 0,
    entries: [
      {
        memory_id: "mem0:failed-route",
        title: "Failed route",
        memory_origin: "external",
        source_backend: "mem0",
        domain: "execution",
        memory_type: "execution_memory",
        lifecycle_state: "contested",
        authority: "advisory",
        admission_action: "inspect_before_use",
        decision_kind: "downgraded",
        actionable: false,
        prompt_included: true,
        agent_used: false,
        feedback_outcome: null,
        attribution_strength: null,
        reason_codes: ["external_candidate_admission"],
        evidence_ids: ["ci-log:123"],
      },
    ],
    summary: "External memory was external without Runtime mutation.",
  });
  assert.equal(parsed.source, "external_candidate_admission");
  assert.equal(parsed.entries[0]?.memory_origin, "external");
  assert.equal(parsed.entries[0]?.source_backend, "mem0");
  assert.equal(parsed.entries[0]?.admission_action, "inspect_before_use");
});

test("AionisMemoryFirewallSummary captures unsafe direct-use and read-only claims", () => {
  const parsed = AionisMemoryFirewallSummarySchema.parse({
    contract_version: "aionis_memory_firewall_summary_v1",
    intended_use: "memory_firewall_audit",
    mode: "firewall",
    candidate_count: 4,
    direct_use_count: 1,
    inspect_count: 1,
    blocked_count: 1,
    rehydrate_count: 1,
    unsafe_candidate_count: 1,
    unsafe_direct_use_count: 0,
    runtime_mutation: false,
    agent_prompt_included: false,
    risk_flags: ["unsafe_candidate_count:1", "blocked_count:1"],
    claims: [
      {
        claim: "Unsafe lifecycle candidates cannot enter direct use.",
        status: "pass",
        evidence: "0/1 unsafe candidates entered use_now.",
      },
    ],
    summary: "Memory Firewall routed external candidates without unsafe direct-use.",
  });

  assert.equal(parsed.contract_version, "aionis_memory_firewall_summary_v1");
  assert.equal(parsed.runtime_mutation, false);
  assert.equal(parsed.agent_prompt_included, false);
  assert.equal(parsed.unsafe_direct_use_count, 0);
  assert.equal(parsed.claims[0]?.status, "pass");
});

test("AionisMemoryDecisionTrace rejects prompt injection and runtime mutation claims", () => {
  assert.throws(
    () =>
      AionisMemoryDecisionTraceSchema.parse({
        ...validMemoryDecisionTrace(),
        agent_prompt_included: true,
      }),
  );

  assert.throws(
    () =>
      AionisMemoryDecisionTraceSchema.parse({
        ...validMemoryDecisionTrace(),
        runtime_mutation: true,
      }),
  );

  assert.throws(
    () =>
      AionisMemoryDecisionTraceSchema.parse({
        ...validMemoryDecisionTrace(),
        memory_use_receipt: {
          ...validMemoryDecisionTrace().memory_use_receipt,
          agent_prompt_included: true,
        },
      }),
  );

  assert.throws(
    () =>
      AionisMemoryDecisionTraceSchema.parse({
        ...validMemoryDecisionTrace(),
        confidence_decay_candidate_summary: {
          present: true,
          contract_version: "aionis_confidence_decay_candidate_summary_v1",
          mode: "shadow_candidate",
          authority_mutation: true,
          agent_prompt_included: false,
          time_decay_age_threshold_days: 90,
          decay_candidate_memory_ids: ["mem-1"],
          candidate_from_learning_control_memory_ids: ["mem-1"],
          candidate_from_time_decay_memory_ids: [],
          supported_by_neighborhood_drift_memory_ids: [],
          drift_only_observation_memory_ids: [],
          blocked_by_positive_attribution_memory_ids: [],
          blocked_by_recent_validation_memory_ids: [],
          time_decay_candidate_details: [],
          reason: "Invalid mutation claim.",
        },
      }),
  );

  assert.throws(
    () =>
      AionisMemoryDecisionTraceSchema.parse({
        ...validMemoryDecisionTrace(),
        inspect_before_use_shadow_delta: {
          present: true,
          contract_version: "aionis_inspect_before_use_shadow_delta_v1",
          mode: "disabled_preview",
          enabled: true,
          authority_mutation: false,
          agent_prompt_included: false,
          simulated_surface: "inspect_before_use",
          candidate_memory_ids: ["mem-1"],
          would_move_to_inspect_before_use_memory_ids: ["mem-1"],
          already_inspect_before_use_memory_ids: [],
          blocked_by_positive_attribution_memory_ids: [],
          blocked_by_recent_validation_memory_ids: [],
          drift_only_observation_memory_ids: [],
          entries: [],
          reason: "Invalid enabled claim.",
        },
      }),
  );

  assert.throws(
    () =>
      AionisMemoryDecisionTraceSchema.parse({
        ...validMemoryDecisionTrace(),
        inspect_before_use_shadow_delta: {
          present: true,
          contract_version: "aionis_inspect_before_use_shadow_delta_v1",
          mode: "disabled_preview",
          enabled: false,
          authority_mutation: true,
          agent_prompt_included: false,
          simulated_surface: "inspect_before_use",
          candidate_memory_ids: ["mem-1"],
          would_move_to_inspect_before_use_memory_ids: ["mem-1"],
          already_inspect_before_use_memory_ids: [],
          blocked_by_positive_attribution_memory_ids: [],
          blocked_by_recent_validation_memory_ids: [],
          drift_only_observation_memory_ids: [],
          entries: [],
          reason: "Invalid mutation claim.",
        },
      }),
  );
});

test("AionisMemoryUseReceipt accepts only read-only memory usage audit fields", () => {
  const parsed = AionisMemoryUseReceiptSchema.parse(validMemoryDecisionTrace().memory_use_receipt);
  assert.equal(parsed.contract_version, "aionis_memory_use_receipt_v1");
  assert.equal(parsed.intended_use, "memory_use_audit");
  assert.equal(parsed.agent_prompt_included, false);
  assert.equal(parsed.runtime_mutation, false);
  assert.equal(parsed.decision_summaries[0]?.memory_id, "mem-pref-1");
  assert.equal(parsed.decision_summaries[0]?.agent_surface, "use_now");
  assert.equal(parsed.decision_summaries[0]?.decision_kind, "used");
  assert.equal(parsed.decision_summaries[0]?.actionable, true);

  assert.throws(
    () =>
      AionisMemoryUseReceiptSchema.parse({
        ...validMemoryDecisionTrace().memory_use_receipt,
        runtime_mutation: true,
      }),
  );
});

test("AionisOperatorSnapshot accepts trace-to-procedure as a read-only product projection", () => {
  const parsed = AionisOperatorSnapshotSchema.parse({
    contract_version: "aionis_operator_snapshot_v1",
    tenant_id: "tenant-local",
    scope: "repo-a",
    intended_use: "operator_snapshot",
    agent_prompt_included: false,
    runtime_mutation: false,
    task: {
      run_id: "run-2",
      task_signature: "fix-build",
      task_family: "coding",
      workflow_signature: "line-local-verifier",
      agent_role: "reviewer",
    },
    execution_state: {
      history_used: true,
      actionable_history_used: true,
      recommended_posture: "inspect_before_use",
      authority: "advisory",
      active_path: {
        count: 1,
        entries: [{
          entry_id: "active-1",
          title: "Continue scoped verifier repair",
          summary: "Continue the scoped verifier branch.",
          source: "execution_context",
          memory_ids: ["mem-exec-1"],
          evidence_refs: ["trace://run-2/active"],
        }],
      },
      passed_solutions: { count: 0, entries: [] },
      failed_branches: { count: 0, entries: [] },
      branch_isolation: {
        active_path_visible: true,
        passed_solution_visible: false,
        failed_branch_visible_in_do_not_use: false,
        failed_branch_leaked_to_use_now: false,
        status: "not_applicable",
        reason: "No failed branch evidence was supplied.",
      },
    },
    trace_to_procedure: {
      present: true,
      runtime_mutation: false,
      source_surfaces: ["execution_tree", "workflow_projection", "execution_contract", "promotion_evidence"],
      procedure_memory_ids: ["mem-exec-1"],
      workflow_ids: ["wf-1"],
      evidence_refs: ["trace://run-2/active", "pqs-1"],
      candidate_visible: true,
      stable_reuse_visible: false,
      promotion_status: "blocked",
      promotion_blocked_count: 1,
      reason: "Procedure evidence is visible, but stable promotion remains blocked.",
    },
    guide_trace: {
      present: true,
      guide_trace_id: "guide_trace:run-2",
      exposed_memory_ids: ["mem-exec-1"],
      use_now_memory_ids: [],
      inspect_before_use_memory_ids: ["mem-exec-1"],
      do_not_use_memory_ids: [],
      attributed_memory_ids: [],
      unattributed_memory_ids: [],
      feedback_attribution_present: false,
      feedback_outcome: null,
      reason: "Guide trace exists, but feedback attribution was not supplied.",
    },
    memory_use_receipt: validMemoryDecisionTrace().memory_use_receipt,
    memory_lifecycle: {
      used_count: 0,
      inspect_before_use_count: 1,
      do_not_use_count: 0,
      rehydrate_count: 0,
      controlled_memory_count: 1,
      blocked_or_suppressed_count: 0,
      stale_memory_count: 0,
      learning_control_visible: true,
      consolidation_guard: {
        supporting_only_count: 0,
        candidate_only_count: 1,
        promotion_blocked_count: 1,
        reason: "Candidate memory stayed outside stable direct-use authority.",
      },
    },
    learning_control: {
      visible: true,
      runtime_mutation: false,
      stable_promotion_allowed: false,
      candidate_count: 1,
      blocked_authority_count: 0,
      promotion_denied_reasons: ["candidate lacked holdout evidence"],
      reason: "Learning-control state is visible without granting runtime mutation authority.",
    },
    effect: {
      present: false,
      impact_direction: null,
      changed_future_behavior: null,
      token_delta: null,
      context_size_delta: null,
      repeated_discovery_delta: null,
      reason: "No effect report was supplied.",
    },
    claims: [{
      claim: "trace_to_procedure_visible",
      status: "pass",
      evidence: "Trace-to-procedure projection is visible.",
    }],
    risks: {
      negative_transfer_risk: "medium",
      blocked_or_suppressed_count: 0,
      unresolved_inspection_count: 1,
      reasons: ["candidate memory requires inspection"],
    },
    source_map: {
      routes_used: ["/v1/operator/snapshot"],
      internal_surfaces_used: ["operator_snapshot", "trace_to_procedure_projection"],
      omitted_internal_surfaces: ["raw_memory_rows", "raw_slots"],
    },
  });

  assert.equal(parsed.trace_to_procedure.runtime_mutation, false);
  assert.equal(parsed.trace_to_procedure.promotion_status, "blocked");
  assert.ok(parsed.trace_to_procedure.source_surfaces.includes("execution_tree"));

  assert.throws(
    () =>
      AionisOperatorSnapshotSchema.parse({
        ...parsed,
        trace_to_procedure: {
          ...parsed.trace_to_procedure,
          runtime_mutation: true,
        },
      }),
  );
});

test("AionisAgentFlightRecorderReport accepts read-only incident replay output", () => {
  const parsed = AionisAgentFlightRecorderReportSchema.parse({
    contract_version: "aionis_agent_flight_recorder_report_v1",
    tenant_id: "tenant-local",
    scope: "repo-a",
    intended_use: "incident_replay_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    guide_trace_id: "guide-trace-1",
    run_id: "run-1",
    decision_time: "2026-06-13T00:00:00.000Z",
    agent_view: {
      history_used: true,
      actionable_history_used: true,
      recommended_posture: "reuse_supported_history",
      authority: "trusted",
      prompt_char_count: 1024,
      prompt_text_included: false,
      exposed_memory_ids: ["mem-current", "mem-failed"],
      use_now_memory_ids: ["mem-current"],
      inspect_before_use_memory_ids: [],
      do_not_use_memory_ids: ["mem-failed"],
      rehydrate_memory_ids: ["mem-archive"],
      target_files: ["src/index.ts"],
    },
    blocked_or_suppressed: [
      {
        memory_id: "mem-failed",
        title: "Failed legacy route",
        lifecycle_state: "suppressed",
        authority: "blocked",
        agent_surface: "do_not_use",
        reason_codes: ["suppressed_lifecycle"],
      },
    ],
    attribution: {
      present: true,
      outcome: "positive",
      used_memory_ids: ["mem-current"],
      attributed_memory_ids: ["mem-current"],
      unattributed_memory_ids: ["mem-failed"],
      supported_memory_ids: ["mem-current"],
      contradicted_memory_ids: [],
      reason: "Feedback was attributed to the current memory.",
    },
    replay_sources: {
      has_agent_context: true,
      has_memory_decision_trace: true,
      has_memory_use_receipt: true,
      has_memory_admission_record: true,
      has_operator_snapshot: true,
      has_feedback_result: true,
    },
    claims: [
      {
        claim: "prompt_payload_excluded",
        status: "pass",
        evidence: "Report includes prompt_char_count but excludes prompt_text.",
      },
    ],
    source_map: {
      routes_used: ["/v1/audit/flight-recorder"],
      internal_surfaces_used: ["agent_flight_recorder", "memory_decision_trace"],
      omitted_internal_surfaces: ["agent_prompt_text", "raw_memory_rows"],
    },
    summary: "Agent Flight Recorder reconstructed memory admission at decision time.",
  });

  assert.equal(parsed.agent_prompt_included, false);
  assert.equal(parsed.runtime_mutation, false);
  assert.equal(parsed.agent_view.prompt_text_included, false);
  assert.deepEqual(parsed.agent_view.use_now_memory_ids, ["mem-current"]);
  assert.equal(parsed.blocked_or_suppressed[0]?.memory_id, "mem-failed");
});

test("AionisMemoryDecisionAuditReport accepts compact operator audit output", () => {
  const parsed = AionisMemoryDecisionAuditReportSchema.parse(validMemoryDecisionAuditReport());
  assert.equal(parsed.contract_version, "aionis_memory_decision_audit_report_v1");
  assert.equal(parsed.intended_use, "operator_audit");
  assert.equal(parsed.agent_prompt_included, false);
  assert.equal(parsed.runtime_mutation, false);
  assert.equal(parsed.verdict, "learning_control_visible");
  assert.equal(parsed.counters.feedback_attribution_count, 0);
  assert.equal(parsed.counters.feedback_threshold_met_count, 0);
  assert.equal(parsed.claims.some((claim) => claim.claim === "feedback_attribution_visible"), true);
  assert.equal(parsed.feedback_signal_review.present, false);
  assert.equal(parsed.feedback_signal_review.authority_mutation, false);
  assert.deepEqual(parsed.feedback_signal_review.read_only_signal_memory_ids, []);
  assert.equal(parsed.confidence_decay_candidate_review.present, false);
  assert.equal(parsed.confidence_decay_candidate_review.authority_mutation, false);
  assert.equal(parsed.confidence_decay_candidate_review.agent_prompt_included, false);
  assert.equal(parsed.confidence_decay_candidate_review.time_decay_age_threshold_days, 0);
  assert.equal(parsed.inspect_before_use_shadow_delta_review.present, false);
  assert.equal(parsed.inspect_before_use_shadow_delta_review.enabled, false);
  assert.equal(parsed.inspect_before_use_shadow_delta_review.authority_mutation, false);
  assert.equal(parsed.inspect_before_use_shadow_delta_review.agent_prompt_included, false);
});
