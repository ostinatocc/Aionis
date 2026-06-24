import assert from "node:assert/strict";
import test from "node:test";
import { admissionCandidatePolicyFixtureJsonl } from "./admission-dataset-fixture.ts";
import {
  evaluateAdmissionDatasetHoldoutJsonl,
  formatAdmissionDatasetHoldoutMarkdown,
} from "../../src/memory/admission-dataset-holdout.js";

const BASELINE_JSONL = admissionCandidatePolicyFixtureJsonl();

function parseRows(jsonl: string): Array<Record<string, unknown>> {
  return jsonl.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function uniqueCount(rows: Array<Record<string, unknown>>, field: string): number {
  return new Set(rows.map((row) => row[field]).filter((entry) => typeof entry === "string" && entry.length > 0)).size;
}

test("admission dataset holdout splits real Runtime rows by task signature", () => {
  const jsonl = BASELINE_JSONL;
  const rows = parseRows(jsonl);
  const report = evaluateAdmissionDatasetHoldoutJsonl(jsonl, {
    split_by: "task_signature",
    holdout_ratio: 0.3,
    seed: "holdout-test-seed",
  });

  assert.equal(report.contract_version, "aionis_admission_dataset_holdout_report_v1");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.split.split_by, "task_signature");
  assert.equal(report.split.group_count, uniqueCount(rows, "task_signature"));
  assert.equal(report.split.train_group_count + report.split.holdout_group_count, report.split.group_count);
  assert.equal(report.split.train_row_count + report.split.holdout_row_count, rows.length);
  assert.equal(report.checks.disjoint_groups, true);
  assert.equal(report.checks.train_has_rows, true);
  assert.equal(report.checks.holdout_has_rows, true);
  assert.ok(report.caveats.some((caveat) => caveat.includes("offline holdout validation")));
  assert.equal(report.holdout.policy_comparison.contract_version, "aionis_admission_policy_comparison_report_v1");
});

test("admission dataset holdout split is deterministic for the same seed", () => {
  const jsonl = BASELINE_JSONL;
  const first = evaluateAdmissionDatasetHoldoutJsonl(jsonl, {
    split_by: "task_signature",
    holdout_ratio: 0.3,
    seed: "stable-seed",
  });
  const second = evaluateAdmissionDatasetHoldoutJsonl(jsonl, {
    split_by: "task_signature",
    holdout_ratio: 0.3,
    seed: "stable-seed",
  });

  assert.deepEqual(first.split.train_groups, second.split.train_groups);
  assert.deepEqual(first.split.holdout_groups, second.split.holdout_groups);
});

test("admission dataset holdout can split by run id for chunk-like validation", () => {
  const jsonl = BASELINE_JSONL;
  const rows = parseRows(jsonl);
  const report = evaluateAdmissionDatasetHoldoutJsonl(jsonl, {
    split_by: "run_id",
    holdout_ratio: 0.2,
    seed: "run-id-seed",
  });

  assert.equal(report.split.split_by, "run_id");
  assert.equal(report.split.group_count, uniqueCount(rows, "run_id"));
  assert.equal(report.split.train_row_count + report.split.holdout_row_count, rows.length);
  assert.equal(report.checks.disjoint_groups, true);
  assert.ok(report.caveats.some((caveat) => caveat.includes("true chunk_id is not yet part of the dataset row contract")));
});

test("admission dataset holdout formats markdown report", () => {
  const jsonl = BASELINE_JSONL;
  const report = evaluateAdmissionDatasetHoldoutJsonl(jsonl, {
    split_by: "task_signature",
    holdout_ratio: 0.3,
    seed: "markdown-seed",
  });
  const markdown = formatAdmissionDatasetHoldoutMarkdown(report);

  assert.match(markdown, /Aionis Admission Dataset Holdout/);
  assert.match(markdown, /Holdout Policy Comparison/);
  assert.match(markdown, /recorded policy holdout leader/);
});
