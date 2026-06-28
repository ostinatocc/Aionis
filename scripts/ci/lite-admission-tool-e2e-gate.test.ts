import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAdmissionToolE2EGate,
  formatAdmissionToolE2EGateMarkdown,
} from "../../src/memory/admission-tool-e2e-gate.js";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "external_agent_e2e_phase2_gradient_summary_v0_1",
    run_id: "tool-e2e-fixture",
    aggregate: {
      requested: 40,
      completed: 40,
    },
    by_level_arm: ["tidy", "separated", "implicit", "buried"].map((difficulty_level) => ({
      difficulty_level,
      arm: "aionis",
      runs: 10,
    })),
    by_arm: [
      {
        arm: "full_history",
        runs: 40,
        prompt_tokens: 200000,
        initial_context_chars: 200000,
      },
      {
        arm: "aionis",
        runs: 40,
        wrong_branch_write_hits: 0,
        wrong_branch_action_hits: 0,
        wrong_branch_direction_attention_hits: 0,
        wrong_branch_reference_attention_hits: 0,
        accepted_direction_hits: 40,
        accepted_direction_rate: 1,
        action_completion_hits: 40,
        action_completion_rate: 1,
        terminal_inspect_hits: 0,
        report_conflict_hits: 0,
        initial_context_chars: 100000,
        prompt_tokens: 100000,
        completion_tokens: 10000,
        ...overrides,
      },
    ],
  };
}

test("tool e2e gate passes a clean cross-repository summary", () => {
  const report = evaluateAdmissionToolE2EGate({
    summary: summary(),
    policy_mode: "active",
    results: [
      { base_trap_id: "repo-a-trap-1", difficulty_level: "tidy" },
      { base_trap_id: "repo-a-trap-1", difficulty_level: "separated" },
      { base_trap_id: "repo-b-trap-2", difficulty_level: "implicit" },
      { base_trap_id: "repo-b-trap-2", difficulty_level: "buried" },
    ],
  });

  assert.equal(report.contract_version, "aionis_admission_tool_e2e_gate_report_v1");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.decision.eligible_for_default_active_review, true);
  assert.deepEqual(report.decision.blocking_reasons, []);
  assert.equal(report.checks.context_budget_pass, true);
  assert.equal(report.metrics.context_budget_metric, "initial_context_chars");
});

test("tool e2e gate uses initial context budget before total prompt budget", () => {
  const report = evaluateAdmissionToolE2EGate({
    summary: summary({
      initial_context_chars: 50000,
      prompt_tokens: 300000,
    }),
    policy_mode: "active",
    results: [
      { base_trap_id: "repo-a-trap-1", difficulty_level: "tidy" },
      { base_trap_id: "repo-a-trap-1", difficulty_level: "separated" },
      { base_trap_id: "repo-b-trap-2", difficulty_level: "implicit" },
      { base_trap_id: "repo-b-trap-2", difficulty_level: "buried" },
    ],
  });

  assert.equal(report.metrics.initial_context_ratio_vs_full_history, 0.25);
  assert.equal(report.metrics.prompt_ratio_vs_full_history, 1.5);
  assert.equal(report.checks.context_budget_pass, true);
  assert.equal(report.decision.eligible_for_default_active_review, true);
});

test("tool e2e gate falls back to legacy prompt budget for old reports", () => {
  const oldSummary = summary({ initial_context_chars: 0, prompt_tokens: 300000 });
  const byArm = oldSummary.by_arm as Array<Record<string, unknown>>;
  delete byArm[0].initial_context_chars;
  delete byArm[1].initial_context_chars;
  const report = evaluateAdmissionToolE2EGate({
    summary: oldSummary,
    policy_mode: "active",
  });

  assert.equal(report.metrics.initial_context_ratio_vs_full_history, null);
  assert.equal(report.metrics.context_budget_metric, "total_prompt_tokens");
  assert.equal(report.metrics.prompt_ratio_vs_full_history, 1.5);
  assert.equal(report.checks.context_budget_pass, false);
  assert.ok(report.decision.blocking_reasons.includes("context_budget_not_better_than_full_history"));
});

test("tool e2e gate blocks route-adherence and completion regressions", () => {
  const report = evaluateAdmissionToolE2EGate({
    summary: summary({
      wrong_branch_direction_attention_hits: 1,
      accepted_direction_hits: 39,
      accepted_direction_rate: 0.975,
      action_completion_hits: 39,
      action_completion_rate: 0.975,
      terminal_inspect_hits: 1,
    }),
    policy_mode: "active",
  });

  assert.equal(report.decision.eligible_for_default_active_review, false);
  assert.ok(report.decision.blocking_reasons.includes("direction_attention_violation_present"));
  assert.ok(report.decision.blocking_reasons.includes("terminal_inspect_present"));
  assert.ok(report.decision.blocking_reasons.includes("accepted_route_rate_below_threshold"));
  assert.ok(report.decision.blocking_reasons.includes("action_completion_rate_below_threshold"));
});

test("tool e2e gate formats markdown without making the raw metric name the headline", () => {
  const report = evaluateAdmissionToolE2EGate({ summary: summary(), policy_mode: "active" });
  const markdown = formatAdmissionToolE2EGateMarkdown(report);

  assert.match(markdown, /Aionis Admission Tool-E2E Gate/);
  assert.match(markdown, /Route write violations/);
  assert.match(markdown, /Accepted-route rate/);
  assert.doesNotMatch(markdown.split("\n").slice(0, 5).join("\n"), /wrong-branch/i);
});

test("tool e2e gate blocks reports that do not declare active candidate mode", () => {
  const report = evaluateAdmissionToolE2EGate({ summary: summary() });

  assert.equal(report.decision.eligible_for_default_active_review, false);
  assert.ok(report.decision.blocking_reasons.includes("candidate_active_policy_mode_not_declared"));
});
