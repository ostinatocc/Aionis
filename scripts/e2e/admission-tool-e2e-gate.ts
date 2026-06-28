#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateAdmissionToolE2EGate,
  formatAdmissionToolE2EGateMarkdown,
  parseJsonlLines,
  type AionisAdmissionToolE2EGateThresholds,
} from "../../src/memory/admission-tool-e2e-gate.js";

type CliArgs = {
  summary: string | null;
  results: string | null;
  outDir: string | null;
  arm: string;
  policyMode: "active" | "off" | "recorded" | "shadow" | "unspecified";
  thresholds: Partial<AionisAdmissionToolE2EGateThresholds>;
};

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    summary: null,
    results: null,
    outDir: null,
    arm: "aionis",
    policyMode: "unspecified",
    thresholds: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--summary" && next) {
      out.summary = next;
      index += 1;
    } else if (arg === "--results" && next) {
      out.results = next;
      index += 1;
    } else if (arg === "--out-dir" && next) {
      out.outDir = next;
      index += 1;
    } else if (arg === "--arm" && next) {
      out.arm = next;
      index += 1;
    } else if (arg === "--policy-mode" && next && ["active", "off", "recorded", "shadow", "unspecified"].includes(next)) {
      out.policyMode = next as CliArgs["policyMode"];
      index += 1;
    } else if (arg === "--min-runs" && next) {
      out.thresholds.min_runs = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--min-difficulty-levels" && next) {
      out.thresholds.min_difficulty_levels = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--max-route-write-violations" && next) {
      out.thresholds.max_route_write_violations = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--max-route-action-violations" && next) {
      out.thresholds.max_route_action_violations = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--max-direction-attention-violations" && next) {
      out.thresholds.max_direction_attention_violations = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--max-terminal-inspect" && next) {
      out.thresholds.max_terminal_inspect = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--max-report-conflict" && next) {
      out.thresholds.max_report_conflict = parsePositiveInteger(next);
      index += 1;
    } else if (arg === "--min-accepted-route-rate" && next) {
      out.thresholds.min_accepted_route_rate = parseNumber(next);
      index += 1;
    } else if (arg === "--min-action-completion-rate" && next) {
      out.thresholds.min_action_completion_rate = parseNumber(next);
      index += 1;
    } else if (arg === "--max-prompt-ratio-vs-full-history" && next) {
      out.thresholds.max_prompt_ratio_vs_full_history = parseNumber(next);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s admission:tool-e2e-gate -- --summary reports/.../summary.json",
        "",
        "Evaluates a cross-repository, tool-executing external Agent report.",
        "The command is read-only: it does not run the Agent and does not mutate Runtime state.",
        "",
        "Inputs:",
        "  --summary FILE                         external-agent summary.json",
        "  --results FILE                         optional phase2-gradient-results.jsonl",
        "  --out-dir DIR                          writes tool_e2e_gate.json/.md",
        "  --arm aionis",
        "  --policy-mode active                   required for candidate default-active review",
        "",
        "Threshold overrides:",
        "  --min-runs 40",
        "  --min-difficulty-levels 4",
        "  --max-route-write-violations 0",
        "  --max-route-action-violations 0",
        "  --max-direction-attention-violations 0",
        "  --max-terminal-inspect 0",
        "  --max-report-conflict 0",
        "  --min-accepted-route-rate 1",
        "  --min-action-completion-rate 1",
        "  --max-prompt-ratio-vs-full-history 0.75",
        "",
      ].join("\n"));
      process.exit(0);
    }
  }
  return out;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as unknown;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.summary) throw new Error("Missing --summary");
  const summaryPath = path.resolve(args.summary);
  if (!fs.existsSync(summaryPath)) throw new Error(`summary not found: ${summaryPath}`);
  const resultsPath = args.results ? path.resolve(args.results) : null;
  if (resultsPath && !fs.existsSync(resultsPath)) throw new Error(`results not found: ${resultsPath}`);
  const report = evaluateAdmissionToolE2EGate({
    summary: readJson(summaryPath),
    results: resultsPath ? parseJsonlLines(fs.readFileSync(resultsPath, "utf8")) : undefined,
    arm: args.arm,
    policy_mode: args.policyMode,
    thresholds: args.thresholds,
  });
  const outDir = path.resolve(args.outDir ?? path.dirname(summaryPath));
  const jsonPath = path.join(outDir, "tool_e2e_gate.json");
  const markdownPath = path.join(outDir, "tool_e2e_gate.md");
  writeJson(jsonPath, report);
  fs.writeFileSync(markdownPath, formatAdmissionToolE2EGateMarkdown(report));
  process.stdout.write(`${JSON.stringify({
    contract_version: "aionis_admission_tool_e2e_gate_cli_result_v1",
    summary_path: summaryPath,
    results_path: resultsPath,
    tool_e2e_gate_path: jsonPath,
    tool_e2e_gate_markdown_path: markdownPath,
    eligible_for_default_active_review: report.decision.eligible_for_default_active_review,
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
