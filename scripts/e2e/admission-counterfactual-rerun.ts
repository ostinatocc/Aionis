#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatAdmissionCounterfactualRerunMarkdown,
  rerunAdmissionCounterfactualJsonl,
  type AionisAdmissionCounterfactualRerunOptions,
} from "../../src/memory/admission-counterfactual-rerun.js";
import type { AionisAdmissionCandidatePolicyId } from "../../src/memory/admission-candidate-policy-evaluator.js";
import type { AionisAdmissionDatasetHoldoutSplitBy } from "../../src/memory/admission-dataset-holdout.js";

type CliArgs = {
  input: string | null;
  outDir: string | null;
  splitBy: AionisAdmissionDatasetHoldoutSplitBy;
  holdoutRatio: number | null;
  seed: string | null;
  candidatePolicyId: AionisAdmissionCandidatePolicyId | null;
  evaluationSplit: AionisAdmissionCounterfactualRerunOptions["evaluation_split"];
};

function parseRatio(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSplitBy(value: string | undefined, fallback: AionisAdmissionDatasetHoldoutSplitBy): AionisAdmissionDatasetHoldoutSplitBy {
  return value === "run_id" ? "run_id" : fallback;
}

function parseEvaluationSplit(value: string | undefined): AionisAdmissionCounterfactualRerunOptions["evaluation_split"] {
  return value === "train" || value === "all" ? value : "holdout";
}

function parseCandidatePolicyId(value: string | undefined): AionisAdmissionCandidatePolicyId | null {
  if (
    value === "recorded_policy_baseline"
    || value === "candidate_external_current_inspect"
    || value === "candidate_aionis_project_context_only"
    || value === "candidate_advisory_inspect"
    || value === "candidate_closed_loop_contradicted_inspect"
    || value === "candidate_project_context_closed_loop_inspect"
  ) {
    return value;
  }
  return null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    input: null,
    outDir: null,
    splitBy: "task_signature",
    holdoutRatio: null,
    seed: null,
    candidatePolicyId: null,
    evaluationSplit: "holdout",
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
    } else if ((arg === "--candidate-policy" || arg === "--candidate_policy") && next) {
      out.candidatePolicyId = parseCandidatePolicyId(next);
      if (!out.candidatePolicyId) throw new Error(`Unknown --candidate-policy ${next}`);
      i += 1;
    } else if ((arg === "--evaluation-split" || arg === "--evaluation_split") && next) {
      out.evaluationSplit = parseEvaluationSplit(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s admission:counterfactual-rerun -- --input rows.jsonl [--out-dir reports/admission]",
        "",
        "Runs an offline deterministic counterfactual action proxy over admission dataset rows.",
        "",
        "Options:",
        "  --split-by task_signature|run_id",
        "  --holdout-ratio 0.5",
        "  --seed aionis-admission-holdout-v1",
        "  --candidate-policy candidate_aionis_project_context_only",
        "  --candidate-policy candidate_closed_loop_contradicted_inspect",
        "  --candidate-policy candidate_project_context_closed_loop_inspect",
        "  --evaluation-split holdout|train|all",
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
  const report = rerunAdmissionCounterfactualJsonl(jsonl, {
    split_by: args.splitBy,
    holdout_ratio: args.holdoutRatio,
    seed: args.seed,
    candidate_policy_id: args.candidatePolicyId,
    evaluation_split: args.evaluationSplit,
  });
  const markdown = formatAdmissionCounterfactualRerunMarkdown(report);
  if (args.outDir) {
    const outDir = path.resolve(args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const summaryPath = path.join(outDir, "counterfactual_rerun.json");
    const markdownPath = path.join(outDir, "counterfactual_rerun.md");
    fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(markdownPath, markdown);
    process.stdout.write(`${JSON.stringify({
      contract_version: "aionis_admission_counterfactual_rerun_cli_result_v1",
      input: inputPath,
      out_dir: outDir,
      candidate_policy_id: report.policy.candidate_policy_id,
      eligible_for_real_agent_rerun: report.checks.eligible_for_real_agent_rerun,
      counterfactual_rerun_path: summaryPath,
      counterfactual_rerun_markdown_path: markdownPath,
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
