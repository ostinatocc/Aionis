import test from "node:test";
import assert from "node:assert/strict";
import {
  AionisAgentContextSchema,
  AionisEffectReportSchema,
  AionisGuidePacketSchema,
  AionisLearningPacketSchema,
  AionisMemoryDecisionAuditReportSchema,
  AionisMemoryDecisionTraceSchema,
  AionisMemoryPacketSchema,
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
    prompt_text: "AIONIS_AGENT_CONTEXT v1\nsummary: Use recovered execution context.\nauthority: advisory",
    summary: "Use recovered execution context.",
    history_used: true,
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
      memory_ids: ["mem-1", "mem-3"],
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
  assert.deepEqual(parsed.behavior_impact.expected_effects, ["answer_style"]);
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
  assert.equal(parsed.authority, "advisory");
  assert.deepEqual(parsed.target_files, ["src/index.ts"]);
  assert.deepEqual(parsed.use_now_memory_ids, ["mem-1"]);
  assert.deepEqual(parsed.inspect_before_use_memory_ids, ["mem-3"]);
  assert.deepEqual(parsed.do_not_use_memory_ids, ["mem-2"]);
  assert.equal(parsed.risk.negative_transfer_risk, "medium");
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
  assert.equal(parsed.training_candidates[0]?.candidate_type, "handoff_distillation");
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
  assert.equal(parsed.memory_decisions[0]?.agent_surface, "use_now");
  assert.equal(parsed.memory_decisions[0]?.feedback_detail, null);
  assert.equal(parsed.feedback_attribution.present, false);
  assert.equal(parsed.summary.feedback_attribution_count, 0);
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
});
