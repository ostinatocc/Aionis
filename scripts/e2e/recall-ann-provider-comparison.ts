#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRecallEngineEval } from "./recall-engine-eval.js";

type AnnProvider = "off" | "local" | "zvec";

type ComparisonRow = {
  provider: AnnProvider;
  semantic_path: string;
  recall_at_50: number;
  candidate_source_coverage: number;
  do_not_use_stale_suppression: number | null;
  failed_branch_blocking: number | null;
  rehydrate_hit_rate: number | null;
  p50_recall_latency_ms: number | null;
  p95_recall_latency_ms: number | null;
  cases_with_ann_source: number;
  ids_with_ann_source: number;
  output_file: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "docs/examples/recall-ann-provider-comparison");
const PROVIDERS: readonly AnnProvider[] = ["off", "local", "zvec"];

function parseArgs(argv: string[]): {
  fixturePath?: string;
  outputDir: string;
  deterministicLatency: boolean;
} {
  let fixturePath: string | undefined;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let deterministicLatency = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixture") {
      fixturePath = path.resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--output-dir") {
      outputDir = path.resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--deterministic-latency") {
      deterministicLatency = true;
    }
  }
  return { fixturePath, outputDir, deterministicLatency };
}

function annSourceCounts(cases: Array<{ candidate_sources: Record<string, string[]> }>): {
  cases_with_ann_source: number;
  ids_with_ann_source: number;
} {
  let casesWithAnn = 0;
  let idsWithAnn = 0;
  for (const testCase of cases) {
    let caseHasAnn = false;
    for (const sources of Object.values(testCase.candidate_sources)) {
      if (sources.includes("ann")) {
        idsWithAnn += 1;
        caseHasAnn = true;
      }
    }
    if (caseHasAnn) casesWithAnn += 1;
  }
  return {
    cases_with_ann_source: casesWithAnn,
    ids_with_ann_source: idsWithAnn,
  };
}

function markdown(rows: ComparisonRow[], outputDir: string): string {
  const lines = [
    "# Recall ANN Provider Comparison",
    "",
    "This is a recall-only comparison over real Lite stores. ANN providers only generate candidates; SQLite remains the fact source and governance still decides admission.",
    "",
    `Output directory: \`${outputDir}\``,
    "",
    "| Provider | Recall@50 | Source coverage | Stale suppression | Failed blocking | Rehydrate | P50 ms | P95 ms | ANN cases | ANN ids |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    lines.push([
      row.provider,
      row.recall_at_50.toFixed(4),
      row.candidate_source_coverage.toFixed(4),
      row.do_not_use_stale_suppression === null ? "n/a" : row.do_not_use_stale_suppression.toFixed(4),
      row.failed_branch_blocking === null ? "n/a" : row.failed_branch_blocking.toFixed(4),
      row.rehydrate_hit_rate === null ? "n/a" : row.rehydrate_hit_rate.toFixed(4),
      row.p50_recall_latency_ms === null ? "n/a" : row.p50_recall_latency_ms.toFixed(4),
      row.p95_recall_latency_ms === null ? "n/a" : row.p95_recall_latency_ms.toFixed(4),
      String(row.cases_with_ann_source),
      String(row.ids_with_ann_source),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push(
    "",
    "Notes:",
    "- `ann` source satisfies the semantic-source family because it is the semantic vector candidate implementation.",
    "- Latency is local-machine diagnostic data. Use `--deterministic-latency` when committing stable fixture reports.",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outputDir, { recursive: true });
  const rows: ComparisonRow[] = [];
  for (const provider of PROVIDERS) {
    const outputFile = path.join(args.outputDir, `${provider}.json`);
    const zvecPath = provider === "zvec"
      ? path.join(os.tmpdir(), `aionis-recall-ann-compare-zvec-${process.pid}`)
      : null;
    const summary = await runRecallEngineEval({
      fixturePath: args.fixturePath,
      outputPath: outputFile,
      deterministicLatency: args.deterministicLatency,
      annProvider: provider,
      zvecPath,
    });
    rows.push({
      provider,
      semantic_path: summary.candidate_generation.semantic_path,
      recall_at_50: summary.metrics.recall_at_50,
      candidate_source_coverage: summary.metrics.candidate_source_coverage,
      do_not_use_stale_suppression: summary.metrics.do_not_use_stale_suppression,
      failed_branch_blocking: summary.metrics.failed_branch_blocking,
      rehydrate_hit_rate: summary.metrics.rehydrate_hit_rate,
      p50_recall_latency_ms: summary.metrics.p50_recall_latency_ms,
      p95_recall_latency_ms: summary.metrics.p95_recall_latency_ms,
      ...annSourceCounts(summary.cases),
      output_file: outputFile,
    });
  }

  const summaryPath = path.join(args.outputDir, "summary.json");
  const markdownPath = path.join(args.outputDir, "summary.md");
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    contract_version: "aionis_recall_ann_provider_comparison_v1",
    generated_at: args.deterministicLatency ? "1970-01-01T00:00:00.000Z" : new Date().toISOString(),
    deterministic_latency: args.deterministicLatency,
    rows,
  }, null, 2)}\n`);
  fs.writeFileSync(markdownPath, markdown(rows, args.outputDir));
  console.log(JSON.stringify({ output_dir: args.outputDir, summary: summaryPath, markdown: markdownPath, rows }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
