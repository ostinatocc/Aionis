import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  evaluateAdmissionCandidatePoliciesJsonl,
  formatAdmissionCandidatePolicyEvaluationMarkdown,
} from "../../src/memory/admission-candidate-policy-evaluator.js";

const BASELINE_ROWS = path.resolve("admission-dataset/rows.jsonl");

test("admission candidate policy evaluator selects and validates a label-safe holdout candidate", () => {
  const report = evaluateAdmissionCandidatePoliciesJsonl(fs.readFileSync(BASELINE_ROWS, "utf8"), {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });

  assert.equal(report.contract_version, "aionis_admission_candidate_policy_evaluation_report_v1");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.guards.label_leakage_guard, true);
  assert.equal(report.guards.hard_actions_preserved, true);
  assert.ok(report.guards.forbidden_decision_fields.includes("outcome_label"));
  assert.ok(report.guards.forbidden_decision_fields.includes("feedback_outcome"));
  assert.ok(report.guards.forbidden_decision_fields.includes("title"));
  assert.ok(report.train_leaderboard.length >= 4);
  assert.ok(report.holdout_scores.length >= 4);
  for (const score of [...report.train_leaderboard, ...report.holdout_scores]) {
    for (const field of score.used_fields) {
      assert.equal(report.guards.forbidden_decision_fields.includes(field), false);
    }
  }
  assert.equal(report.split.train_row_count, 118);
  assert.equal(report.split.holdout_row_count, 293);
  assert.equal(report.split.train_group_count, 12);
  assert.equal(report.split.holdout_group_count, 13);
  assert.notEqual(report.selected_policy_id, "recorded_policy_baseline");
  assert.equal(report.promotion_gate.no_hard_boundary_regression, true);
  assert.equal(report.promotion_gate.no_positive_capture_regression, true);
  assert.equal(report.promotion_gate.changed_actions_on_holdout, true);
  assert.equal(report.promotion_gate.train_candidate_supported, true);
  assert.equal(report.promotion_gate.eligible_for_manual_review, true);
  assert.equal(report.selected_policy.holdout.hard_boundary_direct_count, 0);
  assert.ok(report.selected_policy.holdout.calibration_score >= report.recorded_policy.holdout.calibration_score);
  assert.ok(report.caveats.some((caveat) => caveat.includes("manual review only")));
});

test("admission candidate policy evaluator keeps hard boundaries from being upgraded", () => {
  const report = evaluateAdmissionCandidatePoliciesJsonl(fs.readFileSync(BASELINE_ROWS, "utf8"), {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });

  for (const score of [...report.train_leaderboard, ...report.holdout_scores]) {
    assert.equal(score.blocked_or_suppressed_direct_count, 0);
    assert.equal(score.rehydrate_direct_count, 0);
    assert.equal(score.hard_boundary_direct_count, 0);
  }
});

test("admission candidate policy evaluator formats markdown", () => {
  const report = evaluateAdmissionCandidatePoliciesJsonl(fs.readFileSync(BASELINE_ROWS, "utf8"), {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });
  const markdown = formatAdmissionCandidatePolicyEvaluationMarkdown(report);

  assert.match(markdown, /Aionis Admission Candidate Policy Evaluation/);
  assert.match(markdown, /Holdout Promotion Gate/);
  assert.match(markdown, /Forbidden decision fields/);
});
