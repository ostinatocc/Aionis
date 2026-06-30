import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOrdinaryMemoryRetrievalEval } from "../e2e/ordinary-memory-retrieval-eval.ts";

function tmpOutputPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-ordinary-memory-retrieval-eval-test-"));
  return path.join(dir, "summary.json");
}

test("ordinary memory retrieval eval measures construction-backed evidence hits", async () => {
  const outputPath = tmpOutputPath();
  const summary = await runOrdinaryMemoryRetrievalEval({
    outputPath,
    deterministicLatency: true,
  });

  assert.equal(summary.contract_version, "aionis_ordinary_memory_retrieval_baseline_v1");
  assert.equal(summary.generated_at, "1970-01-01T00:00:00.000Z");
  assert.equal(summary.case_count, 7);
  assert.equal(summary.cases.length, 7);
  assert.equal(summary.candidate_generation.write_path, "prepareMemoryWrite_applyMemoryWrite_real_lite_store");
  assert.equal(summary.candidate_generation.construction_path, "ordinary_memory_v1_deterministic_runtime_write");
  assert.equal(summary.candidate_generation.governance_admission, "out_of_scope_for_recall_only_eval");
  assert.equal(summary.metrics.ordinary_construction_coverage, 1);
  assert.equal(summary.metrics.lexical_evidence_hit_at_5, 1);
  assert.equal(summary.metrics.hybrid_evidence_hit_at_5, 1);
  assert.equal(summary.metrics.lexical_evidence_top1, 1);
  assert.ok(summary.metrics.lexical_mean_reciprocal_rank >= 1);
  assert.equal(summary.metrics.slots_text_source_hit_rate, 1);
  assert.ok(fs.existsSync(outputPath));

  const fromDisk = JSON.parse(fs.readFileSync(outputPath, "utf8")) as typeof summary;
  assert.deepEqual(fromDisk.metrics, summary.metrics);
  for (const result of summary.cases) {
    assert.equal(result.lexical_hit_at_5, true, `${result.case_id} missed lexical evidence`);
    assert.equal(result.hybrid_hit_at_5, true, `${result.case_id} missed hybrid evidence`);
    assert.equal(result.lexical_top1, true, `${result.case_id} did not rank lexical evidence first`);
    assert.equal(result.slots_text_source_hit, true, `${result.case_id} did not hit slots_text`);
    assert.deepEqual(result.missing_ordinary_fields, [], `${result.case_id} missing ordinary fields`);
    assert.ok(result.source_kinds_for_expected.includes("lexical"), `${result.case_id} missing lexical source`);
  }

  const noisyCase = summary.cases.find((result) => result.case_id === "ordinary_rank_under_noise");
  assert.ok(noisyCase);
  assert.equal(noisyCase.lexical_rank, 1);
  assert.equal(noisyCase.lexical_top_ids[0], noisyCase.expected_node_id);
});
