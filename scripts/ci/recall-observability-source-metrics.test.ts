import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRecallEngineEval } from "../e2e/recall-engine-eval.ts";

function tmpOutputPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-recall-source-metrics-test-"));
  return path.join(dir, "summary.json");
}

test("recall eval emits source metrics from real Lite candidate generation", async () => {
  const outputPath = tmpOutputPath();
  const summary = await runRecallEngineEval({
    outputPath,
    deterministicLatency: true,
  });

  const sourceSummary = summary.source_observability;
  assert.equal(sourceSummary.stage1_sources.semantic.case_count, summary.case_count);
  assert.ok(sourceSummary.stage1_sources.semantic.total_candidates > 0);
  assert.ok(sourceSummary.stage1_sources.lexical.total_candidates > 0);
  assert.ok(sourceSummary.stage1_sources.structured.total_candidates > 0);
  assert.ok(sourceSummary.stage1_sources.execution_native.total_candidates > 0);
  assert.ok(sourceSummary.stage1_sources.exact_recovery.total_candidates > 0);
  assert.equal(sourceSummary.stage1_sources.semantic.p50_latency_ms, null);
  assert.equal(sourceSummary.stage1_sources.lexical.p95_latency_ms, null);

  assert.equal(sourceSummary.hybrid_merge.case_count, summary.case_count);
  assert.ok(sourceSummary.hybrid_merge.total_input_count >= sourceSummary.hybrid_merge.total_output_count);
  assert.ok(sourceSummary.hybrid_merge.total_duplicate_candidate_count > 0);
  assert.ok(sourceSummary.candidate_overlap.length > 0);
  assert.ok(sourceSummary.candidate_overlap.some((entry) =>
    entry.source_a === "semantic" && entry.source_b === "exact_recovery" && entry.total_overlap_count > 0
  ));

  const firstCase = summary.cases[0];
  assert.ok(firstCase);
  assert.ok(firstCase.source_observability.stage1_sources.semantic.candidate_count > 0);
  assert.ok(firstCase.source_observability.hybrid_merge.output_count > 0);
  assert.ok(firstCase.source_observability.candidate_overlap.length > 0);
  assert.ok(fs.existsSync(outputPath));
});
