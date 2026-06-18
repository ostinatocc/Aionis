#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type CliArgs = {
  datasetDir: string | null;
  iterations: number;
  chunkPrefix: string;
  stopOnFailure: boolean;
  profile: "standard" | "targeted-external-current" | "closed-loop-prior" | "closed-loop-prior-fresh" | "closed-loop-prior-fresh-2";
};

type BatchChunk = {
  iteration: number;
  chunk_id: string;
  run_id: string | null;
  row_count: number;
  appended_row_count: number | null;
  total_row_count: number | null;
  chunk_path: string | null;
  manifest_path: string | null;
  summary_path: string | null;
  policy_comparison_path: string | null;
  shadow_policy_path: string | null;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): CliArgs {
  const envProfile = process.env.AIONIS_ADMISSION_DATASET_PROFILE;
  const out: CliArgs = {
    datasetDir: process.env.AIONIS_ADMISSION_DATASET_DIR?.trim() || null,
    iterations: positiveInteger(process.env.AIONIS_ADMISSION_BATCH_ITERATIONS, 25),
    chunkPrefix: process.env.AIONIS_ADMISSION_BATCH_CHUNK_PREFIX?.trim() || "runtime-batch",
    stopOnFailure: true,
    profile: envProfile === "targeted-external-current"
      || envProfile === "closed-loop-prior"
      || envProfile === "closed-loop-prior-fresh"
      || envProfile === "closed-loop-prior-fresh-2"
      ? envProfile
      : "standard",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--dataset-dir" && next) {
      out.datasetDir = next;
      i += 1;
    } else if (arg === "--iterations" && next) {
      out.iterations = positiveInteger(next, out.iterations);
      i += 1;
    } else if (arg === "--chunk-prefix" && next) {
      out.chunkPrefix = next;
      i += 1;
    } else if (arg === "--continue-on-failure") {
      out.stopOnFailure = false;
    } else if (arg === "--profile" && next) {
      out.profile = next === "targeted-external-current"
        || next === "closed-loop-prior"
        || next === "closed-loop-prior-fresh"
        || next === "closed-loop-prior-fresh-2"
        ? next
        : "standard";
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s admission:batch-collect -- --dataset-dir admission-dataset [--iterations 25] [--profile standard|targeted-external-current|closed-loop-prior|closed-loop-prior-fresh|closed-loop-prior-fresh-2]",
        "",
        "Runs the real admission dataset Runtime e2e repeatedly and appends each chunk",
        "to the same durable admission dataset.",
        "",
      ].join("\n"));
      process.exit(0);
    }
  }
  return out;
}

