#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateAdmissionProductionGateJsonl,
  formatAdmissionProductionGateMarkdown,
  type AionisAdmissionProductionGateThresholds,
} from "../../src/memory/admission-production-gate.js";

type CliArgs = {
  datasetDir: string | null;
  rows: string | null;
  outDir: string | null;
  batchCollect: string[];
  candidatePolicy: string | null;
  thresholds: Partial<AionisAdmissionProductionGateThresholds>;
};

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    datasetDir: null,
    rows: null,
    outDir: null,
    batchCollect: [],
    candidatePolicy: null,
    thresholds: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--dataset-dir" && next) {
      out.datasetDir = next;
      index += 1;
    } else if (arg === "--rows" && next) {
      out.rows = next;
      index += 1;
    } else if (arg === "--out-dir" && next) {
      out.outDir = next;
      index += 1;
    } else if (arg === "--batch-collect" && next) {
      out.batchCollect.push(next);
      index += 1;
    } else if (arg === "--candidate-policy" && next) {
      out.candidatePolicy = next;
      index += 1;
    } else if (arg === "--min-rows" && next) {
      out.thresholds.min_rows = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--min-task-signatures" && next) {
      out.thresholds.min_task_signatures = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--min-scopes" && next) {
      out.thresholds.min_scopes = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--min-projection-present" && next) {
      out.thresholds.min_projection_present_count = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s admission:production-gate -- --dataset-dir admission-dataset",
        "",
        "Evaluates the closed-loop admission candidate against the default-guide",
        "shadow production gate. This command is read-only: it does not activate",
        "the policy and does not mutate Runtime memory.",
        "",
        "Inputs:",
        "  --dataset-dir DIR                  Uses DIR/rows.jsonl and DIR/reports/latest/*.json",
        "  --rows FILE                        Explicit rows.jsonl path",
        "  --batch-collect FILE               Explicit batch_collect.json path; repeatable",
        "  --candidate-policy FILE            Explicit candidate_policy.json path",
        "  --out-dir DIR                      Writes production_gate.json/.md",
        "",
        "Threshold overrides:",
        "  --min-rows 1000",
        "  --min-task-signatures 30",
        "  --min-scopes 5",
        "  --min-projection-present 1000",
        "",
      ].join("\n"));
      process.exit(0);
    }
  }
  return out;
}

function readJsonIfExists(file: string | null): unknown {
  if (!file) return null;
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return null;
  return JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function datasetDefaultPath(datasetDir: string | null, suffix: string): string | null {
  return datasetDir ? path.join(path.resolve(datasetDir), suffix) : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetDir = args.datasetDir ? path.resolve(args.datasetDir) : null;
  const rowsPath = path.resolve(args.rows ?? datasetDefaultPath(datasetDir, "rows.jsonl") ?? "");
  if (!rowsPath || !fs.existsSync(rowsPath)) {
    throw new Error("Missing --rows or --dataset-dir with rows.jsonl");
  }
  const batchCollectPaths = args.batchCollect.length > 0
    ? args.batchCollect
    : [datasetDefaultPath(datasetDir, "reports/latest/batch_collect.json")].filter((entry): entry is string => !!entry);
  const candidatePolicyPath = args.candidatePolicy
    ?? datasetDefaultPath(datasetDir, "reports/latest/candidate_policy.json");
  const jsonl = fs.readFileSync(rowsPath, "utf8");
  const report = evaluateAdmissionProductionGateJsonl(jsonl, {
    thresholds: args.thresholds,
    batch_collect: batchCollectPaths.map((entry) => readJsonIfExists(entry)).filter((entry) => entry !== null),
    candidate_policy: readJsonIfExists(candidatePolicyPath),
  });
  const outDir = path.resolve(args.outDir ?? datasetDefaultPath(datasetDir, "reports/latest") ?? process.cwd());
  const jsonPath = path.join(outDir, "production_gate.json");
  const markdownPath = path.join(outDir, "production_gate.md");
  writeJson(jsonPath, report);
  fs.writeFileSync(markdownPath, formatAdmissionProductionGateMarkdown(report));
  process.stdout.write(`${JSON.stringify({
    contract_version: "aionis_admission_production_gate_cli_result_v1",
    rows_path: rowsPath,
    batch_collect_paths: batchCollectPaths,
    candidate_policy_path: candidatePolicyPath,
    production_gate_path: jsonPath,
    production_gate_markdown_path: markdownPath,
    eligible_for_isolated_active_gray_review: report.decision.eligible_for_isolated_active_gray_review,
    eligible_for_default_active: report.decision.eligible_for_default_active,
    status: report.decision.status,
    blocking_reasons: report.decision.blocking_reasons,
  }, null, 2)}\n`);
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
