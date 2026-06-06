import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAionisAgentContext,
  buildAionisMemoryDecisionAuditReport,
  buildAionisMemoryDecisionTrace,
  buildAionisMemoryPacket,
} from "../../src/memory/product-output-assembler.ts";
import type {
  AionisAgentContext,
  AionisMemoryDecisionAuditReport,
  AionisMemoryDecisionTrace,
  AionisMemoryPacket,
} from "../../src/memory/product-output-contract.ts";

function countBySurface(trace: AionisMemoryDecisionTrace, surface: AionisMemoryDecisionTrace["memory_decisions"][number]["agent_surface"]): number {
  return trace.memory_decisions.filter((entry) => entry.agent_surface === surface).length;
}

function assertTraceSummaryMatchesDecisions(trace: AionisMemoryDecisionTrace, agentContext: AionisAgentContext): void {
  assert.equal(trace.summary.total_memory_count, trace.memory_decisions.length);
  assert.equal(trace.summary.direct_use_count, countBySurface(trace, "use_now"));
  assert.equal(trace.summary.inspect_before_use_count, countBySurface(trace, "inspect_before_use"));
  assert.equal(trace.summary.do_not_use_count, countBySurface(trace, "do_not_use"));
  assert.equal(trace.summary.rehydrate_count, countBySurface(trace, "rehydrate"));
  assert.equal(trace.summary.relation_count, trace.relation_decisions.length);
  assert.equal(trace.summary.feedback_attribution_count, trace.feedback_attribution.attributed_memory_ids.length);
  assert.equal(trace.summary.feedback_threshold_met_count, trace.feedback_attribution.threshold_met_memory_ids.length);
  assert.equal(trace.summary.unattributed_recalled_memory_count, trace.feedback_attribution.unattributed_recalled_memory_ids.length);
  assert.equal(trace.feedback_attribution.attributed_memory_count, trace.feedback_attribution.attributed_memory_ids.length);
  assert.equal(trace.feedback_attribution.unattributed_recalled_memory_count, trace.feedback_attribution.unattributed_recalled_memory_ids.length);
  assert.equal(trace.summary.prompt_char_count, agentContext.prompt_text.length);
  assert.equal(trace.context_decision.prompt_char_count, agentContext.prompt_text.length);
  assert.equal(trace.context_decision.use_now_count, agentContext.use_now.length);
  assert.equal(trace.context_decision.inspect_before_use_count, agentContext.inspect_before_use.length);
  assert.equal(trace.context_decision.do_not_use_count, agentContext.do_not_use.length);
  assert.equal(trace.context_decision.rehydrate_hint_count, agentContext.rehydrate_hints.length);
  assert.deepEqual(trace.context_decision.memory_ids, agentContext.memory_ids);
  assert.equal(trace.agent_prompt_included, false);
  assert.equal(trace.runtime_mutation, false);
  assert.equal(agentContext.prompt_text.includes("memory_decision_trace"), false);
  assert.equal(agentContext.prompt_text.includes("memory_decision_audit"), false);
  assert.equal(agentContext.prompt_text.includes("decision_reviews"), false);
}

