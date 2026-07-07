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
  assert.equal(report.checks.input_integrity_pass, true);
  assert.equal(report.checks.accepted_route_rate_consistent, true);
  assert.equal(report.checks.action_completion_rate_consistent, true);
  assert.equal(report.checks.context_budget_assessed, true);
  assert.equal(report.checks.context_budget_pass, true);
  assert.equal(report.metrics.context_budget_metric, "initial_context_chars");
  assert.ok(report.input_integrity.trusted_zero_count_fields.some((field) => field.endsWith(".wrong_branch_write_hits")));
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

test("tool e2e gate blocks missing required safety count fields", () => {
  const cleanSummary = summary();
  const byArm = cleanSummary.by_arm as Array<Record<string, unknown>>;
  delete byArm[1].wrong_branch_write_hits;
  const report = evaluateAdmissionToolE2EGate({
    summary: cleanSummary,
    policy_mode: "active",
  });

  assert.equal(report.checks.input_integrity_pass, false);
  assert.equal(report.checks.no_route_write_violations, false);
  assert.equal(report.decision.eligible_for_default_active_review, false);
  assert.ok(report.input_integrity.missing_required_fields.some((field) => field.endsWith(".wrong_branch_write_hits")));
  assert.ok(report.decision.blocking_reasons.includes("missing_required_input_fields"));
  assert.ok(report.decision.blocking_reasons.includes("route_write_violation_present"));
});

test("tool e2e gate blocks invalid required safety count fields", () => {
  const report = evaluateAdmissionToolE2EGate({
    summary: summary({
      terminal_inspect_hits: "0",
    }),
    policy_mode: "active",
  });

  assert.equal(report.checks.input_integrity_pass, false);
  assert.equal(report.checks.no_terminal_inspect, false);
  assert.equal(report.decision.eligible_for_default_active_review, false);
  assert.ok(report.input_integrity.invalid_required_fields.some((field) => field.endsWith(".terminal_inspect_hits")));
  assert.ok(report.decision.blocking_reasons.includes("invalid_required_input_fields"));
  assert.ok(report.decision.blocking_reasons.includes("terminal_inspect_present"));
});

test("tool e2e gate blocks when no context budget evidence is available", () => {
  const noContextSummary = summary();
  const byArm = noContextSummary.by_arm as Array<Record<string, unknown>>;
  delete byArm[0].initial_context_chars;
  delete byArm[0].prompt_tokens;
  delete byArm[1].initial_context_chars;
  delete byArm[1].prompt_tokens;
  const report = evaluateAdmissionToolE2EGate({
    summary: noContextSummary,
    policy_mode: "active",
  });

  assert.equal(report.checks.input_integrity_pass, true);
  assert.equal(report.checks.context_budget_assessed, false);
  assert.equal(report.checks.context_budget_pass, null);
  assert.equal(report.metrics.context_budget_metric, "not_assessed");
  assert.equal(report.decision.eligible_for_default_active_review, false);
  assert.ok(report.decision.blocking_reasons.includes("context_budget_not_assessed"));
});

test("tool e2e gate blocks inconsistent accepted route rates", () => {
  const report = evaluateAdmissionToolE2EGate({
    summary: summary({
      accepted_direction_hits: 40,
      accepted_direction_rate: 0.5,
    }),
    policy_mode: "active",
  });

  assert.equal(report.checks.input_integrity_pass, true);
  assert.equal(report.checks.accepted_route_rate_consistent, false);
  assert.equal(report.decision.eligible_for_default_active_review, false);
  assert.ok(report.decision.blocking_reasons.includes("accepted_route_rate_inconsistent"));
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

test("tool e2e gate can require profile-scoped active source", () => {
  const report = evaluateAdmissionToolE2EGate({
    summary: summary(),
    policy_mode: "active",
    policy_source: "profile_rule",
    required_policy_source: "profile_rule",
    required_policy_profile_id: "external-agent-e2e-worker-full-power",
    policy_source_audit: {
      guide_count: 40,
      matching_source_count: 40,
      profile_id: "external-agent-e2e-worker-full-power",
      matching_profile_id_count: 40,
    },
  });

  assert.equal(report.decision.eligible_for_default_active_review, true);
  assert.equal(report.checks.required_policy_source_pass, true);
  assert.equal(report.checks.required_policy_profile_id_pass, true);
  assert.equal(report.required_policy_source, "profile_rule");
  assert.equal(report.required_policy_profile_id, "external-agent-e2e-worker-full-power");
});

test("tool e2e gate blocks when required profile-scoped source is not proven", () => {
  const report = evaluateAdmissionToolE2EGate({
    summary: summary(),
    policy_mode: "active",
    policy_source: "global_env",
    required_policy_source: "profile_rule",
    required_policy_profile_id: "external-agent-e2e-worker-full-power",
    policy_source_audit: {
      guide_count: 40,
      matching_source_count: 0,
      profile_id: "external-agent-e2e-worker-full-power",
      matching_profile_id_count: 0,
    },
  });

  assert.equal(report.decision.eligible_for_default_active_review, false);
  assert.equal(report.checks.required_policy_source_pass, false);
  assert.equal(report.checks.required_policy_profile_id_pass, false);
  assert.ok(report.decision.blocking_reasons.includes("candidate_policy_source_requirement_not_met"));
  assert.ok(report.decision.blocking_reasons.includes("candidate_policy_profile_requirement_not_met"));
});

test("tool e2e gate does not accept manual profile source without guide audit", () => {
  const report = evaluateAdmissionToolE2EGate({
    summary: summary(),
    policy_mode: "active",
    policy_source: "profile_rule",
    required_policy_source: "profile_rule",
  });

  assert.equal(report.decision.eligible_for_default_active_review, false);
  assert.equal(report.checks.required_policy_source_pass, false);
  assert.ok(report.decision.blocking_reasons.includes("candidate_policy_source_requirement_not_met"));
});