function lastJsonObject(stdout: string): Record<string, unknown> {
  const start = stdout.lastIndexOf("\n{");
  const json = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("batch child did not return an object JSON result");
  }
  return parsed as Record<string, unknown>;
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readJson(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  return nestedRecord(parsed);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runIteration(args: {
  datasetDir: string;
  iteration: number;
  chunkId: string;
  profile: CliArgs["profile"];
}): BatchChunk {
  const childArgs = [
    "tsx",
    "scripts/e2e/admission-dataset-export-loop.ts",
    "--dataset-dir",
    args.datasetDir,
    "--chunk-id",
    args.chunkId,
    "--profile",
    args.profile,
  ];
  const child = spawnSync("npx", childArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.status !== 0) {
    throw new Error([
      `admission dataset e2e iteration ${args.iteration} failed with status ${child.status}`,
      child.stdout.trim(),
      child.stderr.trim(),
    ].filter(Boolean).join("\n"));
  }
  const result = lastJsonObject(child.stdout);
  const exportResult = nestedRecord(result.admission_dataset_export);
  const collector = nestedRecord(result.collector);
  return {
    iteration: args.iteration,
    chunk_id: args.chunkId,
    run_id: stringValue(result.run_id),
    row_count: numberValue(exportResult?.row_count) ?? 0,
    appended_row_count: numberValue(collector?.appended_row_count),
    total_row_count: numberValue(collector?.total_row_count),
    chunk_path: stringValue(exportResult?.chunk_path),
    manifest_path: stringValue(collector?.manifest_path),
    summary_path: stringValue(collector?.summary_path),
    policy_comparison_path: stringValue(collector?.policy_comparison_path),
    shadow_policy_path: stringValue(collector?.shadow_policy_path),
  };
}

function markdownReport(result: Record<string, unknown>): string {
  const chunks = Array.isArray(result.chunks) ? result.chunks as BatchChunk[] : [];
  const sampleQuality = nestedRecord(result.sample_quality);
  const shadow = nestedRecord(result.shadow_policy);
  const shadowDelta = nestedRecord(shadow?.delta);
  const shadowGuards = nestedRecord(shadow?.guards);
  const lines = [
    "# Aionis Admission Batch Collect",
    "",
    String(result.summary ?? ""),
    "",
    "| Gate | Value |",
    "|---|---:|",
    `| Profile | ${String(result.profile ?? "")} |`,
    `| Final rows | ${String(result.final_row_count ?? "")} |`,
    `| Enough rows for policy claim | ${sampleQuality?.has_minimum_rows_for_policy_claim === true ? "yes" : "no"} |`,
    `| Enough task signatures for diversity claim | ${sampleQuality?.has_minimum_task_signatures_for_diversity_claim === true ? "yes" : "no"} |`,
    `| Shadow hard actions preserved | ${shadowGuards?.hard_actions_preserved === true ? "yes" : "no"} |`,
    `| Shadow changed actions | ${String(shadowDelta?.changed_action_count ?? "")} |`,
    `| Shadow would downgrade use_now | ${String(shadowDelta?.would_downgrade_use_now_count ?? "")} |`,
    `| Shadow negative direct delta | ${String(shadowDelta?.negative_direct_delta ?? "")} |`,
    "",
    "| Iteration | Chunk | Rows | Total rows |",
    "|---:|---|---:|---:|",
    ...chunks.map((chunk) => `| ${chunk.iteration} | ${chunk.chunk_id} | ${chunk.row_count} | ${chunk.total_row_count ?? ""} |`),
    "",
  ];
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.datasetDir) throw new Error("Missing --dataset-dir admission-dataset");
  const datasetDir = path.resolve(args.datasetDir);
  const chunks: BatchChunk[] = [];
  const failures: Array<{ iteration: number; error: string }> = [];
  for (let index = 0; index < args.iterations; index += 1) {
    const iteration = index + 1;
    const chunkId = `${args.chunkPrefix}-${String(iteration).padStart(3, "0")}`;
    try {
      chunks.push(runIteration({ datasetDir, iteration, chunkId, profile: args.profile }));
    } catch (err) {
      failures.push({ iteration, error: (err as Error).message });
      if (args.stopOnFailure) break;
    }
  }
  const latestSummaryPath = path.join(datasetDir, "reports", "latest", "summary.json");
  const latestComparisonPath = path.join(datasetDir, "reports", "latest", "policy_comparison.json");
  const latestShadowPolicyPath = path.join(datasetDir, "reports", "latest", "shadow_policy.json");
  const latestSummary = readJson(latestSummaryPath);
  const latestComparison = readJson(latestComparisonPath);
  const latestShadowPolicy = readJson(latestShadowPolicyPath);
  const sampleQuality = nestedRecord(latestSummary?.sample_quality);
  const rowCount = numberValue(nestedRecord(latestSummary?.dataset)?.row_count) ?? chunks.at(-1)?.total_row_count ?? 0;
  const result = {
    contract_version: "aionis_admission_batch_collect_result_v1",
    intended_use: "real_runtime_admission_dataset_batch_collection",
    runtime_mutation: false,
    agent_prompt_included: false,
    dataset_dir: datasetDir,
    profile: args.profile,
    iterations_requested: args.iterations,
    iterations_completed: chunks.length,
    failure_count: failures.length,
    chunks,
    failures,
    rows_path: path.join(datasetDir, "rows.jsonl"),
    summary_path: latestSummaryPath,
    policy_comparison_path: latestComparisonPath,
    shadow_policy_path: latestShadowPolicyPath,
    final_row_count: rowCount,
    sample_quality: sampleQuality,
    policy_comparison_leader: stringValue(nestedRecord((Array.isArray(latestComparison?.leaderboard) ? latestComparison?.leaderboard[0] : null))?.policy_id),
    shadow_policy: latestShadowPolicy,
    checks: {
      completed_all_iterations: chunks.length === args.iterations,
      not_enough_rows_for_policy_claim: sampleQuality?.not_enough_rows_for_policy_claim === true,
      has_minimum_rows_for_policy_claim: sampleQuality?.has_minimum_rows_for_policy_claim === true,
      not_enough_task_signatures_for_diversity_claim: sampleQuality?.not_enough_task_signatures_for_diversity_claim === true,
      has_minimum_task_signatures_for_diversity_claim: sampleQuality?.has_minimum_task_signatures_for_diversity_claim === true,
    },
    summary: `Collected ${rowCount} admission dataset rows across ${chunks.length}/${args.iterations} real Runtime e2e iterations.`,
  };
  const reportDir = path.join(datasetDir, "reports", "latest");
  writeJson(path.join(reportDir, "batch_collect.json"), result);
  fs.writeFileSync(path.join(reportDir, "batch_collect.md"), markdownReport(result));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
