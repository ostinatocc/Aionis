import test from "node:test";
import assert from "node:assert/strict";
import {
  AionisEffectReportSchema,
  AionisGuidePacketSchema,
  AionisLearningPacketSchema,
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
      first_action: {
        action: "inspect src/index.ts around the failing branch",
        reason: "Recovered execution state points to the failing branch.",
        authority: "advisory",
        uncertainty: "medium",
      },
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
      changed_fields: ["guidance.first_action", "memory_lifecycle.suppressed_memory_ids"],
      explanation: "Aionis skipped repeated discovery and suppressed stale memory.",
    },
    efficiency: {
      repeated_discovery_delta: -3,
      first_useful_action_delta: -2,
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
  assert.equal(parsed.guidance.first_action.authority, "advisory");
  assert.equal(parsed.memory_lifecycle.suppressed_memory_ids.length, 1);
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
