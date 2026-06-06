import test from "node:test";
import assert from "node:assert/strict";
import {
  computeFeedbackUpdatedNodeState,
  mergeNodeFeedbackSlots,
  shouldActivateNodeOnFeedback,
} from "../../src/memory/node-feedback-state.ts";

test("mergeNodeFeedbackSlots increments counters and records metadata", () => {
  const merged = mergeNodeFeedbackSlots({
    slots: {
      feedback_positive: 1,
      feedback_negative: 0,
      feedback_quality: 0.25,
    },
    outcome: "negative",
    run_id: "run-123",
    reason: "pattern produced wrong continuity signal",
    input_sha256: "abc123",
    source: "nodes_activate",
    timestamp: "2026-04-18T00:00:00.000Z",
    used_surface: "use_now",
    verifier_status: "not_run",
    tool_status: "unknown",
  });

  assert.equal(merged.feedback_positive, 1);
  assert.equal(merged.feedback_negative, 1);
  assert.equal(merged.weak_counter_signal_count, 1);
  assert.equal(merged.strong_counter_signal_count, 0);
  assert.equal(merged.last_feedback_outcome, "negative");
  assert.equal(merged.last_feedback_run_id, "run-123");
  assert.equal(merged.last_feedback_source, "nodes_activate");
  assert.equal(merged.last_feedback_used_surface, "use_now");
});

test("computeFeedbackUpdatedNodeState recomputes node priority from merged slots", () => {
  const next = computeFeedbackUpdatedNodeState({
    node: {
      id: "node-1",
      type: "procedure",
      tier: "warm",
      title: "Recover workflow validation route",
      text_summary: "Prefer edit when the export route response mismatches",
      slots: {
        summary_kind: "workflow_anchor",
        compression_layer: "L2",
        execution_contract_v1: {
          task_signature: "task:workflow-validation-recovery-route",
        },
      },
    },
    feedback: {
      outcome: "positive",
      input_sha256: "sha-1",
      source: "nodes_activate",
      timestamp: "2026-04-18T00:00:00.000Z",
    },
  });

  assert.equal(next.slots.feedback_positive, 1);
  assert.equal(next.slots.last_feedback_outcome, "positive");
  assert.equal(next.slots.summary_kind, "workflow_anchor");
  assert.equal(next.slots.compression_layer, "L2");
  assert.deepEqual(next.slots.execution_contract_v1, {
    task_signature: "task:workflow-validation-recovery-route",
  });
  assert.ok(next.salience > 0);
  assert.ok(next.importance > 0);
  assert.ok(next.confidence > 0);
  assert.equal(shouldActivateNodeOnFeedback("positive"), true);
  assert.equal(shouldActivateNodeOnFeedback("neutral"), false);
});

test("computeFeedbackUpdatedNodeState keeps base confidence for a single weak negative attribution", () => {
  const next = computeFeedbackUpdatedNodeState({
    node: {
      id: "node-2",
      type: "concept",
      tier: "warm",
      title: "Status style",
      text_summary: "Prefer concise status updates",
      salience: 0.77,
      importance: 0.78,
      confidence: 0.82,
      slots: {},
    },
    feedback: {
      outcome: "negative",
      run_id: "run-weak-negative",
      input_sha256: "sha-weak-negative",
      source: "nodes_activate",
      timestamp: "2026-04-18T00:00:00.000Z",
      used_surface: "use_now",
      verifier_status: "not_run",
      tool_status: "unknown",
    },
  });

  assert.equal(next.slots.weak_counter_signal_count, 1);
  assert.equal(next.slots.strong_counter_signal_count, 0);
  assert.equal(next.confidence, 0.82);
});
