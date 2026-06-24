import assert from "node:assert/strict";
import test from "node:test";
import { admissionCandidatePolicyFixtureJsonl } from "./admission-dataset-fixture.ts";
import {
  formatAdmissionCounterfactualRerunMarkdown,
  rerunAdmissionCounterfactualJsonl,
} from "../../src/memory/admission-counterfactual-rerun.js";

const BASELINE_JSONL = admissionCandidatePolicyFixtureJsonl();

function baselineRowCount(): number {
  return BASELINE_JSONL.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

test("admission counterfactual rerun gates candidate policy before real Agent rerun", () => {
  const report = rerunAdmissionCounterfactualJsonl(BASELINE_JSONL, {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });

  assert.equal(report.contract_version, "aionis_admission_counterfactual_rerun_report_v1");
  assert.equal(report.intended_use, "offline_counterfactual_agent_action_validation");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.agent_mode, "deterministic_action_proxy");
  assert.equal(report.policy.candidate_policy_id, "candidate_project_context_closed_loop_inspect");
  assert.equal(report.split.evaluation_split, "holdout");
  assert.equal(report.dataset.row_count, baselineRowCount());
  assert.ok(report.dataset.evaluated_row_count >= 100);
  assert.ok(report.dataset.evaluated_group_count >= 6);
  assert.equal(report.checks.no_runtime_mutation, true);
  assert.equal(report.checks.deterministic_proxy_only, true);
  assert.equal(report.checks.candidate_no_hard_boundary_direct_use_regression, true);
  assert.equal(report.checks.candidate_no_negative_direct_risk_regression, true);
  assert.equal(report.checks.candidate_no_missed_actionable_memory_regression, true);
  assert.equal(report.checks.candidate_accepted_action_rate_not_worse, true);
  assert.equal(report.checks.candidate_changes_actions, true);
  assert.equal(report.checks.eligible_for_real_agent_rerun, true);
  assert.ok(report.candidate_arm.changed_action_count > 0);
  assert.ok(report.candidate_arm.non_actionable_direct_attention_count < report.recorded_arm.non_actionable_direct_attention_count);
  assert.ok(report.candidate_arm.accepted_action_rate >= report.recorded_arm.accepted_action_rate);
  assert.ok(report.candidate_arm.hard_boundary_direct_use_count <= report.recorded_arm.hard_boundary_direct_use_count);
  assert.ok(report.candidate_arm.negative_direct_risk_count <= report.recorded_arm.negative_direct_risk_count);
});

test("admission counterfactual rerun preserves explicit candidate selection", () => {
  const report = rerunAdmissionCounterfactualJsonl(BASELINE_JSONL, {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
    candidate_policy_id: "candidate_external_current_inspect",
  });

  assert.equal(report.policy.candidate_policy_id, "candidate_external_current_inspect");
  assert.equal(report.policy.selected_by_candidate_evaluator, false);
  assert.equal(report.checks.no_runtime_mutation, true);
});

test("admission counterfactual rerun formats markdown", () => {
  const report = rerunAdmissionCounterfactualJsonl(BASELINE_JSONL, {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });
  const markdown = formatAdmissionCounterfactualRerunMarkdown(report);

  assert.match(markdown, /Aionis Admission Counterfactual Rerun/);
  assert.match(markdown, /deterministic_action_proxy/);
  assert.match(markdown, /eligible for real Agent rerun/);
  assert.match(markdown, /not a real LLM Agent rerun/);
});
