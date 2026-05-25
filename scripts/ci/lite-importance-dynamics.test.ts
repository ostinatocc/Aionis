import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAdaptiveImportanceTarget,
  computeRetentionScore,
  resolveNodePriorityProfile,
} from "../../src/memory/importance-dynamics.ts";

test("resolveNodePriorityProfile rewards trusted pattern anchors over raw events", () => {
  const raw = resolveNodePriorityProfile({
    type: "event",
    tier: "warm",
    slots: {},
  });
  const trusted = resolveNodePriorityProfile({
    type: "rule",
    tier: "warm",
    title: "Trusted edit pattern",
    text_summary: "Prefer edit for repair_export flows",
    slots: {
      summary_kind: "pattern_anchor",
      compression_layer: "L3",
      anchor_v1: {
        anchor_kind: "pattern",
        credibility_state: "trusted",
        pattern_state: "stable",
        metrics: {
          usage_count: 6,
          reuse_success_count: 4,
          reuse_failure_count: 0,
          distinct_run_count: 3,
        },
      },
    },
  });

  assert.ok(trusted.salience > raw.salience);
  assert.ok(trusted.importance > raw.importance);
  assert.ok(trusted.confidence > raw.confidence);
  assert.ok(trusted.retention_score > raw.retention_score);
});

test("computeRetentionScore and adaptive importance stay clamped", () => {
  const retention = computeRetentionScore({
    salience: 0.9,
    importance: 0.95,
    confidence: 0.8,
    feedback_quality: 1,
    last_activated_at: new Date().toISOString(),
  });
  const importance = computeAdaptiveImportanceTarget({
    current_importance: 0.98,
    feedback_quality: 1,
    is_recent: true,
  });

  assert.ok(retention <= 1 && retention >= 0);
  assert.ok(importance <= 1 && importance >= 0);
  assert.ok(importance >= 0.98);
});

test("resolveNodePriorityProfile differentiates authoritative and advisory policy memory via canonical contract trust", () => {
  const advisory = resolveNodePriorityProfile({
    type: "concept",
    tier: "warm",
    title: "Advisory policy memory",
    text_summary: "Hint-level policy memory for export repair",
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
    },
  });
  const authoritative = resolveNodePriorityProfile({
    type: "concept",
    tier: "warm",
    title: "Authoritative policy memory",
    text_summary: "Authoritative policy memory for export repair",
    slots: {
      summary_kind: "policy_memory",
      compression_layer: "L4",
      execution_contract_v1: {
        schema_version: "execution_contract_v1",
        contract_trust: "authoritative",
        task_family: "task:repair_export",
        task_signature: "repair-export-route",
        workflow_signature: "execution_workflow:repair-export",
        policy_memory_id: "pm_authoritative",
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
          source_anchor: "pm_authoritative",
          evidence_refs: [],
          notes: [],
        },
      },
    },
  });

  assert.ok(authoritative.importance > advisory.importance);
  assert.ok(authoritative.confidence > advisory.confidence);
  assert.ok(authoritative.retention_score > advisory.retention_score);
});
