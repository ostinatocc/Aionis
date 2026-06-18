import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  formatAdmissionCounterfactualRerunMarkdown,
  rerunAdmissionCounterfactualJsonl,
} from "../../src/memory/admission-counterfactual-rerun.js";

const BASELINE_ROWS = path.resolve("admission-dataset/rows.jsonl");

test("admission counterfactual rerun gates candidate policy before real Agent rerun", () => {
  const report = rerunAdmissionCounterfactualJsonl(fs.readFileSync(BASELINE_ROWS, "utf8"), {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });

  assert.equal(report.contract_version, "aionis_admission_counterfactual_rerun_report_v1");
  assert.equal(report.intended_use, "offline_counterfactual_agent_action_validation");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.agent_mode, "deterministic_action_proxy");
  assert.equal(report.policy.candidate_policy_id, "candidate_aionis_project_context_only");
  assert.equal(report.split.evaluation_split, "holdout");
  assert.equal(report.dataset.row_count, 411);
  assert.equal(report.dataset.evaluated_row_count, 293);
  assert.equal(report.dataset.evaluated_group_count, 13);
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
  const report = rerunAdmissionCounterfactualJsonl(fs.readFileSync(BASELINE_ROWS, "utf8"), {
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
  const report = rerunAdmissionCounterfactualJsonl(fs.readFileSync(BASELINE_ROWS, "utf8"), {
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
