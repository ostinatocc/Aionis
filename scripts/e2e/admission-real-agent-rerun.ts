#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAdmissionRealAgentPromptPack,
  buildAdmissionRealAgentRerunReport,
  formatAdmissionRealAgentRerunMarkdown,
  normalizeAdmissionRealAgentDecision,
  parseAdmissionRealAgentDatasetJsonl,
  prepareAdmissionRealAgentGroups,
  scoreAdmissionRealAgentDecision,
  type AionisAdmissionRealAgentArmId,
  type AionisAdmissionRealAgentScoredTrial,
} from "../../src/memory/admission-real-agent-rerun.js";
import type { AionisAdmissionCandidatePolicyId } from "../../src/memory/admission-candidate-policy-evaluator.js";
import type { AionisAdmissionDatasetHoldoutSplitBy } from "../../src/memory/admission-dataset-holdout.js";
import { requireLlmConfig, type LlmConfig } from "./runtime-agent-loop.ts";

type CliArgs = {
  input: string | null;
  outDir: string | null;
  splitBy: AionisAdmissionDatasetHoldoutSplitBy;
  holdoutRatio: number | null;
  seed: string | null;
  candidatePolicyId: AionisAdmissionCandidatePolicyId | null;
  evaluationSplit: "holdout" | "train" | "all";
  maxGroups: number | null;
};

