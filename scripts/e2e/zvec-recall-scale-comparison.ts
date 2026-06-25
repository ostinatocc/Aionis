#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createLocalAnnIndex } from "../../src/store/ann/local-ann-index.js";
import { createZvecAnnIndex } from "../../src/store/ann/zvec-ann-index.js";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.js";
import { createLiteWriteStore } from "../../src/store/lite-write-store.js";
import type { RecallCandidate } from "../../src/store/recall-access.js";

type Provider = "off" | "local" | "zvec";

type ProviderRow = {
  provider: Provider;
  semantic_path: string;
  total_nodes: number;
  query_count: number;
  target_recall_at_10: number;
  target_recall_at_50: number;
  first_rank_hit_rate: number;
  p50_ms: number;
  p95_ms: number;
  mean_ms: number;
  index_rebuild_ms: number | null;
  index_rebuild_indexed: number | null;
  ann_source_ids: number;
  sqlite_truth_verified: boolean;
  first_query_top_ids: string[];
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "docs/examples/zvec-recall-scale-comparison");
const SCOPE = "zvec-scale/default";
const VECTOR_DIM = 32;
const TARGET_ID = "00000000-0000-4000-8000-00000000d001";

function parseArgs(argv: string[]): {
  outputDir: string;
  nodes: number;
  queries: number;
} {
  let outputDir = DEFAULT_OUTPUT_DIR;
  let nodes = 4096;
  let queries = 20;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output-dir") {
      outputDir = path.resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--nodes") {
      nodes = Math.max(2050, Math.trunc(Number(argv[i + 1] ?? nodes)));
      i += 1;
    } else if (arg === "--queries") {
      queries = Math.max(1, Math.trunc(Number(argv[i + 1] ?? queries)));
      i += 1;
    }
  }
  return { outputDir, nodes, queries };
}

function uuidSuffix(value: number): string {
  return value.toString(16).padStart(12, "0").slice(-12);
}

function nodeId(value: number): string {
  return `00000000-0000-4000-8000-${uuidSuffix(value)}`;
}

function targetVector(): number[] {
  return [1, ...Array.from({ length: VECTOR_DIM - 1 }, () => 0)];
}

function distractorVector(index: number): number[] {
  const vector = Array.from({ length: VECTOR_DIM }, (_, dim) => {
    const seed = Math.sin((index + 1) * (dim + 3) * 12.9898) * 43758.5453;
    return (seed - Math.floor(seed)) * 2 - 1;
  });
  vector[0] = Math.min(0.18, Math.abs(vector[0]) * 0.18);
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function queryVector(iteration: number): number[] {
  const vector = targetVector();
  const noise = (iteration % 5) * 0.001;
  if (noise > 0) {
    vector[1] = noise;
    const norm = Math.hypot(...vector);
    return vector.map((value) => Number((value / norm).toFixed(8)));
  }
  return vector;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round4(sorted[idx] ?? 0);
}

function mean(values: number[]): number {
  return round4(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

async function populateStore(dbPath: string, totalNodes: number): Promise<void> {
  const writeStore = createLiteWriteStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      const commitId = await writeStore.insertCommit({
        scope: SCOPE,
        parentCommitId: null,
        inputSha256: "zvec-scale-comparison",
        diffJson: "{}",
        actor: "zvec-scale-comparison",
        modelVersion: null,
        promptVersion: null,
        commitHash: "zvec-scale-comparison",
      });
      for (let index = 0; index < totalNodes - 1; index += 1) {
        await writeStore.insertNode({
          id: nodeId(index + 1),
          scope: SCOPE,
          clientId: null,
          type: "concept",
          tier: index % 11 === 0 ? "warm" : "hot",
          title: `high salience distractor ${index}`,
          textSummary: "High salience semantic distractor for bounded SQLite scan pressure.",
          slotsJson: JSON.stringify({ recall_scale_comparison_v1: true, role: "distractor" }),
          rawRef: null,
          evidenceRef: `fixture://zvec-scale/distractor/${index}`,
          embeddingVector: JSON.stringify(distractorVector(index)),
          embeddingModel: "deterministic-zvec-scale",
          memoryLane: "shared",
          producerAgentId: null,
          ownerAgentId: null,
          ownerTeamId: null,
          embeddingStatus: "ready",
          embeddingLastError: null,
          salience: 0.99,
          importance: 0.5,
          confidence: 0.99,
          redactionVersion: 0,
          commitId,
        });
      }
      await writeStore.insertNode({
        id: TARGET_ID,
        scope: SCOPE,
        clientId: null,
        type: "concept",
        tier: "hot",
        title: "low salience semantic needle",
        textSummary: "The semantically exact target intentionally sits below the bounded SQLite salience prefetch window.",
        slotsJson: JSON.stringify({ recall_scale_comparison_v1: true, role: "semantic_needle" }),
        rawRef: null,
        evidenceRef: "fixture://zvec-scale/target",
        embeddingVector: JSON.stringify(targetVector()),
        embeddingModel: "deterministic-zvec-scale",
        memoryLane: "shared",
        producerAgentId: null,
        ownerAgentId: null,
        ownerTeamId: null,
        embeddingStatus: "ready",
        embeddingLastError: null,
        salience: 0.01,
        importance: 0.5,
        confidence: 0.99,
        redactionVersion: 0,
        commitId,
      });
    });
  } finally {
    await writeStore.close();
  }
}

