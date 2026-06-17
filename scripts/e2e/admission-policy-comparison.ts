#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareAdmissionPoliciesJsonl,
  formatAdmissionPolicyComparisonMarkdown,
} from "../../src/memory/admission-policy-comparison.js";

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
        "Usage: npm run -s admission:compare -- --input rows.jsonl [--out-dir reports/admission-comparison]",
        "",
        "Compares Aionis recorded admission against offline baseline routing policies.",
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
  const report = compareAdmissionPoliciesJsonl(jsonl, {
    policy_id: args.policyId,
    policy_version: args.policyVersion,
    policy_mode: args.policyMode,
    runtime_version: args.runtimeVersion,
  });
  const markdown = formatAdmissionPolicyComparisonMarkdown(report);
  if (args.outDir) {
    const outDir = path.resolve(args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const summaryPath = path.join(outDir, "policy_comparison.json");
    const leaderboardPath = path.join(outDir, "policy_comparison.md");
    fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(leaderboardPath, markdown);
    process.stdout.write(`${JSON.stringify({
      contract_version: "aionis_admission_policy_comparison_cli_result_v1",
      input: inputPath,
      out_dir: outDir,
      row_count: report.dataset.row_count,
      summary_path: summaryPath,
      leaderboard_path: leaderboardPath,
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
