import test from "node:test";
import assert from "node:assert/strict";
import { resolveArchiveRelocationPlan } from "../../src/memory/archive-relocation.ts";
import { resolveSemanticForgettingDecision } from "../../src/memory/semantic-forgetting.ts";

test("archive relocation plans cold-store externalization when semantic forgetting archives anchor payload memory", () => {
  const forgetting = resolveSemanticForgettingDecision({
    type: "concept",
    tier: "cold",
    title: "Retired workflow policy",
    text_summary: "Retired policy memory with archived payload references",
    slots: {
      summary_kind: "policy_memory",
      policy_memory_state: "retired",
      anchor_v1: {
        payload_refs: {
          node_ids: ["n1"],
          decision_ids: ["d1"],
          run_ids: [],
          step_ids: [],
          commit_ids: [],
        },
      },
      feedback_negative: 3,
      feedback_quality: -0.8,
    },
  });
  const out = resolveArchiveRelocationPlan({
    forgetting,
    slots: {
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
  });

  assert.equal(out.relocation_state, "cold_archive");
  assert.equal(out.relocation_target, "local_cold_store");
  assert.equal(out.payload_scope, "anchor_payload");
  assert.equal(out.should_relocate, true);
});

test("archive relocation stays as candidate while semantic forgetting only demotes memory", () => {
  const forgetting = resolveSemanticForgettingDecision({
    type: "concept",
    tier: "hot",
    title: "Contested pattern memory",
    text_summary: "Demote before archive",
    slots: {
      summary_kind: "pattern_anchor",
      anchor_v1: {
        credibility_state: "contested",
      },
      feedback_negative: 1,
      feedback_quality: -0.2,
    },
  });
  const out = resolveArchiveRelocationPlan({
    forgetting,
    slots: {},
  });

  assert.equal(out.relocation_state, "candidate");
  assert.equal(out.relocation_target, "none");
  assert.equal(out.should_relocate, false);
});
