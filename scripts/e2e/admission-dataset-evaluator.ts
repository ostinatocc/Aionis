#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateAdmissionDatasetJsonl,
  formatAdmissionDatasetEvaluationMarkdown,
} from "../../src/memory/admission-dataset-evaluator.js";

type CliArgs = {
  input: string | null;
  outDir: string | null;
  policyId: string | null;
  policyVersion: string | null;
  policyMode: string | null;
  runtimeVersion: string | null;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    input: null,
    outDir: null,
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
        "Usage: npm run -s admission:evaluate -- --input rows.jsonl [--out-dir reports/admission]",
        "",
        "Writes summary.json and leaderboard.md when --out-dir is provided; otherwise prints markdown.",
        "",
      ].join("\n"));
      process.exit(0);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    throw new Error("Missing --input rows.jsonl");
  }
  const inputPath = path.resolve(args.input);
  const jsonl = fs.readFileSync(inputPath, "utf8");
  const report = evaluateAdmissionDatasetJsonl(jsonl, {
    policy_id: args.policyId,
    policy_version: args.policyVersion,
    policy_mode: args.policyMode,
    runtime_version: args.runtimeVersion,
  });
  const markdown = formatAdmissionDatasetEvaluationMarkdown(report);
  if (args.outDir) {
    const outDir = path.resolve(args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, "leaderboard.md"), markdown);
    process.stdout.write(`${JSON.stringify({
      contract_version: "aionis_admission_dataset_evaluator_cli_result_v1",
      input: inputPath,
      out_dir: outDir,
      row_count: report.dataset.row_count,
      summary_path: path.join(outDir, "summary.json"),
      leaderboard_path: path.join(outDir, "leaderboard.md"),
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