async function evaluateProvider(args: {
  provider: Provider;
  dbPath: string;
  zvecPath: string;
  totalNodes: number;
  queryCount: number;
}): Promise<ProviderRow> {
  const ann = args.provider === "local"
    ? {
        index: createLocalAnnIndex(),
        rebuildOnStart: true,
        maxCandidates: 256,
        sourceReason: "local_ann_index",
        indexName: "aionis_local_ann",
      }
    : args.provider === "zvec"
      ? {
          index: createZvecAnnIndex({ path: args.zvecPath }),
          rebuildOnStart: true,
          maxCandidates: 256,
          sourceReason: "zvec_ann_index",
          indexName: "aionis_zvec_ann",
        }
      : null;
  const recallStore = createLiteRecallStore(args.dbPath, { ann });
  try {
    let indexRebuildMs: number | null = null;
    let indexRebuildIndexed: number | null = null;
    if (ann) {
      const started = performance.now();
      const rebuilt = await recallStore.rebuildAnnIndex();
      indexRebuildMs = round4(performance.now() - started);
      indexRebuildIndexed = rebuilt.indexed;
    }
    const access = recallStore.createRecallAccess();
    const elapsed: number[] = [];
    let hitsAt10 = 0;
    let hitsAt50 = 0;
    let rank1 = 0;
    let annSourceIds = 0;
    let sqliteTruthVerified = true;
    let firstQueryTopIds: string[] = [];
    for (let queryIndex = 0; queryIndex < args.queryCount; queryIndex += 1) {
      const started = performance.now();
      const candidates = await access.stage1SemanticCandidates({
        queryEmbedding: queryVector(queryIndex),
        scope: SCOPE,
        oversample: 50,
        limit: 50,
        consumerAgentId: null,
        consumerTeamId: null,
      });
      elapsed.push(performance.now() - started);
      const ids = candidates.map((candidate) => candidate.id);
      if (queryIndex === 0) firstQueryTopIds = ids.slice(0, 10);
      if (ids.slice(0, 10).includes(TARGET_ID)) hitsAt10 += 1;
      if (ids.includes(TARGET_ID)) hitsAt50 += 1;
      if (ids[0] === TARGET_ID) rank1 += 1;
      for (const candidate of candidates) {
        if (candidate.sources?.some((source) => source.kind === "ann")) annSourceIds += 1;
        if (candidate.id === TARGET_ID && candidate.title !== "low salience semantic needle") sqliteTruthVerified = false;
      }
    }
    return {
      provider: args.provider,
      semantic_path: args.provider === "off"
        ? "bounded_sqlite_scan_plus_js_cosine"
        : `${args.provider}_ann_sidecar_then_sqlite_fact_verification`,
      total_nodes: args.totalNodes,
      query_count: args.queryCount,
      target_recall_at_10: round4(hitsAt10 / args.queryCount),
      target_recall_at_50: round4(hitsAt50 / args.queryCount),
      first_rank_hit_rate: round4(rank1 / args.queryCount),
      p50_ms: percentile(elapsed, 50),
      p95_ms: percentile(elapsed, 95),
      mean_ms: mean(elapsed),
      index_rebuild_ms: indexRebuildMs,
      index_rebuild_indexed: indexRebuildIndexed,
      ann_source_ids: annSourceIds,
      sqlite_truth_verified: sqliteTruthVerified,
      first_query_top_ids: firstQueryTopIds,
    };
  } finally {
    await recallStore.close();
  }
}

