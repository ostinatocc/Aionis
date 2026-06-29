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
  policySource: "global_env" | "profile_rule" | "off" | "mixed" | "unspecified" | null;
  requiredPolicySource: "global_env" | "profile_rule" | null;
  requiredPolicyProfileId: string | null;
  thresholds: Partial<AionisAdmissionToolE2EGateThresholds>;
};

type PolicySource = NonNullable<CliArgs["policySource"]>;

type PolicyGuideAudit = {
  policy_source: PolicySource;
  policy_source_audit?: {
    guide_count: number;
    matching_source_count: number;
    profile_id?: string | null;
    matching_profile_id_count?: number;
  };
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
    policySource: null,
    requiredPolicySource: null,
    requiredPolicyProfileId: null,
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
    } else if (arg === "--policy-source" && next && ["global_env", "profile_rule", "off", "mixed", "unspecified"].includes(next)) {
      out.policySource = next as CliArgs["policySource"];
      index += 1;
    } else if (arg === "--require-policy-source" && next && ["global_env", "profile_rule"].includes(next)) {
      out.requiredPolicySource = next as CliArgs["requiredPolicySource"];
      index += 1;
    } else if ((arg === "--require-policy-profile-id" || arg === "--policy-profile-id") && next) {
      out.requiredPolicyProfileId = next;
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
    } else if (arg === "--max-initial-context-ratio-vs-full-history" && next) {
      out.thresholds.max_initial_context_ratio_vs_full_history = parseNumber(next);
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
        "  --policy-source profile_rule           optional manual source declaration",
        "  --require-policy-source profile_rule   require every readable guide to use this source",
        "  --require-policy-profile-id ID         require every readable guide to use this profile",
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
        "  --max-initial-context-ratio-vs-full-history 0.75",
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isPolicySource(value: string | null): value is PolicySource {
  return value === "global_env"
    || value === "profile_rule"
    || value === "off"
    || value === "mixed"
    || value === "unspecified";
}

function resultBundlePaths(results: unknown[]): string[] {
  const paths = new Set<string>();
  for (const result of results) {
    const bundlePath = stringValue(recordValue(result)?.bundle_path);
    if (bundlePath) paths.add(path.resolve(bundlePath));
  }
  return [...paths].sort();
}

function guidePolicyRecord(guide: unknown): { source: PolicySource | null; profile_id: string | null } {
  const sourceMap = recordValue(recordValue(guide)?.source_map);
  const admission = recordValue(sourceMap?.admission_candidate_policy);
  const source = stringValue(admission?.source);
  return {
    source: isPolicySource(source) ? source : null,
    profile_id: stringValue(admission?.profile_id),
  };
}

function inferPolicySource(sources: PolicySource[]): PolicySource {
  if (sources.length === 0) return "unspecified";
  const unique = new Set(sources);
  return unique.size === 1 ? sources[0] : "mixed";
}

function collectPolicyGuideAudit(args: CliArgs, results: unknown[]): PolicyGuideAudit {
  const records: Array<{ source: PolicySource; profile_id: string | null }> = [];
  for (const bundlePath of resultBundlePaths(results)) {
    const guidePath = path.join(path.dirname(bundlePath), "contexts", args.arm, "guide.json");
    if (!fs.existsSync(guidePath)) continue;
    const record = guidePolicyRecord(readJson(guidePath));
    if (record.source) records.push({ source: record.source, profile_id: record.profile_id });
  }
  const inferredSource = inferPolicySource(records.map((record) => record.source));
  const policySource = args.policySource ?? inferredSource;
  if (records.length === 0) {
    return { policy_source: policySource };
  }
  const sourceToMatch = args.requiredPolicySource ?? args.policySource ?? (inferredSource === "mixed" ? null : inferredSource);
  const profileId = args.requiredPolicyProfileId;
  return {
    policy_source: policySource,
    policy_source_audit: {
      guide_count: records.length,
      matching_source_count: sourceToMatch
        ? records.filter((record) => record.source === sourceToMatch).length
        : 0,
      profile_id: profileId,
      matching_profile_id_count: profileId
        ? records.filter((record) => record.profile_id === profileId).length
        : undefined,
    },
  };
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
  const results = resultsPath ? parseJsonlLines(fs.readFileSync(resultsPath, "utf8")) : undefined;
  const policyGuideAudit = collectPolicyGuideAudit(args, results ?? []);
  const report = evaluateAdmissionToolE2EGate({
    summary: readJson(summaryPath),
    results,
    arm: args.arm,
    policy_mode: args.policyMode,
    policy_source: policyGuideAudit.policy_source,
    required_policy_source: args.requiredPolicySource ?? undefined,
    required_policy_profile_id: args.requiredPolicyProfileId ?? undefined,
    policy_source_audit: policyGuideAudit.policy_source_audit,
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
