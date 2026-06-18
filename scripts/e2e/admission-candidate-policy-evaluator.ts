#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateAdmissionCandidatePoliciesJsonl,
  formatAdmissionCandidatePolicyEvaluationMarkdown,
} from "../../src/memory/admission-candidate-policy-evaluator.js";
import type { AionisAdmissionDatasetHoldoutSplitBy } from "../../src/memory/admission-dataset-holdout.js";

type CliArgs = {
  input: string | null;
  outDir: string | null;
  splitBy: AionisAdmissionDatasetHoldoutSplitBy;
  holdoutRatio: number | null;
  seed: string | null;
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
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s admission:candidate-policy -- --input rows.jsonl [--out-dir reports/admission]",
        "",
        "Evaluates label-safe candidate admission policies on train/holdout splits.",
        "",
        "Options:",
        "  --split-by task_signature|run_id",
        "  --holdout-ratio 0.5",
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
  const report = evaluateAdmissionCandidatePoliciesJsonl(jsonl, {
    split_by: args.splitBy,
    holdout_ratio: args.holdoutRatio,
    seed: args.seed,
  });
  const markdown = formatAdmissionCandidatePolicyEvaluationMarkdown(report);
  if (args.outDir) {
    const outDir = path.resolve(args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const summaryPath = path.join(outDir, "candidate_policy.json");
    const markdownPath = path.join(outDir, "candidate_policy.md");
    fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(markdownPath, markdown);
    process.stdout.write(`${JSON.stringify({
      contract_version: "aionis_admission_candidate_policy_evaluator_cli_result_v1",
      input: inputPath,
      out_dir: outDir,
      selected_policy_id: report.selected_policy_id,
      eligible_for_manual_review: report.promotion_gate.eligible_for_manual_review,
      candidate_policy_path: summaryPath,
      candidate_policy_markdown_path: markdownPath,
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
