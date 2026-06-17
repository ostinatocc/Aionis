import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectAdmissionDatasetRows } from "../../src/memory/admission-dataset-collector.js";

const EXAMPLE_ROWS = path.resolve("docs/examples/admission-dataset-rows.jsonl");

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aionis-admission-collector-"));
}

function jsonLineCount(file: string): number {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

test("admission dataset collector appends chunks, writes manifest, and refreshes evaluation", () => {
  const datasetDir = tempDir();
  const first = collectAdmissionDatasetRows({
    dataset_dir: datasetDir,
    input_files: [EXAMPLE_ROWS],
    chunk_id: "example-one",
  });

  assert.equal(first.contract_version, "aionis_admission_dataset_collector_result_v1");
  assert.equal(first.appended_row_count, 4);
  assert.equal(first.previous_row_count, 0);
  assert.equal(first.total_row_count, 4);
  assert.equal(first.input_files.length, 1);
  assert.equal(first.input_files[0]?.row_count, 4);
  assert.equal(first.checks.append_only, true);
  assert.equal(first.checks.row_count_matches_jsonl, true);
  assert.equal(first.checks.prompt_payload_excluded, true);
  assert.equal(first.checks.raw_slots_excluded, true);
  assert.equal(first.checks.embeddings_excluded, true);
  assert.equal(first.evaluation?.dataset.row_count, 4);
  assert.ok(fs.existsSync(first.rows_path));
  assert.ok(fs.existsSync(first.manifest_path));
  assert.ok(first.summary_path && fs.existsSync(first.summary_path));
  assert.ok(first.leaderboard_path && fs.existsSync(first.leaderboard_path));
  assert.ok(first.policy_comparison_path && fs.existsSync(first.policy_comparison_path));
  assert.ok(first.policy_comparison_markdown_path && fs.existsSync(first.policy_comparison_markdown_path));
  assert.equal(first.policy_comparison?.contract_version, "aionis_admission_policy_comparison_report_v1");
  assert.equal(jsonLineCount(first.rows_path), 4);

  const manifest = JSON.parse(fs.readFileSync(first.manifest_path, "utf8")) as Record<string, unknown>;
  assert.equal(manifest.contract_version, "aionis_admission_dataset_collect_manifest_v1");
  assert.equal(manifest.runtime_mutation, false);
  assert.equal(manifest.agent_prompt_included, false);
  assert.equal(manifest.appended_row_count, 4);
  assert.equal(manifest.total_row_count, 4);

  const second = collectAdmissionDatasetRows({
    dataset_dir: datasetDir,
    input_files: [EXAMPLE_ROWS],
    chunk_id: "example-two",
  });
  assert.equal(second.appended_row_count, 4);
  assert.equal(second.previous_row_count, 4);
  assert.equal(second.total_row_count, 8);
  assert.equal(second.evaluation?.dataset.row_count, 8);
  assert.equal(second.policy_comparison?.dataset.row_count, 8);
  assert.equal(jsonLineCount(second.rows_path), 8);
});

test("admission dataset collector rejects forbidden raw payload keys", () => {
  const datasetDir = tempDir();
  const sourceRow = JSON.parse(fs.readFileSync(EXAMPLE_ROWS, "utf8").split(/\r?\n/)[0] ?? "{}") as Record<string, unknown>;
  sourceRow.prompt_text = "raw prompt must not enter the admission dataset";
  const leakedFile = path.join(datasetDir, "leaked.jsonl");
  fs.writeFileSync(leakedFile, `${JSON.stringify(sourceRow)}\n`);

  assert.throws(
    () => collectAdmissionDatasetRows({
      dataset_dir: datasetDir,
      input_files: [leakedFile],
      chunk_id: "leaked",
    }),
    /forbidden key prompt_text/,
  );
});