function assertTraceReviewsMirrorDecisions(
  trace: AionisMemoryDecisionTrace,
  audit: AionisMemoryDecisionAuditReport,
): void {
  const used = trace.memory_decisions.filter((entry) => entry.decision_kind === "used" && entry.used_detail);
  const downgraded = trace.memory_decisions.filter((entry) => entry.decision_kind === "downgraded" && entry.downgraded_detail);
  const blocked = trace.memory_decisions.filter((entry) => entry.decision_kind === "blocked" && entry.blocked_detail);
  const rehydrate = trace.memory_decisions.filter((entry) => entry.decision_kind === "rehydrate" && entry.rehydrate_detail);

  assert.deepEqual(
    audit.decision_reviews.used_memories.map((entry) => entry.memory_id),
    used.map((entry) => entry.memory_id),
  );
  assert.deepEqual(
    audit.decision_reviews.downgraded_memories.map((entry) => entry.memory_id),
    downgraded.map((entry) => entry.memory_id),
  );
  assert.deepEqual(
    audit.decision_reviews.blocked_memories.map((entry) => entry.memory_id),
    blocked.map((entry) => entry.memory_id),
  );
  assert.deepEqual(
    audit.decision_reviews.rehydrate_memories.map((entry) => entry.memory_id),
    rehydrate.map((entry) => entry.memory_id),
  );

  for (const review of audit.decision_reviews.downgraded_memories) {
    const decision = trace.memory_decisions.find((entry) => entry.memory_id === review.memory_id);
    assert.ok(decision?.downgraded_detail);
    assert.equal(review.by_memory_id, decision.downgraded_detail.by_memory_id);
    assert.equal(review.evidence_id, decision.downgraded_detail.evidence_id);
    assert.equal(review.lifecycle_relation, decision.downgraded_detail.relation.lifecycle_relation);
    assert.equal(review.relation_confidence, decision.downgraded_detail.relation.confidence);
    assert.equal(review.producer, decision.downgraded_detail.relation.producer);
    assert.deepEqual(review.gate, decision.downgraded_detail.relation.gate);
    assert.deepEqual(review.signals, decision.downgraded_detail.relation.signals);
  }

  for (const review of audit.decision_reviews.blocked_memories) {
    const decision = trace.memory_decisions.find((entry) => entry.memory_id === review.memory_id);
    assert.ok(decision?.blocked_detail);
    assert.equal(review.blocked_by, decision.blocked_detail.blocked_by);
    assert.equal(review.lifecycle_state, decision.blocked_detail.lifecycle_state);
    assert.equal(review.authority, decision.blocked_detail.authority);
  }

  for (const review of audit.decision_reviews.rehydrate_memories) {
    const decision = trace.memory_decisions.find((entry) => entry.memory_id === review.memory_id);
    assert.ok(decision?.rehydrate_detail);
    assert.equal(review.mode, decision.rehydrate_detail.mode);
    assert.equal(review.required, decision.rehydrate_detail.required);
    assert.equal(review.payload_status, decision.rehydrate_detail.payload_status);
  }

  const sparseSummary = trace.feedback_attribution.sparse_feedback_signal_summary;
  assert.equal(audit.feedback_signal_review.present, sparseSummary.present);
  assert.equal(audit.feedback_signal_review.mode, sparseSummary.mode);
  assert.equal(audit.feedback_signal_review.authority_mutation, false);
  assert.deepEqual(
    audit.feedback_signal_review.positive_attributed_memories.map((entry) => entry.memory_id),
    sparseSummary.positive_attributed_memory_ids,
  );
  assert.deepEqual(
    audit.feedback_signal_review.weak_counter_signal_memories.map((entry) => entry.memory_id),
    sparseSummary.weak_counter_signal_memory_ids,
  );
  assert.deepEqual(
    audit.feedback_signal_review.strong_counter_signal_memories.map((entry) => entry.memory_id),
    sparseSummary.strong_counter_signal_memory_ids,
  );
  assert.deepEqual(
    audit.feedback_signal_review.relation_counter_signal_memories.map((entry) => entry.memory_id),
    sparseSummary.relation_counter_signal_memory_ids,
  );
  assert.deepEqual(
    audit.feedback_signal_review.contradiction_warning_memories.map((entry) => entry.memory_id),
    sparseSummary.contradiction_warning_memory_ids,
  );
  assert.deepEqual(
    audit.feedback_signal_review.repeated_unattributed_memories.map((entry) => entry.memory_id),
    sparseSummary.repeated_unattributed_memory_ids,
  );
  assert.deepEqual(
    audit.feedback_signal_review.repeated_unattributed_without_positive_memories.map((entry) => entry.memory_id),
    sparseSummary.repeated_unattributed_without_positive_memory_ids,
  );
  assert.deepEqual(audit.feedback_signal_review.read_only_signal_memory_ids, sparseSummary.read_only_signal_memory_ids);
}

function buildTraceFixture(): {
  memoryPacket: AionisMemoryPacket;
  agentContext: AionisAgentContext;
  trace: AionisMemoryDecisionTrace;
  audit: AionisMemoryDecisionAuditReport;
} {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "audit memory decision correctness",
    },
    nodes: [
      {
        id: "mem-current",
        type: "concept",
        title: "Current checkout route",
        text_summary: "Current checkout work lives in src/payments/checkout.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
        confidence: 0.91,
        salience: 0.88,
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "mem-old",
        type: "concept",
        title: "Old checkout route",
        text_summary: "Prior checkout work pointed at legacy/payments/old-checkout.ts.",
        tier: "hot",
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "contested",
          compression_layer: "L2",
        },
        confidence: 0.86,
        salience: 0.79,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "mem-suppressed",
        type: "concept",
        title: "Suppressed checkout note",
        text_summary: "Suppressed note should stay out of agent use.",
        tier: "warm",
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "suppressed",
          compression_layer: "L2",
        },
        confidence: 0.82,
        salience: 0.72,
      },
      {
        id: "mem-payload",
        type: "concept",
        title: "Checkout archive payload",
        text_summary: "Archived payload contains long-form checkout migration background.",
        tier: "cold",
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "rehydration_candidate",
          compression_layer: "L2",
          execution_native_v1: {
            rehydration_default_mode: "differential",
          },
        },
        confidence: 0.78,
        salience: 0.76,
      },
    ],
    lifecycle_edges: [
      {
        id: "edge-current-contradicts-old",
        type: "contradicts",
        src_id: "mem-current",
        dst_id: "mem-old",
        confidence: 0.83,
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
      operation: "suppress",
      target: "memory",
      reason: "operator blocked an obsolete memory",
      forget_effect: {
        action: "suppress",
        target: "memory",
        changed_count: 1,
        affected_memory_ids: ["mem-suppressed"],
      },
    },
  });
  return {
    memoryPacket,
    agentContext,
    trace,
    audit: buildAionisMemoryDecisionAuditReport({ trace }),
  };
}

