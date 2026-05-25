import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDifferentialRehydrationPlan,
  forgettingKernel,
  resolveArchiveRelocationPlan,
  resolveSemanticForgettingDecision,
} from "../../src/kernel/forgetting-kernel.ts";

test("forgetting kernel facade keeps scoring, forgetting, relocation, and rehydration decisions together", () => {
  const input = {
    type: "concept",
    tier: "cold",
    title: "Retired policy memory",
    text_summary: "Retired policy: no longer default to bash for flaky migration",
    slots: {
      summary_kind: "policy_memory",
      policy_memory_state: "retired",
      feedback_negative: 4,
      feedback_quality: -0.8,
      anchor_v1: {
        payload_refs: {
          node_ids: ["n1"],
          decision_ids: ["d1"],
          run_ids: [],
          step_ids: [],
          commit_ids: [],
        },
      },
    },
  };

  const score = forgettingKernel.scoreImportance(input);
  assert.ok(score.retention_score >= 0);

  const forgetting = forgettingKernel.planForgetting(input);
  assert.equal(forgetting.action, "archive");
  assert.equal(forgetting.lifecycle_state, "retired");

  const relocation = forgettingKernel.planArchiveRelocation({
    forgetting,
    slots: input.slots,
  });
  assert.equal(relocation.relocation_state, "cold_archive");
  assert.equal(relocation.relocation_target, "local_cold_store");
  assert.equal(relocation.payload_scope, "anchor_payload");

  const rehydration = forgettingKernel.planRehydration({
    reason: "need export repair workflow detail",
    nodes: [
      { id: "n1", title: "Export repair workflow", summary: "Patch export mismatch and rerun tests." },
      { id: "n2", title: "Migration note", summary: "Old database migration note." },
    ],
    decisions: [
      { id: "d1", selected_tool: "edit", summary: "Use edit for export repair." },
      { id: "d2", selected_tool: "bash", summary: "Run migration script." },
    ],
  });
  assert.deepEqual(rehydration.node_ids, ["n1"]);
  assert.deepEqual(rehydration.decision_ids, ["d1"]);
  assert.ok(rehydration.rationale.includes("reason_and_keep_details_match"));
});

test("forgetting kernel keeps contested memory in demote-before-archive mode", () => {
  const forgetting = resolveSemanticForgettingDecision({
    type: "concept",
    tier: "hot",
    title: "Contested pattern memory",
    text_summary: "Avoid this tool unless counter-evidence is resolved",
    slots: {
      summary_kind: "pattern_anchor",
      anchor_v1: {
        anchor_kind: "pattern",
        credibility_state: "contested",
      },
      feedback_negative: 2,
      feedback_quality: -0.2,
    },
  });

  assert.equal(forgetting.action, "demote");
  assert.equal(forgetting.target_tier, "warm");
  assert.equal(forgetting.should_relocate, false);

  const relocation = resolveArchiveRelocationPlan({
    forgetting,
    slots: {},
  });
  assert.equal(relocation.relocation_state, "candidate");
  assert.equal(relocation.should_relocate, false);
});

test("forgetting kernel uses explicit rehydration adjudication before token fallback", () => {
  const plan = buildDifferentialRehydrationPlan({
    reason: "recover deploy workflow but avoid obsolete test detail",
    adjudication: {
      related_memory_ids: ["node-explicit"],
      related_decision_ids: ["decision-explicit"],
      drop_details: ["obsolete"],
    },
    nodes: [
      { id: "node-explicit", title: "Any explicit memory" },
      { id: "node-obsolete", title: "Obsolete deploy note" },
    ],
    decisions: [
      { id: "decision-explicit", summary: "Explicit decision" },
      { id: "decision-obsolete", summary: "Obsolete decision" },
    ],
  });

  assert.deepEqual(plan.node_ids, ["node-explicit"]);
  assert.deepEqual(plan.decision_ids, ["decision-explicit"]);
  assert.ok(plan.rationale.includes("explicit_related_ids"));
  assert.ok(plan.rationale.includes("drop_details_penalty"));
});
