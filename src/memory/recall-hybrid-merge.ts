import type { RecallCandidate, RecallCandidateSource } from "../store/recall-access.js";

export type RecallHybridSourceBuckets = {
  semantic?: RecallCandidate[];
  lexical?: RecallCandidate[];
  structured?: RecallCandidate[];
  executionNative?: RecallCandidate[];
  graph?: RecallCandidate[];
  recent?: RecallCandidate[];
  exactRecovery?: RecallCandidate[];
};

export function reciprocalRankFusion(rank: number, k = 60): number {
  const normalizedRank = Number.isFinite(rank) ? Math.max(1, Math.trunc(rank)) : 1;
  const normalizedK = Number.isFinite(k) ? Math.max(1, k) : 60;
  return 1 / (normalizedK + normalizedRank);
}

function sourceKey(source: RecallCandidateSource): string {
  return [
    source.kind,
    source.reason,
    source.index_name ?? "",
    ...(source.matched_fields ?? []),
  ].join("\u0000");
}

function mergeSources(existing: RecallCandidateSource[], next: readonly RecallCandidateSource[] | undefined): RecallCandidateSource[] {
  const out = [...existing];
  const seen = new Set(out.map(sourceKey));
  for (const source of next ?? []) {
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

export function mergeRecallCandidatesByRrf(args: RecallHybridSourceBuckets & {
  limit: number;
  rrfK?: number;
}): RecallCandidate[] {
  if (args.limit <= 0) return [];
  const buckets: Array<[keyof RecallHybridSourceBuckets, RecallCandidate[] | undefined]> = [
    ["semantic", args.semantic],
    ["lexical", args.lexical],
    ["structured", args.structured],
    ["executionNative", args.executionNative],
    ["graph", args.graph],
    ["recent", args.recent],
    ["exactRecovery", args.exactRecovery],
  ];
  const merged = new Map<string, {
    candidate: RecallCandidate;
    rawScore: number;
    bestInputScore: number;
    sourceCount: number;
  }>();

  for (const [_bucketName, candidates] of buckets) {
    for (const [index, candidate] of (candidates ?? []).entries()) {
      const rankScore = reciprocalRankFusion(index + 1, args.rrfK);
      const previous = merged.get(candidate.id);
      if (!previous) {
        merged.set(candidate.id, {
          candidate: {
            ...candidate,
            sources: mergeSources([], candidate.sources),
          },
          rawScore: rankScore,
          bestInputScore: candidate.similarity,
          sourceCount: candidate.sources?.length ?? 0,
        });
        continue;
      }
      previous.rawScore += rankScore;
      previous.bestInputScore = Math.max(previous.bestInputScore, candidate.similarity);
      previous.candidate = {
        ...previous.candidate,
        title: previous.candidate.title ?? candidate.title,
        text_summary: previous.candidate.text_summary ?? candidate.text_summary,
        tier: previous.candidate.tier,
        salience: Math.max(previous.candidate.salience, candidate.salience),
        confidence: Math.max(previous.candidate.confidence, candidate.confidence),
        sources: mergeSources(previous.candidate.sources ?? [], candidate.sources),
      };
      previous.sourceCount = previous.candidate.sources?.length ?? 0;
    }
  }

  const rows = Array.from(merged.values());
  const maxRawScore = Math.max(0, ...rows.map((row) => row.rawScore));
  return rows
    .map((row) => ({
      ...row,
      candidate: {
        ...row.candidate,
        similarity: maxRawScore > 0 ? row.rawScore / maxRawScore : 0,
      },
    }))
    .sort((a, b) =>
      b.rawScore - a.rawScore
      || b.sourceCount - a.sourceCount
      || b.bestInputScore - a.bestInputScore
      || b.candidate.salience - a.candidate.salience
      || b.candidate.confidence - a.candidate.confidence
      || a.candidate.id.localeCompare(b.candidate.id))
    .slice(0, args.limit)
    .map((row) => row.candidate);
}