test("memory decision trace summary and context fields are derived from the emitted packets", () => {
  const { agentContext, trace } = buildTraceFixture();
  assertTraceSummaryMatchesDecisions(trace, agentContext);
  assert.equal(trace.summary.history_used, agentContext.history_used);
  assert.equal(trace.summary.recommended_posture, agentContext.recommended_posture);
  assert.equal(trace.summary.authority, agentContext.authority);
  assert.equal(trace.summary.negative_transfer_risk, agentContext.risk.negative_transfer_risk);
});

test("memory decision trace relation evidence matches lifecycle evidence trail targets", () => {
  const { memoryPacket, trace } = buildTraceFixture();
  const relationEvidence = memoryPacket.evidence_trail.filter((entry) => entry.source === "edge" && entry.lifecycle_relation);
  assert.equal(trace.relation_decisions.length, relationEvidence.length);
  assert.equal(trace.relation_decisions[0]?.evidence_id, relationEvidence[0]?.evidence_id);
  assert.equal(trace.relation_decisions[0]?.memory_id, relationEvidence[0]?.memory_id);
  assert.equal(trace.relation_decisions[0]?.source_memory_id, relationEvidence[0]?.lifecycle_relation?.source_memory_id);
  assert.equal(trace.relation_decisions[0]?.target_memory_id, relationEvidence[0]?.lifecycle_relation?.target_memory_id);
  assert.equal(trace.relation_decisions[0]?.lifecycle_relation, relationEvidence[0]?.lifecycle_relation?.lifecycle_relation);
  assert.equal(trace.relation_decisions[0]?.confidence, relationEvidence[0]?.lifecycle_relation?.confidence);
  assert.equal(trace.relation_decisions[0]?.gate.accepted, true);
});

test("memory decision trace per-memory details explain use, downgrade, block, and rehydrate decisions", () => {
  const { memoryPacket, trace } = buildTraceFixture();
  const current = trace.memory_decisions.find((entry) => entry.memory_id === "mem-current");
  assert.equal(current?.agent_surface, "use_now");
  assert.equal(current?.decision_kind, "used");
  assert.equal(current?.used_detail?.not_superseded, true);
  assert.equal(current?.downgraded_detail, null);
  assert.equal(current?.blocked_detail, null);
  assert.equal(current?.rehydrate_detail, null);

  const old = trace.memory_decisions.find((entry) => entry.memory_id === "mem-old");
  assert.equal(old?.agent_surface, "inspect_before_use");
  assert.equal(old?.decision_kind, "downgraded");
  assert.equal(old?.downgraded_detail?.by_memory_id, "mem-current");
  assert.equal(old?.downgraded_detail?.relation.target_memory_id, "mem-old");
  assert.equal(old?.downgraded_detail?.relation.lifecycle_relation, "contradicts");
  assert.equal(old?.used_detail, null);
  assert.equal(old?.blocked_detail, null);
  assert.equal(old?.rehydrate_detail, null);
  assert.ok(old?.reason_codes.includes("lifecycle_contested"));
  assert.ok(old?.reason_codes.includes("lifecycle_relation_evidence"));

  const suppressed = trace.memory_decisions.find((entry) => entry.memory_id === "mem-suppressed");
  assert.equal(suppressed?.agent_surface, "do_not_use");
  assert.equal(suppressed?.decision_kind, "blocked");
  assert.equal(suppressed?.blocked_detail?.blocked_by, "suppressed_lifecycle");
  assert.equal(suppressed?.blocked_detail?.lifecycle_state, "suppressed");
  assert.equal(suppressed?.used_detail, null);
  assert.equal(suppressed?.downgraded_detail, null);
  assert.equal(suppressed?.rehydrate_detail, null);

  const payload = trace.memory_decisions.find((entry) => entry.memory_id === "mem-payload");
  const payloadHint = memoryPacket.lifecycle.rehydration_hints.find((entry) => entry.memory_id === "mem-payload");
  assert.equal(payload?.agent_surface, "rehydrate");
  assert.equal(payload?.decision_kind, "rehydrate");
  assert.equal(payload?.rehydrate_detail?.mode, payloadHint?.mode);
  assert.equal(payload?.rehydrate_detail?.required, payloadHint?.required);
  assert.equal(payload?.rehydrate_detail?.reason, payloadHint?.reason);
  assert.equal(payload?.rehydrate_detail?.payload_status, "cold_payload");
  assert.equal(payload?.used_detail, null);
  assert.equal(payload?.downgraded_detail, null);
  assert.equal(payload?.blocked_detail, null);
});