function markdown(rows: ProviderRow[]): string {
  const lines = [
    "# Zvec Recall Scale Comparison",
    "",
    "This recall-only diagnostic uses real Lite SQLite stores plus optional ANN sidecars. It stresses the known bounded-scan failure mode: a semantically exact but low-salience memory can sit outside SQLite's prefetch window.",
    "",
    "| Provider | Nodes | Queries | Recall@10 | Recall@50 | Rank-1 | P50 ms | P95 ms | Rebuild ms | ANN ids | SQLite truth |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    lines.push([
      row.provider,
      String(row.total_nodes),
      String(row.query_count),
      row.target_recall_at_10.toFixed(4),
      row.target_recall_at_50.toFixed(4),
      row.first_rank_hit_rate.toFixed(4),
      row.p50_ms.toFixed(4),
      row.p95_ms.toFixed(4),
      row.index_rebuild_ms === null ? "n/a" : row.index_rebuild_ms.toFixed(4),
      String(row.ann_source_ids),
      row.sqlite_truth_verified ? "pass" : "fail",
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push(
    "",
    "Interpretation:",
    "- `off` is the bounded SQLite JSON-vector scan path.",
    "- `local` and `zvec` use ANN only for candidate generation; final candidate rows are still loaded from SQLite truth.",
    "- This is not an admission or governance benchmark. It isolates candidate retrieval under a large hot-memory scope.",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    await import("@zvec/zvec");
  } catch {
    console.log(JSON.stringify({
      contract_version: "aionis_zvec_recall_scale_comparison_v1",
      skipped: true,
      reason: "@zvec/zvec optional dependency is not available on this platform",
    }, null, 2));
    return;
  }

  fs.mkdirSync(args.outputDir, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-zvec-scale-"));
  const dbPath = path.join(tmpRoot, "scale.sqlite");
  try {
    await populateStore(dbPath, args.nodes);
    const rows: ProviderRow[] = [];
    for (const provider of ["off", "local", "zvec"] as const) {
      rows.push(await evaluateProvider({
        provider,
        dbPath,
        zvecPath: path.join(tmpRoot, `${provider}.zvec`),
        totalNodes: args.nodes,
        queryCount: args.queries,
      }));
    }
    const summary = {
      contract_version: "aionis_zvec_recall_scale_comparison_v1",
      generated_at: new Date().toISOString(),
      scope: SCOPE,
      target_id: TARGET_ID,
      rows,
      caveats: [
        "Recall-only diagnostic; guide/admission governance is intentionally out of scope.",
        "Synthetic deterministic load is used to stress candidate retrieval behavior, not to make external benchmark claims.",
        "Latency is local-machine diagnostic data.",
      ],
    };
    fs.writeFileSync(path.join(args.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(path.join(args.outputDir, "summary.md"), markdown(rows));
    console.log(JSON.stringify({ output_dir: args.outputDir, rows }, null, 2));

    const zvec = rows.find((row) => row.provider === "zvec");
    assert.equal(zvec?.target_recall_at_10, 1);
    assert.equal(zvec?.sqlite_truth_verified, true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
