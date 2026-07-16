#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAdmissionRealAgentPromptPack,
  buildAdmissionRealAgentRerunReport,
  admissionRealAgentFiniteHoldoutResponseFingerprint,
  admissionRealAgentFiniteHoldoutRuntimeCopyIdentity,
  AIONIS_ADMISSION_REAL_AGENT_FINITE_HOLDOUT_CASE_COUNT,
  formatAdmissionRealAgentRerunMarkdown,
  normalizeAdmissionRealAgentDecision,
  parseAdmissionRealAgentDatasetJsonl,
  prepareAdmissionRealAgentGroups,
  scoreAdmissionRealAgentDecision,
  type AionisAdmissionRealAgentArmId,
  type AionisAdmissionRealAgentFiniteHoldoutCase,
  type AionisAdmissionRealAgentPredecisionTrack,
  type AionisAdmissionRealAgentScoredTrial,
} from "../../src/memory/admission-real-agent-rerun.js";
import type { AionisAdmissionCandidatePolicyId } from "../../src/memory/admission-candidate-policy-evaluator.js";
import type { AionisAdmissionDatasetHoldoutSplitBy } from "../../src/memory/admission-dataset-holdout.js";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.js";
import {
  restoreLiteRuntimeDatabase,
  verifyLiteRuntimeDatabase,
} from "../../src/store/lite-runtime-data-operations.js";
import { requireLlmConfig, type LlmConfig } from "./runtime-agent-loop.ts";

export type AionisAdmissionRealAgentRuntimeArm = "recorded" | "candidate";

export type AionisAdmissionRealAgentRuntimeArmExecution<T> = Readonly<{
  result: T;
  runtime_copy_identity_sha256: string;
  starting_runtime_snapshot_sha256: string;
  ending_runtime_snapshot_sha256: string;
  runtime_copy_destroyed: true;
}>;

export type AionisAdmissionRealAgentFreshRuntimePairResult<T> = Readonly<{
  source_runtime_snapshot_sha256: string;
  database_instance_id: string;
  execution_order: readonly [AionisAdmissionRealAgentRuntimeArm, AionisAdmissionRealAgentRuntimeArm];
  recorded: AionisAdmissionRealAgentRuntimeArmExecution<T>;
  candidate: AionisAdmissionRealAgentRuntimeArmExecution<T>;
}>;

export async function runAdmissionRealAgentFreshRuntimePair<T>(args: {
  backupPath: string;
  caseOrdinal: number;
  caseIdentitySha256: string;
  firstArm: AionisAdmissionRealAgentRuntimeArm;
  workRoot?: string;
  runArm(input: Readonly<{
    arm: AionisAdmissionRealAgentRuntimeArm;
    runtimeDatabase: LiteRuntimeDatabase;
    runtimeCopyIdentitySha256: string;
    startingRuntimeSnapshotSha256: string;
  }>): Promise<T>;
}): Promise<AionisAdmissionRealAgentFreshRuntimePairResult<T>> {
  if (!Number.isInteger(args.caseOrdinal) || args.caseOrdinal < 0 || args.caseOrdinal >= 96) {
    throw new Error("finite_holdout_case_ordinal_invalid");
  }
  if (!/^[0-9a-f]{64}$/u.test(args.caseIdentitySha256)) {
    throw new Error("finite_holdout_case_identity_invalid");
  }
  if (args.firstArm !== "recorded" && args.firstArm !== "candidate") {
    throw new Error("finite_holdout_first_arm_invalid");
  }
  const workRoot = path.resolve(args.workRoot ?? os.tmpdir());
  fs.mkdirSync(workRoot, { recursive: true });
  const pairDirectory = fs.mkdtempSync(path.join(workRoot, "aionis-admission-runtime-pair-"));
  const paths = {
    recorded: path.join(pairDirectory, "recorded.sqlite"),
    candidate: path.join(pairDirectory, "candidate.sqlite"),
  } as const;
  const order = args.firstArm === "recorded"
    ? ["recorded", "candidate"] as const
    : ["candidate", "recorded"] as const;
  let completed: Omit<AionisAdmissionRealAgentFreshRuntimePairResult<T>, "recorded" | "candidate"> & {
    recorded: Omit<AionisAdmissionRealAgentRuntimeArmExecution<T>, "runtime_copy_destroyed">;
    candidate: Omit<AionisAdmissionRealAgentRuntimeArmExecution<T>, "runtime_copy_destroyed">;
  } | null = null;
  try {
    const restored = {
      recorded: await restoreLiteRuntimeDatabase({ backupPath: args.backupPath, destinationPath: paths.recorded }),
      candidate: await restoreLiteRuntimeDatabase({ backupPath: args.backupPath, destinationPath: paths.candidate }),
    };
    const recordedManifest = restored.recorded.source_manifest;
    const candidateManifest = restored.candidate.source_manifest;
    if (recordedManifest?.contract_version !== "aionis_lite_runtime_backup_manifest_v2"
      || candidateManifest?.contract_version !== "aionis_lite_runtime_backup_manifest_v2") {
      throw new Error("finite_holdout_manifest_bound_v2_backup_required");
    }
    const sourceSha256 = recordedManifest.sha256;
    const databaseInstanceId = recordedManifest.database_instance_id;
    if (!databaseInstanceId
      || candidateManifest.sha256 !== sourceSha256
      || candidateManifest.database_instance_id !== databaseInstanceId
      || restored.recorded.verification.sha256 !== sourceSha256
      || restored.candidate.verification.sha256 !== sourceSha256) {
      throw new Error("finite_holdout_runtime_pair_snapshot_mismatch");
    }
    const armResults = {} as Record<AionisAdmissionRealAgentRuntimeArm,
      Omit<AionisAdmissionRealAgentRuntimeArmExecution<T>, "runtime_copy_destroyed">>;
    for (const arm of order) {
      const runtimeCopyIdentity = admissionRealAgentFiniteHoldoutRuntimeCopyIdentity({
        source_runtime_snapshot_sha256: sourceSha256,
        case_ordinal: args.caseOrdinal,
        case_identity_sha256: args.caseIdentitySha256,
        arm,
      });
      const runtimeDatabase = createLiteRuntimeDatabase(paths[arm]);
      let result: T;
      try {
        result = await args.runArm({
          arm,
          runtimeDatabase,
          runtimeCopyIdentitySha256: runtimeCopyIdentity,
          startingRuntimeSnapshotSha256: sourceSha256,
        });
      } finally {
        await runtimeDatabase.close();
      }
      if (fs.existsSync(`${paths[arm]}-wal`) || fs.existsSync(`${paths[arm]}-shm`)) {
        throw new Error(`finite_holdout_runtime_${arm}_not_quiescent`);
      }
      const ending = await verifyLiteRuntimeDatabase(paths[arm]);
      if (!ending.ok || ending.database_instance_id !== databaseInstanceId) {
        throw new Error(`finite_holdout_runtime_${arm}_ending_verification_failed`);
      }
      armResults[arm] = {
        result,
        runtime_copy_identity_sha256: runtimeCopyIdentity,
        starting_runtime_snapshot_sha256: sourceSha256,
        ending_runtime_snapshot_sha256: ending.sha256,
      };
    }
    completed = {
      source_runtime_snapshot_sha256: sourceSha256,
      database_instance_id: databaseInstanceId,
      execution_order: order,
      recorded: armResults.recorded,
      candidate: armResults.candidate,
    };
  } finally {
    fs.rmSync(pairDirectory, { recursive: true, force: true });
  }
  if (!completed || fs.existsSync(pairDirectory)) {
    throw new Error("finite_holdout_runtime_pair_cleanup_failed");
  }
  return {
    ...completed,
    recorded: { ...completed.recorded, runtime_copy_destroyed: true },
    candidate: { ...completed.candidate, runtime_copy_destroyed: true },
  };
}

