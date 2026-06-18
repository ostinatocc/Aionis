import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  compareAdmissionPoliciesJsonl,
  formatAdmissionPolicyComparisonMarkdown,
} from "../../src/memory/admission-policy-comparison.js";

const EXAMPLE_ROWS = path.resolve("docs/examples/admission-dataset-rows.jsonl");

test("admission policy comparison ranks recorded Aionis admission against raw retrieval baselines", () => {
  const report = compareAdmissionPoliciesJsonl(fs.readFileSync(EXAMPLE_ROWS, "utf8"));
  assert.equal(report.contract_version, "aionis_admission_policy_comparison_report_v1");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.dataset.row_count, 4);
  assert.equal(report.sample_quality.minimum_rows_for_policy_claim, 100);
  assert.equal(report.sample_quality.not_enough_rows_for_policy_claim, true);
  assert.ok(report.caveats.some((caveat) => caveat.includes("Do not claim policy quality")));
  assert.equal(report.arms.length, 4);

  const byId = new Map(report.arms.map((arm) => [arm.policy_id, arm]));
  const aionis = byId.get("aionis_recorded_policy");
  const raw = byId.get("raw_retrieval_prompt_proxy");
  const alwaysUse = byId.get("always_use");
  const alwaysBlock = byId.get("always_block");
  assert.ok(aionis);
  assert.ok(raw);
  assert.ok(alwaysUse);
  assert.ok(alwaysBlock);

  assert.equal(aionis.direct_use_count, 2);
  assert.equal(aionis.positive_use_direct_count, 1);
  assert.equal(aionis.negative_use_direct_count, 1);
  assert.equal(aionis.blocked_or_suppressed_direct_count, 0);
  assert.equal(aionis.positive_capture_rate, 1);
  assert.equal(aionis.direct_use_risk_rate, 0.5);

  assert.equal(raw.direct_use_count, 4);
  assert.equal(raw.blocked_or_suppressed_direct_count, 2);
  assert.equal(raw.direct_use_risk_rate, 0.75);
  assert.equal(alwaysUse.direct_use_count, 4);
  assert.equal(alwaysBlock.direct_use_count, 0);
  assert.equal(alwaysBlock.missed_positive_use_count, 1);
  assert.equal(report.leaderboard[0]?.policy_id, "aionis_recorded_policy");
});

test("admission policy comparison formats markdown leaderboard", () => {
  const report = compareAdmissionPoliciesJsonl(fs.readFileSync(EXAMPLE_ROWS, "utf8"));
  const markdown = formatAdmissionPolicyComparisonMarkdown(report);
  assert.match(markdown, /Aionis Admission Policy Comparison/);
  assert.match(markdown, /Raw retrieval prompt proxy/);
  assert.match(markdown, /Enough rows for policy claim: no/);
  assert.match(markdown, /This is an offline proxy comparison/);
});