test("memory decision audit reviews are a lossless compact projection of trace decisions", () => {
  const { audit, trace } = buildTraceFixture();
  assertTraceReviewsMirrorDecisions(trace, audit);
  assert.equal(audit.agent_prompt_included, false);
  assert.equal(audit.runtime_mutation, false);
  assert.equal(audit.counters.total_memory_count, trace.summary.total_memory_count);
  assert.equal(audit.counters.controlled_memory_count, trace.summary.inspect_before_use_count + trace.summary.do_not_use_count + trace.summary.rehydrate_count);
  assert.equal(audit.counters.relation_count, trace.summary.relation_count);
  assert.equal(audit.counters.feedback_attribution_count, trace.summary.feedback_attribution_count);
  assert.equal(audit.counters.feedback_threshold_met_count, trace.summary.feedback_threshold_met_count);
  assert.equal(audit.counters.prompt_char_count, trace.summary.prompt_char_count);
  assert.equal(audit.claims.some((claim) => claim.claim === "agent_prompt_excluded" && claim.status === "pass"), true);
  assert.equal(audit.claims.some((claim) => claim.claim === "runtime_state_unchanged" && claim.status === "pass"), true);
});

test("memory decision trace forget decisions mirror forget-result effect fields", () => {
  const { trace } = buildTraceFixture();
  assert.deepEqual(trace.forget_decisions, [
    {
      action: "suppress",
      target: "memory",
      changed_count: 1,
      affected_memory_ids: ["mem-suppressed"],
      reason: "operator blocked an obsolete memory",
    },
  ]);
});

test("memory decision trace separates absent feedback attribution from relation sparse signals", () => {
  const { agentContext, trace } = buildTraceFixture();
  assert.equal(trace.feedback_attribution.present, false);
  assert.equal(trace.feedback_attribution.guide_trace_id, null);
  assert.equal(trace.feedback_attribution.exposed_memory_count, 0);
  assert.equal(trace.feedback_attribution.attributed_memory_count, 0);
  assert.equal(trace.feedback_attribution.unattributed_recalled_memory_count, agentContext.memory_ids.length);
  assert.deepEqual(trace.feedback_attribution.affected_memory_ids, []);
  assert.deepEqual(trace.feedback_attribution.attributed_memory_ids, []);
  assert.deepEqual(trace.feedback_attribution.threshold_met_memory_ids, []);
  assert.deepEqual(trace.feedback_attribution.unattributed_recalled_memory_ids, agentContext.memory_ids);
  assert.deepEqual(trace.feedback_attribution.unattributed_use_now_memory_ids, []);
  assert.deepEqual(trace.feedback_attribution.unattributed_inspect_before_use_memory_ids, []);
  assert.deepEqual(trace.feedback_attribution.unattributed_do_not_use_memory_ids, []);
  assert.deepEqual(trace.feedback_attribution.unattributed_rehydrate_memory_ids, []);
  assert.equal(trace.feedback_attribution.unused_exposure_observation.present, false);
  assert.deepEqual(trace.feedback_attribution.unused_exposure_observation.repeated_unattributed_memory_ids, []);
  assert.deepEqual(trace.feedback_attribution.unused_exposure_observation.repeated_unattributed_without_positive_memory_ids, []);
  assert.equal(trace.feedback_attribution.sparse_feedback_signal_summary.present, true);
  assert.equal(trace.feedback_attribution.sparse_feedback_signal_summary.authority_mutation, false);
  assert.deepEqual(trace.feedback_attribution.sparse_feedback_signal_summary.relation_counter_signal_memory_ids, ["mem-old"]);
  assert.deepEqual(trace.feedback_attribution.sparse_feedback_signal_summary.contradiction_warning_memory_ids, ["mem-old"]);
  assert.deepEqual(trace.feedback_attribution.sparse_feedback_signal_summary.read_only_signal_memory_ids, ["mem-old"]);
  assert.equal(trace.memory_decisions.every((entry) => entry.feedback_detail === null), true);
});