export type AionisAdmissionRealAgentFiniteHoldoutUnit = Readonly<{
  case_ordinal: number;
  case_identity_sha256: string;
  policy_affected: boolean;
  predecision_track: AionisAdmissionRealAgentPredecisionTrack;
  first_arm: AionisAdmissionRealAgentRuntimeArm;
}>;

export type AionisAdmissionRealAgentFiniteHoldoutObservedOutcome = Readonly<{
  harm: boolean | null;
  accepted_completed: boolean | null;
  request_fingerprint_sha256: string;
  response_payload_sha256: string;
}>;

export function validateAdmissionRealAgentFiniteHoldoutUnits(
  input: readonly AionisAdmissionRealAgentFiniteHoldoutUnit[],
): AionisAdmissionRealAgentFiniteHoldoutUnit[] {
  const units = [...input].sort((left, right) => left.case_ordinal - right.case_ordinal);
  const count = AIONIS_ADMISSION_REAL_AGENT_FINITE_HOLDOUT_CASE_COUNT;
  if (units.length !== count || units.some((unit, index) => unit.case_ordinal !== index)
    || units.some((unit) => !/^[0-9a-f]{64}$/u.test(unit.case_identity_sha256)
      || typeof unit.policy_affected !== "boolean"
      || (unit.policy_affected
        ? unit.predecision_track !== "explore" && unit.predecision_track !== "exploit"
        : unit.predecision_track !== "unaffected"))
    || new Set(units.map((unit) => unit.case_identity_sha256)).size !== count
    || units.filter((unit) => unit.first_arm === "recorded").length !== count / 2
    || units.filter((unit) => unit.first_arm === "candidate").length !== count / 2) {
    throw new Error("finite_holdout_exact_counterbalanced_96_unit_manifest_required");
  }
  return units;
}