function parseRatio(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseSplitBy(value: string | undefined, fallback: AionisAdmissionDatasetHoldoutSplitBy): AionisAdmissionDatasetHoldoutSplitBy {
  return value === "run_id" ? "run_id" : fallback;
}

function parseEvaluationSplit(value: string | undefined): "holdout" | "train" | "all" {
  return value === "train" || value === "all" ? value : "holdout";
}

function parseCandidatePolicyId(value: string | undefined): AionisAdmissionCandidatePolicyId | null {
  if (
    value === "recorded_policy_baseline"
    || value === "candidate_external_current_inspect"
    || value === "candidate_aionis_project_context_only"
    || value === "candidate_advisory_inspect"
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
    maxGroups: null,
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
    } else if ((arg === "--max-groups" || arg === "--max_groups") && next) {
      out.maxGroups = parseInteger(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s admission:real-agent-rerun -- --input rows.jsonl [--out-dir reports/admission]",
        "",
        "Runs a real LLM Agent admission-policy rerun over exported admission dataset rows.",
        "",
        "Required env:",
        "  DEEPSEEK_API_KEY or AIONIS_AGENT_E2E_API_KEY or OPENROUTER_API_KEY",
        "",
        "Options:",
        "  --split-by task_signature|run_id",
        "  --holdout-ratio 0.5",
        "  --seed aionis-admission-holdout-v1",
        "  --candidate-policy candidate_aionis_project_context_only",
        "  --evaluation-split holdout|train|all",
        "  --max-groups 13",
        "",
      ].join("\n"));
      process.exit(0);
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function extractChatCompletionText(value: unknown): string {
  const root = asRecord(value);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  return typeof message?.content === "string" ? message.content.trim() : "";
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = tryParseJsonObject(fenced.trim());
    if (parsed) return parsed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParseJsonObject(trimmed.slice(start, end + 1));
  return null;
}

function tryParseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function safeBaseUrlHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

async function callLlm(args: {
  llm: LlmConfig;
  armId: AionisAdmissionRealAgentArmId;
  groupId: string;
  promptPack: unknown;
}): Promise<{
  decision: ReturnType<typeof normalizeAdmissionRealAgentDecision>;
  rawText: string;
  usage: Record<string, unknown> | null;
  requestChars: number;
}> {
  const baseUrl = args.llm.baseUrl.replace(/\/+$/, "");
  const body = {
    model: args.llm.model,
    temperature: 0,
    max_tokens: args.llm.maxTokens,
    response_format: { type: "json_object" },
    stream: false,
    messages: [
      {
        role: "system",
        content: [
          "You are a real Agent evaluating a memory admission surface.",
          "Use only the supplied admission prompt pack.",
          "Do not infer hidden outcome labels, hidden feedback, or hidden raw memory payload.",
          "Return only compact JSON with keys: selected_memory_id, action, used_memory_ids, rationale.",
          "Allowed action values: direct_use, inspect_memory, avoid_memory, no_action, unknown.",
          "The JSON must be complete, valid, and one object. Do not use Markdown.",
          "Keep rationale under 80 characters.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          arm_id: args.armId,
          group_id: args.groupId,
          prompt_pack: args.promptPack,
        }, null, 2),
      },
    ],
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.llm.apiKey}`,
      ...(args.llm.provider === "openrouter" ? {
        "HTTP-Referer": "https://github.com/ostinatocc/Aionis",
        "X-Title": "Aionis Admission Real Agent Rerun",
      } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`LLM call failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  const rawText = extractChatCompletionText(payload);
  if (!rawText) throw new Error(`LLM response did not contain assistant text: ${JSON.stringify(payload)}`);
  const parsed = extractJsonObject(rawText);
  if (!parsed) throw new Error(`LLM response was not parseable JSON: ${rawText}`);
  return {
    decision: normalizeAdmissionRealAgentDecision(parsed),
    rawText,
    usage: asRecord(asRecord(payload)?.usage),
    requestChars: JSON.stringify(body).length,
  };
}

async function runArmTrial(args: {
  llm: LlmConfig;
  armId: AionisAdmissionRealAgentArmId;
  groupId: string;
  rows: ReturnType<typeof prepareAdmissionRealAgentGroups>["groups"][number]["rows"];
}): Promise<AionisAdmissionRealAgentScoredTrial> {
  const promptPack = buildAdmissionRealAgentPromptPack({
    arm_id: args.armId,
    group_id: args.groupId,
    rows: args.rows,
  });
  const response = await callLlm({
    llm: args.llm,
    armId: args.armId,
    groupId: args.groupId,
    promptPack,
  });
  return scoreAdmissionRealAgentDecision({
    arm_id: args.armId,
    group_id: args.groupId,
    rows: args.rows,
    decision: response.decision,
    prompt_char_count: JSON.stringify(promptPack).length,
    request_char_count: response.requestChars,
    completion_char_count: response.rawText.length,
    usage: response.usage,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error("Missing --input rows.jsonl");
  const llm = requireLlmConfig();
  const inputPath = path.resolve(args.input);
  const rows = parseAdmissionRealAgentDatasetJsonl(fs.readFileSync(inputPath, "utf8"));
  const options = {
    split_by: args.splitBy,
    holdout_ratio: args.holdoutRatio,
    seed: args.seed,
    candidate_policy_id: args.candidatePolicyId,
    evaluation_split: args.evaluationSplit,
    max_groups: args.maxGroups,
  };
  const prepared = prepareAdmissionRealAgentGroups(rows, options);
  const recordedTrials: AionisAdmissionRealAgentScoredTrial[] = [];
  const candidateTrials: AionisAdmissionRealAgentScoredTrial[] = [];

  for (const group of prepared.groups) {
    recordedTrials.push(await runArmTrial({
      llm,
      armId: "recorded_policy_baseline",
      groupId: group.group_id,
      rows: group.rows,
    }));
    candidateTrials.push(await runArmTrial({
      llm,
      armId: prepared.candidate_policy_id,
      groupId: group.group_id,
      rows: group.rows,
    }));
  }

  const report = buildAdmissionRealAgentRerunReport({
    rows,
    options,
    llm: {
      provider: llm.provider,
      model: llm.model,
      base_url_host: safeBaseUrlHost(llm.baseUrl),
    },
    recorded_trials: recordedTrials,
    candidate_trials: candidateTrials,
  });
  const markdown = formatAdmissionRealAgentRerunMarkdown(report);
  if (args.outDir) {
    const outDir = path.resolve(args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const summaryPath = path.join(outDir, "real_agent_rerun.json");
    const markdownPath = path.join(outDir, "real_agent_rerun.md");
    fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(markdownPath, markdown);
    process.stdout.write(`${JSON.stringify({
      contract_version: "aionis_admission_real_agent_rerun_cli_result_v1",
      input: inputPath,
      out_dir: outDir,
      candidate_policy_id: report.policy.candidate_policy_id,
      real_agent_rerun_path: summaryPath,
      real_agent_rerun_markdown_path: markdownPath,
      summary: report.summary,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(markdown);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
