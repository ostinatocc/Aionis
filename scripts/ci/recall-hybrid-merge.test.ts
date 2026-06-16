import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeRecallCandidatesByRrf,
  reciprocalRankFusion,
} from "../../src/memory/recall-hybrid-merge.ts";
import type { RecallCandidate, RecallCandidateSourceKind } from "../../src/store/recall-access.ts";

function candidate(id: string, similarity: number, kind: RecallCandidateSourceKind): RecallCandidate {
  return {
    id,
    type: "concept",
    title: id,
    text_summary: id,
    tier: "hot",
    salience: 0.5,
    confidence: 0.5,
    similarity,
    sources: [{
      kind,
      score: similarity,
      reason: `${kind}_test_source`,
      matched_fields: [kind],
      index_name: `${kind}_index`,
    }],
  };
}

test("reciprocal rank fusion is deterministic and one-based", () => {
  assert.equal(reciprocalRankFusion(1), 1 / 61);
  assert.equal(reciprocalRankFusion(4), 1 / 64);
  assert.equal(reciprocalRankFusion(0), 1 / 61);
});

test("hybrid merge deduplicates ids while preserving source traces", () => {
  const merged = mergeRecallCandidatesByRrf({
    semantic: [candidate("shared", 0.7, "semantic")],
    lexical: [candidate("shared", 0.5, "lexical")],
    structured: [candidate("other", 0.9, "structured")],
    limit: 5,
  });
  const shared = merged.find((item) => item.id === "shared");
  assert.ok(shared);
  assert.deepEqual(shared.sources?.map((source) => source.kind).sort(), ["lexical", "semantic"]);
  assert.ok((shared.similarity ?? 0) <= 1);
});

test("multi-source lower semantic rank can beat semantic-only neighbor", () => {
  const semantic = [
    candidate("semantic-1", 0.9, "semantic"),
    candidate("semantic-2", 0.8, "semantic"),
    candidate("semantic-3", 0.7, "semantic"),
    candidate("multi-source", 0.6, "semantic"),
    candidate("semantic-only-5", 0.5, "semantic"),
  ];
  const merged = mergeRecallCandidatesByRrf({
    semantic,
    lexical: [candidate("multi-source", 0.95, "lexical")],
    limit: 5,
  });
  assert.ok(
    merged.findIndex((item) => item.id === "multi-source")
      < merged.findIndex((item) => item.id === "semantic-only-5"),
  );
});

test("hybrid merge does not decide memory admission", () => {
  const merged = mergeRecallCandidatesByRrf({
    semantic: [candidate("unsafe-looking-candidate", 0.9, "semantic")],
    structured: [{
      ...candidate("unsafe-looking-candidate", 0.8, "structured"),
      sources: [{
        kind: "structured",
        score: 0.8,
        reason: "failed_branch_candidate_source",
        matched_fields: ["failure_mode"],
        index_name: "test",
      }],
    }],
    limit: 1,
  });
  assert.equal(merged[0]?.id, "unsafe-looking-candidate");
  assert.ok(merged[0]?.sources?.some((source) => source.reason === "failed_branch_candidate_source"));
  assert.equal("action" in (merged[0] as Record<string, unknown>), false);
});
