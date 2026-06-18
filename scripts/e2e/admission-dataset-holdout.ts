#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateAdmissionDatasetHoldoutJsonl,
  formatAdmissionDatasetHoldoutMarkdown,
  type AionisAdmissionDatasetHoldoutSplitBy,
} from "../../src/memory/admission-dataset-holdout.js";

type CliArgs = {
  input: string | null;
  outDir: string | null;
  splitBy: AionisAdmissionDatasetHoldoutSplitBy;
  holdoutRatio: number | null;
  seed: string | null;
  policyId: string | null;
  policyVersion: string | null;
  policyMode: string | null;
  runtimeVersion: string | null;
};

function parseRatio(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSplitBy(value: string | undefined, fallback: AionisAdmissionDatasetHoldoutSplitBy): AionisAdmissionDatasetHoldoutSplitBy {
  return value === "run_id" ? "run_id" : fallback;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    input: null,
    outDir: null,
    splitBy: "task_signature",
    holdoutRatio: null,
    seed: null,
    policyId: null,
    policyVersion: null,
    policyMode: null,
    runtimeVersion: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--input" && next) {
      out.input = next;
      i += 1;
    } else if (arg === "--out-dir" && next) {
      out.outDir = next;
      i += 1;
    } else if ((arg === "--split-by" || arg === "--split_by") && next) {
      out.splitBy = parseSplitBy(next, out.splitBy);
      i += 1;
    } else if ((arg === "--holdout-ratio" || arg === "--holdout_ratio") && next) {
      out.holdoutRatio = parseRatio(next);
      i += 1;
    } else if (arg === "--seed" && next) {
      out.seed = next;
      i += 1;
    } else if (arg === "--policy-id" && next) {
      out.policyId = next;
      i += 1;
    } else if (arg === "--policy-version" && next) {
      out.policyVersion = next;
      i += 1;
    } else if (arg === "--policy-mode" && next) {
      out.policyMode = next;
      i += 1;
    } else if (arg === "--runtime-version" && next) {
      out.runtimeVersion = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s admission:holdout -- --input rows.jsonl [--out-dir reports/admission]",
        "",
        "Splits admission rows by task_signature or run_id and writes holdout.json plus holdout.md.",
        "",
        "Options:",
        "  --split-by task_signature|run_id",
        "  --holdout-ratio 0.3",
        "  --seed aionis-admission-holdout-v1",
        "",
      ].join("\n"));
      process.exit(0);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error("Missing --input rows.jsonl");
  const inputPath = path.resolve(args.input);
  const jsonl = fs.readFileSync(inputPath, "utf8");
  const report = evaluateAdmissionDatasetHoldoutJsonl(jsonl, {
    split_by: args.splitBy,
    holdout_ratio: args.holdoutRatio,
    seed: args.seed,
    policy_id: args.policyId,
    policy_version: args.policyVersion,
    policy_mode: args.policyMode,
    runtime_version: args.runtimeVersion,
  });
  const markdown = formatAdmissionDatasetHoldoutMarkdown(report);
  if (args.outDir) {
    const outDir = path.resolve(args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const summaryPath = path.join(outDir, "holdout.json");
    const markdownPath = path.join(outDir, "holdout.md");
    fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(markdownPath, markdown);
    process.stdout.write(`${JSON.stringify({
      contract_version: "aionis_admission_dataset_holdout_cli_result_v1",
      input: inputPath,
      out_dir: outDir,
      split_by: report.split.split_by,
      train_row_count: report.split.train_row_count,
      holdout_row_count: report.split.holdout_row_count,
      holdout_path: summaryPath,
      holdout_markdown_path: markdownPath,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(markdown);
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
