import test from "node:test";
import assert from "node:assert/strict";
import { resolveSemanticForgettingDecision } from "../../src/memory/semantic-forgetting.ts";

test("semantic forgetting retains recent active workflow memory", () => {
  const out = resolveSemanticForgettingDecision({
    type: "procedure",
    tier: "warm",
    title: "Workflow anchor: fix export mismatch",
    text_summary: "Inspect failing test, patch export, rerun targeted test",
    slots: {
      summary_kind: "workflow_anchor",
      compression_layer: "L2",
      anchor_v1: {
        anchor_kind: "workflow",
        workflow_promotion: {
          promotion_state: "stable",
        },
        metrics: {
          usage_count: 6,
          reuse_success_count: 4,
          distinct_run_count: 3,
          last_used_at: new Date().toISOString(),
        },
      },
      feedback_positive: 3,
      feedback_quality: 0.9,
    },
  });

  assert.equal(out.action, "retain");
  assert.equal(out.target_tier, "warm");
  assert.equal(out.lifecycle_state, "active");
  assert.ok(out.retention_score > 0.6);
});

test("semantic forgetting demotes contested memory before archiving it", () => {
  const out = resolveSemanticForgettingDecision({
    type: "concept",
    tier: "hot",
    title: "Contested pattern memory",
    text_summary: "Avoid this tool unless counter-evidence is resolved",
    slots: {
      summary_kind: "pattern_anchor",
      compression_layer: "L3",
      anchor_v1: {
        anchor_kind: "pattern",
        credibility_state: "contested",
      },
      feedback_positive: 1,
      feedback_negative: 2,
      feedback_quality: -0.2,
    },
  });

  assert.equal(out.action, "demote");
  assert.equal(out.target_tier, "warm");
  assert.equal(out.lifecycle_state, "contested");
});

test("semantic forgetting archives retired policy memory", () => {
  const out = resolveSemanticForgettingDecision({
    type: "concept",
    tier: "cold",
    title: "Retired policy memory",
    text_summary: "Retired policy: no longer default to bash for flaky migration",
    slots: {
      summary_kind: "policy_memory",
      compression_layer: "L4",
      policy_memory_state: "retired",
      feedback_negative: 4,
      feedback_quality: -0.8,
    },
  });

  assert.equal(out.action, "archive");
  assert.equal(out.target_tier, "archive");
  assert.equal(out.lifecycle_state, "retired");
  assert.equal(out.should_relocate, true);
});

test("semantic forgetting treats low-trust canonical policy memory as contested when explicit lifecycle state is absent", () => {
  const out = resolveSemanticForgettingDecision({
    type: "concept",
    tier: "hot",
    title: "Advisory policy memory",
    text_summary: "Hint-level persisted policy memory should not stay hot by default",
    slots: {
      summary_kind: "policy_memory",
      compression_layer: "L4",
      execution_contract_v1: {
        schema_version: "execution_contract_v1",
        contract_trust: "advisory",
        task_family: "task:repair_export",
        task_signature: "repair-export-route",
        workflow_signature: "execution_workflow:repair-export",
        policy_memory_id: "pm_advisory",
        selected_tool: "edit",
        file_path: "src/routes/export.ts",
        target_files: ["src/routes/export.ts"],
        next_action: "Patch src/routes/export.ts and rerun export tests.",
        workflow_steps: [],
        pattern_hints: [],
        service_lifecycle_constraints: [],
        outcome: {
          acceptance_checks: [],
          success_invariants: [],
          dependency_requirements: [],
          environment_assumptions: [],
          must_hold_after_exit: [],
          external_visibility_requirements: [],
        },
        provenance: {
          source_kind: "policy_contract",
          source_summary_version: "policy_contract_v1",
          source_anchor: "pm_advisory",
          evidence_refs: [],
          notes: [],
        },
      },
      feedback_positive: 1,
      feedback_quality: 0.1,
    },
  });

  assert.equal(out.lifecycle_state, "contested");
  assert.equal(out.action, "demote");
  assert.equal(out.target_tier, "warm");
});
