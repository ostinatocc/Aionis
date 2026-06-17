import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRecallEngineEval } from "../e2e/recall-engine-eval.ts";

function tmpOutputPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-recall-engine-eval-test-"));
  return path.join(dir, "summary.json");
}

test("recall engine eval runs against real Lite stores and emits baseline metrics", async () => {
  const outputPath = tmpOutputPath();
  const summary = await runRecallEngineEval({
    outputPath,
    deterministicLatency: true,
  });

  assert.equal(summary.contract_version, "aionis_recall_engine_baseline_v1");
  assert.equal(summary.generated_at, "1970-01-01T00:00:00.000Z");
  assert.equal(summary.case_count, 20);
  assert.equal(summary.cases.length, 20);
  assert.equal(summary.candidate_generation.semantic_path, "bounded_sqlite_scan_plus_js_cosine_with_source_trace");
  assert.equal(summary.candidate_generation.graph_path, "lite_memory_edges_neighbor_expansion");
  assert.equal(summary.candidate_generation.recent_path, "lite_hot_working_set_created_at_scan");
  assert.equal(summary.candidate_generation.governance_admission, "out_of_scope_for_recall_only_baseline");
  assert.ok(summary.recall_access_capability_version >= 4);
  assert.equal(summary.metrics.recall_at_50, 1);
  assert.equal(summary.metrics.candidate_source_coverage, 1);
  assert.equal(summary.metrics.use_now_precision_after_governance, null);
  assert.equal(summary.metrics.inspect_before_use_correctness, null);
  assert.ok(summary.metrics.failed_branch_blocking !== null);
  assert.ok(summary.metrics.do_not_use_stale_suppression !== null);
  assert.ok(summary.metrics.rehydrate_hit_rate !== null);
  assert.equal(summary.metrics.p50_recall_latency_ms, null);
  assert.equal(summary.metrics.p95_recall_latency_ms, null);
  assert.ok(fs.existsSync(outputPath));

  const fromDisk = JSON.parse(fs.readFileSync(outputPath, "utf8")) as typeof summary;
  assert.equal(fromDisk.case_count, summary.case_count);
  assert.deepEqual(
    fromDisk.cases.map((entry) => entry.case_id),
    summary.cases.map((entry) => entry.case_id),
  );
  for (const result of summary.cases) {
    assert.deepEqual(result.missed_required_ids, [], `${result.case_id} missed required recall IDs`);
    assert.deepEqual(result.missing_required_sources, [], `${result.case_id} missed required recall source families`);
  }

  const recentCase = summary.cases.find((entry) => entry.case_id === "case17_recent_working_set");
  assert.ok(recentCase);
  assert.ok(recentCase.candidate_sources["case17-recent"]?.includes("recent"));

  const graphCase = summary.cases.find((entry) => entry.case_id === "case18_graph_neighbor_needed");
  assert.ok(graphCase);
  assert.ok(graphCase.candidate_sources["case18-verifier"]?.includes("graph"));
});