export async function runAdmissionRealAgentFiniteHoldoutCase(args: {
  backupPath: string;
  unit: AionisAdmissionRealAgentFiniteHoldoutUnit;
  executionProfileSha256: string;
  workRoot?: string;
  runArm(input: Readonly<{
    arm: AionisAdmissionRealAgentRuntimeArm;
    runtimeDatabase: LiteRuntimeDatabase;
    runtimeCopyIdentitySha256: string;
    startingRuntimeSnapshotSha256: string;
  }>): Promise<AionisAdmissionRealAgentFiniteHoldoutObservedOutcome>;
}): Promise<AionisAdmissionRealAgentFiniteHoldoutCase> {
  if (!/^[0-9a-f]{64}$/u.test(args.executionProfileSha256)) {
    throw new Error("finite_holdout_execution_profile_digest_invalid");
  }
  const pair = await runAdmissionRealAgentFreshRuntimePair({
    backupPath: args.backupPath,
    caseOrdinal: args.unit.case_ordinal,
    caseIdentitySha256: args.unit.case_identity_sha256,
    firstArm: args.unit.first_arm,
    workRoot: args.workRoot,
    runArm: args.runArm,
  });
  const arm = (name: AionisAdmissionRealAgentRuntimeArm) => {
    const execution = pair[name];
    if ((execution.result.harm !== null && typeof execution.result.harm !== "boolean")
      || (execution.result.accepted_completed !== null
        && typeof execution.result.accepted_completed !== "boolean")
      || !/^[0-9a-f]{64}$/u.test(execution.result.request_fingerprint_sha256)
      || !/^[0-9a-f]{64}$/u.test(execution.result.response_payload_sha256)) {
      throw new Error(`finite_holdout_${name}_outcome_invalid`);
    }
    return {
      ...execution.result,
      runtime_copy_identity_sha256: execution.runtime_copy_identity_sha256,
      starting_runtime_snapshot_sha256: execution.starting_runtime_snapshot_sha256,
      ending_runtime_snapshot_sha256: execution.ending_runtime_snapshot_sha256,
      runtime_copy_destroyed: execution.runtime_copy_destroyed,
      response_fingerprint_sha256: admissionRealAgentFiniteHoldoutResponseFingerprint({
        execution_profile_sha256: args.executionProfileSha256,
        case_ordinal: args.unit.case_ordinal,
        case_identity_sha256: args.unit.case_identity_sha256,
        arm: name,
        runtime_copy_identity_sha256: execution.runtime_copy_identity_sha256,
        request_fingerprint_sha256: execution.result.request_fingerprint_sha256,
        response_payload_sha256: execution.result.response_payload_sha256,
      }),
    };
  };
  return {
    ...args.unit,
    observed_first_arm: pair.execution_order[0],
    recorded: arm("recorded"),
    candidate: arm("candidate"),
  };
}

export async function runAdmissionRealAgentFiniteHoldoutCaseSet(args: {
  backupPath: string;
  units: readonly AionisAdmissionRealAgentFiniteHoldoutUnit[];
  executionProfileSha256: string;
  workRoot?: string;
  runArm(input: Readonly<{
    unit: AionisAdmissionRealAgentFiniteHoldoutUnit;
    arm: AionisAdmissionRealAgentRuntimeArm;
    runtimeDatabase: LiteRuntimeDatabase;
    runtimeCopyIdentitySha256: string;
    startingRuntimeSnapshotSha256: string;
  }>): Promise<AionisAdmissionRealAgentFiniteHoldoutObservedOutcome>;
}): Promise<AionisAdmissionRealAgentFiniteHoldoutCase[]> {
  const units = validateAdmissionRealAgentFiniteHoldoutUnits(args.units);
  const cases: AionisAdmissionRealAgentFiniteHoldoutCase[] = [];
  for (const unit of units) {
    cases.push(await runAdmissionRealAgentFiniteHoldoutCase({
      backupPath: args.backupPath,
      unit,
      executionProfileSha256: args.executionProfileSha256,
      workRoot: args.workRoot,
      runArm: (input) => args.runArm({ ...input, unit }),
    }));
  }
  return cases;
}

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
        "Runs a diagnostic real LLM Agent admission-policy rerun over exported admission dataset rows.",
        "Formal 96-unit evidence uses the exported fresh-Runtime case-set runner and protected ingestion.",
        "",
        "Required env:",
        "  DEEPSEEK_API_KEY or AIONIS_AGENT_E2E_API_KEY or OPENROUTER_API_KEY",
        "",
        "Options:",
        "  --split-by task_signature|run_id",
        "  --holdout-ratio 0.5",
        "  --seed aionis-admission-holdout-v1",
        "  --candidate-policy candidate_aionis_project_context_only",
        "  --candidate-policy candidate_closed_loop_contradicted_inspect",
        "  --candidate-policy candidate_project_context_closed_loop_inspect",
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
  candidatePolicyId: AionisAdmissionCandidatePolicyId;
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
    candidate_policy_id: args.candidatePolicyId,
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

  for (const [index, group] of prepared.groups.entries()) {
    const armOrder: AionisAdmissionRealAgentArmId[] = index % 2 === 0
      ? ["recorded_policy_baseline", prepared.candidate_policy_id]
      : [prepared.candidate_policy_id, "recorded_policy_baseline"];
    for (const armId of armOrder) {
      const trial = await runArmTrial({
        llm,
        armId,
        candidatePolicyId: prepared.candidate_policy_id,
        groupId: group.group_id,
        rows: group.rows,
      });
      if (armId === "recorded_policy_baseline") recordedTrials.push(trial);
      else candidateTrials.push(trial);
    }
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
