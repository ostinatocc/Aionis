import "dotenv/config";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRuntimeEffectRollupFromTaskReports,
  promotionQualitySummaryFromTaskReport,
  runtimeEffectSummaryFromTaskReport,
} from "./report-runtime-effect-rollup.js";

type JsonObject = Record<string, unknown>;

type ProviderKind = "anthropic" | "openai_compatible";

type RealLlmProviderConfig = {
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  stepTimeoutMs: number;
  maxRetries: number;
  protocolRetries: number;
  maxProtocolExhaustedSteps: number;
  openAiJsonMode: boolean;
  openAiExtraBody?: JsonObject;
};

type EvalSuite = {
  suite_id: string;
  description?: string;
  effect_gate?: EvalEffectGate;
  tasks: EvalTask[];
};

type EvalEffectGate = {
  min_tasks?: number;
  require_assisted_success?: boolean;
  require_assisted_first_action_target?: boolean;
  require_native_kickoff_target_files?: boolean;
  require_native_first_action?: boolean;
  require_native_edit_boundary?: boolean;
  min_assisted_success_rate?: number;
  min_improved_task_count?: number;
  min_average_repeated_discovery_delta?: number;
  min_average_wrong_file_touch_delta?: number;
  min_average_tool_step_delta?: number;
  fail_on_assisted_verifier_regression?: boolean;
  fail_on_average_repeated_discovery_regression?: boolean;
  fail_on_assisted_forbidden_file_write?: boolean;
  max_llm_api_error_count?: number | null;
  max_assisted_llm_api_error_count?: number | null;
  max_assisted_llm_protocol_error_count?: number | null;
  max_assisted_llm_protocol_error_rate_per_run?: number | null;
  min_assisted_llm_protocol_repair_rate?: number | null;
};

type EvalTask = {
  id: string;
  title?: string;
  task_family?: string;
  prompt: string;
  workspace: EvalWorkspace;
  verifier: {
    command: string;
    timeout_ms?: number;
  };
  max_steps?: number;
  aionis_attempts?: number;
  time_budget_ms?: number;
  expected?: {
    target_files?: string[];
    allowed_read_files?: string[];
    allowed_edit_files?: string[];
    forbidden_edit_files?: string[];
    first_action_keywords?: string[];
    acceptance_checks?: string[];
    required_verifiers?: string[];
    anti_shortcut_rules?: string[];
  };
};

type EvalWorkspaceSetupCommand = {
  command: string;
  timeout_ms?: number;
};

type EvalWorkspace =
  | {
      source: "copy";
      path: string;
      exclude?: string[];
      link_node_modules?: boolean;
    }
  | {
      source: "git";
      repo_url: string;
      ref: string;
      checkout_depth?: number;
      exclude?: string[];
      link_node_modules?: boolean;
      setup_commands?: EvalWorkspaceSetupCommand[];
    };

type AgentArm = "seed" | "baseline" | "aionis";

type SuiteRunMode =
  | "full_seed_baseline_aionis"
  | "aionis_only_prior_report"
  | "aionis_only_prior_report_stale_replay";

type AionisPriorEvidenceMode = "all" | "failure-only" | "none";

type LlmMessage = {
  role: "user" | "assistant";
  content: string;
};

type LlmResponse = {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

type ToolEvent = {
  step_index: number;
  tool_name: string;
  tool_input: JsonObject;
  status: "success" | "failed" | "partial";
  output_signature: JsonObject;
  touched_files: string[];
  write_files: string[];
  started_at_ms: number;
  ended_at_ms: number;
};

type RuntimeWritePolicy = {
  allowedEditFiles: string[];
  forbiddenEditFiles: string[];
};

type RuntimeSequencePolicy = {
  orderedActions: JsonObject[];
  repairFirstWriteFiles: string[];
  repairPreWriteReadFiles: string[];
  maxNarrowReadsBeforeFirstRepairWrite: number | null;
  maxScopedSearchesBeforeFirstRepairWrite: number | null;
  repairSecondWriteFiles: string[];
  repairSecondWriteReadFiles: string[];
  maxNarrowReadsBeforeSecondRepairWrite: number | null;
  maxScopedSearchesBeforeSecondRepairWrite: number | null;
  packageDependencyRequirements: JsonObject[];
  requiredVerifiers: string[];
  formatterCommands: string[];
  maxSuccessfulWritesBeforeVerifier: number;
  verifierFailurePhase: string | null;
  verifierFailurePrimaryFiles: string[];
  verifierFailureLineHintFiles: string[];
  verifierFailureRepairAffectedFiles: string[];
  semanticCandidateTrial: JsonObject | null;
  semanticSecondCandidateTrial: JsonObject | null;
  cognitiveEntropyEngine: JsonObject | null;
};

type PolicyBlockRecoveryNextActionArgs = {
  events: ToolEvent[];
  sequencePolicy?: RuntimeSequencePolicy | null;
  workspaceDir: string;
};

type LearningControlCandidateScope =
  | "exact_task"
  | "task_family"
  | "repository"
  | "ecosystem"
  | "global";

type LearningControlSemanticRepairCandidate = {
  candidate_version: "learning_control_semantic_repair_candidate_v1";
  producer: {
    kind: "llm_semantic_candidate_producer";
    provider: ProviderKind;
    model: string;
  };
  promotion_state: "candidate";
  source_phase: string;
  semantic_hypothesis: string;
  contract_kind: string;
  target_files: string[];
  evidence: string[];
  suggested_actions: string[];
  scope: LearningControlCandidateScope;
  confidence: number;
  escape_condition: string;
  promotion_requirements: string[];
  runtime_adjudication: {
    decision: "candidate_only" | "rejected";
    authority: "advisory";
    usable_as_next_attempt_guidance: boolean;
    reasons: string[];
    promotion_blockers: string[];
  };
};

type LearningControlSemanticCandidateProducerOutcome = {
  outcome_version: "learning_control_semantic_candidate_producer_outcome_v1";
  status:
    | "produced"
    | "skipped"
    | "rejected"
    | "provider_failure"
    | "protocol_failure";
  reason: string;
  source_phase: string | null;
  input_tokens: number;
  output_tokens: number;
  candidates: LearningControlSemanticRepairCandidate[];
  errors: string[];
};

type WorkspaceFileSnapshot = Map<string, string>;
type WorkspaceFileContentSnapshot = Map<string, string>;

type AgentRun = {
  arm: AgentArm;
  attempt?: number;
  run_id: string;
  task_id: string;
  workspace_dir: string;
  status: "success" | "failed" | "partial";
  summary: string;
  final_target_files: string[];
  trace: {
    trace_version: "aionis_real_llm_agent_trace_v1";
    started_at: string;
    ended_at: string;
    events: ToolEvent[];
  };
  verifier: CommandResult;
  metrics: RunMetrics;
  aionis_context?: JsonObject | null;
  aionis_guidance?: JsonObject | null;
  semantic_candidate_producer?: LearningControlSemanticCandidateProducerOutcome | null;
  learning_control_candidates?: LearningControlSemanticRepairCandidate[];
  positive_patch_evidence?: JsonObject | null;
};

type RunMetrics = {
  verifier_passed: boolean;
  first_action_correct: boolean | null;
  repeated_discovery_steps: number;
  wrong_file_touches: number;
  tool_step_count: number;
  retry_count: number;
  llm_api_error_count: number;
  llm_protocol_error_count: number;
  llm_protocol_repair_count: number;
  policy_block_recovery_mode_count: number;
  policy_block_recovery_protocol_error_count: number;
  action_synthesis_plan_present: boolean;
  repair_action_compiler_present: boolean;
  verifier_command_run_count: number;
  command_write_count: number;
  command_write_files: string[];
  failure_categories: string[];
  first_write_step: number | null;
  first_target_write_step: number | null;
  first_write_latency_ms: number | null;
  first_target_write_latency_ms: number | null;
  first_action_sequence_present: boolean;
  first_action_sequence_followed: boolean | null;
  first_action_sequence_violation: string | null;
  first_action_sequence_clean_follow: boolean | null;
  first_action_sequence_policy_block_count: number;
  first_action_sequence_recovered: boolean | null;
  first_repair_file_write_step: number | null;
  pre_repair_write_broad_read_count: number;
  repair_second_write_present: boolean;
  second_repair_file_write_step: number | null;
  post_first_repair_pre_second_broad_action_count: number;
  cognitive_entropy_engine_present: boolean;
  cognitive_entropy_counterfactual_probe_required: boolean;
  cognitive_entropy_counterfactual_probe_attempted: boolean;
  cognitive_entropy_counterfactual_probe_files: string[];
  candidate_execution_operator_present: boolean;
  candidate_execution_operator_candidate_count: number;
  candidate_execution_operator_target_files: string[];
  runtime_success_replay_present: boolean;
  runtime_success_replay_attempted: boolean;
  runtime_success_replay_applied: boolean | null;
  runtime_success_replay_patch_count: number;
  runtime_success_replay_candidate_count: number;
  runtime_success_replay_attempted_candidate_count: number;
  runtime_success_replay_failed_candidate_count: number;
  runtime_success_replay_stale_candidate_count: number;
  runtime_success_replay_invalid_candidate_count: number;
  runtime_success_replay_adapted_after_failure: boolean;
  runtime_success_replay_adaptation_within_boundary: boolean | null;
  runtime_success_replay_adaptation_succeeded: boolean;
  runtime_success_replay_files: string[];
  forbidden_file_touches: number;
  forbidden_file_writes: number;
  runtime_learning_quarantine_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  touched_files: string[];
  edited_files: string[];
  time_to_finish_ms: number;
};

type CommandResult = {
  command: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  duration_ms: number;
};

type RuntimeHandle = {
  baseUrl: string;
  stop: () => Promise<void>;
};

type SuccessReplayPatchPlan = {
  patch: string;
  patchCount: number;
  files: string[];
  sourceArm: string | null;
  sourceAttempt: number | null;
  toolStepCount: number;
  firstWriteStep: number;
};

type EffectGateReport = {
  gate_version: "aionis_real_llm_effect_gate_v1";
  status: "pass" | "fail";
  effect_status: "pass" | "fail";
  provider_health_status: "pass" | "fail";
  checks: Array<{
    id: string;
    scope: "effect" | "provider_health";
    pass: boolean;
    observed: number | boolean;
    expected: number | boolean;
  }>;
  failed_checks: string[];
  failed_effect_checks: string[];
  failed_provider_health_checks: string[];
};

type EvalProgressLogger = {
  file: string;
  emit: (event: string, fields?: JsonObject) => void;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const REPORT_VERSION = "aionis_real_llm_agent_eval_v1";
const TRACE_VERSION = "aionis_real_llm_agent_trace_v1";
const PROGRESS_VERSION = "aionis_real_llm_progress_v1";
const REAL_EVAL_LAYER_BOUNDARY = {
  boundary_version: "aionis_real_eval_layer_boundary_v1",
  layer: "real_eval_harness",
  core_runtime_effect: "measurement_only",
  persistence_authority: "none",
  policy_authority: "experimental_policy",
  policy_default_authority: "soft_guidance",
  promotion_authority: "none",
  notes: [
    "Real eval may generate evidence for learning-control review, but it is not Core Runtime product behavior.",
    "Verifier classifiers, edit boundaries, and tool recovery rules in this report are experimental policy surfaces unless separately promoted by real success and holdout evidence.",
    "Failed runs can produce candidates and counter-evidence, not stable workflow authority.",
  ],
} as const satisfies JsonObject;
const TOOL_OUTPUT_LIMIT = 12000;
const LLM_CONTEXT_LIMIT = 24000;
const ALLOWED_AGENT_ACTIONS = [
  "list_files",
  "read_file",
  "search",
  "run_command",
  "replace_text",
  "replace_lines",
  "apply_patch",
  "finish",
] as const;
const COMMAND_SNAPSHOT_EXCLUDED_DIRS = new Set([
  ".git",
  ".tmp",
  "coverage",
  "node_modules",
]);
const POLICY_BLOCK_NONCOMPLIANCE_SAME_ACTION_THRESHOLD = 3;
const POLICY_BLOCK_NONCOMPLIANCE_TOTAL_THRESHOLD = 5;

function usage(): string {
  return `
Usage:
  npm run eval:real-llm -- --suite <real-task-suite.json> [--out <dir>] [--runtime-url <url>] [--task <id[,id...]>]
  npm run eval:real-llm -- --suite <real-task-suite.json> --aionis-only-prior-report <real-llm-eval-report.json> [--out <dir>] [--task <id[,id...]>] [--workspace-ref-override <git-ref>] [--expect-stale-success-replay]
  npm run eval:real-llm -- --suite <real-task-suite.json> --rescore-report <real-llm-eval-report.json> [--out <dir>] [--task <id[,id...]>]

Required real LLM configuration:
  Anthropic:
    AIONIS_REAL_LLM_PROVIDER=anthropic
    ANTHROPIC_API_KEY or AIONIS_REAL_LLM_API_KEY
    ANTHROPIC_MODEL or AIONIS_REAL_LLM_MODEL

  OpenAI-compatible:
    AIONIS_REAL_LLM_PROVIDER=openai_compatible
    AIONIS_REAL_LLM_API_KEY
    AIONIS_REAL_LLM_MODEL
    AIONIS_REAL_LLM_BASE_URL
    AIONIS_REAL_LLM_OPENAI_JSON_MODE optional 1/true to request JSON object responses, default true for OpenAI-compatible providers
    AIONIS_REAL_LLM_OPENAI_EXTRA_BODY_JSON optional provider-specific JSON body fields
    AIONIS_REAL_LLM_TIMEOUT_MS optional per-provider-request timeout
    AIONIS_REAL_LLM_STEP_TIMEOUT_MS optional total timeout for one LLM tool-decision step
    AIONIS_REAL_LLM_MAX_RETRIES optional retry count for transient transport/429/5xx failures
    AIONIS_REAL_LLM_PROTOCOL_RETRIES optional same-step JSON protocol repair retry count
    AIONIS_REAL_LLM_MAX_PROTOCOL_EXHAUSTED_STEPS optional consecutive protocol-exhausted no-action steps before failing an arm

This runner does not provide a mock provider and does not generate synthetic pass results.
It starts a real Lite Runtime unless --runtime-url is provided.
--aionis-only-prior-report loads real prior seed/baseline evidence from a prior report and runs only new real Aionis attempts.
--aionis-prior-evidence controls what prior evidence Aionis can see: all (default), failure-only, or none.
--workspace-ref-override changes selected git task workspaces to a different real Git ref for stale replay validation.
--expect-stale-success-replay makes prior-report mode require failed replay candidates followed by bounded adaptation and verifier pass.
--provider-preflight-only runs only the tiny real LLM provider JSON-contract check, then exits without Runtime/workspaces.
--skip-provider-preflight disables the default tiny real LLM provider JSON-contract check before full evaluation.
--rescore-report recomputes gate and diagnostics from a prior real report without calling an LLM.
The command exits non-zero when the suite effect gate fails.
Progress is written to <out>/progress.jsonl and concise progress lines are printed to stderr.
`.trim();
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unknown positional argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function resolveAionisPriorEvidenceMode(value: string | boolean | undefined): AionisPriorEvidenceMode {
  if (value === undefined || value === false) return "all";
  if (value === true) throw new Error("--aionis-prior-evidence requires one of: all, failure-only, none");
  const mode = value.trim();
  if (mode === "all" || mode === "failure-only" || mode === "none") return mode;
  throw new Error(`--aionis-prior-evidence must be one of: all, failure-only, none; got ${mode}`);
}

function requireString(value: string | undefined, label: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error(`${label} is required for real LLM evaluation`);
  return trimmed;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(parsed);
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function booleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw.trim())) return true;
  if (/^(0|false|no|off)$/i.test(raw.trim())) return false;
  throw new Error(`${name} must be a boolean value: 1/0, true/false, yes/no, or on/off`);
}

function jsonObjectEnv(name: string): JsonObject | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a valid JSON object`);
  }
  const object = asObject(parsed);
  if (!object) throw new Error(`${name} must be a valid JSON object`);
  return object;
}

function resolveProviderConfig(): RealLlmProviderConfig {
  const provider = requireString(process.env.AIONIS_REAL_LLM_PROVIDER, "AIONIS_REAL_LLM_PROVIDER") as ProviderKind;
  if (provider !== "anthropic" && provider !== "openai_compatible") {
    throw new Error("AIONIS_REAL_LLM_PROVIDER must be anthropic or openai_compatible");
  }
  const apiKey = requireString(
    process.env.AIONIS_REAL_LLM_API_KEY ?? (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : undefined),
    provider === "anthropic" ? "ANTHROPIC_API_KEY or AIONIS_REAL_LLM_API_KEY" : "AIONIS_REAL_LLM_API_KEY",
  );
  const model = requireString(
    process.env.AIONIS_REAL_LLM_MODEL ?? (provider === "anthropic" ? process.env.ANTHROPIC_MODEL : undefined),
    provider === "anthropic" ? "ANTHROPIC_MODEL or AIONIS_REAL_LLM_MODEL" : "AIONIS_REAL_LLM_MODEL",
  );
  const baseUrl = requireString(
    process.env.AIONIS_REAL_LLM_BASE_URL
      ?? (provider === "anthropic" ? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" : undefined),
    provider === "anthropic" ? "AIONIS_REAL_LLM_BASE_URL or ANTHROPIC_BASE_URL" : "AIONIS_REAL_LLM_BASE_URL",
  ).replace(/\/+$/, "");
  const timeoutMs = intEnv("AIONIS_REAL_LLM_TIMEOUT_MS", 120000);
  const maxRetries = Math.max(0, intEnv("AIONIS_REAL_LLM_MAX_RETRIES", 2));
  return {
    provider,
    apiKey,
    model,
    baseUrl,
    maxTokens: intEnv("AIONIS_REAL_LLM_MAX_TOKENS", 1200),
    temperature: numberEnv("AIONIS_REAL_LLM_TEMPERATURE", 0),
    timeoutMs,
    stepTimeoutMs: intEnv("AIONIS_REAL_LLM_STEP_TIMEOUT_MS", defaultLlmStepTimeoutMs(timeoutMs, maxRetries)),
    maxRetries,
    protocolRetries: Math.floor(numberEnv("AIONIS_REAL_LLM_PROTOCOL_RETRIES", 2)),
    maxProtocolExhaustedSteps: Math.max(1, intEnv("AIONIS_REAL_LLM_MAX_PROTOCOL_EXHAUSTED_STEPS", 1)),
    openAiJsonMode: provider === "openai_compatible"
      ? booleanEnv("AIONIS_REAL_LLM_OPENAI_JSON_MODE", true)
      : false,
    openAiExtraBody: provider === "openai_compatible"
      ? jsonObjectEnv("AIONIS_REAL_LLM_OPENAI_EXTRA_BODY_JSON")
      : undefined,
  };
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function findLineSequenceNear(args: {
  lines: string[];
  expectedLines: string[];
  requestedStartLine: number;
  searchRadius: number;
}): { startLine: number; endLine: number; candidateStartLines: number[] } | null {
  if (args.expectedLines.length === 0 || args.expectedLines.length > args.lines.length) return null;
  const requestedStartIndex = args.requestedStartLine - 1;
  const firstCandidate = Math.max(0, requestedStartIndex - args.searchRadius);
  const lastCandidate = Math.min(
    args.lines.length - args.expectedLines.length,
    requestedStartIndex + args.searchRadius,
  );
  const candidateStartLines: number[] = [];
  for (let index = firstCandidate; index <= lastCandidate; index += 1) {
    if (stringArraysEqual(args.lines.slice(index, index + args.expectedLines.length), args.expectedLines)) {
      candidateStartLines.push(index + 1);
    }
  }
  if (candidateStartLines.length !== 1) {
    return candidateStartLines.length > 1
      ? {
          startLine: candidateStartLines[0] as number,
          endLine: (candidateStartLines[0] as number) + args.expectedLines.length - 1,
          candidateStartLines,
        }
      : null;
  }
  const startLine = candidateStartLines[0] as number;
  return {
    startLine,
    endLine: startLine + args.expectedLines.length - 1,
    candidateStartLines,
  };
}

function findLineSequenceInFile(args: {
  lines: string[];
  expectedLines: string[];
}): { startLine: number; endLine: number; candidateStartLines: number[] } | null {
  if (args.expectedLines.length === 0 || args.expectedLines.length > args.lines.length) return null;
  const candidateStartLines: number[] = [];
  for (let index = 0; index <= args.lines.length - args.expectedLines.length; index += 1) {
    if (stringArraysEqual(args.lines.slice(index, index + args.expectedLines.length), args.expectedLines)) {
      candidateStartLines.push(index + 1);
    }
  }
  if (candidateStartLines.length === 0) return null;
  const startLine = candidateStartLines[0] as number;
  return {
    startLine,
    endLine: startLine + args.expectedLines.length - 1,
    candidateStartLines,
  };
}

function truncate(text: string, max = TOOL_OUTPUT_LIMIT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function createProgressLogger(args: {
  outDir: string;
  quiet: boolean;
}): EvalProgressLogger {
  const file = path.join(args.outDir, "progress.jsonl");
  const emit = (event: string, fields: JsonObject = {}) => {
    const payload = {
      progress_version: PROGRESS_VERSION,
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[real-llm-eval] progress_write_failed detail=${truncate(detail, 500)}\n`);
    }
    if (!args.quiet) {
      const task = asString(fields.task_id);
      const arm = asString(fields.arm);
      const attempt = typeof fields.attempt === "number" ? `#${fields.attempt}` : "";
      const status = asString(fields.status);
      const step = typeof fields.step === "number" ? ` step=${fields.step}` : "";
      const detail = asString(fields.detail) ?? asString(fields.tool_name) ?? asString(fields.command);
      console.error([
        `[real-llm-eval] ${event}`,
        task ? `task=${task}` : null,
        arm ? `arm=${arm}${attempt}` : null,
        status ? `status=${status}` : null,
        step.trim() ? step.trim() : null,
        detail ? `detail=${detail}` : null,
      ].filter(Boolean).join(" "));
    }
  };
  return { file, emit };
}

function selectSuiteTasks(suite: EvalSuite, taskFilterRaw: string | undefined): EvalSuite {
  if (!taskFilterRaw) return suite;
  const ids = taskFilterRaw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return suite;
  const idSet = new Set(ids);
  const tasks = suite.tasks.filter((task) => idSet.has(task.id));
  const missing = ids.filter((id) => !tasks.some((task) => task.id === id));
  if (missing.length > 0) {
    throw new Error(`--task referenced unknown task id(s): ${missing.join(", ")}`);
  }
  return {
    ...suite,
    suite_id: `${suite.suite_id}__filtered__${ids.join("_")}`,
    description: [
      suite.description,
      `Filtered to task(s): ${ids.join(", ")}`,
    ].filter(Boolean).join(" "),
    tasks,
  };
}

function parseJsonObjectCandidate(candidate: string): JsonObject | null {
  try {
    const parsed = JSON.parse(candidate.trim());
    const obj = asObject(parsed);
    if (obj) return obj;
  } catch {
    return null;
  }
  return null;
}

function extractJsonObjectFromText(text: string): JsonObject {
  const trimmed = text.trim();
  const direct = parseJsonObjectCandidate(trimmed);
  if (direct) return direct;

  for (const match of trimmed.matchAll(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g)) {
    const fenced = parseJsonObjectCandidate(match[1] ?? "");
    if (fenced) return fenced;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const embedded = parseJsonObjectCandidate(trimmed.slice(first, last + 1));
    if (embedded) return embedded;
  }
  throw new Error("LLM response did not contain a JSON object");
}

function likelyIncompleteJsonResponse(text: string | null | undefined): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("{")) return false;
  if (!trimmed.endsWith("}")) return true;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth !== 0 || inString;
}

function actionFromJsonLikeResponse(text: string | null | undefined): string | null {
  const match = (text ?? "").match(/["']action["']\s*:\s*["']([a-z_]+)["']/i);
  return match?.[1] ?? null;
}

function validateAgentProtocolAction(action: JsonObject): void {
  const toolName = asString(action.action);
  if (!toolName) {
    throw new Error("LLM JSON object must include a non-empty string action");
  }
  if (!ALLOWED_AGENT_ACTIONS.includes(toolName as typeof ALLOWED_AGENT_ACTIONS[number])) {
    throw new Error(`Unsupported action "${toolName}". Allowed actions: ${ALLOWED_AGENT_ACTIONS.join(", ")}`);
  }
  if (!asObject(action.input)) {
    throw new Error(`LLM JSON object for action "${toolName}" must include an input object`);
  }
}

class RealLlmTransientError extends Error {
  retryable = true;
}

class ToolStructuredError extends Error {
  constructor(message: string, readonly details: JsonObject) {
    super(message);
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableLlmError(error: unknown): boolean {
  if (error instanceof RealLlmTransientError) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error instanceof TypeError && /fetch failed|network|terminated|socket|connection/i.test(error.message)) return true;
  return false;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function llmRetryBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

function defaultLlmStepTimeoutMs(requestTimeoutMs: number, maxRetries: number): number {
  let retryDelayBudgetMs = 0;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    retryDelayBudgetMs += llmRetryBackoffMs(attempt);
  }
  return requestTimeoutMs * (maxRetries + 1) + retryDelayBudgetMs + 5000;
}

async function callRealLlm(args: {
  provider: RealLlmProviderConfig;
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  onRetry?: (event: {
    providerAttempt: number;
    providerMaxAttempts: number;
    retryDelayMs: number;
    elapsedMs: number;
    remainingStepTimeoutMs: number;
    detail: string;
  }) => void;
}): Promise<LlmResponse> {
  const maxAttempts = args.provider.maxRetries + 1;
  const startedMs = Date.now();
  const deadlineMs = startedMs + args.provider.stepTimeoutMs;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingBeforeAttemptMs = deadlineMs - Date.now();
    if (remainingBeforeAttemptMs <= 0) {
      throw new RealLlmTransientError(
        `LLM step exceeded total timeout ${args.provider.stepTimeoutMs}ms before provider attempt ${attempt}`,
      );
    }
    try {
      return await callRealLlmOnce({
        ...args,
        timeoutMs: Math.max(1, Math.min(args.provider.timeoutMs, remainingBeforeAttemptMs)),
      });
    } catch (err) {
      lastError = err;
      if (!isRetryableLlmError(err) || attempt >= maxAttempts) throw err;
      const retryDelayMs = llmRetryBackoffMs(attempt);
      const remainingStepTimeoutMs = Math.max(0, deadlineMs - Date.now());
      if (remainingStepTimeoutMs <= retryDelayMs) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new RealLlmTransientError(
          `LLM step exceeded total timeout ${args.provider.stepTimeoutMs}ms after provider attempt ${attempt}: ${truncate(detail, 500)}`,
        );
      }
      args.onRetry?.({
        providerAttempt: attempt,
        providerMaxAttempts: maxAttempts,
        retryDelayMs,
        elapsedMs: Date.now() - startedMs,
        remainingStepTimeoutMs,
        detail: err instanceof Error ? err.message : String(err),
      });
      await sleepMs(retryDelayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callRealLlmOnce(args: {
  provider: RealLlmProviderConfig;
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<LlmResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? args.provider.timeoutMs);
  const maxTokens = Math.max(1, Math.floor(args.maxTokens ?? args.provider.maxTokens));
  try {
    if (args.provider.provider === "anthropic") {
      const response = await fetch(`${args.provider.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": args.provider.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: args.provider.model,
          max_tokens: maxTokens,
          temperature: args.provider.temperature,
          system: args.system,
          messages: args.messages.map((message) => ({
            role: message.role,
            content: [{ type: "text", text: message.content }],
          })),
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(async () => ({ raw: await response.text().catch(() => "") }));
      if (!response.ok) {
        const message = `Anthropic API failed: ${response.status} ${truncate(JSON.stringify(payload), 2000)}`;
        if (isRetryableHttpStatus(response.status)) throw new RealLlmTransientError(message);
        throw new Error(message);
      }
      const root = asObject(payload);
      const content = Array.isArray(root?.content) ? root.content : [];
      const text = content
        .map((entry) => asString(asObject(entry)?.text) ?? "")
        .filter(Boolean)
        .join("\n");
      if (!text) throw new RealLlmTransientError("Anthropic API returned no text content");
      const usage = asObject(root?.usage);
      return {
        text,
        inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : null,
        outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
      };
    }

    const response = await fetch(`${args.provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.provider.apiKey}`,
      },
      body: JSON.stringify({
        model: args.provider.model,
        temperature: args.provider.temperature,
        max_tokens: maxTokens,
        ...(args.provider.openAiJsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(args.provider.openAiExtraBody ?? {}),
        messages: [
          { role: "system", content: args.system },
          ...args.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(async () => ({ raw: await response.text().catch(() => "") }));
    if (!response.ok) {
      const message = `OpenAI-compatible API failed: ${response.status} ${truncate(JSON.stringify(payload), 2000)}`;
      if (isRetryableHttpStatus(response.status)) throw new RealLlmTransientError(message);
      throw new Error(message);
    }
    const root = asObject(payload);
    const first = asObject(Array.isArray(root?.choices) ? root?.choices[0] : null);
    const message = asObject(first?.message);
    const text = asString(message?.content);
    if (!text) {
      const diagnostics = {
        finish_reason: asString(first?.finish_reason) ?? null,
        message_keys: message ? Object.keys(message).sort() : [],
        content_type: typeof message?.content,
        reasoning_content_length: typeof message?.reasoning_content === "string" ? message.reasoning_content.length : null,
      };
      throw new RealLlmTransientError(`OpenAI-compatible API returned no text content: ${JSON.stringify(diagnostics)}`);
    }
    const usage = asObject(root?.usage);
    return {
      text,
      inputTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
      outputTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, "utf8")) as T;
}

async function runProviderPreflight(
  provider: RealLlmProviderConfig,
  progress: EvalProgressLogger,
): Promise<JsonObject> {
  const startedMs = Date.now();
  const preflightProvider: RealLlmProviderConfig = {
    ...provider,
    maxTokens: Math.min(provider.maxTokens, 32),
    timeoutMs: Math.min(provider.timeoutMs, 30_000),
    stepTimeoutMs: Math.min(provider.stepTimeoutMs, 45_000),
    maxRetries: Math.min(provider.maxRetries, 1),
  };
  progress.emit("provider_preflight_start", {
    provider: provider.provider,
    base_url: provider.baseUrl,
    model: provider.model,
    openai_json_mode: provider.openAiJsonMode,
  });
  try {
    const response = await callRealLlm({
      provider: preflightProvider,
      maxTokens: preflightProvider.maxTokens,
      system: "Return exactly one small JSON object. No markdown. No prose.",
      messages: [{
        role: "user",
        content: "Return {\"ok\":true,\"kind\":\"provider_preflight\"}.",
      }],
      onRetry: (event) => progress.emit("provider_preflight_retry", {
        provider_attempt: event.providerAttempt,
        provider_max_attempts: event.providerMaxAttempts,
        retry_delay_ms: event.retryDelayMs,
        remaining_step_timeout_ms: event.remainingStepTimeoutMs,
        detail: truncate(event.detail, 500),
      }),
    });
    const parsed = extractJsonObjectFromText(response.text);
    if (parsed.ok !== true || asString(parsed.kind) !== "provider_preflight") {
      throw new Error(`Provider preflight returned unexpected JSON contract: ${truncate(JSON.stringify(parsed), 500)}`);
    }
    const result: JsonObject = {
      status: "pass",
      provider: provider.provider,
      base_url: provider.baseUrl,
      model: provider.model,
      openai_json_mode: provider.openAiJsonMode,
      latency_ms: Date.now() - startedMs,
      input_tokens: response.inputTokens,
      output_tokens: response.outputTokens,
    };
    progress.emit("provider_preflight_pass", result);
    return result;
  } catch (err) {
    const result: JsonObject = {
      status: "fail",
      provider: provider.provider,
      base_url: provider.baseUrl,
      model: provider.model,
      openai_json_mode: provider.openAiJsonMode,
      latency_ms: Date.now() - startedMs,
      error: truncate(err instanceof Error ? err.message : String(err), 2000),
    };
    progress.emit("provider_preflight_fail", result);
    return result;
  }
}

function validateSuite(value: EvalSuite): void {
  if (!value || typeof value !== "object") throw new Error("suite must be an object");
  if (!value.suite_id) throw new Error("suite_id is required");
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error("suite.tasks must contain real tasks");
  for (const task of value.tasks) {
    if (!task.id || !task.prompt) throw new Error("each task requires id and prompt");
    if (task.workspace?.source === "copy") {
      if (!task.workspace.path) throw new Error(`task ${task.id} requires workspace.path`);
    } else if (task.workspace?.source === "git") {
      if (!task.workspace.repo_url || !task.workspace.ref) {
        throw new Error(`task ${task.id} requires workspace.repo_url and workspace.ref for git source`);
      }
    } else {
      throw new Error(`task ${task.id} requires workspace.source=copy or workspace.source=git`);
    }
    if (!task.verifier?.command) throw new Error(`task ${task.id} requires a verifier.command`);
    if (task.aionis_attempts !== undefined && (!Number.isInteger(task.aionis_attempts) || task.aionis_attempts < 1 || task.aionis_attempts > 4)) {
      throw new Error(`task ${task.id} aionis_attempts must be an integer from 1 to 4`);
    }
  }
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a local port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Runtime did not become healthy at ${baseUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function startRuntimeIfNeeded(args: {
  runtimeUrl?: string;
  outDir: string;
  provider: RealLlmProviderConfig;
}): Promise<RuntimeHandle> {
  if (args.runtimeUrl) {
    await waitForHealth(args.runtimeUrl.replace(/\/+$/, ""), 10000);
    return { baseUrl: args.runtimeUrl.replace(/\/+$/, ""), stop: async () => undefined };
  }

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtimeDir = path.join(args.outDir, "runtime");
  await fsp.mkdir(runtimeDir, { recursive: true });
  const logFile = path.join(runtimeDir, "lite-runtime.log");
  const log = fs.createWriteStream(logFile, { flags: "a" });
  const providerTransport =
    args.provider.provider === "anthropic" ? "anthropic_messages_v1" : "openai_chat_completions_v1";
  const child = spawn("npm", ["run", "-s", "lite:start"], {
    cwd: ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      AIONIS_LISTEN_HOST: "127.0.0.1",
      MEMORY_AUTH_MODE: "off",
      TENANT_QUOTA_ENABLED: "false",
      RATE_LIMIT_BYPASS_LOOPBACK: "true",
      LITE_LOCAL_ACTOR_ID: "aionis-real-llm-eval",
      LITE_REPLAY_SQLITE_PATH: path.join(runtimeDir, "replay.sqlite"),
      LITE_WRITE_SQLITE_PATH: path.join(runtimeDir, "write.sqlite"),
      REPLAY_LEARNING_PROJECTION_DELIVERY: "sync_inline",
      REPLAY_LEARNING_CONTROL_STATIC_PROMOTE_MEMORY_PROVIDER_ENABLED: "false",
      REPLAY_LEARNING_CONTROL_HTTP_MODEL_PROMOTE_MEMORY_PROVIDER_ENABLED: "true",
      WORKFLOW_LEARNING_CONTROL_STATIC_PROMOTE_MEMORY_PROVIDER_ENABLED: "false",
      WORKFLOW_LEARNING_CONTROL_HTTP_MODEL_PROMOTE_MEMORY_PROVIDER_ENABLED: "true",
      TOOLS_LEARNING_CONTROL_STATIC_FORM_PATTERN_PROVIDER_ENABLED: "false",
      TOOLS_LEARNING_CONTROL_HTTP_MODEL_FORM_PATTERN_PROVIDER_ENABLED: "true",
      LEARNING_CONTROL_MODEL_CLIENT_TRANSPORT: providerTransport,
      LEARNING_CONTROL_MODEL_CLIENT_BASE_URL: args.provider.baseUrl,
      LEARNING_CONTROL_MODEL_CLIENT_API_KEY: args.provider.apiKey,
      LEARNING_CONTROL_MODEL_CLIENT_MODEL: args.provider.model,
      LEARNING_CONTROL_MODEL_CLIENT_TIMEOUT_MS: String(Math.min(args.provider.timeoutMs, 60000)),
      LEARNING_CONTROL_MODEL_CLIENT_MAX_TOKENS: "1200",
      LEARNING_CONTROL_MODEL_CLIENT_TEMPERATURE: "0",
      LEARNING_CONTROL_MODEL_CLIENT_OPENAI_EXTRA_BODY_JSON: args.provider.openAiExtraBody
        ? JSON.stringify(args.provider.openAiExtraBody)
        : "",
    },
  });
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  await waitForHealth(baseUrl, 30000);
  return {
    baseUrl,
    stop: async () => {
      if (!childExited && !child.killed) child.kill("SIGTERM");
      if (!childExited) await new Promise((resolve) => child.once("exit", resolve));
      log.end();
    },
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspacePath(workspaceDir: string, relativePath: string): string {
  const resolved = path.resolve(workspaceDir, relativePath);
  if (!isInside(workspaceDir, resolved)) throw new Error(`Path escapes workspace: ${relativePath}`);
  return resolved;
}

function resolveWorkspaceFile(workspaceDir: string, inputPath: string): { file: string; rel: string } {
  const file = resolveWorkspacePath(workspaceDir, inputPath);
  const rel = path.relative(workspaceDir, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes workspace: ${inputPath}`);
  return { file, rel };
}

function resolveWorkspaceCommandPath(workspaceDir: string, inputPath: string): string {
  if (/[*?[\]{}]/.test(inputPath)) {
    throw new Error(`Runtime edit boundary requires explicit file paths, not globs: ${inputPath}`);
  }
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workspaceDir, inputPath);
  if (!isInside(workspaceDir, resolved)) throw new Error(`Path escapes workspace: ${inputPath}`);
  const rel = path.relative(workspaceDir, resolved);
  if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Runtime edit boundary requires file paths inside the workspace: ${inputPath}`);
  }
  return rel;
}

async function workspaceFileFingerprint(file: string): Promise<string> {
  const stat = await fsp.lstat(file);
  if (stat.isSymbolicLink()) return `symlink:${await fsp.readlink(file)}`;
  if (!stat.isFile()) return `other:${stat.mode}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  const hash = crypto.createHash("sha256");
  hash.update(await fsp.readFile(file));
  return `file:${stat.mode}:${stat.size}:${hash.digest("hex")}`;
}

async function snapshotWorkspaceFiles(workspaceDir: string): Promise<WorkspaceFileSnapshot> {
  const snapshot: WorkspaceFileSnapshot = new Map();
  async function visit(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (COMMAND_SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(workspaceDir, absolute);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        snapshot.set(rel, await workspaceFileFingerprint(absolute));
      }
    }
  }
  await visit(workspaceDir);
  return snapshot;
}

function changedFilesFromSnapshots(before: WorkspaceFileSnapshot, after: WorkspaceFileSnapshot): string[] {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

async function readWorkspaceFileContents(
  workspaceDir: string,
  files: string[],
  maxBytesPerFile = 250_000,
): Promise<WorkspaceFileContentSnapshot> {
  const snapshot: WorkspaceFileContentSnapshot = new Map();
  for (const requestedPath of files) {
    try {
      const { file, rel } = resolveWorkspaceFile(workspaceDir, requestedPath);
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > maxBytesPerFile) continue;
      snapshot.set(rel, await fsp.readFile(file, "utf8"));
    } catch {
      continue;
    }
  }
  return snapshot;
}

async function unifiedDiffForText(args: {
  rel: string;
  before: string;
  after: string;
}): Promise<string> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aionis-real-llm-diff-"));
  try {
    const beforeFile = path.join(tempDir, "before");
    const afterFile = path.join(tempDir, "after");
    await fsp.writeFile(beforeFile, args.before, "utf8");
    await fsp.writeFile(afterFile, args.after, "utf8");
    const result = await runCommand(
      `git diff --no-index --no-prefix ${JSON.stringify(beforeFile)} ${JSON.stringify(afterFile)}`,
      tempDir,
      30000,
    );
    const raw = result.stdout || result.stderr || "";
    const beforeDisplay = `a/${args.rel}`;
    const afterDisplay = `b/${args.rel}`;
    const beforeNoLeadingSlash = beforeFile.replace(/^\/+/, "");
    const afterNoLeadingSlash = afterFile.replace(/^\/+/, "");
    return canonicalWorkspacePatchForPath(raw
      .replaceAll(beforeFile, beforeDisplay)
      .replaceAll(afterFile, afterDisplay)
      .replaceAll(beforeNoLeadingSlash, beforeDisplay)
      .replaceAll(afterNoLeadingSlash, afterDisplay), args.rel);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function buildPositivePatchEvidence(args: {
  workspaceDir: string;
  before: WorkspaceFileContentSnapshot;
  files: string[];
  verifierCommand: string;
}): Promise<JsonObject | null> {
  const changedPatches: JsonObject[] = [];
  for (const requestedPath of args.files) {
    let rel = requestedPath;
    let after = "";
    try {
      const resolved = resolveWorkspaceFile(args.workspaceDir, requestedPath);
      rel = resolved.rel;
      after = await fsp.readFile(resolved.file, "utf8");
    } catch {
      continue;
    }
    const before = args.before.get(rel);
    if (typeof before !== "string" || before === after) continue;
    const patch = await unifiedDiffForText({ rel, before, after });
    changedPatches.push({
      path: rel,
      patch,
    });
  }
  if (changedPatches.length === 0) return null;
  return {
    schema_version: "aionis_positive_patch_evidence_v1",
    verifier_command: args.verifierCommand,
    changed_files: changedPatches.map((entry) => asString(entry.path)).filter((file): file is string => !!file),
    patches: changedPatches,
  };
}

function suiteCacheSegment(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function commandWithRuntimePlaceholders(command: string, workspaceDir: string): string {
  return command
    .replaceAll("{AIONIS_ROOT}", ROOT_DIR)
    .replaceAll("${AIONIS_ROOT}", ROOT_DIR)
    .replaceAll("{WORKSPACE_DIR}", workspaceDir)
    .replaceAll("${WORKSPACE_DIR}", workspaceDir);
}

function commandFailureSummary(result: CommandResult): string {
  return [
    `exit=${result.exit_code}`,
    `signal=${result.signal ?? ""}`,
    `timed_out=${result.timed_out}`,
    `duration_ms=${result.duration_ms}`,
    result.stderr ? `stderr:\n${result.stderr}` : null,
    result.stdout ? `stdout:\n${result.stdout}` : null,
  ].filter((line): line is string => !!line).join("\n");
}

function taskWithWorkspaceRefOverride(task: EvalTask, refOverride: string | null | undefined): EvalTask {
  if (!refOverride || task.workspace.source !== "git") return task;
  return {
    ...task,
    workspace: {
      ...task.workspace,
      ref: refOverride,
    },
  };
}

function suiteWithWorkspaceRefOverride(suite: EvalSuite, refOverride: string | null | undefined): EvalSuite {
  if (!refOverride) return suite;
  return {
    ...suite,
    suite_id: `${suite.suite_id}__workspace_ref_${suiteCacheSegment(refOverride)}`,
    tasks: suite.tasks.map((task) => taskWithWorkspaceRefOverride(task, refOverride)),
  };
}

async function ensureGitWorkspaceSource(task: EvalTask, outDir: string): Promise<string> {
  if (task.workspace.source !== "git") throw new Error(`task ${task.id} is not a git workspace`);
  const cacheKey = suiteCacheSegment([
    task.workspace.repo_url,
    task.workspace.ref,
    JSON.stringify(task.workspace.setup_commands ?? []),
  ].join("\n"));
  const sourceDir = path.join(outDir, "sources", `${task.id}-${cacheKey}`);
  const gitDir = path.join(sourceDir, ".git");
  if (!fs.existsSync(gitDir)) {
    await fsp.rm(sourceDir, { recursive: true, force: true });
    await fsp.mkdir(sourceDir, { recursive: true });
    const init = await runCommand("git init", sourceDir, 30000);
    if (init.exit_code !== 0) throw new Error(`git init failed for ${task.id}: ${init.stderr || init.stdout}`);
    const remote = await runCommand(`git remote add origin ${JSON.stringify(task.workspace.repo_url)}`, sourceDir, 30000);
    if (remote.exit_code !== 0) throw new Error(`git remote add failed for ${task.id}: ${remote.stderr || remote.stdout}`);
    const depth = Math.max(1, Math.floor(task.workspace.checkout_depth ?? 1));
    const fetch = await runCommand(`git fetch --depth ${depth} origin ${JSON.stringify(task.workspace.ref)}`, sourceDir, 120000);
    if (fetch.exit_code !== 0) throw new Error(`git fetch failed for ${task.id}: ${fetch.stderr || fetch.stdout}`);
    const checkout = await runCommand("git checkout --detach FETCH_HEAD", sourceDir, 30000);
    if (checkout.exit_code !== 0) throw new Error(`git checkout failed for ${task.id}: ${checkout.stderr || checkout.stdout}`);
  }
  const setupCommands = task.workspace.setup_commands ?? [];
  if (setupCommands.length > 0) {
    const setupMarker = path.join(
      sourceDir,
      ".aionis-real-llm-setup.json",
    );
    if (!fs.existsSync(setupMarker)) {
      const results: JsonObject[] = [];
      const setupAttempts = Math.max(1, Math.floor(numberEnv("AIONIS_REAL_WORKSPACE_SETUP_ATTEMPTS", 2)));
      for (const setup of setupCommands) {
        const command = commandWithRuntimePlaceholders(setup.command, sourceDir);
        if (!commandAllowed(command)) {
          throw new Error(`setup command is not allowed for ${task.id}: ${command}`);
        }
        let lastResult: CommandResult | null = null;
        for (let attempt = 1; attempt <= setupAttempts; attempt += 1) {
          const result = await runCommand(command, sourceDir, setup.timeout_ms ?? 120000);
          lastResult = result;
          results.push({
            command,
            attempt,
            exit_code: result.exit_code,
            timed_out: result.timed_out,
            duration_ms: result.duration_ms,
          });
          if (result.exit_code === 0 && !result.timed_out) break;
          if (attempt < setupAttempts) await sleepMs(Math.min(1000 * 2 ** (attempt - 1), 8000));
        }
        if (!lastResult || lastResult.exit_code !== 0 || lastResult.timed_out) {
          throw new Error(`setup command failed for ${task.id}: ${command}\n${lastResult ? commandFailureSummary(lastResult) : "no setup attempt executed"}`);
        }
      }
      await fsp.writeFile(setupMarker, JSON.stringify({ task_id: task.id, setup: results }, null, 2), "utf8");
    }
  }
  return sourceDir;
}

async function resolveWorkspaceSource(task: EvalTask, outDir: string): Promise<string> {
  if (task.workspace.source === "copy") return path.resolve(ROOT_DIR, task.workspace.path);
  return await ensureGitWorkspaceSource(task, outDir);
}

async function prepareWorkspace(task: EvalTask, arm: string, outDir: string): Promise<string> {
  const source = await resolveWorkspaceSource(task, outDir);
  const dest = path.join(outDir, "workspaces", task.id, arm);
  const copyDest = isInside(source, dest)
    ? path.join(path.dirname(source), `.aionis-real-llm-workspace-${crypto.randomUUID()}`)
    : dest;
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.rm(copyDest, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(copyDest), { recursive: true });
  const defaultExcludes = new Set([".git", ".tmp", "node_modules", "coverage"]);
  for (const entry of task.workspace.exclude ?? []) defaultExcludes.add(entry);
  try {
    await fsp.cp(source, copyDest, {
      recursive: true,
      filter: (candidate) => {
        const rel = path.relative(source, candidate);
        if (!rel) return true;
        const parts = rel.split(path.sep);
        return !parts.some((part) => defaultExcludes.has(part));
      },
    });
    if (copyDest !== dest) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(copyDest, dest);
    }
    if (task.workspace.link_node_modules !== false) {
      const sourceNodeModules = path.join(source, "node_modules");
      const destNodeModules = path.join(dest, "node_modules");
      if (fs.existsSync(sourceNodeModules) && !fs.existsSync(destNodeModules)) {
        await fsp.symlink(sourceNodeModules, destNodeModules, "dir");
      }
    }
  } catch (err) {
    await fsp.rm(copyDest, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return dest;
}

function commandAllowed(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const forbidden = /\b(rm|mv|cp|sudo|chmod|chown|kill|pkill|dd|mkfs)\b|[;&|]|\$\(|`|>\s*|>>|[\r\n]/;
  if (forbidden.test(trimmed)) return false;
  const allowedPrefixes = [
    "pwd",
    "ls",
    "find ",
    "rg ",
    "sed ",
    "cat ",
    "test ",
    "npm ",
    "npx ",
    "node ",
    "git status",
    "git diff",
    "git apply",
    "curl -fsS http://127.0.0.1:",
  ];
  return allowedPrefixes.some((prefix) => trimmed === prefix.trim() || trimmed.startsWith(prefix));
}

function splitCommandWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error("Command contains unmatched shell quote");
  if (current.length > 0) words.push(current);
  return words;
}

function commandBaseName(value: string | undefined): string {
  return path.basename(String(value ?? ""));
}

function stripOptionValue(args: string[], index: number): number {
  const option = args[index] as string | undefined;
  if (!option || option.includes("=")) return index + 1;
  const optionsWithValues = new Set([
    "--cache",
    "--config",
    "--cwd",
    "--ext",
    "--extension",
    "--ignore",
    "--ignore-pattern",
    "--package",
    "--parser",
    "--plugin",
    "--reporter",
    "--rule",
    "--stdin-filepath",
    "-c",
    "-f",
    "-p",
  ]);
  return optionsWithValues.has(option) ? index + 2 : index + 1;
}

function formatterWriteFlags(tool: string): string[] {
  const writeFlagsByTool: Record<string, string[]> = {
    xo: ["--fix"],
    eslint: ["--fix"],
    prettier: ["--write"],
    biome: ["--write"],
    rome: ["--write"],
  };
  return writeFlagsByTool[tool] ?? [];
}

function runnerToolArgs(argv: string[]): { tool: string; args: string[] } | null {
  const command = commandBaseName(argv[0]);
  if (command === "npx") {
    let toolIndex = 1;
    while (toolIndex < argv.length && argv[toolIndex]?.startsWith("-")) {
      toolIndex = stripOptionValue(argv, toolIndex);
    }
    const tool = commandBaseName(argv[toolIndex]);
    return tool ? { tool, args: argv.slice(toolIndex + 1) } : null;
  }
  if (command === "npm" && argv[1] === "exec") {
    let toolIndex = 2;
    while (toolIndex < argv.length && argv[toolIndex]?.startsWith("-")) {
      toolIndex = stripOptionValue(argv, toolIndex);
    }
    const tool = commandBaseName(argv[toolIndex]);
    const args = argv[toolIndex + 1] === "--" ? argv.slice(toolIndex + 2) : argv.slice(toolIndex + 1);
    return tool ? { tool, args } : null;
  }
  if (["xo", "eslint", "prettier", "biome", "rome"].includes(command)) {
    return { tool: command, args: argv.slice(1) };
  }
  return null;
}

function nonOptionArgsAfterWriteFlag(args: string[], writeFlags: string[]): string[] {
  const firstWriteFlag = args.findIndex((arg) => writeFlags.includes(arg));
  if (firstWriteFlag < 0) return [];
  const out: string[] = [];
  for (let index = firstWriteFlag + 1; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      index = stripOptionValue(args, index) - 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function formatterWriteTargets(argv: string[], workspaceDir: string): string[] | null {
  const runner = runnerToolArgs(argv);
  if (!runner) return null;
  const { tool, args } = runner;
  const writeFlags = formatterWriteFlags(tool);
  if (!writeFlags || !args.some((arg) => writeFlags.includes(arg))) return null;
  return nonOptionArgsAfterWriteFlag(args, writeFlags).map((file) => resolveWorkspaceCommandPath(workspaceDir, file));
}

function formatterWriteCommandPrefix(argv: string[]): string[] | null {
  const runner = runnerToolArgs(argv);
  if (!runner) return null;
  const writeFlags = formatterWriteFlags(runner.tool);
  if (writeFlags.length === 0) return null;
  const writeFlagIndex = argv.findIndex((arg) => writeFlags.includes(arg));
  if (writeFlagIndex < 0) return null;
  let targetStartIndex = writeFlagIndex + 1;
  while (targetStartIndex < argv.length) {
    const arg = argv[targetStartIndex] as string | undefined;
    if (!arg) break;
    if (arg === "--") {
      targetStartIndex += 1;
      break;
    }
    if (!arg.startsWith("-")) break;
    targetStartIndex = stripOptionValue(argv, targetStartIndex);
  }
  return argv.slice(0, targetStartIndex);
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatterCommandWithTargets(command: string, files: string[]): string | null {
  const argv = splitCommandWords(command);
  const prefix = formatterWriteCommandPrefix(argv);
  if (!prefix || files.length === 0) return null;
  return [...prefix, ...files].map(shellQuoteArg).join(" ");
}

function packageManagerMutatesProject(argv: string[]): boolean {
  const command = commandBaseName(argv[0]);
  const subcommand = argv[1];
  if (command === "npm") {
    return [
      "add",
      "audit",
      "ci",
      "dedupe",
      "i",
      "install",
      "link",
      "prune",
      "rebuild",
      "remove",
      "uninstall",
      "update",
    ].includes(String(subcommand));
  }
  if (command === "pnpm" || command === "yarn" || command === "bun") {
    return [
      "add",
      "install",
      "link",
      "remove",
      "uninstall",
      "update",
      "upgrade",
    ].includes(String(subcommand));
  }
  return false;
}

function nodeEvalMayMutate(argv: string[]): boolean {
  const command = commandBaseName(argv[0]);
  if (command !== "node") return false;
  const evalIndex = argv.findIndex((arg) => arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print");
  if (evalIndex < 0) return false;
  const evalSource = argv[evalIndex + 1] ?? "";
  return /\b(writeFile|appendFile|rm|unlink|rename|mkdir|rmdir|copyFile|truncate)Sync?\b/.test(evalSource);
}

function assertCommandAllowedByWritePolicy(command: string, workspaceDir: string, policy: RuntimeWritePolicy | null | undefined): void {
  if (!policy) return;
  const argv = splitCommandWords(command);
  if (argv.length === 0) throw new Error("Command is empty");
  const executable = commandBaseName(argv[0]);
  if (executable === "git" && argv[1] === "apply") {
    throw new Error("Runtime edit boundary blocks run_command git apply; use apply_patch so target files are enforced before execution");
  }
  if (packageManagerMutatesProject(argv)) {
    throw new Error("Runtime edit boundary blocks package-manager mutation commands during assisted edits");
  }
  if (nodeEvalMayMutate(argv)) {
    throw new Error("Runtime edit boundary blocks node eval commands that can mutate files during assisted edits");
  }
  const formatterTargets = formatterWriteTargets(argv, workspaceDir);
  if (formatterTargets !== null) {
    if (formatterTargets.length === 0) {
      throw new Error("Runtime edit boundary blocks formatter --fix/--write commands without explicit file targets");
    }
    assertWriteAllowed(policy, formatterTargets);
  }
}

async function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: process.env.SHELL || "/bin/zsh",
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exited = false;
    const killProcessGroup = (signal: NodeJS.Signals): void => {
      if (typeof child.pid === "number") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to killing the spawned shell directly.
        }
      }
      child.kill(signal);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
      setTimeout(() => {
        if (!exited) killProcessGroup("SIGKILL");
      }, 1000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code, signal) => {
      exited = true;
      clearTimeout(timer);
      resolve({
        command,
        exit_code: code,
        signal,
        timed_out: timedOut,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        duration_ms: Date.now() - started,
      });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({
        command,
        exit_code: null,
        signal: null,
        timed_out: timedOut,
        stdout: truncate(stdout),
        stderr: truncate(`${stderr}\n${err instanceof Error ? err.message : String(err)}`),
        duration_ms: Date.now() - started,
      });
    });
  });
}

async function applyUnifiedDiff(workspaceDir: string, patch: string, timeoutMs: number): Promise<CommandResult> {
  const patchFile = path.join(os.tmpdir(), `aionis-real-llm-patch-${crypto.randomUUID()}.diff`);
  await fsp.writeFile(patchFile, normalizeUnifiedDiffPatch(patch), "utf8");
  try {
    return await runCommand(`git apply --whitespace=nowarn ${JSON.stringify(patchFile)}`, workspaceDir, timeoutMs);
  } finally {
    await fsp.rm(patchFile, { force: true });
  }
}

function normalizeUnifiedDiffPatch(patch: string): string {
  const normalized = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function canonicalWorkspacePatchForPath(patch: string, rel: string): string {
  const normalized = normalizeUnifiedDiffPatch(patch);
  const safeRel = rel.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!safeRel || safeRel.startsWith("../")) return normalized;
  return normalized
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) return `diff --git a/${safeRel} b/${safeRel}`;
      if (line.startsWith("--- ") && line !== "--- /dev/null") return `--- a/${safeRel}`;
      if (line.startsWith("+++ ") && line !== "+++ /dev/null") return `+++ b/${safeRel}`;
      return line;
    })
    .join("\n");
}

function patchReplayRejectReason(patch: string): string | null {
  const normalized = normalizeUnifiedDiffPatch(patch);
  if (/\.\.\.\[truncated|truncated\]/i.test(normalized)) return "patch_contains_truncation_marker";
  if (!/^diff --git a\/.+ b\/.+$/m.test(normalized)) return "patch_missing_diff_git_header";
  if (!/^--- (a\/.+|\/dev\/null)$/m.test(normalized)) return "patch_missing_old_file_header";
  if (!/^\+\+\+ (b\/.+|\/dev\/null)$/m.test(normalized)) return "patch_missing_new_file_header";
  if (!/^@@ .+ @@/m.test(normalized)) return "patch_missing_hunk_header";
  return null;
}

function runtimeSuccessReplayFailureKind(event: ToolEvent): string | null {
  if (event.status === "success") return null;
  const output = asObject(event.output_signature);
  const error = asString(output?.error) ?? "";
  const result = asObject(output?.result);
  const stderr = asString(result?.stderr) ?? "";
  const stdout = asString(result?.stdout) ?? "";
  const text = `${error}\n${stderr}\n${stdout}`.toLowerCase();
  if (/runtime edit boundary|write policy|forbidden write|outside allowed_edit_files/.test(text)) {
    return "edit_boundary_blocked";
  }
  if (/patch failed|does not apply|already exists in working tree|not a git repository/.test(text)) {
    return "stale_patch";
  }
  if (/corrupt patch|no valid patches|unrecognized input|patch fragment|malformed patch/.test(text)) {
    return "invalid_patch";
  }
  return "apply_patch_failed";
}

function touchedFilesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) files.add(line.slice("+++ b/".length));
    if (line.startsWith("--- a/")) files.add(line.slice("--- a/".length));
  }
  return [...files].filter((file) => file !== "/dev/null").sort();
}

function toolSchemaCorrection(action: string, input: JsonObject, error: string): string | null {
  if (action === "read_file" && (typeof input.file_path === "string" || /read_file\.input\.path|input\.path|path is required/i.test(error))) {
    return "read_file.input.path is required; if Runtime gives first_action_v1.file_path, put that value in input.path.";
  }
  if (action === "replace_text" && /replace_text\.input\.path|input\.path|path is required/i.test(error)) {
    return "replace_text.input.path is required together with exact find, replace, and expected_replacements.";
  }
  if (action === "replace_lines" && /replace_lines\.input\.path|input\.path|path is required/i.test(error)) {
    return "replace_lines.input.path, start_line, end_line, expected_old_lines, and replacement_lines are required. Use line arrays with complete lines and no newline characters.";
  }
  return null;
}

function editOperationNextActionFromFailure(action: string, input: JsonObject, details: JsonObject, error: string): JsonObject | null {
  const pathValue = asString(input.path) ?? asString(details.path);
  if (action === "replace_lines" && pathValue && details.expected_old_lines_match === false) {
    const requestedStartLine = numeric(details.requested_start_line);
    const requestedEndLine = numeric(details.requested_end_line);
    const actualOldLines = requiredStringArrayOrNull(details.actual_old_lines);
    const startLine = requestedStartLine > 0 ? Math.max(1, requestedStartLine - 20) : 1;
    const endLine = requestedEndLine > 0 ? requestedEndLine + 20 : startLine + 80;
    return {
      reason: "replace_lines_current_anchor_required",
      action: "read_file",
      path: pathValue,
      start_line: startLine,
      end_line: endLine,
      actual_old_lines: actualOldLines ?? [],
      instruction:
        "The last replace_lines expected_old_lines did not match current file content. Read the current target range, then retry replace_lines using expected_old_lines copied from the latest read_file output, not from stale memory.",
    };
  }
  if (action === "replace_text" && pathValue && /expected \d+ replacement\(s\), found \d+/i.test(error)) {
    return {
      reason: "replace_text_current_anchor_required",
      action: "read_file",
      path: pathValue,
      start_line: 1,
      end_line: 220,
      instruction:
        "The exact replace_text anchor did not match current file content. Read the current target file section and retry with an exact current find span.",
    };
  }
  if ((action === "replace_text" || action === "replace_lines") && pathValue && details.edit_noop === true) {
    const requestedStartLine = numeric(details.requested_start_line);
    const requestedEndLine = numeric(details.requested_end_line);
    const effectiveStartLine = numeric(details.start_line);
    const effectiveEndLine = numeric(details.end_line);
    const actualOldLines = requiredStringArrayOrNull(details.actual_old_lines);
    return {
      reason: `${action}_non_noop_required`,
      action,
      path: pathValue,
      allowed_files: [pathValue],
      allowed_write_actions: [action],
      start_line: effectiveStartLine > 0 ? effectiveStartLine : requestedStartLine > 0 ? requestedStartLine : null,
      end_line: effectiveEndLine > 0 ? effectiveEndLine : requestedEndLine > 0 ? requestedEndLine : null,
      max_expected_old_lines: action === "replace_lines" ? 8 : null,
      max_replacement_lines: action === "replace_lines" ? 16 : null,
      actual_old_lines: action === "replace_lines" ? (actualOldLines ?? []).slice(0, 24) : [],
      forbidden_replacement:
        action === "replace_text"
          ? asString(input.replace) ?? null
          : requiredStringArrayOrNull(input.replacement_lines) ?? [],
      instruction:
        action === "replace_lines"
          ? "The last replace_lines edit exactly preserved current file content. Retry with one narrow subspan only: at most 8 expected_old_lines and at most 16 replacement_lines. Do not reuse the whole previous read range or whole function."
          : "The last edit exactly preserved the current file content. Retry with a replacement that changes the implementation semantics and addresses the latest verifier failure; do not submit an identical replacement.",
    };
  }
  if ((action === "replace_text" || action === "replace_lines") && pathValue && /Runtime edit operation non-noop repair/i.test(error)) {
    const startLine = numeric(input.start_line);
    const endLine = numeric(input.end_line);
    return {
      reason: `${action}_non_noop_required`,
      action,
      path: pathValue,
      allowed_files: [pathValue],
      allowed_write_actions: [action],
      start_line: startLine > 0 ? startLine : null,
      end_line: endLine > 0 ? endLine : null,
      max_expected_old_lines: action === "replace_lines" ? 8 : null,
      max_replacement_lines: action === "replace_lines" ? 16 : null,
      actual_old_lines: requiredStringArrayOrNull(input.expected_old_lines)?.slice(0, 8) ?? [],
      forbidden_replacement:
        action === "replace_text"
          ? asString(input.replace) ?? null
          : requiredStringArrayOrNull(input.replacement_lines) ?? [],
      instruction:
        "Runtime rejected the non-noop repair payload as too broad or off-contract. Retry with one narrow edit that changes behavior; for replace_lines use at most 8 expected_old_lines and at most 16 replacement_lines.",
    };
  }
  if (action === "read_file" && (typeof input.file_path === "string" || /read_file\.input\.path|input\.path|path is required/i.test(error))) {
    return {
      reason: "read_file_schema_repair_required",
      action: "read_file",
      path: asString(input.file_path) ?? null,
      instruction:
        "Retry read_file with input.path. Do not use input.file_path.",
    };
  }
  return null;
}

function applyPatchFailureNextAction(input: JsonObject, result: CommandResult): JsonObject | null {
  const patch = asString(input.patch) ?? "";
  const touchedFiles = touchedFilesFromPatch(patch);
  const text = `${result.stderr}\n${result.stdout}`;
  if (touchedFiles.length === 0) return null;
  if (!/patch failed|does not apply|corrupt patch|no valid patches|patch fragment|malformed patch|unrecognized input/i.test(text)) {
    return null;
  }
  const failedLineMatch = text.match(/patch failed:\s*([^:\n]+):(\d+)/i);
  const failedPath = failedLineMatch?.[1]?.trim();
  const failedLine = Number(failedLineMatch?.[2]);
  const hunkMatch = patch.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/m);
  const hunkLine = Number(hunkMatch?.[1]);
  const pathValue = failedPath && touchedFiles.includes(failedPath)
    ? failedPath
    : touchedFiles[0];
  if (!pathValue) return null;
  const anchorLine = Number.isFinite(failedLine) && failedLine > 0
    ? failedLine
    : Number.isFinite(hunkLine) && hunkLine > 0
      ? hunkLine
      : 1;
  return {
    reason: "apply_patch_current_anchor_required",
    action: "read_file",
    path: pathValue,
    allowed_files: [pathValue],
    start_line: Math.max(1, anchorLine - 30),
    end_line: anchorLine + 70,
    failed_patch_files: touchedFiles,
    failed_patch_line: anchorLine > 0 ? anchorLine : null,
    preferred_next_write_actions: ["replace_lines", "apply_patch"],
    instruction:
      "The previous apply_patch failed against stale or invalid patch anchors. Read this current source span first, then retry with a compact replace_lines edit copied from current read evidence, or one small apply_patch hunk that applies to the current file.",
  };
}

function latestRuntimeNextAction(events: ToolEvent[]): JsonObject | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const output = asObject(events[index]?.output_signature);
    const nextAction = asObject(output?.sequence_policy_next_action)
      ?? asObject(output?.edit_operation_next_action)
      ?? asObject(output?.verifier_failure_lock_next_action);
    if (nextAction) return nextAction;
  }
  return null;
}

function verifierStagnationStopSignal(events: ToolEvent[]): JsonObject | null {
  const latestEvent = events.at(-1);
  if (!latestEvent || latestEvent.status !== "failed" || latestEvent.tool_name !== "run_command") return null;
  const lock = asObject(latestEvent.output_signature.verifier_failure_lock_next_action);
  const convergence = asObject(lock?.repeated_failure_convergence_v1);
  if (convergence?.required !== true) return null;
  const sameFileFailureCount = numeric(convergence?.same_file_failure_count);
  const successfulWritesAfterFirstFailure = numeric(convergence?.successful_writes_after_first_same_file_failure);
  if (sameFileFailureCount < 5 || successfulWritesAfterFirstFailure < 4) return null;
  const targetFiles = stringList(convergence.target_files);
  return {
    summary_version: "verifier_stagnation_stop_v1",
    required: true,
    reason: "repeated_same_file_verifier_failure_after_convergence",
    failed_verifier_step: latestEvent.step_index,
    failed_verifier_command: asString(latestEvent.tool_input.command) ?? "",
    target_files: targetFiles,
    same_file_failure_count: sameFileFailureCount,
    successful_writes_after_first_same_file_failure: successfulWritesAfterFirstFailure,
    required_next_action:
      "Stop this attempt, preserve the verifier evidence, and let learning-control produce or update a semantic candidate instead of continuing local edit toggles.",
    instruction:
      "The same implementation workflow has failed repeatedly after multiple successful writes and a coherent repair escalation. Further local edits in this attempt are low-evidence; stop and convert the trace into candidate evidence for the next attempt.",
  };
}

function latestVerifierFailureLockNextAction(events: ToolEvent[]): JsonObject | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const lock = asObject(events[index]?.output_signature.verifier_failure_lock_next_action);
    if (lock && asString(lock.reason) === "latest_verifier_failure_lock") return lock;
  }
  return null;
}

function toolPayloadExhaustionStopSignal(events: ToolEvent[]): JsonObject | null {
  const latestEvent = events.at(-1);
  if (!latestEvent || latestEvent.status !== "failed" || !editWriteToolAction(latestEvent.tool_name)) return null;
  const latestOutput = asObject(latestEvent.output_signature);
  if (!asString(latestOutput?.verifier_failure_lock_error) && !asObject(latestOutput?.edit_operation_next_action)) return null;

  const lock = latestVerifierFailureLockNextAction(events.slice(0, -1));
  if (!lock) return null;
  const convergence = asObject(lock.repeated_failure_convergence_v1);
  const convergenceRequired = convergence?.required === true;

  const failedVerifierStep = numeric(lock.failed_verifier_step);
  const eventsAfterVerifier = failedVerifierStep > 0
    ? events.filter((event) => event.step_index > failedVerifierStep)
    : events;
  const lockedEditFailures = eventsAfterVerifier.filter((event) => {
    const output = asObject(event.output_signature);
    return event.status === "failed"
      && editWriteToolAction(event.tool_name)
      && (
        asString(output?.verifier_failure_lock_error)
        || asObject(output?.edit_operation_next_action)
      );
  });
  const failedActions = uniqueStringValues(lockedEditFailures.map((event) => event.tool_name), 8);
  const successfulLockedWritesAfterVerifier = eventsAfterVerifier.filter((event) => (
    event.status === "success"
    && targetFileWritten(event, stringList(lock.files))
  )).length;
  const sourceWorkflowFailurePressure = numeric(lock.replace_lines_semantic_failure_count)
    + numeric(lock.replace_lines_payload_failure_count)
    + numeric(lock.replace_lines_compact_span_violation_count)
    + numeric(lock.apply_patch_payload_failure_count)
    + numeric(lock.dangling_helper_payload_rejection_count);
  const actionQuarantine = asObject(lock.locked_repair_action_quarantine_v1);
  const payloadQuarantine = asObject(lock.locked_repair_payload_quarantine_v1);
  const sameFileFailureCount = numeric(convergence?.same_file_failure_count);
  const successfulWritesAfterFirstFailure = numeric(convergence?.successful_writes_after_first_same_file_failure);
  const toolExecutabilityExhausted = (
    successfulLockedWritesAfterVerifier >= 1
    && lockedEditFailures.length >= 4
    && failedActions.length >= 2
  );
  const exhausted = (
    toolExecutabilityExhausted
    || (
      convergenceRequired
      && (
        (sameFileFailureCount >= 3 && successfulWritesAfterFirstFailure >= 2 && sourceWorkflowFailurePressure >= 3 && lockedEditFailures.length >= 1)
        || (sameFileFailureCount >= 4 && sourceWorkflowFailurePressure >= 4)
        || (sameFileFailureCount >= 4 && lockedEditFailures.length >= 2)
        || (sameFileFailureCount >= 5 && actionQuarantine)
        || (sameFileFailureCount >= 5 && payloadQuarantine)
      )
    )
  );
  if (!exhausted) return null;

  return {
    summary_version: "tool_payload_exhaustion_stop_v1",
    required: true,
    reason: toolExecutabilityExhausted
      ? "locked_repair_tool_executability_exhausted"
      : "locked_repair_payload_exhausted_after_convergence",
    failed_verifier_step: failedVerifierStep || null,
    failed_tool_step: latestEvent.step_index,
    failed_tool_action: latestEvent.tool_name,
    target_files: stringList(lock.files),
    convergence_required: convergenceRequired,
    same_file_failure_count: sameFileFailureCount,
    successful_writes_after_first_same_file_failure: successfulWritesAfterFirstFailure,
    successful_locked_writes_after_latest_verifier: successfulLockedWritesAfterVerifier,
    source_workflow_failure_pressure: sourceWorkflowFailurePressure,
    locked_edit_failure_count_after_latest_verifier: lockedEditFailures.length,
    failed_write_actions_after_latest_verifier: failedActions,
    locked_repair_action_quarantine_v1: actionQuarantine,
    locked_repair_payload_quarantine_v1: payloadQuarantine,
    required_next_action:
      "Stop this attempt and preserve the failed payload evidence for learning-control candidate review; do not keep cycling write-tool payload variants.",
    instruction:
      toolExecutabilityExhausted
        ? "The locked repair phase already produced a target write, then failed across multiple write tool families. Continuing to cycle edit tools is low-evidence; stop this attempt, run final verification, and preserve tool-executability evidence for the next attempt."
        : "The locked repair phase has exhausted local write payload variants after same-file workflow convergence. Continuing this attempt is low-evidence; stop and convert the trace into candidate evidence or a new execution operator trial.",
  };
}

function candidateTrialStagnationStopSignal(policy: RuntimeSequencePolicy | null | undefined, events: ToolEvent[]): JsonObject | null {
  if (!policy) return null;
  const latestEvent = events.at(-1);
  if (!latestEvent || latestEvent.status !== "failed" || !eventRunsRequiredVerifier(policy, latestEvent)) return null;
  const candidateTrial = asObject(policy.semanticCandidateTrial);
  if (!candidateTrial) return null;
  const targetFiles = stringList(candidateTrial.target_files);
  if (targetFiles.length === 0) return null;

  const verifierEventsSinceLastSuccess: ToolEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || !eventRunsRequiredVerifier(policy, event)) continue;
    if (event.status === "success") break;
    verifierEventsSinceLastSuccess.unshift(event);
  }
  const failedVerifierEvents = verifierEventsSinceLastSuccess.filter((event) => event.status === "failed");
  if (failedVerifierEvents.length < 2) return null;

  const firstFailedVerifierStep = failedVerifierEvents[0]?.step_index ?? 0;
  const successfulCandidateWrites = events.filter((event) => (
    event.step_index < latestEvent.step_index
    && event.status === "success"
    && editWriteToolAction(event.tool_name)
    && event.write_files.some((file) => targetFiles.includes(file))
  ));
  if (successfulCandidateWrites.length < 2) return null;

  const candidateSignature = semanticCandidateSignature(candidateTrial);
  const candidateScopeSignature = semanticCandidateScopeSignature(candidateTrial);
  return {
    summary_version: "candidate_trial_stagnation_stop_v1",
    required: true,
    reason: "candidate_failed_real_verifier_after_multiple_writes",
    active_candidate_signature: candidateSignature,
    active_candidate_scope_signature: candidateScopeSignature,
    active_candidate_role: asString(asObject(candidateTrial.trial_selection_v1)?.role) ?? semanticCandidateTrialRole(candidateTrial),
    target_files: targetFiles,
    contract_kind: asString(candidateTrial.contract_kind) ?? "",
    semantic_hypothesis: truncate(asString(candidateTrial.semantic_hypothesis) ?? "", 500),
    failed_verifier_count_since_last_success: failedVerifierEvents.length,
    first_failed_verifier_step: firstFailedVerifierStep || null,
    latest_failed_verifier_step: latestEvent.step_index,
    successful_candidate_write_count: successfulCandidateWrites.length,
    successful_candidate_write_steps: successfulCandidateWrites.map((event) => event.step_index).slice(-8),
    required_next_action:
      "Stop this attempt and preserve counter-evidence for the active semantic candidate; the next attempt must demote or rotate the contested candidate instead of repeating the same trial path.",
    instruction:
      "Runtime observed the active semantic candidate fail the real verifier after multiple successful target writes. Do not keep editing inside the same candidate attractor; mark the candidate contested, rotate to a different candidate or reclassify from fresh verifier evidence.",
  };
}

function latestPolicyBlockEvent(events: ToolEvent[]): ToolEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.tool_name === "llm_call" || event.tool_name === "llm_protocol") continue;
    const output = asObject(event.output_signature);
    return (
      asString(output?.sequence_policy_error)
      || asString(output?.verification_cadence_error)
      || asString(output?.verifier_failure_lock_error)
      || asString(output?.package_dependency_lock_error)
      || asString(output?.cognitive_entropy_probe_error)
      || asObject(output?.edit_operation_next_action)
    ) ? event : null;
  }
  return null;
}

function requiredStringArrayOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function writePolicyFromGuidance(guidance: JsonObject | null): RuntimeWritePolicy | null {
  if (!guidance) return null;
  const allowedEditFiles = stringList(guidance.allowed_edit_files);
  const forbiddenEditFiles = stringList(guidance.forbidden_edit_files);
  if (allowedEditFiles.length === 0 && forbiddenEditFiles.length === 0) return null;
  return { allowedEditFiles, forbiddenEditFiles };
}

function sequencePolicyFromGuidance(guidance: JsonObject | null): RuntimeSequencePolicy | null {
  const sequence = guidanceFirstActionSequence(guidance);
  const orderedActions = orderedSequenceActions(sequence);
  const repairFirstWriteFiles = sequenceRepairWriteFiles(sequence);
  const repairPreWriteReadFiles = sequencePreWriteReadFiles(sequence);
  const maxNarrowReadsBeforeFirstRepairWrite = sequenceMaxNarrowReadsBeforeFirstRepairWrite(sequence);
  const maxScopedSearchesBeforeFirstRepairWrite = sequenceMaxScopedSearchesBeforeFirstRepairWrite(sequence);
  const repairSecondWriteFiles = sequenceRepairSecondWriteFiles(sequence);
  const repairSecondWriteReadFiles = sequenceSecondWriteReadFiles(sequence);
  const maxNarrowReadsBeforeSecondRepairWrite = sequenceMaxNarrowReadsBeforeSecondRepairWrite(sequence);
  const maxScopedSearchesBeforeSecondRepairWrite = sequenceMaxScopedSearchesBeforeSecondRepairWrite(sequence);
  const packageDependencyRequirements = sequencePackageDependencyRequirements(sequence);
  const repairFirstWrite = asObject(sequence?.repair_first_write);
  const repairSecondWrite = asObject(sequence?.repair_second_write);
  const cadence = asObject(sequence?.verification_cadence);
  const cognitiveEntropyEngine = asObject(guidance?.cognitive_entropy_engine_v1);
  const verifierFailurePhase = asObject(guidance?.verifier_failure_phase_v1);
  const verifierFailureLineHintFiles = Array.isArray(verifierFailurePhase?.line_hints)
    ? verifierFailurePhase.line_hints
        .map((entry) => asString(asObject(entry)?.path))
        .filter((file): file is string => !!file)
    : [];
  const verificationRepair = asObject(guidance?.verification_repair_v1);
  const verificationRepairAffectedFiles = Array.isArray(verificationRepair?.affected_files)
    ? verificationRepair.affected_files
        .map((entry) => asString(asObject(entry)?.path))
        .filter((file): file is string => !!file)
    : [];
  const editFailurePhase = asObject(verificationRepair?.edit_failure_phase_v1);
  const editFailureLineHintFiles = Array.isArray(editFailurePhase?.line_hints)
    ? editFailurePhase.line_hints
        .map((entry) => asString(asObject(entry)?.path))
        .filter((file): file is string => !!file)
    : [];
  const verifierFailureRepairAffectedFiles = uniqueStringValues([
    stringList(guidance?.repair_affected_files),
    verificationRepairAffectedFiles,
    stringList(verificationRepair?.primary_files),
    asString(editFailurePhase?.primary_file),
    editFailureLineHintFiles,
  ], 32);
  const successReplayPlan = successReplayPatchPlanFromGuidance(guidance);
  const requiredVerifiers = uniqueStringValues([
    stringList(guidance?.required_verifiers),
    stringList(sequence?.required_verifiers),
    stringList(cadence?.required_verifiers),
  ], 16);
  const formatterCommands = extractCommandCandidates([
    ...stringList(verificationRepair?.next_actions),
    asString(verificationRepair?.instruction) ?? "",
  ].join("\n"))
    .filter((command) => formatterWriteCommandPrefix(splitCommandWords(command)) !== null);
  const maxSuccessfulWritesBeforeVerifier = Math.max(
    1,
    successReplayPlan
      ? 1
      : typeof cadence?.max_successful_writes_before_verifier === "number"
      ? Math.floor(cadence.max_successful_writes_before_verifier)
      : 3,
  );
  if (
    orderedActions.length === 0
    && repairFirstWriteFiles.length === 0
    && repairSecondWriteFiles.length === 0
    && requiredVerifiers.length === 0
  ) return null;
  return {
    orderedActions,
    repairFirstWriteFiles,
    repairPreWriteReadFiles,
    maxNarrowReadsBeforeFirstRepairWrite,
    maxScopedSearchesBeforeFirstRepairWrite,
    repairSecondWriteFiles,
    repairSecondWriteReadFiles,
    maxNarrowReadsBeforeSecondRepairWrite,
    maxScopedSearchesBeforeSecondRepairWrite,
    packageDependencyRequirements,
    requiredVerifiers,
    formatterCommands,
    maxSuccessfulWritesBeforeVerifier,
    verifierFailurePhase: asString(verifierFailurePhase?.phase),
    verifierFailurePrimaryFiles: stringList(verifierFailurePhase?.primary_files),
    verifierFailureLineHintFiles,
    verifierFailureRepairAffectedFiles,
    semanticCandidateTrial: asObject(repairFirstWrite?.semantic_candidate_trial),
    semanticSecondCandidateTrial: asObject(repairSecondWrite?.semantic_candidate_trial),
    cognitiveEntropyEngine,
  };
}

function assertWriteAllowed(policy: RuntimeWritePolicy | null | undefined, files: string[]): void {
  if (!policy || files.length === 0) return;
  for (const file of files) {
    if (policy.forbiddenEditFiles.includes(file)) {
      throw new Error(`Runtime edit boundary blocked forbidden write to ${file}`);
    }
    if (policy.allowedEditFiles.length > 0 && !policy.allowedEditFiles.includes(file)) {
      throw new Error(`Runtime edit boundary blocked write outside allowed_edit_files: ${file}`);
    }
  }
}

function satisfiedOrderedActionCount(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): number {
  let satisfied = 0;
  for (const event of priorEvents) {
    if (satisfied >= policy.orderedActions.length) break;
    if (event.status === "success" && eventMatchesOrderedAction(event, policy.orderedActions[satisfied])) {
      satisfied += 1;
    }
  }
  return satisfied;
}

function expectedActionDescription(action: JsonObject | undefined): string {
  if (!action) return "no ordered action";
  const kind = asString(action.action) ?? "unknown";
  const filePath = asString(action.file_path);
  return filePath ? `${kind} ${filePath}` : kind;
}

function orderedActionFilePath(action: JsonObject | undefined): string | null {
  return asString(action?.file_path);
}

function completedOrderedActionReadFiles(policy: RuntimeSequencePolicy, satisfiedCount: number): string[] {
  return uniqueStringValues(
    policy.orderedActions
      .slice(0, Math.max(0, satisfiedCount))
      .map((action) => orderedActionFilePath(action))
      .filter((file): file is string => !!file),
    32,
  );
}

function orderedActionBoundaryIndex(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): number {
  let satisfied = 0;
  let boundary = 0;
  for (const [eventIndex, event] of priorEvents.entries()) {
    if (satisfied >= policy.orderedActions.length) return eventIndex;
    const expected = policy.orderedActions[satisfied];
    if (event.status === "success" && eventMatchesOrderedAction(event, expected)) {
      satisfied += 1;
      boundary = eventIndex + 1;
      continue;
    }
    if (event.status === "success" && eventIsOrderedActionContinuationRead(event, policy.orderedActions, satisfied)) {
      boundary = eventIndex + 1;
    }
  }
  return satisfied >= policy.orderedActions.length ? boundary : priorEvents.length;
}

function inputTouchesFiles(action: string, input: JsonObject, files: string[], workspaceDir: string): boolean {
  if (files.length === 0) return false;
  if (action === "read_file" || action === "replace_text" || action === "replace_lines") {
    const requestedPath = asString(input.path);
    return !!requestedPath && files.includes(requestedPath);
  }
  if (action === "apply_patch") {
    const patch = asString(input.patch);
    return !!patch && touchedFilesFromPatch(patch).some((file) => files.includes(file));
  }
  if (action === "run_command") {
    const command = asString(input.command);
    if (!command) return false;
    const formatterTargets = formatterWriteTargets(splitCommandWords(command), workspaceDir);
    return formatterTargets !== null
      && formatterTargets.length > 0
      && formatterTargets.every((file) => files.includes(file));
  }
  return false;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function searchScopedToFiles(input: JsonObject, files: string[]): boolean {
  const glob = asString(input.glob);
  if (!glob || files.length === 0) return false;
  const normalized = normalizeRelativePath(glob);
  return files.includes(normalized);
}

function isWriteToolAction(action: string): boolean {
  return action === "replace_text" || action === "replace_lines" || action === "apply_patch" || action === "run_command";
}

function hasRepairFileWrite(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): boolean {
  return priorEvents.some((event) => event.status === "success" && targetFileWritten(event, policy.repairFirstWriteFiles));
}

function firstRepairWriteIndex(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): number {
  return priorEvents.findIndex((event) => (
    event.status === "success" && targetFileWritten(event, policy.repairFirstWriteFiles)
  ));
}

function narrowReadsBeforeRepairWriteCount(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): number {
  const readableBeforeWrite = policy.repairPreWriteReadFiles.length > 0
    ? policy.repairPreWriteReadFiles
    : policy.repairFirstWriteFiles;
  if (readableBeforeWrite.length === 0) return 0;
  const boundary = orderedActionBoundaryIndex(policy, priorEvents);
  const repairWriteIndex = firstRepairWriteIndex(policy, priorEvents);
  const end = repairWriteIndex >= 0 ? repairWriteIndex : priorEvents.length;
  return priorEvents
    .slice(boundary, end)
    .filter((event) => (
      event.status === "success"
      && event.tool_name === "read_file"
      && eventTouchesAnyFile(event, readableBeforeWrite)
    )).length;
}

function scopedSearchesBeforeRepairWriteCount(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): number {
  const readableBeforeWrite = policy.repairPreWriteReadFiles.length > 0
    ? policy.repairPreWriteReadFiles
    : policy.repairFirstWriteFiles;
  if (readableBeforeWrite.length === 0) return 0;
  const boundary = orderedActionBoundaryIndex(policy, priorEvents);
  const repairWriteIndex = firstRepairWriteIndex(policy, priorEvents);
  const end = repairWriteIndex >= 0 ? repairWriteIndex : priorEvents.length;
  return priorEvents
    .slice(boundary, end)
    .filter((event) => (
      event.status === "success"
      && event.tool_name === "search"
      && searchScopedToFiles(event.tool_input, readableBeforeWrite)
    )).length;
}

function hasRepairSecondFileWrite(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): boolean {
  if (policy.repairSecondWriteFiles.length === 0) return true;
  const firstWriteIndex = firstRepairWriteIndex(policy, priorEvents);
  if (firstWriteIndex < 0) return false;
  return priorEvents.slice(firstWriteIndex).some((event) => (
    event.status === "success" && targetFileWritten(event, policy.repairSecondWriteFiles)
  ));
}

function narrowReadsBeforeSecondRepairWriteCount(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): number {
  const readableBeforeWrite = policy.repairSecondWriteReadFiles.length > 0
    ? policy.repairSecondWriteReadFiles
    : policy.repairSecondWriteFiles;
  if (readableBeforeWrite.length === 0) return 0;
  const firstWriteIndex = firstRepairWriteIndex(policy, priorEvents);
  if (firstWriteIndex < 0) return 0;
  const secondWriteRelativeIndex = priorEvents.slice(firstWriteIndex).findIndex((event) => (
    event.status === "success" && targetFileWritten(event, policy.repairSecondWriteFiles)
  ));
  const secondWriteIndex = secondWriteRelativeIndex >= 0 ? firstWriteIndex + secondWriteRelativeIndex : priorEvents.length;
  return priorEvents
    .slice(firstWriteIndex + 1, secondWriteIndex)
    .filter((event) => (
      event.status === "success"
      && event.tool_name === "read_file"
      && eventTouchesAnyFile(event, readableBeforeWrite)
    )).length;
}

function scopedSearchesBeforeSecondRepairWriteCount(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): number {
  const readableBeforeWrite = policy.repairSecondWriteReadFiles.length > 0
    ? policy.repairSecondWriteReadFiles
    : policy.repairSecondWriteFiles;
  if (readableBeforeWrite.length === 0) return 0;
  const firstWriteIndex = firstRepairWriteIndex(policy, priorEvents);
  if (firstWriteIndex < 0) return 0;
  const secondWriteRelativeIndex = priorEvents.slice(firstWriteIndex).findIndex((event) => (
    event.status === "success" && targetFileWritten(event, policy.repairSecondWriteFiles)
  ));
  const secondWriteIndex = secondWriteRelativeIndex >= 0 ? firstWriteIndex + secondWriteRelativeIndex : priorEvents.length;
  return priorEvents
    .slice(firstWriteIndex + 1, secondWriteIndex)
    .filter((event) => (
      event.status === "success"
      && event.tool_name === "search"
      && searchScopedToFiles(event.tool_input, readableBeforeWrite)
    )).length;
}

function failedNoOpEditOnFiles(event: ToolEvent, files: string[]): boolean {
  if (event.status !== "failed") return false;
  if (event.tool_name !== "replace_text" && event.tool_name !== "replace_lines") return false;
  const output = asObject(event.output_signature);
  if (output?.edit_noop !== true) return false;
  return eventTouchesAnyFile(event, files);
}

function repairSecondWriteNoOpConfirmation(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): JsonObject | null {
  if (policy.repairSecondWriteFiles.length === 0 || policy.requiredVerifiers.length === 0) return null;
  const firstWriteIndex = firstRepairWriteIndex(policy, priorEvents);
  if (firstWriteIndex < 0) return null;
  const secondWriteRelativeIndex = priorEvents.slice(firstWriteIndex + 1).findIndex((event) => (
    event.status === "success" && targetFileWritten(event, policy.repairSecondWriteFiles)
  ));
  if (secondWriteRelativeIndex >= 0) return null;
  const eventsAfterFirstWrite = priorEvents.slice(firstWriteIndex + 1);
  const noOpEvents = eventsAfterFirstWrite.filter((event) => failedNoOpEditOnFiles(event, policy.repairSecondWriteFiles));
  if (noOpEvents.length < 2) return null;
  const latestNoOpEvent = noOpEvents.at(-1);
  const latestNoOpIndex = latestNoOpEvent ? priorEvents.indexOf(latestNoOpEvent) : -1;
  const verifierAlreadyRanAfterLatestNoOp = latestNoOpIndex >= 0
    && priorEvents.slice(latestNoOpIndex + 1).some((event) => eventRunsRequiredVerifier(policy, event));
  if (verifierAlreadyRanAfterLatestNoOp) return null;
  return {
    summary_version: "repair_second_write_noop_confirmation_v1",
    no_op_count: noOpEvents.length,
    failed_steps: noOpEvents.map((event) => event.step_index).slice(-6),
    files: uniqueStringValues(noOpEvents.flatMap((event) => [
      asString(event.tool_input.path),
      event.touched_files,
    ]), 8),
    instruction:
      "The coupled second-write target rejected repeated no-op edits after the primary repair write. Treat the coupled file as already inspected/current enough for this phase, stop looping on empty package/type edits, and run the required verifier to get fresh evidence.",
  };
}

function repeatedCurrentAnchorFailureCount(args: {
  events: ToolEvent[];
  files: string[];
  action: "replace_text" | "replace_lines" | "apply_patch";
  sinceIndex?: number;
}): number {
  if (args.files.length === 0) return 0;
  const events = typeof args.sinceIndex === "number"
    ? args.events.slice(Math.max(0, args.sinceIndex))
    : args.events;
  return events.filter((event) => {
    if (event.status !== "failed" || event.tool_name !== args.action) return false;
    if (!eventTouchesAnyFile(event, args.files)) return false;
    const next = asObject(asObject(event.output_signature)?.edit_operation_next_action);
    return asString(next?.reason) === `${args.action}_current_anchor_required`;
  }).length;
}

function firstSequencePolicyReasonIndex(args: {
  events: ToolEvent[];
  files: string[];
  reason: string;
}): number {
  return args.events.findIndex((event) => {
    const next = asObject(asObject(event.output_signature)?.sequence_policy_next_action);
    return asString(next?.reason) === args.reason
      && (args.files.length === 0 || eventTouchesAnyFile(event, args.files));
  });
}

function firstCurrentAnchorFailureIndex(args: {
  events: ToolEvent[];
  files: string[];
  action: "replace_text" | "replace_lines" | "apply_patch";
}): number {
  return args.events.findIndex((event) => {
    if (event.status !== "failed" || event.tool_name !== args.action) return false;
    if (!eventTouchesAnyFile(event, args.files)) return false;
    const next = asObject(asObject(event.output_signature)?.edit_operation_next_action);
    return asString(next?.reason) === `${args.action}_current_anchor_required`;
  });
}

function repairWriteAnchorEscalationSinceIndex(args: {
  policy: RuntimeSequencePolicy;
  priorEvents: ToolEvent[];
  files: string[];
  phase: "first" | "second";
}): number {
  if (args.phase === "second") {
    const firstWriteIndex = firstRepairWriteIndex(args.policy, args.priorEvents);
    return firstWriteIndex >= 0 ? firstWriteIndex + 1 : 0;
  }
  const orderedBoundary = orderedActionBoundaryIndex(args.policy, args.priorEvents);
  const firstRepairRequiredIndex = firstSequencePolicyReasonIndex({
    events: args.priorEvents,
    files: args.files,
    reason: "repair_first_write_required",
  });
  const firstAnchorFailureIndex = firstCurrentAnchorFailureIndex({
    events: args.priorEvents,
    files: args.files,
    action: "replace_text",
  });
  const firstApplyPatchAnchorFailureIndex = firstCurrentAnchorFailureIndex({
    events: args.priorEvents,
    files: args.files,
    action: "apply_patch",
  });
  const firstReplaceLinesAnchorFailureIndex = firstCurrentAnchorFailureIndex({
    events: args.priorEvents,
    files: args.files,
    action: "replace_lines",
  });
  const candidateIndexes = [orderedBoundary, firstRepairRequiredIndex, firstAnchorFailureIndex]
    .concat(firstApplyPatchAnchorFailureIndex)
    .concat(firstReplaceLinesAnchorFailureIndex)
    .filter((index) => index >= 0 && index <= args.priorEvents.length);
  return candidateIndexes.length > 0 ? Math.min(...candidateIndexes) : 0;
}

function failedReplaceTextFindSpans(args: {
  events: ToolEvent[];
  files: string[];
  sinceIndex?: number;
}): string[] {
  const events = typeof args.sinceIndex === "number"
    ? args.events.slice(Math.max(0, args.sinceIndex))
    : args.events;
  return uniqueStringValues(events.flatMap((event) => {
    if (event.status !== "failed" || event.tool_name !== "replace_text") return [];
    if (!eventTouchesAnyFile(event, args.files)) return [];
    const next = asObject(asObject(event.output_signature)?.edit_operation_next_action);
    if (asString(next?.reason) !== "replace_text_current_anchor_required") return [];
    const find = asString(event.tool_input.find);
    return find ? [truncate(find, 240)] : [];
  }), 6);
}

function repairWriteAnchorEscalation(args: {
  policy: RuntimeSequencePolicy;
  priorEvents: ToolEvent[];
  files: string[];
  phase: "first" | "second";
}): JsonObject | null {
  if (args.files.length === 0) return null;
  const sinceIndex = repairWriteAnchorEscalationSinceIndex(args);
  const replaceTextAnchorFailures = repeatedCurrentAnchorFailureCount({
    events: args.priorEvents,
    files: args.files,
    action: "replace_text",
    sinceIndex,
  });
  const applyPatchAnchorFailures = repeatedCurrentAnchorFailureCount({
    events: args.priorEvents,
    files: args.files,
    action: "apply_patch",
    sinceIndex,
  });
  const replaceLinesAnchorFailures = repeatedCurrentAnchorFailureCount({
    events: args.priorEvents,
    files: args.files,
    action: "replace_lines",
    sinceIndex,
  });
  if (replaceTextAnchorFailures < 2 && applyPatchAnchorFailures < 2 && replaceLinesAnchorFailures < 2) return null;
  const failedFindSpans = failedReplaceTextFindSpans({
    events: args.priorEvents,
    files: args.files,
    sinceIndex,
  });
  const forbiddenWriteActions = uniqueStringValues([
    replaceTextAnchorFailures >= 2 ? "replace_text" : null,
    applyPatchAnchorFailures >= 2 ? "apply_patch" : null,
    replaceLinesAnchorFailures >= 2 ? "replace_lines" : null,
  ].filter((action): action is string => !!action), 4);
  const allowedWriteActions = ["replace_lines", "apply_patch", "replace_text"]
    .filter((action) => !forbiddenWriteActions.includes(action));
  const preferredAction = allowedWriteActions.includes("replace_lines")
    ? "replace_lines"
    : allowedWriteActions.includes("apply_patch")
    ? "apply_patch"
    : allowedWriteActions[0] ?? "replace_lines";
  const failedActions = uniqueStringValues([
    replaceTextAnchorFailures >= 2 ? "replace_text" : null,
    applyPatchAnchorFailures >= 2 ? "apply_patch" : null,
    replaceLinesAnchorFailures >= 2 ? "replace_lines" : null,
  ].filter((action): action is string => !!action), 4);
  const applyPatchFiles = applyPatchAnchorFailureFiles({
    events: args.priorEvents,
    files: args.files,
    sinceIndex,
  });
  return {
    summary_version: "repair_write_anchor_escalation_v1",
    phase: args.phase,
    failed_action: failedActions.length === 1 ? failedActions[0] : "multiple_write_actions",
    failed_actions: failedActions,
    failure_count: replaceTextAnchorFailures + applyPatchAnchorFailures + replaceLinesAnchorFailures,
    failure_counts_by_action: {
      replace_text: replaceTextAnchorFailures,
      apply_patch: applyPatchAnchorFailures,
      replace_lines: replaceLinesAnchorFailures,
    },
    since_event_index: sinceIndex,
    preferred_repair_write_action: preferredAction,
    allowed_write_actions: allowedWriteActions,
    forbidden_write_actions: forbiddenWriteActions,
    files: args.files,
    apply_patch_failed_files: applyPatchFiles,
    stale_candidate_anchor_detected: failedFindSpans.length > 0 || applyPatchAnchorFailures >= 2,
    forbidden_failed_find_spans: failedFindSpans,
    instruction:
      [
        "Repeated repair-write anchors failed after current-content reads.",
        forbiddenWriteActions.length > 0
          ? `Do not use quarantined write action(s): ${forbiddenWriteActions.join(", ")}.`
          : null,
        failedFindSpans.length > 0
          ? "Do not retry any forbidden_failed_find_spans."
          : null,
        `Use ${preferredAction} copied from the latest read_file output on the allowed repair file.`,
      ].filter(Boolean).join(" "),
  };
}

function applyPatchAnchorFailureFiles(args: {
  events: ToolEvent[];
  files: string[];
  sinceIndex?: number;
}): string[] {
  const events = typeof args.sinceIndex === "number"
    ? args.events.slice(Math.max(0, args.sinceIndex))
    : args.events;
  const failures = events.filter((event) => {
    if (event.status !== "failed" || event.tool_name !== "apply_patch") return false;
    if (!eventTouchesAnyFile(event, args.files)) return false;
    const next = asObject(asObject(event.output_signature)?.edit_operation_next_action);
    return asString(next?.reason) === "apply_patch_current_anchor_required";
  });
  return uniqueStringValues([
    failures.flatMap((event) => event.touched_files),
    args.files,
  ], 12).filter((file) => args.files.includes(file));
}

function normalizePolicyCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function commandMatchesRequiredVerifier(command: string, requiredVerifiers: string[]): boolean {
  const observed = normalizePolicyCommand(command);
  return requiredVerifiers.some((required) => {
    const expected = normalizePolicyCommand(required);
    return observed === expected || observed.includes(expected) || expected.includes(observed);
  });
}

function commandMatchesAny(command: string, candidates: string[]): boolean {
  const observed = normalizePolicyCommand(command);
  return candidates.some((candidate) => normalizePolicyCommand(candidate) === observed);
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = new Set(left);
  return right.every((value) => normalizedLeft.has(value));
}

function commandMatchesFormatterCommand(command: string, candidates: string[], workspaceDir: string): boolean {
  if (commandMatchesAny(command, candidates)) return true;
  const observedTargets = formatterWriteTargets(splitCommandWords(command), workspaceDir);
  if (observedTargets === null || observedTargets.length === 0) return false;
  return candidates.some((candidate) => {
    const candidateTargets = formatterWriteTargets(splitCommandWords(candidate), workspaceDir);
    return candidateTargets !== null
      && candidateTargets.length > 0
      && sameStringSet(observedTargets, candidateTargets);
  });
}

function formatterFailureOnly(text: string): boolean {
  if (!/xo|eslint|prettier|@stylistic|Expected indentation|Expected blank line|no-multiple-empty-lines|padding-line-between-statements/i.test(text)) {
    return false;
  }
  return !/AssertionError|ERR_ASSERTION|must directly assert|must include|must expose|must return|expected promise|source_contract_failure|TypeError|SyntaxError/i.test(text);
}

function formatterFailureRequiresFormatter(text: string): boolean {
  if (!formatterFailureOnly(text)) return false;
  return !/no-await-in-loop|max-depth|promise\/param-names|promise\/prefer-await-to-then|unicorn\/prefer-ternary|no-warning-comments|Unused eslint-disable|Unexpected await inside a loop|Blocks are nested too deeply|Promise constructor parameters must be named|Prefer await to then/i.test(text);
}

function formatterCommandSeedsFromFailure(outputText: string): string[] {
  const seeds: string[] = [];
  if (/\bxo\b|xo &&|Expected indentation|no-multiple-empty-lines|padding-line-between-statements/i.test(outputText)) {
    seeds.push("npx xo --fix");
  }
  if (/\beslint\b/i.test(outputText)) {
    seeds.push("npx eslint --fix");
  }
  if (/\bprettier\b/i.test(outputText)) {
    seeds.push("npx prettier --write");
  }
  return uniqueStringValues(seeds, 8);
}

function formatterCommandsForFailure(policy: RuntimeSequencePolicy, outputFiles: string[], outputText: string): string[] {
  const allowedFiles = outputFiles.filter((file) => policy.repairFirstWriteFiles.includes(file));
  if (allowedFiles.length === 0) return [];
  return uniqueStringValues(
    [...policy.formatterCommands, ...formatterCommandSeedsFromFailure(outputText)]
      .map((command) => formatterCommandWithTargets(command, allowedFiles))
      .filter((command): command is string => !!command),
    8,
  );
}

function successfulWritesSinceLastRequiredVerifier(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): number {
  if (policy.requiredVerifiers.length === 0) return 0;
  let lastVerifierIndex = -1;
  for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
    const event = priorEvents[index];
    if (
      event?.tool_name === "run_command"
      && commandMatchesRequiredVerifier(asString(event.tool_input.command) ?? "", policy.requiredVerifiers)
    ) {
      lastVerifierIndex = index;
      break;
    }
  }
  return priorEvents
    .slice(lastVerifierIndex + 1)
    .filter((event) => event.status === "success" && event.write_files.length > 0)
    .length;
}

function requiredVerifierDue(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): boolean {
  return (
    policy.requiredVerifiers.length > 0
    && successfulWritesSinceLastRequiredVerifier(policy, priorEvents) >= policy.maxSuccessfulWritesBeforeVerifier
  );
}

function lockedRepairVerifierDueNextAction(policy: RuntimeSequencePolicy, lock: JsonObject | null): JsonObject | null {
  if (policy.requiredVerifiers.length === 0) return null;
  if (!lock) return null;
  const editPhaseBudget = asObject(lock.edit_phase_failure_budget_v1);
  const dueAfterBudgetExhaustion = editPhaseBudget?.force_required_verifier === true;
  if (lock.locked_repair_write_completed !== true && !dueAfterBudgetExhaustion) return null;
  return {
    reason: "locked_repair_verifier_due",
    action: "run_command",
    commands: policy.requiredVerifiers,
    locked_files: stringList(lock.files),
    failed_verifier_step: lock.failed_verifier_step ?? null,
    failed_verifier_command: asString(lock.failed_verifier_command) ?? null,
    successful_writes_since_last_verifier: dueAfterBudgetExhaustion
      ? numeric(editPhaseBudget?.successful_write_count_after_latest_verifier)
      : 1,
    edit_phase_failure_budget_v1: dueAfterBudgetExhaustion ? editPhaseBudget : null,
    instruction:
      dueAfterBudgetExhaustion
        ? `Edit phase budget is exhausted after a successful locked edit. Run a required verifier before any more reads or edits: ${policy.requiredVerifiers.join(" | ")}.`
        : `A locked repair write already changed latest failure file(s). Run a required verifier before any more reads or edits: ${policy.requiredVerifiers.join(" | ")}.`,
  };
}

function eventRunsRequiredVerifier(policy: RuntimeSequencePolicy, event: ToolEvent): boolean {
  return (
    event.tool_name === "run_command"
    && commandMatchesRequiredVerifier(asString(event.tool_input.command) ?? "", policy.requiredVerifiers)
  );
}

function verifierOutputTextFromEvent(event: ToolEvent): string {
  const output = asObject(event.output_signature);
  const result = asObject(output?.result);
  return [
    asString(result?.stderr),
    asString(result?.stdout),
    asString(output?.error),
  ].filter((value): value is string => !!value).join("\n");
}

function workspaceRelativeMentionPath(file: string, workspaceDir?: string): string | null {
  const cleaned = file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned) return null;
  if (workspaceDir) {
    const normalizedWorkspace = workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const candidates = cleaned.startsWith("/") ? [cleaned] : [cleaned, `/${cleaned}`];
    for (const candidate of candidates) {
      if (candidate === normalizedWorkspace) return null;
      if (candidate.startsWith(`${normalizedWorkspace}/`)) {
        const relative = candidate.slice(normalizedWorkspace.length + 1).replace(/^\.\//, "");
        return relative && !relative.includes("node_modules/") ? relative : null;
      }
    }
  }
  if (path.isAbsolute(cleaned)) return null;
  if (/^(?:Volumes|Users|private|tmp|var)\//.test(cleaned)) return null;
  return cleaned;
}

function workspaceFilesMentionedInText(text: string, workspaceDir?: string): string[] {
  const files = new Set<string>();
  const patterns = [
    /\b([\w./-]+\.(?:[cm]?js|[cm]?ts|tsx|jsx|d\.ts))(?::\d+(?::\d+)?)?/g,
    /\b([\w./-]+test-d\.ts)(?::\d+(?::\d+)?)?/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const file = workspaceRelativeMentionPath(match[1] ?? "", workspaceDir);
      if (
        file
        && file !== "Node.js"
        && !file.includes("node_modules/")
        && !file.includes("scripts/real-llm-eval/")
      ) {
        files.add(file);
      }
    }
  }
  return [...files].sort();
}

function existingWorkspaceFileRaw(workspaceDir: string, relativePath: string): string | null {
  try {
    const resolved = resolveWorkspaceFile(workspaceDir, relativePath);
    const stat = fs.statSync(resolved.file);
    return stat.isFile() ? resolved.rel.replace(/\\/g, "/") : null;
  } catch {
    return null;
  }
}

function generatedArtifactSourceCandidates(relativePath: string): string[] {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const distSourceMatch = normalized.match(/^dist\/(source\/.+)\.(?:[cm]?js|jsx)$/);
  if (!distSourceMatch?.[1]) return [];
  const sourceBase = distSourceMatch[1];
  return [
    `${sourceBase}.ts`,
    `${sourceBase}.tsx`,
    `${sourceBase}.mts`,
    `${sourceBase}.cts`,
    `${sourceBase}.js`,
    `${sourceBase}.jsx`,
  ];
}

function existingWorkspaceFile(workspaceDir: string, relativePath: string): string | null {
  for (const candidate of generatedArtifactSourceCandidates(relativePath)) {
    const sourceFile = existingWorkspaceFileRaw(workspaceDir, candidate);
    if (sourceFile) return sourceFile;
  }
  return existingWorkspaceFileRaw(workspaceDir, relativePath);
}

function existingWorkspaceFiles(files: string[], workspaceDir: string): string[] {
  return uniqueStringValues(
    files
      .map((file) => existingWorkspaceFile(workspaceDir, file))
      .filter((file): file is string => !!file),
    32,
  );
}

function trustedVerifierOutputFiles(args: {
  outputFiles: string[];
  policyFiles: string[];
  workspaceDir: string;
}): string[] {
  const existingFiles = existingWorkspaceFiles(args.outputFiles, args.workspaceDir);
  if (args.policyFiles.length === 0) return existingFiles;
  const policyFileSet = new Set(args.policyFiles);
  return existingFiles.filter((file) => policyFileSet.has(file));
}

function existingWorkspaceLineHints(hints: JsonObject[], workspaceDir: string): JsonObject[] {
  const normalized: JsonObject[] = [];
  const seen = new Set<string>();
  for (const hint of hints) {
    const pathValue = asString(hint.path);
    if (!pathValue) continue;
    const file = existingWorkspaceFile(workspaceDir, pathValue);
    if (!file) continue;
    const line = typeof hint.line === "number" && Number.isFinite(hint.line) ? Math.floor(hint.line) : null;
    const column = typeof hint.column === "number" && Number.isFinite(hint.column) ? Math.floor(hint.column) : null;
    const key = `${file}:${line ?? ""}:${column ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...hint, path: file, line, column });
  }
  return normalized;
}

function workspaceFileLineHintsMentionedInText(text: string, workspaceDir?: string): JsonObject[] {
  const hints: JsonObject[] = [];
  const seen = new Set<string>();
  const addHint = (pathRaw: string, lineRaw: string, columnRaw: string | undefined | null) => {
    const file = workspaceRelativeMentionPath(pathRaw, workspaceDir);
    if (
      !file
      || file === "Node.js"
      || file.includes("node_modules/")
      || file.includes("scripts/real-llm-eval/")
    ) {
      return;
    }
    const line = Number.parseInt(lineRaw, 10);
    const column = columnRaw ? Number.parseInt(columnRaw, 10) : null;
    const key = `${file}:${Number.isFinite(line) ? line : ""}:${column ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({
      path: file,
      line: Number.isFinite(line) ? line : null,
      column: typeof column === "number" && Number.isFinite(column) ? column : null,
    });
  };
  const colonPattern = /\b([\w./-]+\.(?:[cm]?js|[cm]?ts|tsx|jsx|d\.ts)):(\d+)(?::(\d+))?/g;
  for (const match of text.matchAll(colonPattern)) {
    addHint(match[1] ?? "", match[2] ?? "", match[3]);
  }
  const tscPattern = /\b([\w./-]+\.(?:[cm]?js|[cm]?ts|tsx|jsx|d\.ts))\((\d+),(\d+)\)/g;
  for (const match of text.matchAll(tscPattern)) {
    addHint(match[1] ?? "", match[2] ?? "", match[3]);
  }
  return hints;
}

function verifierLineDiagnosticsMentionedInText(text: string, workspaceDir?: string): JsonObject[] {
  const diagnostics: JsonObject[] = [];
  const seen = new Set<string>();
  const addDiagnostic = (pathRaw: string, lineRaw: string, columnRaw: string, severity: string, code: string, messageRaw: string) => {
    const file = workspaceRelativeMentionPath(pathRaw, workspaceDir);
    if (
      !file
      || file === "Node.js"
      || file.includes("node_modules/")
      || file.includes("scripts/real-llm-eval/")
    ) {
      return;
    }
    const line = Number.parseInt(lineRaw, 10);
    const column = Number.parseInt(columnRaw, 10);
    const message = messageRaw.trim();
    const key = `${file}:${line}:${column}:${code}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    const unusedSymbol = code === "TS6133"
      ? message.match(/'([^']+)'\s+is declared but its value is never read/i)?.[1] ?? null
      : null;
    const missingNameSymbol = code === "TS2304" || code === "TS2552"
      ? message.match(/Cannot find name ['"]([^'"]+)['"]/i)?.[1] ?? null
      : null;
    const suggestedNameSymbol = code === "TS2552"
      ? message.match(/Did you mean ['"]([^'"]+)['"]/i)?.[1] ?? null
      : null;
    const typeOnlyValueSymbol = code === "TS1361"
      ? message.match(/['"]([^'"]+)['"] cannot be used as a value because it was imported using ['"]import type['"]/i)?.[1] ?? null
      : null;
    const possiblyUndefinedSymbol = code === "TS18048" || code === "TS18047" || code === "TS2532"
      ? message.match(/['"]([^'"]+)['"] is possibly ['"](?:undefined|null)['"]/i)?.[1]
        ?? (/Object is possibly ['"](?:undefined|null)['"]/i.test(message) ? "object" : null)
      : null;
    const duplicateImplementationSymbol = code === "TS2393"
      ? message.match(/Duplicate function implementation/i) ? "duplicate_implementation" : null
      : null;
    const missingExportSymbol = code === "TS2305"
      ? message.match(/no exported member ['"]([^'"]+)['"]/i)?.[1] ?? null
      : null;
    const moduleSpecifier = /Module\s+'([^']+)'/i.test(message)
      ? message.match(/Module\s+'([^']+)'/i)?.[1] ?? null
      : null;
    diagnostics.push({
      path: file,
      line: Number.isFinite(line) ? line : null,
      column: Number.isFinite(column) ? column : null,
      severity: severity.toLowerCase(),
      code,
      message,
      ...(unusedSymbol || missingNameSymbol || typeOnlyValueSymbol || possiblyUndefinedSymbol || duplicateImplementationSymbol
        ? { symbol: unusedSymbol ?? missingNameSymbol ?? typeOnlyValueSymbol ?? possiblyUndefinedSymbol ?? duplicateImplementationSymbol }
        : {}),
      ...(suggestedNameSymbol ? { suggested_symbol: suggestedNameSymbol } : {}),
      ...(missingExportSymbol ? { missing_export_symbol: missingExportSymbol } : {}),
      ...(moduleSpecifier ? { module_specifier: moduleSpecifier } : {}),
    });
  };
  const tscPattern = /\b([\w./-]+\.(?:[cm]?js|[cm]?ts|tsx|jsx|d\.ts))\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+([^\n]+)/g;
  for (const match of text.matchAll(tscPattern)) {
    addDiagnostic(match[1] ?? "", match[2] ?? "", match[3] ?? "", match[4] ?? "", match[5] ?? "", match[6] ?? "");
  }
  const colonPattern = /\b([\w./-]+\.(?:[cm]?js|[cm]?ts|tsx|jsx|d\.ts)):(\d+):(\d+):\s+(error|warning)\s+(TS\d+):\s+([^\n]+)/g;
  for (const match of text.matchAll(colonPattern)) {
    addDiagnostic(match[1] ?? "", match[2] ?? "", match[3] ?? "", match[4] ?? "", match[5] ?? "", match[6] ?? "");
  }
  return diagnostics;
}

function existingWorkspaceDiagnostics(diagnostics: JsonObject[], workspaceDir: string): JsonObject[] {
  const normalized: JsonObject[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const pathValue = asString(diagnostic.path);
    if (!pathValue) continue;
    const file = existingWorkspaceFile(workspaceDir, pathValue);
    if (!file) continue;
    const line = typeof diagnostic.line === "number" && Number.isFinite(diagnostic.line) ? Math.floor(diagnostic.line) : null;
    const column = typeof diagnostic.column === "number" && Number.isFinite(diagnostic.column) ? Math.floor(diagnostic.column) : null;
    const code = asString(diagnostic.code) ?? "unknown";
    const message = asString(diagnostic.message) ?? "";
    const key = `${file}:${line ?? ""}:${column ?? ""}:${code}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...diagnostic, path: file, line, column, code, message });
  }
  return normalized;
}

function verifierLineDiagnosticRepair(outputText: string, workspaceDir: string, policyFiles: string[]): JsonObject | null {
  const diagnostics = existingWorkspaceDiagnostics(
    verifierLineDiagnosticsMentionedInText(outputText, workspaceDir),
    workspaceDir,
  ).filter((diagnostic) => {
    const pathValue = asString(diagnostic.path);
    return !!pathValue && (policyFiles.length === 0 || policyFiles.includes(pathValue));
  });
  if (diagnostics.length === 0) return null;
  const importContractDiagnostics = diagnostics.filter((diagnostic) => {
    const code = asString(diagnostic.code);
    return code === "TS1192" || code === "TS2305" || code === "TS2614";
  });
  const typeOnlyValueDiagnostics = diagnostics.filter((diagnostic) => asString(diagnostic.code) === "TS1361");
  const missingBindingDiagnostics = diagnostics.filter((diagnostic) => {
    const code = asString(diagnostic.code);
    return code === "TS2304" || code === "TS2552";
  });
  const possiblyUndefinedDiagnostics = diagnostics.filter((diagnostic) => {
    const code = asString(diagnostic.code);
    return code === "TS18048" || code === "TS18047" || code === "TS2532";
  });
  const duplicateImplementationDiagnostics = diagnostics.filter((diagnostic) => asString(diagnostic.code) === "TS2393");
  const unusedDiagnostics = diagnostics.filter((diagnostic) => asString(diagnostic.code) === "TS6133");
  const argumentContractDiagnostics = diagnostics.filter((diagnostic) => {
    const code = asString(diagnostic.code);
    return code === "TS2345" || code === "TS2769";
  });
  const importContractFiles = uniqueStringValues(
    importContractDiagnostics.map((diagnostic) => asString(diagnostic.path)).filter((file): file is string => !!file),
    12,
  );
  const importContractLineKeys = new Set(importContractDiagnostics.map((diagnostic) => (
    `${asString(diagnostic.path) ?? ""}:${typeof diagnostic.line === "number" ? diagnostic.line : ""}`
  )));
  const importContractCoupledUnusedDiagnostics = unusedDiagnostics.filter((diagnostic) => (
    importContractLineKeys.has(`${asString(diagnostic.path) ?? ""}:${typeof diagnostic.line === "number" ? diagnostic.line : ""}`)
  ));
  const candidateRepairableDiagnostics = importContractDiagnostics.length > 0
    ? [...importContractDiagnostics, ...importContractCoupledUnusedDiagnostics]
    : typeOnlyValueDiagnostics.length > 0
      ? typeOnlyValueDiagnostics
      : missingBindingDiagnostics.length > 0
      ? missingBindingDiagnostics
    : possiblyUndefinedDiagnostics.length > 0
      ? possiblyUndefinedDiagnostics
    : duplicateImplementationDiagnostics.length > 0
      ? duplicateImplementationDiagnostics
      : unusedDiagnostics.length > 0
      ? unusedDiagnostics
      : argumentContractDiagnostics;
  const repairableDiagnostics: JsonObject[] = [];
  const seenRepairableDiagnostics = new Set<string>();
  for (const diagnostic of candidateRepairableDiagnostics) {
    const key = [
      asString(diagnostic.path) ?? "",
      typeof diagnostic.line === "number" ? String(diagnostic.line) : "",
      typeof diagnostic.column === "number" ? String(diagnostic.column) : "",
      asString(diagnostic.code) ?? "",
      asString(diagnostic.message) ?? "",
    ].join(":");
    if (seenRepairableDiagnostics.has(key)) continue;
    seenRepairableDiagnostics.add(key);
    repairableDiagnostics.push(diagnostic);
  }
  if (repairableDiagnostics.length === 0) return null;
  const targetFiles = uniqueStringValues(
    repairableDiagnostics.map((diagnostic) => asString(diagnostic.path)).filter((file): file is string => !!file),
    12,
  );
  const symbols = uniqueStringValues(
    repairableDiagnostics
      .map((diagnostic) => firstStringValue(diagnostic.symbol, diagnostic.missing_export_symbol))
      .filter((symbol): symbol is string => !!symbol),
    16,
  );
  const modules = uniqueStringValues(
    repairableDiagnostics.map((diagnostic) => asString(diagnostic.module_specifier)).filter((specifier): specifier is string => !!specifier),
    8,
  );
  const diagnosticKind = importContractDiagnostics.length > 0
    ? "typescript_import_contract"
    : typeOnlyValueDiagnostics.length > 0
      ? "typescript_type_only_value_usage"
      : missingBindingDiagnostics.length > 0
      ? "typescript_missing_binding"
    : possiblyUndefinedDiagnostics.length > 0
      ? "typescript_possibly_undefined"
    : duplicateImplementationDiagnostics.length > 0
      ? "typescript_duplicate_implementation"
    : unusedDiagnostics.length > 0
      ? "typescript_unused_symbol"
      : "typescript_argument_contract";
  const suggestedSymbols = uniqueStringValues(
    repairableDiagnostics
      .map((diagnostic) => asString(diagnostic.suggested_symbol))
      .filter((symbol): symbol is string => !!symbol),
    8,
  );
  return {
    summary_version: "line_diagnostic_repair_v1",
    required: true,
    diagnostic_kind: diagnosticKind,
    target_files: targetFiles,
    diagnostics: repairableDiagnostics.slice(0, 12),
    symbols,
    suggested_symbols: suggestedSymbols,
    modules,
    preferred_action: diagnosticKind === "typescript_duplicate_implementation" ? "apply_patch" : null,
    allowed_write_actions: ["replace_lines", "apply_patch"],
    max_narrow_reads_before_write:
      diagnosticKind === "typescript_import_contract" || diagnosticKind === "typescript_missing_binding" || diagnosticKind === "typescript_duplicate_implementation" ? 2 : 1,
    instruction: [
      diagnosticKind === "typescript_import_contract"
        ? `Latest verifier output contains a TypeScript import/export contract failure on ${targetFiles.join(", ")}.`
        : diagnosticKind === "typescript_type_only_value_usage"
          ? `Latest verifier output contains a TypeScript type-only import used as a runtime value on ${targetFiles.join(", ")}.`
        : diagnosticKind === "typescript_missing_binding"
        ? `Latest verifier output contains TypeScript missing-name diagnostics on ${targetFiles.join(", ")}.`
        : diagnosticKind === "typescript_possibly_undefined"
          ? `Latest verifier output contains TypeScript possibly-undefined diagnostics on ${targetFiles.join(", ")}.`
        : diagnosticKind === "typescript_duplicate_implementation"
          ? `Latest verifier output contains TypeScript duplicate implementation diagnostics on ${targetFiles.join(", ")}.`
        : diagnosticKind === "typescript_unused_symbol"
          ? `Latest verifier output contains TypeScript unused-symbol diagnostics on ${targetFiles.join(", ")}.`
          : `Latest verifier output contains TypeScript argument contract diagnostics on ${targetFiles.join(", ")}.`,
      symbols.length > 0 ? `Repair these exact symbols: ${symbols.join(", ")}.` : null,
      suggestedSymbols.length > 0 ? `Verifier suggested these in-scope names: ${suggestedSymbols.join(", ")}.` : null,
      modules.length > 0 ? `Repair imports from these modules: ${modules.join(", ")}.` : null,
      diagnosticKind === "typescript_import_contract"
        ? "A default-vs-named export change is not enough if the imported binding stays unused; choose a valid import form and connect the imported value to the verifier-exercised implementation path, or remove the import only if the contract does not require that dependency."
        : diagnosticKind === "typescript_type_only_value_usage"
          ? "If the symbol is used at runtime, convert only that binding to a value import; if the runtime value is not required, remove the value usage instead of keeping an invalid import type/value mix."
        : diagnosticKind === "typescript_missing_binding"
          ? "Restore the missing import/declaration or replace the stale identifier with the verifier-suggested in-scope name; keep the edit on the diagnostic line or its directly coupled import/declaration line."
        : diagnosticKind === "typescript_possibly_undefined"
          ? "Narrow the exact possibly-undefined expression before access using existing control-flow evidence, or move the access into the branch where the value is defined. Do not add a broad fallback path or silence the diagnostic with a cosmetic cast."
        : diagnosticKind === "typescript_duplicate_implementation"
          ? "Remove the later duplicate implementation block or merge its useful body into the existing implementation; do not add another helper/function/method with the same name."
        : diagnosticKind === "typescript_unused_symbol"
          ? "Remove unused declarations/imports or wire them into the verifier-exercised call path only when the value is semantically required."
          : "Repair the exact call-site expression so the argument type satisfies the callee contract; do not add wrapper code that recursively calls the same method or broadens the failing union type.",
      diagnosticKind === "typescript_argument_contract"
        ? "If a helper expects ArrayBufferView, normalize string inputs to Buffer/Uint8Array before the helper call and keep the runtime body-delivery semantics intact."
        : diagnosticKind === "typescript_duplicate_implementation"
          ? "Prefer one apply_patch hunk that deletes the duplicate implementation at the later diagnostic line, then rerun the verifier before continuing hidden-contract edits."
        : diagnosticKind === "typescript_unused_symbol"
          ? "Do not rename or prefix unused locals as a cosmetic workaround; noUnusedLocals still fails when the value remains unused."
          : "Keep the repair line-scoped and compilable; rerun the verifier immediately after the diagnostic repair before continuing hidden-contract edits.",
      "Use replace_lines or apply_patch on the diagnostic line(s), then rerun the required verifier.",
    ].filter(Boolean).join(" "),
  };
}

function verifierFailureSpecificInstruction(outputText: string): string | null {
  if (/error\s+TS1361:\s+'[^']+'\s+cannot be used as a value because it was imported using 'import type'/i.test(outputText)) {
    return [
      "The latest verifier failure is a TypeScript type-only import used as a runtime value.",
      "Repair the exact import/value-use contract: convert the specific binding to a value import only if runtime code really uses it, or remove the runtime value usage.",
      "Do not leave the same symbol declared only through import type.",
    ].join(" ");
  }
  if (/error\s+TS2304:\s+Cannot find name/i.test(outputText) || /error\s+TS2552:\s+Cannot find name/i.test(outputText)) {
    return [
      "The latest verifier failure is a TypeScript missing binding error.",
      "Repair the exact missing identifier by restoring its import/declaration or replacing stale code with the verifier-suggested in-scope name.",
      "Do not keep editing the call path around an undefined name; make the binding contract compile first.",
    ].join(" ");
  }
  if (/error\s+(?:TS18048|TS18047|TS2532):\s+(?:'[^']+'|Object)\s+is possibly\s+'?(?:undefined|null)'?/i.test(outputText)) {
    return [
      "The latest verifier failure is a TypeScript possibly-undefined diagnostic.",
      "Repair the exact access by narrowing the value in the same branch where it is used or by moving the access under the existing definition guard.",
      "Do not add a broad fallback path, non-null assertion, or cast that hides an unproven runtime state.",
    ].join(" ");
  }
  if (/error\s+(?:TS2345|TS2769):\s+(?:Argument of type|No overload matches this call)/i.test(outputText)) {
    return [
      "The latest verifier failure is a TypeScript argument/overload contract error.",
      "Repair the exact call-site expression so the argument type matches the callee signature; do not silence the type error with casts unless the runtime value is already guaranteed valid.",
      "If the callee expects an ArrayBufferView, convert string data to Buffer/Uint8Array before passing it, then rerun the verifier.",
    ].join(" ");
  }
  if (/error\s+TS2393:\s+Duplicate function implementation/i.test(outputText)) {
    return [
      "The latest verifier failure is a TypeScript duplicate implementation error.",
      "Do not add another helper/function/method. Compare the reported duplicate lines, keep one implementation, and remove the later duplicate block or merge its useful body into the existing implementation.",
      "Rerun the verifier immediately after the duplicate implementation is removed.",
    ].join(" ");
  }
  if (/error\s+TS6133:\s+'[^']+'\s+is declared but its value is never read/i.test(outputText)) {
    return [
      "The latest verifier failure is TypeScript unused-symbol diagnostics.",
      "Repair the exact diagnostic lines by removing the unused declarations/imports, or by using them in the live call path if the contract requires them.",
      "Do not only rename variables or add underscore prefixes; rerun the verifier after the line-scoped repair.",
    ].join(" ");
  }
  if (/expected promise to reject|already aborted|aborted while .* pending|signal\.reason/i.test(outputText)) {
    return [
      "The latest verifier failure is an async cancellation or rejection contract.",
      "Repair the evidence-bearing implementation path so the pending operation rejects with the verifier-required reason instead of only setting a later flag.",
      "Keep this as scoped verifier evidence; do not turn the task's package or function names into reusable Runtime policy.",
    ].join(" ");
  }
  if (/ReferenceError:\s*[A-Za-z_$][\w$]* is not defined/i.test(outputText)) {
    return "The latest verifier failure is a missing binding/scope error; repair the declaration or function parameter that should define the missing name before editing the use site again.";
  }
  return null;
}

function actionSynthesisLineHintLabels(lineHints: JsonObject[]): string[] {
  return lineHints
    .map((entry) => {
      const file = asString(entry.path);
      if (!file) return null;
      const line = typeof entry.line === "number" ? entry.line : null;
      const column = typeof entry.column === "number" ? entry.column : null;
      return `${file}${line ? `:${line}${column ? `:${column}` : ""}` : ""}`;
    })
    .filter((label): label is string => !!label);
}

function actionSynthesisPlanFromVerifierLock(args: {
  files: string[];
  outputLineHints: JsonObject[];
  failedVerifierCommand: string;
  lineDiagnosticRepair: JsonObject | null;
  repeatedFailureConvergence: JsonObject | null;
  compactLockedRepairSpan: JsonObject | null;
  lockedRepairActionQuarantine: JsonObject | null;
  lockedRepairPayloadQuarantine: JsonObject | null;
  importContractEvidence: JsonObject | null;
  editPhaseBudget: JsonObject | null;
  preferredLockedRepairAction: string | null;
}): JsonObject | null {
  if (args.files.length === 0) return null;
  const lineDiagnosticRequired = args.lineDiagnosticRepair?.required === true;
  const repeatedWorkflowRequired = args.repeatedFailureConvergence?.required === true;
  const editBudgetForcesVerifier = args.editPhaseBudget?.force_required_verifier === true;
  const lineHintLabels = actionSynthesisLineHintLabels(args.outputLineHints).slice(0, 8);
  const diagnosticKind = asString(args.lineDiagnosticRepair?.diagnostic_kind);
  const noDefaultExportModules = stringList(args.importContractEvidence?.no_default_export_modules);
  const forbiddenNamedImports = jsonObjectList(args.importContractEvidence?.forbidden_named_imports);
  const forbiddenNamedImportLabels = forbiddenNamedImports
    .map((entry) => {
      const moduleName = asString(entry.module);
      const symbol = asString(entry.symbol);
      return moduleName && symbol ? `${moduleName}.${symbol}` : null;
    })
    .filter((label): label is string => !!label);
  const preferredAction = editBudgetForcesVerifier
    ? "run_command"
    : lineDiagnosticRequired
      ? asString(args.lineDiagnosticRepair?.preferred_action) ?? "replace_lines"
      : asString(args.preferredLockedRepairAction)
        ?? asString(args.lockedRepairActionQuarantine?.preferred_action)
        ?? asString(args.lockedRepairPayloadQuarantine?.preferred_action)
        ?? "replace_lines";
  const allowedActions = editBudgetForcesVerifier
    ? ["run_command"]
    : uniqueStringValues([
        stringList(args.editPhaseBudget?.allowed_actions),
        stringList(args.lineDiagnosticRepair?.allowed_write_actions),
        preferredAction,
        "replace_lines",
        "apply_patch",
        "replace_text",
      ], 8).filter((action) => action !== "run_command" || editBudgetForcesVerifier);
  const currentStep = editBudgetForcesVerifier
    ? "run_required_verifier"
    : lineDiagnosticRequired
      ? "line_diagnostic_repair"
      : repeatedWorkflowRequired
        ? "coherent_workflow_repair"
        : args.lockedRepairPayloadQuarantine
          ? "payload_quarantine_repair"
          : args.compactLockedRepairSpan
            ? "compact_span_repair"
            : "locked_verifier_repair";
  return {
    summary_version: "action_synthesis_plan_v1",
    authority: "runtime_execution_scaffold",
    promotion_state: "none",
    source: "latest_verifier_failure_lock",
    current_step: currentStep,
    target_files: args.files,
    line_hints: args.outputLineHints.slice(0, 8),
    line_hint_labels: lineHintLabels,
    preferred_action: preferredAction,
    allowed_actions: allowedActions,
    required_verifier_command: args.failedVerifierCommand || null,
    diagnostics: Array.isArray(args.lineDiagnosticRepair?.diagnostics)
      ? args.lineDiagnosticRepair.diagnostics.slice(0, 8)
      : [],
    import_contract_evidence_v1: args.importContractEvidence,
    quality_gates: [
      "choose exactly one next tool action",
      "copy anchors from the latest read evidence before replace_lines or replace_text",
      "do not submit no-op edits or stale expected_old_lines",
      "do not rewrite whole files, whole functions, or whole recent_read_evidence ranges",
      "connect imports/helpers to the verifier-exercised call path in the same payload, or remove them",
      noDefaultExportModules.length > 0
        ? `do not introduce default imports for verifier-denied module(s): ${noDefaultExportModules.join(", ")}`
        : null,
      forbiddenNamedImportLabels.length > 0
        ? `do not introduce verifier-denied named import binding(s): ${forbiddenNamedImportLabels.join(", ")}`
        : null,
      diagnosticKind === "typescript_import_contract" || diagnosticKind === "typescript_unused_symbol"
        ? "if a symbol is imported or declared in this payload, the same payload must include non-import call-path usage, otherwise remove it"
        : null,
      "run the required verifier immediately after the localized repair",
    ].filter((gate): gate is string => !!gate),
    payload_limits: {
      max_apply_patch_hunks: lineDiagnosticRequired ? 1 : repeatedWorkflowRequired ? 2 : 1,
      max_replace_lines_old_lines: args.compactLockedRepairSpan ? 8 : lineDiagnosticRequired ? 10 : 18,
      max_replace_lines_replacement_lines: args.compactLockedRepairSpan ? 16 : lineDiagnosticRequired ? 24 : 36,
    },
    instruction: [
      lineDiagnosticRequired
        ? "Synthesize one line-diagnostic repair from verifier diagnostics before continuing behavior edits."
        : repeatedWorkflowRequired
          ? "Synthesize one coherent workflow repair instead of another local toggle."
          : editBudgetForcesVerifier
            ? "The edit budget is exhausted; synthesize no new edit and run the required verifier."
            : "Synthesize one localized verifier repair from the latest lock evidence.",
      lineHintLabels.length > 0 ? `Start from line hint(s): ${lineHintLabels.join(", ")}.` : null,
      `Target only: ${args.files.join(", ")}.`,
      `Preferred action: ${preferredAction}.`,
    ].filter(Boolean).join(" "),
  };
}

function verifierFailureDiagnosticSignature(outputText: string): string {
  const lineDiagnostics = verifierLineDiagnosticsMentionedInText(outputText);
  if (lineDiagnostics.length > 0) {
    const diagnostic = lineDiagnostics[0] ?? {};
    const code = asString(diagnostic.code) ?? "TS";
    const pathValue = asString(diagnostic.path) ?? "unknown";
    const line = typeof diagnostic.line === "number" ? diagnostic.line : "";
    const symbol = firstStringValue(diagnostic.symbol, diagnostic.missing_export_symbol, diagnostic.suggested_symbol)
      ?? asString(diagnostic.message)
        ?.toLowerCase()
        .replace(/\s+/g, " ")
        .slice(0, 80)
      ?? "diagnostic";
    return `typescript:${code}:${pathValue}:${line}:${symbol}`;
  }
  if (/ReferenceError:\s*([A-Za-z_$][\w$]*) is not defined/i.test(outputText)) {
    const name = outputText.match(/ReferenceError:\s*([A-Za-z_$][\w$]*) is not defined/i)?.[1] ?? "unknown";
    return `reference_error:${name}`;
  }
  if (/expected promise to reject/i.test(outputText) && /already aborted|signal is already aborted/i.test(outputText)) {
    return "async_rejection:already_aborted_expected_reject";
  }
  if (/expected promise to reject/i.test(outputText) && /mapper work is pending|aborted while mapper work is pending/i.test(outputText)) {
    return "async_rejection:pending_mapper_expected_reject";
  }
  if (/expected promise to reject/i.test(outputText) && /async source|async iterable/i.test(outputText)) {
    return "async_rejection:async_source_expected_reject";
  }
  if (/Expected indentation/i.test(outputText)) return "formatter:expected_indentation";
  const diagnostics = diagnosticLines(outputText, 6).join(" | ").toLowerCase();
  return diagnostics
    .replace(/\s+/g, " ")
    .replace(/file:\/\/\S+/g, "file://...")
    .slice(0, 220);
}

function hiddenContractVerifierFailure(outputText: string): boolean {
  if (formatterFailureOnly(outputText)) return false;
  if (/index\.d\.ts must|index\.test-d\.ts must|IterableOptions[\s\S]{0,120}AbortSignal|expectType|tsd/i.test(outputText)) return false;
  return /AssertionError|ERR_ASSERTION|strictEqual|expected .* actual|expected promise to reject|must reject|must not call|must stop|stop consuming|signal\.reason|already aborted|aborted while .* pending|async source|source_contract_failure/i.test(outputText);
}

function sourceWorkflowVerifierFailure(outputText: string): boolean {
  if (formatterFailureOnly(outputText)) return false;
  return hiddenContractVerifierFailure(outputText)
    || /AssertionError|ERR_ASSERTION|source_contract_failure|error\s+TS\d{4}|expected .* actual|must (?:emit|reject|expose|stop|not|include|preserve)/i.test(outputText);
}

function repeatedVerifierFailureConvergence(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[], latestVerifierIndex: number, latestOutputText: string): JsonObject | null {
  if (!hiddenContractVerifierFailure(latestOutputText)) return null;
  const signature = verifierFailureDiagnosticSignature(latestOutputText);
  if (!signature) return null;
  const events = priorEvents.slice(0, latestVerifierIndex + 1);
  let sameFailureCount = 0;
  let totalVerifierFailureCount = 0;
  let firstSameFailureIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!eventRunsRequiredVerifier(policy, event)) continue;
    if (event.status === "success") break;
    totalVerifierFailureCount += 1;
    const eventSignature = verifierFailureDiagnosticSignature(verifierOutputTextFromEvent(event));
    if (eventSignature === signature) {
      sameFailureCount += 1;
      firstSameFailureIndex = index;
    }
  }
  const successfulWritesAfterFirstSameFailure = firstSameFailureIndex >= 0
    ? events.slice(firstSameFailureIndex + 1).filter((event) => event.status === "success" && event.write_files.length > 0).length
    : 0;
  const required = sameFailureCount >= 3 || (sameFailureCount >= 2 && successfulWritesAfterFirstSameFailure >= 2);
  if (!required && sameFailureCount < 2) return null;
  return {
    summary_version: "repeated_verifier_failure_convergence_v1",
    required,
    diagnostic_signature: signature,
    same_failure_count: sameFailureCount,
    verifier_failure_count_since_last_success: totalVerifierFailureCount,
    successful_writes_after_first_same_failure: successfulWritesAfterFirstSameFailure,
    allowed_write_actions: required ? ["replace_lines", "apply_patch"] : ["replace_text", "replace_lines", "apply_patch"],
    instruction: required
      ? [
          `The same hidden-contract verifier failure repeated ${sameFailureCount} times after ${successfulWritesAfterFirstSameFailure} successful write action(s).`,
          "Stop local toggles and rewrite the coherent owning implementation block in the primary repair file.",
          "Read enough of the function to see setup, pending awaits, cleanup, and return/yield flow before writing.",
          "Use replace_lines or apply_patch for the function-level repair, not replace_text.",
          "Rerun the required verifier immediately after that coherent repair.",
        ].join(" ")
      : `The same verifier failure has appeared ${sameFailureCount} times; if it repeats again, switch from localized edits to a coherent function-level repair.`,
  };
}

function verifierFailureImplementationFilesForWorkflow(args: {
  policy: RuntimeSequencePolicy;
  event: ToolEvent;
  workspaceDir: string;
  fallbackFiles: string[];
}): string[] {
  const outputText = verifierOutputTextFromEvent(args.event);
  const rawLineHints = workspaceFileLineHintsMentionedInText(outputText, args.workspaceDir);
  const outputLineHints = existingWorkspaceLineHints(rawLineHints, args.workspaceDir);
  const outputLineHintFiles = uniqueStringValues(
    outputLineHints.map((hint) => asString(hint.path)).filter((file): file is string => !!file),
    32,
  );
  const phaseFallbackFiles = uniqueStringValues([
    args.fallbackFiles,
    args.policy.verifierFailurePrimaryFiles,
    args.policy.verifierFailureLineHintFiles,
    args.policy.verifierFailureRepairAffectedFiles,
    args.policy.repairFirstWriteFiles,
  ], 32);
  const outputFiles = trustedVerifierOutputFiles({
    outputFiles: workspaceFilesMentionedInText(outputText, args.workspaceDir),
    policyFiles: phaseFallbackFiles,
    workspaceDir: args.workspaceDir,
  });
  const candidateFiles = outputLineHintFiles.length > 0
    ? outputLineHintFiles
    : outputFiles.length > 0
      ? outputFiles
      : sourceWorkflowVerifierFailure(outputText)
        ? phaseFallbackFiles
        : [];
  return uniqueStringValues(candidateFiles.filter(implementationEditFile), 12);
}

function sameFileSourceWorkflowEscalation(args: {
  policy: RuntimeSequencePolicy;
  priorEvents: ToolEvent[];
  latestVerifierIndex: number;
  latestOutputText: string;
  workspaceDir: string;
  lockFiles: string[];
}): JsonObject | null {
  if (!sourceWorkflowVerifierFailure(args.latestOutputText)) return null;
  const targetFiles = uniqueStringValues(args.lockFiles.filter(implementationEditFile), 8);
  if (targetFiles.length === 0) return null;
  const events = args.priorEvents.slice(0, args.latestVerifierIndex + 1);
  let sameFileFailureCount = 0;
  let totalVerifierFailureCount = 0;
  let firstSameFileFailureIndex = -1;
  const diagnosticSignatures: string[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!eventRunsRequiredVerifier(args.policy, event)) continue;
    if (event.status === "success") break;
    totalVerifierFailureCount += 1;
    const implementationFiles = verifierFailureImplementationFilesForWorkflow({
      policy: args.policy,
      event,
      workspaceDir: args.workspaceDir,
      fallbackFiles: targetFiles,
    });
    if (!implementationFiles.some((file) => targetFiles.includes(file))) continue;
    sameFileFailureCount += 1;
    firstSameFileFailureIndex = index;
    diagnosticSignatures.push(verifierFailureDiagnosticSignature(verifierOutputTextFromEvent(event)));
  }
  const successfulWritesAfterFirstSameFileFailure = firstSameFileFailureIndex >= 0
    ? events.slice(firstSameFileFailureIndex + 1).filter((event) => (
        event.status === "success" && targetFileWritten(event, targetFiles)
      )).length
    : 0;
  const required = sameFileFailureCount >= 3 && successfulWritesAfterFirstSameFileFailure >= 2;
  if (!required && sameFileFailureCount < 2) return null;
  return {
    summary_version: "repeated_verifier_failure_convergence_v1",
    escalation_kind: "same_file_source_workflow",
    required,
    target_files: targetFiles,
    same_file_failure_count: sameFileFailureCount,
    verifier_failure_count_since_last_success: totalVerifierFailureCount,
    successful_writes_after_first_same_file_failure: successfulWritesAfterFirstSameFileFailure,
    diagnostic_signatures: uniqueStringValues(diagnosticSignatures, 6),
    allowed_write_actions: required ? ["replace_lines", "apply_patch"] : ["replace_text", "replace_lines", "apply_patch"],
    instruction: required
      ? [
          `The verifier has failed ${sameFileFailureCount} time(s) on the same implementation file after ${successfulWritesAfterFirstSameFileFailure} successful write action(s): ${targetFiles.join(", ")}.`,
          "Stop localized toggles. Perform one coherent source workflow repair in the owning implementation block.",
          "The repair must connect imports/helpers to the call path that the verifier exercises, remove unused placeholders, and preserve the latest package/type coupling evidence.",
          "Use replace_lines or apply_patch for the coherent repair, then run the required verifier immediately.",
        ].join(" ")
      : `The verifier has failed ${sameFileFailureCount} time(s) on the same implementation file; if it repeats after more writes, escalate from local edits to a coherent source workflow repair.`,
  };
}

function packageManifestFile(file: string): boolean {
  return /(?:^|\/)package\.json$/i.test(file);
}

function verifierLockTargetFiles(args: {
  candidateFiles: string[];
  outputText: string;
  outputLineHintFiles: string[];
  outputFiles: string[];
  phase: string | null;
  phasePrimaryFiles: string[];
  repairFirstWriteFiles: string[];
  recentWriteFiles: string[];
  repeatedFailureConvergence: JsonObject | null;
}): { files: string[]; reason: string } {
  const candidateFiles = uniqueStringValues(args.candidateFiles, 32);
  if (candidateFiles.length <= 1) return { files: candidateFiles, reason: "single_or_empty_lock_target" };
  const lineHintFiles = candidateFiles.filter((file) => args.outputLineHintFiles.includes(file));
  const trustedOutputFiles = candidateFiles.filter((file) => args.outputFiles.includes(file));
  if (trustedOutputFiles.length === 1) return { files: trustedOutputFiles, reason: "single_trusted_output_file" };

  const text = args.outputText;
  const implementationFiles = candidateFiles.filter(implementationEditFile);
  const recentImplementationWrites = uniqueStringValues(args.recentWriteFiles.filter(implementationEditFile), 6);
  const phaseImplementationFiles = uniqueStringValues([
    args.phasePrimaryFiles.filter(implementationEditFile),
    args.repairFirstWriteFiles.filter(implementationEditFile),
  ], 6);
  const packageFiles = candidateFiles.filter(packageManifestFile);
  const typeFiles = typeSurfaceFiles(candidateFiles);
  const testFiles = candidateFiles.filter(authoredTestFile);
  const packageContract = /package\.json[\s\S]{0,220}(?:dependencies|devDependencies|runtime dependency|must expose)|runtime dependency[\s\S]{0,220}package\.json/i.test(text);
  const typeContract = /type_contract|type surface|type-test|tsd|expecttype|\.d\.ts|\.test-d\.ts/i.test(text);
  const authoredTestContract = /tests? must|test assertion|self-authored test|runtime tests|\.test\.[cm]?[jt]sx?/i.test(text);
  const explicitPackageDependencyContract = /package\.json\s+must\s+expose|must\s+expose[\s\S]{0,140}runtime\s+dependency|runtime\s+dependency[\s\S]{0,180}because[\s\S]{0,120}imports/i.test(text);
  const behaviorContract = /AssertionError|ERR_ASSERTION|source_contract_failure|hidden-contract|must (?:emit|reject|expose|stop|not|include|preserve)|expected .* actual|Got \d+ events/i.test(text);
  const broadDiagnosticFanout = (
    lineHintFiles.length >= 4
    || trustedOutputFiles.length >= 5
    || candidateFiles.length >= 6
  );
  const sourceOrHiddenContract = args.phase === "hidden_contract_failure" || sourceWorkflowVerifierFailure(text);

  if (explicitPackageDependencyContract && packageFiles.length > 0) {
    return { files: packageFiles, reason: "explicit_package_dependency_contract_target" };
  }
  if (packageContract && !behaviorContract && packageFiles.length > 0) {
    return { files: packageFiles, reason: "package_contract_target" };
  }
  if (typeContract && typeFiles.length > 0) {
    return { files: typeFiles, reason: "type_contract_target" };
  }
  if (authoredTestContract && !behaviorContract && testFiles.length > 0) {
    return { files: testFiles, reason: "authored_test_contract_target" };
  }
  if (broadDiagnosticFanout && sourceOrHiddenContract && recentImplementationWrites.length > 0) {
    const causalRecentImplementation = uniqueStringValues([
      recentImplementationWrites.filter((file) => candidateFiles.includes(file)),
      recentImplementationWrites.filter((file) => phaseImplementationFiles.includes(file)),
    ], 2);
    if (causalRecentImplementation.length > 0) {
      return { files: causalRecentImplementation, reason: "broad_diagnostic_recent_implementation_write_target" };
    }
  }
  if (broadDiagnosticFanout && sourceOrHiddenContract && phaseImplementationFiles.length > 0) {
    return { files: phaseImplementationFiles.slice(0, 2), reason: "broad_diagnostic_phase_implementation_target" };
  }
  if (lineHintFiles.length > 0) return { files: lineHintFiles, reason: "trusted_line_hint_targets" };
  if (behaviorContract && implementationFiles.length > 0) {
    return { files: implementationFiles.slice(0, 2), reason: "behavior_contract_implementation_target" };
  }
  if (args.repeatedFailureConvergence?.required === true && implementationFiles.length > 0) {
    return { files: implementationFiles.slice(0, 1), reason: "repeated_failure_implementation_target" };
  }
  if (args.phase === "hidden_contract_failure" && implementationFiles.length > 0) {
    return { files: implementationFiles.slice(0, 2), reason: "hidden_contract_primary_implementation_target" };
  }
  if (packageContract && packageFiles.length > 0) {
    return { files: packageFiles, reason: "package_contract_target" };
  }
  return { files: candidateFiles, reason: "multi_file_policy_target" };
}

function successfulWriteFilesSincePreviousVerifier(
  policy: RuntimeSequencePolicy,
  events: ToolEvent[],
  latestVerifierIndex: number,
): string[] {
  const files: string[] = [];
  for (let index = latestVerifierIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (eventRunsRequiredVerifier(policy, event)) break;
    if (event.status !== "success") continue;
    for (const file of event.write_files) {
      if (typeof file === "string" && file.length > 0 && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

function compactSpanViolationError(error: string): boolean {
  return /requires compact source-workflow replace_lines after repeated payload failures/i.test(error);
}

function replaceLinesPayloadFailureError(error: string): boolean {
  return /oversized source-workflow replace_lines payload|expected_old_lines length did not match requested range|expected_old_lines did not match current file content|expected_old_lines matched multiple file ranges|range \d+-\d+ exceeds|replacement is a no-op|duplicate implementation declaration/i.test(error);
}

function replaceLinesOversizedPayloadFailureError(error: string): boolean {
  return /oversized source-workflow replace_lines payload/i.test(error);
}

function toolEventTouchesLock(event: ToolEvent, files: string[], workspaceDir: string): boolean {
  return eventTouchesAnyFile(event, files) || inputTouchesFiles(event.tool_name, event.tool_input, files, workspaceDir);
}

function applyPatchPayloadFailureEvent(event: ToolEvent, files: string[], workspaceDir: string): boolean {
  const output = asObject(event.output_signature);
  const error = asString(output?.error) ?? "";
  const result = asObject(output?.result);
  const patchFailureText = `${asString(result?.stderr) ?? ""}\n${asString(result?.stdout) ?? ""}`;
  return event.status === "failed"
    && event.tool_name === "apply_patch"
    && toolEventTouchesLock(event, files, workspaceDir)
    && (
      /Runtime verifier failure lock rejected (?:oversized source-workflow apply_patch payload|a default import)/i.test(error)
      || /Runtime verifier failure lock rejected a write that adds duplicate implementation declaration/i.test(error)
      || /Runtime verifier failure lock rejected a source-workflow repair that introduces helper\/import\/declaration symbol\(s\) without .*?call-path usage/i.test(error)
      || /corrupt patch|patch does not apply|patch failed|patch fragment without header/i.test(patchFailureText)
    );
}

function helperImportPayloadRejectionSymbols(error: string): string[] {
  const match = error.match(
    /(?:reintroduces unused helper\/import symbol\(s\)|introduces helper\/import\/declaration symbol\(s\)) without .*?(?:call-path )?usage:\s*([^.]*)\./i,
  );
  if (!match?.[1]) return [];
  return match[1].split(",").map((symbol) => symbol.trim()).filter(Boolean);
}

type EditWriteToolAction = "replace_text" | "replace_lines" | "apply_patch";

const EDIT_WRITE_TOOL_ACTIONS: EditWriteToolAction[] = ["replace_text", "replace_lines", "apply_patch"];

function editWriteToolAction(action: string): action is EditWriteToolAction {
  return action === "replace_text" || action === "replace_lines" || action === "apply_patch";
}

function editWriteFailureCounts(args: {
  events: ToolEvent[];
  files: string[];
  workspaceDir: string;
}): Record<EditWriteToolAction, number> {
  const counts: Record<EditWriteToolAction, number> = {
    replace_text: 0,
    replace_lines: 0,
    apply_patch: 0,
  };
  for (const event of args.events) {
    if (
      event.status !== "failed"
      || !editWriteToolAction(event.tool_name)
      || !toolEventTouchesLock(event, args.files, args.workspaceDir)
    ) {
      continue;
    }
    counts[event.tool_name] += 1;
  }
  return counts;
}

function editPhaseFailureBudget(args: {
  eventsAfterFailure: ToolEvent[];
  files: string[];
  workspaceDir: string;
  candidateWriteActions: string[];
}): JsonObject | null {
  if (args.files.length === 0) return null;
  const failureCounts = editWriteFailureCounts({
    events: args.eventsAfterFailure,
    files: args.files,
    workspaceDir: args.workspaceDir,
  });
  const totalFailureCount = Object.values(failureCounts).reduce((sum, value) => sum + value, 0);
  if (totalFailureCount === 0) return null;
  const successfulWriteCount = args.eventsAfterFailure.filter((event) => (
    event.status === "success"
    && editWriteToolAction(event.tool_name)
    && targetFileWritten(event, args.files)
  )).length;
  const failedActions = EDIT_WRITE_TOOL_ACTIONS.filter((action) => failureCounts[action] > 0);
  const quarantinedActions = EDIT_WRITE_TOOL_ACTIONS.filter((action) => failureCounts[action] >= 2);
  const candidateActions = uniqueStringValues([
    args.candidateWriteActions.filter(editWriteToolAction),
    EDIT_WRITE_TOOL_ACTIONS,
  ], 8).filter(editWriteToolAction);
  const allowedAfterQuarantine = candidateActions.filter((action) => !quarantinedActions.includes(action));
  const allCandidateWriteActionsExhausted = candidateActions.length > 0 && allowedAfterQuarantine.length === 0;
  const preferredAction = allowedAfterQuarantine
    .find((action) => failureCounts[action] === 0)
    ?? allowedAfterQuarantine[0]
    ?? null;
  const forceRequiredVerifier = allCandidateWriteActionsExhausted
    || (successfulWriteCount > 0 && failedActions.length >= 2 && totalFailureCount >= 3);
  const budgetActive = quarantinedActions.length > 0 || forceRequiredVerifier;
  if (!budgetActive) {
    return {
      summary_version: "edit_phase_failure_budget_v1",
      required: false,
      reason: "edit_write_failures_observed_below_budget",
      scope: "latest_verifier_failure_phase",
      failure_counts_by_action: failureCounts,
      failed_write_actions: failedActions,
      successful_write_count_after_latest_verifier: successfulWriteCount,
      total_failed_write_count_after_latest_verifier: totalFailureCount,
      quarantined_write_actions: [],
      allowed_write_actions: candidateActions,
      preferred_action: preferredAction,
      force_required_verifier: false,
    };
  }
  return {
    summary_version: "edit_phase_failure_budget_v1",
    required: true,
    reason: allCandidateWriteActionsExhausted
      ? "all_write_actions_exhausted"
      : forceRequiredVerifier
      ? "multi_tool_edit_phase_exhausted_after_successful_write"
      : "write_action_failure_budget_exceeded",
    scope: "latest_verifier_failure_phase",
    failure_counts_by_action: failureCounts,
    failed_write_actions: failedActions,
    successful_write_count_after_latest_verifier: successfulWriteCount,
    total_failed_write_count_after_latest_verifier: totalFailureCount,
    quarantined_write_actions: quarantinedActions,
    allowed_write_actions: allowedAfterQuarantine,
    preferred_action: forceRequiredVerifier ? null : preferredAction,
    force_required_verifier: forceRequiredVerifier,
    instruction: allCandidateWriteActionsExhausted
      ? "Runtime observed repeated failures across every available write tool family in this verifier phase. No safe write action remains; stop editing and run the required verifier to close this phase and produce fresh adjudication evidence."
      : forceRequiredVerifier
      ? "Runtime observed failures across multiple write tool families after a successful locked edit. Stop additional writes in this phase and run the required verifier to obtain fresh evidence."
      : `Runtime observed repeated edit failures in this verifier phase. Do not use quarantined write action(s): ${quarantinedActions.join(", ")}. Use ${preferredAction ?? "a non-quarantined write action"} on the locked file, or run the required verifier only after a successful write.`,
  };
}

function lockedRepairActionHistory(args: {
  policy: RuntimeSequencePolicy;
  priorEvents: ToolEvent[];
  latestVerifierIndex: number;
  files: string[];
  workspaceDir: string;
}): JsonObject {
  let phaseStartIndex = 0;
  for (let index = args.latestVerifierIndex - 1; index >= 0; index -= 1) {
    const event = args.priorEvents[index];
    if (!event || !eventRunsRequiredVerifier(args.policy, event)) continue;
    if (event.status === "success") {
      phaseStartIndex = index + 1;
      break;
    }
  }
  const phaseEvents = args.priorEvents.slice(phaseStartIndex, args.latestVerifierIndex + 1);
  let replaceLinesSemanticFailureCount = 0;
  let applyPatchSemanticFailureCount = 0;
  let replaceTextSemanticFailureCount = 0;
  let verifierFailureCount = 0;
  for (let index = 0; index < phaseEvents.length; index += 1) {
    const event = phaseEvents[index];
    if (!eventRunsRequiredVerifier(args.policy, event) || event.status === "success") continue;
    const outputText = verifierOutputTextFromEvent(event);
    if (!sourceWorkflowVerifierFailure(outputText)) continue;
    const implementationFiles = verifierFailureImplementationFilesForWorkflow({
      policy: args.policy,
      event,
      workspaceDir: args.workspaceDir,
      fallbackFiles: args.files,
    });
    if (!implementationFiles.some((file) => args.files.includes(file))) continue;
    verifierFailureCount += 1;
    let previousVerifierIndex = -1;
    for (let reverse = index - 1; reverse >= 0; reverse -= 1) {
      const reverseEvent = phaseEvents[reverse];
      if (reverseEvent && eventRunsRequiredVerifier(args.policy, reverseEvent)) {
        previousVerifierIndex = reverse;
        break;
      }
    }
    const cycleEvents = phaseEvents.slice(previousVerifierIndex + 1, index);
    if (cycleEvents.some((cycleEvent) => (
      cycleEvent.status === "success"
      && cycleEvent.tool_name === "replace_lines"
      && targetFileWritten(cycleEvent, args.files)
    ))) {
      replaceLinesSemanticFailureCount += 1;
    }
    if (cycleEvents.some((cycleEvent) => (
      cycleEvent.status === "success"
      && cycleEvent.tool_name === "apply_patch"
      && targetFileWritten(cycleEvent, args.files)
    ))) {
      applyPatchSemanticFailureCount += 1;
    }
    if (cycleEvents.some((cycleEvent) => (
      cycleEvent.status === "success"
      && cycleEvent.tool_name === "replace_text"
      && targetFileWritten(cycleEvent, args.files)
    ))) {
      replaceTextSemanticFailureCount += 1;
    }
  }
  const replaceLinesPayloadFailureCount = phaseEvents.filter((event) => (
    event.status === "failed"
    && event.tool_name === "replace_lines"
    && toolEventTouchesLock(event, args.files, args.workspaceDir)
    && replaceLinesPayloadFailureError(asString(asObject(event.output_signature)?.error) ?? "")
  )).length;
  const replaceLinesOversizedPayloadFailureCount = phaseEvents.filter((event) => (
    event.status === "failed"
    && event.tool_name === "replace_lines"
    && toolEventTouchesLock(event, args.files, args.workspaceDir)
    && replaceLinesOversizedPayloadFailureError(asString(asObject(event.output_signature)?.error) ?? "")
  )).length;
  const replaceLinesCompactSpanViolationCount = phaseEvents.filter((event) => (
    event.status === "failed"
    && event.tool_name === "replace_lines"
    && toolEventTouchesLock(event, args.files, args.workspaceDir)
    && compactSpanViolationError(asString(asObject(event.output_signature)?.error) ?? "")
  )).length;
  const applyPatchPayloadFailureCount = phaseEvents.filter((event) => applyPatchPayloadFailureEvent(event, args.files, args.workspaceDir)).length;
  return {
    summary_version: "locked_repair_action_history_v1",
    phase_start_step: phaseEvents[0]?.step_index ?? null,
    latest_verifier_step: args.priorEvents[args.latestVerifierIndex]?.step_index ?? null,
    verifier_failure_count: verifierFailureCount,
    replace_lines_semantic_failure_count: replaceLinesSemanticFailureCount,
    apply_patch_semantic_failure_count: applyPatchSemanticFailureCount,
    replace_text_semantic_failure_count: replaceTextSemanticFailureCount,
    replace_lines_payload_failure_count: replaceLinesPayloadFailureCount,
    replace_lines_oversized_payload_failure_count: replaceLinesOversizedPayloadFailureCount,
    replace_lines_compact_span_violation_count: replaceLinesCompactSpanViolationCount,
    apply_patch_payload_failure_count: applyPatchPayloadFailureCount,
  };
}

function lockedRepairAnchorRefreshTarget(files: string[], outputLineHints: JsonObject[]): JsonObject | null {
  const hinted = outputLineHints.find((hint) => {
    const path = asString(hint.path);
    return !!path && files.includes(path);
  }) ?? outputLineHints.find((hint) => !!asString(hint.path));
  const hintedPath = asString(hinted?.path);
  const path = hintedPath && (files.length === 0 || files.includes(hintedPath))
    ? hintedPath
    : files[0];
  if (!path) return null;
  const line = numeric(hinted?.line);
  const startLine = line > 0 ? Math.max(1, line - 12) : 1;
  const endLine = line > 0 ? line + 24 : 80;
  return {
    path,
    line: line > 0 ? line : null,
    start_line: startLine,
    end_line: endLine,
  };
}

function readEventCoversAnchorRefresh(event: ToolEvent, anchorRefresh: JsonObject): boolean {
  const path = asString(anchorRefresh.path);
  if (!path || event.status !== "success" || event.tool_name !== "read_file" || !eventTouchesAnyFile(event, [path])) {
    return false;
  }
  const output = asObject(event.output_signature) ?? {};
  const requestedStart = numeric(output.start_line ?? event.tool_input.start_line);
  const requestedEnd = numeric(output.end_line ?? event.tool_input.end_line);
  const requiredStart = numeric(anchorRefresh.start_line);
  const requiredEnd = numeric(anchorRefresh.end_line);
  return requestedStart > 0
    && requestedEnd > 0
    && requiredStart > 0
    && requiredEnd > 0
    && requestedStart <= requiredStart
    && requestedEnd >= requiredEnd;
}

function lockedRepairAnchorRefreshNextAction(lock: JsonObject | null): JsonObject | null {
  if (!lock || asString(lock.reason) !== "latest_verifier_failure_lock") return null;
  const anchorRefresh = asObject(lock.locked_repair_anchor_refresh_v1);
  if (anchorRefresh?.required !== true) return null;
  const path = asString(anchorRefresh.path);
  if (!path) return null;
  return {
    reason: "locked_repair_current_anchor_required",
    action: "read_file",
    path,
    allowed_files: [path],
    start_line: numeric(anchorRefresh.start_line) || 1,
    end_line: numeric(anchorRefresh.end_line) || 80,
    locked_repair_anchor_refresh_v1: anchorRefresh,
    source_failed_verifier_step: lock.failed_verifier_step ?? null,
    source_lock_files: stringList(lock.files),
    instruction: asString(anchorRefresh.instruction)
      ?? "The compact locked repair kept repeating invalid write payloads. Refresh the exact current source span before another write.",
  };
}

function readActionMatchesLockedAnchorRefresh(action: string, input: JsonObject, anchorAction: JsonObject): boolean {
  if (action !== "read_file") return false;
  const path = asString(anchorAction.path);
  if (!path || asString(input.path) !== path) return false;
  const requiredStart = numeric(anchorAction.start_line);
  const requiredEnd = numeric(anchorAction.end_line);
  return numeric(input.start_line) === requiredStart && numeric(input.end_line) === requiredEnd;
}

function latestFailedVerifierLock(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[], workspaceDir: string): JsonObject | null {
  if (policy.requiredVerifiers.length === 0) return null;
  for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
    const event = priorEvents[index];
    if (!event || !eventRunsRequiredVerifier(policy, event)) continue;
    if (event.status === "success") return null;
    const outputText = verifierOutputTextFromEvent(event);
    const rawOutputFiles = workspaceFilesMentionedInText(outputText, workspaceDir);
    const rawOutputLineHints = workspaceFileLineHintsMentionedInText(outputText, workspaceDir);
    const outputLineHints = existingWorkspaceLineHints(rawOutputLineHints, workspaceDir);
    const outputLineHintFiles = uniqueStringValues(
      outputLineHints.map((hint) => asString(hint.path)).filter((file): file is string => !!file),
      32,
    );
    const phaseFallbackFiles = uniqueStringValues([
      policy.verifierFailurePrimaryFiles,
      policy.verifierFailureLineHintFiles,
      policy.verifierFailureRepairAffectedFiles,
      policy.repairFirstWriteFiles,
    ], 32);
    const outputFiles = trustedVerifierOutputFiles({
      outputFiles: rawOutputFiles,
      policyFiles: phaseFallbackFiles,
      workspaceDir,
    });
    const recentWriteFiles = successfulWriteFilesSincePreviousVerifier(policy, priorEvents, index);
    const lineDiagnosticRepair = verifierLineDiagnosticRepair(outputText, workspaceDir, phaseFallbackFiles);
    const importContractEvidence = verifierImportContractEvidence(policy, priorEvents, index, workspaceDir);
    const specificInstruction = verifierFailureSpecificInstruction(outputText);
    const rawRepeatedFailureConvergence = repeatedVerifierFailureConvergence(policy, priorEvents, index, outputText);
    const formatterCommands = formatterFailureRequiresFormatter(outputText)
      ? formatterCommandsForFailure(policy, outputFiles.length > 0 ? outputFiles : phaseFallbackFiles, outputText)
      : [];
    const formatterAttemptedAfterFailure = formatterCommands.length > 0
      && priorEvents.slice(index + 1).some((laterEvent) => (
        laterEvent.tool_name === "run_command"
        && commandMatchesAny(asString(laterEvent.tool_input.command) ?? "", formatterCommands)
      ));
    const effectiveFormatterCommands = formatterAttemptedAfterFailure ? [] : formatterCommands;
    const useHiddenContractPrimaryFallback = (
      policy.verifierFailurePhase === "hidden_contract_failure"
      && outputLineHintFiles.length === 0
      && outputFiles.length === 0
      && policy.verifierFailurePrimaryFiles.length > 0
    );
    const candidateFiles = outputLineHintFiles.length > 0
      ? outputLineHintFiles
      : outputFiles.length > 0
        ? outputFiles
        : useHiddenContractPrimaryFallback
          ? policy.verifierFailurePrimaryFiles
          : phaseFallbackFiles;
    const lockTarget = verifierLockTargetFiles({
      candidateFiles,
      outputText,
      outputLineHintFiles,
      outputFiles,
      phase: policy.verifierFailurePhase,
      phasePrimaryFiles: policy.verifierFailurePrimaryFiles,
      repairFirstWriteFiles: policy.repairFirstWriteFiles,
      recentWriteFiles,
      repeatedFailureConvergence: rawRepeatedFailureConvergence,
    });
    const files = lockTarget.files;
    const nonNoopStagnation = repeatedNonNoopRepairStagnation({
      policy,
      priorEvents,
      workspaceDir,
      files,
    });
    const sameFileWorkflowEscalation = sameFileSourceWorkflowEscalation({
      policy,
      priorEvents,
      latestVerifierIndex: index,
      latestOutputText: outputText,
      workspaceDir,
      lockFiles: files,
    });
    const maxNarrowReadsBeforeLockedRepairWrite = lineDiagnosticRepair?.required === true
      ? Math.max(0, numeric(lineDiagnosticRepair.max_narrow_reads_before_write) || 1)
      : 2;
    const eventsAfterFailure = priorEvents.slice(index + 1);
    const phaseActionHistory = lockedRepairActionHistory({
      policy,
      priorEvents,
      latestVerifierIndex: index,
      files,
      workspaceDir,
    });
    const firstLockedRepairWriteIndex = eventsAfterFailure.findIndex((laterEvent) => (
      laterEvent.status === "success" && targetFileWritten(laterEvent, files)
    ));
    const lockedRepairPreWriteEvents = firstLockedRepairWriteIndex >= 0
      ? eventsAfterFailure.slice(0, firstLockedRepairWriteIndex)
      : eventsAfterFailure;
    const narrowReadsBeforeLockedRepairWrite = lockedRepairPreWriteEvents.filter((laterEvent) => (
      laterEvent.status === "success"
      && laterEvent.tool_name === "read_file"
      && eventTouchesAnyFile(laterEvent, files)
    )).length;
    const lockedRepairReadBudgetExhausted = (
      files.length > 0
      && firstLockedRepairWriteIndex < 0
      && narrowReadsBeforeLockedRepairWrite >= maxNarrowReadsBeforeLockedRepairWrite
    );
    const replaceLinesAnchorFailureCount = eventsAfterFailure.filter((laterEvent) => {
      const next = asObject(asObject(laterEvent.output_signature)?.edit_operation_next_action);
      const reason = asString(next?.reason);
      return laterEvent.status === "failed"
        && laterEvent.tool_name === "replace_lines"
        && reason === "replace_lines_current_anchor_required"
        && eventTouchesAnyFile(laterEvent, files);
    }).length;
    const replaceLinesPayloadFailureCount = eventsAfterFailure.filter((laterEvent) => {
      const output = asObject(laterEvent.output_signature);
      const error = asString(output?.error) ?? "";
      return laterEvent.status === "failed"
        && laterEvent.tool_name === "replace_lines"
        && toolEventTouchesLock(laterEvent, files, workspaceDir)
        && replaceLinesPayloadFailureError(error);
    }).length;
    const replaceLinesOversizedPayloadFailureCount = eventsAfterFailure.filter((laterEvent) => {
      const output = asObject(laterEvent.output_signature);
      const error = asString(output?.error) ?? "";
      return laterEvent.status === "failed"
        && laterEvent.tool_name === "replace_lines"
        && toolEventTouchesLock(laterEvent, files, workspaceDir)
        && replaceLinesOversizedPayloadFailureError(error);
    }).length;
    const compactSpanViolationIndexes = eventsAfterFailure.flatMap((laterEvent, relativeIndex) => {
      const output = asObject(laterEvent.output_signature);
      const error = asString(output?.error) ?? "";
      const touchesLock = eventTouchesAnyFile(laterEvent, files)
        || inputTouchesFiles(laterEvent.tool_name, laterEvent.tool_input, files, workspaceDir);
      return laterEvent.status === "failed"
        && laterEvent.tool_name === "replace_lines"
        && touchesLock
        && compactSpanViolationError(error)
        ? [relativeIndex]
        : [];
    });
    const compactSpanViolationCount = compactSpanViolationIndexes.length;
    const applyPatchPayloadFailureCount = eventsAfterFailure
      .filter((laterEvent) => applyPatchPayloadFailureEvent(laterEvent, files, workspaceDir)).length;
    const totalReplaceLinesPayloadFailureCount = replaceLinesPayloadFailureCount
      + numeric(phaseActionHistory.replace_lines_payload_failure_count);
    const totalReplaceLinesOversizedPayloadFailureCount = replaceLinesOversizedPayloadFailureCount
      + numeric(phaseActionHistory.replace_lines_oversized_payload_failure_count);
    const totalCompactSpanViolationCount = compactSpanViolationCount
      + numeric(phaseActionHistory.replace_lines_compact_span_violation_count);
    const totalApplyPatchPayloadFailureCount = applyPatchPayloadFailureCount
      + numeric(phaseActionHistory.apply_patch_payload_failure_count);
    const replaceLinesSemanticFailureCount = numeric(phaseActionHistory.replace_lines_semantic_failure_count);
    const danglingHelperPayloadRejections = eventsAfterFailure.flatMap((laterEvent) => {
      const output = asObject(laterEvent.output_signature);
      const error = asString(output?.error) ?? "";
      if (
        laterEvent.status !== "failed"
        || !isWriteToolAction(laterEvent.tool_name)
        || !(eventTouchesAnyFile(laterEvent, files) || inputTouchesFiles(laterEvent.tool_name, laterEvent.tool_input, files, workspaceDir))
      ) {
        return [];
      }
      return helperImportPayloadRejectionSymbols(error);
    });
    const danglingHelperPayloadRejectionCount = danglingHelperPayloadRejections.length;
    const danglingHelperPayloadRejectedSymbols = uniqueStringValues(danglingHelperPayloadRejections, 8);
    const danglingHelperApplyPatchRejectionCount = eventsAfterFailure.filter((laterEvent) => {
      const output = asObject(laterEvent.output_signature);
      const error = asString(output?.error) ?? "";
      return laterEvent.status === "failed"
        && laterEvent.tool_name === "apply_patch"
        && (eventTouchesAnyFile(laterEvent, files) || inputTouchesFiles(laterEvent.tool_name, laterEvent.tool_input, files, workspaceDir))
        && helperImportPayloadRejectionSymbols(error).length > 0;
    }).length;
    const compactLockedRepairSpanRequired = totalReplaceLinesPayloadFailureCount >= 2 || totalReplaceLinesOversizedPayloadFailureCount >= 1;
    const compactLockedRepairSpan = compactLockedRepairSpanRequired
      ? {
          summary_version: "locked_repair_compact_span_v1",
          required: true,
          reason: totalReplaceLinesOversizedPayloadFailureCount > 0
            ? "repeated_or_oversized_replace_lines_payload_after_latest_verifier_failure"
            : "repeated_replace_lines_payload_failure_after_latest_verifier_failure",
          failure_count: totalReplaceLinesPayloadFailureCount,
          oversized_failure_count: totalReplaceLinesOversizedPayloadFailureCount,
          max_expected_old_lines: 8,
          max_replacement_lines: 16,
          instruction:
            "Runtime observed replace_lines payload/anchor failures after the latest verifier failure. The next locked repair must use one small contiguous replace_lines span copied from the latest read evidence: at most 8 expected_old_lines and at most 16 replacement_lines. Do not use the whole read range, whole import block, whole file, or whole function as the replace_lines span.",
        }
      : null;
    const anchorRefreshTarget = compactSpanViolationCount >= 2
      ? lockedRepairAnchorRefreshTarget(files, outputLineHints)
      : null;
    const lastCompactSpanViolationIndex = compactSpanViolationIndexes[compactSpanViolationIndexes.length - 1] ?? -1;
    const anchorRefreshSatisfied = anchorRefreshTarget
      ? eventsAfterFailure.slice(lastCompactSpanViolationIndex + 1)
        .some((laterEvent) => readEventCoversAnchorRefresh(laterEvent, anchorRefreshTarget))
      : false;
    const lockedRepairAnchorRefresh = anchorRefreshTarget && !anchorRefreshSatisfied
      ? {
          summary_version: "locked_repair_anchor_refresh_v1",
          required: true,
          reason: "repeated_compact_span_payload_rejection",
          failure_count: compactSpanViolationCount,
          path: asString(anchorRefreshTarget.path),
          line: anchorRefreshTarget.line ?? null,
          start_line: anchorRefreshTarget.start_line,
          end_line: anchorRefreshTarget.end_line,
          instruction:
            `Runtime observed ${compactSpanViolationCount} compact replace_lines payload rejection(s) after the latest verifier failure. Before another write, read the current anchor span exactly: ${asString(anchorRefreshTarget.path)}:${anchorRefreshTarget.start_line}-${anchorRefreshTarget.end_line}.`,
        }
      : null;
    const replaceLinesPayloadQuarantineRequired = (
      totalReplaceLinesPayloadFailureCount >= 4
      || totalCompactSpanViolationCount >= 3
    );
    const replaceLinesSemanticQuarantineRequired = (
      sameFileWorkflowEscalation?.required === true
      && replaceLinesSemanticFailureCount >= 3
    );
    const replaceLinesQuarantineRequired = replaceLinesPayloadQuarantineRequired || replaceLinesSemanticQuarantineRequired;
    const replaceLinesQuarantinePreferredAction = replaceLinesQuarantineRequired
      ? totalApplyPatchPayloadFailureCount >= 2 ? "replace_text" : "apply_patch"
      : null;
    const lineDiagnosticPreferredAction = asString(lineDiagnosticRepair?.preferred_action);
    const editPhaseBudget = editPhaseFailureBudget({
      eventsAfterFailure,
      files,
      workspaceDir,
      candidateWriteActions: uniqueStringValues([
        stringList(lineDiagnosticRepair?.allowed_write_actions),
        stringList(sameFileWorkflowEscalation?.allowed_write_actions),
        stringList(rawRepeatedFailureConvergence?.allowed_write_actions),
        ["replace_lines", "apply_patch", "replace_text"],
      ], 8),
    });
    const editPhaseBudgetPreferredAction = asString(editPhaseBudget?.preferred_action);
    const preferredLockedRepairAction = lineDiagnosticPreferredAction === "replace_text"
      || lineDiagnosticPreferredAction === "replace_lines"
      || lineDiagnosticPreferredAction === "apply_patch"
      ? lineDiagnosticPreferredAction
      : editPhaseBudget?.force_required_verifier === true
      ? null
      : editPhaseBudget?.required === true && (
        editPhaseBudgetPreferredAction === "replace_text"
        || editPhaseBudgetPreferredAction === "replace_lines"
        || editPhaseBudgetPreferredAction === "apply_patch"
      )
      ? editPhaseBudgetPreferredAction
      : nonNoopStagnation
      ? "apply_patch"
      : replaceLinesQuarantinePreferredAction
        ? replaceLinesQuarantinePreferredAction
      : totalApplyPatchPayloadFailureCount >= 2
      ? sameFileWorkflowEscalation?.required === true && !compactLockedRepairSpanRequired ? "replace_text" : "replace_lines"
      : danglingHelperPayloadRejectionCount >= 2
        ? danglingHelperApplyPatchRejectionCount >= 2 ? "replace_lines" : "apply_patch"
      : lockedRepairReadBudgetExhausted && replaceLinesAnchorFailureCount >= 2
        ? "replace_text"
        : null;
    const lockedRepairActionQuarantine = nonNoopStagnation
      ? {
          summary_version: "locked_repair_action_quarantine_v1",
          quarantined_action: asString(nonNoopStagnation.action) ?? "replace_lines",
          reason: "repeated_non_noop_repair_after_current_anchor_read",
          failure_count: numeric(nonNoopStagnation.failed_repair_count),
          preferred_action: "apply_patch",
          instruction:
            "Runtime observed repeated no-op line-repair failures after current-anchor reads. Do not emit another replace_lines repair for this phase; use apply_patch for one coherent implementation-path change.",
        }
      : replaceLinesQuarantineRequired
      ? {
          summary_version: "locked_repair_action_quarantine_v1",
          quarantined_action: "replace_lines",
          reason: replaceLinesSemanticQuarantineRequired
            ? "successful_replace_lines_repeated_verifier_failure"
            : "repeated_replace_lines_payload_rejections_after_latest_verifier_failure",
          failure_count: totalReplaceLinesPayloadFailureCount,
          semantic_failure_count: replaceLinesSemanticFailureCount,
          compact_span_violation_count: totalCompactSpanViolationCount,
          preferred_action: replaceLinesQuarantinePreferredAction,
          instruction:
            replaceLinesSemanticQuarantineRequired
              ? replaceLinesQuarantinePreferredAction === "replace_text"
                ? "Runtime observed repeated successful replace_lines edits followed by the same source-workflow verifier failure, and apply_patch also failed. Do not emit another replace_lines/apply_patch for this phase; use one compact replace_text anchored on recent read evidence to change the verifier-exercised implementation path."
                : "Runtime observed repeated successful replace_lines edits followed by the same source-workflow verifier failure. Do not emit another replace_lines repair for this phase; use apply_patch for one coherent implementation-path change."
              : replaceLinesQuarantinePreferredAction === "replace_text"
                ? "Runtime observed repeated replace_lines payload failures and apply_patch rejections after the latest verifier failure. Do not emit another replace_lines/apply_patch for this phase; use one compact replace_text anchored on recent read evidence."
                : "Runtime observed repeated replace_lines payload failures after the latest verifier failure. Do not emit another replace_lines repair for this phase; use apply_patch for one coherent implementation-path change.",
        }
      : totalApplyPatchPayloadFailureCount >= 2
      ? {
          summary_version: "locked_repair_action_quarantine_v1",
          quarantined_action: "apply_patch",
          reason: "repeated_apply_patch_payload_rejections_after_latest_verifier_failure",
          failure_count: totalApplyPatchPayloadFailureCount,
          preferred_action: sameFileWorkflowEscalation?.required === true && !compactLockedRepairSpanRequired ? "replace_text" : "replace_lines",
          instruction:
            sameFileWorkflowEscalation?.required === true && compactLockedRepairSpanRequired
              ? "Runtime observed repeated apply_patch payload rejections during a same-file source workflow escalation while compact-span mode is active. Do not emit another apply_patch for this repair phase; use one small replace_lines span copied from recent read evidence."
              : sameFileWorkflowEscalation?.required === true
              ? "Runtime observed repeated apply_patch payload rejections during a same-file source workflow escalation. Do not emit another apply_patch for this repair phase; use one compact replace_text anchored on recent read evidence."
              : "Runtime observed repeated apply_patch payload rejections after the latest verifier failure. Do not emit another apply_patch for this repair phase; use a small replace_lines edit copied from recent read evidence.",
        }
      : null;
    const lockedRepairPayloadQuarantine = danglingHelperPayloadRejectionCount >= 2
      ? {
          summary_version: "locked_repair_payload_quarantine_v1",
          quarantined_pattern: "unused_helper_import_without_non_import_usage",
          reason: "repeated_unused_helper_payload_rejections_after_latest_verifier_failure",
          failure_count: danglingHelperPayloadRejectionCount,
          apply_patch_failure_count: danglingHelperApplyPatchRejectionCount,
          rejected_symbols: danglingHelperPayloadRejectedSymbols,
          preferred_action: danglingHelperApplyPatchRejectionCount >= 2 ? "replace_lines" : "apply_patch",
          instruction:
            danglingHelperApplyPatchRejectionCount >= 2
              ? `Runtime observed repeated apply_patch edits that reintroduced helper/import symbol(s) without live call-path usage: ${danglingHelperPayloadRejectedSymbols.join(", ")}. Do not submit another apply_patch for this pattern. Use one small replace_lines span to remove the invalid helper/import/declaration, or include direct non-import usage in the same small span only if current read evidence proves it belongs in the verifier-exercised path.`
              : `Runtime observed repeated edits that reintroduced helper/import symbol(s) without live call-path usage: ${danglingHelperPayloadRejectedSymbols.join(", ")}. The next repair must include non-import usage of those symbol(s) in the verifier-exercised implementation path in the same payload, or remove the import entirely if the dependency contract no longer applies. Do not submit another import/declaration-only payload.`,
        }
      : null;
    const baseFileSelectionReason = outputLineHintFiles.length > 0
      ? "trusted_output_line_hints"
      : outputFiles.length > 0
        ? "trusted_output_files_intersect_policy"
      : useHiddenContractPrimaryFallback
          ? "hidden_contract_primary_fallback"
          : "phase_policy_fallback";
    const fileSelectionReason = lockTarget.reason === "single_or_empty_lock_target" || lockTarget.reason === "multi_file_policy_target"
      ? baseFileSelectionReason
      : `${baseFileSelectionReason}:${lockTarget.reason}`;
    const ignoredOutputFiles = rawOutputFiles.filter((file) => !outputFiles.includes(file));
    const selectedPrimaryFiles = files.filter((file) => policy.verifierFailurePrimaryFiles.includes(file));
    const nonNoopStagnationConvergence = nonNoopStagnation
      ? {
          summary_version: "repeated_verifier_failure_convergence_v1",
          escalation_kind: "same_file_source_workflow",
          trigger_kind: "non_noop_repair_stagnation",
          required: true,
          target_files: asString(nonNoopStagnation.path) ? [asString(nonNoopStagnation.path) as string] : files,
          failed_repair_count: numeric(nonNoopStagnation.failed_repair_count),
          current_anchor_read_count: numeric(nonNoopStagnation.current_anchor_read_count),
          allowed_write_actions: ["apply_patch", "replace_lines"],
          instruction: [
            asString(nonNoopStagnation.instruction),
            "Quarantine the repeated line replacement shape for this verifier phase.",
            "Use apply_patch for one coherent implementation-path repair that changes behavior under the latest hidden-contract verifier, then rerun the required verifier.",
          ].filter(Boolean).join(" "),
        }
      : null;
    const repeatedFailureConvergence = sameFileWorkflowEscalation?.required === true
      ? sameFileWorkflowEscalation
      : nonNoopStagnationConvergence
        ?? sameFileWorkflowEscalation
      ?? (
        rawRepeatedFailureConvergence && selectedPrimaryFiles.length === 0
          ? {
              ...rawRepeatedFailureConvergence,
              required: false,
              instruction:
                "The repeated source-contract signature has moved to coupled verifier files. Repair the locked coupled file(s) before returning to the primary source file.",
            }
          : rawRepeatedFailureConvergence
      );
    const actionSynthesisPlan = actionSynthesisPlanFromVerifierLock({
      files,
      outputLineHints,
      failedVerifierCommand: asString(event.tool_input.command) ?? "",
      lineDiagnosticRepair,
      repeatedFailureConvergence: asObject(repeatedFailureConvergence),
      compactLockedRepairSpan,
      lockedRepairActionQuarantine,
      lockedRepairPayloadQuarantine,
      importContractEvidence,
      editPhaseBudget,
      preferredLockedRepairAction,
    });
    return {
      reason: "latest_verifier_failure_lock",
      failed_verifier_step: event.step_index,
      failed_verifier_command: asString(event.tool_input.command) ?? "",
      files,
      candidate_files_before_target_narrowing: candidateFiles,
      file_selection_reason: fileSelectionReason,
      raw_output_files: rawOutputFiles,
      output_files: outputFiles,
      ignored_output_files: ignoredOutputFiles,
      raw_output_line_hints: rawOutputLineHints,
      output_line_hints: outputLineHints,
      recent_write_files_since_previous_verifier: recentWriteFiles,
      formatter_required: effectiveFormatterCommands.length > 0,
      formatter_commands: effectiveFormatterCommands,
      formatter_attempted_after_failure: formatterAttemptedAfterFailure,
      max_narrow_reads_before_locked_repair_write: maxNarrowReadsBeforeLockedRepairWrite,
      narrow_reads_used_before_locked_repair_write: narrowReadsBeforeLockedRepairWrite,
      locked_repair_read_budget_exhausted: lockedRepairReadBudgetExhausted,
      locked_repair_write_completed: firstLockedRepairWriteIndex >= 0,
      replace_lines_anchor_failure_count: replaceLinesAnchorFailureCount,
      locked_repair_action_history_v1: phaseActionHistory,
      replace_lines_payload_failure_count: totalReplaceLinesPayloadFailureCount,
      replace_lines_payload_failure_count_after_latest_verifier: replaceLinesPayloadFailureCount,
      replace_lines_oversized_payload_failure_count: totalReplaceLinesOversizedPayloadFailureCount,
      replace_lines_compact_span_violation_count: totalCompactSpanViolationCount,
      replace_lines_semantic_failure_count: replaceLinesSemanticFailureCount,
      apply_patch_payload_failure_count: totalApplyPatchPayloadFailureCount,
      apply_patch_payload_failure_count_after_latest_verifier: applyPatchPayloadFailureCount,
      dangling_helper_payload_rejection_count: danglingHelperPayloadRejectionCount,
      dangling_helper_apply_patch_rejection_count: danglingHelperApplyPatchRejectionCount,
      dangling_helper_payload_rejected_symbols: danglingHelperPayloadRejectedSymbols,
      non_noop_stagnation_v1: nonNoopStagnation,
      edit_phase_failure_budget_v1: editPhaseBudget,
      preferred_locked_repair_action: preferredLockedRepairAction,
      locked_repair_compact_span_v1: compactLockedRepairSpan,
      locked_repair_anchor_refresh_v1: lockedRepairAnchorRefresh,
      locked_repair_action_quarantine_v1: lockedRepairActionQuarantine,
      locked_repair_payload_quarantine_v1: lockedRepairPayloadQuarantine,
      phase_primary_files: policy.verifierFailurePrimaryFiles,
      phase_line_hint_files: policy.verifierFailureLineHintFiles,
      phase_repair_affected_files: policy.verifierFailureRepairAffectedFiles,
      specific_repair_instruction: specificInstruction,
      line_diagnostic_repair_v1: lineDiagnosticRepair,
      import_contract_evidence_v1: importContractEvidence,
      repeated_failure_convergence_v1: repeatedFailureConvergence,
      action_synthesis_plan_v1: actionSynthesisPlan,
      instruction: files.length > 0
        ? [
            effectiveFormatterCommands.length > 0
              ? `Latest verifier failure is formatter-only; run formatter before manual edits: ${effectiveFormatterCommands.join(" | ")}.`
              : formatterAttemptedAfterFailure
                ? "Formatter was already attempted after the latest verifier failure; manually repair the remaining lint/type location."
              : null,
            `After a failed verifier, repair only latest failure files before broad exploration: ${files.join(", ")}.`,
            lockedRepairReadBudgetExhausted
              ? `Read budget is exhausted (${narrowReadsBeforeLockedRepairWrite}/${maxNarrowReadsBeforeLockedRepairWrite}); write the locked file now instead of reading more.`
              : null,
            preferredLockedRepairAction === "replace_text"
              ? `replace_lines anchors failed ${replaceLinesAnchorFailureCount} time(s) after this verifier failure; use one compact replace_text anchored on recent read evidence instead of another replace_lines attempt.`
              : null,
            asString(compactLockedRepairSpan?.instruction),
            asString(lockedRepairAnchorRefresh?.instruction),
            asString(editPhaseBudget?.instruction),
            asString(lockedRepairActionQuarantine?.instruction),
            asString(lockedRepairPayloadQuarantine?.instruction),
            asString(lineDiagnosticRepair?.instruction),
            asString(importContractEvidence?.instruction),
            specificInstruction,
            asString(repeatedFailureConvergence?.instruction),
            outputLineHints.length > 0
              ? `Start at latest verifier line hints: ${outputLineHints.map((hint) => `${asString(hint.path)}${typeof hint.line === "number" ? `:${hint.line}${typeof hint.column === "number" ? `:${hint.column}` : ""}` : ""}`).join(", ")}.`
              : null,
            "Rerun the required verifier after the localized repair.",
          ].filter(Boolean).join(" ")
        : "After a failed verifier, rerun the required verifier or request operator review before broad exploration.",
    };
  }
  return null;
}

function actionAllowedByVerifierFailureLock(args: {
  policy: RuntimeSequencePolicy;
  lock: JsonObject;
  action: string;
  input: JsonObject;
  workspaceDir: string;
}): boolean {
  const lockFiles = stringList(args.lock.files);
  const formatterCommands = stringList(args.lock.formatter_commands);
  const formatterRequired = args.lock.formatter_required === true && formatterCommands.length > 0;
  const repeatedFailureConvergence = asObject(args.lock.repeated_failure_convergence_v1);
  const lineDiagnosticRepair = asObject(args.lock.line_diagnostic_repair_v1);
  const lineDiagnosticRequired = lineDiagnosticRepair?.required === true;
  const lineDiagnosticWriteActions = stringList(lineDiagnosticRepair?.allowed_write_actions)
    .filter((action): action is "replace_lines" | "apply_patch" => action === "replace_lines" || action === "apply_patch");
  const functionLevelRepairRequired = repeatedFailureConvergence?.required === true;
  const preferredLockedRepairAction = asString(args.lock.preferred_locked_repair_action);
  const editPhaseBudget = asObject(args.lock.edit_phase_failure_budget_v1);
  const budgetQuarantinedActions = stringList(editPhaseBudget?.quarantined_write_actions);
  const budgetPreferredAction = asString(editPhaseBudget?.preferred_action);
  const budgetForcesVerifier = editPhaseBudget?.force_required_verifier === true;
  if (args.action === "run_command") {
    const command = asString(args.input.command) ?? "";
    if (budgetForcesVerifier) return commandMatchesRequiredVerifier(command, args.policy.requiredVerifiers);
    if (lineDiagnosticRequired && args.lock.locked_repair_write_completed !== true) return false;
    if (commandMatchesRequiredVerifier(command, args.policy.requiredVerifiers)) return true;
    if (formatterRequired && commandMatchesFormatterCommand(command, formatterCommands, args.workspaceDir)) {
      const formatterTargets = formatterWriteTargets(splitCommandWords(command), args.workspaceDir);
      return formatterTargets !== null
        && formatterTargets.length > 0
        && formatterTargets.every((file) => args.policy.repairFirstWriteFiles.includes(file));
    }
    if (formatterRequired) return false;
    return inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir);
  }
  if (budgetForcesVerifier) return false;
  if (formatterRequired) return false;
  if (lineDiagnosticRequired) {
    if (args.action === "read_file") return inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir);
    if (preferredLockedRepairAction === "replace_lines" || preferredLockedRepairAction === "apply_patch") {
      return args.action === preferredLockedRepairAction
        && lineDiagnosticWriteActions.includes(args.action)
        && inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir);
    }
    if ((args.action === "replace_lines" || args.action === "apply_patch") && lineDiagnosticWriteActions.includes(args.action)) {
      return inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir);
    }
    return false;
  }
  if (
    editWriteToolAction(args.action)
    && budgetQuarantinedActions.includes(args.action)
    && inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir)
  ) {
    return false;
  }
  if (
    budgetPreferredAction
    && editPhaseBudget?.required === true
    && editWriteToolAction(budgetPreferredAction)
  ) {
    return args.action === budgetPreferredAction
      && inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir);
  }
  if (functionLevelRepairRequired) {
    if (args.action === "read_file") return inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir);
    if (
      preferredLockedRepairAction === "replace_text"
      || preferredLockedRepairAction === "replace_lines"
      || preferredLockedRepairAction === "apply_patch"
    ) {
      const protocolSafePreferredAlternative = preferredLockedRepairAction === "apply_patch"
        && args.action === "replace_text";
      return (args.action === preferredLockedRepairAction || protocolSafePreferredAlternative)
        && inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir);
    }
    if (args.action === "replace_lines" || args.action === "apply_patch") {
      return inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir);
    }
    return false;
  }
  if (
    preferredLockedRepairAction
    && (preferredLockedRepairAction === "replace_text" || preferredLockedRepairAction === "replace_lines" || preferredLockedRepairAction === "apply_patch")
  ) {
    return args.action === preferredLockedRepairAction
      && inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir);
  }
  if (args.action === "read_file" || args.action === "replace_text" || args.action === "replace_lines" || args.action === "apply_patch") {
    return inputTouchesFiles(args.action, args.input, lockFiles, args.workspaceDir);
  }
  return false;
}

function replaceLinesExpectedOldLineCount(input: JsonObject): number {
  return Array.isArray(input.expected_old_lines) ? input.expected_old_lines.length : 0;
}

function replaceLinesReplacementLineCount(input: JsonObject): number {
  return Array.isArray(input.replacement_lines) ? input.replacement_lines.length : 0;
}

function replaceLinesRequestedRangeLineCount(input: JsonObject): number {
  const startLine = numeric(input.start_line);
  const endLine = numeric(input.end_line);
  if (typeof startLine !== "number" || typeof endLine !== "number" || endLine < startLine) return 0;
  return endLine - startLine + 1;
}

function applyPatchHunkCount(input: JsonObject): number {
  const patch = asString(input.patch) ?? "";
  return [...patch.matchAll(/^@@\s/gm)].length;
}

function defaultImportRegexForModule(moduleName: string): RegExp {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bimport\\s+[A-Za-z_$][\\w$]*\\s+from\\s+["']${escaped}["']`, "m");
}

function namedImportRegexForModuleSymbol(moduleName: string, symbol: string): RegExp {
  const escapedModule = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bimport\\s*\\{[^}]*\\b${escapedSymbol}\\b[^}]*\\}\\s*from\\s+["']${escapedModule}["']`, "m");
}

function jsonObjectList(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map((item) => asObject(item)).filter((item): item is JsonObject => !!item)
    : [];
}

function importOrDeclarationMentionsSymbol(text: string, symbol: string): boolean {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declarationPattern = new RegExp(`\\b(?:const|let|var|function|class|interface|type)\\s+${escapedSymbol}\\b`, "m");
  return text
    .split(/\r?\n/)
    .some((line) => /^\s*import\b/.test(line) && new RegExp(`\\b${escapedSymbol}\\b`).test(line))
    || declarationPattern.test(text);
}

function nonImportUsageMentionsSymbol(text: string, symbol: string): boolean {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const symbolPattern = new RegExp(`\\b${escapedSymbol}\\b`);
  return text
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed || /^import\b/.test(trimmed) || /^export\s+type\b/.test(trimmed)) return false;
      if (/^(?:const|let|var|function|class|interface|type)\s+/.test(trimmed) && symbolPattern.test(trimmed)) return false;
      return symbolPattern.test(line);
    });
}

function localImportBindingNames(importLine: string): string[] {
  const trimmed = importLine.trim();
  if (!trimmed.startsWith("import ")) return [];
  if (/^import\s+["'][^"']+["']\s*;?$/.test(trimmed)) return [];
  const bindings: string[] = [];
  const namespaceMatch = trimmed.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceMatch?.[1]) bindings.push(namespaceMatch[1]);
  const defaultMatch = trimmed.match(/^import\s+([A-Za-z_$][\w$]*)(?:\s*,|\s+from\b)/);
  if (defaultMatch?.[1] && defaultMatch[1] !== "type") bindings.push(defaultMatch[1]);
  const namedMatch = trimmed.match(/\{([^}]+)\}/);
  if (namedMatch?.[1]) {
    for (const rawPart of namedMatch[1].split(",")) {
      const part = rawPart.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const aliasMatch = part.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const directMatch = part.match(/^([A-Za-z_$][\w$]*)$/);
      const alias = aliasMatch?.[1] ?? directMatch?.[1];
      if (alias) bindings.push(alias);
    }
  }
  return uniqueStringValues(bindings, 16);
}

function importOrDeclarationSymbols(text: string): string[] {
  const symbols: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*import\b/.test(line)) symbols.push(...localImportBindingNames(line));
  }
  const declarationPattern = /^\s*(?:export\s+)?(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)\b/gm;
  for (const match of text.matchAll(declarationPattern)) {
    if (match[1]) symbols.push(match[1]);
  }
  return uniqueStringValues(symbols, 32);
}

function introducedDanglingHelperSymbols(args: {
  action: string;
  input: JsonObject;
  workspaceDir: string;
  lockFiles: string[];
}): string[] {
  if (!isWriteToolAction(args.action) || args.lockFiles.length === 0) return [];
  const changes = args.action === "apply_patch"
    ? patchFileTextChanges(asString(args.input.patch) ?? "")
    : [
        {
          path: asString(args.input.path) ?? "",
          addedText: editIntroducedText(args.action, args.input),
          removedText: editRemovedText(args.action, args.input),
        },
      ];
  const danglingSymbols: string[] = [];
  for (const change of changes) {
    if (!change.path || !args.lockFiles.includes(change.path)) continue;
    const introducedSymbols = importOrDeclarationSymbols(change.addedText)
      .filter((symbol) => !importOrDeclarationMentionsSymbol(change.removedText, symbol));
    if (introducedSymbols.length === 0) continue;
    const file = resolveWorkspacePath(args.workspaceDir, change.path);
    const currentText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    for (const symbol of introducedSymbols) {
      if (nonImportUsageMentionsSymbol(change.addedText, symbol)) continue;
      if (currentText && nonImportUsageMentionsSymbol(currentText, symbol)) continue;
      danglingSymbols.push(symbol);
    }
  }
  return uniqueStringValues(danglingSymbols, 16);
}

function diagnosticModuleBareNames(lineDiagnosticRepair: JsonObject | null): string[] {
  const names: string[] = [];
  for (const diagnostic of Array.isArray(lineDiagnosticRepair?.diagnostics) ? lineDiagnosticRepair.diagnostics : []) {
    const moduleSpecifier = asString(asObject(diagnostic)?.module_specifier);
    if (!moduleSpecifier) continue;
    const nodeModulesMatch = moduleSpecifier.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
    if (nodeModulesMatch?.[1]) {
      names.push(nodeModulesMatch[1]);
      continue;
    }
    if (!moduleSpecifier.startsWith("/") && !moduleSpecifier.startsWith(".")) names.push(moduleSpecifier);
  }
  return uniqueStringValues(names, 8);
}

function normalizedModuleSpecifier(moduleSpecifier: string): string {
  return moduleSpecifier
    .trim()
    .replace(/^\\?["']+/, "")
    .replace(/\\?["']+$/, "");
}

function moduleBareNameFromSpecifier(moduleSpecifier: string): string | null {
  const normalizedSpecifier = normalizedModuleSpecifier(moduleSpecifier);
  const nodeModulesMatch = normalizedSpecifier.match(/node_modules\/(@[^/\\'")\s]+\/[^/\\'")\s]+|[^/\\'")\s]+)/);
  if (nodeModulesMatch?.[1]) return nodeModulesMatch[1];
  if (normalizedSpecifier.startsWith("/") || normalizedSpecifier.startsWith(".")) return null;
  const packageMatch = normalizedSpecifier.match(/^(@[^/]+\/[^/]+|[^/]+)/);
  return packageMatch?.[1] ?? null;
}

function noDefaultExportModulesFromText(outputText: string): string[] {
  const modules: string[] = [];
  if (/has no default export/i.test(outputText)) {
    for (const match of outputText.matchAll(/node_modules\/(@[^/\\'")\s]+\/[^/\\'")\s]+|[^/\\'")\s]+)/gi)) {
      if (match[1]) modules.push(match[1]);
    }
  }
  for (const match of outputText.matchAll(/Module\s+['"]([^'"]+)['"][\s\S]{0,220}?has no default export/gi)) {
    const moduleName = moduleBareNameFromSpecifier(match[1]);
    if (moduleName) modules.push(moduleName);
  }
  for (const match of outputText.matchAll(/import\s+\{\s*[^}]+\s*\}\s+from\s+["']([^"']+)["']/gi)) {
    const moduleName = moduleBareNameFromSpecifier(match[1]);
    if (moduleName && /has no default export/i.test(outputText)) modules.push(moduleName);
  }
  return uniqueStringValues(modules, 8);
}

function missingNamedExportsFromText(outputText: string, workspaceDir: string): JsonObject[] {
  const diagnostics = verifierLineDiagnosticsMentionedInText(outputText, workspaceDir);
  const entries: JsonObject[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (asString(diagnostic.code) !== "TS2305") continue;
    const symbol = asString(diagnostic.missing_export_symbol);
    const moduleName = moduleBareNameFromSpecifier(asString(diagnostic.module_specifier) ?? "");
    if (!moduleName || !symbol) continue;
    const key = `${moduleName}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      module: moduleName,
      symbol,
      source_code: "TS2305",
      message: asString(diagnostic.message) ?? "",
    });
  }
  return entries;
}

function verifierImportContractEvidence(
  policy: RuntimeSequencePolicy,
  priorEvents: ToolEvent[],
  latestVerifierIndex: number,
  workspaceDir: string,
): JsonObject | null {
  const events = priorEvents.slice(0, latestVerifierIndex + 1);
  const noDefaultExportModules: string[] = [];
  const forbiddenNamedImports: JsonObject[] = [];
  const forbiddenNamedImportKeys = new Set<string>();
  let scannedFailedVerifierCount = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!eventRunsRequiredVerifier(policy, event)) continue;
    if (event.status === "success") break;
    scannedFailedVerifierCount += 1;
    const outputText = verifierOutputTextFromEvent(event);
    noDefaultExportModules.push(...noDefaultExportModulesFromText(outputText));
    for (const entry of missingNamedExportsFromText(outputText, workspaceDir)) {
      const moduleName = asString(entry.module);
      const symbol = asString(entry.symbol);
      if (!moduleName || !symbol) continue;
      const key = `${moduleName}:${symbol}`;
      if (forbiddenNamedImportKeys.has(key)) continue;
      forbiddenNamedImportKeys.add(key);
      forbiddenNamedImports.push(entry);
    }
  }
  const uniqueNoDefaultExportModules = uniqueStringValues(noDefaultExportModules, 8);
  if (uniqueNoDefaultExportModules.length === 0 && forbiddenNamedImports.length === 0) return null;
  const instructions = [
    uniqueNoDefaultExportModules.length > 0
      ? `Verifier history since the last success proved these modules have no default export: ${uniqueNoDefaultExportModules.join(", ")}. Do not reintroduce default imports for them.`
      : null,
    forbiddenNamedImports.length > 0
      ? `Verifier history since the last success proved these named imports do not exist: ${forbiddenNamedImports.map((entry) => `${asString(entry.module)}.${asString(entry.symbol)}`).join(", ")}. Do not reintroduce those named import bindings.`
      : null,
  ].filter(Boolean).join(" ");
  return {
    summary_version: "verifier_import_contract_evidence_v1",
    no_default_export_modules: uniqueNoDefaultExportModules,
    forbidden_named_imports: forbiddenNamedImports.slice(0, 12),
    failed_verifier_count_since_last_success: scannedFailedVerifierCount,
    instruction: instructions,
  };
}

function editInputText(action: string, input: JsonObject): string {
  if (action === "replace_text") return `${asString(input.find) ?? ""}\n${typeof input.replace === "string" ? input.replace : ""}`;
  if (action === "replace_lines") {
    return [
      requiredStringArrayOrNull(input.expected_old_lines) ?? [],
      requiredStringArrayOrNull(input.replacement_lines) ?? [],
    ].flat().join("\n");
  }
  if (action === "apply_patch") return asString(input.patch) ?? "";
  return "";
}

function editIntroducedText(action: string, input: JsonObject): string {
  if (action === "replace_text") return typeof input.replace === "string" ? input.replace : "";
  if (action === "replace_lines") return (requiredStringArrayOrNull(input.replacement_lines) ?? []).join("\n");
  if (action === "apply_patch") {
    return (asString(input.patch) ?? "")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
  }
  return editInputText(action, input);
}

function editRemovedText(action: string, input: JsonObject): string {
  if (action === "replace_text") return asString(input.find) ?? "";
  if (action === "replace_lines") return (requiredStringArrayOrNull(input.expected_old_lines) ?? []).join("\n");
  if (action === "apply_patch") {
    return (asString(input.patch) ?? "")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("-") && !line.startsWith("---"))
      .map((line) => line.slice(1))
      .join("\n");
  }
  return "";
}

function implementationDeclarationNames(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | undefined) => {
    if (!name || seen.has(name)) return;
    if (/^(?:if|for|while|switch|catch|function|constructor)$/.test(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "");
    const functionMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>{}]+>)?\([^;{}]*\)\s*(?::[^;{}]+)?\{/);
    add(functionMatch?.[1]);
    const methodMatch = line.match(/^\s*(?:(?:public|private|protected|static|override|async|abstract|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>{}]+>)?\([^;{}]*\)\s*(?::[^;{}]+)?\{/);
    add(methodMatch?.[1]);
  }
  return names;
}

type PatchFileTextChange = {
  path: string;
  addedText: string;
  removedText: string;
};

function patchFileTextChanges(patch: string): PatchFileTextChange[] {
  const changes = new Map<string, { added: string[]; removed: string[] }>();
  let currentPath: string | null = null;
  const ensure = (file: string) => {
    if (!changes.has(file)) changes.set(file, { added: [], removed: [] });
    return changes.get(file)!;
  };
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      const file = line.slice("+++ b/".length);
      currentPath = file === "/dev/null" ? null : file;
      if (currentPath) ensure(currentPath);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const match = line.match(/\sb\/(.+)$/);
      currentPath = match?.[1] && match[1] !== "/dev/null" ? match[1] : null;
      if (currentPath) ensure(currentPath);
      continue;
    }
    if (!currentPath) continue;
    const change = ensure(currentPath);
    if (line.startsWith("+") && !line.startsWith("+++")) change.added.push(line.slice(1));
    if (line.startsWith("-") && !line.startsWith("---")) change.removed.push(line.slice(1));
  }
  return [...changes.entries()].map(([file, change]) => ({
    path: file,
    addedText: change.added.join("\n"),
    removedText: change.removed.join("\n"),
  }));
}

function importLineOnlyReplaceLines(input: JsonObject): boolean {
  const expected = requiredStringArrayOrNull(input.expected_old_lines) ?? [];
  const replacement = requiredStringArrayOrNull(input.replacement_lines) ?? [];
  const touched = [...expected, ...replacement].map((line) => line.trim()).filter(Boolean);
  return touched.length > 0 && touched.every((line) => /^import\s/.test(line));
}

function replacementMentionsAnySymbol(input: JsonObject, symbols: string[]): boolean {
  if (symbols.length === 0) return false;
  const replacementText = (requiredStringArrayOrNull(input.replacement_lines) ?? []).join("\n");
  return symbols.some((symbol) => new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(replacementText));
}

function packageDependencyRequirementWriteViolation(args: {
  requirements: JsonObject[];
  action: string;
  input: JsonObject;
  workspaceDir: string;
}): string | null {
  if (args.requirements.length === 0 || !isWriteToolAction(args.action)) return null;
  const touchedRequirements = args.requirements.filter((requirement) => {
    const packageFile = asString(requirement.package_file) ?? "package.json";
    return inputTouchesFiles(args.action, args.input, [packageFile], args.workspaceDir);
  });
  if (touchedRequirements.length === 0) return null;
  const introducedText = editIntroducedText(args.action, args.input);
  for (const requirement of touchedRequirements) {
    const dependency = asString(requirement.dependency);
    const version = asString(requirement.version);
    const targetSection = asString(requirement.target_section) ?? "dependencies";
    const sourceSection = asString(requirement.source_section);
    if (!dependency || !version) continue;
    const dependencyPattern = new RegExp(
      `"${dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
    );
    if (!dependencyPattern.test(introducedText)) {
      return `Runtime package dependency lock rejected incomplete coupled package write. This write must add "${dependency}": "${version}" under ${targetSection}; do not only remove or rename the old entry.`;
    }
    if (sourceSection) {
      if (!packageDependencySourceRemovalProven({
        action: args.action,
        input: args.input,
        sourceSection,
        dependency,
        version,
      })) {
        return `Runtime package dependency lock rejected partial dependency migration. This write must also remove "${dependency}": "${version}" from ${sourceSection} in the same package edit.`;
      }
    }
  }
  return null;
}

function packageDependencySourceRemovalProven(args: {
  action: string;
  input: JsonObject;
  sourceSection: string;
  dependency: string;
  version: string;
}): boolean {
  const sourceSectionPattern = new RegExp(
    `"${args.sourceSection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[\\s\\S]{0,2000}"${args.dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"${args.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
  );
  if (args.action === "replace_lines") {
    const expectedText = (requiredStringArrayOrNull(args.input.expected_old_lines) ?? []).join("\n");
    const replacementText = (requiredStringArrayOrNull(args.input.replacement_lines) ?? []).join("\n");
    return sourceSectionPattern.test(expectedText) && !sourceSectionPattern.test(replacementText);
  }
  if (args.action === "replace_text") {
    const findText = asString(args.input.find) ?? "";
    const replaceText = typeof args.input.replace === "string" ? args.input.replace : "";
    return sourceSectionPattern.test(findText) && !sourceSectionPattern.test(replaceText);
  }
  if (args.action === "apply_patch") {
    const patch = asString(args.input.patch) ?? "";
    const removedDependencyPattern = new RegExp(
      `^-\\s*"${args.dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"${args.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      "m",
    );
    return removedDependencyPattern.test(patch);
  }
  return false;
}

type PackageJsonSection = {
  name: string;
  startIndex: number;
  endIndex: number;
  closeHasComma: boolean;
};

function findPackageJsonSection(lines: string[], sectionName: string): PackageJsonSection | null {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startPattern = new RegExp(`^\\s*"${escaped}"\\s*:\\s*\\{\\s*$`);
  const startIndex = lines.findIndex((line) => startPattern.test(line));
  if (startIndex < 0) return null;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^\s*}\s*,?\s*$/.test(lines[index] ?? "")) {
      return {
        name: sectionName,
        startIndex,
        endIndex: index,
        closeHasComma: /,\s*$/.test(lines[index] ?? ""),
      };
    }
  }
  return null;
}

function packageJsonSectionEntries(packageJson: JsonObject, sectionName: string): [string, string][] {
  const section = asObject(packageJson[sectionName]) ?? {};
  return Object.entries(section)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

function packageJsonSectionIndent(lines: string[], section: PackageJsonSection): string {
  const firstEntry = lines
    .slice(section.startIndex + 1, section.endIndex)
    .find((line) => /^\s*"/.test(line));
  if (firstEntry) return firstEntry.match(/^\s*/)?.[0] ?? "\t\t";
  const sectionIndent = lines[section.startIndex]?.match(/^\s*/)?.[0] ?? "\t";
  return `${sectionIndent}\t`;
}

function buildPackageJsonSectionBlock(args: {
  lines: string[];
  section: PackageJsonSection;
  entries: [string, string][];
}): string[] {
  const sectionLine = args.lines[args.section.startIndex] ?? `\t"${args.section.name}": {`;
  const closeIndent = args.lines[args.section.endIndex]?.match(/^\s*/)?.[0] ?? "\t";
  const entryIndent = packageJsonSectionIndent(args.lines, args.section);
  return [
    sectionLine,
    ...args.entries.map(([key, value], index) => (
      `${entryIndent}"${key}": "${value}"${index === args.entries.length - 1 ? "" : ","}`
    )),
    `${closeIndent}}${args.section.closeHasComma ? "," : ""}`,
  ];
}

function packageDependencyMigrationTemplate(args: {
  requirements: JsonObject[];
  workspaceDir: string;
}): JsonObject | null {
  const requirement = args.requirements.find((entry) => (
    asString(entry.package_file)
    && asString(entry.dependency)
    && asString(entry.version)
    && asString(entry.source_section)
  ));
  if (!requirement) return null;
  const packageFile = asString(requirement.package_file) ?? "package.json";
  const targetSectionName = asString(requirement.target_section) ?? "dependencies";
  const sourceSectionName = asString(requirement.source_section) ?? "devDependencies";
  const dependency = asString(requirement.dependency);
  const version = asString(requirement.version);
  if (!dependency || !version) return null;
  const packagePath = path.join(args.workspaceDir, packageFile);
  if (!fs.existsSync(packagePath)) return null;
  let text: string;
  let packageJson: JsonObject;
  try {
    text = fs.readFileSync(packagePath, "utf8");
    packageJson = JSON.parse(text) as JsonObject;
  } catch {
    return null;
  }
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n");
  const targetSection = findPackageJsonSection(lines, targetSectionName);
  const sourceSection = findPackageJsonSection(lines, sourceSectionName);
  if (!targetSection || !sourceSection) return null;
  const targetEntries = packageJsonSectionEntries(packageJson, targetSectionName)
    .filter(([key]) => key !== dependency);
  const sourceEntries = packageJsonSectionEntries(packageJson, sourceSectionName)
    .filter(([key]) => key !== dependency);
  targetEntries.push([dependency, version]);
  const nextLines = [...lines];
  for (const section of [targetSection, sourceSection].sort((left, right) => right.startIndex - left.startIndex)) {
    const entries = section.name === targetSectionName ? targetEntries : sourceEntries;
    nextLines.splice(
      section.startIndex,
      section.endIndex - section.startIndex + 1,
      ...buildPackageJsonSectionBlock({ lines, section, entries }),
    );
  }
  const rangeStart = Math.min(targetSection.startIndex, sourceSection.startIndex);
  const rangeEnd = Math.max(targetSection.endIndex, sourceSection.endIndex);
  const expectedOldLines = lines.slice(rangeStart, rangeEnd + 1);
  const replacementLines = nextLines.slice(rangeStart, rangeEnd + 1);
  if (stringArraysEqual(expectedOldLines, replacementLines)) return null;
  return {
    summary_version: "package_dependency_migration_template_v1",
    action: "replace_lines",
    path: packageFile,
    dependency,
    version,
    source_section: sourceSectionName,
    target_section: targetSectionName,
    start_line: rangeStart + 1,
    end_line: rangeEnd + 1,
    action_template: {
      action: "replace_lines",
      input: {
        path: packageFile,
        start_line: rangeStart + 1,
        end_line: rangeEnd + 1,
        expected_old_lines: expectedOldLines,
        replacement_lines: replacementLines,
      },
    },
    instruction:
      `Return package_dependency_migration_template_v1.action_template exactly. It moves "${dependency}": "${version}" from ${sourceSectionName} to ${targetSectionName} in one coupled package edit.`,
  };
}

function duplicateImplementationPayloadViolation(args: {
  action: string;
  input: JsonObject;
  workspaceDir: string;
  lockFiles: string[];
}): string | null {
  if (!isWriteToolAction(args.action) || args.lockFiles.length === 0) return null;
  const changes = args.action === "apply_patch"
    ? patchFileTextChanges(asString(args.input.patch) ?? "")
    : [
        {
          path: asString(args.input.path) ?? "",
          addedText: editIntroducedText(args.action, args.input),
          removedText: editRemovedText(args.action, args.input),
        },
      ];
  const duplicateNames: string[] = [];
  for (const change of changes) {
    if (!change.path || !args.lockFiles.includes(change.path)) continue;
    const introducedNames = implementationDeclarationNames(change.addedText);
    if (introducedNames.length === 0) continue;
    const removedNames = new Set(implementationDeclarationNames(change.removedText));
    const file = resolveWorkspacePath(args.workspaceDir, change.path);
    if (!fs.existsSync(file)) continue;
    const currentNames = new Set(implementationDeclarationNames(fs.readFileSync(file, "utf8")));
    for (const name of introducedNames) {
      if (removedNames.has(name)) continue;
      if (currentNames.has(name)) duplicateNames.push(name);
    }
  }
  const uniqueDuplicateNames = uniqueStringValues(duplicateNames, 8);
  if (uniqueDuplicateNames.length === 0) return null;
  return [
    `Runtime verifier failure lock rejected a write that adds duplicate implementation declaration(s) already present in the locked file: ${uniqueDuplicateNames.join(", ")}.`,
    "Edit the existing implementation or remove the duplicate block; do not add a second function/method with the same name.",
  ].join(" ");
}

function verifierFailureLockPayloadViolation(args: {
  lock: JsonObject;
  action: string;
  input: JsonObject;
  workspaceDir: string;
}): string | null {
  const repeatedFailureConvergence = asObject(args.lock.repeated_failure_convergence_v1);
  const lineDiagnosticRepair = asObject(args.lock.line_diagnostic_repair_v1);
  const duplicateImplementationViolation = duplicateImplementationPayloadViolation({
    action: args.action,
    input: args.input,
    workspaceDir: args.workspaceDir,
    lockFiles: stringList(args.lock.files),
  });
  if (duplicateImplementationViolation) return duplicateImplementationViolation;
  const sourceWorkflowRepair = repeatedFailureConvergence?.required === true
    && asString(repeatedFailureConvergence.escalation_kind) === "same_file_source_workflow"
    && lineDiagnosticRepair?.required !== true;
  const compactSpan = asObject(args.lock.locked_repair_compact_span_v1);
  const compactSpanRequired = compactSpan?.required === true;
  if (sourceWorkflowRepair) {
    const danglingSymbols = introducedDanglingHelperSymbols({
      action: args.action,
      input: args.input,
      workspaceDir: args.workspaceDir,
      lockFiles: stringList(args.lock.files),
    });
    if (danglingSymbols.length > 0) {
      return `Runtime verifier failure lock rejected a source-workflow repair that introduces helper/import/declaration symbol(s) without same-payload or existing live call-path usage: ${danglingSymbols.join(", ")}. Use the new symbol in the verifier-exercised implementation path in the same edit, or do not introduce it.`;
    }
  }
  if (sourceWorkflowRepair && compactSpanRequired && args.action === "replace_text") {
    const findLineCount = (asString(args.input.find) ?? "").split(/\r?\n/).length;
    const replaceLineCount = (asString(args.input.replace) ?? "").split(/\r?\n/).length;
    const maxFindLines = numeric(compactSpan.max_expected_old_lines) || 8;
    const maxReplaceLines = numeric(compactSpan.max_replacement_lines) || 16;
    if (findLineCount > maxFindLines || replaceLineCount > maxReplaceLines) {
      return `Runtime verifier failure lock rejected oversized replace_text during compact source-workflow repair. Use replace_lines with at most ${maxFindLines} current lines and ${maxReplaceLines} replacement lines copied from recent read evidence; do not replace a whole block through replace_text.`;
    }
  }
  if (sourceWorkflowRepair && args.action === "replace_lines") {
    const configuredMaxExpectedOldLines = numeric(compactSpan?.max_expected_old_lines);
    const configuredMaxReplacementLines = numeric(compactSpan?.max_replacement_lines);
    const maxExpectedOldLines = compactSpanRequired && configuredMaxExpectedOldLines > 0
      ? configuredMaxExpectedOldLines
      : 18;
    const maxReplacementLines = compactSpanRequired && configuredMaxReplacementLines > 0
      ? configuredMaxReplacementLines
      : 32;
    const expectedOldLineCount = replaceLinesExpectedOldLineCount(args.input);
    const replacementLineCount = replaceLinesReplacementLineCount(args.input);
    const requestedRangeLineCount = replaceLinesRequestedRangeLineCount(args.input);
    if (
      expectedOldLineCount > maxExpectedOldLines
      || requestedRangeLineCount > maxExpectedOldLines
      || replacementLineCount > maxReplacementLines
    ) {
      return compactSpanRequired
        ? `Runtime verifier failure lock requires compact source-workflow replace_lines after repeated payload failures. Use one contiguous span with at most ${maxExpectedOldLines} expected_old_lines/requested range lines and at most ${maxReplacementLines} replacement_lines copied from the latest read evidence.`
        : `Runtime verifier failure lock rejected oversized source-workflow replace_lines payload. Use apply_patch with at most two small hunks, or replace_lines with at most ${maxExpectedOldLines} expected_old_lines/requested range lines and at most ${maxReplacementLines} replacement_lines copied from the latest read.`;
    }
  }
  if (sourceWorkflowRepair && args.action === "apply_patch" && applyPatchHunkCount(args.input) > 2) {
    return "Runtime verifier failure lock rejected oversized source-workflow apply_patch payload. Use at most two focused hunks on the locked implementation file.";
  }
  const diagnosticKind = asString(lineDiagnosticRepair?.diagnostic_kind);
  if (
    sourceWorkflowRepair
    && diagnosticKind === "typescript_unused_symbol"
    && args.action === "replace_lines"
    && importLineOnlyReplaceLines(args.input)
    && replacementMentionsAnySymbol(args.input, stringList(lineDiagnosticRepair?.symbols))
  ) {
    return "Runtime verifier failure lock rejected an import-only source-workflow repair that keeps the unused symbol. Connect the imported helper to the verifier-exercised call path in the same repair, or remove the import instead of toggling import syntax.";
  }
  const importContractEvidence = asObject(args.lock.import_contract_evidence_v1);
  const historicalNoDefaultExportModules = stringList(importContractEvidence?.no_default_export_modules);
  const historicalForbiddenNamedImports = jsonObjectList(importContractEvidence?.forbidden_named_imports);
  if (historicalNoDefaultExportModules.length > 0) {
    const editText = editIntroducedText(args.action, args.input);
    const defaultImportModules = historicalNoDefaultExportModules
      .filter((moduleName) => defaultImportRegexForModule(moduleName).test(editText));
    if (defaultImportModules.length > 0) {
      return `Runtime verifier failure lock rejected a default import that contradicts verifier no-default-export evidence for: ${defaultImportModules.join(", ")}. Use a named import or remove the import if the contract does not require it.`;
    }
  }
  if (historicalForbiddenNamedImports.length > 0) {
    const editText = editIntroducedText(args.action, args.input);
    const rejectedImports = historicalForbiddenNamedImports
      .filter((entry) => {
        const moduleName = asString(entry.module);
        const symbol = asString(entry.symbol);
        return !!moduleName && !!symbol && namedImportRegexForModuleSymbol(moduleName, symbol).test(editText);
      })
      .map((entry) => `${asString(entry.module)}.${asString(entry.symbol)}`);
    if (rejectedImports.length > 0) {
      return `Runtime verifier failure lock rejected named import binding(s) that contradict TS2305 no-export evidence: ${rejectedImports.join(", ")}. Use an exported binding proven by the package contract, or remove the invalid import.`;
    }
  }
  if (diagnosticKind === "typescript_import_contract") {
    const hasNoDefaultExport = Array.isArray(lineDiagnosticRepair?.diagnostics)
      && lineDiagnosticRepair.diagnostics.some((diagnostic) => /no default export/i.test(asString(asObject(diagnostic)?.message) ?? ""));
    if (hasNoDefaultExport) {
      const editText = editIntroducedText(args.action, args.input);
      const defaultImportModules = diagnosticModuleBareNames(lineDiagnosticRepair)
        .filter((moduleName) => defaultImportRegexForModule(moduleName).test(editText));
      if (defaultImportModules.length > 0) {
        return `Runtime verifier failure lock rejected a default import that contradicts TS1192 no-default-export evidence for: ${defaultImportModules.join(", ")}. Use a named import or remove the import if the contract does not require it.`;
      }
    }
  }
  if (diagnosticKind === "typescript_unused_symbol" || diagnosticKind === "typescript_import_contract") {
    const introducedText = editIntroducedText(args.action, args.input);
    const unusedSymbols = stringList(lineDiagnosticRepair?.symbols);
    const danglingSymbols = unusedSymbols.filter((symbol) => (
      importOrDeclarationMentionsSymbol(introducedText, symbol)
      && !nonImportUsageMentionsSymbol(introducedText, symbol)
    ));
    if (danglingSymbols.length > 0) {
      return `Runtime verifier failure lock rejected a repair that reintroduces unused helper/import symbol(s) without non-import call-path usage: ${danglingSymbols.join(", ")}. Connect them to the verifier-exercised implementation path in the same payload, or remove them.`;
    }
  }
  return null;
}

function pendingEditOperationAnchorRead(priorEvents: ToolEvent[]): JsonObject | null {
  for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
    const event = priorEvents[index];
    const nextAction = asObject(asObject(event.output_signature)?.edit_operation_next_action);
    const reason = asString(nextAction?.reason) ?? "";
    const action = asString(nextAction?.action);
    const path = asString(nextAction?.path);
    if (!nextAction || !path || action !== "read_file" || !reason.endsWith("_current_anchor_required")) continue;
    const laterEvents = priorEvents.slice(index + 1);
    if (laterEvents.some((laterEvent) => laterEvent.status === "success" && targetFileWritten(laterEvent, [path]))) return null;
    if (
      laterEvents.some((laterEvent) => (
        laterEvent.status === "success"
        && laterEvent.tool_name === "read_file"
        && eventTouchesAnyFile(laterEvent, [path])
      ))
    ) {
      return null;
    }
    return {
      reason: "edit_operation_current_anchor_required",
      source_reason: reason,
      source_failed_step: event.step_index,
      source_failed_tool: event.tool_name,
      action: "read_file",
      path,
      allowed_files: [path],
      start_line: nextAction.start_line ?? null,
      end_line: nextAction.end_line ?? null,
      actual_old_lines: requiredStringArrayOrNull(nextAction.actual_old_lines)?.slice(0, 20) ?? [],
      instruction:
        "The previous edit failed because its exact anchor was stale. Do one narrow read of the current target range, then retry the edit with current anchors.",
    };
  }
  return null;
}

function pendingEditOperationNonNoopRepair(priorEvents: ToolEvent[]): JsonObject | null {
  for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
    const event = priorEvents[index];
    const nextAction = asObject(asObject(event.output_signature)?.edit_operation_next_action);
    const reason = asString(nextAction?.reason) ?? "";
    const action = asString(nextAction?.action);
    const path = asString(nextAction?.path);
    if (!path || (action !== "replace_text" && action !== "replace_lines") || !reason.endsWith("_non_noop_required")) continue;
    const laterEvents = priorEvents.slice(index + 1);
    if (laterEvents.some((laterEvent) => laterEvent.status === "success" && targetFileWritten(laterEvent, [path]))) return null;
    return nextAction;
  }
  return null;
}

function latestFailedRequiredVerifierIndex(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[]): number {
  for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
    const event = priorEvents[index];
    if (!eventRunsRequiredVerifier(policy, event)) continue;
    if (event.status === "success") return -1;
    return index;
  }
  return -1;
}

function eventNonNoopNextAction(event: ToolEvent): JsonObject | null {
  const nextAction = asObject(asObject(event.output_signature)?.edit_operation_next_action);
  const reason = asString(nextAction?.reason) ?? "";
  const action = asString(nextAction?.action);
  const path = asString(nextAction?.path);
  if (!path || (action !== "replace_text" && action !== "replace_lines") || !reason.endsWith("_non_noop_required")) {
    return null;
  }
  return nextAction;
}

function repeatedNonNoopRepairStagnation(args: {
  policy: RuntimeSequencePolicy;
  priorEvents: ToolEvent[];
  workspaceDir: string;
  files?: string[];
}): JsonObject | null {
  const latestVerifierIndex = latestFailedRequiredVerifierIndex(args.policy, args.priorEvents);
  if (latestVerifierIndex < 0) return null;
  const eventsAfterVerifier = args.priorEvents.slice(latestVerifierIndex + 1);
  for (let index = eventsAfterVerifier.length - 1; index >= 0; index -= 1) {
    const event = eventsAfterVerifier[index];
    const latestNextAction = eventNonNoopNextAction(event);
    const path = asString(latestNextAction?.path);
    const action = asString(latestNextAction?.action);
    const reason = asString(latestNextAction?.reason);
    if (!path || !action || !reason) continue;
    const files = stringList(args.files);
    if (files.length > 0 && !files.includes(path)) continue;
    const lastSuccessfulWriteIndex = eventsAfterVerifier
      .slice(0, index + 1)
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate }) => candidate.status === "success" && targetFileWritten(candidate, [path]))
      .map(({ candidateIndex }) => candidateIndex)
      .pop() ?? -1;
    const eventsAfterLastWrite = eventsAfterVerifier.slice(lastSuccessfulWriteIndex + 1);
    const failureIndexes = eventsAfterLastWrite.flatMap((candidate, candidateIndex) => {
      const nextAction = eventNonNoopNextAction(candidate);
      const touchesPath = eventTouchesAnyFile(candidate, [path])
        || inputTouchesFiles(candidate.tool_name, candidate.tool_input, [path], args.workspaceDir);
      return candidate.status === "failed"
        && touchesPath
        && asString(nextAction?.path) === path
        && asString(nextAction?.action) === action
        && asString(nextAction?.reason) === reason
        ? [candidateIndex]
        : [];
    });
    if (failureIndexes.length < 3) continue;
    const anchorReadIndexes = eventsAfterLastWrite.flatMap((candidate, candidateIndex) => (
      candidate.status === "success"
      && candidate.tool_name === "read_file"
      && eventTouchesAnyFile(candidate, [path])
        ? [candidateIndex]
        : []
    ));
    const firstAnchorReadIndex = anchorReadIndexes[0] ?? -1;
    const noOpAfterAnchorRead = firstAnchorReadIndex >= 0 && failureIndexes.some((failureIndex) => failureIndex > firstAnchorReadIndex);
    if (!noOpAfterAnchorRead) continue;
    if (!latestNextAction) continue;
    const startLine = numeric(latestNextAction.start_line);
    const endLine = numeric(latestNextAction.end_line);
    return {
      summary_version: "non_noop_repair_stagnation_v1",
      required: true,
      reason: "repeated_non_noop_repair_after_current_anchor_read",
      path,
      action,
      source_reason: reason,
      failed_repair_count: failureIndexes.length,
      current_anchor_read_count: anchorReadIndexes.length,
      latest_failed_repair_step: event.step_index,
      latest_failed_verifier_step: args.priorEvents[latestVerifierIndex]?.step_index ?? null,
      start_line: startLine > 0 ? startLine : null,
      end_line: endLine > 0 ? endLine : null,
      instruction:
        `Runtime observed ${failureIndexes.length} repeated ${action} no-op repair failure(s) on ${path} after a current-anchor read. Stop retrying the same line replacement; switch to a coherent source-workflow repair driven by the latest verifier contract.`,
    };
  }
  return null;
}

function readEventCoversNonNoopAnchor(event: ToolEvent, anchorRead: JsonObject): boolean {
  const path = asString(anchorRead.path);
  if (!path || event.status !== "success" || event.tool_name !== "read_file" || !eventTouchesAnyFile(event, [path])) {
    return false;
  }
  const requiredStart = numeric(anchorRead.start_line);
  const requiredEnd = numeric(anchorRead.end_line);
  if (requiredStart <= 0 || requiredEnd <= 0) return true;
  const output = asObject(event.output_signature) ?? {};
  const requestedStart = numeric(output.start_line ?? event.tool_input.start_line);
  const requestedEnd = numeric(output.end_line ?? event.tool_input.end_line);
  return requestedStart > 0 && requestedEnd > 0 && requestedStart <= requiredStart && requestedEnd >= requiredEnd;
}

function pendingRepeatedNonNoopAnchorRead(priorEvents: ToolEvent[]): JsonObject | null {
  for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
    const event = priorEvents[index];
    const nextAction = eventNonNoopNextAction(event);
    if (!nextAction) continue;
    const path = asString(nextAction.path);
    const action = asString(nextAction.action);
    const reason = asString(nextAction.reason);
    if (!path || !action || !reason) continue;
    const laterEvents = priorEvents.slice(index + 1);
    if (laterEvents.some((laterEvent) => laterEvent.status === "success" && targetFileWritten(laterEvent, [path]))) return null;
    const startLine = numeric(nextAction.start_line) || 1;
    const actualOldLines = requiredStringArrayOrNull(nextAction.actual_old_lines)?.slice(0, 20) ?? [];
    const endLine = numeric(nextAction.end_line)
      || (actualOldLines.length > 0 ? startLine + actualOldLines.length - 1 : startLine + 40);
    const anchorRead = {
      reason: "non_noop_current_anchor_required",
      source_reason: reason,
      source_failed_step: event.step_index,
      source_failed_tool: event.tool_name,
      action: "read_file",
      path,
      allowed_files: [path],
      start_line: startLine,
      end_line: endLine,
      actual_old_lines: actualOldLines,
      source_non_noop_action: action,
      instruction:
        `The same non-noop repair kept failing without a successful write. Read the current anchor exactly before another ${action} on ${path}.`,
    };
    if (laterEvents.some((laterEvent) => readEventCoversNonNoopAnchor(laterEvent, anchorRead))) return null;
    const lastSuccessIndex = priorEvents
      .slice(0, index + 1)
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate }) => candidate.status === "success" && targetFileWritten(candidate, [path]))
      .map(({ candidateIndex }) => candidateIndex)
      .pop() ?? -1;
    const sameNonNoopFailureCount = priorEvents.slice(lastSuccessIndex + 1).filter((candidate) => {
      const candidateNext = eventNonNoopNextAction(candidate);
      return candidate.status === "failed"
        && asString(candidateNext?.path) === path
        && asString(candidateNext?.action) === action
        && asString(candidateNext?.reason) === reason;
    }).length;
    if (sameNonNoopFailureCount >= 2) {
      return {
        ...anchorRead,
        same_non_noop_failure_count: sameNonNoopFailureCount,
      };
    }
    return null;
  }
  return null;
}

function nonNoopRepairPayloadViolation(action: string, input: JsonObject, nextAction: JsonObject): string | null {
  const expectedAction = asString(nextAction.action);
  const path = asString(nextAction.path);
  if (!expectedAction || !path) return null;
  if (action !== expectedAction || asString(input.path) !== path) {
    return `Runtime edit operation non-noop repair requires ${expectedAction} on ${path}; do not read, run commands, finish, or switch files before changing the rejected no-op span.`;
  }
  if (action !== "replace_lines") return null;
  const maxExpectedOldLines = numeric(nextAction.max_expected_old_lines) || 8;
  const maxReplacementLines = numeric(nextAction.max_replacement_lines) || 16;
  const expectedOldLineCount = replaceLinesExpectedOldLineCount(input);
  const requestedRangeLineCount = replaceLinesRequestedRangeLineCount(input);
  const replacementLineCount = replaceLinesReplacementLineCount(input);
  if (
    expectedOldLineCount > maxExpectedOldLines
    || requestedRangeLineCount > maxExpectedOldLines
    || replacementLineCount > maxReplacementLines
  ) {
    return `Runtime edit operation non-noop repair rejected oversized replace_lines payload. Use one narrow contiguous span with at most ${maxExpectedOldLines} expected_old_lines/requested range lines and at most ${maxReplacementLines} replacement_lines; do not use a whole read range, whole function, or whole method body.`;
  }
  return null;
}

function pendingAnchorReadSuppressedByVerifierLock(args: {
  pendingAnchorRead: JsonObject | null;
  lock: JsonObject | null;
  workspaceDir: string;
}): boolean {
  if (!args.pendingAnchorRead || !args.lock) return false;
  if (args.lock.locked_repair_read_budget_exhausted !== true) return false;
  const lockFiles = stringList(args.lock.files);
  if (lockFiles.length === 0) return false;
  return inputTouchesFiles(
    "read_file",
    { path: asString(args.pendingAnchorRead.path) ?? "" },
    lockFiles,
    args.workspaceDir,
  );
}

function sequencePolicyNextAction(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[], workspaceDir: string): JsonObject | null {
  const satisfied = satisfiedOrderedActionCount(policy, priorEvents);
  if (satisfied < policy.orderedActions.length) {
    const expected = policy.orderedActions[satisfied];
    const continuationReadFiles = completedOrderedActionReadFiles(policy, satisfied);
    return {
      reason: "ordered_action_required",
      ordered_action_index: satisfied + 1,
      action: asString(expected.action),
      path: asString(expected.file_path),
      continuation_read_files: continuationReadFiles,
      instruction: [
        `Run ordered action ${satisfied + 1}: ${expectedActionDescription(expected)}.`,
        continuationReadFiles.length > 0
          ? `Narrow read_file continuations are allowed only on already-read ordered files: ${continuationReadFiles.join(", ")}.`
          : null,
      ].filter(Boolean).join(" "),
    };
  }
  const pendingAnchorRead = pendingEditOperationAnchorRead(priorEvents);
  if (pendingAnchorRead) {
    const lockForPendingAnchorRead = latestFailedVerifierLock(policy, priorEvents, workspaceDir);
    if (!pendingAnchorReadSuppressedByVerifierLock({
      pendingAnchorRead,
      lock: lockForPendingAnchorRead,
      workspaceDir,
    })) {
      return pendingAnchorRead;
    }
  }
  if (policy.repairFirstWriteFiles.length > 0 && !hasRepairFileWrite(policy, priorEvents)) {
    const readableBeforeWrite = policy.repairPreWriteReadFiles.length > 0
      ? policy.repairPreWriteReadFiles
      : policy.repairFirstWriteFiles;
    const anchorEscalation = repairWriteAnchorEscalation({
      policy,
      priorEvents,
      files: policy.repairFirstWriteFiles,
      phase: "first",
    });
    if (anchorEscalation) {
      return {
        reason: "repair_first_write_required",
        allowed_files: policy.repairFirstWriteFiles,
        allowed_write_actions: stringList(anchorEscalation.allowed_write_actions),
        allowed_narrow_read_actions: ["read_file"],
        allowed_read_files_before_first_write: readableBeforeWrite,
        semantic_candidate_trial: asObject(policy.semanticCandidateTrial),
        repair_write_anchor_escalation_v1: anchorEscalation,
        instruction: asString(anchorEscalation.instruction) ?? "",
      };
    }
  }
  if (policy.repairSecondWriteFiles.length > 0 && !hasRepairSecondFileWrite(policy, priorEvents)) {
    const readableBeforeWrite = policy.repairSecondWriteReadFiles.length > 0
      ? policy.repairSecondWriteReadFiles
      : policy.repairSecondWriteFiles;
    const packageDependencyMigration = packageDependencyMigrationTemplate({
      requirements: policy.packageDependencyRequirements,
      workspaceDir,
    });
    const anchorEscalation = repairWriteAnchorEscalation({
      policy,
      priorEvents,
      files: policy.repairSecondWriteFiles,
      phase: "second",
    });
    if (anchorEscalation) {
      return {
        reason: "repair_second_write_required",
        allowed_files: policy.repairSecondWriteFiles,
        allowed_write_actions: packageDependencyMigration
          ? [asString(packageDependencyMigration.action) ?? "replace_lines"]
          : stringList(anchorEscalation.allowed_write_actions),
        allowed_narrow_read_actions: ["read_file"],
        allowed_read_files_before_second_write: readableBeforeWrite,
        semantic_candidate_trial: asObject(policy.semanticSecondCandidateTrial),
        package_dependency_migration_template_v1: packageDependencyMigration,
        repair_write_anchor_escalation_v1: anchorEscalation,
        instruction: packageDependencyMigration
          ? asString(packageDependencyMigration.instruction) ?? ""
          : asString(anchorEscalation.instruction) ?? "",
      };
    }
  }
  if (requiredVerifierDue(policy, priorEvents)) {
    return {
      reason: "required_verifier_due",
      action: "run_command",
      commands: policy.requiredVerifiers,
      successful_writes_since_last_verifier: successfulWritesSinceLastRequiredVerifier(policy, priorEvents),
      max_successful_writes_before_verifier: policy.maxSuccessfulWritesBeforeVerifier,
      instruction: `Run a required verifier before more edits: ${policy.requiredVerifiers.join(" | ")}.`,
    };
  }
  const nonNoopStagnation = repeatedNonNoopRepairStagnation({ policy, priorEvents, workspaceDir });
  if (!nonNoopStagnation) {
    const pendingNonNoopAnchorRead = pendingRepeatedNonNoopAnchorRead(priorEvents);
    if (pendingNonNoopAnchorRead) return pendingNonNoopAnchorRead;
  }
  if (policy.repairFirstWriteFiles.length > 0 && !hasRepairFileWrite(policy, priorEvents)) {
    const readableBeforeWrite = policy.repairPreWriteReadFiles.length > 0
      ? policy.repairPreWriteReadFiles
      : policy.repairFirstWriteFiles;
    const narrowReadCount = narrowReadsBeforeRepairWriteCount(policy, priorEvents);
    const scopedSearchCount = scopedSearchesBeforeRepairWriteCount(policy, priorEvents);
    const semanticCandidateTrial = asObject(policy.semanticCandidateTrial);
    const anchorEscalation = repairWriteAnchorEscalation({
      policy,
      priorEvents,
      files: policy.repairFirstWriteFiles,
      phase: "first",
    });
    return {
      reason: "repair_first_write_required",
      allowed_files: policy.repairFirstWriteFiles,
      allowed_write_actions: stringList(anchorEscalation?.allowed_write_actions).length > 0
        ? stringList(anchorEscalation?.allowed_write_actions)
        : ["replace_text", "replace_lines", "apply_patch", "run_command"],
      allowed_narrow_read_actions: ["read_file"],
      allowed_scoped_search_actions: ["search"],
      allowed_read_files_before_first_write: readableBeforeWrite,
      max_narrow_reads_before_first_repair_write: policy.maxNarrowReadsBeforeFirstRepairWrite,
      narrow_reads_used_before_first_repair_write: narrowReadCount,
      max_scoped_searches_before_first_repair_write: policy.maxScopedSearchesBeforeFirstRepairWrite,
      scoped_searches_used_before_first_repair_write: scopedSearchCount,
      semantic_candidate_trial: semanticCandidateTrial,
      repair_write_anchor_escalation_v1: anchorEscalation,
      instruction: [
        `Write one repair file before broad discovery; before that write, read_file and file-scoped search are allowed only for anchor files: ${readableBeforeWrite.join(", ")}.`,
        asString(anchorEscalation?.instruction),
        semanticCandidateTrial
          ? `Candidate trial is active; apply suggested_actions only after current file content confirms the candidate anchor and the write can connect imports/helpers to a verifier-exercised call path on ${stringList(semanticCandidateTrial.target_files).join(", ")}.`
          : null,
        typeof policy.maxNarrowReadsBeforeFirstRepairWrite === "number"
          ? `You have used ${narrowReadCount}/${policy.maxNarrowReadsBeforeFirstRepairWrite} allowed narrow reads before the first repair write.`
          : null,
        typeof policy.maxScopedSearchesBeforeFirstRepairWrite === "number"
          ? `You have used ${scopedSearchCount}/${policy.maxScopedSearchesBeforeFirstRepairWrite} allowed file-scoped searches before the first repair write.`
          : null,
      ].filter(Boolean).join(" "),
    };
  }
  if (policy.repairSecondWriteFiles.length > 0 && !hasRepairSecondFileWrite(policy, priorEvents)) {
    const noOpConfirmation = repairSecondWriteNoOpConfirmation(policy, priorEvents);
    if (noOpConfirmation) {
      return {
        reason: "repair_second_write_noop_confirmed_verifier_required",
        action: "run_command",
        commands: policy.requiredVerifiers,
        repair_second_write_noop_confirmation_v1: noOpConfirmation,
        instruction:
          `Repeated no-op edits on the coupled second-write target mean Runtime needs a fresh verifier result instead of more empty edits. Run a required verifier now: ${policy.requiredVerifiers.join(" | ")}.`,
      };
    }
    const readableBeforeWrite = policy.repairSecondWriteReadFiles.length > 0
      ? policy.repairSecondWriteReadFiles
      : policy.repairSecondWriteFiles;
    const narrowReadCount = narrowReadsBeforeSecondRepairWriteCount(policy, priorEvents);
    const scopedSearchCount = scopedSearchesBeforeSecondRepairWriteCount(policy, priorEvents);
    const semanticCandidateTrial = asObject(policy.semanticSecondCandidateTrial);
    const packageDependencyMigration = packageDependencyMigrationTemplate({
      requirements: policy.packageDependencyRequirements,
      workspaceDir,
    });
    const anchorEscalation = repairWriteAnchorEscalation({
      policy,
      priorEvents,
      files: policy.repairSecondWriteFiles,
      phase: "second",
    });
    return {
      reason: "repair_second_write_required",
      allowed_files: policy.repairSecondWriteFiles,
      allowed_write_actions: packageDependencyMigration
        ? [asString(packageDependencyMigration.action) ?? "replace_lines"]
        : stringList(anchorEscalation?.allowed_write_actions).length > 0
        ? stringList(anchorEscalation?.allowed_write_actions)
        : ["replace_text", "replace_lines", "apply_patch", "run_command"],
      allowed_narrow_read_actions: ["read_file"],
      allowed_scoped_search_actions: ["search"],
      allowed_read_files_before_second_write: readableBeforeWrite,
      max_narrow_reads_before_second_repair_write: policy.maxNarrowReadsBeforeSecondRepairWrite,
      narrow_reads_used_before_second_repair_write: narrowReadCount,
      max_scoped_searches_before_second_repair_write: policy.maxScopedSearchesBeforeSecondRepairWrite,
      scoped_searches_used_before_second_repair_write: scopedSearchCount,
      semantic_candidate_trial: semanticCandidateTrial,
      package_dependency_requirements_v1: policy.packageDependencyRequirements.length > 0 ? policy.packageDependencyRequirements : null,
      package_dependency_migration_template_v1: packageDependencyMigration,
      repair_write_anchor_escalation_v1: anchorEscalation,
      instruction: [
        `After the primary source repair write, the next repair write must target a coupled file before search/list/run_command or another source rewrite: ${policy.repairSecondWriteFiles.join(", ")}.`,
        asString(packageDependencyMigration?.instruction),
        asString(anchorEscalation?.instruction),
        policy.packageDependencyRequirements.length > 0
          ? `Package dependency requirement(s): ${policy.packageDependencyRequirements.map((entry) => `${asString(entry.dependency)}=${asString(entry.version)} in ${asString(entry.target_section) ?? "dependencies"}`).join(", ")}.`
          : null,
        semanticCandidateTrial
          ? `Candidate trial is active; apply suggested_actions only after current file content confirms the candidate anchor and the write can satisfy the coupled file contract on ${stringList(semanticCandidateTrial.target_files).join(", ")}.`
          : null,
        readableBeforeWrite.length > 0
          ? `Before that second write, read_file and file-scoped search are allowed only on coupled files: ${readableBeforeWrite.join(", ")}.`
          : null,
        typeof policy.maxNarrowReadsBeforeSecondRepairWrite === "number"
          ? `You have used ${narrowReadCount}/${policy.maxNarrowReadsBeforeSecondRepairWrite} allowed narrow reads before the second repair write.`
          : null,
        typeof policy.maxScopedSearchesBeforeSecondRepairWrite === "number"
          ? `You have used ${scopedSearchCount}/${policy.maxScopedSearchesBeforeSecondRepairWrite} allowed file-scoped searches before the second repair write.`
          : null,
      ].filter(Boolean).join(" "),
    };
  }
  const latestFailureLock = latestFailedVerifierLock(policy, priorEvents, workspaceDir);
  const lineDiagnosticRepair = asObject(latestFailureLock?.line_diagnostic_repair_v1);
  if (
    latestFailureLock
    && (
      lineDiagnosticRepair?.required === true
      || latestFailureLock.locked_repair_read_budget_exhausted === true
    )
  ) {
    return lockedRepairAnchorRefreshNextAction(latestFailureLock) ?? latestFailureLock;
  }
  const counterfactualProbe = cognitiveEntropyCounterfactualProbeNextAction({
    policy,
    priorEvents,
    lock: latestFailureLock,
    workspaceDir,
  });
  if (counterfactualProbe) return counterfactualProbe;
  const lockedRepairVerifierDue = lockedRepairVerifierDueNextAction(policy, latestFailureLock);
  if (lockedRepairVerifierDue) return lockedRepairVerifierDue;
  if (latestFailureLock) return lockedRepairAnchorRefreshNextAction(latestFailureLock) ?? latestFailureLock;
  return null;
}

function assertSequenceAllowed(args: {
  policy?: RuntimeSequencePolicy | null;
  priorEvents: ToolEvent[];
  action: string;
  input: JsonObject;
  workspaceDir: string;
}): void {
  const policy = args.policy;
  if (!policy) return;
  const satisfied = satisfiedOrderedActionCount(policy, args.priorEvents);
  if (satisfied < policy.orderedActions.length) {
    const expected = policy.orderedActions[satisfied];
    const continuationReadFiles = completedOrderedActionReadFiles(policy, satisfied);
    if (
      args.action === "read_file"
      && continuationReadFiles.length > 0
      && inputTouchesFiles(args.action, args.input, continuationReadFiles, args.workspaceDir)
    ) {
      return;
    }
    if (!eventMatchesOrderedAction({
      step_index: args.priorEvents.length + 1,
      tool_name: args.action,
      tool_input: args.input,
      status: "success",
      output_signature: {},
      touched_files: [],
      write_files: [],
      started_at_ms: 0,
      ended_at_ms: 0,
    }, expected)) {
      throw new Error(
        `Runtime first_action_sequence blocked out-of-order tool. Expected ordered action ${satisfied + 1}: ${expectedActionDescription(expected)}.`,
      );
    }
    return;
  }
  if (policy.repairFirstWriteFiles.length > 0 && !hasRepairFileWrite(policy, args.priorEvents)) {
    const pendingAnchorRead = pendingEditOperationAnchorRead(args.priorEvents);
    if (pendingAnchorRead) {
      if (
        args.action === "read_file"
        && inputTouchesFiles(args.action, args.input, stringList(pendingAnchorRead.allowed_files), args.workspaceDir)
      ) {
        return;
      }
      throw new Error(
        `Runtime edit operation requires current-anchor read before another repair write. Read ${asString(pendingAnchorRead.path) ?? stringList(pendingAnchorRead.allowed_files).join(", ")} before retrying the write.`,
      );
    }
    const anchorEscalation = repairWriteAnchorEscalation({
      policy,
      priorEvents: args.priorEvents,
      files: policy.repairFirstWriteFiles,
      phase: "first",
    });
    if (anchorEscalation) {
      const allowedWriteActions = stringList(anchorEscalation.allowed_write_actions);
      if (
        allowedWriteActions.includes(args.action)
        && inputTouchesFiles(args.action, args.input, policy.repairFirstWriteFiles, args.workspaceDir)
      ) {
        return;
      }
      throw new Error(
        `Runtime repair anchor escalation blocked stale-anchor loop before first repair write. Use ${allowedWriteActions.join(" or ")} on: ${policy.repairFirstWriteFiles.join(", ")}`,
      );
    }
    const readableBeforeWrite = policy.repairPreWriteReadFiles.length > 0
      ? policy.repairPreWriteReadFiles
      : policy.repairFirstWriteFiles;
    const narrowReadCount = narrowReadsBeforeRepairWriteCount(policy, args.priorEvents);
    const scopedSearchCount = scopedSearchesBeforeRepairWriteCount(policy, args.priorEvents);
    if (isWriteToolAction(args.action) && inputTouchesFiles(args.action, args.input, policy.repairFirstWriteFiles, args.workspaceDir)) return;
    if (args.action === "read_file" && inputTouchesFiles(args.action, args.input, readableBeforeWrite, args.workspaceDir)) {
      if (
        typeof policy.maxNarrowReadsBeforeFirstRepairWrite !== "number"
        || narrowReadCount < policy.maxNarrowReadsBeforeFirstRepairWrite
      ) {
        return;
      }
      throw new Error(
        `Runtime first_action_sequence blocked extra narrow read before first repair-file write. Used ${narrowReadCount}/${policy.maxNarrowReadsBeforeFirstRepairWrite} allowed reads; write one of: ${policy.repairFirstWriteFiles.join(", ")}`,
      );
    }
    if (args.action === "search" && searchScopedToFiles(args.input, readableBeforeWrite)) {
      if (
        typeof policy.maxScopedSearchesBeforeFirstRepairWrite !== "number"
        || scopedSearchCount < policy.maxScopedSearchesBeforeFirstRepairWrite
      ) {
        return;
      }
      throw new Error(
        `Runtime first_action_sequence blocked extra file-scoped search before first repair-file write. Used ${scopedSearchCount}/${policy.maxScopedSearchesBeforeFirstRepairWrite} allowed searches; write one of: ${policy.repairFirstWriteFiles.join(", ")}`,
      );
    }
    if (isWriteToolAction(args.action)) {
      throw new Error(
        `Runtime first_action_sequence blocked first write outside repair_first_write.allowed_files: ${policy.repairFirstWriteFiles.join(", ")}`,
      );
    }
    if (args.action === "list_files" || args.action === "search" || args.action === "read_file") {
      throw new Error(
        `Runtime first_action_sequence blocked read before first repair-file write. Narrow read_file is allowed only for anchor files: ${readableBeforeWrite.join(", ")}`,
      );
    }
  }
  if (policy.repairSecondWriteFiles.length > 0 && !hasRepairSecondFileWrite(policy, args.priorEvents)) {
    const pendingAnchorRead = pendingEditOperationAnchorRead(args.priorEvents);
    if (pendingAnchorRead) {
      if (
        args.action === "read_file"
        && inputTouchesFiles(args.action, args.input, stringList(pendingAnchorRead.allowed_files), args.workspaceDir)
      ) {
        return;
      }
      throw new Error(
        `Runtime edit operation requires current-anchor read before another repair write. Read ${asString(pendingAnchorRead.path) ?? stringList(pendingAnchorRead.allowed_files).join(", ")} before retrying the write.`,
      );
    }
    const anchorEscalation = repairWriteAnchorEscalation({
      policy,
      priorEvents: args.priorEvents,
      files: policy.repairSecondWriteFiles,
      phase: "second",
    });
    if (anchorEscalation) {
      const allowedWriteActions = stringList(anchorEscalation.allowed_write_actions);
      if (
        allowedWriteActions.includes(args.action)
        && inputTouchesFiles(args.action, args.input, policy.repairSecondWriteFiles, args.workspaceDir)
      ) {
        return;
      }
      throw new Error(
        `Runtime repair anchor escalation blocked stale-anchor loop before second repair write. Use ${allowedWriteActions.join(" or ")} on: ${policy.repairSecondWriteFiles.join(", ")}`,
      );
    }
    const noOpConfirmation = repairSecondWriteNoOpConfirmation(policy, args.priorEvents);
    if (
      noOpConfirmation
      && args.action === "run_command"
      && commandMatchesRequiredVerifier(asString(args.input.command) ?? "", policy.requiredVerifiers)
    ) {
      return;
    }
    const readableBeforeWrite = policy.repairSecondWriteReadFiles.length > 0
      ? policy.repairSecondWriteReadFiles
      : policy.repairSecondWriteFiles;
    const narrowReadCount = narrowReadsBeforeSecondRepairWriteCount(policy, args.priorEvents);
    const scopedSearchCount = scopedSearchesBeforeSecondRepairWriteCount(policy, args.priorEvents);
    if (isWriteToolAction(args.action) && inputTouchesFiles(args.action, args.input, policy.repairSecondWriteFiles, args.workspaceDir)) {
      const packageViolation = packageDependencyRequirementWriteViolation({
        requirements: policy.packageDependencyRequirements,
        action: args.action,
        input: args.input,
        workspaceDir: args.workspaceDir,
      });
      if (packageViolation) throw new Error(packageViolation);
      return;
    }
    if (args.action === "read_file" && inputTouchesFiles(args.action, args.input, readableBeforeWrite, args.workspaceDir)) {
      if (
        typeof policy.maxNarrowReadsBeforeSecondRepairWrite !== "number"
        || narrowReadCount < policy.maxNarrowReadsBeforeSecondRepairWrite
      ) {
        return;
      }
      throw new Error(
        `Runtime first_action_sequence blocked extra narrow read before second coupled repair-file write. Used ${narrowReadCount}/${policy.maxNarrowReadsBeforeSecondRepairWrite} allowed reads; write one of: ${policy.repairSecondWriteFiles.join(", ")}`,
      );
    }
    if (args.action === "search" && searchScopedToFiles(args.input, readableBeforeWrite)) {
      if (
        typeof policy.maxScopedSearchesBeforeSecondRepairWrite !== "number"
        || scopedSearchCount < policy.maxScopedSearchesBeforeSecondRepairWrite
      ) {
        return;
      }
      throw new Error(
        `Runtime first_action_sequence blocked extra file-scoped search before second coupled repair-file write. Used ${scopedSearchCount}/${policy.maxScopedSearchesBeforeSecondRepairWrite} allowed searches; write one of: ${policy.repairSecondWriteFiles.join(", ")}`,
      );
    }
    if (isWriteToolAction(args.action)) {
      throw new Error(
        `Runtime first_action_sequence blocked second write outside repair_second_write.allowed_files: ${policy.repairSecondWriteFiles.join(", ")}`,
      );
    }
    if (args.action === "list_files" || args.action === "search" || args.action === "read_file") {
      throw new Error(
        `Runtime first_action_sequence blocked broad action before second coupled repair write. Narrow read_file is allowed only for coupled files: ${readableBeforeWrite.join(", ")}`,
      );
    }
  }
  if (requiredVerifierDue(policy, args.priorEvents)) {
    const command = asString(args.input.command) ?? "";
    if (args.action === "run_command" && commandMatchesRequiredVerifier(command, policy.requiredVerifiers)) return;
    throw new Error(
      `Runtime verification cadence blocked further actions after repair write. Run a required verifier now: ${policy.requiredVerifiers.join(" | ")}`,
    );
  }
  const latestFailureLock = latestFailedVerifierLock(policy, args.priorEvents, args.workspaceDir);
  if (
    latestFailureLock
    && latestFailureLock.locked_repair_read_budget_exhausted === true
    && args.action === "read_file"
    && inputTouchesFiles(args.action, args.input, stringList(latestFailureLock.files), args.workspaceDir)
  ) {
    throw new Error(
      `Runtime verifier failure lock blocked extra read before locked repair write. Used ${numeric(latestFailureLock.narrow_reads_used_before_locked_repair_write)}/${numeric(latestFailureLock.max_narrow_reads_before_locked_repair_write)} allowed reads; write locked files now: ${stringList(latestFailureLock.files).join(", ") || "none"}`,
    );
  }
  const lineDiagnosticRepair = asObject(latestFailureLock?.line_diagnostic_repair_v1);
  if (
    latestFailureLock
    && lineDiagnosticRepair?.required === true
    && (args.action === "search" || args.action === "list_files")
  ) {
    throw new Error(
      `Runtime verifier failure lock requires exact lint/type diagnostic repair before exploration. Repair latest failure file(s): ${stringList(latestFailureLock.files).join(", ") || "none"}`,
    );
  }
  const counterfactualProbe = cognitiveEntropyCounterfactualProbeNextAction({
    policy,
    priorEvents: args.priorEvents,
    lock: latestFailureLock,
    workspaceDir: args.workspaceDir,
  });
  if (counterfactualProbe) {
    const probe = asObject(counterfactualProbe.cognitive_entropy_counterfactual_probe_v1);
    const files = stringList(counterfactualProbe.allowed_read_files);
    if (
      probe
      && cognitiveEntropyProbeActionMatches({
        probe,
        action: args.action,
        input: args.input,
        files,
        workspaceDir: args.workspaceDir,
      })
    ) {
      return;
    }
    if (cognitiveEntropyProbeDiagnosticActionAllowed({
      nextAction: counterfactualProbe,
      action: args.action,
      input: args.input,
      workspaceDir: args.workspaceDir,
    })) {
      return;
    }
    throw new Error(
      `Runtime cognitive entropy probe blocked write, verifier, or broad exploration before a bounded counterfactual probe. Run one read_file or file-scoped search on: ${files.join(", ") || "the listed probe files"}`,
    );
  }
  const lockedRepairVerifierDue = lockedRepairVerifierDueNextAction(policy, latestFailureLock);
  if (lockedRepairVerifierDue) {
    const command = asString(args.input.command) ?? "";
    if (args.action === "run_command" && commandMatchesRequiredVerifier(command, policy.requiredVerifiers)) return;
    throw new Error(
      `Runtime verifier failure lock blocked further actions after a locked repair write. Run a required verifier now: ${policy.requiredVerifiers.join(" | ")}`,
    );
  }
  const pendingAnchorRead = pendingEditOperationAnchorRead(args.priorEvents);
  if (
    pendingAnchorRead
    && args.action === "read_file"
    && inputTouchesFiles(args.action, args.input, stringList(pendingAnchorRead.allowed_files), args.workspaceDir)
  ) {
    return;
  }
  if (pendingAnchorRead) {
    throw new Error(
      `Runtime edit operation requires current-anchor read before another write. Read ${asString(pendingAnchorRead.path) ?? stringList(pendingAnchorRead.allowed_files).join(", ")} before retrying the edit.`,
    );
  }
  const nonNoopStagnation = repeatedNonNoopRepairStagnation({
    policy,
    priorEvents: args.priorEvents,
    workspaceDir: args.workspaceDir,
  });
  if (!nonNoopStagnation) {
    const pendingNonNoopAnchorRead = pendingRepeatedNonNoopAnchorRead(args.priorEvents);
    if (pendingNonNoopAnchorRead) {
      if (
        args.action === "read_file"
        && readActionMatchesLockedAnchorRefresh(args.action, args.input, pendingNonNoopAnchorRead)
      ) {
        return;
      }
      throw new Error(
        `Runtime edit operation non-noop repair requires current-anchor refresh before another write. Read exactly ${asString(pendingNonNoopAnchorRead.path)}:${numeric(pendingNonNoopAnchorRead.start_line)}-${numeric(pendingNonNoopAnchorRead.end_line)}.`,
      );
    }
    const pendingNonNoopRepair = pendingEditOperationNonNoopRepair(args.priorEvents);
    if (pendingNonNoopRepair) {
      const violation = nonNoopRepairPayloadViolation(args.action, args.input, pendingNonNoopRepair);
      if (violation) throw new Error(violation);
      return;
    }
  }
  if (requiredVerifierDue(policy, args.priorEvents)) {
    const command = asString(args.input.command) ?? "";
    if (args.action === "run_command" && commandMatchesRequiredVerifier(command, policy.requiredVerifiers)) return;
    throw new Error(
      `Runtime verification cadence blocked further actions until a required verifier runs: ${policy.requiredVerifiers.join(" | ")}`,
    );
  }
  const lockedRepairAnchorRefresh = lockedRepairAnchorRefreshNextAction(latestFailureLock);
  if (lockedRepairAnchorRefresh) {
    if (readActionMatchesLockedAnchorRefresh(args.action, args.input, lockedRepairAnchorRefresh)) return;
    throw new Error(
      `Runtime verifier failure lock requires current-anchor refresh before another locked repair write. Read exactly ${asString(lockedRepairAnchorRefresh.path)}:${numeric(lockedRepairAnchorRefresh.start_line)}-${numeric(lockedRepairAnchorRefresh.end_line)}.`,
    );
  }
  if (latestFailureLock && !actionAllowedByVerifierFailureLock({
    policy,
    lock: latestFailureLock,
    action: args.action,
    input: args.input,
    workspaceDir: args.workspaceDir,
  })) {
    const formatterCommands = stringList(latestFailureLock.formatter_commands);
    const repeatedFailureConvergence = asObject(latestFailureLock.repeated_failure_convergence_v1);
    const lineDiagnosticRepair = asObject(latestFailureLock.line_diagnostic_repair_v1);
    const editPhaseBudget = asObject(latestFailureLock.edit_phase_failure_budget_v1);
    const preferredLockedRepairAction = asString(latestFailureLock.preferred_locked_repair_action);
    throw new Error(
      latestFailureLock.formatter_required === true && formatterCommands.length > 0
        ? `Runtime verifier failure lock requires formatter command after formatter-only verifier failure: ${formatterCommands.join(" | ")}`
        : lineDiagnosticRepair?.required === true
          ? `Runtime verifier failure lock requires exact lint/type diagnostic repair on latest failure files: ${stringList(latestFailureLock.files).join(", ") || "none"}`
        : editPhaseBudget?.required === true
          ? asString(editPhaseBudget.instruction) ?? `Runtime edit phase budget blocked repeated failed write action on latest failure files: ${stringList(latestFailureLock.files).join(", ") || "none"}`
        : repeatedFailureConvergence?.required === true
          ? `Runtime verifier failure lock requires function-level repair after repeated hidden-contract verifier failure. Use read_file plus replace_lines/apply_patch on latest failure files: ${stringList(latestFailureLock.files).join(", ") || "none"}`
        : preferredLockedRepairAction
          ? `Runtime verifier failure lock requires ${preferredLockedRepairAction} after repeated edit anchor failures on latest failure files: ${stringList(latestFailureLock.files).join(", ") || "none"}`
        : `Runtime verifier failure lock blocked broad action after failed verifier. Repair only latest failure files: ${stringList(latestFailureLock.files).join(", ") || "none"}`,
      );
  }
  const payloadViolation = latestFailureLock
    ? verifierFailureLockPayloadViolation({
        lock: latestFailureLock,
        action: args.action,
        input: args.input,
        workspaceDir: args.workspaceDir,
      })
    : null;
  if (payloadViolation) throw new Error(payloadViolation);
}

async function executeTool(args: {
  action: string;
  input: JsonObject;
  workspaceDir: string;
  stepIndex: number;
  writePolicy?: RuntimeWritePolicy | null;
  sequencePolicy?: RuntimeSequencePolicy | null;
  priorEvents?: ToolEvent[];
}): Promise<ToolEvent> {
  const started = Date.now();
  const input = args.input;
  let status: ToolEvent["status"] = "success";
  let output: JsonObject;
  let touchedFiles: string[] = [];
  let writeFiles: string[] = [];

  try {
    assertSequenceAllowed({
      policy: args.sequencePolicy,
      priorEvents: args.priorEvents ?? [],
      action: args.action,
      input,
      workspaceDir: args.workspaceDir,
    });
    if (args.action === "list_files") {
      const command = "rg --files";
      const result = await runCommand(command, args.workspaceDir, 10000);
      status = result.exit_code === 0 ? "success" : "failed";
      output = { command, result };
    } else if (args.action === "read_file") {
      const requestedPath = requireString(asString(input.path) ?? undefined, "read_file.input.path");
      const startLine = typeof input.start_line === "number" ? Math.max(1, Math.floor(input.start_line)) : 1;
      const endLine = typeof input.end_line === "number" ? Math.max(startLine, Math.floor(input.end_line)) : startLine + 220;
      const { file, rel } = resolveWorkspaceFile(args.workspaceDir, requestedPath);
      const lines = (await fsp.readFile(file, "utf8")).split(/\r?\n/);
      touchedFiles = [rel];
      output = {
        path: rel,
        start_line: startLine,
        end_line: Math.min(endLine, lines.length),
        content: truncate(lines.slice(startLine - 1, endLine).join("\n")),
      };
    } else if (args.action === "search") {
      const query = requireString(asString(input.query) ?? undefined, "search.input.query");
      const glob = asString(input.glob);
      const command = glob ? `rg -n --glob ${JSON.stringify(glob)} ${JSON.stringify(query)}` : `rg -n ${JSON.stringify(query)}`;
      const result = await runCommand(command, args.workspaceDir, 10000);
      status = result.exit_code === 0 || result.exit_code === 1 ? "success" : "failed";
      output = { command, result };
    } else if (args.action === "run_command") {
      const command = requireString(asString(input.command) ?? undefined, "run_command.input.command");
      const timeoutMs = typeof input.timeout_ms === "number" ? Math.max(1000, Math.floor(input.timeout_ms)) : 30000;
      if (!commandAllowed(command)) throw new Error(`Command is not allowed by this real-eval runner: ${command}`);
      assertCommandAllowedByWritePolicy(command, args.workspaceDir, args.writePolicy);
      const requiredVerifierCommand = args.sequencePolicy
        ? commandMatchesRequiredVerifier(command, args.sequencePolicy.requiredVerifiers)
        : false;
      const beforeSnapshot = await snapshotWorkspaceFiles(args.workspaceDir);
      const result = await runCommand(command, args.workspaceDir, timeoutMs);
      const afterSnapshot = await snapshotWorkspaceFiles(args.workspaceDir);
      const changedFiles = changedFilesFromSnapshots(beforeSnapshot, afterSnapshot);
      touchedFiles = requiredVerifierCommand ? [] : changedFiles;
      writeFiles = requiredVerifierCommand ? [] : changedFiles;
      let writePolicyError: string | null = null;
      if (!requiredVerifierCommand) {
        try {
          assertWriteAllowed(args.writePolicy, changedFiles);
        } catch (err) {
          writePolicyError = err instanceof Error ? err.message : String(err);
        }
      }
      status = result.exit_code === 0 && !writePolicyError ? "success" : "failed";
      output = {
        command,
        result,
        detected_write_files: changedFiles,
        ...(requiredVerifierCommand
          ? {
              write_policy_exempt_reason: "required_verifier_artifacts",
              verifier_artifact_write_files: changedFiles,
            }
          : {}),
        ...(writePolicyError ? { write_policy_error: writePolicyError } : {}),
      };
    } else if (args.action === "replace_text") {
      const requestedPath = requireString(asString(input.path) ?? undefined, "replace_text.input.path");
      const find = requireString(asString(input.find) ?? undefined, "replace_text.input.find");
      if (typeof input.replace !== "string") throw new Error("replace_text.input.replace is required");
      const expected = typeof input.expected_replacements === "number"
        ? Math.max(1, Math.floor(input.expected_replacements))
        : 1;
      const { file, rel } = resolveWorkspaceFile(args.workspaceDir, requestedPath);
      assertWriteAllowed(args.writePolicy, [rel]);
      const before = await fsp.readFile(file, "utf8");
      const actual = before.split(find).length - 1;
      if (actual !== expected) {
        throw new Error(`replace_text expected ${expected} replacement(s), found ${actual}`);
      }
      const next = before.split(find).join(input.replace);
      if (next === before) {
        throw new ToolStructuredError("replace_text replacement is a no-op; replacement must change file content", {
          edit_noop: true,
          path: rel,
          replacements: actual,
        });
      }
      await fsp.writeFile(file, next, "utf8");
      touchedFiles = [rel];
      writeFiles = [rel];
      output = { path: rel, replacements: actual };
    } else if (args.action === "replace_lines") {
      const requestedPath = requireString(asString(input.path) ?? undefined, "replace_lines.input.path");
      const startLine = typeof input.start_line === "number" ? Math.floor(input.start_line) : NaN;
      const endLine = typeof input.end_line === "number" ? Math.floor(input.end_line) : NaN;
      const expectedOldLines = requiredStringArray(input.expected_old_lines, "replace_lines.input.expected_old_lines");
      const replacementLines = requiredStringArray(input.replacement_lines, "replace_lines.input.replacement_lines");
      if (!Number.isInteger(startLine) || startLine < 1) throw new Error("replace_lines.input.start_line must be a positive integer");
      if (!Number.isInteger(endLine) || endLine < startLine) throw new Error("replace_lines.input.end_line must be an integer >= start_line");
      if ([...expectedOldLines, ...replacementLines].some((line) => /\r|\n/.test(line))) {
        throw new Error("replace_lines line entries must be complete single lines without newline characters");
      }
      const { file, rel } = resolveWorkspaceFile(args.workspaceDir, requestedPath);
      assertWriteAllowed(args.writePolicy, [rel]);
      const before = await fsp.readFile(file, "utf8");
      const newline = before.includes("\r\n") ? "\r\n" : "\n";
      const hadFinalNewline = /\r?\n$/.test(before);
      const body = hadFinalNewline ? before.replace(/\r?\n$/, "") : before;
      const lines = body.length > 0 ? body.split(/\r?\n/) : [];
      const requestedRangeInBounds = endLine <= lines.length;
      const requestedActualOldLines = requestedRangeInBounds
        ? lines.slice(startLine - 1, endLine)
        : lines.slice(startLine - 1, lines.length);
      const requestedLineCount = endLine - startLine + 1;
      let effectiveStartLine = startLine;
      let effectiveEndLine = endLine;
      let startLineAdjusted = false;
      let endLineAdjusted = false;
      let relocationScope: "requested_range" | "nearby_exact" | "full_file_exact" = "requested_range";
      const requestedRangeMatches = requestedRangeInBounds && stringArraysEqual(requestedActualOldLines, expectedOldLines);
      if (!requestedRangeMatches) {
        const nearbyMatch = findLineSequenceNear({
          lines,
          expectedLines: expectedOldLines,
          requestedStartLine: startLine,
          searchRadius: 12,
        });
        if (nearbyMatch && nearbyMatch.candidateStartLines.length > 1) {
          throw new ToolStructuredError("replace_lines expected_old_lines matched multiple nearby ranges", {
            expected_old_lines_match: false,
            path: rel,
            requested_start_line: startLine,
            requested_end_line: endLine,
            candidate_start_lines: nearbyMatch.candidateStartLines,
            actual_old_lines: requestedActualOldLines,
          });
        }
        if (nearbyMatch) {
          effectiveStartLine = nearbyMatch.startLine;
          effectiveEndLine = nearbyMatch.endLine;
          startLineAdjusted = effectiveStartLine !== startLine;
          endLineAdjusted = effectiveEndLine !== endLine;
          relocationScope = "nearby_exact";
        } else {
          const fullFileMatch = findLineSequenceInFile({
            lines,
            expectedLines: expectedOldLines,
          });
          if (fullFileMatch && fullFileMatch.candidateStartLines.length > 1) {
            throw new ToolStructuredError("replace_lines expected_old_lines matched multiple file ranges", {
              expected_old_lines_match: false,
              path: rel,
              requested_start_line: startLine,
              requested_end_line: endLine,
              candidate_start_lines: fullFileMatch.candidateStartLines,
              actual_old_lines: requestedActualOldLines,
              relocation_scope: "full_file_exact",
            });
          }
          if (fullFileMatch) {
            effectiveStartLine = fullFileMatch.startLine;
            effectiveEndLine = fullFileMatch.endLine;
            startLineAdjusted = effectiveStartLine !== startLine;
            endLineAdjusted = effectiveEndLine !== endLine;
            relocationScope = "full_file_exact";
          } else if (!requestedRangeInBounds) {
            throw new ToolStructuredError(`replace_lines range ${startLine}-${endLine} exceeds ${rel} length ${lines.length}`, {
              expected_old_lines_match: false,
              path: rel,
              requested_start_line: startLine,
              requested_end_line: endLine,
              actual_old_lines: requestedActualOldLines,
            });
          } else if (expectedOldLines.length !== requestedLineCount) {
            const inferredEndLine = startLine + expectedOldLines.length - 1;
            const inferredOldLines = inferredEndLine >= startLine && inferredEndLine <= lines.length
              ? lines.slice(startLine - 1, inferredEndLine)
              : [];
            throw new ToolStructuredError("replace_lines expected_old_lines length did not match requested range", {
              expected_old_lines_match: false,
              path: rel,
              requested_start_line: startLine,
              requested_end_line: endLine,
              inferred_end_line: inferredEndLine,
              actual_old_lines: requestedActualOldLines,
              inferred_actual_old_lines: inferredOldLines,
            });
          } else {
            throw new ToolStructuredError("replace_lines expected_old_lines did not match current file content", {
              expected_old_lines_match: false,
              path: rel,
              requested_start_line: startLine,
              requested_end_line: endLine,
              actual_old_lines: requestedActualOldLines,
            });
          }
        }
      }
      const nextLines = [
        ...lines.slice(0, effectiveStartLine - 1),
        ...replacementLines,
        ...lines.slice(effectiveEndLine),
      ];
      const nextBody = nextLines.join(newline);
      const currentEffectiveLines = lines.slice(effectiveStartLine - 1, effectiveEndLine);
      if (stringArraysEqual(currentEffectiveLines, replacementLines)) {
        throw new ToolStructuredError("replace_lines replacement is a no-op; replacement_lines must change file content", {
          edit_noop: true,
          path: rel,
          requested_start_line: startLine,
          requested_end_line: endLine,
          start_line: effectiveStartLine,
          end_line: effectiveEndLine,
          actual_old_lines: currentEffectiveLines,
        });
      }
      await fsp.writeFile(file, nextBody.length > 0 ? `${nextBody}${hadFinalNewline ? newline : ""}` : "", "utf8");
      touchedFiles = [rel];
      writeFiles = [rel];
      output = {
        path: rel,
        start_line: effectiveStartLine,
        end_line: effectiveEndLine,
        requested_start_line: startLine,
        requested_end_line: endLine,
        start_line_adjusted: startLineAdjusted,
        end_line_adjusted: endLineAdjusted,
        relocation_scope: relocationScope,
        replacement_line_count: replacementLines.length,
      };
    } else if (args.action === "apply_patch") {
      const patch = requireString(asString(input.patch) ?? undefined, "apply_patch.input.patch");
      touchedFiles = touchedFilesFromPatch(patch);
      assertWriteAllowed(args.writePolicy, touchedFiles);
      const result = await applyUnifiedDiff(args.workspaceDir, patch, 30000);
      status = result.exit_code === 0 ? "success" : "failed";
      writeFiles = status === "success" ? touchedFiles : [];
      const applyPatchNextAction = status === "failed"
        ? applyPatchFailureNextAction(input, result)
        : null;
      output = {
        result,
        touched_files: touchedFiles,
        ...(applyPatchNextAction ? { edit_operation_next_action: applyPatchNextAction } : {}),
      };
    } else {
      throw new Error(`Unsupported tool action: ${args.action}`);
    }
  } catch (err) {
    status = "failed";
    const error = err instanceof Error ? err.message : String(err);
    const inputPath = asString(input.path);
    if (touchedFiles.length === 0 && inputPath) {
      touchedFiles = [inputPath];
    }
    const structuredDetails = err instanceof ToolStructuredError ? err.details : {};
    const schemaCorrection = toolSchemaCorrection(args.action, input, error);
    const sequencePolicyError = error.includes("Runtime first_action_sequence") ? error : null;
    const verificationCadenceError = error.includes("Runtime verification cadence") ? error : null;
    const verifierFailureLockError = error.includes("Runtime verifier failure lock") ? error : null;
    const packageDependencyLockError = error.includes("Runtime package dependency lock") ? error : null;
    const cognitiveEntropyProbeError = error.includes("Runtime cognitive entropy probe") ? error : null;
    const sequenceNextAction = (sequencePolicyError || verificationCadenceError || verifierFailureLockError || packageDependencyLockError || cognitiveEntropyProbeError) && args.sequencePolicy
      ? sequencePolicyNextAction(args.sequencePolicy, args.priorEvents ?? [], args.workspaceDir)
      : null;
    const editOperationNextAction = editOperationNextActionFromFailure(args.action, input, structuredDetails, error);
    output = {
      error,
      ...structuredDetails,
      ...(schemaCorrection ? { schema_correction: schemaCorrection } : {}),
      ...(sequencePolicyError ? { sequence_policy_error: sequencePolicyError } : {}),
      ...(verificationCadenceError ? { verification_cadence_error: verificationCadenceError } : {}),
      ...(verifierFailureLockError ? { verifier_failure_lock_error: verifierFailureLockError } : {}),
      ...(packageDependencyLockError ? { package_dependency_lock_error: packageDependencyLockError } : {}),
      ...(cognitiveEntropyProbeError ? { cognitive_entropy_probe_error: cognitiveEntropyProbeError } : {}),
      ...(sequenceNextAction ? { sequence_policy_next_action: sequenceNextAction } : {}),
      ...(editOperationNextAction ? { edit_operation_next_action: editOperationNextAction } : {}),
    };
  }

  const event: ToolEvent = {
    step_index: args.stepIndex,
    tool_name: args.action,
    tool_input: input,
    status,
    output_signature: output,
    touched_files: touchedFiles,
    write_files: writeFiles,
    started_at_ms: started,
    ended_at_ms: Date.now(),
  };
  if (args.sequencePolicy && event.status === "success") {
    const latestFailureLock = latestFailedVerifierLock(args.sequencePolicy, args.priorEvents ?? [], args.workspaceDir);
    const counterfactualProbe = cognitiveEntropyCounterfactualProbeNextAction({
      policy: args.sequencePolicy,
      priorEvents: args.priorEvents ?? [],
      lock: latestFailureLock,
      workspaceDir: args.workspaceDir,
    });
    const probe = asObject(counterfactualProbe?.cognitive_entropy_counterfactual_probe_v1);
    const probeFiles = stringList(counterfactualProbe?.allowed_read_files);
    if (
      probe
      && cognitiveEntropyProbeActionMatches({
        probe,
        action: args.action,
        input,
        files: probeFiles,
        workspaceDir: args.workspaceDir,
      })
    ) {
      event.output_signature = {
        ...event.output_signature,
        runtime_control: "cognitive_entropy_counterfactual_probe",
        cognitive_entropy_counterfactual_probe_v1: {
          ...counterfactualProbe,
          observed_action: args.action,
          observed_files: uniqueStringValues([event.touched_files, event.write_files], 16),
        },
      };
    }
  }
  if (args.sequencePolicy && event.status === "failed" && eventRunsRequiredVerifier(args.sequencePolicy, event)) {
    const verifierFailureLock = latestFailedVerifierLock(
      args.sequencePolicy,
      [...(args.priorEvents ?? []), event],
      args.workspaceDir,
    );
    if (verifierFailureLock) {
      event.output_signature = {
        ...event.output_signature,
        verifier_failure_lock_next_action: verifierFailureLock,
      };
    }
  }
  return event;
}

function buildSystemPrompt(arm: AgentArm): string {
  return `
You are a real coding agent running inside an isolated workspace copy.
You must use tools by returning exactly one JSON object per response.
Protocol is mandatory: the first byte of every response must be "{" and the last byte must be "}".
No markdown. No prose outside JSON. No explanations, no chain-of-thought text, no fenced code, and no prefixed labels.
Do not invent tool results.
Do not submit no-op edits. Any replace_text or replace_lines action must change the current file content and move the latest verifier failure forward.

Allowed actions:
{"action":"list_files","input":{}}
{"action":"read_file","input":{"path":"src/file.ts","start_line":1,"end_line":120}}
{"action":"search","input":{"query":"text or regex","glob":"src/**/*.ts"}}
{"action":"run_command","input":{"command":"npm run -s build","timeout_ms":120000}}
{"action":"replace_text","input":{"path":"src/file.ts","find":"exact old text","replace":"exact new text","expected_replacements":1}}
{"action":"replace_lines","input":{"path":"src/file.ts","start_line":10,"end_line":11,"expected_old_lines":["old line 10 exactly","old line 11 exactly"],"replacement_lines":["new line 10","new line 11"]}}
{"action":"apply_patch","input":{"patch":"unified git diff"}}
{"action":"finish","input":{"status":"success|failed|partial","summary":"what happened","target_files":["src/file.ts"],"acceptance_checks":["command"]}}

Rules:
- Work from observed files and command output only.
- Think internally, then output only the next tool JSON object.
- If the previous tool_result failed or Runtime blocked an action, use the evidence and boundary metadata in that tool_result to choose the next JSON tool call.
- If Runtime blocks an extra read before first repair write, the next valid response must be a write action targeting the listed repair file, not prose and not another read.
- If aionis_runtime_guidance is present, use its first_action_v1, target_files, and operating_rules before broad discovery.
- If aionis_runtime_guidance.first_action_v1 is present, your first response must execute that action before any other action. For action=read_file, call {"action":"read_file","input":{"path": first_action_v1.file_path}}; the tool input key is path, not file_path.
- If aionis_runtime_guidance.first_action_sequence_v1 is present, execute ordered_actions in order before any broad read/search/list/run_command. Narrow read_file continuations on already-read ordered files are allowed only when needed to inspect later line ranges. A search is narrow only when its glob is exactly one allowed anchor/coupled file; otherwise search is broad before the required repair write. If repair_first_write.allowed_files is non-empty, the first successful write after ordered_actions must target one of those files; before that write, narrow read_file and exact-file search are allowed only on repair_first_write.allowed_read_files or the ordered anchor files. If repair_first_write.max_narrow_reads_before_first_repair_write is present, it is a hard limit for reads; after reaching it, use an exact-file search if still available or write the repair file. If repair_second_write.allowed_files is non-empty, after the primary source repair write the next successful repair write must target one of those coupled files before broad search/list/run_command, verifier runs, unrelated reads, or additional source rewrites; only bounded read_file and exact-file search on repair_second_write.allowed_read_files are allowed before that second write. Do not list, run unrelated commands, broad-search, or read unrelated files before the required repair write.
- If aionis_runtime_guidance.edit_boundary_v1 is present, restrict writes to allowed_edit_files when provided, never write forbidden_edit_files, and run required_verifiers before finish.
- If aionis_runtime_guidance.direct_success_replay_evidence_v1 is present, a prior real run passed the verifier. Apply its positive_patch_evidence.patches with apply_patch before inventing a new implementation, unless the current file content proves the patch is stale. If apply_patch fails, inspect only the conflicting patch target and adapt that hunk.
- If the tool stream includes runtime_control_result.control=direct_success_replay, treat that Runtime action as already executed. When it succeeds, run the required verifier exactly before further edits; when it fails, adapt only the reported replay files.
- If aionis_runtime_guidance.verification_repair_v1 is present, repair the listed verifier/tool-schema failures before declaring success, then rerun the failed verifier exactly.
- If aionis_runtime_guidance.edit_failure_phase_v1 is present, treat recommended_focus as evidence focus; do not repeat stale anchors, no-op edits, malformed patches, or unrelated writes.
- If aionis_runtime_guidance.verifier_failure_phase_v1 is present, treat recommended_focus as evidence focus; use primary_files and line_hints before broad exploration unless current evidence proves a different target.
- If aionis_runtime_guidance.cognitive_entropy_engine_v1.counterfactual_probe_v1 is present, treat it as a bounded escape-velocity mechanism for repeated failed verifier/candidate attractors. When Runtime requests cognitive_entropy_counterfactual_probe_v1, do exactly one read_file or file-scoped search on its allowed_read_files, do not write during the probe, summarize the observation internally, then return to scoped repair and the required verifier.
- If aionis_runtime_guidance.candidate_execution_operator_v1 is present, treat it as the active bounded candidate experiment for this attempt: combine compatible candidate target files, perform the primary candidate edit, perform required coupled candidate edits before broad exploration or verifier rerun, then run the required verifier. Candidate execution is still candidate-only; do not promote it without a passing real verifier.
- If aionis_runtime_guidance.candidate_trial_strategy_v1 is present, treat it as the active bounded experiment for this attempt: inspect its target_files, make one smallest non-noop edit that directly tests candidate_trial.suggested_actions, then run the required verifier. It is not a promoted workflow; if current evidence disproves it or the verifier phase changes, stop applying it and reclassify.
- If aionis_runtime_guidance.semantic_repair_candidates_v1 is present, treat it as candidate-only repair guidance: it is not proof of success and not a promoted workflow, but it is the next hypothesis to trial when current file content matches its evidence. Inspect the candidate target files, apply the smallest edit that directly tests suggested_actions before unrelated semantic rewrites, obey the edit boundary, and accept the candidate only when the required verifier passes.
- If aionis_runtime_guidance.direct_prior_failure_evidence_v1 is present, every required_repair_actions item is mandatory. Do not only fix the first lint or source location when direct evidence names missing runtime tests, public types, or type tests.
- If aionis_runtime_guidance.repair_affected_files is non-empty, inspect and repair those files before broad target sweeps. Do not reread every target file up front unless verifier output proves it is needed.
- If no first_action_v1 is present and aionis_runtime_guidance.target_files is non-empty, your first action must be read_file on the first target file. Do not start with list_files or search.
- Prefer direct task progress over broad exploration.
- Use replace_lines for multi-line edits, replace_text for short exact single-span edits, and apply_patch for larger structural edits. For replace_lines, expected_old_lines must exactly match the current file lines you observed most recently; start_line/end_line are used as an anchor and the tool may safely relocate to one unique nearby exact expected_old_lines match.
- run_command is checked against Runtime edit boundaries. Do not use package-manager mutation commands, git apply, node eval file writes, or formatter --fix/--write without explicit allowed file paths.
- Run the task verifier before declaring success. The verifier command already runs from the workspace directory; use it exactly as shown without cd, shell chaining, or redirection.
- This arm is ${arm}; do not assume hidden memory unless the user message includes Aionis context.
`.trim();
}

function taskMessage(task: EvalTask, workspaceDir: string, aionisContext: JsonObject | null, aionisGuidance: JsonObject | null): string {
  const verifierCommand = commandWithRuntimePlaceholders(task.verifier.command, workspaceDir);
  const acceptanceChecks = (task.expected?.acceptance_checks ?? [task.verifier.command])
    .map((command) => commandWithRuntimePlaceholders(command, workspaceDir));
  const payload: JsonObject = {
    task_id: task.id,
    title: task.title ?? task.id,
    task_family: task.task_family ?? null,
    prompt: task.prompt,
    workspace_dir: workspaceDir,
    verifier_command: verifierCommand,
    acceptance_checks: acceptanceChecks,
    aionis_runtime_guidance: aionisGuidance,
    aionis_context: aionisContext,
  };
  return truncate(JSON.stringify(payload, null, 2), LLM_CONTEXT_LIMIT);
}

function finishFromAction(action: JsonObject): {
  status: AgentRun["status"];
  summary: string;
  targetFiles: string[];
} | null {
  if (action.action !== "finish") return null;
  const input = asObject(action.input) ?? {};
  const status = input.status === "success" || input.status === "failed" || input.status === "partial"
    ? input.status
    : "partial";
  return {
    status,
    summary: asString(input.summary) ?? "LLM finished without a summary.",
    targetFiles: stringList(input.target_files),
  };
}

function firstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return null;
}

function uniqueStringValues(values: unknown[], limit = 12): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim().length > 0 && !out.includes(item)) out.push(item);
        if (out.length >= limit) return out;
      }
    } else if (typeof value === "string" && value.trim().length > 0 && !out.includes(value)) {
      out.push(value);
    }
    if (out.length >= limit) return out;
  }
  return out;
}

function recallCandidateContracts(surface: unknown): JsonObject[] {
  const recall = asObject(asObject(surface)?.recall);
  const subgraph = asObject(recall?.subgraph);
  const nodes = Array.isArray(subgraph?.nodes) ? subgraph.nodes : [];
  return nodes
    .map((node) => asObject(node))
    .filter((node): node is JsonObject => !!node)
    .map((node) => {
      const slots = asObject(node.slots);
      const contract = asObject(slots?.execution_contract_v1);
      const summaryKind = asString(slots?.summary_kind);
      if (!contract) return null;
      if (summaryKind !== "workflow_candidate" && summaryKind !== "handoff") return null;
      return contract;
    })
    .filter((contract): contract is JsonObject => !!contract);
}

function runtimeFirstActionFromValue(value: unknown): JsonObject | null {
  const action = asObject(value);
  if (!action) return null;
  const actionKind = asString(action.action);
  if (
    actionKind !== "read_file"
    && actionKind !== "inspect_context"
    && actionKind !== "widen_recall"
    && actionKind !== "rehydrate_payload"
    && actionKind !== "request_operator_review"
  ) {
    return null;
  }
  return {
    summary_version: "kickoff_first_action_v1",
    action: actionKind,
    priority: action.priority === "required" ? "required" : "recommended",
    contract_trust: asString(action.contract_trust),
    tool_name: asString(action.tool_name),
    learned_tool: asString(action.learned_tool),
    file_path: asString(action.file_path),
    target_files: stringList(action.target_files),
    reason: asString(action.reason),
    instruction: asString(action.instruction),
  };
}

function firstRuntimeFirstAction(...values: unknown[]): JsonObject | null {
  for (const value of values) {
    const action = runtimeFirstActionFromValue(value);
    if (action) return action;
  }
  return null;
}

function runtimeEditBoundaryFromValue(value: unknown, workspaceDir: string | null): JsonObject | null {
  const boundary = asObject(value);
  if (!boundary) return null;
  const requiredVerifiers = stringList(boundary.required_verifiers).map((command) => (
    workspaceDir ? commandWithRuntimePlaceholders(command, workspaceDir) : command
  ));
  if (
    stringList(boundary.allowed_edit_files).length === 0
    && stringList(boundary.forbidden_edit_files).length === 0
    && requiredVerifiers.length === 0
    && stringList(boundary.anti_shortcut_rules).length === 0
  ) {
    return null;
  }
  return {
    summary_version: "kickoff_edit_boundary_v1",
    contract_trust: asString(boundary.contract_trust),
    allowed_edit_files: stringList(boundary.allowed_edit_files),
    forbidden_edit_files: stringList(boundary.forbidden_edit_files),
    required_verifiers: requiredVerifiers,
    anti_shortcut_rules: stringList(boundary.anti_shortcut_rules),
    reason: asString(boundary.reason),
    instruction: asString(boundary.instruction),
  };
}

function firstRuntimeEditBoundary(workspaceDir: string | null, ...values: unknown[]): JsonObject | null {
  for (const value of values) {
    const boundary = runtimeEditBoundaryFromValue(value, workspaceDir);
    if (boundary) return boundary;
  }
  return null;
}

function runtimeVerifierFailurePhaseFromValue(value: unknown, workspaceDir: string | null): JsonObject | null {
  const phase = asObject(value);
  if (!phase) return null;
  const phaseName = asString(phase.phase);
  const recommendedFocus = asString(phase.recommended_focus);
  if (!phaseName || !recommendedFocus) return null;
  const lineHints = Array.isArray(phase.line_hints)
    ? phase.line_hints.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => !!entry).map((entry) => ({
        path: asString(entry.path),
        line: typeof entry.line === "number" ? entry.line : null,
        column: typeof entry.column === "number" ? entry.column : null,
        message: asString(entry.message),
      })).filter((entry) => !!entry.path)
    : [];
  return {
    summary_version: "verifier_failure_phase_v1",
    phase: phaseName,
    confidence: typeof phase.confidence === "number" ? phase.confidence : null,
    primary_reason: asString(phase.primary_reason),
    failing_command: workspaceDir && asString(phase.failing_command)
      ? commandWithRuntimePlaceholders(asString(phase.failing_command) as string, workspaceDir)
      : asString(phase.failing_command),
    primary_files: stringList(phase.primary_files),
    line_hints: lineHints,
    allowed_next_actions: stringList(phase.allowed_next_actions),
    forbidden_next_actions: stringList(phase.forbidden_next_actions),
    recommended_focus: workspaceDir
      ? commandWithRuntimePlaceholders(recommendedFocus, workspaceDir)
      : recommendedFocus,
  };
}

function runtimeEditFailurePhaseFromValue(value: unknown, workspaceDir: string | null): JsonObject | null {
  const phase = asObject(value);
  if (!phase) return null;
  const phaseName = asString(phase.phase);
  const recommendedFocus = asString(phase.recommended_focus);
  const sourceTool = asString(phase.source_tool);
  if (!phaseName || !recommendedFocus || !sourceTool) return null;
  const lineHints = Array.isArray(phase.line_hints)
    ? phase.line_hints.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => !!entry).map((entry) => ({
        path: asString(entry.path),
        line: typeof entry.line === "number" ? entry.line : null,
        column: typeof entry.column === "number" ? entry.column : null,
        message: asString(entry.message),
      })).filter((entry) => !!entry.path)
    : [];
  return {
    summary_version: "edit_failure_phase_v1",
    phase: phaseName,
    confidence: typeof phase.confidence === "number" ? phase.confidence : null,
    source_tool: sourceTool,
    failure_count: typeof phase.failure_count === "number" ? phase.failure_count : null,
    primary_file: asString(phase.primary_file),
    line_hints: lineHints,
    allowed_next_actions: stringList(phase.allowed_next_actions),
    forbidden_next_actions: stringList(phase.forbidden_next_actions),
    recommended_focus: workspaceDir
      ? commandWithRuntimePlaceholders(recommendedFocus, workspaceDir)
      : recommendedFocus,
    evidence_summary: asString(phase.evidence_summary),
  };
}

function runtimeVerificationRepairFromValue(value: unknown, workspaceDir: string | null): JsonObject | null {
  const repair = asObject(value);
  if (!repair) return null;
  const failedCommands = stringList(repair.failed_commands).map((command) => (
    workspaceDir ? commandWithRuntimePlaceholders(command, workspaceDir) : command
  ));
  const nextActions = stringList(repair.next_actions).map((action) => (
    workspaceDir ? commandWithRuntimePlaceholders(action, workspaceDir) : action
  ));
  const affectedFiles = Array.isArray(repair.affected_files)
    ? repair.affected_files.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => !!entry).map((entry) => ({
        path: asString(entry.path),
        line: typeof entry.line === "number" ? entry.line : null,
        column: typeof entry.column === "number" ? entry.column : null,
        message: asString(entry.message),
      })).filter((entry) => !!entry.path)
    : [];
  if (
    failedCommands.length === 0
    && nextActions.length === 0
    && affectedFiles.length === 0
    && stringList(repair.failed_tool_schema_hints).length === 0
  ) {
    return null;
  }
  return {
    summary_version: "kickoff_verification_repair_v1",
    priority: repair.priority === "required" ? "required" : "recommended",
    contract_trust: asString(repair.contract_trust),
    failed_verifier_count: typeof repair.failed_verifier_count === "number" ? repair.failed_verifier_count : 0,
    failed_commands: failedCommands,
    categories: stringList(repair.categories),
    affected_files: affectedFiles,
    verifier_failure_phase_v1: runtimeVerifierFailurePhaseFromValue(repair.verifier_failure_phase_v1, workspaceDir),
    edit_failure_phase_v1: runtimeEditFailurePhaseFromValue(repair.edit_failure_phase_v1, workspaceDir),
    failed_tool_schema_hints: stringList(repair.failed_tool_schema_hints),
    next_actions: nextActions,
    reason: asString(repair.reason),
    instruction: workspaceDir && asString(repair.instruction)
      ? commandWithRuntimePlaceholders(asString(repair.instruction) as string, workspaceDir)
      : asString(repair.instruction),
  };
}

function firstRuntimeVerificationRepair(workspaceDir: string | null, ...values: unknown[]): JsonObject | null {
  for (const value of values) {
    const repair = runtimeVerificationRepairFromValue(value, workspaceDir);
    if (repair) return repair;
  }
  return null;
}

function repairNeedsCoupledTypeSurface(repair: JsonObject | null): boolean {
  if (!repair) return false;
  const text = [
    stringList(repair.categories),
    stringList(repair.next_actions),
    asString(repair.instruction),
  ].flat().filter((value): value is string => typeof value === "string").join("\n");
  return /type_contract|type surface|type-test|public type|tsd|index\.d\.ts/i.test(text);
}

function typeSurfaceFiles(files: string[]): string[] {
  return files.filter((file) => (
    /\.d\.ts$/i.test(file)
    || /\.test-d\.ts$/i.test(file)
    || /test-d\.ts$/i.test(file)
  ));
}

function diagnosticLines(text: string, limit = 12): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/AssertionError|ERR_ASSERTION|must |expected |actual:|operator:|✖|error|failed|not equal|promise|rejected|resolved|tsd|\.d\.ts|\.test-d\.ts|xo|eslint|no-await-in-loop|padding-line/i.test(line)) continue;
    if (!out.includes(line)) out.push(line);
    if (out.length >= limit) return out;
  }
  return out;
}

function omitLargeAssertionPayload(text: string): string {
  return text.replace(
    /\n\s+actual:\s*[\s\S]{2000,}?\n\s+expected:/g,
    "\n  actual: [omitted large AssertionError payload from LLM tool context]\n  expected:",
  );
}

function compactTextForLlmToolResult(text: string, max = 4000): string {
  if (text.length <= max) return text;
  const reduced = omitLargeAssertionPayload(text);
  if (reduced.length <= max) return reduced;
  const diagnostics = diagnosticLines(reduced, 16);
  const diagnosticBlock = diagnostics.length > 0
    ? `[diagnostic_lines]\n${diagnostics.join("\n")}\n`
    : "";
  const remaining = Math.max(1000, max - diagnosticBlock.length - 80);
  const headLength = Math.max(700, Math.floor(remaining * 0.65));
  const tailLength = Math.max(300, remaining - headLength);
  return truncate(
    [
      diagnosticBlock,
      "[head]",
      reduced.slice(0, headLength),
      "[tail]",
      reduced.slice(-tailLength),
      `[llm_tool_result_compacted original_chars=${text.length} reduced_chars=${reduced.length}]`,
    ].filter(Boolean).join("\n"),
    max,
  );
}

function compactOutputSignatureForLlm(output: JsonObject): JsonObject {
  const result = asObject(output.result);
  const content = asString(output.content);
  return {
    ...output,
    ...(typeof content === "string" && content.length > 6000
      ? {
          content: compactTextForLlmToolResult(content, 6000),
          content_original_chars: content.length,
          content_llm_compacted: true,
        }
      : {}),
    ...(result
      ? {
          result: {
            ...result,
            stdout: compactTextForLlmToolResult(asString(result.stdout) ?? ""),
            stderr: compactTextForLlmToolResult(asString(result.stderr) ?? ""),
            stdout_original_chars: (asString(result.stdout) ?? "").length,
            stderr_original_chars: (asString(result.stderr) ?? "").length,
            llm_compacted: true,
          },
        }
      : {}),
  };
}

function compactToolEventForLlm(event: ToolEvent): ToolEvent {
  return {
    ...event,
    output_signature: compactOutputSignatureForLlm(asObject(event.output_signature) ?? {}),
  };
}

function policyBlockRecoveryFiles(nextAction: JsonObject | null): string[] {
  if (!nextAction) return [];
  return uniqueStringValues([
    stringList(nextAction.allowed_files),
    stringList(nextAction.allowed_probe_files),
    stringList(nextAction.files),
    asString(nextAction.path),
  ].filter((value): value is string | string[] => !!value), 16);
}

function policyBlockRecoveryReadFiles(nextAction: JsonObject | null): string[] {
  if (!nextAction) return [];
  return uniqueStringValues([
    stringList(nextAction.allowed_read_files),
    stringList(nextAction.allowed_probe_files),
    stringList(nextAction.allowed_read_files_before_first_write),
    stringList(nextAction.allowed_read_files_before_second_write),
    stringList(nextAction.continuation_read_files),
    policyBlockRecoveryFiles(nextAction),
  ], 24);
}

function cognitiveEntropyCounterfactualProbe(policy: RuntimeSequencePolicy): JsonObject | null {
  return asObject(asObject(policy.cognitiveEntropyEngine)?.counterfactual_probe_v1);
}

function cognitiveEntropyProbeFiles(probe: JsonObject | null, lock: JsonObject | null): string[] {
  if (!probe || probe.required !== true) return [];
  const allowed = stringList(probe.allowed_read_files);
  const lockFiles = stringList(lock?.files);
  const outsideAttractor = allowed.filter((file) => !lockFiles.includes(file));
  return uniqueStringValues([
    outsideAttractor,
    allowed,
  ], 12);
}

function cognitiveEntropyProbeActionMatches(args: {
  probe: JsonObject;
  action: string;
  input: JsonObject;
  files: string[];
  workspaceDir: string;
}): boolean {
  if (args.files.length === 0) return false;
  if (args.action === "read_file") {
    return inputTouchesFiles(args.action, args.input, args.files, args.workspaceDir);
  }
  if (args.action === "search") {
    return searchScopedToFiles(args.input, args.files);
  }
  return false;
}

function cognitiveEntropyProbeDiagnosticActionAllowed(args: {
  nextAction: JsonObject;
  action: string;
  input: JsonObject;
  workspaceDir: string;
}): boolean {
  const sourceLockFiles = stringList(args.nextAction.source_lock_files);
  if (sourceLockFiles.length === 0) return false;
  if (args.action === "read_file") {
    return inputTouchesFiles(args.action, args.input, sourceLockFiles, args.workspaceDir);
  }
  if (args.action === "search") {
    return searchScopedToFiles(args.input, sourceLockFiles);
  }
  return false;
}

function cognitiveEntropyProbeBudget(policy: RuntimeSequencePolicy, probe: JsonObject): number {
  const engineBudget = numeric(policy.cognitiveEntropyEngine?.divergence_budget);
  const probeBudget = numeric(probe.max_probe_actions_per_attempt);
  const fallbackProbeBudget = numeric(probe.max_probe_actions_per_verifier_failure);
  const budget = probeBudget > 0 ? probeBudget : engineBudget > 0 ? engineBudget : fallbackProbeBudget > 0 ? fallbackProbeBudget : 1;
  return Math.max(1, Math.min(3, Math.floor(budget)));
}

function cognitiveEntropyProbeConsumed(args: {
  policy: RuntimeSequencePolicy;
  priorEvents: ToolEvent[];
  lock: JsonObject;
  workspaceDir: string;
}): boolean {
  const probe = cognitiveEntropyCounterfactualProbe(args.policy);
  const files = cognitiveEntropyProbeFiles(probe, args.lock);
  if (!probe || files.length === 0) return false;
  const budget = cognitiveEntropyProbeBudget(args.policy, probe);
  const observedProbeCount = args.priorEvents.filter((event) => {
    const output = asObject(event.output_signature);
    if (asString(output?.runtime_control) === "cognitive_entropy_counterfactual_probe") return true;
    return event.status === "success" && cognitiveEntropyProbeActionMatches({
      probe,
      action: event.tool_name,
      input: event.tool_input,
      files,
      workspaceDir: args.workspaceDir,
    });
  }).length;
  return observedProbeCount >= budget;
}

function cognitiveEntropyCounterfactualProbeNextAction(args: {
  policy: RuntimeSequencePolicy;
  priorEvents: ToolEvent[];
  lock: JsonObject | null;
  workspaceDir: string;
}): JsonObject | null {
  const probe = cognitiveEntropyCounterfactualProbe(args.policy);
  if (!probe || probe.required !== true || !args.lock) return null;
  if (pendingEditOperationAnchorRead(args.priorEvents) || pendingRepeatedNonNoopAnchorRead(args.priorEvents)) {
    return null;
  }
  if (cognitiveEntropyProbeConsumed({
    policy: args.policy,
    priorEvents: args.priorEvents,
    lock: args.lock,
    workspaceDir: args.workspaceDir,
  })) {
    return null;
  }
  const files = cognitiveEntropyProbeFiles(probe, args.lock);
  if (files.length === 0) return null;
  return {
    reason: "cognitive_entropy_counterfactual_probe_required",
    action: "read_file",
    allowed_actions: ["read_file", "search"],
    allowed_files: files,
    allowed_read_files: files,
    allowed_probe_files: files,
    source_lock_files: stringList(args.lock.files),
    source_failed_verifier_step: args.lock.failed_verifier_step ?? null,
    probe_budget_per_attempt: cognitiveEntropyProbeBudget(args.policy, probe),
    cognitive_entropy_counterfactual_probe_v1: probe,
    instruction: [
      asString(probe.reason),
      `Run one bounded counterfactual probe on allowed_read_files outside the current attractor when possible: ${files.join(", ")}.`,
      "Use read_file or a file-scoped search only. Do not write during the probe. After the probe, return to scoped repair and the required verifier.",
    ].filter(Boolean).join(" "),
  };
}

function policyBlockRecoveryActionFamily(nextAction: JsonObject | null): string {
  const reason = asString(nextAction?.reason) ?? "";
  if (reason === "ordered_action_required") return "ordered_action";
  if (reason === "cognitive_entropy_counterfactual_probe_required") return "counterfactual_probe";
  if (reason === "edit_operation_current_anchor_required" || reason.endsWith("_current_anchor_required")) return "edit_anchor_read";
  if (reason === "replace_text_non_noop_required" || reason === "replace_lines_non_noop_required") return "non_noop_repair";
  if (asObject(nextAction?.edit_phase_failure_budget_v1)?.force_required_verifier === true) return "required_verifier";
  if (
    reason === "required_verifier_due"
    || reason === "locked_repair_verifier_due"
    || reason === "repair_second_write_noop_confirmed_verifier_required"
  ) {
    return "required_verifier";
  }
  if (reason === "repair_first_write_required" || reason === "repair_second_write_required") return "repair_write";
  if (
    reason === "latest_verifier_failure_lock"
    && asObject(nextAction?.line_diagnostic_repair_v1)?.required === true
    && nextAction?.locked_repair_read_budget_exhausted !== true
  ) {
    return "locked_repair";
  }
  const preferredLockedRepairAction = asString(nextAction?.preferred_locked_repair_action);
  if (
    reason === "latest_verifier_failure_lock"
    && (
      preferredLockedRepairAction === "replace_text"
      || preferredLockedRepairAction === "replace_lines"
      || preferredLockedRepairAction === "apply_patch"
    )
  ) {
    return "locked_repair_write";
  }
  if (reason === "latest_verifier_failure_lock" && asObject(nextAction?.repeated_failure_convergence_v1)?.required === true) return "locked_repair_write";
  if (reason === "latest_verifier_failure_lock" && nextAction?.locked_repair_read_budget_exhausted === true) return "locked_repair_write";
  if (reason === "latest_verifier_failure_lock") return "locked_repair";
  return "runtime_next_action";
}

function preferCompactWriteActions(actions: string[], files: string[]): string[] {
  const allowed = uniqueStringValues(actions, 8);
  const implementationWrite = files.some(implementationEditFile);
  const preferred = implementationWrite
    ? ["apply_patch", "replace_lines", "replace_text", "run_command"]
    : ["replace_text", "replace_lines", "apply_patch", "run_command"];
  return uniqueStringValues([
    preferred.filter((action) => allowed.includes(action)),
    allowed.filter((action) => !preferred.includes(action)),
  ], 8);
}

function policyBlockRecoveryAllowedActions(
  nextAction: JsonObject | null,
  options: {
    protocolErrorsThisStep?: number;
    lastInvalidResponseExcerpt?: string | null;
  } = {},
): string[] {
  const family = policyBlockRecoveryActionFamily(nextAction);
  const files = policyBlockRecoveryFiles(nextAction);
  const protocolRetryAfterLikelyTruncation = (options.protocolErrorsThisStep ?? 0) > 0
    && likelyIncompleteJsonResponse(options.lastInvalidResponseExcerpt);
  const previousInvalidAction = protocolRetryAfterLikelyTruncation
    ? actionFromJsonLikeResponse(options.lastInvalidResponseExcerpt)
    : null;
  if (family === "ordered_action") {
    return [asString(nextAction?.action)].filter((action): action is string => !!action);
  }
  if (family === "counterfactual_probe") {
    const allowed = stringList(nextAction?.allowed_actions)
      .filter((action) => action === "read_file" || action === "search");
    return allowed.length > 0 ? allowed : ["read_file"];
  }
  if (family === "edit_anchor_read") return ["read_file"];
  if (family === "non_noop_repair") {
    return [asString(nextAction?.action)].filter((action): action is string => !!action);
  }
  if (family === "required_verifier") return ["run_command"];
  if (family === "locked_repair_write") {
    const lineDiagnosticRepair = asObject(nextAction?.line_diagnostic_repair_v1);
    const diagnosticAllowed = stringList(lineDiagnosticRepair?.allowed_write_actions)
      .filter((action) => action === "replace_lines" || action === "apply_patch");
    const preferred = asString(nextAction?.preferred_locked_repair_action);
    const editPhaseBudget = asObject(nextAction?.edit_phase_failure_budget_v1);
    if (editPhaseBudget?.force_required_verifier === true) return ["run_command"];
    const budgetAllowed = stringList(editPhaseBudget?.allowed_write_actions)
      .filter((action) => action === "replace_text" || action === "replace_lines" || action === "apply_patch");
    const budgetPreferred = asString(editPhaseBudget?.preferred_action);
    if (
      editPhaseBudget?.required === true
      && (budgetPreferred === "replace_text" || budgetPreferred === "replace_lines" || budgetPreferred === "apply_patch")
    ) {
      return [budgetPreferred];
    }
    if (editPhaseBudget?.required === true && budgetAllowed.length > 0) return budgetAllowed;
    if (lineDiagnosticRepair?.required === true && diagnosticAllowed.length > 0) {
      if ((preferred === "replace_lines" || preferred === "apply_patch") && diagnosticAllowed.includes(preferred)) {
        return [preferred];
      }
      return uniqueStringValues([
        diagnosticAllowed.includes("replace_lines") ? "replace_lines" : null,
        diagnosticAllowed.includes("apply_patch") ? "apply_patch" : null,
      ].filter((action): action is string => !!action), 4);
    }
    if (protocolRetryAfterLikelyTruncation) {
      if (previousInvalidAction === "apply_patch") {
        if (preferred === "replace_lines") return ["replace_lines"];
        return ["replace_text"];
      }
      if (previousInvalidAction === "replace_lines") {
        if (preferred === "replace_text") return ["replace_text"];
        if (preferred === "apply_patch") return ["apply_patch"];
        return files.some(implementationEditFile) ? ["apply_patch"] : ["replace_text"];
      }
      if (previousInvalidAction === "replace_text") {
        if (preferred === "apply_patch") return ["apply_patch"];
        return ["replace_lines"];
      }
      if (preferred === "replace_lines") return ["replace_lines"];
      if (preferred === "replace_text" || preferred === "apply_patch") return [preferred];
      return uniqueStringValues([
        files.some(implementationEditFile) ? "apply_patch" : null,
        "replace_text",
        "replace_lines",
      ].filter((action): action is string => !!action), 4);
    }
    const repeatedFailureConvergence = asObject(nextAction?.repeated_failure_convergence_v1);
    if (repeatedFailureConvergence?.required === true) {
      const compactSpan = asObject(nextAction?.locked_repair_compact_span_v1);
      if (preferred === "replace_text" || preferred === "replace_lines" || preferred === "apply_patch") return [preferred];
      if (compactSpan?.required === true) return ["replace_lines"];
      const allowed = stringList(repeatedFailureConvergence.allowed_write_actions)
        .filter((action) => action === "replace_lines" || action === "apply_patch");
      if (allowed.length > 0) return preferCompactWriteActions(allowed, files);
    }
    if (preferred === "replace_text" || preferred === "replace_lines" || preferred === "apply_patch") return [preferred];
    if (files.length > 0 && files.every(authoredTestFile)) return ["replace_text"];
    return preferCompactWriteActions(["replace_lines", "replace_text"], files);
  }
  if (family === "repair_write") {
    const packageMigration = asObject(nextAction?.package_dependency_migration_template_v1);
    const packageMigrationAction = asString(packageMigration?.action);
    if (packageMigrationAction === "replace_lines" || packageMigrationAction === "replace_text" || packageMigrationAction === "apply_patch") {
      return [packageMigrationAction];
    }
    const anchorEscalation = asObject(nextAction?.repair_write_anchor_escalation_v1);
    const allowed = stringList(anchorEscalation?.allowed_write_actions)
      .filter((action) => action === "replace_text" || action === "replace_lines" || action === "apply_patch");
    if (allowed.length > 0) return preferCompactWriteActions(allowed, files);
    if (protocolRetryAfterLikelyTruncation) {
      const retryAllowed = stringList(nextAction?.allowed_write_actions)
        .filter((action) => action === "replace_text" || action === "replace_lines" || action === "apply_patch");
      if (previousInvalidAction === "apply_patch" && retryAllowed.includes("replace_text")) return ["replace_text"];
      if (previousInvalidAction === "replace_lines" && retryAllowed.includes("replace_text")) return ["replace_text"];
      const compactRetryAllowed = preferCompactWriteActions(retryAllowed, files);
      if (compactRetryAllowed.length > 0) return compactRetryAllowed;
    }
    const nextAllowed = stringList(nextAction?.allowed_write_actions)
      .filter((action) => action === "replace_text" || action === "replace_lines" || action === "apply_patch");
    if (nextAllowed.length > 0) return preferCompactWriteActions(nextAllowed, files);
    return ["replace_text"];
  }
  if (family === "locked_repair") {
    const lineDiagnosticRepair = asObject(nextAction?.line_diagnostic_repair_v1);
    const diagnosticAllowed = stringList(lineDiagnosticRepair?.allowed_write_actions)
      .filter((action) => action === "replace_lines" || action === "apply_patch");
    const preferred = asString(nextAction?.preferred_locked_repair_action);
    const editPhaseBudget = asObject(nextAction?.edit_phase_failure_budget_v1);
    if (editPhaseBudget?.force_required_verifier === true) return ["run_command"];
    const budgetAllowed = stringList(editPhaseBudget?.allowed_write_actions)
      .filter((action) => action === "replace_text" || action === "replace_lines" || action === "apply_patch");
    if (editPhaseBudget?.required === true && budgetAllowed.length > 0) {
      return uniqueStringValues(["read_file", budgetAllowed], 8);
    }
    if (lineDiagnosticRepair?.required === true && diagnosticAllowed.length > 0) {
      if ((preferred === "replace_lines" || preferred === "apply_patch") && diagnosticAllowed.includes(preferred)) {
        return ["read_file", preferred];
      }
      return uniqueStringValues([
        "read_file",
        diagnosticAllowed.includes("replace_lines") ? "replace_lines" : null,
        diagnosticAllowed.includes("apply_patch") ? "apply_patch" : null,
      ].filter((action): action is string => !!action), 8);
    }
    return ["read_file", "replace_lines", "apply_patch", "replace_text", "run_command"];
  }
  return stringList(nextAction?.allowed_write_actions).length > 0
    ? stringList(nextAction?.allowed_write_actions)
    : ["read_file", "replace_lines", "apply_patch", "replace_text", "run_command"];
}

function repairWriteAnchorEscalationNextAction(policy: RuntimeSequencePolicy, priorEvents: ToolEvent[], workspaceDir: string): JsonObject | null {
  if (policy.repairFirstWriteFiles.length > 0 && !hasRepairFileWrite(policy, priorEvents)) {
    const readableBeforeWrite = policy.repairPreWriteReadFiles.length > 0
      ? policy.repairPreWriteReadFiles
      : policy.repairFirstWriteFiles;
    const anchorEscalation = repairWriteAnchorEscalation({
      policy,
      priorEvents,
      files: policy.repairFirstWriteFiles,
      phase: "first",
    });
    if (!anchorEscalation) return null;
    return {
      reason: "repair_first_write_required",
      allowed_files: policy.repairFirstWriteFiles,
      allowed_write_actions: stringList(anchorEscalation.allowed_write_actions),
      allowed_narrow_read_actions: ["read_file"],
      allowed_read_files_before_first_write: readableBeforeWrite,
      repair_write_anchor_escalation_v1: anchorEscalation,
      instruction: asString(anchorEscalation.instruction) ?? "",
    };
  }
  if (policy.repairSecondWriteFiles.length > 0 && !hasRepairSecondFileWrite(policy, priorEvents)) {
    const readableBeforeWrite = policy.repairSecondWriteReadFiles.length > 0
      ? policy.repairSecondWriteReadFiles
      : policy.repairSecondWriteFiles;
    const packageDependencyMigration = packageDependencyMigrationTemplate({
      requirements: policy.packageDependencyRequirements,
      workspaceDir,
    });
    const anchorEscalation = repairWriteAnchorEscalation({
      policy,
      priorEvents,
      files: policy.repairSecondWriteFiles,
      phase: "second",
    });
    if (!anchorEscalation) return null;
    return {
      reason: "repair_second_write_required",
      allowed_files: policy.repairSecondWriteFiles,
      allowed_write_actions: packageDependencyMigration
        ? [asString(packageDependencyMigration.action) ?? "replace_lines"]
        : stringList(anchorEscalation.allowed_write_actions),
      allowed_narrow_read_actions: ["read_file"],
      allowed_read_files_before_second_write: readableBeforeWrite,
      package_dependency_requirements_v1: policy.packageDependencyRequirements.length > 0 ? policy.packageDependencyRequirements : null,
      package_dependency_migration_template_v1: packageDependencyMigration,
      repair_write_anchor_escalation_v1: anchorEscalation,
      instruction: packageDependencyMigration
        ? asString(packageDependencyMigration.instruction) ?? ""
        : asString(anchorEscalation.instruction) ?? "",
    };
  }
  return null;
}

function policyBlockRecoveryNextAction(args: PolicyBlockRecoveryNextActionArgs): JsonObject | null {
  const blockEvent = latestPolicyBlockEvent(args.events);
  if (!blockEvent) return null;
  const output = asObject(blockEvent.output_signature) ?? {};
  const rawNextAction = asObject(output.sequence_policy_next_action)
    ?? asObject(output.edit_operation_next_action);
  const lockedAnchorRefreshAction = lockedRepairAnchorRefreshNextAction(rawNextAction);
  if (lockedAnchorRefreshAction) {
    const latestFailureLock = args.sequencePolicy
      ? latestFailedVerifierLock(args.sequencePolicy, args.events, args.workspaceDir)
      : null;
    if (!pendingAnchorReadSuppressedByVerifierLock({
      pendingAnchorRead: lockedAnchorRefreshAction,
      lock: latestFailureLock,
      workspaceDir: args.workspaceDir,
    })) {
      return lockedAnchorRefreshAction;
    }
  }
  const rawFamily = policyBlockRecoveryActionFamily(rawNextAction);
  if (rawFamily === "edit_anchor_read" && args.sequencePolicy) {
    const pendingAnchorRead = pendingEditOperationAnchorRead(args.events);
    if (pendingAnchorRead) {
      const latestFailureLock = latestFailedVerifierLock(args.sequencePolicy, args.events, args.workspaceDir);
      if (!pendingAnchorReadSuppressedByVerifierLock({
        pendingAnchorRead,
        lock: latestFailureLock,
        workspaceDir: args.workspaceDir,
      })) {
        return {
          ...pendingAnchorRead,
          source_edit_operation_next_action: rawNextAction,
        };
      }
    }
    const anchorEscalation = repairWriteAnchorEscalationNextAction(args.sequencePolicy, args.events, args.workspaceDir);
    if (anchorEscalation) {
      return {
        ...anchorEscalation,
        source_edit_operation_next_action: rawNextAction,
      };
    }
  }
  const sequenceNextAction = args.sequencePolicy
    ? sequencePolicyNextAction(args.sequencePolicy, args.events, args.workspaceDir)
    : null;
  const sequenceReason = asString(sequenceNextAction?.reason);
  if (
    sequenceReason === "locked_repair_verifier_due"
    || sequenceReason === "required_verifier_due"
    || sequenceReason === "repair_second_write_noop_confirmed_verifier_required"
    || sequenceReason === "cognitive_entropy_counterfactual_probe_required"
  ) {
    return {
      ...sequenceNextAction,
      source_policy_block_next_action: rawNextAction,
    };
  }
  const latestFailureLock = args.sequencePolicy
    ? latestFailedVerifierLock(args.sequencePolicy, args.events, args.workspaceDir)
    : null;
  if (
    latestFailureLock
    && (
      asString(rawNextAction?.reason) === "latest_verifier_failure_lock"
      || rawFamily === "locked_repair"
      || rawFamily === "locked_repair_write"
    )
  ) {
    return {
      ...(lockedRepairAnchorRefreshNextAction(latestFailureLock) ?? latestFailureLock),
      source_policy_block_next_action: rawNextAction,
    };
  }
  if (rawFamily !== "non_noop_repair" || !args.sequencePolicy) return rawNextAction;
  if (asObject(latestFailureLock?.non_noop_stagnation_v1)?.required === true) {
    return {
      ...latestFailureLock,
      source_edit_operation_next_action: rawNextAction,
    };
  }
  if (asString(sequenceNextAction?.reason) === "non_noop_current_anchor_required") {
    return {
      ...sequenceNextAction,
      source_edit_operation_next_action: rawNextAction,
    };
  }
  if (asString(sequenceNextAction?.reason) === "repair_second_write_noop_confirmed_verifier_required") {
    return {
      ...sequenceNextAction,
      source_edit_operation_next_action: rawNextAction,
    };
  }
  return rawNextAction;
}

function recentReadEvidenceForPolicyBlockRecovery(
  events: ToolEvent[],
  files: string[],
  options: { maxEvents?: number; maxContentChars?: number } = {},
): JsonObject[] {
  if (files.length === 0) return [];
  const maxEvents = Math.max(1, options.maxEvents ?? 5);
  const maxContentChars = Math.max(500, options.maxContentChars ?? 5000);
  return events
    .filter((event) => event.status === "success" && event.tool_name === "read_file" && eventTouchesAnyFile(event, files))
    .slice(-maxEvents)
    .map((event) => {
      const output = asObject(event.output_signature) ?? {};
      return {
        step_index: event.step_index,
        path: asString(output.path) ?? asString(event.tool_input.path) ?? null,
        start_line: output.start_line ?? event.tool_input.start_line ?? null,
        end_line: output.end_line ?? event.tool_input.end_line ?? null,
        content: compactTextForLlmToolResult(asString(output.content) ?? "", maxContentChars),
      };
    });
}

function policyRecoveryOutputBudget(args: {
  family: string;
  allowedActions: string[];
  sourceWorkflowRepair: boolean;
  lineDiagnosticRepair: boolean;
  packageDependencyMigration: boolean;
  compactLockedRepairSpan: boolean;
  protocolErrorsThisStep: number;
  lastInvalidResponseExcerpt?: string | null;
}): JsonObject {
  const retryAfterTruncation = args.protocolErrorsThisStep > 0
    && likelyIncompleteJsonResponse(args.lastInvalidResponseExcerpt);
  const previousInvalidAction = retryAfterTruncation
    ? actionFromJsonLikeResponse(args.lastInvalidResponseExcerpt)
    : null;
  const applyPatchPreferred = args.allowedActions.includes("apply_patch");
  const replaceLinesAllowed = args.allowedActions.includes("replace_lines");
  const replaceTextAllowed = args.allowedActions.includes("replace_text");
  const replaceLinesOnlyAvailable = replaceLinesAllowed && !applyPatchPreferred && !replaceTextAllowed;
  const sourceRetryReplaceLinesOnly = args.sourceWorkflowRepair && retryAfterTruncation && replaceLinesOnlyAvailable;
  const compactSourceReplaceLines = args.compactLockedRepairSpan || sourceRetryReplaceLinesOnly;
  const nonNoopRepair = args.family === "non_noop_repair";
  return {
    forced_action_family: args.family,
    retry_after_likely_truncated_json: retryAfterTruncation,
    previous_invalid_action: previousInvalidAction,
    preferred_action_when_listed: args.packageDependencyMigration
      ? "replace_lines"
      : compactSourceReplaceLines
      ? "replace_lines"
      : retryAfterTruncation && previousInvalidAction === "apply_patch" && replaceTextAllowed
      ? "replace_text"
      : retryAfterTruncation && previousInvalidAction === "replace_lines" && replaceTextAllowed
      ? "replace_text"
      : retryAfterTruncation && applyPatchPreferred
      ? "apply_patch"
      : retryAfterTruncation && replaceTextAllowed
      ? "replace_text"
      : args.lineDiagnosticRepair && replaceLinesAllowed
      ? "replace_lines"
      : applyPatchPreferred ? "apply_patch" : replaceLinesAllowed ? "replace_lines" : replaceTextAllowed ? "replace_text" : null,
    max_replace_text_find_chars: args.sourceWorkflowRepair ? 1400 : 900,
    max_replace_text_replace_chars: args.sourceWorkflowRepair ? 2200 : 1400,
    max_replace_lines_old_lines: args.packageDependencyMigration ? 160 : args.lineDiagnosticRepair ? 10 : nonNoopRepair ? 8 : compactSourceReplaceLines ? 8 : args.sourceWorkflowRepair ? 18 : 18,
    max_replace_lines_replacement_lines: args.packageDependencyMigration ? 160 : args.lineDiagnosticRepair ? 24 : nonNoopRepair ? 16 : compactSourceReplaceLines ? 16 : args.sourceWorkflowRepair ? 32 : 36,
    max_apply_patch_hunks: args.lineDiagnosticRepair ? 1 : compactSourceReplaceLines ? 0 : retryAfterTruncation ? 1 : args.sourceWorkflowRepair ? 2 : 2,
    instruction: [
      "Keep the tool JSON compact enough to close before max_tokens.",
      args.packageDependencyMigration
        ? "For package dependency migration, return the exact replace_lines action_template supplied by Runtime; the larger line budget applies only to that exact template."
        : null,
      compactSourceReplaceLines
        ? "For compact locked repair, use exactly one small replace_lines span: at most 8 expected_old_lines and at most 16 replacement_lines. Choose a narrow span inside recent_read_evidence; do not reuse the entire read range."
        : null,
      args.lineDiagnosticRepair && replaceLinesAllowed
        ? "For line-diagnostic repair, prefer replace_lines over apply_patch; touch only the diagnostic import/declaration lines unless the latest read proves the directly adjacent call-site line must change."
        : null,
      args.sourceWorkflowRepair
        ? "For source-workflow repair, do not emit a whole-function or whole-read-range replace_lines payload. Use at most the listed replace_lines limits, or a compact apply_patch with at most two hunks when apply_patch is allowed."
        : null,
      nonNoopRepair
        ? "For non-noop repair, do not expand the failed edit into a broad method rewrite. Use at most 8 old lines and 16 replacement lines copied from the latest read evidence."
        : null,
      applyPatchPreferred && !args.lineDiagnosticRepair
        ? "When apply_patch is listed, prefer it for import/helper plus call-site edits because it avoids embedding long expected_old_lines arrays."
        : null,
      retryAfterTruncation
        ? previousInvalidAction === "apply_patch" && replaceTextAllowed
          ? "The previous response was an oversized incomplete apply_patch JSON. Do not emit apply_patch for this retry; use one compact replace_text on recent_read_evidence."
          : previousInvalidAction === "replace_lines" && replaceTextAllowed
          ? "The previous response was an oversized incomplete replace_lines JSON. Do not emit another long line-array payload; use one compact replace_text on recent_read_evidence."
          : sourceRetryReplaceLinesOnly
          ? "The previous response looked like incomplete JSON from an oversized payload. Use replace_lines now with at most 8 old lines and 16 replacement lines; do not emit apply_patch."
          : "The previous response looked like incomplete JSON, likely because the action payload was too large. Prefer apply_patch or replace_text now; avoid replace_lines arrays that include long current-source lines."
        : null,
    ].filter(Boolean).join(" "),
  };
}

function projectedRuntimeNextActionForRecovery(nextAction: JsonObject | null, allowedActions: string[]): JsonObject | null {
  if (!nextAction) return null;
  const projected: JsonObject = { ...nextAction };
  const editPhaseBudget = asObject(projected.edit_phase_failure_budget_v1);
  if (editPhaseBudget?.required !== true) return projected;
  if (editPhaseBudget.force_required_verifier === true) {
    projected.effective_recovery_override_v1 = {
      summary_version: "effective_recovery_override_v1",
      reason: "edit_phase_failure_budget_forces_required_verifier",
      allowed_actions: ["run_command"],
      quarantined_write_actions: stringList(editPhaseBudget.quarantined_write_actions),
      instruction:
        "The edit phase write budget is exhausted. Do not emit another read or write action; run the required verifier to close this phase and produce fresh evidence.",
    };
    projected.action = "run_command";
    projected.commands = uniqueStringValues([
      stringList(projected.commands),
      asString(projected.failed_verifier_command),
    ], 4);
    projected.allowed_write_actions = [];
    projected.preferred_locked_repair_action = null;
    projected.instruction = [
      asString(editPhaseBudget.instruction),
      "Effective recovery action is run_command with the required verifier. Ignore nested write/action-quarantine instructions for this recovery step.",
    ].filter(Boolean).join(" ");
    return projected;
  }
  const allowedWriteActions = allowedActions.filter(editWriteToolAction);
  const quarantinedWriteActions = stringList(editPhaseBudget.quarantined_write_actions);
  projected.effective_recovery_override_v1 = {
    summary_version: "effective_recovery_override_v1",
    reason: "edit_phase_failure_budget_overrides_nested_repair_instructions",
    allowed_actions: allowedActions,
    allowed_write_actions: allowedWriteActions,
    quarantined_write_actions: quarantinedWriteActions,
    instruction:
      `The edit phase failure budget is the controlling contract for this recovery step. Use only allowed_actions: ${allowedActions.join(", ")}. Ignore nested repair instructions that mention quarantined action(s): ${quarantinedWriteActions.join(", ") || "none"}.`,
  };
  projected.allowed_write_actions = allowedWriteActions;
  if (allowedWriteActions.length > 0) {
    projected.preferred_locked_repair_action = allowedWriteActions[0];
  }
  projected.instruction = [
    asString(editPhaseBudget.instruction),
    `Effective recovery allowed action(s): ${allowedActions.join(", ")}.`,
    quarantinedWriteActions.length > 0
      ? `Do not use quarantined write action(s), even if older nested diagnostics mention them: ${quarantinedWriteActions.join(", ")}.`
      : null,
  ].filter(Boolean).join(" ");
  const repeatedFailureConvergence = asObject(projected.repeated_failure_convergence_v1);
  if (repeatedFailureConvergence) {
    projected.repeated_failure_convergence_v1 = {
      ...repeatedFailureConvergence,
      allowed_write_actions: allowedWriteActions,
      instruction:
        "This source-workflow diagnostic is subordinate to edit_phase_failure_budget_v1 for the current recovery step. Use only effective_recovery_override_v1.allowed_actions.",
    };
  }
  const compactSpan = asObject(projected.locked_repair_compact_span_v1);
  if (compactSpan && !allowedWriteActions.includes("replace_lines")) {
    projected.locked_repair_compact_span_v1 = {
      ...compactSpan,
      required: false,
      suppressed_by_edit_phase_failure_budget: true,
      instruction:
        "Compact replace_lines span guidance is suppressed for this recovery step because replace_lines is quarantined by edit_phase_failure_budget_v1.",
    };
  }
  const actionQuarantine = asObject(projected.locked_repair_action_quarantine_v1);
  if (actionQuarantine) {
    const quarantinedAction = asString(actionQuarantine.quarantined_action);
    const preferredAction = asString(actionQuarantine.preferred_action);
    const conflictsWithBudget = !!(
      (quarantinedAction && allowedActions.includes(quarantinedAction))
      || (preferredAction && !allowedActions.includes(preferredAction))
    );
    projected.locked_repair_action_quarantine_v1 = conflictsWithBudget
      ? {
          ...actionQuarantine,
          suppressed_by_edit_phase_failure_budget: true,
          original_quarantined_action: quarantinedAction ?? null,
          original_preferred_action: preferredAction ?? null,
          quarantined_action: null,
          preferred_action: allowedWriteActions[0] ?? null,
          instruction:
            "This action quarantine conflicts with edit_phase_failure_budget_v1 and is suppressed for the current recovery step. Use only effective_recovery_override_v1.allowed_actions.",
        }
      : {
          ...actionQuarantine,
          instruction:
            "Action quarantine is subordinate to edit_phase_failure_budget_v1 for this recovery step. Use only effective_recovery_override_v1.allowed_actions.",
        };
  }
  return projected;
}

function recoveryNextActionFromPolicyBlockEvent(event: ToolEvent): JsonObject | null {
  const output = asObject(event.output_signature) ?? {};
  return asObject(output.sequence_policy_next_action)
    ?? asObject(output.edit_operation_next_action)
    ?? asObject(output.verifier_failure_lock_next_action);
}

function policyBlockNoncomplianceFromEvent(event: ToolEvent): JsonObject | null {
  if (event.status !== "failed") return null;
  if (event.tool_name === "llm_call" || event.tool_name === "llm_protocol" || event.tool_name === "runtime_policy") return null;
  const nextAction = recoveryNextActionFromPolicyBlockEvent(event);
  if (!nextAction) return null;
  const output = asObject(event.output_signature) ?? {};
  const hasPolicyBlock = !!(
    asString(output.sequence_policy_error)
    || asString(output.verification_cadence_error)
    || asString(output.verifier_failure_lock_error)
    || asString(output.package_dependency_lock_error)
    || asString(output.cognitive_entropy_probe_error)
    || asObject(output.edit_operation_next_action)
  );
  if (!hasPolicyBlock) return null;
  const allowedActions = policyBlockRecoveryAllowedActions(nextAction);
  if (allowedActions.length === 0) return null;
  const editPhaseBudget = asObject(nextAction.edit_phase_failure_budget_v1);
  const quarantinedWriteActions = stringList(editPhaseBudget?.quarantined_write_actions)
    .filter(editWriteToolAction);
  const failedAction = event.tool_name;
  const blockedByAllowedActions = !allowedActions.includes(failedAction);
  const blockedByWriteQuarantine = quarantinedWriteActions.includes(failedAction as EditWriteToolAction);
  if (!blockedByAllowedActions && !blockedByWriteQuarantine) return null;
  return {
    summary_version: "policy_block_noncompliance_event_v1",
    step_index: event.step_index,
    failed_action: failedAction,
    recovery_reason: asString(nextAction.reason) ?? null,
    allowed_actions: allowedActions,
    allowed_files: policyBlockRecoveryFiles(nextAction),
    quarantined_write_actions: quarantinedWriteActions,
    blocked_by_allowed_actions: blockedByAllowedActions,
    blocked_by_write_quarantine: blockedByWriteQuarantine,
  };
}

function successfulBoundaryResetEvent(event: ToolEvent): boolean {
  if (event.status !== "success") return false;
  if (event.write_files.length > 0) return true;
  if (event.tool_name !== "run_command") return false;
  const command = asString(event.tool_input.command) ?? "";
  return /npm\s+(run\s+)?test|npm\s+run|node\s+.*github-real-project-contracts|pnpm\s+(test|run)|yarn\s+(test|run)/i.test(command);
}

function policyBlockNoncomplianceBudget(events: ToolEvent[]): JsonObject | null {
  const latestEvent = events[events.length - 1];
  if (!latestEvent) return null;
  const latest = policyBlockNoncomplianceFromEvent(latestEvent);
  if (!latest) return null;
  const latestAction = asString(latest.failed_action);
  const latestReason = asString(latest.recovery_reason);
  const evidence: JsonObject[] = [];
  let totalCount = 0;
  let sameActionCount = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (successfulBoundaryResetEvent(event)) break;
    const noncompliance = policyBlockNoncomplianceFromEvent(event);
    if (!noncompliance) continue;
    totalCount += 1;
    if (
      asString(noncompliance.failed_action) === latestAction
      && asString(noncompliance.recovery_reason) === latestReason
    ) {
      sameActionCount += 1;
    }
    if (evidence.length < 8) evidence.push(noncompliance);
  }
  const exhausted = sameActionCount >= POLICY_BLOCK_NONCOMPLIANCE_SAME_ACTION_THRESHOLD
    || totalCount >= POLICY_BLOCK_NONCOMPLIANCE_TOTAL_THRESHOLD;
  if (!exhausted) return null;
  return {
    summary_version: "policy_block_noncompliance_budget_v1",
    required: true,
    reason: "repeated_forbidden_recovery_action",
    action: "abort_attempt",
    failed_action: latestAction ?? null,
    recovery_reason: latestReason ?? null,
    same_action_count: sameActionCount,
    same_action_threshold: POLICY_BLOCK_NONCOMPLIANCE_SAME_ACTION_THRESHOLD,
    total_count: totalCount,
    total_threshold: POLICY_BLOCK_NONCOMPLIANCE_TOTAL_THRESHOLD,
    allowed_actions: stringList(latest.allowed_actions),
    allowed_files: stringList(latest.allowed_files),
    quarantined_write_actions: stringList(latest.quarantined_write_actions),
    latest_blocked_step: latestEvent.step_index,
    evidence,
    learning_control: {
      quarantine_run: true,
      reason: "tool_protocol_failure_before_completed_run",
    },
    instruction:
      "Runtime stopped this attempt because the LLM repeatedly ignored the active recovery contract. Do not derive repository code learning from this run; retry with a fresh attempt/provider state and the same generic recovery policy.",
  };
}

function actionSynthesisPlanForPolicyRecovery(args: {
  nextAction: JsonObject | null;
  family: string;
  allowedActions: string[];
  files: string[];
  readFiles: string[];
  outputBudget: JsonObject;
  recentReads: JsonObject[];
  requiredVerifierCommands: string[];
}): JsonObject | null {
  const targetFiles = uniqueStringValues([args.files, args.readFiles], 24);
  if (targetFiles.length === 0 && args.requiredVerifierCommands.length === 0) return null;
  const lineHints = jsonObjectList(args.nextAction?.output_line_hints);
  const lineDiagnosticRepair = asObject(args.nextAction?.line_diagnostic_repair_v1);
  const importContractEvidence = asObject(args.nextAction?.import_contract_evidence_v1);
  const diagnosticHints = Array.isArray(lineDiagnosticRepair?.diagnostics)
    ? lineDiagnosticRepair.diagnostics.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => !!entry)
    : [];
  const effectiveLineHints = lineHints.length > 0 ? lineHints : diagnosticHints;
  const lineHintLabels = actionSynthesisLineHintLabels(effectiveLineHints);
  const noDefaultExportModules = stringList(importContractEvidence?.no_default_export_modules);
  const forbiddenNamedImports = jsonObjectList(importContractEvidence?.forbidden_named_imports);
  const forbiddenNamedImportLabels = forbiddenNamedImports
    .map((entry) => {
      const moduleName = asString(entry.module);
      const symbol = asString(entry.symbol);
      return moduleName && symbol ? `${moduleName}.${symbol}` : null;
    })
    .filter((label): label is string => !!label);
  const preferredAction = asString(args.outputBudget.preferred_action_when_listed)
    ?? asString(args.nextAction?.preferred_action)
    ?? args.allowedActions[0]
    ?? (args.requiredVerifierCommands.length > 0 ? "run_command" : null);
  const currentStep = args.family === "required_verifier"
    ? "run_required_verifier"
    : args.family === "counterfactual_probe"
      ? "bounded_counterfactual_probe"
      : args.family === "edit_anchor_read"
        ? "refresh_anchor_read"
        : args.family === "locked_repair_write" || args.family === "locked_repair"
          ? "locked_repair_action"
          : args.family === "repair_write"
            ? "scoped_repair_write"
            : args.family === "non_noop_repair"
              ? "non_noop_repair"
              : "policy_block_recovery";
  return {
    summary_version: "action_synthesis_plan_v1",
    authority: "runtime_execution_scaffold",
    promotion_state: "none",
    source: "policy_block_recovery",
    current_step: currentStep,
    target_files: targetFiles,
    allowed_read_files: args.readFiles,
    line_hints: effectiveLineHints.slice(0, 8),
    line_hint_labels: lineHintLabels,
    preferred_action: preferredAction,
    allowed_actions: args.allowedActions,
    required_verifier_command: args.requiredVerifierCommands[0] ?? null,
    recent_read_evidence_count: args.recentReads.length,
    import_contract_evidence_v1: importContractEvidence,
    quality_gates: [
      "return exactly one raw JSON tool action",
      "choose the action from allowed_actions only",
      "target only allowed_files or allowed_read_files",
      "for write actions, copy anchors from recent_read_evidence and keep payload under output_budget",
      "do not retry the blocked payload pattern, stale anchor, no-op replacement, or oversized whole-range edit",
      noDefaultExportModules.length > 0
        ? `do not introduce default imports for verifier-denied module(s): ${noDefaultExportModules.join(", ")}`
        : null,
      forbiddenNamedImportLabels.length > 0
        ? `do not introduce verifier-denied named import binding(s): ${forbiddenNamedImportLabels.join(", ")}`
        : null,
      "if a write quality gate cannot be met, choose the allowed read/verifier action instead of malformed JSON",
      "run the required verifier immediately when current_step is run_required_verifier",
      "this scaffold is not memory promotion and carries no reusable project policy authority",
    ].filter((gate): gate is string => !!gate),
    payload_limits: {
      max_apply_patch_hunks: args.outputBudget.max_apply_patch_hunks ?? null,
      max_replace_lines_old_lines: args.outputBudget.max_replace_lines_old_lines ?? null,
      max_replace_lines_replacement_lines: args.outputBudget.max_replace_lines_replacement_lines ?? null,
      max_tokens_hint: args.outputBudget.max_tokens_hint ?? null,
    },
    instruction: [
      `Reduce the blocked recovery state to one ${currentStep} action.`,
      preferredAction ? `Preferred action when listed: ${preferredAction}.` : null,
      targetFiles.length > 0 ? `Target only: ${targetFiles.join(", ")}.` : null,
      lineHintLabels.length > 0 ? `Start from line hint(s): ${lineHintLabels.join(", ")}.` : null,
      args.requiredVerifierCommands[0] ? `Verifier command: ${args.requiredVerifierCommands[0]}.` : null,
    ].filter(Boolean).join(" "),
  };
}

function recentReadLineSpan(args: {
  recentReads: JsonObject[];
  path: string;
  line: number;
  before?: number;
  after?: number;
  maxLines?: number;
}): JsonObject | null {
  const before = Math.max(0, Math.floor(args.before ?? 0));
  const after = Math.max(0, Math.floor(args.after ?? 0));
  const maxLines = Math.max(1, Math.floor(args.maxLines ?? 6));
  for (let index = args.recentReads.length - 1; index >= 0; index -= 1) {
    const read = args.recentReads[index];
    if (asString(read?.path) !== args.path) continue;
    const readStart = numeric(read?.start_line);
    const readEnd = numeric(read?.end_line);
    const content = asString(read?.content);
    if (!content || readStart <= 0 || readEnd < readStart || args.line < readStart || args.line > readEnd) continue;
    const lines = content.split(/\r?\n/);
    const spanStart = Math.max(readStart, args.line - before);
    const spanEnd = Math.min(readEnd, args.line + after, spanStart + maxLines - 1);
    const startIndex = spanStart - readStart;
    const endIndex = spanEnd - readStart;
    const expectedOldLines = lines.slice(startIndex, endIndex + 1);
    if (expectedOldLines.length === 0 || expectedOldLines.some((line) => typeof line !== "string")) continue;
    return {
      path: args.path,
      start_line: spanStart,
      end_line: spanEnd,
      expected_old_lines: expectedOldLines,
      source_read_step: read.step_index ?? null,
    };
  }
  return null;
}

function diagnosticRepairTarget(lineDiagnosticRepair: JsonObject | null, targetFiles: string[]): JsonObject | null {
  const diagnostics = jsonObjectList(lineDiagnosticRepair?.diagnostics);
  for (const diagnostic of diagnostics) {
    const path = asString(diagnostic.path);
    const line = typeof diagnostic.line === "number" ? Math.floor(diagnostic.line) : 0;
    if (!path || line <= 0) continue;
    if (targetFiles.length > 0 && !targetFiles.includes(path)) continue;
    return diagnostic;
  }
  return diagnostics[0] ?? null;
}

function repairActionCompilerForPolicyRecovery(args: {
  nextAction: JsonObject | null;
  family: string;
  allowedActions: string[];
  files: string[];
  readFiles: string[];
  outputBudget: JsonObject;
  recentReads: JsonObject[];
  requiredVerifierCommands: string[];
}): JsonObject | null {
  const lineDiagnosticRepair = asObject(args.nextAction?.line_diagnostic_repair_v1);
  const importContractEvidence = asObject(args.nextAction?.import_contract_evidence_v1);
  const targetFiles = uniqueStringValues([args.files, args.readFiles, stringList(lineDiagnosticRepair?.target_files)], 24);
  const diagnostic = diagnosticRepairTarget(lineDiagnosticRepair, targetFiles);
  const diagnosticPath = asString(diagnostic?.path);
  const diagnosticLine = typeof diagnostic?.line === "number" ? Math.floor(diagnostic.line) : 0;
  const diagnosticKind = asString(lineDiagnosticRepair?.diagnostic_kind);
  const maxOldLines = numeric(args.outputBudget.max_replace_lines_old_lines) || 8;
  const maxReplacementLines = numeric(args.outputBudget.max_replace_lines_replacement_lines) || 16;
  const lineSpan = diagnosticPath && diagnosticLine > 0
    ? recentReadLineSpan({
        recentReads: args.recentReads,
        path: diagnosticPath,
        line: diagnosticLine,
        before: 0,
        after: 0,
        maxLines: Math.min(maxOldLines, 3),
      })
    : null;
  const anchorReadAction = diagnosticPath && diagnosticLine > 0
    ? {
        action: "read_file",
        input: {
          path: diagnosticPath,
          start_line: Math.max(1, diagnosticLine - 24),
          end_line: diagnosticLine + 48,
        },
      }
    : null;
  const noDefaultExportModules = stringList(importContractEvidence?.no_default_export_modules);
  const forbiddenNamedImports = jsonObjectList(importContractEvidence?.forbidden_named_imports);
  const compiledTemplates: JsonObject = {};
  if (lineSpan && args.allowedActions.includes("replace_lines")) {
    compiledTemplates.compiled_line_replace_lines = {
      action: "replace_lines",
      input: {
        path: lineSpan.path,
        start_line: lineSpan.start_line,
        end_line: lineSpan.end_line,
        expected_old_lines: lineSpan.expected_old_lines,
        replacement_lines: [
          "<fill with the localized replacement lines only; preserve path/start_line/end_line/expected_old_lines exactly>",
        ],
      },
    };
  }
  if (lineSpan && args.allowedActions.includes("replace_text")) {
    compiledTemplates.compiled_line_replace_text = {
      action: "replace_text",
      input: {
        path: lineSpan.path,
        find: stringList(lineSpan.expected_old_lines).join("\n"),
        replace: "<fill with the localized replacement text only>",
        expected_replacements: 1,
      },
    };
  }
  if (!lineSpan && anchorReadAction && args.allowedActions.includes("read_file")) {
    compiledTemplates.compiled_anchor_read = anchorReadAction;
  }
  if (args.family === "required_verifier" && args.requiredVerifierCommands[0] && args.allowedActions.includes("run_command")) {
    compiledTemplates.compiled_required_verifier = {
      action: "run_command",
      input: { command: args.requiredVerifierCommands[0] },
    };
  }
  if (Object.keys(compiledTemplates).length === 0) return null;
  return {
    summary_version: "repair_action_compiler_v1",
    authority: "runtime_execution_scaffold",
    promotion_state: "none",
    source: "policy_block_recovery",
    current_step: lineSpan
      ? "emit_compiled_localized_write"
      : anchorReadAction
        ? "refresh_current_anchor"
        : args.family === "required_verifier"
          ? "run_required_verifier"
          : "compile_from_runtime_next_action",
    target_files: targetFiles,
    diagnostic: diagnostic ?? null,
    diagnostic_kind: diagnosticKind ?? null,
    anchor_state: lineSpan
      ? {
          status: "current_read_anchor_available",
          source_read_step: lineSpan.source_read_step,
          path: lineSpan.path,
          start_line: lineSpan.start_line,
          end_line: lineSpan.end_line,
        }
      : anchorReadAction
        ? {
            status: "current_read_anchor_required",
            path: diagnosticPath,
            line: diagnosticLine,
          }
        : { status: "no_line_anchor" },
    compiled_preferred_action: lineSpan && args.allowedActions.includes("replace_lines")
      ? "replace_lines"
      : lineSpan && args.allowedActions.includes("replace_text")
        ? "replace_text"
        : anchorReadAction && args.allowedActions.includes("read_file")
          ? "read_file"
          : args.requiredVerifierCommands[0] && args.allowedActions.includes("run_command")
            ? "run_command"
            : null,
    compiled_action_templates: compiledTemplates,
    compiler_guards: [
      "preserve compiled template path/start_line/end_line/expected_old_lines/find exactly",
      "fill only replacement_lines or replace with the smallest localized repair",
      "do not expand the compiled span into a whole function, whole import block, whole file, or whole recent_read_evidence range",
      "the compiled action must change current content and must be followed by the required verifier when the repair phase allows a verifier",
      noDefaultExportModules.length > 0
        ? `do not introduce default imports for verifier-denied module(s): ${noDefaultExportModules.join(", ")}`
        : null,
      forbiddenNamedImports.length > 0
        ? `do not introduce verifier-denied named import binding(s): ${forbiddenNamedImports
            .map((entry) => {
              const moduleName = asString(entry.module);
              const symbol = asString(entry.symbol);
              return moduleName && symbol ? `${moduleName}.${symbol}` : null;
            })
            .filter((label): label is string => !!label)
            .join(", ")}`
        : null,
      diagnosticKind === "typescript_import_contract" || diagnosticKind === "typescript_unused_symbol"
        ? "if the replacement imports or declares a symbol, the same replacement must include non-import call-path usage unless the symbol is removed"
        : null,
    ].filter((guard): guard is string => !!guard),
    payload_limits: {
      max_replace_lines_old_lines: maxOldLines,
      max_replace_lines_replacement_lines: maxReplacementLines,
      max_apply_patch_hunks: args.outputBudget.max_apply_patch_hunks ?? null,
    },
    instruction: [
      "Compile the next repair into one concrete tool action shape before responding.",
      lineSpan ? "Use the compiled localized write template; preserve its anchor fields exactly." : null,
      !lineSpan && anchorReadAction ? "Current line anchor is missing; use the compiled anchor read exactly before another write." : null,
      args.requiredVerifierCommands[0] ? `Required verifier after repair: ${args.requiredVerifierCommands[0]}.` : null,
    ].filter(Boolean).join(" "),
  };
}

function buildPolicyBlockRecoveryMessage(args: {
  events: ToolEvent[];
  protocolErrorsThisStep: number;
  lastInvalidResponseExcerpt?: string | null;
  lastInvalidDetail?: string | null;
  sequencePolicy?: RuntimeSequencePolicy | null;
  task: EvalTask;
  workspaceDir: string;
}): string | null {
  const blockEvent = latestPolicyBlockEvent(args.events);
  const protocolRecoveryNextAction = !blockEvent && args.protocolErrorsThisStep > 0 && args.sequencePolicy
    ? sequencePolicyNextAction(args.sequencePolicy, args.events, args.workspaceDir)
    : null;
  if (!blockEvent && !protocolRecoveryNextAction) return null;
  const output = asObject(blockEvent?.output_signature) ?? {};
  const nextAction = protocolRecoveryNextAction ?? policyBlockRecoveryNextAction({
    events: args.events,
    sequencePolicy: args.sequencePolicy,
    workspaceDir: args.workspaceDir,
  });
  const family = policyBlockRecoveryActionFamily(nextAction);
  const files = policyBlockRecoveryFiles(nextAction);
  const readFiles = policyBlockRecoveryReadFiles(nextAction);
  const allowedActions = policyBlockRecoveryAllowedActions(nextAction, {
    protocolErrorsThisStep: args.protocolErrorsThisStep,
    lastInvalidResponseExcerpt: args.lastInvalidResponseExcerpt,
  });
  const runtimeNextAction = projectedRuntimeNextActionForRecovery(nextAction, allowedActions);
  const effectiveNextAction = runtimeNextAction ?? nextAction;
  const lockedRepairWrite = family === "locked_repair_write";
  const lockedRepairText = lockedRepairWrite && allowedActions.includes("replace_text");
  const lockedRepairLines = lockedRepairWrite && allowedActions.includes("replace_lines");
  const lockedRepairPatch = lockedRepairWrite && allowedActions.includes("apply_patch");
  const repeatedFailureConvergence = asObject(effectiveNextAction?.repeated_failure_convergence_v1);
  const lineDiagnosticRepair = asObject(effectiveNextAction?.line_diagnostic_repair_v1);
  const lineDiagnosticRequired = lineDiagnosticRepair?.required === true;
  const lockedRepairActionQuarantine = asObject(effectiveNextAction?.locked_repair_action_quarantine_v1);
  const lockedRepairPayloadQuarantine = asObject(effectiveNextAction?.locked_repair_payload_quarantine_v1);
  const editPhaseFailureBudget = asObject(effectiveNextAction?.edit_phase_failure_budget_v1);
  const importContractEvidence = asObject(effectiveNextAction?.import_contract_evidence_v1);
  const noDefaultExportModules = stringList(importContractEvidence?.no_default_export_modules);
  const forbiddenNamedImports = jsonObjectList(importContractEvidence?.forbidden_named_imports);
  const forbiddenNamedImportLabels = forbiddenNamedImports
    .map((entry) => {
      const moduleName = asString(entry.module);
      const symbol = asString(entry.symbol);
      return moduleName && symbol ? `${moduleName}.${symbol}` : null;
    })
    .filter((label): label is string => !!label);
  const lockedRepairLineDiagnostic = family === "locked_repair" && lineDiagnosticRepair?.required === true;
  const sourceWorkflowRepair = lockedRepairWrite
    && repeatedFailureConvergence?.required === true
    && asString(repeatedFailureConvergence.escalation_kind) === "same_file_source_workflow"
    && !lineDiagnosticRequired;
  const compactLockedRepairSpan = asObject(effectiveNextAction?.locked_repair_compact_span_v1);
  const compactLockedRepairSpanRequired = compactLockedRepairSpan?.required === true
    || (args.protocolErrorsThisStep > 0 && likelyIncompleteJsonResponse(args.lastInvalidResponseExcerpt) && sourceWorkflowRepair && allowedActions.includes("replace_lines"));
  const localLineDiagnosticRepair = lineDiagnosticRequired && !sourceWorkflowRepair;
  const semanticCandidateTrial = asObject(effectiveNextAction?.semantic_candidate_trial);
  const repairWriteAnchorEscalation = asObject(effectiveNextAction?.repair_write_anchor_escalation_v1);
  const forbiddenFailedFindSpans = stringList(repairWriteAnchorEscalation?.forbidden_failed_find_spans);
  const packageDependencyMigration = asObject(effectiveNextAction?.package_dependency_migration_template_v1);
  const packageDependencyActionTemplate = asObject(packageDependencyMigration?.action_template);
  const repairWriteLines = family === "repair_write" && allowedActions.includes("replace_lines");
  const repairWritePatch = family === "repair_write" && allowedActions.includes("apply_patch");
  const outputBudget = policyRecoveryOutputBudget({
    family,
    allowedActions,
    sourceWorkflowRepair,
    lineDiagnosticRepair: localLineDiagnosticRepair,
    packageDependencyMigration: !!packageDependencyActionTemplate,
    compactLockedRepairSpan: compactLockedRepairSpanRequired,
    protocolErrorsThisStep: args.protocolErrorsThisStep,
    lastInvalidResponseExcerpt: args.lastInvalidResponseExcerpt,
  });
  const recentReads = recentReadEvidenceForPolicyBlockRecovery(
    args.events,
    uniqueStringValues([files, readFiles], 24),
    family === "repair_write" || family === "non_noop_repair" || lockedRepairWrite
      ? {
          maxEvents: compactLockedRepairSpanRequired ? 2 : sourceWorkflowRepair ? 4 : 2,
          maxContentChars: args.protocolErrorsThisStep > 0
            ? compactLockedRepairSpanRequired ? 1800 : sourceWorkflowRepair ? 4200 : lockedRepairWrite ? 1800 : 2200
            : compactLockedRepairSpanRequired ? 2200 : sourceWorkflowRepair ? 6500 : lockedRepairWrite ? 2200 : 3000,
        }
      : { maxEvents: 4, maxContentChars: 4000 },
  );
  const firstFile = files[0] ?? "<allowed file>";
  const latestRead = recentReads[recentReads.length - 1] ?? {};
  const requiredVerifierCommands = stringList(effectiveNextAction?.commands);
  const verifierCommand = commandWithRuntimePlaceholders(args.task.verifier.command, args.workspaceDir);
  const actionSynthesisPlan = actionSynthesisPlanForPolicyRecovery({
    nextAction: effectiveNextAction,
    family,
    allowedActions,
    files,
    readFiles,
    outputBudget,
    recentReads,
    requiredVerifierCommands,
  });
  const repairActionCompiler = repairActionCompilerForPolicyRecovery({
    nextAction: effectiveNextAction,
    family,
    allowedActions,
    files,
    readFiles,
    outputBudget,
    recentReads,
    requiredVerifierCommands,
  });
  const validResponseExamples: JsonObject = {};
  if (allowedActions.includes("replace_lines")) {
    validResponseExamples.replace_lines = {
      action: "replace_lines",
      input: {
        path: firstFile,
        start_line: 10,
        end_line: 12,
        expected_old_lines: ["old line 10", "old line 11", "old line 12"],
        replacement_lines: ["new line 10", "new line 11", "new line 12"],
      },
    };
  }
  if (allowedActions.includes("replace_text")) {
    validResponseExamples.replace_text = {
      action: "replace_text",
      input: {
        path: firstFile,
        find: "exact current text",
        replace: "exact replacement text",
        expected_replacements: 1,
      },
    };
  }
  if (allowedActions.includes("apply_patch")) {
    validResponseExamples.apply_patch = {
      action: "apply_patch",
      input: {
        patch: `--- a/${firstFile}\n+++ b/${firstFile}\n@@\n-<old lines copied from recent_read_evidence>\n+<new lines>`,
      },
    };
  }
  if (allowedActions.includes("read_file")) {
    validResponseExamples.read_file = {
      action: "read_file",
      input: {
        path: firstFile,
        start_line: 1,
        end_line: 80,
      },
    };
  }
  if (allowedActions.includes("search")) {
    validResponseExamples.search = {
      action: "search",
      input: {
        query: "exact symbol or contract text",
        glob: firstFile,
      },
    };
  }
  if (allowedActions.includes("run_command")) {
    validResponseExamples.run_command = {
      action: "run_command",
      input: {
        command: requiredVerifierCommands[0] ?? "npm test",
      },
    };
  }
  return JSON.stringify({
    runtime_policy_block_recovery_mode_v1: {
      active: true,
      task_goal: {
        task_id: args.task.id,
        title: args.task.title ?? args.task.id,
        prompt: truncate(args.task.prompt, args.protocolErrorsThisStep > 0 ? 450 : 1400),
        verifier_command: verifierCommand,
      },
      trigger: {
        blocked_step: blockEvent?.step_index ?? null,
        blocked_tool: blockEvent?.tool_name ?? "llm_protocol",
        error: truncate(
          asString(output.sequence_policy_error)
            ?? asString(output.package_dependency_lock_error)
            ?? asString(output.verification_cadence_error)
            ?? asString(output.verifier_failure_lock_error)
            ?? asString(output.cognitive_entropy_probe_error)
            ?? asString(output.error)
            ?? args.lastInvalidDetail
            ?? "",
          500,
        ),
      },
      protocol_repair:
        args.protocolErrorsThisStep > 0
          ? {
              previous_invalid_json_count_this_step: args.protocolErrorsThisStep,
              previous_invalid_detail: args.lastInvalidDetail ?? null,
              previous_invalid_response_excerpt: truncate(args.lastInvalidResponseExcerpt ?? "", 700),
              likely_truncated_json: likelyIncompleteJsonResponse(args.lastInvalidResponseExcerpt),
            }
          : null,
      runtime_next_action: runtimeNextAction,
      forced_action_family: family,
      allowed_actions: allowedActions,
      allowed_files: files,
      allowed_read_files: readFiles,
      output_budget: outputBudget,
      action_synthesis_plan_v1: actionSynthesisPlan,
      ...(repairActionCompiler ? { repair_action_compiler_v1: repairActionCompiler } : {}),
      forbidden_actions:
        lockedRepairWrite
          ? uniqueStringValues([
              "list_files",
              "search",
              "read_file",
              "run_command",
              "finish",
              allowedActions.includes("apply_patch") ? null : "apply_patch",
              allowedActions.includes("replace_lines") ? null : "replace_lines",
              allowedActions.includes("replace_text") ? null : "replace_text",
            ].filter((action): action is string => !!action), 16)
          : lockedRepairLineDiagnostic
            ? uniqueStringValues([
                "list_files",
                "search",
                "run_command",
                "finish",
                allowedActions.includes("apply_patch") ? null : "apply_patch",
                allowedActions.includes("replace_lines") ? null : "replace_lines",
                allowedActions.includes("read_file") ? null : "read_file",
                "replace_text",
              ].filter((action): action is string => !!action), 16)
          : family === "repair_write"
            ? uniqueStringValues([
                "list_files",
                "search",
                "read_file",
                "run_command",
                "finish",
                allowedActions.includes("replace_lines") ? null : "replace_lines",
                allowedActions.includes("apply_patch") ? null : "apply_patch",
                allowedActions.includes("replace_text") ? null : "replace_text",
              ].filter((action): action is string => !!action), 16)
          : family === "non_noop_repair"
            ? ["list_files", "search", "read_file", "run_command", "finish"].concat(
                allowedActions.includes("replace_text") ? ["replace_lines", "apply_patch"] : ["replace_text"],
              )
          : family === "edit_anchor_read"
            ? ["list_files", "search", "replace_lines", "replace_text", "apply_patch", "run_command", "finish"]
          : family === "counterfactual_probe"
            ? uniqueStringValues([
                "list_files",
                "replace_lines",
                "replace_text",
                "apply_patch",
                "run_command",
                "finish",
                allowedActions.includes("read_file") ? null : "read_file",
                allowedActions.includes("search") ? null : "search",
              ].filter((action): action is string => !!action), 16)
          : ["list_files", "search", "finish"],
      response_contract: [
        "Return exactly one raw JSON object and nothing else.",
        "Your response is a tool call, not an answer to the task and not a summary of the policy document.",
        "Do not explain the blocked action.",
        "If trigger.error says Runtime rejected the previous payload, that exact payload pattern is forbidden; change strategy to satisfy trigger.error instead of retrying it.",
        "Do not include markdown, prose, labels, comments, or code fences.",
        "Use exactly this top-level shape: {\"action\":\"replace_lines|replace_text|apply_patch|read_file|search|run_command\",\"input\":{...}}.",
        "Never return runtime_policy_block_recovery_mode_v1, task_goal, analysis, plan, summary, or reasoning keys.",
        "Obey output_budget. The JSON must be compact and complete; do not emit whole-file, whole-import-block, or whole-read-range payloads.",
        "Before emitting the tool JSON, reduce the action through action_synthesis_plan_v1.current_step and quality_gates.",
        "If an action_synthesis_plan_v1 quality gate cannot be met, choose the allowed read/verifier action instead of a malformed, stale, no-op, or oversized write.",
        repairActionCompiler
          ? "If repair_action_compiler_v1.compiled_action_templates contains a template for an allowed action, use that compiled template before generic action_templates."
          : null,
        repairActionCompiler
          ? "For compiled write templates, preserve path/start_line/end_line/expected_old_lines/find exactly; fill only replacement_lines or replace with the localized repair."
          : null,
        allowedActions.includes("apply_patch") && !localLineDiagnosticRepair
          ? "Prefer apply_patch when it can express the allowed-file edit in fewer tokens than replace_lines or replace_text."
          : null,
        args.protocolErrorsThisStep > 0 && likelyIncompleteJsonResponse(args.lastInvalidResponseExcerpt)
          ? "The previous action JSON was discarded because it was incomplete. Return a smaller complete JSON object now; first byte { and final byte }."
          : null,
        lockedRepairWrite
          ? `The only allowed action is one of: ${allowedActions.join(", ") || "the listed allowed action"}. Do not emit any forbidden action or more than one action.`
          : null,
        family === "counterfactual_probe"
          ? `The next action must be exactly one bounded cognitive entropy probe using ${allowedActions.join(" or ")} on allowed_read_files: ${readFiles.join(", ")}. Do not write, run commands, list files, finish, or probe outside these files.`
          : null,
        noDefaultExportModules.length > 0
          ? `Verifier evidence forbids default imports for these modules: ${noDefaultExportModules.join(", ")}. Do not include any default import syntax for them anywhere in the payload.`
          : null,
        forbiddenNamedImportLabels.length > 0
          ? `Verifier evidence forbids these named import bindings: ${forbiddenNamedImportLabels.join(", ")}. Do not include those named imports anywhere in the payload.`
          : null,
        sourceWorkflowRepair
          ? compactLockedRepairSpanRequired
            ? "This is a same-file source workflow escalation under compact span mode. Make one small semantic step inside the owning implementation path; imports/helpers must remain connected to verifier-exercised code, and unused placeholders are forbidden."
            : "This is a same-file source workflow escalation. Do not make another local toggle. Rewrite the coherent owning implementation block so imports/helpers are actually connected to the verifier-exercised call path, and remove unused placeholders."
          : null,
        compactLockedRepairSpanRequired
          ? "Compact span mode is active. Your replace_lines range length must equal expected_old_lines.length and both must be <= output_budget.max_replace_lines_old_lines; replacement_lines.length must be <= output_budget.max_replace_lines_replacement_lines."
          : null,
        lockedRepairActionQuarantine
          ? asString(lockedRepairActionQuarantine.instruction)
          : null,
        lockedRepairPayloadQuarantine
          ? asString(lockedRepairPayloadQuarantine.instruction)
          : null,
        editPhaseFailureBudget
          ? [
              asString(editPhaseFailureBudget.instruction),
              `This overrides any nested runtime_next_action instruction that names an action outside allowed_actions: ${allowedActions.join(", ")}.`,
            ].filter(Boolean).join(" ")
          : null,
        localLineDiagnosticRepair
          ? "This is a verifier line-diagnostic repair. Stay on runtime_next_action.line_diagnostic_repair_v1.diagnostics and output_line_hints; do not search, broaden scope, rerun the verifier before a write, or edit unrelated lines."
          : null,
        localLineDiagnosticRepair
          ? asString(lineDiagnosticRepair.instruction)
          : null,
        family === "repair_write"
          ? `The only allowed action is one of: ${allowedActions.join(", ") || "replace_text"}. Do not emit forbidden actions, run_command, read_file, finish, or more than one action.`
          : null,
        family === "repair_write" && packageDependencyActionTemplate
          ? "A package dependency migration template is provided. Return runtime_next_action.package_dependency_migration_template_v1.action_template exactly; do not invent a shorter partial package edit."
          : null,
        family === "repair_write" && repairWriteAnchorEscalation
          ? asString(repairWriteAnchorEscalation.instruction)
          : null,
        family === "repair_write" && forbiddenFailedFindSpans.length > 0
          ? `Forbidden stale find spans for this repair step: ${JSON.stringify(forbiddenFailedFindSpans)}. Do not put any of these strings in replace_text.find or reproduce the same stale edit through another tool.`
          : null,
        family === "repair_write" && semanticCandidateTrial
          ? allowedActions.includes("replace_text") && allowedActions.length === 1
            ? "This is a semantic candidate trial. Apply one minimal replace_text edit that directly tests runtime_next_action.semantic_candidate_trial.suggested_actions on allowed_files, unless current evidence disproves the candidate. Do not rewrite unrelated blocks."
            : "This is a semantic candidate trial. Apply one compact write that directly tests runtime_next_action.semantic_candidate_trial.suggested_actions on allowed_files, unless current evidence disproves the candidate. Do not rewrite unrelated blocks."
          : null,
        lockedRepairLines
          ? sourceWorkflowRepair
            ? compactLockedRepairSpanRequired
              ? "Use numeric start_line/end_line for one narrow contiguous span inside recent_read_evidence. Do not use latestRead.start_line/latestRead.end_line as the whole requested range; choose only the exact lines being changed."
              : "Use numeric start_line/end_line and exact expected_old_lines copied from recent_read_evidence. replacement_lines may cover only the focused workflow hunk, must stay under output_budget.max_replace_lines_replacement_lines, and must not repeat a whole function or whole read range."
            : "Use numeric start_line/end_line and exact expected_old_lines copied from recent_read_evidence. Keep replacement_lines focused and under 30 lines."
          : null,
        lockedRepairPatch
          ? lockedRepairPayloadQuarantine
            ? "If using apply_patch under payload quarantine, include both the import/helper contract and the non-import call-path usage in the same compact patch; do not emit an import/declaration-only patch."
            : "If using apply_patch, modify only allowed_files and keep the patch to directly required import/helper/call-path hunks within output_budget.max_apply_patch_hunks."
          : null,
        lockedRepairText
          ? "Use one compact replace_text insertion or localized span replacement copied from recent_read_evidence. Do not replace a whole implementation file, test file, function, or whole read range."
          : null,
        family === "repair_write"
          ? repairWriteLines
            ? "Use numeric start_line/end_line and exact expected_old_lines copied from recent_read_evidence. Keep replacement_lines focused and under 60 lines."
            : repairWritePatch
              ? "Use apply_patch only on allowed_files with a compact patch based on recent_read_evidence."
              : "Use a compact exact-span edit only: find and replace must be localized spans copied/adapted from recent_read_evidence, not whole functions or whole read ranges."
          : null,
        family === "repair_write" || lockedRepairWrite
          ? "The replacement must change current file content; identical/no-op edits are invalid."
          : null,
        family === "non_noop_repair"
          ? "The previous edit was rejected as a no-op. Return the same action family on the same allowed file, but choose one narrow subspan that actually changes behavior. Do not use the whole latest read range, whole function, or whole method body. Keep replace_lines spans small: at most 8 expected_old_lines and 16 replacement_lines."
          : null,
        family === "repair_write"
          ? "The next action must be a write action targeting allowed_files. Use the recent_read_evidence below; do not request another read."
          : null,
        family === "required_verifier"
          ? "The next action must run one required verifier command exactly."
          : null,
        family === "edit_anchor_read"
          ? "The next action must be exactly one narrow read_file on the provided path/range."
          : null,
        family === "non_noop_repair"
          ? "Do not return read_file, run_command, finish, or the same replacement content that was just rejected."
          : null,
        args.protocolErrorsThisStep > 0
          ? "The previous response for this same recovery step was invalid. Do not produce analysis. Emit only a valid action JSON matching action_templates."
          : null,
      ].filter(Boolean),
      action_templates:
        repairActionCompiler
          ? {
              compiled_repair_action: asObject(repairActionCompiler.compiled_action_templates),
            }
        : family === "repair_write" && packageDependencyActionTemplate
          ? {
              exact_package_dependency_migration: packageDependencyActionTemplate,
            }
          : lockedRepairLines
          ? {
              ...(lockedRepairPatch
                ? {
                    exact_locked_apply_patch: {
                      action: "apply_patch",
                      input: {
                        patch: `--- a/${firstFile}\n+++ b/${firstFile}\n@@\n-<old workflow/import lines copied from recent_read_evidence>\n+<coherent workflow/import repair lines>`,
                      },
                    },
                  }
                : {}),
              exact_locked_replace_lines: {
                action: "replace_lines",
                input: {
                  path: firstFile,
                  start_line: compactLockedRepairSpanRequired
                    ? "<narrow numeric start_line inside recent_read_evidence>"
                    : "<numeric start_line from latest recent_read_evidence>",
                  end_line: compactLockedRepairSpanRequired
                    ? "<start_line + expected_old_lines.length - 1; max output_budget.max_replace_lines_old_lines>"
                    : "<numeric end_line for the focused hunk, not the whole read range>",
                  expected_old_lines: compactLockedRepairSpanRequired
                    ? ["<1-8 exact current lines copied from latest recent_read_evidence>"]
                    : ["<exact current lines copied from latest recent_read_evidence>"],
                  replacement_lines: sourceWorkflowRepair
                    ? compactLockedRepairSpanRequired
                      ? ["<focused replacement lines, 1-16 lines>"]
                      : ["<focused coherent workflow replacement lines, under output_budget.max_replace_lines_replacement_lines>"]
                    : ["<complete replacement lines, focused and under 30 lines>"],
                },
              },
            }
          : lockedRepairPatch
            ? {
                exact_locked_apply_patch: {
                  action: "apply_patch",
                  input: {
                    patch: `--- a/${firstFile}\n+++ b/${firstFile}\n@@\n-<old workflow/import lines copied from recent_read_evidence>\n+<coherent workflow/import repair lines>`,
                  },
                },
              }
          : lockedRepairText
            ? {
                exact_locked_replace_text: {
                  action: "replace_text",
                  input: {
                    path: firstFile,
                    find: "<small exact current anchor copied from recent_read_evidence>",
                    replace: "<anchor plus focused inserted/replaced implementation or test change>",
                    expected_replacements: 1,
                  },
                },
              }
          : family === "edit_anchor_read"
            ? {
                exact_anchor_read: {
                  action: "read_file",
                  input: {
                    path: firstFile,
                    start_line: effectiveNextAction?.start_line ?? "<start_line from runtime_next_action>",
                    end_line: effectiveNextAction?.end_line ?? "<end_line from runtime_next_action>",
                  },
                },
              }
          : family === "repair_write"
          ? repairWriteLines
            ? {
                ...(repairWritePatch
                  ? {
                      exact_repair_apply_patch: {
                        action: "apply_patch",
                        input: {
                          patch: `--- a/${firstFile}\n+++ b/${firstFile}\n@@\n-<old lines copied from recent_read_evidence>\n+<focused repair lines>`,
                        },
                      },
                    }
                  : {}),
                exact_repair_replace_lines: {
                  action: "replace_lines",
                  input: {
                    path: firstFile,
                    start_line: latestRead.start_line ?? "<numeric start_line from latest recent_read_evidence>",
                    end_line: latestRead.end_line ?? "<numeric end_line from latest recent_read_evidence>",
                    expected_old_lines: ["<exact current lines copied from latest recent_read_evidence>"],
                    replacement_lines: ["<focused replacement lines, under 60 lines>"],
                  },
                },
              }
            : repairWritePatch
              ? {
                  exact_repair_apply_patch: {
                    action: "apply_patch",
                    input: {
                      patch: `--- a/${firstFile}\n+++ b/${firstFile}\n@@\n-<old lines copied from recent_read_evidence>\n+<focused repair lines>`,
                    },
                  },
                }
            : {
                exact_replace_text: {
                  action: "replace_text",
                  input: {
                    path: firstFile,
                    find: "<exact current span copied from recent_read_evidence>",
                    replace: semanticCandidateTrial
                      ? "<minimal localized candidate-trial replacement span>"
                      : "<complete localized replacement span>",
                    expected_replacements: 1,
                  },
                },
              }
          : family === "non_noop_repair" && allowedActions.includes("replace_text")
            ? {
                exact_non_noop_replace_text: {
                  action: "replace_text",
                  input: {
                    path: firstFile,
                    find: "<exact current span copied from recent_read_evidence>",
                    replace: "<different replacement span that changes behavior>",
                    expected_replacements: 1,
                  },
                },
              }
          : family === "non_noop_repair" && allowedActions.includes("replace_lines")
            ? {
                exact_non_noop_replace_lines: {
                  action: "replace_lines",
                  input: {
                    path: firstFile,
                    start_line: effectiveNextAction?.start_line ?? "<narrow numeric start_line inside latest recent_read_evidence>",
                    end_line: effectiveNextAction?.end_line ?? "<start_line + expected_old_lines.length - 1; max output_budget.max_replace_lines_old_lines>",
                    expected_old_lines:
                      (requiredStringArrayOrNull(effectiveNextAction?.actual_old_lines)?.slice(0, 8) ?? ["<at most 8 exact current lines copied from latest recent_read_evidence>"]),
                    replacement_lines: ["<different replacement lines that change behavior, at most 16 lines>"],
                  },
                },
              }
          : family === "counterfactual_probe"
            ? allowedActions.includes("search")
              ? {
                  exact_counterfactual_search: {
                    action: "search",
                    input: {
                      query: "<one exact symbol or contract term from current verifier evidence>",
                      glob: readFiles[0] ?? firstFile,
                    },
                  },
                  exact_counterfactual_read: {
                    action: "read_file",
                    input: {
                      path: readFiles[0] ?? firstFile,
                      start_line: 1,
                      end_line: 120,
                    },
                  },
                }
              : {
                  exact_counterfactual_read: {
                    action: "read_file",
                    input: {
                      path: readFiles[0] ?? firstFile,
                      start_line: 1,
                      end_line: 120,
                    },
                  },
                }
          : family === "ordered_action"
            ? { exact_ordered_action: { action: asString(effectiveNextAction?.action), input: { path: asString(effectiveNextAction?.path) } } }
            : family === "required_verifier"
              ? { exact_verifier: { action: "run_command", input: { command: requiredVerifierCommands[0] ?? "<required verifier command>" } } }
              : {},
      valid_response_examples: validResponseExamples,
      recent_read_evidence: recentReads,
      previous_invalid_json_count_this_step: args.protocolErrorsThisStep,
      previous_failed_action:
        family === "non_noop_repair" && blockEvent
          ? {
              action: blockEvent.tool_name,
              input: blockEvent.tool_input,
              forbidden_replacement: effectiveNextAction?.forbidden_replacement ?? null,
            }
          : null,
    },
  }, null, 2);
}

function buildSystemPromptForLlm(arm: AgentArm, policyBlockRecoveryActive: boolean): string {
  const base = buildSystemPrompt(arm);
  if (!policyBlockRecoveryActive) return base;
  return `${base}

Runtime policy block recovery mode is active:
- Output exactly one raw JSON tool call object only.
- The response is a tool call, not an explanation, answer, plan, summary, or copy of the recovery document.
- Use runtime_policy_block_recovery_mode_v1 as evidence-focused recovery context: allowed_actions, allowed_files, forbidden_actions, response_contract, recent evidence, and output_budget describe the safe operating boundary.
- Stay inside explicit edit boundaries and avoid repeating the failed action blindly.
- The LLM/Agent still owns semantic repair choice; Runtime recovery context is guidance and authority metadata, not a repository-specific repair script.`;
}

function policyBlockRecoveryMaxTokens(args: {
  events: ToolEvent[];
  sequencePolicy?: RuntimeSequencePolicy | null;
  workspaceDir: string;
  protocolErrorsThisStep: number;
  lastInvalidResponseExcerpt?: string | null;
}): number {
  const blockEvent = latestPolicyBlockEvent(args.events);
  const protocolRecoveryNextAction = !blockEvent && args.protocolErrorsThisStep > 0 && args.sequencePolicy
    ? sequencePolicyNextAction(args.sequencePolicy, args.events, args.workspaceDir)
    : null;
  const output = asObject(blockEvent?.output_signature);
  const nextAction = protocolRecoveryNextAction ?? policyBlockRecoveryNextAction({
    events: args.events,
    sequencePolicy: args.sequencePolicy,
    workspaceDir: args.workspaceDir,
  }) ?? asObject(output?.sequence_policy_next_action)
    ?? asObject(output?.edit_operation_next_action);
  const family = policyBlockRecoveryActionFamily(nextAction);
  if (family === "counterfactual_probe") return 420;
  if (family === "edit_anchor_read" || family === "required_verifier") return 220;
  const allowedActions = policyBlockRecoveryAllowedActions(nextAction, {
    protocolErrorsThisStep: args.protocolErrorsThisStep,
    lastInvalidResponseExcerpt: args.lastInvalidResponseExcerpt,
  });
  const retryAfterLikelyTruncation = args.protocolErrorsThisStep > 0
    && likelyIncompleteJsonResponse(args.lastInvalidResponseExcerpt);
  const repeatedFailureConvergence = asObject(nextAction?.repeated_failure_convergence_v1);
  if (
    family === "locked_repair_write"
    && repeatedFailureConvergence?.required === true
    && asString(repeatedFailureConvergence.escalation_kind) === "same_file_source_workflow"
  ) {
    const compactSpan = asObject(nextAction?.locked_repair_compact_span_v1);
    if (retryAfterLikelyTruncation) {
      if (allowedActions.includes("apply_patch")) return 4200;
      if (allowedActions.includes("replace_text")) return 1600;
      return 900;
    }
    if (compactSpan?.required === true && allowedActions.includes("replace_lines")) return 900;
    if (allowedActions.includes("apply_patch")) return 4200;
    if (allowedActions.includes("replace_text")) return 1800;
    return 1400;
  }
  if (family === "locked_repair_write") {
    if (retryAfterLikelyTruncation) {
      if (allowedActions.includes("apply_patch")) return 4200;
      return allowedActions.includes("replace_lines") ? 900 : 1200;
    }
    return allowedActions.includes("apply_patch") ? 4200 : allowedActions.includes("replace_lines") ? 2200 : 1200;
  }
  if (family === "repair_write" && asObject(nextAction?.package_dependency_migration_template_v1)) return 5200;
  if (family === "repair_write") {
    if (retryAfterLikelyTruncation) {
      if (allowedActions.includes("apply_patch")) return 3600;
      return allowedActions.includes("replace_lines") ? 2600 : 2000;
    }
    return allowedActions.includes("apply_patch") ? 3000 : 1000;
  }
  if (family === "non_noop_repair") return retryAfterLikelyTruncation ? 650 : 700;
  return 700;
}

function compactFailedToolCalls(run: AgentRun, limit = 5): JsonObject[] {
  return failedToolCalls(run)
    .filter((call) => call.tool_name !== "llm_call" && call.tool_name !== "llm_protocol")
    .slice(-limit)
    .map((call) => {
      const output = asObject(call.output_signature);
      const result = asObject(output?.result);
      return {
        step_index: call.step_index,
        tool_name: call.tool_name,
        touched_files: call.touched_files,
        write_files: call.write_files,
        error: asString(output?.error),
        schema_correction: asString(output?.schema_correction),
        sequence_policy_error: asString(output?.sequence_policy_error),
        package_dependency_lock_error: asString(output?.package_dependency_lock_error),
        cognitive_entropy_probe_error: asString(output?.cognitive_entropy_probe_error),
        candidate_trial_stagnation_stop_v1: asObject(output?.candidate_trial_stagnation_stop_v1),
        tool_payload_exhaustion_stop_v1: asObject(output?.tool_payload_exhaustion_stop_v1),
        edit_operation_next_action: asObject(output?.edit_operation_next_action),
        edit_noop: output?.edit_noop === true,
        actual_old_lines: requiredStringArrayOrNull(output?.actual_old_lines)?.slice(0, 12),
        requested_start_line: typeof output?.requested_start_line === "number" ? output.requested_start_line : null,
        requested_end_line: typeof output?.requested_end_line === "number" ? output.requested_end_line : null,
        stdout_diagnostics: diagnosticLines(asString(result?.stdout) ?? "", 4),
        stderr_diagnostics: diagnosticLines(asString(result?.stderr) ?? "", 4),
      };
    });
}

function codeRepairFailureCategories(categories: string[]): string[] {
  const nonCodeRepairCategories = new Set([
    "llm_api_error",
    "llm_call_failure",
    "llm_protocol_error",
    "provider_failure",
    "tool_protocol_failure",
  ]);
  return uniqueStringValues(
    categories.filter((category) => !nonCodeRepairCategories.has(category)),
    32,
  );
}

function codeRepairMetricsForRuntimeContext(run: AgentRun): JsonObject {
  return {
    ...(run.metrics as unknown as JsonObject),
    failure_categories: codeRepairFailureCategories(run.metrics.failure_categories),
    provider_protocol_diagnostics: {
      llm_api_error_count: run.metrics.llm_api_error_count,
      llm_protocol_error_count: run.metrics.llm_protocol_error_count,
      llm_protocol_repair_count: run.metrics.llm_protocol_repair_count,
      runtime_learning_quarantine_reason: run.metrics.runtime_learning_quarantine_reason,
    },
  };
}

function compactPriorRunRepairEvidence(run: AgentRun): JsonObject {
  return {
    schema_version: "aionis_direct_prior_repair_evidence_v1",
    arm: run.arm,
    ...(run.attempt ? { attempt: run.attempt } : {}),
    status: run.status,
    verifier_passed: run.metrics.verifier_passed,
    failure_categories: codeRepairFailureCategories(uniqueStringValues([
      run.metrics.failure_categories,
      failureCategoriesFromCommandText(run.verifier.stderr, run.verifier.stdout),
    ], 32)),
    provider_protocol_diagnostics: {
      llm_api_error_count: run.metrics.llm_api_error_count,
      llm_protocol_error_count: run.metrics.llm_protocol_error_count,
      llm_protocol_repair_count: run.metrics.llm_protocol_repair_count,
      runtime_learning_quarantine_reason: run.metrics.runtime_learning_quarantine_reason,
    },
    verifier: {
      command: run.verifier.command,
      exit_code: run.verifier.exit_code,
      timed_out: run.verifier.timed_out,
      stdout_diagnostics: diagnosticLines(run.verifier.stdout, 6),
      stderr_diagnostics: diagnosticLines(run.verifier.stderr, 12),
    },
    runtime_signals: {
      tool_step_count: run.metrics.tool_step_count,
      retry_count: run.metrics.retry_count,
      verifier_command_run_count: run.metrics.verifier_command_run_count,
      policy_block_recovery_mode_count: run.metrics.policy_block_recovery_mode_count,
      first_action_sequence_policy_block_count: run.metrics.first_action_sequence_policy_block_count,
      first_action_sequence_followed: run.metrics.first_action_sequence_followed,
      repair_second_write_present: run.metrics.repair_second_write_present,
      repair_second_write_satisfied: run.metrics.second_repair_file_write_step !== null,
      cognitive_entropy_counterfactual_probe_attempted: run.metrics.cognitive_entropy_counterfactual_probe_attempted,
      candidate_execution_operator_present: run.metrics.candidate_execution_operator_present,
      candidate_execution_operator_candidate_count: run.metrics.candidate_execution_operator_candidate_count,
    },
    failed_tool_calls: compactFailedToolCalls(run),
    semantic_candidate_producer: run.semantic_candidate_producer
      ? {
          outcome_version: run.semantic_candidate_producer.outcome_version,
          status: run.semantic_candidate_producer.status,
          reason: run.semantic_candidate_producer.reason,
          source_phase: run.semantic_candidate_producer.source_phase,
          candidate_count: run.semantic_candidate_producer.candidates.length,
          usable_candidate_count: run.learning_control_candidates?.length ?? 0,
          errors: run.semantic_candidate_producer.errors,
        }
      : null,
    learning_control_candidates: run.learning_control_candidates ?? [],
  };
}

function compactSuccessfulRunReplayEvidence(run: AgentRun): JsonObject {
  return {
    schema_version: "aionis_direct_success_replay_evidence_v1",
    arm: run.arm,
    ...(run.attempt ? { attempt: run.attempt } : {}),
    status: run.status,
    verifier_passed: run.metrics.verifier_passed,
    verifier_command: run.verifier.command,
    edited_files: run.metrics.edited_files,
    touched_files: run.metrics.touched_files,
    first_write_step: run.metrics.first_write_step,
    first_target_write_step: run.metrics.first_target_write_step,
    tool_step_count: run.metrics.tool_step_count,
    positive_patch_evidence: run.positive_patch_evidence ?? null,
  };
}

function directPriorRepairEvidence(aionisContext: JsonObject | null): JsonObject[] {
  const evidence = Array.isArray(aionisContext?.direct_prior_repair_evidence)
    ? aionisContext?.direct_prior_repair_evidence
    : [];
  return evidence
    .map((entry) => asObject(entry))
    .filter((entry): entry is JsonObject => !!entry);
}

function learningControlSemanticCandidatesFromEvidence(evidence: JsonObject[], task: EvalTask | null | undefined): JsonObject[] {
  const candidates: JsonObject[] = [];
  const taskText = taskTextForGuidance(task);
  const seen = new Set<string>();
  const contestedSignatures = candidateTrialStagnationSignaturesFromEvidence(evidence);
  for (const entry of [...evidence].reverse()) {
    const values = Array.isArray(entry.learning_control_candidates) ? entry.learning_control_candidates : [];
    for (const value of values) {
      const candidate = asObject(value);
      if (!candidate) continue;
      if (asString(candidate.candidate_version) !== "learning_control_semantic_repair_candidate_v1") continue;
      const adjudication = asObject(candidate.runtime_adjudication);
      if (adjudication?.usable_as_next_attempt_guidance !== true) continue;
      const text = [
        asString(candidate.semantic_hypothesis),
        asString(candidate.contract_kind),
        ...stringList(candidate.suggested_actions),
        ...stringList(candidate.target_files),
      ].filter((part): part is string => !!part).join("\n");
      if (taskText && !repairActionMatchesTask(text, task)) continue;
      const signature = semanticCandidateSignature(candidate);
      const scopeSignature = semanticCandidateScopeSignature(candidate);
      if (seen.has(signature)) continue;
      seen.add(signature);
      const contested = contestedSignatures.has(signature) || contestedSignatures.has(scopeSignature);
      candidates.push(
        contested
          ? {
              ...candidate,
              candidate_counter_evidence_v1: {
                summary_version: "semantic_candidate_counter_evidence_v1",
                contested: true,
                reason: "candidate_trial_failed_real_verifier_after_multiple_writes",
                instruction:
                  "This candidate remains visible as counter-evidence, but Runtime should demote or rotate it before retrying the same trial path.",
              },
            }
          : candidate,
      );
    }
  }
  return candidates.slice(0, 3);
}

function candidateTrialStagnationSignaturesFromEvidence(evidence: JsonObject[]): Set<string> {
  const signatures = new Set<string>();
  for (const entry of evidence) {
    const failedCalls = Array.isArray(entry.failed_tool_calls) ? entry.failed_tool_calls : [];
    for (const call of failedCalls) {
      const stop = asObject(asObject(call)?.candidate_trial_stagnation_stop_v1);
      const signature = asString(stop?.active_candidate_signature);
      const scopeSignature = asString(stop?.active_candidate_scope_signature);
      if (signature) signatures.add(signature);
      if (scopeSignature) signatures.add(scopeSignature);
    }
  }
  return signatures;
}

function semanticCandidateTargetFiles(candidates: JsonObject[], allowedEditFiles: string[]): string[] {
  return uniqueStringValues(
    candidates.flatMap((candidate) => stringList(candidate.target_files))
      .filter((file) => allowedEditFiles.length === 0 || allowedEditFiles.includes(file)),
    12,
  );
}

function semanticCandidateGuidanceRules(candidates: JsonObject[]): string[] {
  const rules: string[] = [];
  for (const candidate of candidates) {
    const hypothesis = asString(candidate.semantic_hypothesis);
    const files = stringList(candidate.target_files);
    const actions = stringList(candidate.suggested_actions);
    const escapeCondition = asString(candidate.escape_condition);
    if (!hypothesis || files.length === 0 || actions.length === 0) continue;
    rules.push([
      `Candidate-only semantic repair hypothesis: ${hypothesis}`,
      `Candidate target files: ${files.join(", ")}.`,
      `Candidate suggested actions: ${actions.join(" ")}`,
      escapeCondition ? `Escape condition: ${escapeCondition}` : null,
      "Candidate trial protocol: after inspecting current target content and the implementation anchor, apply the smallest edit that directly tests this candidate unless current evidence disproves it; imports/helpers must be connected to the verifier-exercised call path in the same repair. Then rerun the required verifier. Do not promote this candidate or treat it as a reusable workflow unless a later real run passes the required verifier and regression/holdout evidence admits promotion.",
    ].filter((part): part is string => !!part).join(" "));
  }
  return uniqueStringValues(rules, 8);
}

function semanticCandidateTrialFromCandidates(candidates: JsonObject[], allowedFiles: string[]): JsonObject | null {
  for (const candidate of orderedSemanticCandidatesForTrial(candidates, allowedFiles)) {
    const targetFiles = stringList(candidate.target_files)
      .filter((file) => allowedFiles.length === 0 || allowedFiles.includes(file));
    const suggestedActions = stringList(candidate.suggested_actions);
    if (targetFiles.length === 0 || suggestedActions.length === 0) continue;
    const trialRole = semanticCandidateTrialRole(candidate);
    return {
      summary_version: "learning_control_semantic_candidate_trial_v1",
      authority: "candidate_trial",
      promotion_state: "candidate",
      trial_selection_v1: {
        summary_version: "semantic_candidate_trial_selection_v1",
        role: trialRole,
        reason:
          trialRole === "behavioral_implementation"
            ? "Behavioral implementation candidates are trialed before import/package scaffolding when they target the same repair window."
            : "Candidate matches the active repair window and remains candidate-only until verifier evidence accepts it.",
      },
      target_files: targetFiles,
      semantic_hypothesis: asString(candidate.semantic_hypothesis) ?? "",
      contract_kind: asString(candidate.contract_kind) ?? "",
      evidence: stringList(candidate.evidence),
      suggested_actions: suggestedActions,
      escape_condition: asString(candidate.escape_condition) ?? "",
      instruction:
        "Trial this candidate only inside target_files: inspect current content and the implementation anchor, apply the smallest edit that directly tests suggested_actions unless current evidence disproves it, and connect imports/helpers to the verifier-exercised call path in the same repair. Then rerun the required verifier. This is not workflow promotion.",
    };
  }
  return null;
}

function semanticCandidateTrialStrategy(args: {
  candidates: JsonObject[];
  allowedFiles: string[];
  requiredVerifiers: string[];
  verifierFailurePhase: JsonObject | null;
}): JsonObject | null {
  const trial = semanticCandidateTrialFromCandidates(args.candidates, args.allowedFiles);
  if (!trial) return null;
  const targetFiles = stringList(trial.target_files);
  const verifier = args.requiredVerifiers[0] ?? null;
  return {
    summary_version: "learning_control_candidate_trial_strategy_v1",
    authority: "candidate_trial",
    promotion_state: "candidate",
    priority: "active_when_current_evidence_matches",
    source_phase: asString(args.verifierFailurePhase?.phase) ?? null,
    target_files: targetFiles,
    candidate_trial: trial,
    required_sequence: [
      targetFiles.length > 0 ? `Inspect current candidate target file(s): ${targetFiles.join(", ")}.` : null,
      "Apply one non-noop implementation edit that directly tests candidate_trial.suggested_actions.",
      verifier ? `Run required verifier immediately after the candidate edit: ${verifier}.` : "Run the required verifier immediately after the candidate edit.",
      "Keep the candidate only if the required verifier moves forward; otherwise reclassify from the new verifier evidence.",
    ].filter((step): step is string => !!step),
    escape_conditions: uniqueStringValues([
      asString(trial.escape_condition),
      "If current file evidence disproves the candidate target or action, do not force it.",
      "If the next verifier output names a different phase, file, provider failure, or tool protocol failure, stop applying this candidate and reclassify from fresh evidence.",
    ], 6),
    instruction:
      "Use this as a bounded experiment, not as a promoted workflow: read candidate target evidence, make one smallest non-noop candidate edit, run the required verifier, and let verifier evidence accept, reject, or mutate the candidate.",
  };
}

function directPriorSuccessEvidence(aionisContext: JsonObject | null): JsonObject[] {
  const evidence = Array.isArray(aionisContext?.direct_success_replay_evidence)
    ? aionisContext?.direct_success_replay_evidence
    : [];
  return evidence
    .map((entry) => asObject(entry))
    .filter((entry): entry is JsonObject => !!entry);
}

function directRepairEvidenceForPhase(evidence: JsonObject[]): JsonObject[] {
  const eligible = evidence.filter((entry) => {
    const providerDiagnostics = asObject(entry.provider_protocol_diagnostics);
    return !asString(providerDiagnostics?.runtime_learning_quarantine_reason)
      && !stringList(entry.failure_categories).includes("tool_protocol_failure")
      && !stringList(entry.failure_categories).includes("llm_protocol_fatal");
  });
  const selected = eligible.at(-1) ?? evidence.at(-1) ?? null;
  return selected ? [selected] : [];
}

function successReplayPatchEntriesFromEvidence(evidence: JsonObject[]): JsonObject[] {
  const entries: JsonObject[] = [];
  const seenPatches = new Set<string>();
  for (const contract of evidence) {
    const patchEvidence = asObject(contract.positive_patch_evidence);
    const patches = Array.isArray(patchEvidence?.patches) ? patchEvidence.patches : [];
    const contractEntries: JsonObject[] = [];
    let rejectedReason: string | null = null;
    for (const patchEntry of patches) {
      const object = asObject(patchEntry);
      const rel = asString(object?.path);
      const patch = asString(object?.patch);
      if (!object || !rel || !patch) continue;
      const canonicalPatch = canonicalWorkspacePatchForPath(patch, rel);
      if (seenPatches.has(canonicalPatch)) continue;
      rejectedReason = patchReplayRejectReason(canonicalPatch);
      if (rejectedReason) break;
      contractEntries.push({
        path: rel,
        patch: canonicalPatch,
      });
    }
    if (rejectedReason) continue;
    for (const entry of contractEntries) {
      const patch = asString(entry.patch);
      if (!patch || seenPatches.has(patch)) continue;
      seenPatches.add(patch);
      entries.push(entry);
    }
  }
  return entries;
}

function orderedSuccessReplayEvidence(evidence: JsonObject[]): JsonObject[] {
  const candidates = evidence
    .map((entry, index) => ({
      entry,
      index,
      patchCount: successReplayPatchEntriesFromEvidence([entry]).length,
      toolStepCount: numeric(entry.tool_step_count) || Number.MAX_SAFE_INTEGER,
      firstWriteStep: numeric(entry.first_write_step) || Number.MAX_SAFE_INTEGER,
    }))
    .filter((candidate) => candidate.patchCount > 0 && candidate.entry.verifier_passed === true);
  candidates.sort((left, right) => (
    left.toolStepCount - right.toolStepCount
    || left.firstWriteStep - right.firstWriteStep
    || right.index - left.index
  ));
  return candidates.map((candidate) => candidate.entry);
}

function successReplayPatchPlanCandidatesFromGuidance(guidance: JsonObject | null | undefined): SuccessReplayPatchPlan[] {
  const replay = asObject(guidance?.direct_success_replay_evidence_v1);
  const contracts = Array.isArray(replay?.replay_contracts) ? replay.replay_contracts : [];
  const evidence = contracts
    .map((entry) => asObject(entry))
    .filter((entry): entry is JsonObject => !!entry);
  return orderedSuccessReplayEvidence(evidence).map((selected) => {
    const patches = successReplayPatchEntriesFromEvidence([selected]);
    const patchText = patches
      .map((entry) => asString(entry.patch))
      .filter((patch): patch is string => !!patch)
      .map(normalizeUnifiedDiffPatch)
      .join("\n");
    const selectedPatchEvidence = asObject(selected.positive_patch_evidence);
    const files = uniqueStringValues([
      stringList(selectedPatchEvidence?.changed_files),
      patches.map((entry) => asString(entry.path)),
      touchedFilesFromPatch(patchText),
    ], 64);
    return {
      patch: patchText,
      patchCount: patches.length,
      files,
      sourceArm: asString(selected.arm),
      sourceAttempt: typeof selected.attempt === "number" ? selected.attempt : null,
      toolStepCount: numeric(selected.tool_step_count) || Number.MAX_SAFE_INTEGER,
      firstWriteStep: numeric(selected.first_write_step) || Number.MAX_SAFE_INTEGER,
    };
  }).filter((plan) => plan.patch.length > 0 && plan.patchCount > 0);
}

function successReplayPatchPlanFromGuidance(guidance: JsonObject | null | undefined): SuccessReplayPatchPlan | null {
  return successReplayPatchPlanCandidatesFromGuidance(guidance)[0] ?? null;
}

function directEvidenceTexts(evidence: JsonObject[]): string[] {
  const texts: string[] = [];
  for (const entry of evidence) {
    texts.push(...stringList(entry.failure_categories));
    const verifier = asObject(entry.verifier);
    texts.push(asString(verifier?.command) ?? "");
    texts.push(...stringList(verifier?.stdout_diagnostics));
    texts.push(...stringList(verifier?.stderr_diagnostics));
    const failedCalls = Array.isArray(entry.failed_tool_calls) ? entry.failed_tool_calls : [];
    for (const call of failedCalls) {
      const object = asObject(call);
      if (!object) continue;
      texts.push(asString(object.command) ?? "");
      texts.push(asString(object.error) ?? "");
      texts.push(asString(object.schema_correction) ?? "");
      texts.push(asString(object.sequence_policy_error) ?? "");
      const editOperationNextAction = asObject(object.edit_operation_next_action);
      texts.push(asString(editOperationNextAction?.instruction) ?? "");
      texts.push(asString(editOperationNextAction?.reason) ?? "");
      texts.push(...stringList(object.stdout_diagnostics));
      texts.push(...stringList(object.stderr_diagnostics));
    }
  }
  return texts.filter((text) => text.trim().length > 0);
}

function directBlockingAssertionsFromEvidence(evidence: JsonObject[]): string[] {
  const assertions: string[] = [];
  for (const text of directEvidenceTexts(evidence)) {
    const normalized = text
      .replace(/^AssertionError \[ERR_ASSERTION\]:\s*/i, "")
      .replace(/\s+at\s+.*$/, "")
      .trim();
    if (!normalized) continue;
    if (/Command is not allowed by this real-eval runner/i.test(normalized)) continue;
    if (!/must |expected promise to reject|expected .* to|should |not call|stop consuming|signal\.reason|AbortSignal|AbortController/i.test(normalized)) continue;
    assertions.push(normalized);
  }
  return uniqueStringValues(assertions, 12);
}

function successReplayActionsFromEvidence(evidence: JsonObject[]): string[] {
  const replayableEvidence = orderedSuccessReplayEvidence(evidence);
  if (replayableEvidence.length === 0) return [];
  const patchFiles = uniqueStringValues(
    replayableEvidence.flatMap((entry) => {
      const patchEvidence = asObject(entry.positive_patch_evidence);
      return stringList(patchEvidence?.changed_files);
    }),
    12,
  );
  return [
    patchFiles.length > 0
      ? `A prior real run passed the verifier; apply the exact positive_patch_evidence patches for changed files before inventing a new implementation: ${patchFiles.join(", ")}.`
      : "A prior real run passed the verifier; reuse its execution path before inventing a new implementation.",
    patchFiles.length > 0
      ? "Use apply_patch with the provided positive_patch_evidence.patches first; if a patch is stale, inspect only the conflicting patch target and adapt that hunk."
      : null,
    "After applying the successful replay pattern, run the required verifier exactly.",
  ].filter((action): action is string => !!action);
}

function directRepairActionsFromEvidence(evidence: JsonObject[]): string[] {
  const text = directEvidenceTexts(evidence).join("\n");
  const actions: string[] = [];
  if (/Command is not allowed by this real-eval runner|not allowed by this real-eval runner/i.test(text)) {
    actions.push("Do not spend steps on ad hoc node -e scripts, shell pipes, or partial test commands; use the exact required verifier command for validation.");
  }
  if (/SyntaxError|Illegal return statement|Unexpected token|missing \)|Unexpected end/i.test(text)) {
    actions.push("Repair syntax in edited runtime files before further behavior changes; keep control flow inside the owning function or module scope.");
  }
  if (/padding-line-between-statements|no-await-in-loop|xo|eslint|lint_or_format/i.test(text)) {
    actions.push("Fix linter failures in allowed files; if needed, run npx xo --fix only on allowed affected files.");
  }
  if (/max-depth|Blocks are nested too deeply|Unused eslint-disable directive/i.test(text)) {
    actions.push("Keep the implementation lint-clean by extracting small helpers instead of deeply nested branches, and remove stale eslint-disable comments.");
  }
  if (/\berror\s+TS\d{4}\b|TypeScript|No overload matches this call|Cannot find name|possibly undefined|is declared but its value is never read/i.test(text)) {
    actions.push("Repair the exact TypeScript diagnostic at the reported file and line before continuing semantic behavior edits.");
  }
  if (/AssertionError|ERR_ASSERTION|source_contract_failure|expected .* actual|strictEqual|must (?:emit|reject|expose|stop|not|include|preserve)|expected promise to reject/i.test(text)) {
    actions.push("Treat verifier assertions as scoped acceptance evidence. Inspect mentioned allowed files first, repair the evidence-bearing implementation or test/type file for this phase, then rerun the required verifier.");
    actions.push("Do not convert package names, repository names, function names, or path quirks from this task into reusable Runtime policy.");
  }
  if (/already aborted|aborted while .* pending|signal\.reason|AbortSignal|AbortController|stop consuming/i.test(text)) {
    actions.push("For async cancellation evidence, preserve exact rejection reasons and stop/cleanup behavior required by the verifier; keep the repair scoped to the verifier-named implementation path.");
  }
  if (/tests?\/[A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?\s+must|tests must (?:include|assert|preserve)|test\.js[\s\S]{0,120}must|index\.test-d\.ts[\s\S]{0,120}must|runtime tests|type assertion/i.test(text)) {
    actions.push("If the latest verifier phase is test/type coverage, edit the named authored test or type file; otherwise repair implementation first and rerun the verifier.");
  }
  if (/package\.json[\s\S]{0,180}(?:dependencies|devDependencies|runtime dependency|must expose)|runtime dependency[\s\S]{0,180}package\.json/i.test(text)) {
    actions.push("If the verifier names a package/dependency contract, keep the package edit coupled to the runtime import/export evidence and rerun the required verifier.");
  }
  if (/replace_lines_current_anchor_required|stale_line_anchor_failure|expected_old_lines did not match/i.test(text)) {
    actions.push("Before another replace_lines edit, read the current target range and copy expected_old_lines from that latest read_file output; do not reuse stale line anchors from memory.");
  }
  return uniqueStringValues(actions, 12);
}

function repairActionConflictsWithSelectedPhase(action: string, phase: string | null): boolean {
  if (!phase) return false;
  const lower = action.toLowerCase();
  const knownPhases = [
    "provider_failure",
    "tool_protocol_failure",
    "lint_type_failure",
    "authored_test_failure",
    "hidden_contract_failure",
    "unknown_verifier_failure",
  ];
  if (knownPhases.some((other) => other !== phase && lower.includes(other))) return true;
  if (phase === "hidden_contract_failure" && /defer\s+(?:hidden|source contract)|before continuing semantic behavior edits|fix only the reported lint\/type|reported lint\/type contract/i.test(action)) {
    return true;
  }
  if (phase === "lint_type_failure" && /defer\s+(?:lint|type)|hidden verifier contract before/i.test(action)) {
    return true;
  }
  return false;
}

function phaseConsistentRepairActions(actions: string[], verifierFailurePhase: JsonObject | null): string[] {
  const phase = asString(verifierFailurePhase?.phase);
  if (!phase) return uniqueStringValues(actions, 24);
  return uniqueStringValues(
    actions.filter((action) => !repairActionConflictsWithSelectedPhase(action, phase)),
    24,
  );
}

function phaseRequiresPrimaryFileRepairWindow(verifierFailurePhase: JsonObject | null): boolean {
  const phase = asString(verifierFailurePhase?.phase);
  if (phase !== "lint_type_failure") return false;
  const primaryFiles = stringList(verifierFailurePhase?.primary_files);
  const lineHints = Array.isArray(verifierFailurePhase?.line_hints)
    ? verifierFailurePhase.line_hints.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => !!entry)
    : [];
  return primaryFiles.length > 0 || lineHints.some((entry) => !!asString(entry.path));
}

function primaryRepairWindowFiles(verifierFailurePhase: JsonObject | null, allowedEditFiles: string[]): string[] {
  if (!phaseRequiresPrimaryFileRepairWindow(verifierFailurePhase)) return [];
  const primaryFiles = stringList(verifierFailurePhase?.primary_files);
  const lineHintFiles = Array.isArray(verifierFailurePhase?.line_hints)
    ? verifierFailurePhase.line_hints
        .map((entry) => asString(asObject(entry)?.path))
        .filter((file): file is string => !!file)
    : [];
  return uniqueStringValues([primaryFiles, lineHintFiles], 8)
    .filter((file) => allowedEditFiles.length === 0 || allowedEditFiles.includes(file));
}

function taskTextForGuidance(task: EvalTask | null | undefined): string {
  if (!task) return "";
  return [
    task.id,
    task.title,
    task.task_family,
    task.prompt,
  ].filter((value): value is string => !!value).join("\n");
}

function repairActionMatchesTask(action: string, task: EvalTask | null | undefined): boolean {
  void action;
  void taskTextForGuidance(task);
  return true;
}

function repairEntryMatchesTask(entry: JsonObject, task: EvalTask | null | undefined): boolean {
  return repairActionMatchesTask([
    asString(entry.path),
    asString(entry.message),
  ].filter((value): value is string => !!value).join("\n"), task);
}

function authoredTestFile(file: string): boolean {
  return /(?:^|\/)test\.[cm]?js$|\.test\.[cm]?[jt]sx?$|test-d\.ts$/i.test(file);
}

function documentationEditFile(file: string): boolean {
  return /(?:^|\/)(?:docs?|documentation)\//i.test(file) || /\.(?:md|mdx|rst)$/i.test(file);
}

function implementationEditFile(file: string): boolean {
  return !/^dist\//.test(file)
    && /\.(?:[cm]?[jt]sx?|ts)$/.test(file)
    && !/\.d\.ts$|test/i.test(file);
}

function directVerifierFailurePhaseFromEvidence(args: {
  evidence: JsonObject[];
  directFailureTexts: string[];
  directBlockingAssertions: string[];
  directRepairActions: string[];
  allowedEditFiles: string[];
  requiredVerifiers: string[];
}): JsonObject | null {
  if (args.evidence.length === 0) return null;
  const combined = [
    ...args.directFailureTexts,
    ...args.directBlockingAssertions,
    ...args.directRepairActions,
  ].join("\n");
  if (!combined.trim()) return null;
  const lower = combined.toLowerCase();
  const mentionedFiles = mentionedAllowedFiles([combined], args.allowedEditFiles);
  const mentionedLineHints = workspaceFileLineHintsMentionedInText(combined)
    .filter((hint) => mentionedFiles.includes(asString(hint.path) ?? ""));
  const mentionedLineHintFiles = uniqueStringValues(
    mentionedLineHints.map((hint) => asString(hint.path)).filter((file): file is string => !!file),
    16,
  );
  const mentionedTestFiles = mentionedFiles.filter(authoredTestFile);
  const mentionedPackageFiles = mentionedFiles.filter((file) => /(?:^|\/)package\.json$/i.test(file));
  const allowedTestFiles = args.allowedEditFiles.filter(authoredTestFile);
  const mentionedImplementationFiles = mentionedFiles.filter(implementationEditFile);
  const mentionedImplementationHintFiles = mentionedLineHintFiles.filter(implementationEditFile);
  const allowedImplementationFiles = args.allowedEditFiles.filter(implementationEditFile);
  const hasTypeScriptDiagnostic = /\b[\w./-]+\.(?:[cm]?[jt]sx?|d\.ts)\(\d+,\d+\):\s+error\s+TS\d{4}\b/i.test(combined)
    || /\berror\s+TS\d{4}\b/i.test(combined);
  const hasConcreteLintAnchor = (
    mentionedLineHintFiles.length > 0
    && /lint_or_format|xo|eslint|prettier|typescript|tsd|expecttype|\.d\.ts|\berror\s+TS\d{4}\b/i.test(combined)
  ) || hasTypeScriptDiagnostic;
  const hasProviderFailure = /provider_failure|llm_api_error|llm_call_failure|rate limit|429|no text content|api error/i.test(combined);
  const hasToolProtocol = /tool_protocol_failure|llm_protocol_error|llm_protocol_fatal|llm_protocol_exhausted|invalid_assistant_response_discarded|did not return a valid tool JSON object|Return one raw JSON object/i.test(combined);
  const hasCodeVerifierEvidence = hasTypeScriptDiagnostic
    || /AssertionError|assertion_failure|verifier_command_failure|test_assertion_failure|source_contract_failure|must |expected .* actual|expected promise to reject/i.test(combined);
  const hasLintType = hasTypeScriptDiagnostic
    || /lint_or_format|type_contract|xo|eslint|prettier|typescript|tsd|expecttype|\.d\.ts|\berror\s+ts\d{4}\b/i.test(lower);
  const hasAuthoredTestContract = /tests\/[A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?\s+must|tests must (?:include|assert|preserve)|test\.js[\s\S]{0,120}must|index\.test-d\.ts[\s\S]{0,120}must|runtime tests|type assertion/i.test(combined);
  const hasHiddenContract = /AssertionError|ERR_ASSERTION|source_contract_failure|must (?:emit|reject|expose|stop|not call|not include|include|preserve)|expected .* actual|expected promise to reject|strictEqual|signal\.reason|stop consuming/i.test(combined);
  const hasPackageDependencyContract = /package\.json[\s\S]{0,180}(?:must expose|dependencies|devDependencies|runtime dependency)|runtime dependency[\s\S]{0,180}package\.json/i.test(combined);

  let phase = "unknown_verifier_failure";
  let confidence = 0.55;
  let reason = "Direct prior verifier evidence could not be isolated to a narrower phase.";
  let primaryFiles: string[] = [];

  if (hasProviderFailure && !hasCodeVerifierEvidence) {
    phase = "provider_failure";
    confidence = 0.95;
    reason = "Direct prior evidence is a provider/API failure without code verifier evidence.";
  } else if (hasToolProtocol && !hasCodeVerifierEvidence) {
    phase = "tool_protocol_failure";
    confidence = 0.92;
    reason = "Direct prior evidence is an LLM/tool JSON protocol failure without code verifier evidence.";
  } else if (hasLintType && hasConcreteLintAnchor) {
    phase = "lint_type_failure";
    confidence = 0.92;
    reason = "Direct prior verifier evidence reports concrete lint, formatter, TypeScript, or type-test line failures.";
    primaryFiles = uniqueStringValues([
      mentionedImplementationHintFiles,
      mentionedLineHintFiles,
      mentionedFiles,
      args.allowedEditFiles.filter((file) => mentionedFiles.includes(file)),
    ], 16);
  } else if (hasHiddenContract && hasPackageDependencyContract && mentionedPackageFiles.length > 0) {
    phase = "hidden_contract_failure";
    confidence = 0.92;
    const sourceContractPresent = /source_contract_failure|runtime behavior|implementation/i.test(combined)
      && (mentionedImplementationFiles.length > 0 || allowedImplementationFiles.length > 0);
    reason = sourceContractPresent
      ? "Direct prior verifier evidence points at a source contract with a coupled package dependency requirement."
      : "Direct prior verifier evidence points at a package dependency contract failure.";
    primaryFiles = sourceContractPresent
      ? uniqueStringValues([
          mentionedImplementationFiles,
          allowedImplementationFiles.slice(0, 1),
          mentionedPackageFiles,
        ], 16)
      : uniqueStringValues([
          mentionedPackageFiles,
          mentionedImplementationFiles,
          allowedImplementationFiles.slice(0, 1),
        ], 16);
  } else if (hasHiddenContract && !hasConcreteLintAnchor) {
    phase = "hidden_contract_failure";
    confidence = 0.9;
    reason = "Direct prior verifier evidence points at hidden/source contract behavior without a concrete lint/type line anchor.";
    primaryFiles = uniqueStringValues([
      mentionedImplementationFiles,
      allowedImplementationFiles.slice(0, 2),
      mentionedPackageFiles,
    ], 16);
  } else if (hasLintType) {
    phase = "lint_type_failure";
    confidence = 0.9;
    reason = "Direct prior verifier evidence reports lint, formatter, TypeScript, or type-test contract failures.";
    primaryFiles = uniqueStringValues([
      mentionedImplementationHintFiles,
      mentionedLineHintFiles,
      mentionedFiles,
      args.allowedEditFiles.filter((file) => mentionedFiles.includes(file)),
    ], 16);
  } else if (hasAuthoredTestContract) {
    phase = "authored_test_failure";
    confidence = 0.88;
    reason = "Direct prior verifier evidence points at self-authored test coverage or type-test contract output.";
    primaryFiles = uniqueStringValues([
      mentionedTestFiles,
      allowedTestFiles.filter((file) => mentionedFiles.includes(file)),
      allowedTestFiles.slice(0, 2),
      mentionedImplementationFiles,
      allowedImplementationFiles.slice(0, 1),
    ], 16);
  } else if (hasHiddenContract) {
    phase = "hidden_contract_failure";
    confidence = 0.88;
    reason = "Direct prior verifier evidence points at hidden/source contract behavior.";
    primaryFiles = uniqueStringValues([
      mentionedImplementationFiles,
      allowedImplementationFiles.slice(0, 2),
      mentionedPackageFiles,
    ], 16);
  } else {
    primaryFiles = uniqueStringValues([mentionedFiles, allowedImplementationFiles.slice(0, 2)], 16);
  }

  const command = args.requiredVerifiers[0] ?? null;
  const firstFile = primaryFiles[0] ?? "the verifier-reported target file";
  const lineHints = primaryFiles.map((file) => {
    const hint = mentionedLineHints.find((entry) => asString(entry.path) === file);
    return {
      path: file,
      line: typeof hint?.line === "number" ? hint.line : null,
      column: typeof hint?.column === "number" ? hint.column : null,
      message: asString(hint?.message) ?? reason,
    };
  });
  const allowedNextActions = phase === "provider_failure"
    ? ["request_operator_review", "run_command"]
    : phase === "tool_protocol_failure"
      ? ["request_operator_review"]
    : ["read_file", "replace_text", "replace_lines", "apply_patch", "run_command"];
  const forbiddenNextActions = uniqueStringValues([
    phase === "provider_failure" ? "persist_learning" : null,
    phase === "provider_failure" ? "edit_unrelated_files" : null,
    phase !== "provider_failure" ? "list_files" : null,
    phase !== "provider_failure" ? "search" : null,
    phase !== "provider_failure" ? "edit_unrelated_files" : null,
    phase === "hidden_contract_failure" ? "write_tests_only" : null,
    "run_unrelated_command",
  ].filter((value): value is string => !!value), 16);
  const recommendedFocus = phase === "provider_failure"
    ? "Do not edit code from provider/API failure evidence; retry the provider call or request operator review before learning from this run."
    : phase === "tool_protocol_failure"
      ? "Do not edit repository code from LLM/tool protocol failure evidence; retry with a provider/model that obeys the JSON tool contract or request operator review."
      : phase === "authored_test_failure"
        ? `Repair the self-authored test contract in ${primaryFiles.join(", ") || firstFile}; start from ${firstFile} and rerun ${command ?? "the failed verifier"}.`
        : phase === "lint_type_failure"
          ? `Read ${firstFile}, fix only the reported lint/type contract location, then rerun ${command ?? "the failed verifier"}.`
          : phase === "hidden_contract_failure"
            ? `Repair the hidden verifier contract in ${primaryFiles.join(", ") || firstFile}; start from ${firstFile} and rerun ${command ?? "the failed verifier"}.`
            : `Use direct verifier evidence to repair ${primaryFiles.join(", ") || firstFile}, then rerun ${command ?? "the failed verifier"}.`;

  return {
    summary_version: "verifier_failure_phase_v1",
    phase,
    confidence,
    primary_reason: reason,
    failing_command: command,
    primary_files: primaryFiles,
    line_hints: lineHints,
    allowed_next_actions: allowedNextActions,
    forbidden_next_actions: forbiddenNextActions,
    recommended_focus: recommendedFocus,
  };
}

function semanticCandidateProducerMode(): "off" | "unknown" | "hidden_or_unknown" | "all" {
  const raw = (process.env.AIONIS_REAL_LLM_SEMANTIC_CANDIDATE_MODE ?? "hidden_or_unknown").trim();
  if (raw === "off" || raw === "unknown" || raw === "hidden_or_unknown" || raw === "all") return raw;
  throw new Error("AIONIS_REAL_LLM_SEMANTIC_CANDIDATE_MODE must be off, unknown, hidden_or_unknown, or all");
}

function sourcePhaseEligibleForSemanticCandidate(sourcePhase: string | null): boolean {
  const mode = semanticCandidateProducerMode();
  if (mode === "off") return false;
  if (mode === "all") return true;
  if (mode === "unknown") return sourcePhase === "unknown_verifier_failure";
  return sourcePhase === "unknown_verifier_failure" || sourcePhase === "hidden_contract_failure";
}

function semanticCandidateScope(value: unknown, task: EvalTask): LearningControlCandidateScope {
  const scope = asString(value);
  if (
    scope === "exact_task"
    || scope === "task_family"
    || scope === "repository"
    || scope === "ecosystem"
    || scope === "global"
  ) {
    return scope;
  }
  return task.task_family ? "task_family" : "exact_task";
}

function narrowSemanticCandidateScope(scope: LearningControlCandidateScope, task: EvalTask): LearningControlCandidateScope {
  if (scope === "global" || scope === "ecosystem") return task.task_family ? "task_family" : "exact_task";
  return scope;
}

function confidenceNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(0.74, parsed));
}

function semanticCandidatePromotionRequirements(task: EvalTask): string[] {
  return uniqueStringValues([
    "A later real run must pass the required verifier with this candidate applied as advisory guidance.",
    "The run must not write forbidden files or violate the edit boundary.",
    "Provider/API or tool-protocol failures must stay quarantined and cannot promote this candidate.",
    "Promotion beyond the current task family requires a separate holdout or regression run.",
    ...(task.expected?.required_verifiers ?? task.expected?.acceptance_checks ?? [task.verifier.command])
      .map((command) => `Verifier evidence required: ${command}`),
  ], 8);
}

function compactVerifierDiagnosticsForCandidate(run: AgentRun): string[] {
  const diagnostics = [
    ...diagnosticLines(run.verifier.stdout, 6),
    ...diagnosticLines(run.verifier.stderr, 12),
  ];
  if (diagnostics.length > 0) return diagnostics;
  return [
    truncate(run.verifier.stdout.trim(), 1000),
    truncate(run.verifier.stderr.trim(), 2000),
  ].filter((text) => text.length > 0);
}

function adjudicateSemanticCandidate(args: {
  raw: JsonObject;
  task: EvalTask;
  sourcePhase: string;
  provider: RealLlmProviderConfig;
  index: number;
}): LearningControlSemanticRepairCandidate {
  const allowedEditFiles = args.task.expected?.allowed_edit_files ?? args.task.expected?.target_files ?? [];
  const forbiddenEditFiles = args.task.expected?.forbidden_edit_files ?? [];
  const rawTargetFiles = uniqueStringValues(stringList(args.raw.target_files), 16);
  const forbiddenTargets = rawTargetFiles.filter((file) => forbiddenEditFiles.includes(file));
  const allowedTargets = allowedEditFiles.length > 0
    ? rawTargetFiles.filter((file) => allowedEditFiles.includes(file))
    : rawTargetFiles.filter((file) => !forbiddenEditFiles.includes(file));
  const semanticHypothesis = asString(args.raw.semantic_hypothesis) ?? asString(args.raw.hypothesis) ?? "";
  const contractKind = asString(args.raw.contract_kind) ?? asString(args.raw.failure_contract) ?? "unknown_contract";
  const evidence = uniqueStringValues(stringList(args.raw.evidence), 8);
  const suggestedActions = uniqueStringValues(stringList(args.raw.suggested_actions), 8);
  const proposedScope = semanticCandidateScope(args.raw.scope, args.task);
  const scope = narrowSemanticCandidateScope(proposedScope, args.task);
  const escapeCondition = asString(args.raw.escape_condition)
    ?? "If the next verifier output names a different phase, file, assertion, or provider/protocol failure, stop applying this candidate and reclassify from fresh evidence.";
  const reasons = uniqueStringValues([
    "LLM output is treated as a semantic candidate only; Runtime keeps authority advisory until real verifier evidence promotes it.",
    proposedScope !== scope ? `Runtime narrowed proposed scope ${proposedScope} to ${scope}.` : null,
    forbiddenTargets.length > 0 ? `Rejected forbidden target file(s): ${forbiddenTargets.join(", ")}.` : null,
    allowedTargets.length === 0 ? "No allowed edit-boundary target file survived adjudication." : null,
    semanticHypothesis.length === 0 ? "Missing semantic_hypothesis." : null,
    evidence.length === 0 ? "Missing candidate evidence quotes or diagnostics." : null,
    suggestedActions.length === 0 ? "Missing suggested_actions." : null,
  ].filter((value): value is string => !!value), 12);
  const usable = (
    forbiddenTargets.length === 0
    && allowedTargets.length > 0
    && semanticHypothesis.length > 0
    && evidence.length > 0
    && suggestedActions.length > 0
  );
  return {
    candidate_version: "learning_control_semantic_repair_candidate_v1",
    producer: {
      kind: "llm_semantic_candidate_producer",
      provider: args.provider.provider,
      model: args.provider.model,
    },
    promotion_state: "candidate",
    source_phase: args.sourcePhase,
    semantic_hypothesis: semanticHypothesis || `unusable candidate ${args.index + 1}`,
    contract_kind: contractKind,
    target_files: allowedTargets,
    evidence,
    suggested_actions: suggestedActions,
    scope,
    confidence: confidenceNumber(args.raw.confidence),
    escape_condition: escapeCondition,
    promotion_requirements: semanticCandidatePromotionRequirements(args.task),
    runtime_adjudication: {
      decision: usable ? "candidate_only" : "rejected",
      authority: "advisory",
      usable_as_next_attempt_guidance: usable,
      reasons,
      promotion_blockers: [
        "No workflow promotion until a real run passes the task verifier with this candidate in the guidance packet.",
        "No hard rule promotion without regression or holdout evidence.",
      ],
    },
  };
}

function buildSemanticCandidateProducerSystemPrompt(): string {
  return `
You are the Aionis Runtime semantic candidate producer.
Return exactly one JSON object and nothing else.
You do not make rules, declare success, or promote workflows.
Your only job is to propose candidate semantic explanations for failed real verifier evidence.
Runtime will adjudicate scope, evidence, edit boundary, provider quarantine, and promotion.

JSON contract:
{
  "candidates": [
    {
      "semantic_hypothesis": "short semantic failure explanation",
      "contract_kind": "specific contract type",
      "target_files": ["allowed/file.js"],
      "evidence": ["short verifier diagnostic or assertion text"],
      "suggested_actions": ["candidate-only next repair action"],
      "scope": "exact_task|task_family|repository|ecosystem|global",
      "confidence": 0.0,
      "escape_condition": "when this candidate must stop being applied"
    }
  ]
}

Rules:
- Use only provided evidence. Do not invent file names, tests, or verifier results.
- Prefer exact_task or task_family scope. Use ecosystem/global only when evidence explicitly supports that broad scope.
- Target only allowed edit files. If evidence is insufficient, return {"candidates":[]}.
- Provider/API and tool-protocol failures are not code-learning candidates.
- Keep suggested_actions concrete, but candidate-only: the verifier must still pass in a future real run.
`.trim();
}

function buildSemanticCandidateProducerMessage(args: {
  task: EvalTask;
  run: AgentRun;
  sourcePhase: string;
}): string {
  return truncate(JSON.stringify({
    task_id: args.task.id,
    title: args.task.title ?? args.task.id,
    task_family: args.task.task_family ?? null,
    prompt: args.task.prompt,
    deterministic_phase: args.sourcePhase,
    edit_boundary: {
      allowed_edit_files: args.task.expected?.allowed_edit_files ?? args.task.expected?.target_files ?? [],
      forbidden_edit_files: args.task.expected?.forbidden_edit_files ?? [],
      required_verifiers: args.task.expected?.required_verifiers ?? args.task.expected?.acceptance_checks ?? [args.task.verifier.command],
      anti_shortcut_rules: args.task.expected?.anti_shortcut_rules ?? [],
    },
    run_evidence: {
      arm: args.run.arm,
      attempt: args.run.attempt ?? null,
      status: args.run.status,
      failure_categories: codeRepairFailureCategories(args.run.metrics.failure_categories),
      edited_files: args.run.metrics.edited_files,
      touched_files: args.run.metrics.touched_files,
      verifier: {
        command: args.run.verifier.command,
        exit_code: args.run.verifier.exit_code,
        timed_out: args.run.verifier.timed_out,
        diagnostics: compactVerifierDiagnosticsForCandidate(args.run),
      },
      failed_tool_calls: compactFailedToolCalls(args.run, 4),
    },
  }, null, 2), LLM_CONTEXT_LIMIT);
}

async function produceLearningControlSemanticCandidates(args: {
  provider: RealLlmProviderConfig;
  task: EvalTask;
  run: AgentRun;
  progress?: EvalProgressLogger;
}): Promise<LearningControlSemanticCandidateProducerOutcome | null> {
  if (args.run.metrics.verifier_passed) return null;
  const quarantineReason = runtimeLearningQuarantineReasonFromRun(args.run);
  const evidence = [compactPriorRunRepairEvidence(args.run)];
  const directFailureTexts = directEvidenceTexts(evidence);
  const directBlockingAssertions = directBlockingAssertionsFromEvidence(evidence);
  const directRepairActions = directRepairActionsFromEvidence(evidence);
  const directEvidencePhase = directVerifierFailurePhaseFromEvidence({
    evidence,
    directFailureTexts,
    directBlockingAssertions,
    directRepairActions,
    allowedEditFiles: args.task.expected?.allowed_edit_files ?? args.task.expected?.target_files ?? [],
    requiredVerifiers: args.task.expected?.required_verifiers ?? args.task.expected?.acceptance_checks ?? [args.task.verifier.command],
  });
  const finalVerifierPhase = finalVerifierFailurePhaseFromRun(args.task, args.run);
  const phase = finalVerifierPhase ?? directEvidencePhase;
  const sourcePhase = asString(phase?.phase) ?? "unknown_verifier_failure";
  if (quarantineReason) {
    return {
      outcome_version: "learning_control_semantic_candidate_producer_outcome_v1",
      status: "skipped",
      reason: `Skipped semantic candidate production because run learning is quarantined: ${quarantineReason}.`,
      source_phase: sourcePhase,
      input_tokens: 0,
      output_tokens: 0,
      candidates: [],
      errors: [],
    };
  }
  if (!sourcePhaseEligibleForSemanticCandidate(sourcePhase)) {
    return {
      outcome_version: "learning_control_semantic_candidate_producer_outcome_v1",
      status: "skipped",
      reason: `Semantic candidate producer mode ${semanticCandidateProducerMode()} does not admit source phase ${sourcePhase}.`,
      source_phase: sourcePhase,
      input_tokens: 0,
      output_tokens: 0,
      candidates: [],
      errors: [],
    };
  }
  if (sourcePhase === "provider_failure" || sourcePhase === "tool_protocol_failure") {
    return {
      outcome_version: "learning_control_semantic_candidate_producer_outcome_v1",
      status: "skipped",
      reason: `Skipped ${sourcePhase}; provider/protocol evidence is quarantined from code-learning candidates.`,
      source_phase: sourcePhase,
      input_tokens: 0,
      output_tokens: 0,
      candidates: [],
      errors: [],
    };
  }

  args.progress?.emit("semantic_candidate_producer_start", {
    task_id: args.task.id,
    arm: args.run.arm,
    ...(args.run.attempt ? { attempt: args.run.attempt } : {}),
    run_id: args.run.run_id,
    source_phase: sourcePhase,
    provider: args.provider.provider,
    model: args.provider.model,
  });

  let response: LlmResponse;
  try {
    response = await callRealLlm({
      provider: args.provider,
      system: buildSemanticCandidateProducerSystemPrompt(),
      messages: [{ role: "user", content: buildSemanticCandidateProducerMessage({ task: args.task, run: args.run, sourcePhase }) }],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    args.progress?.emit("semantic_candidate_producer_end", {
      task_id: args.task.id,
      arm: args.run.arm,
      ...(args.run.attempt ? { attempt: args.run.attempt } : {}),
      run_id: args.run.run_id,
      status: "provider_failure",
      source_phase: sourcePhase,
      detail,
    });
    return {
      outcome_version: "learning_control_semantic_candidate_producer_outcome_v1",
      status: "provider_failure",
      reason: "Semantic candidate producer provider call failed; this is quarantined from code repair learning.",
      source_phase: sourcePhase,
      input_tokens: 0,
      output_tokens: 0,
      candidates: [],
      errors: [detail],
    };
  }

  let parsed: JsonObject;
  try {
    parsed = extractJsonObjectFromText(response.text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    args.progress?.emit("semantic_candidate_producer_end", {
      task_id: args.task.id,
      arm: args.run.arm,
      ...(args.run.attempt ? { attempt: args.run.attempt } : {}),
      run_id: args.run.run_id,
      status: "protocol_failure",
      source_phase: sourcePhase,
      input_tokens: response.inputTokens ?? 0,
      output_tokens: response.outputTokens ?? 0,
      detail,
    });
    return {
      outcome_version: "learning_control_semantic_candidate_producer_outcome_v1",
      status: "protocol_failure",
      reason: "Semantic candidate producer did not return the required JSON object; this is quarantined from code repair learning.",
      source_phase: sourcePhase,
      input_tokens: response.inputTokens ?? 0,
      output_tokens: response.outputTokens ?? 0,
      candidates: [],
      errors: [detail],
    };
  }

  const rawCandidates = Array.isArray(parsed.candidates)
    ? parsed.candidates.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => !!entry)
    : [];
  const candidates = rawCandidates
    .slice(0, 3)
    .map((raw, index) => adjudicateSemanticCandidate({
      raw,
      task: args.task,
      sourcePhase,
      provider: args.provider,
      index,
    }));
  const usableCount = candidates.filter((candidate) => (
    candidate.runtime_adjudication.usable_as_next_attempt_guidance
  )).length;
  const status = candidates.length === 0
    ? "rejected"
    : usableCount > 0
      ? "produced"
      : "rejected";
  args.progress?.emit("semantic_candidate_producer_end", {
    task_id: args.task.id,
    arm: args.run.arm,
    ...(args.run.attempt ? { attempt: args.run.attempt } : {}),
    run_id: args.run.run_id,
    status,
    source_phase: sourcePhase,
    candidate_count: candidates.length,
    usable_candidate_count: usableCount,
    input_tokens: response.inputTokens ?? 0,
    output_tokens: response.outputTokens ?? 0,
  });
  return {
    outcome_version: "learning_control_semantic_candidate_producer_outcome_v1",
    status,
    reason: usableCount > 0
      ? "LLM produced semantic repair candidates; Runtime adjudicated them as candidate-only advisory guidance."
      : "LLM produced no usable candidate after Runtime edit-boundary and evidence adjudication.",
    source_phase: sourcePhase,
    input_tokens: response.inputTokens ?? 0,
    output_tokens: response.outputTokens ?? 0,
    candidates,
    errors: [],
  };
}

function mentionedAllowedFiles(texts: string[], allowedEditFiles: string[]): string[] {
  const haystack = texts.join("\n");
  return allowedEditFiles.filter((file) => haystack.includes(file));
}

function expandRepairAffectedFiles(args: {
  repairAffectedFiles: string[];
  repairMentionedFiles: string[];
  allowedEditFiles: string[];
  verificationRepair: JsonObject | null;
}): string[] {
  const base = uniqueStringValues([
    args.repairAffectedFiles,
    args.repairMentionedFiles,
  ], 8);
  if (!repairNeedsCoupledTypeSurface(args.verificationRepair)) return base;
  return uniqueStringValues([
    base,
    typeSurfaceFiles(args.allowedEditFiles),
  ], 8);
}

function orderedRepairAnchorFiles(args: {
  firstAction: JsonObject | null;
  repairAffectedFiles: string[];
  verifierFailurePhase: JsonObject | null;
}): string[] {
  const phasePrimaryFiles = stringList(args.verifierFailurePhase?.primary_files);
  if (phasePrimaryFiles.length > 0) {
    const first = phasePrimaryFiles[0];
    const implementation = phasePrimaryFiles.find((file) => file !== first && implementationEditFile(file));
    const typeSurface = phasePrimaryFiles.find((file) => file !== first && typeSurfaceFiles([file]).length > 0);
    return uniqueStringValues([first, implementation, typeSurface].filter((file): file is string => !!file), 2);
  }
  const firstActionPath = asString(args.firstAction?.file_path);
  return uniqueStringValues([
    firstActionPath,
    args.repairAffectedFiles,
  ], 3);
}

function packageDependencyRequirementsFromTask(args: {
  task: EvalTask | null;
  workspaceDir: string | null;
  allowedEditFiles: string[];
}): JsonObject[] {
  if (!args.task || !args.workspaceDir) return [];
  const packageFile = args.allowedEditFiles.find((file) => /(?:^|\/)package\.json$/i.test(file)) ?? "package.json";
  const packagePath = path.join(args.workspaceDir, packageFile);
  if (!fs.existsSync(packagePath)) return [];
  let packageJson: JsonObject;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as JsonObject;
  } catch {
    return [];
  }
  const text = `${args.task.title ?? ""}\n${args.task.prompt}`;
  const dependencies = asObject(packageJson.dependencies) ?? {};
  const devDependencies = asObject(packageJson.devDependencies) ?? {};
  const names: string[] = [];
  for (const match of text.matchAll(/move\s+`?(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)`?\s+from\s+devDependencies\s+to\s+dependencies/gi)) {
    if (match[1]) names.push(match[1]);
  }
  for (const match of text.matchAll(/`?(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)`?[\s\S]{0,120}runtime dependency/gi)) {
    if (match[1] && Object.prototype.hasOwnProperty.call(devDependencies, match[1])) names.push(match[1]);
  }
  const requirements: JsonObject[] = [];
  for (const dependency of uniqueStringValues(names, 8)) {
    const version = asString(devDependencies[dependency]) ?? asString(dependencies[dependency]);
    if (!version) continue;
    const sourceSection = Object.prototype.hasOwnProperty.call(devDependencies, dependency) ? "devDependencies" : null;
    requirements.push({
      summary_version: "package_dependency_requirement_v1",
      package_file: packageFile,
      dependency,
      version,
      source_section: sourceSection,
      target_section: "dependencies",
      instruction: sourceSection
        ? `Move "${dependency}": "${version}" from devDependencies to dependencies in ${packageFile}; the same package edit must add the dependency entry and remove the devDependency entry.`
        : `Add "${dependency}": "${version}" under dependencies in ${packageFile}.`,
    });
  }
  return requirements;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function semanticCandidateText(candidate: JsonObject): string {
  return [
    asString(candidate.semantic_hypothesis),
    asString(candidate.contract_kind),
    ...stringList(candidate.evidence),
    ...stringList(candidate.suggested_actions),
    asString(candidate.escape_condition),
  ].filter((value): value is string => !!value).join("\n");
}

function semanticCandidateSignature(candidate: JsonObject): string {
  return JSON.stringify({
    target_files: stringList(candidate.target_files).sort(),
    contract_kind: asString(candidate.contract_kind) ?? "",
    suggested_actions: stringList(candidate.suggested_actions).slice(0, 2),
  });
}

function semanticCandidateScopeSignature(candidate: JsonObject): string {
  return JSON.stringify({
    target_files: stringList(candidate.target_files).sort(),
    contract_kind: asString(candidate.contract_kind) ?? "",
  });
}

function semanticCandidateTrialRole(candidate: JsonObject): string {
  const text = semanticCandidateText(candidate);
  const contractKind = asString(candidate.contract_kind) ?? "";
  const targetFiles = stringList(candidate.target_files);
  const implementationTarget = targetFiles.some(implementationEditFile);
  const packageTarget = targetFiles.some((file) => /(?:^|\/)package\.json$/i.test(file));
  const testOrDocsTarget = targetFiles.some((file) => authoredTestFile(file) || documentationEditFile(file));
  const scaffoldingOnly = /(?:missing[_\s-]?import|add\s+import|import\s+statement|dependency|dependencies|devdependencies|package\.json|type\s+surface|type\s+declaration|export\s+binding|no\s+default\s+export|named\s+import)/i.test(text);
  const behaviorCandidate = /(?:implementation|behavior|logic|call[\s-]?path|runtime|algorithm|state|flow|handle|parse|seriali[sz]e|validate|normalize|resolve|retry|redirect|emit|write|read|return|throw|reject|transform|split|stream|buffer|loop|iterate|boundary|contract)/i.test(text);
  if (/(?:missing[_\s-]?import|import|dependency|package|type[_\s-]?surface|type[_\s-]?declaration|export)/i.test(contractKind)) {
    return "scaffolding_or_coupled_surface";
  }
  if (implementationTarget && behaviorCandidate) return "behavioral_implementation";
  if (packageTarget || scaffoldingOnly) return "scaffolding_or_coupled_surface";
  if (testOrDocsTarget) return "test_or_documentation_surface";
  if (implementationTarget) return "implementation_surface";
  return "supporting_candidate";
}

function semanticCandidateTrialPriority(candidate: JsonObject, allowedFiles: string[], originalIndex: number): number {
  const targetFiles = stringList(candidate.target_files);
  const matchingTargets = targetFiles.filter((file) => allowedFiles.length === 0 || allowedFiles.includes(file));
  if (matchingTargets.length === 0) return Number.NEGATIVE_INFINITY;

  const role = semanticCandidateTrialRole(candidate);
  const implementationTarget = matchingTargets.some(implementationEditFile);
  const packageOnlyWindow = allowedFiles.length > 0 && allowedFiles.every((file) => /(?:^|\/)package\.json$/i.test(file));
  const packageTarget = matchingTargets.some((file) => /(?:^|\/)package\.json$/i.test(file));
  const testOrDocsTarget = matchingTargets.some((file) => authoredTestFile(file) || documentationEditFile(file));
  const confidence = numeric(candidate.confidence);
  let score = 1000 - originalIndex;
  if (implementationTarget) score += 80;
  if (role === "behavioral_implementation") score += 160;
  if (role === "implementation_surface") score += 40;
  if (role === "scaffolding_or_coupled_surface") score += packageOnlyWindow ? 80 : -70;
  if (packageTarget && !packageOnlyWindow) score -= 35;
  if (testOrDocsTarget) score -= 45;
  if (asObject(candidate.candidate_counter_evidence_v1)?.contested === true) score -= 220;
  if (stringList(candidate.suggested_actions).length > 0) score += 10;
  if (confidence > 0) score += Math.min(20, confidence * 20);
  return score;
}

function orderedSemanticCandidatesForTrial(candidates: JsonObject[], allowedFiles: string[]): JsonObject[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      priority: semanticCandidateTrialPriority(candidate, allowedFiles, index),
    }))
    .filter((entry) => Number.isFinite(entry.priority))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .map((entry) => entry.candidate);
}

function packageDependencyRequirementsFromSemanticCandidates(args: {
  candidates: JsonObject[];
  workspaceDir: string | null;
  allowedEditFiles: string[];
}): JsonObject[] {
  if (!args.workspaceDir || args.candidates.length === 0) return [];
  const candidateTexts = args.candidates.map(semanticCandidateText).filter((text) => text.trim().length > 0);
  if (candidateTexts.length === 0) return [];
  const packageFiles = uniqueStringValues([
    args.candidates.flatMap((candidate) => stringList(candidate.target_files)),
    args.allowedEditFiles,
    "package.json",
  ], 16).filter((file) => (
    /(?:^|\/)package\.json$/i.test(file)
    && (args.allowedEditFiles.length === 0 || args.allowedEditFiles.includes(file))
  ));
  const requirements: JsonObject[] = [];
  const seen = new Set<string>();
  for (const packageFile of packageFiles) {
    const packagePath = path.join(args.workspaceDir, packageFile);
    if (!fs.existsSync(packagePath)) continue;
    let packageJson: JsonObject;
    try {
      packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as JsonObject;
    } catch {
      continue;
    }
    const dependencies = asObject(packageJson.dependencies) ?? {};
    const devDependencies = asObject(packageJson.devDependencies) ?? {};
    const packageCandidates = uniqueStringValues([
      ...Object.keys(devDependencies),
      ...Object.keys(dependencies),
    ], 256);
    for (const dependency of packageCandidates) {
      const escaped = regexEscape(dependency);
      const explicitMove = new RegExp(`move\\s+\`?${escaped}\`?\\s+from\\s+devDependencies\\s+to\\s+dependencies`, "i");
      const runtimeDependencyMention = new RegExp(`\`?${escaped}\`?[\\s\\S]{0,160}(?:runtime dependency|dependencies|dependency contract)|(?:runtime dependency|dependencies|dependency contract)[\\s\\S]{0,160}\`?${escaped}\`?`, "i");
      const matched = candidateTexts.some((text) => (
        explicitMove.test(text)
        || (
          runtimeDependencyMention.test(text)
          && /package\.json|dependency|dependencies|devDependencies|runtime dependency/i.test(text)
        )
      ));
      if (!matched) continue;
      const version = asString(devDependencies[dependency]) ?? asString(dependencies[dependency]);
      if (!version) continue;
      const sourceSection = Object.prototype.hasOwnProperty.call(devDependencies, dependency) ? "devDependencies" : null;
      const signature = `${packageFile}\0${dependency}\0${version}\0${sourceSection ?? ""}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      requirements.push({
        summary_version: "package_dependency_requirement_v1",
        package_file: packageFile,
        dependency,
        version,
        source_section: sourceSection,
        target_section: "dependencies",
        source: "semantic_candidate",
        instruction: sourceSection
          ? `Move "${dependency}": "${version}" from ${sourceSection} to dependencies in ${packageFile}; the same package edit must add the dependency entry and remove the old entry.`
          : `Ensure "${dependency}": "${version}" is present under dependencies in ${packageFile}.`,
      });
    }
  }
  return requirements;
}

function mergePackageDependencyRequirements(...groups: JsonObject[][]): JsonObject[] {
  const out: JsonObject[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const entry of group) {
      const packageFile = asString(entry.package_file);
      const dependency = asString(entry.dependency);
      const version = asString(entry.version);
      if (!packageFile || !dependency || !version) continue;
      const signature = JSON.stringify({
        package_file: packageFile,
        dependency,
        version,
        source_section: asString(entry.source_section) ?? "",
        target_section: asString(entry.target_section) ?? "dependencies",
      });
      if (seen.has(signature)) continue;
      seen.add(signature);
      out.push(entry);
    }
  }
  return out.slice(0, 8);
}

function candidateExecutionOperatorFromCandidates(args: {
  candidates: JsonObject[];
  primaryFiles: string[];
  allowedFiles: string[];
  requiredVerifiers: string[];
  packageDependencyRequirements: JsonObject[];
}): JsonObject | null {
  const selectedCandidates = orderedSemanticCandidatesForTrial(args.candidates, args.allowedFiles).filter((candidate) => {
    const targetFiles = stringList(candidate.target_files)
      .filter((file) => args.allowedFiles.length === 0 || args.allowedFiles.includes(file));
    return targetFiles.length > 0 && stringList(candidate.suggested_actions).length > 0;
  }).slice(0, 4);
  if (selectedCandidates.length === 0) return null;
  const targetFiles = uniqueStringValues(
    [
      selectedCandidates.flatMap((candidate) => stringList(candidate.target_files)),
      args.packageDependencyRequirements
        .map((requirement) => asString(requirement.package_file))
        .filter((file): file is string => !!file),
    ].flat()
      .filter((file) => args.allowedFiles.length === 0 || args.allowedFiles.includes(file)),
    12,
  );
  if (targetFiles.length === 0) return null;
  const explicitPrimaryCandidates = uniqueStringValues([
    args.primaryFiles.filter((file) => targetFiles.includes(file)),
  ], 4);
  const explicitImplementationPrimary = explicitPrimaryCandidates.filter(implementationEditFile);
  const explicitPrimaryTargetFiles = explicitImplementationPrimary.length > 0
    ? explicitImplementationPrimary
    : explicitPrimaryCandidates;
  const fallbackPrimaryTargetFiles = uniqueStringValues([
    targetFiles.filter(implementationEditFile).slice(0, 1),
    targetFiles.slice(0, 1),
  ], 4);
  const primaryTargetFiles = explicitPrimaryTargetFiles.length > 0
    ? explicitPrimaryTargetFiles
    : fallbackPrimaryTargetFiles;
  const coupledTargetFiles = targetFiles.filter((file) => !primaryTargetFiles.includes(file));
  const verifier = args.requiredVerifiers[0] ?? null;
  return {
    summary_version: "learning_control_candidate_execution_operator_v1",
    authority: "candidate_trial",
    promotion_state: "candidate",
    operator_kind: "bounded_multi_candidate_trial",
    candidate_count: selectedCandidates.length,
    target_files: targetFiles,
    primary_target_files: primaryTargetFiles,
    coupled_target_files: coupledTargetFiles,
    package_dependency_requirements_v1: args.packageDependencyRequirements.length > 0
      ? args.packageDependencyRequirements
      : null,
    candidates: selectedCandidates.map((candidate, index) => ({
      index: index + 1,
      trial_role: semanticCandidateTrialRole(candidate),
      target_files: stringList(candidate.target_files).filter((file) => targetFiles.includes(file)),
      semantic_hypothesis: asString(candidate.semantic_hypothesis) ?? "",
      contract_kind: asString(candidate.contract_kind) ?? "",
      suggested_actions: stringList(candidate.suggested_actions),
      escape_condition: asString(candidate.escape_condition) ?? "",
    })),
    required_sequence: [
      primaryTargetFiles.length > 0 ? `Inspect primary candidate file(s): ${primaryTargetFiles.join(", ")}.` : null,
      primaryTargetFiles.length > 0 ? `Apply one source/primary non-noop edit inside: ${primaryTargetFiles.join(", ")}.` : null,
      coupledTargetFiles.length > 0 ? `Apply required coupled candidate edit(s) inside: ${coupledTargetFiles.join(", ")} before broad exploration or verifier rerun.` : null,
      verifier ? `Run required verifier after candidate edits: ${verifier}.` : "Run the required verifier after candidate edits.",
    ].filter((step): step is string => !!step),
    escape_conditions: uniqueStringValues([
      "If current file evidence disproves a candidate target or suggested action, do not force that candidate.",
      "If provider/protocol failure occurs, quarantine the run and do not promote the candidate.",
      "If the verifier phase moves to unrelated files, reclassify from fresh verifier evidence.",
    ], 6),
    instruction:
      "Execute as a bounded experiment: combine compatible candidate-only hypotheses across prior failed runs, constrain writes to target_files, run the verifier, and let verifier evidence accept, reject, or mutate the candidate set. This is not workflow promotion.",
  };
}

function evidenceRuntimeSignals(evidence: JsonObject[]): JsonObject[] {
  return evidence
    .map((entry) => asObject(entry.runtime_signals))
    .filter((entry): entry is JsonObject => !!entry);
}

function sumEvidenceSignal(evidence: JsonObject[], key: string): number {
  return evidenceRuntimeSignals(evidence)
    .reduce((sum, signals) => sum + numeric(signals[key]), 0);
}

function evidenceCategories(evidence: JsonObject[]): string[] {
  return uniqueStringValues(evidence.flatMap((entry) => stringList(entry.failure_categories)), 64);
}

function cognitiveEntropyEngineFromEvidence(args: {
  directRepairEvidence: JsonObject[];
  verifierFailurePhase: JsonObject | null;
  repairAffectedFiles: string[];
  targetFiles: string[];
  allowedEditFiles: string[];
  allowedReadFiles: string[];
  semanticRepairCandidates: JsonObject[];
  candidateExecutionOperator: JsonObject | null;
}): JsonObject | null {
  const failedRunCount = args.directRepairEvidence.length;
  if (failedRunCount === 0) return null;
  const phase = asString(args.verifierFailurePhase?.phase) ?? "unknown_verifier_failure";
  if (phase === "provider_failure" || phase === "tool_protocol_failure") return null;
  const categories = evidenceCategories(args.directRepairEvidence);
  const verifierCommandRunCount = sumEvidenceSignal(args.directRepairEvidence, "verifier_command_run_count");
  const policyBlockCount = sumEvidenceSignal(args.directRepairEvidence, "policy_block_recovery_mode_count")
    + sumEvidenceSignal(args.directRepairEvidence, "first_action_sequence_policy_block_count");
  const retryCount = sumEvidenceSignal(args.directRepairEvidence, "retry_count");
  const priorProbeAttempted = evidenceRuntimeSignals(args.directRepairEvidence)
    .some((signals) => signals.cognitive_entropy_counterfactual_probe_attempted === true);
  const candidateOperatorCount = numeric(asObject(args.candidateExecutionOperator)?.candidate_count);
  const candidatePressure = (
    args.semanticRepairCandidates.length > 0
    || candidateOperatorCount > 0
  ) && failedRunCount >= 2;
  const verifierStagnationPressure = categories.includes("verifier_stagnation_stop")
    || categories.includes("tool_payload_exhaustion_stop")
    || categories.includes("repeated_verifier_failure")
    || verifierCommandRunCount >= 8;
  const overGovernancePressure = policyBlockCount >= 6
    || categories.includes("first_action_sequence_policy_violation")
    || categories.includes("policy_block_noncompliance_budget_exhausted");
  const repeatedFailurePressure = failedRunCount >= 3 || retryCount >= 12 || verifierCommandRunCount >= 6;
  const divergenceRequired = (
    repeatedFailurePressure
    && (candidatePressure || verifierStagnationPressure || overGovernancePressure)
  );
  const targetAttractorFiles = uniqueStringValues([
    args.repairAffectedFiles,
    stringList(args.verifierFailurePhase?.primary_files),
    stringList(args.candidateExecutionOperator?.target_files),
  ], 16);
  const readableUniverse = uniqueStringValues([
    args.allowedReadFiles,
    args.targetFiles,
    args.allowedEditFiles,
    targetAttractorFiles,
  ], 64);
  const nonAttractorReadFiles = readableUniverse.filter((file) => !targetAttractorFiles.includes(file));
  const probeReadFiles = uniqueStringValues([
    nonAttractorReadFiles.filter(implementationEditFile),
    nonAttractorReadFiles,
    readableUniverse.filter(implementationEditFile),
    readableUniverse,
  ], 8);
  const explorationBias = divergenceRequired ? 0.74 : repeatedFailurePressure ? 0.62 : 0.5;
  const governanceStrength = divergenceRequired
    ? overGovernancePressure ? 0.54 : 0.6
    : 0.66;
  const candidateGravity = candidatePressure && divergenceRequired ? 0.38 : candidatePressure ? 0.56 : 0.5;
  return {
    summary_version: "aionis_cognitive_entropy_engine_v1",
    authority: "runtime_execution_posture",
    promotion_state: "candidate_control",
    entropy_state: divergenceRequired ? "divergence_required" : "balanced",
    failed_prior_run_count: failedRunCount,
    verifier_failure_phase: phase,
    exploration_bias: Number(explorationBias.toFixed(2)),
    governance_strength: Number(governanceStrength.toFixed(2)),
    candidate_gravity: Number(candidateGravity.toFixed(2)),
    divergence_budget: divergenceRequired ? (priorProbeAttempted ? 1 : 2) : 0,
    triggers: uniqueStringValues([
      candidatePressure ? "candidate_attractor_pressure" : null,
      verifierStagnationPressure ? "verifier_stagnation_pressure" : null,
      overGovernancePressure ? "over_governance_pressure" : null,
      repeatedFailurePressure ? "repeated_failure_pressure" : null,
      priorProbeAttempted ? "prior_counterfactual_probe_attempted" : null,
    ].filter((value): value is string => !!value), 12),
    counterfactual_probe_v1: divergenceRequired && probeReadFiles.length > 0
      ? {
          summary_version: "cognitive_entropy_counterfactual_probe_v1",
          required: true,
          authority: "bounded_read_only_probe",
          reason:
            "Prior failed real runs show repeated verifier/candidate pressure. Before another same-attractor repair loop, run one bounded alternative read/search probe and then return to verifier-grounded repair.",
          allowed_actions: ["read_file", "search"],
          allowed_read_files: probeReadFiles,
          current_attractor_files: targetAttractorFiles,
          max_probe_actions_per_attempt: divergenceRequired && priorProbeAttempted ? 1 : 2,
          write_allowed_during_probe: false,
          required_observation:
            "Record whether the alternative file/path confirms, refutes, or changes the current repair hypothesis. Do not promote the probe without a passing verifier.",
        }
      : null,
    operating_rules: [
      "Dynamic entropy adjusts execution posture; it is not a repository-specific repair rule.",
      "When repeated candidate/verifier failures create attractor pressure, increase bounded exploration instead of adding another hard repair constraint.",
      "The counterfactual probe is read/search-only and candidate-level; writes still obey edit_boundary_v1 and verifier evidence.",
      "After one probe, return to scoped repair and the required verifier; no workflow promotion without a passing real verifier and holdout/regression evidence.",
    ],
  };
}

function buildFirstActionSequence(args: {
  firstAction: JsonObject | null;
  repairAffectedFiles: string[];
  verificationRepairCommands: string[];
  verifierFailurePhase: JsonObject | null;
  sourceContractRepair: boolean;
  semanticRepairCandidates: JsonObject[];
  candidateExecutionOperator: JsonObject | null;
  packageDependencyRequirements: JsonObject[];
}): JsonObject | null {
  const orderedActions: JsonObject[] = [];
  const phase = asString(args.verifierFailurePhase?.phase);
  const phasePrimaryFiles = stringList(args.verifierFailurePhase?.primary_files);
  const anchorFiles = orderedRepairAnchorFiles({
    firstAction: args.firstAction,
    repairAffectedFiles: args.repairAffectedFiles,
    verifierFailurePhase: args.verifierFailurePhase,
  });
  for (const file of anchorFiles) {
    orderedActions.push({
      index: orderedActions.length + 1,
      action: "read_file",
      file_path: file,
      reason: asString(args.verifierFailurePhase?.phase)
        ? "verifier_failure_phase_v1 selected this file as a repair anchor."
        : "Runtime selected this file as a narrow repair anchor.",
    });
  }
  const candidateOperatorPrimaryFiles = stringList(args.candidateExecutionOperator?.primary_target_files);
  if (
    orderedActions.length === 0
    && args.repairAffectedFiles.length === 0
    && candidateOperatorPrimaryFiles.length === 0
  ) return null;
  const orderedReadFiles = uniqueStringValues(
    orderedActions
      .map((action) => asString(action.file_path))
      .filter((file): file is string => !!file),
    16,
  );
  const hiddenContractFirstWrite = phase === "hidden_contract_failure" && orderedReadFiles.length > 0;
  const sourceContractFirstWrite = args.sourceContractRepair && phasePrimaryFiles.length > 0;
  const exactPhasePrimaryFirstWrite = phaseRequiresPrimaryFileRepairWindow(args.verifierFailurePhase);
  const primaryConstrainedFirstWrite = hiddenContractFirstWrite || sourceContractFirstWrite || exactPhasePrimaryFirstWrite;
  const sourceContractPrimaryWriteFiles = sourceContractFirstWrite
    ? phasePrimaryFiles.filter(implementationEditFile)
    : [];
  const sourceContractCoupledCandidates = uniqueStringValues([
    phasePrimaryFiles,
    args.repairAffectedFiles,
  ], 12);
  const sourceContractCoupledWriteFiles = sourceContractFirstWrite && sourceContractPrimaryWriteFiles.length > 0
    ? sourceContractCoupledCandidates.filter((file) => (
        !sourceContractPrimaryWriteFiles.includes(file)
        && !authoredTestFile(file)
        && (/(?:^|\/)package\.json$/i.test(file) || typeSurfaceFiles([file]).length > 0)
      ))
    : [];
  const constrainedFirstWriteFiles = sourceContractPrimaryWriteFiles.length > 0
    ? sourceContractPrimaryWriteFiles
    : uniqueStringValues([phasePrimaryFiles, orderedReadFiles, candidateOperatorPrimaryFiles], 8);
  const firstWriteFiles = primaryConstrainedFirstWrite
    ? constrainedFirstWriteFiles
    : args.repairAffectedFiles.length > 0
      ? args.repairAffectedFiles
      : candidateOperatorPrimaryFiles;
  const semanticCandidateTrial = semanticCandidateTrialFromCandidates(args.semanticRepairCandidates, firstWriteFiles);
  const packageDependencyFiles = args.packageDependencyRequirements
    .map((entry) => asString(entry.package_file))
    .filter((file): file is string => !!file);
  const candidateOperatorCoupledFiles = stringList(args.candidateExecutionOperator?.coupled_target_files)
    .filter((file) => !firstWriteFiles.includes(file));
  const secondWriteFiles = uniqueStringValues([
    exactPhasePrimaryFirstWrite ? [] : sourceContractCoupledWriteFiles,
    packageDependencyFiles,
    candidateOperatorCoupledFiles,
  ], 4);
  const secondSemanticCandidateTrial = semanticCandidateTrialFromCandidates(args.semanticRepairCandidates, secondWriteFiles);
  const preWriteReadFiles = uniqueStringValues([
    orderedReadFiles,
    primaryConstrainedFirstWrite ? [] : args.repairAffectedFiles,
    candidateOperatorPrimaryFiles,
  ], 16);
  const maxNarrowReadsBeforeFirstRepairWrite = exactPhasePrimaryFirstWrite ? 3 : hiddenContractFirstWrite || sourceContractFirstWrite ? 6 : 4;
  const maxScopedSearchesBeforeFirstRepairWrite = exactPhasePrimaryFirstWrite ? 0 : hiddenContractFirstWrite || sourceContractFirstWrite ? 2 : 1;
  const maxSuccessfulWritesBeforeVerifier = secondWriteFiles.length > 0
    ? 2
    : hiddenContractFirstWrite || exactPhasePrimaryFirstWrite ? 1 : sourceContractFirstWrite ? 2 : 3;
  return {
    summary_version: "aionis_first_action_sequence_v1",
    priority: "required",
    ordered_actions: orderedActions,
    repair_first_write: firstWriteFiles.length > 0
      ? {
          allowed_files: firstWriteFiles,
          allowed_read_files: preWriteReadFiles,
          max_broad_reads_before_first_repair_write: 0,
          max_narrow_reads_before_first_repair_write: maxNarrowReadsBeforeFirstRepairWrite,
          max_scoped_searches_before_first_repair_write: maxScopedSearchesBeforeFirstRepairWrite,
          instruction:
            hiddenContractFirstWrite
              ? `After ordered_actions, the first successful write must target the hidden-contract anchor file before tests/types or broad sweeps. Before that write, bounded narrow read_file calls and exact-file searches are allowed only on ordered anchor files.`
              : exactPhasePrimaryFirstWrite
                ? `After ordered_actions, the first successful write must target verifier phase primary_files before semantic behavior edits, coupled files, broad sweeps, or broad search. Then rerun the required verifier.`
              : sourceContractFirstWrite
                ? `After ordered_actions, the first successful write must target verifier phase primary_files before tests/types or broad sweeps. Before that write, bounded narrow read_file calls and exact-file searches are allowed on ordered anchor files; other search is broad.`
              : `After ordered_actions, the first successful write must target repair_affected_files before broad target sweeps. Before that write, bounded narrow read_file calls and exact-file searches are allowed only on repair_affected_files.`,
          semantic_candidate_trial: semanticCandidateTrial,
        }
      : null,
    repair_second_write: secondWriteFiles.length > 0
      ? {
          allowed_files: secondWriteFiles,
          allowed_read_files: secondWriteFiles,
          max_broad_reads_before_second_repair_write: 0,
          max_narrow_reads_before_second_repair_write: 2,
          max_scoped_searches_before_second_repair_write: 1,
          semantic_candidate_trial: secondSemanticCandidateTrial,
          package_dependency_requirements_v1: args.packageDependencyRequirements.length > 0
            ? args.packageDependencyRequirements
            : null,
          candidate_execution_operator_v1: args.candidateExecutionOperator,
          instruction:
            "After the primary source repair write, the next successful repair write must target the coupled dependency/type-surface/candidate file before broad search, list, broad sweeps, verifier runs, or additional source rewrites. Before that second write, bounded narrow read_file calls and exact-file searches are allowed on coupled files.",
        }
      : null,
    required_verifiers: args.verificationRepairCommands,
    verification_cadence: args.verificationRepairCommands.length > 0
      ? {
          required_verifiers: args.verificationRepairCommands,
          max_successful_writes_before_verifier: maxSuccessfulWritesBeforeVerifier,
          instruction: `After at most ${maxSuccessfulWritesBeforeVerifier} successful write action${maxSuccessfulWritesBeforeVerifier === 1 ? "" : "s"}, run a required verifier before more edits.`,
        }
      : null,
    reason:
      "Runtime converted prior failed verifier evidence into an execution-order contract so the assisted agent repairs before exploring broadly.",
  };
}

function actionSynthesisPlanFromOperatorGuidance(args: {
  verifierFailurePhase: JsonObject | null;
  verificationRepair: JsonObject | null;
  firstActionSequence: JsonObject | null;
  candidateExecutionOperator: JsonObject | null;
  requiredVerifiers: string[];
  repairAffectedFiles: string[];
  allowedEditFiles: string[];
}): JsonObject | null {
  const orderedActions = orderedSequenceActions(args.firstActionSequence);
  const repairFirstWrite = asObject(args.firstActionSequence?.repair_first_write);
  const repairSecondWrite = asObject(args.firstActionSequence?.repair_second_write);
  const primaryTargetFiles = stringList(repairFirstWrite?.allowed_files);
  const coupledTargetFiles = stringList(repairSecondWrite?.allowed_files);
  const candidatePrimaryFiles = stringList(args.candidateExecutionOperator?.primary_target_files);
  const candidateCoupledFiles = stringList(args.candidateExecutionOperator?.coupled_target_files);
  const candidateTargetFiles = stringList(args.candidateExecutionOperator?.target_files);
  const phaseLineHints = jsonObjectList(args.verifierFailurePhase?.line_hints);
  const lineHintLabels = actionSynthesisLineHintLabels(phaseLineHints);
  const repairCommands = stringList(args.verificationRepair?.failed_commands);
  const requiredVerifierCommand = args.requiredVerifiers[0] ?? repairCommands[0] ?? null;
  const targetFiles = uniqueStringValues([
    primaryTargetFiles,
    coupledTargetFiles,
    args.repairAffectedFiles,
    candidatePrimaryFiles,
    candidateCoupledFiles,
    candidateTargetFiles,
  ], 24);
  const fallbackAllowedFiles = targetFiles.length === 0
    ? uniqueStringValues([args.allowedEditFiles], 24)
    : [];
  const effectiveTargetFiles = targetFiles.length > 0 ? targetFiles : fallbackAllowedFiles;
  if (
    orderedActions.length === 0
    && effectiveTargetFiles.length === 0
    && !requiredVerifierCommand
    && !args.candidateExecutionOperator
  ) {
    return null;
  }
  const phaseName = asString(args.verifierFailurePhase?.phase);
  const hasCoupledWrite = primaryTargetFiles.length > 0 && coupledTargetFiles.length > 0;
  const candidateActive = !!args.candidateExecutionOperator;
  const currentStep = orderedActions.length > 0
    ? "ordered_anchor_read"
    : hasCoupledWrite
      ? "primary_then_coupled_then_verifier"
      : lineHintLabels.length > 0 || phaseName === "lint_type_failure"
        ? "line_or_phase_repair"
        : candidateActive
          ? "candidate_trial_repair"
          : requiredVerifierCommand && effectiveTargetFiles.length === 0
            ? "run_required_verifier"
            : "scoped_repair";
  const preferredAction = currentStep === "run_required_verifier"
    ? "run_command"
    : currentStep === "ordered_anchor_read"
      ? "read_file"
      : lineHintLabels.length > 0
        ? "replace_lines"
        : "replace_text";
  const allowedActions = currentStep === "run_required_verifier"
    ? ["run_command"]
    : uniqueStringValues([
        "read_file",
        "search",
        "replace_lines",
        "replace_text",
        "apply_patch",
        requiredVerifierCommand ? "run_command" : null,
      ], 8);
  return {
    summary_version: "action_synthesis_plan_v1",
    authority: "runtime_execution_scaffold",
    promotion_state: "none",
    source: "operator_guidance",
    current_step: currentStep,
    target_files: effectiveTargetFiles,
    primary_target_files: uniqueStringValues([primaryTargetFiles, candidatePrimaryFiles], 16),
    coupled_target_files: uniqueStringValues([coupledTargetFiles, candidateCoupledFiles], 16),
    ordered_actions: orderedActions,
    line_hints: phaseLineHints.slice(0, 8),
    line_hint_labels: lineHintLabels,
    preferred_action: preferredAction,
    allowed_actions: allowedActions,
    required_verifier_command: requiredVerifierCommand,
    quality_gates: [
      "choose exactly one next tool action",
      "execute ordered anchor reads before first repair writes when ordered_actions are present",
      "copy write anchors from the latest read evidence before replace_lines, replace_text, or apply_patch",
      "do not submit no-op edits or stale anchors",
      "write primary target files before coupled target files when both are present",
      "run the required verifier after the bounded primary/coupled repair sequence",
      "do not write outside allowed_edit_files or target_files",
      "candidate guidance remains candidate-only and cannot be promoted without a passing real verifier",
    ],
    payload_limits: {
      max_apply_patch_hunks: hasCoupledWrite ? 2 : 1,
      max_replace_lines_old_lines: lineHintLabels.length > 0 ? 10 : 18,
      max_replace_lines_replacement_lines: lineHintLabels.length > 0 ? 24 : 48,
    },
    instruction: [
      "Synthesize the next action from current Runtime evidence; do not invent a project-specific repair rule.",
      orderedActions.length > 0 ? "Start by executing the ordered anchor read sequence." : null,
      hasCoupledWrite ? "After the primary repair write, preserve the coupled write before verifier rerun unless the verifier phase changes." : null,
      lineHintLabels.length > 0 ? `Start from verifier line hint(s): ${lineHintLabels.join(", ")}.` : null,
      effectiveTargetFiles.length > 0 ? `Target only: ${effectiveTargetFiles.join(", ")}.` : null,
      requiredVerifierCommand ? `Verifier after repair: ${requiredVerifierCommand}.` : null,
    ].filter(Boolean).join(" "),
  };
}

function buildAionisRuntimeGuidance(aionisContext: JsonObject | null, workspaceDir: string | null = null, task: EvalTask | null = null): JsonObject | null {
  if (!aionisContext) return null;
  const kickoff = asObject(asObject(aionisContext.kickoff)?.kickoff_recommendation);
  const planningFirst = asObject(asObject(aionisContext.planning)?.first_step_recommendation);
  const assemblyFirst = asObject(asObject(aionisContext.assembly)?.first_step_recommendation);
  const kickoffContract = asObject(kickoff?.execution_contract_v1);
  const planningContract = asObject(planningFirst?.execution_contract_v1);
  const assemblyContract = asObject(assemblyFirst?.execution_contract_v1);
  const recallContracts = [
    ...recallCandidateContracts(aionisContext.planning),
    ...recallCandidateContracts(aionisContext.assembly),
  ];
  const firstAction = firstRuntimeFirstAction(
    kickoff?.first_action_v1,
    planningFirst?.first_action_v1,
    assemblyFirst?.first_action_v1,
  );
  const editBoundary = firstRuntimeEditBoundary(
    workspaceDir,
    kickoff?.edit_boundary_v1,
    planningFirst?.edit_boundary_v1,
    assemblyFirst?.edit_boundary_v1,
    asObject(asObject(aionisContext.planning)?.operator_projection)?.edit_boundary_v1,
    asObject(asObject(aionisContext.assembly)?.operator_projection)?.edit_boundary_v1,
  );
  const runtimeVerificationRepair = firstRuntimeVerificationRepair(
    workspaceDir,
    kickoff?.verification_repair_v1,
    planningFirst?.verification_repair_v1,
    assemblyFirst?.verification_repair_v1,
    asObject(asObject(aionisContext.planning)?.operator_projection)?.verification_repair_v1,
    asObject(asObject(aionisContext.assembly)?.operator_projection)?.verification_repair_v1,
  );
  const directRepairEvidence = directPriorRepairEvidence(aionisContext);
  const directSuccessEvidence = directPriorSuccessEvidence(aionisContext);
  const replayableDirectSuccessEvidence = orderedSuccessReplayEvidence(directSuccessEvidence);
  const directPhaseEvidence = directRepairEvidenceForPhase(directRepairEvidence);
  const immediateRepairEvidence = directPhaseEvidence.length > 0 ? directPhaseEvidence : directRepairEvidence;
  const directFailureTexts = directEvidenceTexts(directRepairEvidence);
  const immediateFailureTexts = directEvidenceTexts(immediateRepairEvidence);
  const directBlockingAssertions = directBlockingAssertionsFromEvidence(immediateRepairEvidence)
    .filter((assertion) => repairActionMatchesTask(assertion, task));
  const directRepairActions = directRepairActionsFromEvidence(immediateRepairEvidence);
  const successReplayActions = successReplayActionsFromEvidence(replayableDirectSuccessEvidence);
  const successPatchFiles = uniqueStringValues(
    replayableDirectSuccessEvidence.flatMap((entry) => {
      const patchEvidence = asObject(entry.positive_patch_evidence);
      return stringList(patchEvidence?.changed_files);
    }),
    12,
  );
  const directRepairCategories = uniqueStringValues(
    directRepairEvidence.flatMap((entry) => stringList(entry.failure_categories)),
    32,
  );
  const rawAllowedEditFiles = stringList(editBoundary?.allowed_edit_files);
  const forbiddenEditFiles = stringList(editBoundary?.forbidden_edit_files);
  const allowedEditFiles = uniqueStringValues([
    rawAllowedEditFiles,
    successPatchFiles.filter((file) => !forbiddenEditFiles.includes(file)),
  ], 64);
  const allowedReadFiles = uniqueStringValues([
    task?.expected?.allowed_read_files ?? [],
    allowedEditFiles,
  ], 64);
  const semanticRepairCandidates = learningControlSemanticCandidatesFromEvidence(directRepairEvidence, task);
  const semanticCandidateFiles = semanticCandidateTargetFiles(semanticRepairCandidates, allowedEditFiles);
  const semanticCandidateRules = semanticCandidateGuidanceRules(semanticRepairCandidates);
  const requiredVerifiers = stringList(editBoundary?.required_verifiers);
  const antiShortcutRules = stringList(editBoundary?.anti_shortcut_rules);
  const directMentionedFiles = mentionedAllowedFiles(immediateFailureTexts, allowedEditFiles);
  const runtimeAffectedEntries = Array.isArray(runtimeVerificationRepair?.affected_files)
    ? runtimeVerificationRepair.affected_files.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => !!entry)
      .filter((entry) => repairEntryMatchesTask(entry, task))
    : [];
  const directAffectedEntries = directMentionedFiles
    .filter((file) => !runtimeAffectedEntries.some((entry) => asString(entry.path) === file))
    .map((file) => ({
      path: file,
      line: null,
      column: null,
      message: "Direct prior verifier evidence mentioned this allowed file.",
    }));
  const rawRuntimeRepairActions = stringList(runtimeVerificationRepair?.next_actions)
    .filter((action) => repairActionMatchesTask(action, task));
  const taskMatchedDirectRepairActions = directRepairActions
    .filter((action) => repairActionMatchesTask(action, task));
  const runtimeFailedCommands = stringList(runtimeVerificationRepair?.failed_commands);
  const runtimeRepairCategories = codeRepairFailureCategories(stringList(runtimeVerificationRepair?.categories));
  const directVerifierFailurePhase = directVerifierFailurePhaseFromEvidence({
    evidence: immediateRepairEvidence,
    directFailureTexts: immediateFailureTexts.length > 0 ? immediateFailureTexts : directFailureTexts,
    directBlockingAssertions,
    directRepairActions: taskMatchedDirectRepairActions,
    allowedEditFiles,
    requiredVerifiers,
  });
  const selectedVerifierFailurePhase = directVerifierFailurePhase ?? asObject(runtimeVerificationRepair?.verifier_failure_phase_v1);
  const runtimeRepairActions = phaseConsistentRepairActions(rawRuntimeRepairActions, selectedVerifierFailurePhase);
  const phaseMatchedDirectRepairActions = phaseConsistentRepairActions(taskMatchedDirectRepairActions, selectedVerifierFailurePhase);
  const mergedRepairActions = uniqueStringValues([runtimeRepairActions, phaseMatchedDirectRepairActions], 24);
  const verificationRepair = phaseMatchedDirectRepairActions.length > 0 || directMentionedFiles.length > 0
    ? {
        summary_version: "kickoff_verification_repair_v1",
        priority: "required",
        contract_trust: firstStringValue(runtimeVerificationRepair?.contract_trust, "direct_prior_failure_evidence"),
        failed_verifier_count: typeof runtimeVerificationRepair?.failed_verifier_count === "number"
          ? runtimeVerificationRepair.failed_verifier_count
          : directRepairEvidence.length,
        failed_commands: runtimeFailedCommands.length > 0 ? runtimeFailedCommands : requiredVerifiers,
        categories: uniqueStringValues([
          runtimeRepairCategories,
          directRepairCategories,
        ], 32),
        blocking_assertions: directBlockingAssertions,
        affected_files: [...runtimeAffectedEntries, ...directAffectedEntries],
        verifier_failure_phase_v1: directVerifierFailurePhase ?? asObject(runtimeVerificationRepair?.verifier_failure_phase_v1),
        edit_failure_phase_v1: asObject(runtimeVerificationRepair?.edit_failure_phase_v1),
        failed_tool_schema_hints: stringList(runtimeVerificationRepair?.failed_tool_schema_hints),
        next_actions: mergedRepairActions,
        reason: [
          asString(runtimeVerificationRepair?.reason),
          "Runner supplied compact direct prior verifier evidence so later attempts must repair the exact observed failures.",
        ].filter(Boolean).join(" "),
        instruction: uniqueStringValues([
          asString(runtimeVerificationRepair?.instruction),
          directBlockingAssertions.length > 0
            ? `Blocking verifier assertion(s) still failing: ${directBlockingAssertions.join(" ")}`
            : null,
          phaseMatchedDirectRepairActions,
        ], 24).join(" "),
      }
    : runtimeVerificationRepair;
  const rawRepairAffectedFiles = uniqueStringValues(
    Array.isArray(verificationRepair?.affected_files)
      ? verificationRepair.affected_files.map((entry) => asObject(entry)?.path)
      : [],
    8,
  );
  const verifierFailurePhase = asObject(verificationRepair?.verifier_failure_phase_v1);
  const editFailurePhase = asObject(verificationRepair?.edit_failure_phase_v1);
  const phasePrimaryFiles = stringList(verifierFailurePhase?.primary_files);
  const phaseLineHintFiles = Array.isArray(verifierFailurePhase?.line_hints)
    ? verifierFailurePhase.line_hints.map((entry) => asString(asObject(entry)?.path)).filter((file): file is string => !!file)
    : [];
  const editFailurePrimaryFile = asString(editFailurePhase?.primary_file);
  const editFailureLineHintFiles = Array.isArray(editFailurePhase?.line_hints)
    ? editFailurePhase.line_hints.map((entry) => asString(asObject(entry)?.path)).filter((file): file is string => !!file)
    : [];
  const repairMentionedFiles = mentionedAllowedFiles([
    ...stringList(verificationRepair?.next_actions),
    asString(verificationRepair?.instruction) ?? "",
    asString(verifierFailurePhase?.recommended_focus) ?? "",
    asString(editFailurePhase?.recommended_focus) ?? "",
    ...phasePrimaryFiles,
    ...phaseLineHintFiles,
    ...(editFailurePrimaryFile ? [editFailurePrimaryFile] : []),
    ...editFailureLineHintFiles,
    ...directFailureTexts,
    ...antiShortcutRules,
  ], allowedEditFiles);
  const primaryWindowFiles = primaryRepairWindowFiles(verifierFailurePhase, allowedEditFiles);
  const repairAffectedFiles = primaryWindowFiles.length > 0
    ? primaryWindowFiles
    : expandRepairAffectedFiles({
    repairAffectedFiles: uniqueStringValues([
      rawRepairAffectedFiles,
      phasePrimaryFiles,
      phaseLineHintFiles,
      editFailurePrimaryFile ? [editFailurePrimaryFile] : [],
      editFailureLineHintFiles,
    ], 12),
    repairMentionedFiles: uniqueStringValues([repairMentionedFiles, successPatchFiles], 12),
    allowedEditFiles,
    verificationRepair,
  });
  const targetFiles = uniqueStringValues([
    repairAffectedFiles,
    semanticCandidateFiles,
    successPatchFiles,
    editBoundary?.allowed_edit_files,
    firstAction?.target_files,
    firstAction?.file_path,
    kickoffContract?.target_files,
    planningContract?.target_files,
    assemblyContract?.target_files,
    ...recallContracts.map((contract) => contract.target_files),
    kickoff?.file_path,
    planningFirst?.file_path,
    assemblyFirst?.file_path,
    ...recallContracts.map((contract) => contract.file_path),
  ], 8);
  const nextAction = firstStringValue(
    kickoff?.next_action,
    planningFirst?.next_action,
    assemblyFirst?.next_action,
    kickoffContract?.next_action,
    planningContract?.next_action,
    assemblyContract?.next_action,
    ...recallContracts.map((contract) => contract.next_action),
  );
  const selectedTool = firstStringValue(
    kickoff?.selected_tool,
    planningFirst?.selected_tool,
    assemblyFirst?.selected_tool,
    kickoffContract?.selected_tool,
    planningContract?.selected_tool,
    assemblyContract?.selected_tool,
    ...recallContracts.map((contract) => contract.selected_tool),
  );
  if (targetFiles.length === 0 && !nextAction && !selectedTool && !firstAction && !editBoundary && !verificationRepair) return null;
  const firstActionPath = asString(firstAction?.file_path);
  const firstActionKind = asString(firstAction?.action);
  const verificationRepairActions = stringList(verificationRepair?.next_actions);
  const verificationRepairCommands = stringList(verificationRepair?.failed_commands);
  const phaseName = asString(verifierFailurePhase?.phase);
  const phaseRecommendedFocus = asString(verifierFailurePhase?.recommended_focus);
  const phaseAllowedActions = stringList(verifierFailurePhase?.allowed_next_actions);
  const phaseForbiddenActions = stringList(verifierFailurePhase?.forbidden_next_actions);
  const editFailureName = asString(editFailurePhase?.phase);
  const editFailureRecommendedFocus = asString(editFailurePhase?.recommended_focus);
  const editFailureAllowedActions = stringList(editFailurePhase?.allowed_next_actions);
  const editFailureForbiddenActions = stringList(editFailurePhase?.forbidden_next_actions);
  const phaseLineHints = Array.isArray(verifierFailurePhase?.line_hints)
    ? verifierFailurePhase.line_hints.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => !!entry)
    : [];
  const editFailureLineHints = Array.isArray(editFailurePhase?.line_hints)
    ? editFailurePhase.line_hints.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => !!entry)
    : [];
  const phaseLineHintLabels = phaseLineHints
    .map((entry) => {
      const pathValue = asString(entry.path);
      if (!pathValue) return null;
      const line = typeof entry.line === "number" ? entry.line : null;
      const column = typeof entry.column === "number" ? entry.column : null;
      return `${pathValue}${line ? `:${line}${column ? `:${column}` : ""}` : ""}`;
    })
    .filter((value): value is string => !!value);
  const editFailureLineHintLabels = editFailureLineHints
    .map((entry) => {
      const pathValue = asString(entry.path);
      if (!pathValue) return null;
      const line = typeof entry.line === "number" ? entry.line : null;
      const column = typeof entry.column === "number" ? entry.column : null;
      return `${pathValue}${line ? `:${line}${column ? `:${column}` : ""}` : ""}`;
    })
    .filter((value): value is string => !!value);
  const coupledRepairFiles = repairAffectedFiles.filter((file) => !rawRepairAffectedFiles.includes(file));
  const executableSuccessReplayPlanCount = replayableDirectSuccessEvidence.length;
  const packageDependencyRequirements = mergePackageDependencyRequirements(
    packageDependencyRequirementsFromTask({
      task,
      workspaceDir,
      allowedEditFiles,
    }),
    packageDependencyRequirementsFromSemanticCandidates({
      candidates: semanticRepairCandidates,
      workspaceDir,
      allowedEditFiles,
    }),
  );
  const candidateExecutionOperator = candidateExecutionOperatorFromCandidates({
    candidates: semanticRepairCandidates,
    primaryFiles: repairAffectedFiles.length > 0 ? repairAffectedFiles : phasePrimaryFiles,
    allowedFiles: allowedEditFiles,
    requiredVerifiers: verificationRepairCommands.length > 0 ? verificationRepairCommands : requiredVerifiers,
    packageDependencyRequirements,
  });
  const cognitiveEntropyEngine = cognitiveEntropyEngineFromEvidence({
    directRepairEvidence,
    verifierFailurePhase,
    repairAffectedFiles,
    targetFiles,
    allowedEditFiles,
    allowedReadFiles,
    semanticRepairCandidates,
    candidateExecutionOperator,
  });
  const firstActionSequence = executableSuccessReplayPlanCount > 0
    ? null
    : buildFirstActionSequence({
        firstAction,
        repairAffectedFiles,
        verificationRepairCommands,
        verifierFailurePhase,
        sourceContractRepair: verificationRepairActions.includes("source_contract_failure")
          || stringList(verificationRepair?.categories).includes("source_contract_failure"),
        semanticRepairCandidates,
        candidateExecutionOperator,
        packageDependencyRequirements,
      });
  const actionSynthesisPlan = actionSynthesisPlanFromOperatorGuidance({
    verifierFailurePhase,
    verificationRepair,
    firstActionSequence,
    candidateExecutionOperator,
    requiredVerifiers: verificationRepairCommands.length > 0 ? verificationRepairCommands : requiredVerifiers,
    repairAffectedFiles,
    allowedEditFiles,
  });
  const candidateTrialStrategy = semanticCandidateTrialStrategy({
    candidates: semanticRepairCandidates,
    allowedFiles: repairAffectedFiles.length > 0 ? repairAffectedFiles : allowedEditFiles,
    requiredVerifiers: verificationRepairCommands.length > 0 ? verificationRepairCommands : requiredVerifiers,
    verifierFailurePhase,
  });
  const firstActionSequenceCadence = asObject(firstActionSequence?.verification_cadence);
  const maxSuccessfulWritesBeforeVerifier = typeof firstActionSequenceCadence?.max_successful_writes_before_verifier === "number"
    ? Math.max(1, Math.floor(firstActionSequenceCadence.max_successful_writes_before_verifier))
    : 3;
  const verifierCadenceRule = requiredVerifiers.length > 0
    ? `After at most ${maxSuccessfulWritesBeforeVerifier} successful write action${maxSuccessfulWritesBeforeVerifier === 1 ? "" : "s"}, run a required verifier before more edits.`
    : null;
  const phaseOperatingRules = [
    editFailureName && editFailureRecommendedFocus
      ? `Edit failure phase is ${editFailureName}; evidence focus: ${editFailureRecommendedFocus}`
      : null,
    editFailurePrimaryFile
      ? `Prefer edit recovery primary_file before unrelated implementation guesses: ${editFailurePrimaryFile}.`
      : null,
    editFailureLineHintLabels.length > 0
      ? `Start edit recovery at edit line hint(s): ${editFailureLineHintLabels.join(", ")}.`
      : null,
    editFailureAllowedActions.length > 0
      ? `Allowed edit recovery next actions: ${editFailureAllowedActions.join(", ")}.`
      : null,
    editFailureForbiddenActions.length > 0
      ? `Forbidden before edit recovery/verifier rerun: ${editFailureForbiddenActions.join(", ")}.`
      : null,
    phaseName && phaseRecommendedFocus
      ? `Verifier failure phase is ${phaseName}; evidence focus: ${phaseRecommendedFocus}`
      : null,
    phasePrimaryFiles.length > 0
      ? `Prefer phase primary_files before broad exploration: ${phasePrimaryFiles.join(", ")}.`
      : null,
    phaseLineHintLabels.length > 0
      ? `Start phase repair at verifier line hint(s): ${phaseLineHintLabels.join(", ")}.`
      : null,
    phaseAllowedActions.length > 0
      ? `Allowed phase next actions: ${phaseAllowedActions.join(", ")}.`
      : null,
    phaseForbiddenActions.length > 0
      ? `Forbidden before phase repair/verifier rerun: ${phaseForbiddenActions.join(", ")}.`
      : null,
  ].filter((rule): rule is string => !!rule);
  return {
    guidance_version: "aionis_real_llm_operator_guidance_v1",
    first_action_v1: firstAction,
    first_action_sequence_v1: firstActionSequence,
    action_synthesis_plan_v1: actionSynthesisPlan,
    cognitive_entropy_engine_v1: cognitiveEntropyEngine,
    candidate_execution_operator_v1: candidateExecutionOperator,
    candidate_trial_strategy_v1: candidateTrialStrategy,
    edit_boundary_v1: editBoundary,
    verification_repair_v1: verificationRepair,
    verifier_failure_phase_v1: verifierFailurePhase,
    edit_failure_phase_v1: editFailurePhase,
    semantic_repair_candidates_v1: semanticRepairCandidates.length > 0
      ? {
          summary_version: "learning_control_semantic_repair_candidates_v1",
          authority: "advisory",
          promotion_state: "candidate",
          candidate_count: semanticRepairCandidates.length,
          target_files: semanticCandidateFiles,
          candidates: semanticRepairCandidates,
          operating_rules: semanticCandidateRules,
          adjudication_contract: [
            "LLM semantic candidates are candidate-only.",
            "Runtime edit boundary, verifier phase, provider/protocol quarantine, and workflow promotion gates decide whether they can influence future runs.",
            "A passing real verifier run plus regression or holdout evidence is required before workflow promotion.",
          ],
        }
      : null,
    direct_prior_failure_evidence_v1: directRepairEvidence.length > 0
      ? {
          summary_version: "aionis_direct_prior_failure_evidence_v1",
          failed_run_count: directRepairEvidence.length,
          blocking_assertions: directBlockingAssertions,
          diagnostics: directRepairEvidence,
          required_repair_actions: phaseMatchedDirectRepairActions,
        }
      : null,
    direct_success_replay_evidence_v1: replayableDirectSuccessEvidence.length > 0
      ? {
          summary_version: "aionis_direct_success_replay_evidence_v1",
          priority: "required",
          replay_mode: "apply_positive_patch_before_new_implementation",
          passed_run_count: replayableDirectSuccessEvidence.length,
          changed_files: successPatchFiles,
          patch_count: replayableDirectSuccessEvidence.reduce((sum, entry) => {
            const patchEvidence = asObject(entry.positive_patch_evidence);
            return sum + (Array.isArray(patchEvidence?.patches) ? patchEvidence.patches.length : 0);
          }, 0),
          replay_contracts: replayableDirectSuccessEvidence,
          required_replay_actions: successReplayActions,
        }
      : null,
    repair_affected_files: repairAffectedFiles,
    selected_tool: selectedTool,
    target_files: targetFiles,
    allowed_edit_files: allowedEditFiles,
    allowed_read_files: allowedReadFiles,
    forbidden_edit_files: forbiddenEditFiles,
    required_verifiers: requiredVerifiers,
    next_action: nextAction,
    task_family: firstStringValue(
      kickoff?.task_family,
      planningFirst?.task_family,
      assemblyFirst?.task_family,
      kickoffContract?.task_family,
      planningContract?.task_family,
      assemblyContract?.task_family,
      ...recallContracts.map((contract) => contract.task_family),
    ),
    contract_trust: firstStringValue(
      kickoff?.contract_trust,
      planningFirst?.contract_trust,
      assemblyFirst?.contract_trust,
      ...recallContracts.map((contract) => contract.contract_trust),
    ),
    history_applied: kickoff?.history_applied === true
      || planningFirst?.history_applied === true
      || assemblyFirst?.history_applied === true
      || recallContracts.length > 0,
    operating_rules: firstAction
      ? [
          "Execute first_action_v1 before any broad list/search discovery.",
          firstActionKind === "read_file" && firstActionPath
            ? `First action must be read_file on ${firstActionPath}.`
            : `First action must be ${firstActionKind ?? "the Runtime first action"}.`,
          firstActionSequence ? "Execute first_action_sequence_v1.ordered_actions in order before broad target sweeps; narrow read_file continuations on already-read ordered files are allowed for later line ranges." : null,
          allowedEditFiles.length > 0 ? `Only write allowed_edit_files: ${allowedEditFiles.join(", ")}.` : null,
          forbiddenEditFiles.length > 0 ? `Never write forbidden_edit_files: ${forbiddenEditFiles.join(", ")}.` : null,
          successReplayActions.length > 0 ? `Success replay is required before new implementation: ${successReplayActions.join(" ")} Do not write a hand-authored alternative until apply_patch with positive_patch_evidence fails or the verifier proves the replay is insufficient.` : null,
          verificationRepairActions.length > 0 ? `Before finishing, apply verification_repair_v1: ${verificationRepairActions.join(" ")}` : null,
          actionSynthesisPlan ? "Action synthesis plan is active as execution scaffolding only; use it to choose one bounded next action, not as promoted memory." : null,
          cognitiveEntropyEngine ? `Cognitive entropy engine is active: ${stringList(cognitiveEntropyEngine.operating_rules).join(" ")}` : null,
          candidateExecutionOperator ? `Candidate execution operator is active: ${stringList(candidateExecutionOperator.required_sequence).join(" ")}` : null,
          candidateTrialStrategy ? `Candidate trial strategy is active: ${stringList(candidateTrialStrategy.required_sequence).join(" ")}` : null,
          ...semanticCandidateRules,
          ...phaseOperatingRules,
          directBlockingAssertions.length > 0 ? `Treat blocking_assertions as exact acceptance gates: ${directBlockingAssertions.join(" ")}` : null,
          phaseMatchedDirectRepairActions.length > 0 ? `Before finishing, satisfy direct_prior_failure_evidence_v1: ${phaseMatchedDirectRepairActions.join(" ")}` : null,
          coupledRepairFiles.length > 0 ? `Because verification_repair_v1 includes type/test contract failures, repair coupled type/type-test files too: ${coupledRepairFiles.join(", ")}.` : null,
          repairAffectedFiles.length > 0 ? `After first_action_v1, prioritize repair_affected_files before broad target sweeps: ${repairAffectedFiles.join(", ")}.` : null,
          repairAffectedFiles.length > 0 ? `First successful write should target repair_affected_files: ${repairAffectedFiles.join(", ")}.` : null,
          repairAffectedFiles.length > 0 ? "Do not reread every target file up front when verification_repair_v1 already names concrete affected files." : null,
          verifierCadenceRule,
          "Do not expand to adjacent files unless the first action output or verifier output proves the target hypothesis is wrong.",
          verificationRepairCommands.length > 0
            ? `Rerun failed verifier(s): ${verificationRepairCommands.join(" | ")}.`
            : requiredVerifiers.length > 0 ? `Run required_verifiers before finishing: ${requiredVerifiers.join(" | ")}.` : "Run the verifier before finishing.",
          ...antiShortcutRules,
        ].filter((rule): rule is string => !!rule)
      : targetFiles.length > 0
      ? [
          "Inspect the listed target_files before broad list/search discovery.",
          firstActionSequence ? "Execute first_action_sequence_v1.ordered_actions in order before broad target sweeps; narrow read_file continuations on already-read ordered files are allowed for later line ranges." : null,
          allowedEditFiles.length > 0 ? `Only write allowed_edit_files: ${allowedEditFiles.join(", ")}.` : null,
          forbiddenEditFiles.length > 0 ? `Never write forbidden_edit_files: ${forbiddenEditFiles.join(", ")}.` : null,
          successReplayActions.length > 0 ? `Success replay is required before new implementation: ${successReplayActions.join(" ")} Do not write a hand-authored alternative until apply_patch with positive_patch_evidence fails or the verifier proves the replay is insufficient.` : null,
          verificationRepairActions.length > 0 ? `Before finishing, apply verification_repair_v1: ${verificationRepairActions.join(" ")}` : null,
          actionSynthesisPlan ? "Action synthesis plan is active as execution scaffolding only; use it to choose one bounded next action, not as promoted memory." : null,
          cognitiveEntropyEngine ? `Cognitive entropy engine is active: ${stringList(cognitiveEntropyEngine.operating_rules).join(" ")}` : null,
          candidateExecutionOperator ? `Candidate execution operator is active: ${stringList(candidateExecutionOperator.required_sequence).join(" ")}` : null,
          candidateTrialStrategy ? `Candidate trial strategy is active: ${stringList(candidateTrialStrategy.required_sequence).join(" ")}` : null,
          ...semanticCandidateRules,
          ...phaseOperatingRules,
          directBlockingAssertions.length > 0 ? `Treat blocking_assertions as exact acceptance gates: ${directBlockingAssertions.join(" ")}` : null,
          phaseMatchedDirectRepairActions.length > 0 ? `Before finishing, satisfy direct_prior_failure_evidence_v1: ${phaseMatchedDirectRepairActions.join(" ")}` : null,
          coupledRepairFiles.length > 0 ? `Because verification_repair_v1 includes type/test contract failures, repair coupled type/type-test files too: ${coupledRepairFiles.join(", ")}.` : null,
          repairAffectedFiles.length > 0 ? `Prioritize repair_affected_files before broad target sweeps: ${repairAffectedFiles.join(", ")}.` : null,
          repairAffectedFiles.length > 0 ? `First successful write should target repair_affected_files: ${repairAffectedFiles.join(", ")}.` : null,
          repairAffectedFiles.length > 0 ? "Do not reread every target file up front when verification_repair_v1 already names concrete affected files." : null,
          verifierCadenceRule,
          "Do not expand to adjacent files unless the target file or verifier output proves the target hypothesis is wrong.",
          verificationRepairCommands.length > 0
            ? `Use replace_lines for multi-line edits or replace_text for exact localized edits, then rerun failed verifier(s): ${verificationRepairCommands.join(" | ")}.`
            : requiredVerifiers.length > 0
            ? `Use replace_lines for multi-line edits or replace_text for exact localized edits, then run required_verifiers: ${requiredVerifiers.join(" | ")}.`
            : "Use replace_lines for multi-line edits or replace_text for exact localized edits, then run the verifier.",
          ...antiShortcutRules,
        ].filter((rule): rule is string => !!rule)
      : [
          "Use the selected_tool and next_action as the first narrow hypothesis before broad discovery.",
          firstActionSequence ? "Execute first_action_sequence_v1.ordered_actions in order before broad target sweeps; narrow read_file continuations on already-read ordered files are allowed for later line ranges." : null,
          successReplayActions.length > 0 ? `Success replay is required before new implementation: ${successReplayActions.join(" ")} Do not write a hand-authored alternative until apply_patch with positive_patch_evidence fails or the verifier proves the replay is insufficient.` : null,
          verificationRepairActions.length > 0 ? `Before finishing, apply verification_repair_v1: ${verificationRepairActions.join(" ")}` : null,
          actionSynthesisPlan ? "Action synthesis plan is active as execution scaffolding only; use it to choose one bounded next action, not as promoted memory." : null,
          cognitiveEntropyEngine ? `Cognitive entropy engine is active: ${stringList(cognitiveEntropyEngine.operating_rules).join(" ")}` : null,
          candidateExecutionOperator ? `Candidate execution operator is active: ${stringList(candidateExecutionOperator.required_sequence).join(" ")}` : null,
          candidateTrialStrategy ? `Candidate trial strategy is active: ${stringList(candidateTrialStrategy.required_sequence).join(" ")}` : null,
          ...semanticCandidateRules,
          ...phaseOperatingRules,
          directBlockingAssertions.length > 0 ? `Treat blocking_assertions as exact acceptance gates: ${directBlockingAssertions.join(" ")}` : null,
          phaseMatchedDirectRepairActions.length > 0 ? `Before finishing, satisfy direct_prior_failure_evidence_v1: ${phaseMatchedDirectRepairActions.join(" ")}` : null,
          coupledRepairFiles.length > 0 ? `Because verification_repair_v1 includes type/test contract failures, repair coupled type/type-test files too: ${coupledRepairFiles.join(", ")}.` : null,
          repairAffectedFiles.length > 0 ? `Prioritize repair_affected_files before broad target sweeps: ${repairAffectedFiles.join(", ")}.` : null,
          repairAffectedFiles.length > 0 ? `First successful write should target repair_affected_files: ${repairAffectedFiles.join(", ")}.` : null,
          repairAffectedFiles.length > 0 ? "Do not reread every target file up front when verification_repair_v1 already names concrete affected files." : null,
          verifierCadenceRule,
          verificationRepairCommands.length > 0
            ? `Rerun failed verifier(s): ${verificationRepairCommands.join(" | ")}.`
            : requiredVerifiers.length > 0 ? `Run required_verifiers before finishing: ${requiredVerifiers.join(" | ")}.` : "Run the verifier before finishing.",
          ...antiShortcutRules,
        ].filter((rule): rule is string => !!rule),
  };
}

function targetFileTouched(event: ToolEvent, targetFiles: string[]): boolean {
  if (targetFiles.length === 0) return false;
  const serialized = JSON.stringify({ input: event.tool_input, output: event.output_signature, touched: event.touched_files, writes: event.write_files });
  return targetFiles.some((file) => serialized.includes(file));
}

function targetFileWritten(event: ToolEvent, targetFiles: string[]): boolean {
  if (event.write_files.length === 0) return false;
  if (targetFiles.length === 0) return true;
  return event.write_files.some((file) => targetFiles.includes(file));
}

function eventLatencyMs(event: ToolEvent | undefined, startedMs: number): number | null {
  if (!event) return null;
  return Math.max(0, event.started_at_ms - startedMs);
}

function eventTouchesAnyFile(event: ToolEvent, files: string[]): boolean {
  if (files.length === 0) return false;
  const inputPath = asString(event.tool_input.path);
  return files.some((file) => (
    inputPath === file
    || event.touched_files.includes(file)
    || event.write_files.includes(file)
  ));
}

function eventMatchesOrderedAction(event: ToolEvent | undefined, expected: JsonObject): boolean {
  if (!event) return false;
  const action = asString(expected.action);
  if (!action || event.tool_name !== action) return false;
  const filePath = asString(expected.file_path);
  if (!filePath) return true;
  return eventTouchesAnyFile(event, [filePath]);
}

function eventIsOrderedActionContinuationRead(
  event: ToolEvent,
  orderedActions: JsonObject[],
  satisfiedCount: number,
): boolean {
  if (event.tool_name !== "read_file") return false;
  const files = uniqueStringValues(
    orderedActions
      .slice(0, Math.max(0, satisfiedCount))
      .map((action) => orderedActionFilePath(action))
      .filter((file): file is string => !!file),
    32,
  );
  return files.length > 0 && eventTouchesAnyFile(event, files);
}

function guidanceFirstActionSequence(guidance: JsonObject | null | undefined): JsonObject | null {
  return asObject(guidance?.first_action_sequence_v1);
}

function orderedSequenceActions(sequence: JsonObject | null): JsonObject[] {
  const actions = Array.isArray(sequence?.ordered_actions) ? sequence.ordered_actions : [];
  return actions.map((action) => asObject(action)).filter((action): action is JsonObject => !!action);
}

function sequenceRepairWriteFiles(sequence: JsonObject | null): string[] {
  const repairFirstWrite = asObject(sequence?.repair_first_write);
  return stringList(repairFirstWrite?.allowed_files);
}

function sequencePreWriteReadFiles(sequence: JsonObject | null): string[] {
  const repairFirstWrite = asObject(sequence?.repair_first_write);
  const explicit = stringList(repairFirstWrite?.allowed_read_files);
  if (explicit.length > 0) return explicit;
  return orderedSequenceActions(sequence)
    .map((action) => asString(action.file_path))
    .filter((file): file is string => !!file);
}

function sequenceMaxNarrowReadsBeforeFirstRepairWrite(sequence: JsonObject | null): number | null {
  const repairFirstWrite = asObject(sequence?.repair_first_write);
  const value = repairFirstWrite?.max_narrow_reads_before_first_repair_write;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function sequenceMaxScopedSearchesBeforeFirstRepairWrite(sequence: JsonObject | null): number | null {
  const repairFirstWrite = asObject(sequence?.repair_first_write);
  const value = repairFirstWrite?.max_scoped_searches_before_first_repair_write;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function sequenceRepairSecondWriteFiles(sequence: JsonObject | null): string[] {
  const repairSecondWrite = asObject(sequence?.repair_second_write);
  return stringList(repairSecondWrite?.allowed_files);
}

function sequenceSecondWriteReadFiles(sequence: JsonObject | null): string[] {
  const repairSecondWrite = asObject(sequence?.repair_second_write);
  const explicit = stringList(repairSecondWrite?.allowed_read_files);
  if (explicit.length > 0) return explicit;
  return sequenceRepairSecondWriteFiles(sequence);
}

function sequenceMaxNarrowReadsBeforeSecondRepairWrite(sequence: JsonObject | null): number | null {
  const repairSecondWrite = asObject(sequence?.repair_second_write);
  const value = repairSecondWrite?.max_narrow_reads_before_second_repair_write;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function sequenceMaxScopedSearchesBeforeSecondRepairWrite(sequence: JsonObject | null): number | null {
  const repairSecondWrite = asObject(sequence?.repair_second_write);
  const value = repairSecondWrite?.max_scoped_searches_before_second_repair_write;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function sequencePackageDependencyRequirements(sequence: JsonObject | null): JsonObject[] {
  const repairSecondWrite = asObject(sequence?.repair_second_write);
  const entries = Array.isArray(repairSecondWrite?.package_dependency_requirements_v1)
    ? repairSecondWrite.package_dependency_requirements_v1
    : [];
  return entries.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => !!entry);
}

function broadReadBeforeRepairWriteCount(args: {
  events: ToolEvent[];
  orderedActionCount: number;
  repairFiles: string[];
  allowedReadFiles: string[];
  firstRepairWriteIndex: number;
}): number {
  if (args.repairFiles.length === 0) return 0;
  const allowedReadFiles = args.allowedReadFiles.length > 0 ? args.allowedReadFiles : args.repairFiles;
  const boundary = args.firstRepairWriteIndex >= 0 ? args.firstRepairWriteIndex : args.events.length;
  return args.events
    .slice(args.orderedActionCount, boundary)
    .filter((event) => (
      event.tool_name === "list_files"
      || event.tool_name === "search"
      || event.tool_name === "run_command"
      || (event.tool_name === "read_file" && !eventTouchesAnyFile(event, allowedReadFiles))
    )).length;
}

function broadActionBeforeSecondRepairWriteCount(args: {
  events: ToolEvent[];
  firstRepairWriteIndex: number;
  secondRepairWriteIndex: number;
  repairSecondWriteFiles: string[];
  allowedReadFiles: string[];
}): number {
  if (args.repairSecondWriteFiles.length === 0 || args.firstRepairWriteIndex < 0) return 0;
  const allowedReadFiles = args.allowedReadFiles.length > 0 ? args.allowedReadFiles : args.repairSecondWriteFiles;
  const boundary = args.secondRepairWriteIndex >= 0 ? args.secondRepairWriteIndex : args.events.length;
  return args.events
    .slice(args.firstRepairWriteIndex + 1, boundary)
    .filter((event) => (
      event.tool_name === "list_files"
      || event.tool_name === "search"
      || event.tool_name === "run_command"
      || (event.tool_name === "read_file" && !eventTouchesAnyFile(event, allowedReadFiles))
      || (event.write_files.length > 0 && !targetFileWritten(event, args.repairSecondWriteFiles))
    )).length;
}

function firstActionSequenceMetrics(events: ToolEvent[], guidance: JsonObject | null | undefined): {
  present: boolean;
  followed: boolean | null;
  violation: string | null;
  firstRepairFileWriteStep: number | null;
  preRepairWriteBroadReadCount: number;
  repairSecondWritePresent: boolean;
  secondRepairFileWriteStep: number | null;
  postFirstRepairPreSecondBroadActionCount: number;
} {
  const sequence = guidanceFirstActionSequence(guidance);
  if (!sequence) {
    return {
      present: false,
      followed: null,
      violation: null,
      firstRepairFileWriteStep: null,
      preRepairWriteBroadReadCount: 0,
      repairSecondWritePresent: false,
      secondRepairFileWriteStep: null,
      postFirstRepairPreSecondBroadActionCount: 0,
    };
  }
  const orderedActions = orderedSequenceActions(sequence);
  const repairFiles = sequenceRepairWriteFiles(sequence);
  const preWriteReadFiles = sequencePreWriteReadFiles(sequence);
  const repairSecondWriteFiles = sequenceRepairSecondWriteFiles(sequence);
  const secondWriteReadFiles = sequenceSecondWriteReadFiles(sequence);
  const firstWriteEvent = events.find((event) => event.status === "success" && event.write_files.length > 0);
  const firstRepairWriteIndex = events.findIndex((event) => event.status === "success" && targetFileWritten(event, repairFiles));
  const firstRepairWriteEvent = firstRepairWriteIndex >= 0 ? events[firstRepairWriteIndex] : undefined;
  const secondRepairWriteRelativeIndex = firstRepairWriteIndex >= 0 && repairSecondWriteFiles.length > 0
    ? events.slice(firstRepairWriteIndex).findIndex((event) => (
        event.status === "success" && targetFileWritten(event, repairSecondWriteFiles)
      ))
    : -1;
  const secondRepairWriteIndex = secondRepairWriteRelativeIndex >= 0
    ? firstRepairWriteIndex + secondRepairWriteRelativeIndex
    : -1;
  const secondRepairWriteEvent = secondRepairWriteIndex >= 0 ? events[secondRepairWriteIndex] : undefined;
  let violation: string | null = null;
  let satisfiedOrderedActions = 0;
  let orderedActionBoundaryIndex = 0;
  for (const [eventIndex, event] of events.entries()) {
    if (satisfiedOrderedActions >= orderedActions.length) {
      orderedActionBoundaryIndex = eventIndex;
      break;
    }

    const expected = orderedActions[satisfiedOrderedActions];
    if (event.status === "success" && eventMatchesOrderedAction(event, expected)) {
      satisfiedOrderedActions += 1;
      orderedActionBoundaryIndex = eventIndex + 1;
      continue;
    }

    if (event.status === "success" && eventIsOrderedActionContinuationRead(event, orderedActions, satisfiedOrderedActions)) {
      orderedActionBoundaryIndex = eventIndex + 1;
      continue;
    }

    if (asString(asObject(event.output_signature)?.sequence_policy_error)) {
      violation = `ordered_action_${satisfiedOrderedActions + 1}_mismatch`;
      break;
    }
  }
  if (!violation && satisfiedOrderedActions < orderedActions.length) {
    violation = `ordered_action_${satisfiedOrderedActions + 1}_missing`;
  }
  const preRepairWriteBroadReadCount = broadReadBeforeRepairWriteCount({
    events,
    orderedActionCount: orderedActionBoundaryIndex,
    repairFiles,
    allowedReadFiles: preWriteReadFiles,
    firstRepairWriteIndex,
  });
  const postFirstRepairPreSecondBroadActionCount = broadActionBeforeSecondRepairWriteCount({
    events,
    firstRepairWriteIndex,
    secondRepairWriteIndex,
    repairSecondWriteFiles,
    allowedReadFiles: secondWriteReadFiles,
  });
  if (!violation && repairFiles.length > 0) {
    if (!firstWriteEvent) {
      violation = "missing_first_write";
    } else if (!targetFileWritten(firstWriteEvent, repairFiles)) {
      violation = "first_write_not_repair_file";
    } else if (preRepairWriteBroadReadCount > 0) {
      violation = "broad_read_before_repair_write";
    }
  }
  if (!violation && repairSecondWriteFiles.length > 0) {
    if (firstRepairWriteIndex < 0) {
      violation = "missing_first_repair_write_before_second";
    } else if (secondRepairWriteIndex < 0) {
      violation = "missing_second_repair_write";
    } else if (postFirstRepairPreSecondBroadActionCount > 0) {
      violation = "broad_action_before_second_repair_write";
    }
  }
  return {
    present: true,
    followed: violation ? false : true,
    violation,
    firstRepairFileWriteStep: firstRepairWriteEvent?.step_index ?? null,
    preRepairWriteBroadReadCount,
    repairSecondWritePresent: repairSecondWriteFiles.length > 0,
    secondRepairFileWriteStep: secondRepairWriteEvent?.step_index ?? null,
    postFirstRepairPreSecondBroadActionCount,
  };
}

function sequencePolicyBlockCount(events: ToolEvent[]): number {
  return events.filter((event) => {
    const output = asObject(event.output_signature);
    return asString(output?.sequence_policy_error)
      || asString(output?.package_dependency_lock_error)
      || asString(output?.cognitive_entropy_probe_error);
  }).length;
}

function failureCategoriesFromCommandText(stderr: string, stdout: string): string[] {
  const categories: string[] = [];
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  if (/xo|eslint|prettier|expected indentation|no-await-in-loop|@stylistic|padding-line-between-statements/.test(combined)) {
    categories.push("lint_or_format_failure");
  }
  if (/tsd|typescript|expecttype|\.d\.ts|type error|iterableoptions|\berror\s+ts\d{4}\b/.test(combined)) {
    categories.push("type_contract_failure");
  }
  if (/assertionerror|err_assertion|ava|test failed|not equal|promise rejected|promise resolved|expected promise to reject/.test(combined)) {
    categories.push("test_assertion_failure");
  }
  if (/verifier|command failed: npm test|github-real-project-contracts/.test(combined)) {
    categories.push("verifier_command_failure");
  }
  if (/assertionerror|err_assertion|must /.test(combined)) {
    categories.push("assertion_failure");
  }
  if (/abortsignal|signal\.reason|abort reason|aborted/.test(combined)) {
    categories.push("async_rejection_handling");
  }
  if (/async iterable|iterable options/.test(combined)) {
    categories.push("async_iterable_contract_failure");
  }
  if (/must expose|source must|must assert|must reject|must stop|must call|must not/.test(combined)) {
    categories.push("source_contract_failure");
  }
  return categories;
}

function failureCategoriesFromEvent(event: ToolEvent): string[] {
  const categories: string[] = [];
  if (event.status !== "failed") return categories;
  if (event.tool_name === "run_command") {
    categories.push("run_command_failure");
    const output = asObject(event.output_signature);
    const result = asObject(output?.result);
    const stderr = asString(result?.stderr) ?? "";
    const stdout = asString(result?.stdout) ?? "";
    categories.push(...failureCategoriesFromCommandText(stderr, stdout));
  } else {
    categories.push(`${event.tool_name}_failure`);
  }
  const output = asObject(event.output_signature);
  if (asString(output?.runtime_control) === "direct_success_replay") categories.push("runtime_success_replay_failure");
  if (asString(output?.llm_api_error)) categories.push("llm_api_error");
  if (asString(output?.llm_protocol_exhausted)) {
    categories.push("llm_protocol_error", "llm_protocol_fatal", "tool_protocol_failure");
  }
  if (asString(output?.schema_correction)) categories.push("tool_schema_error");
  if (asString(output?.write_policy_error)) categories.push("edit_boundary_write_policy_violation");
  if (asString(output?.sequence_policy_error)) categories.push("first_action_sequence_policy_violation");
  if (asString(output?.verification_cadence_error)) categories.push("verification_cadence_policy_violation");
  if (asString(output?.package_dependency_lock_error)) categories.push("package_dependency_policy_violation");
  if (asString(output?.cognitive_entropy_probe_error)) categories.push("cognitive_entropy_probe_policy_violation");
  if (asObject(output?.policy_block_noncompliance_budget_v1)?.required === true) {
    categories.push("policy_block_noncompliance_budget_exhausted", "tool_protocol_failure");
  }
  if (asObject(output?.verifier_stagnation_stop_v1)?.required === true) {
    categories.push("verifier_stagnation_stop", "repeated_verifier_failure");
  }
  if (asObject(output?.candidate_trial_stagnation_stop_v1)?.required === true) {
    categories.push("candidate_trial_stagnation_stop", "candidate_counter_evidence", "repeated_verifier_failure");
  }
  if (asObject(output?.tool_payload_exhaustion_stop_v1)?.required === true) {
    categories.push("tool_payload_exhaustion_stop", "tool_payload_failure");
    if (asString(asObject(output?.tool_payload_exhaustion_stop_v1)?.reason) === "locked_repair_tool_executability_exhausted") {
      categories.push("tool_executability_failure");
    }
  }
  if (output?.expected_old_lines_match === false) categories.push("stale_line_anchor_failure");
  if (output?.edit_noop === true) categories.push("noop_edit_failure");
  if (event.write_files.length > 0) categories.push("failed_tool_wrote_files");
  return categories;
}

function computeMetrics(args: {
  task: EvalTask;
  events: ToolEvent[];
  verifier: CommandResult;
  tokenUsage: { input: number; output: number };
  startedMs: number;
  endedMs?: number;
  llmApiErrorCount: number;
  llmProtocolErrorCount: number;
  llmProtocolRepairCount: number;
  policyBlockRecoveryModeCount: number;
  policyBlockRecoveryProtocolErrorCount: number;
  repairActionCompilerPresent?: boolean;
  llmProtocolFatalError?: string | null;
  aionisGuidance?: JsonObject | null;
}): RunMetrics {
  const targetFiles = args.task.expected?.target_files ?? [];
  const allowedTouchFiles = new Set([
    ...targetFiles,
    ...(args.task.expected?.allowed_read_files ?? []),
  ]);
  const forbiddenEditFiles = args.task.expected?.forbidden_edit_files ?? [];
  const touched = new Set<string>();
  const edited = new Set<string>();
  for (const event of args.events) {
    for (const file of event.touched_files) touched.add(file);
    for (const file of event.write_files ?? []) edited.add(file);
  }
  const firstTool = args.events[0] ?? null;
  const firstPayload = firstTool ? JSON.stringify({ tool: firstTool.tool_name, input: firstTool.tool_input }) : "";
  const firstKeywords = args.task.expected?.first_action_keywords ?? [];
  const firstActionCorrect = firstKeywords.length > 0
    ? firstKeywords.some((keyword) => firstPayload.includes(keyword))
    : null;
  const firstTargetIndex = args.events.findIndex((event) => targetFileTouched(event, targetFiles));
  const repeatedDiscoverySteps = firstTargetIndex > 0
    ? args.events.slice(0, firstTargetIndex).filter((event) => (
        event.tool_name === "list_files"
        || event.tool_name === "search"
        || event.tool_name === "read_file"
        || event.tool_name === "run_command"
      )).length
    : firstTargetIndex === 0 ? 0 : args.events.length;
  const wrongFileTouches = targetFiles.length === 0
    ? 0
    : [...touched].filter((file) => !allowedTouchFiles.has(file)).length;
  const forbiddenFileTouches = forbiddenEditFiles.length === 0
    ? 0
    : [...touched].filter((file) => forbiddenEditFiles.includes(file)).length;
  const forbiddenFileWrites = forbiddenEditFiles.length === 0
    ? 0
    : [...edited].filter((file) => forbiddenEditFiles.includes(file)).length;
  const verifierPassed = args.verifier.exit_code === 0 && !args.verifier.timed_out;
  const runCommandEvents = args.events.filter((event) => event.tool_name === "run_command");
  const commandWriteFiles = uniqueStringValues(
    runCommandEvents.flatMap((event) => event.write_files),
    64,
  );
  const firstWriteEvent = args.events.find((event) => event.status === "success" && event.write_files.length > 0);
  const firstTargetWriteEvent = args.events.find((event) => event.status === "success" && targetFileWritten(event, targetFiles));
  const sequenceMetrics = firstActionSequenceMetrics(args.events, args.aionisGuidance);
  const policyBlockCount = sequencePolicyBlockCount(args.events);
  const actionSynthesisPlan = asObject(args.aionisGuidance?.action_synthesis_plan_v1);
  const actionSynthesisPlanEvents = args.events.filter((event) => {
    const output = asObject(event.output_signature);
    return !!(
      asObject(output?.action_synthesis_plan_v1)
      || asObject(asObject(output?.sequence_policy_next_action)?.action_synthesis_plan_v1)
      || asObject(asObject(output?.verifier_failure_lock_next_action)?.action_synthesis_plan_v1)
      || asObject(asObject(output?.edit_operation_next_action)?.action_synthesis_plan_v1)
      || asObject(asObject(output?.runtime_next_action)?.action_synthesis_plan_v1)
    );
  });
  const actionSynthesisPlanPresent = !!actionSynthesisPlan || actionSynthesisPlanEvents.length > 0;
  const cognitiveEntropyEngine = asObject(args.aionisGuidance?.cognitive_entropy_engine_v1);
  const cognitiveEntropyProbe = asObject(cognitiveEntropyEngine?.counterfactual_probe_v1);
  const cognitiveEntropyProbeEvents = args.events.filter((event) => (
    asString(asObject(event.output_signature)?.runtime_control) === "cognitive_entropy_counterfactual_probe"
  ));
  const cognitiveEntropyProbeFiles = uniqueStringValues(
    cognitiveEntropyProbeEvents.flatMap((event) => event.touched_files),
    64,
  );
  const candidateExecutionOperator = asObject(args.aionisGuidance?.candidate_execution_operator_v1);
  const candidateExecutionTargetFiles = stringList(candidateExecutionOperator?.target_files);
  const successReplayGuidance = successReplayPatchPlanFromGuidance(args.aionisGuidance);
  const successReplayCandidatePlanCount = successReplayPatchPlanCandidatesFromGuidance(args.aionisGuidance).length;
  const successReplayEvents = args.events.filter((event) => (
    asString(asObject(event.output_signature)?.runtime_control) === "direct_success_replay"
  ));
  const successReplayAttempted = successReplayEvents.length > 0;
  const successReplayApplied = successReplayAttempted
    ? successReplayEvents.some((event) => event.status === "success")
    : null;
  const successReplayCandidateCount = Math.max(
    successReplayCandidatePlanCount,
    ...successReplayEvents.map((event) => numeric(asObject(event.output_signature)?.replay_candidate_count)),
  );
  const successReplayFailedEvents = successReplayEvents.filter((event) => event.status !== "success");
  const successReplayFailureKinds = successReplayFailedEvents.map((event) => (
    asString(asObject(event.output_signature)?.replay_failure_kind)
      ?? runtimeSuccessReplayFailureKind(event)
      ?? "apply_patch_failed"
  ));
  const successReplayFiles = uniqueStringValues([
    successReplayGuidance?.files,
    successReplayEvents.flatMap((event) => stringList(asObject(event.output_signature)?.replay_files)),
    successReplayEvents.flatMap((event) => event.write_files),
  ], 64);
  const lastReplayEventIndex = successReplayEvents.length > 0
    ? args.events.reduce((latest, event, index) => (
        asString(asObject(event.output_signature)?.runtime_control) === "direct_success_replay"
          ? index
          : latest
      ), -1)
    : -1;
  const postFailedReplayWriteFiles = uniqueStringValues(
    successReplayAttempted && successReplayApplied === false && lastReplayEventIndex >= 0
      ? args.events.slice(lastReplayEventIndex + 1).flatMap((event) => event.write_files)
      : [],
    64,
  );
  const successReplayAdaptedAfterFailure = postFailedReplayWriteFiles.length > 0;
  const successReplayAdaptationWithinBoundary = successReplayAdaptedAfterFailure
    ? postFailedReplayWriteFiles.every((file) => successReplayFiles.includes(file))
    : null;
  const successReplayAdaptationSucceeded = successReplayAdaptedAfterFailure
    && successReplayAdaptationWithinBoundary === true
    && verifierPassed;
  const sequenceCleanFollow = sequenceMetrics.present
    ? sequenceMetrics.followed === true && policyBlockCount === 0
    : null;
  const sequenceRecovered = sequenceMetrics.present
    ? policyBlockCount > 0 && verifierPassed && sequenceMetrics.firstRepairFileWriteStep !== null
    : null;
  const agentToolEvents = args.events.filter((event) => event.tool_name !== "llm_call" && event.tool_name !== "llm_protocol");
  const runtimeLearningQuarantineReason = !verifierPassed && args.llmProtocolFatalError
    ? "tool_protocol_failure_before_completed_run"
    : !verifierPassed && edited.size === 0 && agentToolEvents.length === 0
      ? args.llmApiErrorCount > 0
        ? "provider_failure_before_tool_action"
        : args.llmProtocolErrorCount > 0
          ? "tool_protocol_failure_before_tool_action"
          : null
      : null;
  const failureCategories = uniqueStringValues([
    args.llmApiErrorCount > 0 ? "llm_api_error" : null,
    args.llmProtocolErrorCount > 0 ? "llm_protocol_error" : null,
    args.llmProtocolFatalError ? "llm_protocol_fatal" : null,
    args.llmProtocolFatalError ? "tool_protocol_failure" : null,
    ...args.events.flatMap(failureCategoriesFromEvent),
    ...(verifierPassed ? [] : failureCategoriesFromCommandText(args.verifier.stderr, args.verifier.stdout)),
    verifierPassed ? null : "final_verifier_failure",
    forbiddenFileWrites > 0 ? "forbidden_file_write" : null,
    wrongFileTouches > 0 ? "wrong_file_touch" : null,
  ].filter((value): value is string => !!value), 64);
  return {
    verifier_passed: verifierPassed,
    first_action_correct: firstActionCorrect,
    repeated_discovery_steps: repeatedDiscoverySteps,
    wrong_file_touches: wrongFileTouches,
    tool_step_count: args.events.length,
    retry_count: args.events.filter((event) => event.status === "failed").length,
    llm_api_error_count: args.llmApiErrorCount,
    llm_protocol_error_count: args.llmProtocolErrorCount,
    llm_protocol_repair_count: args.llmProtocolRepairCount,
    policy_block_recovery_mode_count: args.policyBlockRecoveryModeCount,
    policy_block_recovery_protocol_error_count: args.policyBlockRecoveryProtocolErrorCount,
    action_synthesis_plan_present: actionSynthesisPlanPresent,
    repair_action_compiler_present: args.repairActionCompilerPresent === true,
    verifier_command_run_count: runCommandEvents.filter((event) => {
      const command = asString(event.tool_input.command) ?? "";
      return command.includes("github-real-project-contracts.mjs") || command.includes("npm test") || command.includes("npm run test");
    }).length + 1,
    command_write_count: runCommandEvents.filter((event) => event.write_files.length > 0).length,
    command_write_files: commandWriteFiles,
    failure_categories: failureCategories,
    first_write_step: firstWriteEvent?.step_index ?? null,
    first_target_write_step: firstTargetWriteEvent?.step_index ?? null,
    first_write_latency_ms: eventLatencyMs(firstWriteEvent, args.startedMs),
    first_target_write_latency_ms: eventLatencyMs(firstTargetWriteEvent, args.startedMs),
    first_action_sequence_present: sequenceMetrics.present,
    first_action_sequence_followed: sequenceMetrics.followed,
    first_action_sequence_violation: sequenceMetrics.violation,
    first_action_sequence_clean_follow: sequenceCleanFollow,
    first_action_sequence_policy_block_count: policyBlockCount,
    first_action_sequence_recovered: sequenceRecovered,
    first_repair_file_write_step: sequenceMetrics.firstRepairFileWriteStep,
    pre_repair_write_broad_read_count: sequenceMetrics.preRepairWriteBroadReadCount,
    repair_second_write_present: sequenceMetrics.repairSecondWritePresent,
    second_repair_file_write_step: sequenceMetrics.secondRepairFileWriteStep,
    post_first_repair_pre_second_broad_action_count: sequenceMetrics.postFirstRepairPreSecondBroadActionCount,
    cognitive_entropy_engine_present: !!cognitiveEntropyEngine,
    cognitive_entropy_counterfactual_probe_required: cognitiveEntropyProbe?.required === true,
    cognitive_entropy_counterfactual_probe_attempted: cognitiveEntropyProbeEvents.length > 0,
    cognitive_entropy_counterfactual_probe_files: cognitiveEntropyProbeFiles,
    candidate_execution_operator_present: !!candidateExecutionOperator,
    candidate_execution_operator_candidate_count: numeric(candidateExecutionOperator?.candidate_count),
    candidate_execution_operator_target_files: candidateExecutionTargetFiles,
    runtime_success_replay_present: !!successReplayGuidance,
    runtime_success_replay_attempted: successReplayAttempted,
    runtime_success_replay_applied: successReplayApplied,
    runtime_success_replay_patch_count: successReplayGuidance?.patchCount ?? 0,
    runtime_success_replay_candidate_count: successReplayCandidateCount,
    runtime_success_replay_attempted_candidate_count: successReplayEvents.length,
    runtime_success_replay_failed_candidate_count: successReplayFailedEvents.length,
    runtime_success_replay_stale_candidate_count: successReplayFailureKinds.filter((kind) => kind === "stale_patch").length,
    runtime_success_replay_invalid_candidate_count: successReplayFailureKinds.filter((kind) => kind === "invalid_patch").length,
    runtime_success_replay_adapted_after_failure: successReplayAdaptedAfterFailure,
    runtime_success_replay_adaptation_within_boundary: successReplayAdaptationWithinBoundary,
    runtime_success_replay_adaptation_succeeded: successReplayAdaptationSucceeded,
    runtime_success_replay_files: successReplayFiles,
    forbidden_file_touches: forbiddenFileTouches,
    forbidden_file_writes: forbiddenFileWrites,
    runtime_learning_quarantine_reason: runtimeLearningQuarantineReason,
    input_tokens: args.tokenUsage.input,
    output_tokens: args.tokenUsage.output,
    touched_files: [...touched].sort(),
    edited_files: [...edited].sort(),
    time_to_finish_ms: Math.max(0, (args.endedMs ?? Date.now()) - args.startedMs),
  };
}

async function applyRuntimeSuccessReplay(args: {
  task: EvalTask;
  arm: AgentArm;
  attempt?: number;
  runId: string;
  workspaceDir: string;
  guidance: JsonObject | null;
  writePolicy: RuntimeWritePolicy | null;
  progress?: EvalProgressLogger;
  stepIndex: number;
}): Promise<ToolEvent[]> {
  if (args.arm !== "aionis") return [];
  const plans = successReplayPatchPlanCandidatesFromGuidance(args.guidance);
  if (plans.length === 0) return [];
  const events: ToolEvent[] = [];
  args.progress?.emit("runtime_success_replay_start", {
    task_id: args.task.id,
    arm: args.arm,
    ...(args.attempt ? { attempt: args.attempt } : {}),
    run_id: args.runId,
    step: 0,
    candidate_count: plans.length,
    patch_count: plans[0]?.patchCount ?? 0,
    replay_files: plans[0]?.files ?? [],
    source_arm: plans[0]?.sourceArm ?? null,
    source_attempt: plans[0]?.sourceAttempt ?? null,
    detail: "direct_success_replay",
  });
  for (const [candidateIndex, plan] of plans.entries()) {
    const event = await executeTool({
      action: "apply_patch",
      input: { patch: plan.patch },
      workspaceDir: args.workspaceDir,
      stepIndex: args.stepIndex + events.length,
      writePolicy: args.writePolicy,
      sequencePolicy: null,
      priorEvents: [],
    });
    const failureKind = runtimeSuccessReplayFailureKind(event);
    event.output_signature = {
      ...event.output_signature,
      runtime_control: "direct_success_replay",
      replay_mode: "apply_positive_patch_before_new_implementation",
      replay_candidate_index: candidateIndex + 1,
      replay_candidate_count: plans.length,
      source_arm: plan.sourceArm,
      source_attempt: plan.sourceAttempt,
      patch_count: plan.patchCount,
      replay_files: plan.files,
      ...(failureKind ? { replay_failure_kind: failureKind } : {}),
    };
    events.push(event);
    args.progress?.emit("runtime_success_replay_candidate_end", {
      task_id: args.task.id,
      arm: args.arm,
      ...(args.attempt ? { attempt: args.attempt } : {}),
      run_id: args.runId,
      step: 0,
      status: event.status,
      candidate_index: candidateIndex + 1,
      candidate_count: plans.length,
      patch_count: plan.patchCount,
      replay_files: plan.files,
      source_arm: plan.sourceArm,
      source_attempt: plan.sourceAttempt,
      write_files: event.write_files,
      error: asString(asObject(event.output_signature)?.error),
      stderr: asString(asObject(asObject(event.output_signature)?.result)?.stderr),
      replay_failure_kind: asString(asObject(event.output_signature)?.replay_failure_kind),
      detail: "direct_success_replay",
    });
    if (event.status === "success") break;
  }
  const applied = events.some((event) => event.status === "success");
  const lastEvent = events[events.length - 1];
  args.progress?.emit("runtime_success_replay_end", {
    task_id: args.task.id,
    arm: args.arm,
    ...(args.attempt ? { attempt: args.attempt } : {}),
    run_id: args.runId,
    step: 0,
    status: applied ? "success" : "failed",
    candidate_count: plans.length,
    attempted_candidate_count: events.length,
    patch_count: Number(asObject(lastEvent?.output_signature)?.patch_count ?? 0),
    replay_files: stringList(asObject(lastEvent?.output_signature)?.replay_files),
    source_arm: asString(asObject(lastEvent?.output_signature)?.source_arm),
    source_attempt: asObject(lastEvent?.output_signature)?.source_attempt ?? null,
    write_files: lastEvent?.write_files ?? [],
    error: asString(asObject(lastEvent?.output_signature)?.error),
    stderr: asString(asObject(asObject(lastEvent?.output_signature)?.result)?.stderr),
    replay_failure_kind: asString(asObject(lastEvent?.output_signature)?.replay_failure_kind),
    detail: "direct_success_replay",
  });
  return events;
}

type RuntimePolicyStopOutcome = {
  event: ToolEvent;
  finish: {
    status: AgentRun["status"];
    summary: string;
    targetFiles: string[];
  };
  progressEvent: string;
  progressFields: JsonObject;
};

function runtimePolicyStopOutcomeForLatestEvent(args: {
  task: EvalTask;
  arm: AgentArm;
  attempt?: number;
  runId: string;
  step: number;
  events: ToolEvent[];
  sequencePolicy: RuntimeSequencePolicy | null;
}): RuntimePolicyStopOutcome | null {
  if (args.arm !== "aionis") return null;
  const candidateTrialStagnationStop = candidateTrialStagnationStopSignal(args.sequencePolicy, args.events);
  if (candidateTrialStagnationStop) {
    const now = Date.now();
    return {
      event: {
        step_index: args.events.length + 1,
        tool_name: "runtime_policy",
        tool_input: {
          control: "candidate_trial_stagnation_stop_v1",
          failed_verifier_step: candidateTrialStagnationStop.latest_failed_verifier_step,
        },
        status: "failed",
        output_signature: {
          failure_phase: "candidate_trial_stagnation",
          required_next_action:
            "Stop this attempt and preserve counter-evidence for the active semantic candidate; do not continue the same candidate attractor.",
          candidate_trial_stagnation_stop_v1: candidateTrialStagnationStop,
        },
        touched_files: [],
        write_files: [],
        started_at_ms: now,
        ended_at_ms: now,
      },
      finish: {
        status: "failed",
        summary: asString(candidateTrialStagnationStop.instruction)
          ?? "Runtime stopped this attempt after candidate trial stagnation.",
        targetFiles: stringList(candidateTrialStagnationStop.target_files),
      },
      progressEvent: "candidate_trial_stagnation_budget_exhausted",
      progressFields: {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: args.runId,
        step: args.step,
        active_candidate_role: asString(candidateTrialStagnationStop.active_candidate_role) ?? null,
        failed_verifier_count_since_last_success: numeric(candidateTrialStagnationStop.failed_verifier_count_since_last_success),
        successful_candidate_write_count: numeric(candidateTrialStagnationStop.successful_candidate_write_count),
        target_files: stringList(candidateTrialStagnationStop.target_files),
        status: "failed",
      },
    };
  }
  const stagnationStop = verifierStagnationStopSignal(args.events);
  if (stagnationStop) {
    const now = Date.now();
    return {
      event: {
        step_index: args.events.length + 1,
        tool_name: "runtime_policy",
        tool_input: {
          control: "verifier_stagnation_stop_v1",
          failed_verifier_step: stagnationStop.failed_verifier_step,
        },
        status: "failed",
        output_signature: {
          failure_phase: "verifier_stagnation",
          required_next_action:
            "Stop this attempt and preserve evidence for learning-control candidate review; do not continue low-evidence local edit toggles.",
          verifier_stagnation_stop_v1: stagnationStop,
        },
        touched_files: [],
        write_files: [],
        started_at_ms: now,
        ended_at_ms: now,
      },
      finish: {
        status: "failed",
        summary: asString(stagnationStop.instruction)
          ?? "Runtime stopped this attempt after repeated same-file verifier stagnation.",
        targetFiles: stringList(stagnationStop.target_files),
      },
      progressEvent: "verifier_stagnation_budget_exhausted",
      progressFields: {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: args.runId,
        step: args.step,
        failed_verifier_step: numeric(stagnationStop.failed_verifier_step),
        same_file_failure_count: numeric(stagnationStop.same_file_failure_count),
        successful_writes_after_first_same_file_failure: numeric(stagnationStop.successful_writes_after_first_same_file_failure),
        target_files: stringList(stagnationStop.target_files),
        status: "failed",
      },
    };
  }
  const payloadExhaustionStop = toolPayloadExhaustionStopSignal(args.events);
  if (payloadExhaustionStop) {
    const now = Date.now();
    return {
      event: {
        step_index: args.events.length + 1,
        tool_name: "runtime_policy",
        tool_input: {
          control: "tool_payload_exhaustion_stop_v1",
          failed_tool_step: payloadExhaustionStop.failed_tool_step,
        },
        status: "failed",
        output_signature: {
          failure_phase: "tool_payload_exhaustion",
          required_next_action:
            "Stop this attempt and preserve failed payload evidence for learning-control candidate review; do not continue cycling write-tool payload variants.",
          tool_payload_exhaustion_stop_v1: payloadExhaustionStop,
        },
        touched_files: [],
        write_files: [],
        started_at_ms: now,
        ended_at_ms: now,
      },
      finish: {
        status: "failed",
        summary: asString(payloadExhaustionStop.instruction)
          ?? "Runtime stopped this attempt after locked repair payload exhaustion.",
        targetFiles: stringList(payloadExhaustionStop.target_files),
      },
      progressEvent: "tool_payload_exhaustion_budget_exhausted",
      progressFields: {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: args.runId,
        step: args.step,
        failed_tool_step: numeric(payloadExhaustionStop.failed_tool_step),
        failed_tool_action: asString(payloadExhaustionStop.failed_tool_action) ?? null,
        same_file_failure_count: numeric(payloadExhaustionStop.same_file_failure_count),
        locked_edit_failure_count_after_latest_verifier: numeric(payloadExhaustionStop.locked_edit_failure_count_after_latest_verifier),
        failed_write_actions_after_latest_verifier: stringList(payloadExhaustionStop.failed_write_actions_after_latest_verifier),
        target_files: stringList(payloadExhaustionStop.target_files),
        status: "failed",
      },
    };
  }
  return null;
}

async function runAgent(args: {
  provider: RealLlmProviderConfig;
  task: EvalTask;
  arm: AgentArm;
  workspaceDir: string;
  aionisContext: JsonObject | null;
  progress?: EvalProgressLogger;
  attempt?: number;
}): Promise<AgentRun> {
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const startedMs = Date.now();
  const aionisGuidance = buildAionisRuntimeGuidance(args.aionisContext, args.workspaceDir, args.task);
  const patchEvidenceFiles = uniqueStringValues([
    args.task.expected?.allowed_edit_files,
    args.task.expected?.target_files,
  ], 20);
  const initialPatchEvidence = await readWorkspaceFileContents(args.workspaceDir, patchEvidenceFiles);
  args.progress?.emit("agent_start", {
    task_id: args.task.id,
    arm: args.arm,
    ...(args.attempt ? { attempt: args.attempt } : {}),
    run_id: runId,
    workspace_dir: args.workspaceDir,
    max_steps: args.task.max_steps ?? 12,
    has_aionis_guidance: !!aionisGuidance,
  });
  const messages: LlmMessage[] = [
    { role: "user", content: taskMessage(args.task, args.workspaceDir, args.aionisContext, aionisGuidance) },
  ];
  const maxSteps = args.task.max_steps ?? 12;
  const events: ToolEvent[] = [];
  const tokenUsage = { input: 0, output: 0 };
  let finish: ReturnType<typeof finishFromAction> = null;
  let llmApiErrorCount = 0;
  let llmFatalError: string | null = null;
  let consecutiveProtocolExhaustedSteps = 0;
  let protocolFatalError: string | null = null;
  let llmProtocolErrorCount = 0;
  let llmProtocolRepairCount = 0;
  let policyBlockRecoveryModeCount = 0;
  let policyBlockRecoveryProtocolErrorCount = 0;
  let repairActionCompilerPresent = false;
  const writePolicy = args.arm === "aionis" ? writePolicyFromGuidance(aionisGuidance) : null;
  const sequencePolicy = args.arm === "aionis" ? sequencePolicyFromGuidance(aionisGuidance) : null;
  const successReplayEvents = await applyRuntimeSuccessReplay({
    task: args.task,
    arm: args.arm,
    ...(args.attempt ? { attempt: args.attempt } : {}),
    runId,
    workspaceDir: args.workspaceDir,
    guidance: aionisGuidance,
    writePolicy,
    progress: args.progress,
    stepIndex: events.length + 1,
  });
  if (successReplayEvents.length > 0) {
    events.push(...successReplayEvents);
    const replayApplied = successReplayEvents.some((event) => event.status === "success");
    messages.push({
      role: "user",
      content: JSON.stringify({
        runtime_control_result: {
          control: "direct_success_replay",
          required_next_action: replayApplied
            ? "Run the required verifier exactly before making any further edits."
            : "Every prior success patch candidate was stale or could not be applied; inspect only the conflicting replay files and adapt the failed hunks.",
          tool_results: successReplayEvents.map(compactToolEventForLlm),
        },
      }, null, 2),
    });
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    let action: JsonObject | null = null;
    let protocolErrorsThisStep = 0;
    let lastProtocolInvalidResponseExcerpt: string | null = null;
    let lastProtocolInvalidDetail: string | null = null;
    let policyBlockRecoveryCountedThisStep = false;
    for (let protocolAttempt = 0; protocolAttempt <= args.provider.protocolRetries; protocolAttempt += 1) {
      const policyBlockRecoveryMessage = args.arm === "aionis"
          ? buildPolicyBlockRecoveryMessage({
              events,
              protocolErrorsThisStep,
              lastInvalidResponseExcerpt: lastProtocolInvalidResponseExcerpt,
              lastInvalidDetail: lastProtocolInvalidDetail,
              sequencePolicy,
              task: args.task,
              workspaceDir: args.workspaceDir,
            })
        : null;
      const policyBlockRecoveryActive = !!policyBlockRecoveryMessage;
      if (policyBlockRecoveryMessage?.includes("\"repair_action_compiler_v1\"")) {
        repairActionCompilerPresent = true;
      }
      const recoveryMaxTokens = policyBlockRecoveryActive
        ? policyBlockRecoveryMaxTokens({
            events,
            sequencePolicy,
            workspaceDir: args.workspaceDir,
            protocolErrorsThisStep,
            lastInvalidResponseExcerpt: lastProtocolInvalidResponseExcerpt,
          })
        : undefined;
      if (policyBlockRecoveryActive && !policyBlockRecoveryCountedThisStep) {
        policyBlockRecoveryModeCount += 1;
        policyBlockRecoveryCountedThisStep = true;
        const blockEvent = latestPolicyBlockEvent(events);
        const nextAction = policyBlockRecoveryNextAction({
          events,
          sequencePolicy,
          workspaceDir: args.workspaceDir,
        });
        args.progress?.emit("policy_block_recovery_mode_start", {
          task_id: args.task.id,
          arm: args.arm,
          ...(args.attempt ? { attempt: args.attempt } : {}),
          run_id: runId,
          step,
          blocked_step: blockEvent?.step_index ?? null,
          blocked_tool: blockEvent?.tool_name ?? null,
          recovery_reason: asString(nextAction?.reason) ?? null,
          forced_action_family: policyBlockRecoveryActionFamily(nextAction),
          allowed_actions: policyBlockRecoveryAllowedActions(nextAction, {
            protocolErrorsThisStep,
            lastInvalidResponseExcerpt: lastProtocolInvalidResponseExcerpt,
          }),
          allowed_files: policyBlockRecoveryFiles(nextAction),
          max_tokens: recoveryMaxTokens ?? null,
        });
      }
      args.progress?.emit("llm_step_start", {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: runId,
        step,
        protocol_attempt: protocolAttempt + 1,
        protocol_retry: protocolAttempt > 0,
      });
      const llmStartedMs = Date.now();
      let response: LlmResponse;
      try {
        response = await callRealLlm({
          provider: args.provider,
          system: buildSystemPromptForLlm(args.arm, policyBlockRecoveryActive),
          messages: policyBlockRecoveryActive
            ? [{ role: "user", content: policyBlockRecoveryMessage }]
            : messages,
          maxTokens: recoveryMaxTokens,
          onRetry: (event) => {
            args.progress?.emit("llm_step_retry", {
              task_id: args.task.id,
              arm: args.arm,
              ...(args.attempt ? { attempt: args.attempt } : {}),
              run_id: runId,
              step,
              protocol_attempt: protocolAttempt + 1,
              provider_attempt: event.providerAttempt,
              provider_max_attempts: event.providerMaxAttempts,
              retry_delay_ms: event.retryDelayMs,
              elapsed_ms: event.elapsedMs,
              remaining_step_timeout_ms: event.remainingStepTimeoutMs,
              status: "retrying",
              detail: truncate(event.detail, 500),
            });
          },
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        llmApiErrorCount += 1;
        llmFatalError = detail;
        const event: ToolEvent = {
          step_index: events.length + 1,
          tool_name: "llm_call",
          tool_input: {
            provider: args.provider.provider,
            model: args.provider.model,
            step,
            protocol_attempt: protocolAttempt + 1,
          },
          status: "failed",
          output_signature: {
            llm_api_error: detail,
            retries_exhausted: true,
          },
          touched_files: [],
          write_files: [],
          started_at_ms: llmStartedMs,
          ended_at_ms: Date.now(),
        };
        events.push(event);
        args.progress?.emit("llm_step_api_error", {
          task_id: args.task.id,
          arm: args.arm,
          ...(args.attempt ? { attempt: args.attempt } : {}),
          run_id: runId,
          step,
          protocol_attempt: protocolAttempt + 1,
          status: "failed",
          detail,
        });
        break;
      }
      args.progress?.emit("llm_step_response", {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: runId,
        step,
        protocol_attempt: protocolAttempt + 1,
        status: "success",
        duration_ms: Date.now() - llmStartedMs,
        input_tokens: response.inputTokens,
        output_tokens: response.outputTokens,
        detail: `duration_ms=${Date.now() - llmStartedMs}`,
      });
      tokenUsage.input += response.inputTokens ?? 0;
      tokenUsage.output += response.outputTokens ?? 0;
      const assistantActionMessage: LlmMessage = { role: "assistant", content: response.text };
      try {
        action = extractJsonObjectFromText(response.text);
        validateAgentProtocolAction(action);
        messages.push(assistantActionMessage);
        if (protocolErrorsThisStep > 0) {
          llmProtocolRepairCount += protocolErrorsThisStep;
          args.progress?.emit("llm_step_protocol_repaired", {
            task_id: args.task.id,
            arm: args.arm,
            ...(args.attempt ? { attempt: args.attempt } : {}),
            run_id: runId,
            step,
            repaired_error_count: protocolErrorsThisStep,
          });
        }
        break;
      } catch (err) {
        llmProtocolErrorCount += 1;
        protocolErrorsThisStep += 1;
        if (policyBlockRecoveryActive) policyBlockRecoveryProtocolErrorCount += 1;
        const exhausted = protocolAttempt >= args.provider.protocolRetries;
        const runtimeNextAction = latestRuntimeNextAction(events);
        lastProtocolInvalidDetail = err instanceof Error ? err.message : String(err);
        lastProtocolInvalidResponseExcerpt = response.text;
        args.progress?.emit("llm_step_invalid_json", {
          task_id: args.task.id,
          arm: args.arm,
          ...(args.attempt ? { attempt: args.attempt } : {}),
          run_id: runId,
          step,
          protocol_attempt: protocolAttempt + 1,
          protocol_retries_remaining: Math.max(0, args.provider.protocolRetries - protocolAttempt),
          status: "failed",
          detail: lastProtocolInvalidDetail,
          invalid_response_excerpt: truncate(response.text.replace(/\s+/g, " "), 400),
          likely_truncated_json: likelyIncompleteJsonResponse(response.text),
        });
        messages.push({
          role: "user",
          content: JSON.stringify({
            tool_result: {
              status: "failed",
              error: lastProtocolInvalidDetail,
              invalid_assistant_response_discarded: true,
              invalid_response_excerpt: truncate(response.text.replace(/\s+/g, " "), 400),
              likely_truncated_json: likelyIncompleteJsonResponse(response.text),
              protocol_retry_allowed: !exhausted,
              required_format: "Return one raw JSON object only. First character must be { and last character must be }. No markdown, no prose, no labels.",
              ...(runtimeNextAction ? { repeat_runtime_next_action: runtimeNextAction } : {}),
              strict_response_contract: {
                first_character: "{",
                last_character: "}",
                no_markdown: true,
                no_prose: true,
                no_fenced_code: true,
                no_prefixed_labels: true,
                allowed_top_level_keys: ["action", "input"],
                allowed_actions: ALLOWED_AGENT_ACTIONS,
                input_must_be_object: true,
              },
            },
          }),
        });
      }
    }
    if (llmFatalError) break;
    if (!action) {
      consecutiveProtocolExhaustedSteps += 1;
      const event: ToolEvent = {
        step_index: events.length + 1,
        tool_name: "llm_protocol",
        tool_input: {
          step,
          protocol_attempts: args.provider.protocolRetries + 1,
        },
        status: "failed",
        output_signature: {
          llm_protocol_exhausted: "LLM did not return a valid tool JSON object after configured protocol retries.",
          failure_phase: "tool_protocol_failure",
          required_next_action:
            "Stop this arm and retry with a provider/model that obeys the JSON tool contract; do not edit repository code from protocol failure evidence.",
          learning_control: {
            quarantine_run: true,
            reason: "tool_protocol_failure_before_completed_run",
          },
          protocol_errors_this_step: protocolErrorsThisStep,
          consecutive_protocol_exhausted_steps: consecutiveProtocolExhaustedSteps,
        },
        touched_files: [],
        write_files: [],
        started_at_ms: Date.now(),
        ended_at_ms: Date.now(),
      };
      events.push(event);
      args.progress?.emit("llm_step_protocol_exhausted", {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: runId,
        step,
        status: "failed",
        protocol_errors_this_step: protocolErrorsThisStep,
        consecutive_protocol_exhausted_steps: consecutiveProtocolExhaustedSteps,
        max_protocol_exhausted_steps: args.provider.maxProtocolExhaustedSteps,
      });
      if (consecutiveProtocolExhaustedSteps >= args.provider.maxProtocolExhaustedSteps) {
        protocolFatalError = `LLM protocol exhausted for ${consecutiveProtocolExhaustedSteps} consecutive steps without a valid action.`;
        break;
      }
      continue;
    }
    consecutiveProtocolExhaustedSteps = 0;
    finish = finishFromAction(action);
    if (finish) {
      args.progress?.emit("agent_finish_requested", {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: runId,
        step,
        status: finish.status,
        target_files: finish.targetFiles,
      });
      break;
    }
    const toolInput = asObject(action.input) ?? {};
    const toolName = asString(action.action) ?? "unknown";
    args.progress?.emit("tool_start", {
      task_id: args.task.id,
      arm: args.arm,
      ...(args.attempt ? { attempt: args.attempt } : {}),
      run_id: runId,
      step,
      tool_name: toolName,
      command: toolName === "run_command" ? asString(toolInput.command) ?? undefined : undefined,
    });
    const event = await executeTool({
      action: toolName,
      input: toolInput,
      workspaceDir: args.workspaceDir,
      stepIndex: events.length + 1,
      writePolicy,
      sequencePolicy,
      priorEvents: events,
    });
    events.push(event);
    args.progress?.emit("tool_end", {
      task_id: args.task.id,
      arm: args.arm,
      ...(args.attempt ? { attempt: args.attempt } : {}),
      run_id: runId,
      step,
      tool_name: event.tool_name,
      status: event.status,
      touched_files: event.touched_files,
      write_files: event.write_files,
      command: event.tool_name === "run_command" ? asString(event.tool_input.command) ?? undefined : undefined,
    });
    const candidateTrialStagnationStop = args.arm === "aionis"
      ? candidateTrialStagnationStopSignal(sequencePolicy, events)
      : null;
    if (candidateTrialStagnationStop) {
      const now = Date.now();
      const stopEvent: ToolEvent = {
        step_index: events.length + 1,
        tool_name: "runtime_policy",
        tool_input: {
          control: "candidate_trial_stagnation_stop_v1",
          failed_verifier_step: candidateTrialStagnationStop.latest_failed_verifier_step,
        },
        status: "failed",
        output_signature: {
          failure_phase: "candidate_trial_stagnation",
          required_next_action:
            "Stop this attempt and preserve counter-evidence for the active semantic candidate; do not continue the same candidate attractor.",
          candidate_trial_stagnation_stop_v1: candidateTrialStagnationStop,
        },
        touched_files: [],
        write_files: [],
        started_at_ms: now,
        ended_at_ms: now,
      };
      events.push(stopEvent);
      finish = {
        status: "failed",
        summary: asString(candidateTrialStagnationStop.instruction)
          ?? "Runtime stopped this attempt after candidate trial stagnation.",
        targetFiles: stringList(candidateTrialStagnationStop.target_files),
      };
      args.progress?.emit("candidate_trial_stagnation_budget_exhausted", {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: runId,
        step,
        active_candidate_role: asString(candidateTrialStagnationStop.active_candidate_role) ?? null,
        failed_verifier_count_since_last_success: numeric(candidateTrialStagnationStop.failed_verifier_count_since_last_success),
        successful_candidate_write_count: numeric(candidateTrialStagnationStop.successful_candidate_write_count),
        target_files: stringList(candidateTrialStagnationStop.target_files),
        status: "failed",
      });
      break;
    }
    const stagnationStop = args.arm === "aionis"
      ? verifierStagnationStopSignal(events)
      : null;
    if (stagnationStop) {
      const now = Date.now();
      const stopEvent: ToolEvent = {
        step_index: events.length + 1,
        tool_name: "runtime_policy",
        tool_input: {
          control: "verifier_stagnation_stop_v1",
          failed_verifier_step: stagnationStop.failed_verifier_step,
        },
        status: "failed",
        output_signature: {
          failure_phase: "verifier_stagnation",
          required_next_action:
            "Stop this attempt and preserve evidence for learning-control candidate review; do not continue low-evidence local edit toggles.",
          verifier_stagnation_stop_v1: stagnationStop,
        },
        touched_files: [],
        write_files: [],
        started_at_ms: now,
        ended_at_ms: now,
      };
      events.push(stopEvent);
      finish = {
        status: "failed",
        summary: asString(stagnationStop.instruction)
          ?? "Runtime stopped this attempt after repeated same-file verifier stagnation.",
        targetFiles: stringList(stagnationStop.target_files),
      };
      args.progress?.emit("verifier_stagnation_budget_exhausted", {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: runId,
        step,
        failed_verifier_step: numeric(stagnationStop.failed_verifier_step),
        same_file_failure_count: numeric(stagnationStop.same_file_failure_count),
        successful_writes_after_first_same_file_failure: numeric(stagnationStop.successful_writes_after_first_same_file_failure),
        target_files: stringList(stagnationStop.target_files),
        status: "failed",
      });
      break;
    }
    const payloadExhaustionStop = args.arm === "aionis"
      ? toolPayloadExhaustionStopSignal(events)
      : null;
    if (payloadExhaustionStop) {
      const now = Date.now();
      const stopEvent: ToolEvent = {
        step_index: events.length + 1,
        tool_name: "runtime_policy",
        tool_input: {
          control: "tool_payload_exhaustion_stop_v1",
          failed_tool_step: payloadExhaustionStop.failed_tool_step,
        },
        status: "failed",
        output_signature: {
          failure_phase: "tool_payload_exhaustion",
          required_next_action:
            "Stop this attempt and preserve failed payload evidence for learning-control candidate review; do not continue cycling write-tool payload variants.",
          tool_payload_exhaustion_stop_v1: payloadExhaustionStop,
        },
        touched_files: [],
        write_files: [],
        started_at_ms: now,
        ended_at_ms: now,
      };
      events.push(stopEvent);
      finish = {
        status: "failed",
        summary: asString(payloadExhaustionStop.instruction)
          ?? "Runtime stopped this attempt after locked repair payload exhaustion.",
        targetFiles: stringList(payloadExhaustionStop.target_files),
      };
      args.progress?.emit("tool_payload_exhaustion_budget_exhausted", {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: runId,
        step,
        failed_tool_step: numeric(payloadExhaustionStop.failed_tool_step),
        failed_tool_action: asString(payloadExhaustionStop.failed_tool_action) ?? null,
        same_file_failure_count: numeric(payloadExhaustionStop.same_file_failure_count),
        locked_edit_failure_count_after_latest_verifier: numeric(payloadExhaustionStop.locked_edit_failure_count_after_latest_verifier),
        failed_write_actions_after_latest_verifier: stringList(payloadExhaustionStop.failed_write_actions_after_latest_verifier),
        target_files: stringList(payloadExhaustionStop.target_files),
        status: "failed",
      });
      break;
    }
    const noncomplianceBudget = args.arm === "aionis"
      ? policyBlockNoncomplianceBudget(events)
      : null;
    if (noncomplianceBudget) {
      protocolFatalError = `Runtime policy-block recovery noncompliance budget exhausted at step ${event.step_index}: action ${asString(noncomplianceBudget.failed_action) ?? "unknown"} was repeated outside allowed recovery actions.`;
      const now = Date.now();
      const policyEvent: ToolEvent = {
        step_index: events.length + 1,
        tool_name: "runtime_policy",
        tool_input: {
          control: "policy_block_noncompliance_budget_v1",
          blocked_step: event.step_index,
        },
        status: "failed",
        output_signature: {
          failure_phase: "tool_protocol_failure",
          required_next_action:
            "Stop this attempt and retry with the same generic Runtime recovery policy; do not promote task-specific repository content from this run.",
          policy_block_noncompliance_budget_v1: noncomplianceBudget,
          learning_control: {
            quarantine_run: true,
            reason: "tool_protocol_failure_before_completed_run",
          },
        },
        touched_files: [],
        write_files: [],
        started_at_ms: now,
        ended_at_ms: now,
      };
      events.push(policyEvent);
      args.progress?.emit("policy_block_noncompliance_budget_exhausted", {
        task_id: args.task.id,
        arm: args.arm,
        ...(args.attempt ? { attempt: args.attempt } : {}),
        run_id: runId,
        step,
        blocked_step: event.step_index,
        failed_action: asString(noncomplianceBudget.failed_action) ?? null,
        recovery_reason: asString(noncomplianceBudget.recovery_reason) ?? null,
        same_action_count: noncomplianceBudget.same_action_count,
        total_count: noncomplianceBudget.total_count,
        status: "failed",
      });
      break;
    }
    messages.push({
      role: "user",
      content: JSON.stringify({ tool_result: compactToolEventForLlm(event) }, null, 2),
    });
  }

  const verifierCommand = commandWithRuntimePlaceholders(args.task.verifier.command, args.workspaceDir);
  args.progress?.emit("verifier_start", {
    task_id: args.task.id,
    arm: args.arm,
    ...(args.attempt ? { attempt: args.attempt } : {}),
    run_id: runId,
    command: verifierCommand,
  });
  const verifier = await runCommand(verifierCommand, args.workspaceDir, args.task.verifier.timeout_ms ?? 120000);
  args.progress?.emit("verifier_end", {
    task_id: args.task.id,
    arm: args.arm,
    ...(args.attempt ? { attempt: args.attempt } : {}),
    run_id: runId,
    status: verifier.exit_code === 0 && !verifier.timed_out ? "success" : "failed",
    exit_code: verifier.exit_code,
    timed_out: verifier.timed_out,
    duration_ms: verifier.duration_ms,
    command: verifierCommand,
  });
  const metrics = computeMetrics({
    task: args.task,
    events,
    verifier,
    tokenUsage,
    startedMs,
    llmApiErrorCount,
    llmProtocolErrorCount,
    llmProtocolRepairCount,
    policyBlockRecoveryModeCount,
    policyBlockRecoveryProtocolErrorCount,
    repairActionCompilerPresent,
    llmProtocolFatalError: protocolFatalError,
    aionisGuidance,
  });
  const positivePatchEvidence = metrics.verifier_passed
    ? await buildPositivePatchEvidence({
        workspaceDir: args.workspaceDir,
        before: initialPatchEvidence,
        files: patchEvidenceFiles,
        verifierCommand,
      })
    : null;
  const status: AgentRun["status"] =
    metrics.verifier_passed && (finish?.status ?? "partial") !== "failed"
      ? "success"
      : finish?.status === "success"
        ? "partial"
        : finish?.status ?? "failed";
  const baseRun: AgentRun = {
    arm: args.arm,
    ...(args.attempt ? { attempt: args.attempt } : {}),
    run_id: runId,
    task_id: args.task.id,
    workspace_dir: args.workspaceDir,
    status,
    summary: finish?.summary ?? (llmFatalError
      ? `Agent stopped because the LLM API failed after configured retries: ${truncate(llmFatalError, 1000)}`
      : protocolFatalError
        ? `Agent stopped because the LLM tool protocol failed: ${protocolFatalError}`
      : metrics.verifier_passed
        ? "Verifier passed after max-step execution."
        : "Agent reached the step limit before finishing."),
    final_target_files: finish?.targetFiles ?? [],
    trace: {
      trace_version: TRACE_VERSION,
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      events,
    },
    verifier,
    metrics,
    aionis_context: args.aionisContext,
    aionis_guidance: aionisGuidance,
    semantic_candidate_producer: null,
    learning_control_candidates: [],
    positive_patch_evidence: positivePatchEvidence,
  };
  const semanticCandidateProducer = await produceLearningControlSemanticCandidates({
    provider: args.provider,
    task: args.task,
    run: baseRun,
    progress: args.progress,
  });
  const learningControlCandidates = semanticCandidateProducer?.candidates.filter((candidate) => (
    candidate.runtime_adjudication.usable_as_next_attempt_guidance
  )) ?? [];
  args.progress?.emit("agent_end", {
    task_id: args.task.id,
    arm: args.arm,
    ...(args.attempt ? { attempt: args.attempt } : {}),
    run_id: runId,
    status,
    verifier_passed: metrics.verifier_passed,
    retry_count: metrics.retry_count,
    llm_api_error_count: metrics.llm_api_error_count,
    llm_protocol_error_count: metrics.llm_protocol_error_count,
    llm_protocol_repair_count: metrics.llm_protocol_repair_count,
    policy_block_recovery_mode_count: metrics.policy_block_recovery_mode_count,
    policy_block_recovery_protocol_error_count: metrics.policy_block_recovery_protocol_error_count,
    verifier_command_run_count: metrics.verifier_command_run_count,
    command_write_count: metrics.command_write_count,
    command_write_files: metrics.command_write_files,
    semantic_candidate_producer_status: semanticCandidateProducer?.status ?? null,
    semantic_candidate_count: learningControlCandidates.length,
    failure_categories: metrics.failure_categories,
    first_write_step: metrics.first_write_step,
    first_target_write_step: metrics.first_target_write_step,
    first_write_latency_ms: metrics.first_write_latency_ms,
    first_target_write_latency_ms: metrics.first_target_write_latency_ms,
    first_action_sequence_present: metrics.first_action_sequence_present,
    first_action_sequence_followed: metrics.first_action_sequence_followed,
    first_action_sequence_violation: metrics.first_action_sequence_violation,
    first_action_sequence_clean_follow: metrics.first_action_sequence_clean_follow,
    first_action_sequence_policy_block_count: metrics.first_action_sequence_policy_block_count,
    first_action_sequence_recovered: metrics.first_action_sequence_recovered,
    first_repair_file_write_step: metrics.first_repair_file_write_step,
    pre_repair_write_broad_read_count: metrics.pre_repair_write_broad_read_count,
    repair_second_write_present: metrics.repair_second_write_present,
    second_repair_file_write_step: metrics.second_repair_file_write_step,
    post_first_repair_pre_second_broad_action_count: metrics.post_first_repair_pre_second_broad_action_count,
    cognitive_entropy_engine_present: metrics.cognitive_entropy_engine_present,
    cognitive_entropy_counterfactual_probe_required: metrics.cognitive_entropy_counterfactual_probe_required,
    cognitive_entropy_counterfactual_probe_attempted: metrics.cognitive_entropy_counterfactual_probe_attempted,
    cognitive_entropy_counterfactual_probe_files: metrics.cognitive_entropy_counterfactual_probe_files,
    candidate_execution_operator_present: metrics.candidate_execution_operator_present,
    candidate_execution_operator_candidate_count: metrics.candidate_execution_operator_candidate_count,
    candidate_execution_operator_target_files: metrics.candidate_execution_operator_target_files,
    runtime_success_replay_present: metrics.runtime_success_replay_present,
    runtime_success_replay_attempted: metrics.runtime_success_replay_attempted,
    runtime_success_replay_applied: metrics.runtime_success_replay_applied,
    runtime_success_replay_patch_count: metrics.runtime_success_replay_patch_count,
    runtime_success_replay_files: metrics.runtime_success_replay_files,
    tool_step_count: metrics.tool_step_count,
    wrong_file_touches: metrics.wrong_file_touches,
    forbidden_file_writes: metrics.forbidden_file_writes,
    edited_files: metrics.edited_files,
    duration_ms: Date.now() - startedMs,
  });

  return {
    ...baseRun,
    semantic_candidate_producer: semanticCandidateProducer,
    learning_control_candidates: learningControlCandidates,
  };
}

async function postRuntime(baseUrl: string, route: string, payload: JsonObject): Promise<JsonObject> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as JsonObject : {};
  if (!response.ok) {
    throw new Error(`Runtime ${route} failed: ${response.status} ${truncate(JSON.stringify(parsed), 2000)}`);
  }
  return parsed;
}

async function getRuntime(baseUrl: string, route: string): Promise<JsonObject> {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as JsonObject : {};
  if (!response.ok) {
    throw new Error(`Runtime ${route} failed: ${response.status} ${truncate(JSON.stringify(parsed), 2000)}`);
  }
  return parsed;
}

function runtimePayloadBase(task: EvalTask, runId: string): JsonObject {
  return {
    tenant_id: "real-llm-eval",
    scope: `real-llm-eval:${task.id}`,
    actor: "real-llm-agent",
    consumer_agent_id: "real-llm-agent",
    memory_lane: "private",
    producer_agent_id: "real-llm-agent",
    owner_agent_id: "real-llm-agent",
    run_id: runId,
  };
}

function reusableTargetFiles(task: EvalTask, run: AgentRun): string[] {
  const expected = task.expected?.target_files ?? [];
  if (expected.length > 0) {
    const edited = new Set(run.metrics.edited_files);
    const editedExpected = expected.filter((file) => edited.has(file));
    return editedExpected.length > 0 ? editedExpected : expected;
  }
  if (run.metrics.edited_files.length > 0) return run.metrics.edited_files;
  return run.metrics.touched_files;
}

function feedbackToolName(run: AgentRun): string | null {
  const decisiveWrite = run.metrics.verifier_passed
    ? run.trace.events.find((event) => event.status === "success" && event.write_files.length > 0)
    : null;
  const firstFailed = run.trace.events.find((event) => event.status === "failed");
  return decisiveWrite?.tool_name ?? firstFailed?.tool_name ?? run.trace.events[0]?.tool_name ?? null;
}

function commandTail(text: string, limit = 6000): string {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}

function failedToolCalls(run: AgentRun): JsonObject[] {
  return run.trace.events
    .filter((event) => event.status === "failed")
    .map((event) => ({
      step_index: event.step_index,
      tool_name: event.tool_name,
      tool_input: event.tool_input,
      output_signature: event.output_signature,
      touched_files: event.touched_files,
      write_files: event.write_files,
    }));
}

function verifierEvidence(run: AgentRun): JsonObject {
  return {
    schema_version: "real_llm_verifier_evidence_v1",
    kind: "verifier",
    arm: run.arm,
    ...(run.attempt ? { attempt: run.attempt } : {}),
    command: run.verifier.command,
    passed: run.metrics.verifier_passed,
    exit_code: run.verifier.exit_code,
    timed_out: run.verifier.timed_out,
    duration_ms: run.verifier.duration_ms,
    stdout_tail: commandTail(run.verifier.stdout),
    stderr_tail: commandTail(run.verifier.stderr),
    failed_tool_calls: failedToolCalls(run),
    positive_patch_evidence: run.positive_patch_evidence ?? null,
  };
}

function priorRunEvidence(run: AgentRun): JsonObject {
  return {
    schema_version: "real_llm_prior_run_evidence_v1",
    kind: "prior_real_llm_run",
    arm: run.arm,
    ...(run.attempt ? { attempt: run.attempt } : {}),
    status: run.status,
    verifier: {
      command: run.verifier.command,
      passed: run.metrics.verifier_passed,
      exit_code: run.verifier.exit_code,
      timed_out: run.verifier.timed_out,
      stdout_tail: commandTail(run.verifier.stdout),
      stderr_tail: commandTail(run.verifier.stderr),
    },
    metrics: codeRepairMetricsForRuntimeContext(run),
    failed_tool_calls: failedToolCalls(run),
    semantic_candidate_producer: run.semantic_candidate_producer ?? null,
    learning_control_candidates: run.learning_control_candidates ?? [],
    positive_patch_evidence: run.positive_patch_evidence ?? null,
  };
}

async function buildAionisContext(args: {
  baseUrl: string;
  task: EvalTask;
  runId: string;
  priorRuns?: AgentRun[];
}): Promise<JsonObject> {
  const base = runtimePayloadBase(args.task, args.runId);
  const context = {
    task_id: args.task.id,
    task_family: args.task.task_family ?? null,
    prompt: args.task.prompt,
    verifier: args.task.verifier,
  };
  const editBoundaryContext = {
    allowed_edit_files: args.task.expected?.allowed_edit_files ?? args.task.expected?.target_files ?? [],
    forbidden_edit_files: args.task.expected?.forbidden_edit_files ?? [],
    required_verifiers:
      args.task.expected?.required_verifiers
      ?? args.task.expected?.acceptance_checks
      ?? [args.task.verifier.command],
    anti_shortcut_rules: args.task.expected?.anti_shortcut_rules ?? [],
  };
  const common = {
    ...base,
    query_text: args.task.prompt,
    context,
    execution_evidence: (args.priorRuns ?? []).map(priorRunEvidence),
    execution_result_summary: {
      prior_run_count: args.priorRuns?.length ?? 0,
      failed_prior_run_count: (args.priorRuns ?? []).filter((run) => !run.metrics.verifier_passed).length,
      failed_prior_arms: (args.priorRuns ?? []).filter((run) => !run.metrics.verifier_passed).map((run) => run.arm),
    },
    edit_boundary_context: editBoundaryContext,
    tool_candidates: ["list_files", "read_file", "search", "run_command", "replace_text", "replace_lines", "apply_patch"],
    candidates: ["list_files", "read_file", "search", "run_command", "replace_text", "replace_lines", "apply_patch"],
    include_shadow: true,
    return_debug: true,
    include_slots: true,
    context_char_budget: 16000,
    context_optimization_profile: "aggressive",
  };
  const kickoff = await postRuntime(args.baseUrl, "/v1/memory/kickoff/recommendation", common);
  const planning = await postRuntime(args.baseUrl, "/v1/memory/planning/context", common);
  const assembly = await postRuntime(args.baseUrl, "/v1/memory/context/assemble", common);
  const tools = await postRuntime(args.baseUrl, "/v1/memory/tools/select", {
    ...base,
    context,
    candidates: ["list_files", "read_file", "search", "run_command", "replace_text", "replace_lines", "apply_patch"],
    include_shadow: true,
  });
  return {
    context_version: "aionis_real_llm_context_packet_v1",
    direct_prior_repair_evidence: (args.priorRuns ?? [])
      .filter((run) => !run.metrics.verifier_passed)
      .map(compactPriorRunRepairEvidence),
    direct_success_replay_evidence: (args.priorRuns ?? [])
      .filter((run) => run.metrics.verifier_passed)
      .map(compactSuccessfulRunReplayEvidence),
    kickoff,
    planning,
    assembly,
    tools,
  };
}

async function storeAionisOutcome(args: {
  baseUrl: string;
  task: EvalTask;
  run: AgentRun;
}): Promise<JsonObject> {
  const quarantineReason = runtimeLearningQuarantineReasonFromRun(args.run);
  if (quarantineReason) {
    return {
      persisted: false,
      runtime_learning_quarantined: true,
      runtime_learning_quarantine_reason: quarantineReason,
      run_id: args.run.run_id,
      arm: args.run.arm,
      verifier_passed: args.run.metrics.verifier_passed,
      llm_api_error_count: args.run.metrics.llm_api_error_count,
      llm_protocol_error_count: args.run.metrics.llm_protocol_error_count,
    };
  }
  const base = runtimePayloadBase(args.task, args.run.run_id);
  const targetFiles = reusableTargetFiles(args.task, args.run);
  const started = await postRuntime(args.baseUrl, "/v1/memory/replay/run/start", {
    ...base,
    goal: args.task.prompt,
    ...(args.run.aionis_context ? { context_snapshot_ref: `aionis-context:${args.run.run_id}` } : {}),
    metadata: {
      suite_source: "real_llm_agent_eval",
      arm: args.run.arm,
      trace_version: TRACE_VERSION,
    },
  });
  const replayRunId = asString(started.run_id) ?? args.run.run_id;
  const replaySteps: JsonObject[] = [];
  for (const event of args.run.trace.events) {
    const before = await postRuntime(args.baseUrl, "/v1/memory/replay/step/before", {
      ...base,
      run_id: replayRunId,
      step_index: event.step_index,
      tool_name: event.tool_name,
      tool_input: event.tool_input,
      safety_level: event.tool_name === "apply_patch" ? "needs_confirm" : "auto_ok",
      metadata: { arm: args.run.arm },
    });
    const stepId = asString(before.step_id);
    const after = await postRuntime(args.baseUrl, "/v1/memory/replay/step/after", {
      ...base,
      run_id: replayRunId,
      step_id: stepId ?? undefined,
      step_index: event.step_index,
      status: event.status,
      output_signature: event.output_signature,
      artifact_refs: event.touched_files.map((file) => `workspace://${args.run.run_id}/${file}`),
      metadata: { arm: args.run.arm, touched_files: event.touched_files },
    });
    replaySteps.push({ before, after });
  }
  const ended = await postRuntime(args.baseUrl, "/v1/memory/replay/run/end", {
    ...base,
    run_id: replayRunId,
    status: args.run.status,
    summary: args.run.summary,
    success_criteria: {
      verifier_command: args.task.verifier.command,
      verifier_passed: args.run.metrics.verifier_passed,
      acceptance_checks: args.task.expected?.acceptance_checks ?? [args.task.verifier.command],
    },
    metrics: args.run.metrics as unknown as JsonObject,
    metadata: { arm: args.run.arm },
  });
  const compile = args.run.metrics.verifier_passed
    ? await postRuntime(args.baseUrl, "/v1/memory/replay/playbooks/compile_from_run", {
        ...base,
        run_id: replayRunId,
        success_criteria: {
          verifier_command: args.task.verifier.command,
          verifier_passed: args.run.metrics.verifier_passed,
        },
        allow_partial: false,
        risk_profile: "medium",
        metadata: { arm: args.run.arm },
      })
    : null;
  const handoff = await postRuntime(args.baseUrl, "/v1/handoff/store", {
    tenant_id: base.tenant_id,
    scope: base.scope,
    actor: base.actor,
    handoff_kind: "task_handoff",
    task_family: args.task.task_family ?? undefined,
    anchor: `real-llm-eval:${args.task.id}:${args.run.arm}`,
    file_path: targetFiles[0],
    summary: args.run.summary,
    handoff_text: `Real LLM ${args.run.arm} run for ${args.task.id}: ${args.run.summary}`,
    memory_lane: "private",
    target_files: targetFiles,
    must_keep: args.task.expected?.forbidden_edit_files ?? [],
    next_action: args.run.metrics.verifier_passed ? "Reuse only if the verifier and target files match." : "Inspect failure before reusing this run.",
    acceptance_checks: args.task.expected?.acceptance_checks ?? [args.task.verifier.command],
    execution_result_summary: {
      status: args.run.status,
      verifier_passed: args.run.metrics.verifier_passed,
      metrics: args.run.metrics,
      verifier: {
        command: args.run.verifier.command,
        exit_code: args.run.verifier.exit_code,
        timed_out: args.run.verifier.timed_out,
        stdout_tail: commandTail(args.run.verifier.stdout),
        stderr_tail: commandTail(args.run.verifier.stderr),
      },
      failed_tool_calls: failedToolCalls(args.run),
    },
    execution_evidence: [verifierEvidence(args.run)],
    execution_packet_v1: {
      version: 1,
      state_id: args.run.run_id,
      current_stage: "patch",
      active_role: "patch",
      task_brief: args.task.prompt,
      target_files: targetFiles,
      next_action: args.run.metrics.verifier_passed
        ? "Reuse this execution path only when the verifier and target files match."
        : "Inspect this failed run before reusing any step.",
      hard_constraints: [
        "No mock validation.",
        "Run the verifier before accepting the result.",
        ...(args.task.expected?.allowed_edit_files?.length
          ? [`Allowed edit files: ${args.task.expected.allowed_edit_files.join(", ")}`]
          : args.task.expected?.target_files?.length
            ? [`Allowed edit files: ${args.task.expected.target_files.join(", ")}`]
            : []),
        ...(args.task.expected?.forbidden_edit_files?.length
          ? [`Forbidden edit files: ${args.task.expected.forbidden_edit_files.join(", ")}`]
          : []),
        ...(args.task.expected?.anti_shortcut_rules ?? []),
      ],
      accepted_facts: args.run.metrics.verifier_passed
        ? [`Verifier passed: ${args.task.verifier.command}`]
        : [],
      rejected_paths: [],
      pending_validations: args.run.metrics.verifier_passed ? [] : [args.task.verifier.command],
      unresolved_blockers: args.run.metrics.verifier_passed ? [] : ["real LLM run did not satisfy verifier"],
      rollback_notes: [],
      review_contract: null,
      resume_anchor: {
        anchor: `real-llm-eval:${args.task.id}:${args.run.arm}`,
        file_path: targetFiles[0] ?? null,
        symbol: null,
        repo_root: args.run.workspace_dir,
      },
      artifact_refs: args.run.metrics.touched_files.map((file) => `workspace://${args.run.run_id}/${file}`),
      evidence_refs: [`verifier://${args.run.run_id}`],
      acceptance_checks: args.task.expected?.acceptance_checks ?? [args.task.verifier.command],
      verifier_command: args.task.verifier.command,
      contract_trust: args.run.metrics.verifier_passed ? "authoritative" : "advisory",
    },
  });
  const selectedFeedbackTool = feedbackToolName(args.run);
  let toolsFeedback: JsonObject | null = null;
  if (selectedFeedbackTool) {
    toolsFeedback = await postRuntime(args.baseUrl, "/v1/memory/tools/feedback", {
      tenant_id: base.tenant_id,
      scope: base.scope,
      actor: base.actor,
      run_id: args.run.run_id,
      outcome: args.run.metrics.verifier_passed ? "positive" : "negative",
      context: {
        task_id: args.task.id,
        prompt: args.task.prompt,
        verifier_passed: args.run.metrics.verifier_passed,
        metrics: args.run.metrics,
      },
      candidates: ["list_files", "read_file", "search", "run_command", "replace_text", "replace_lines", "apply_patch"],
      selected_tool: selectedFeedbackTool,
      target: "tool",
      input_text: args.task.prompt,
      note: `Real LLM ${args.run.arm} feedback from verifier ${args.run.metrics.verifier_passed ? "pass" : "fail"}.`,
    });
  }
  const introspection = await postRuntime(args.baseUrl, "/v1/memory/execution/introspect", {
    tenant_id: base.tenant_id,
    scope: base.scope,
    consumer_agent_id: base.consumer_agent_id,
    run_id: args.run.run_id,
    limit: 20,
  });
  return { started, replay_steps: replaySteps, ended, compile, handoff, tools_feedback: toolsFeedback, introspection };
}

async function runTaskRuntimeMaintenance(args: {
  baseUrl: string;
  task: EvalTask;
}): Promise<JsonObject> {
  return await postRuntime(args.baseUrl, "/v1/memory/runtime-maintenance/run", {
    tenant_id: "real-llm-eval",
    scope: `real-llm-eval:${args.task.id}`,
    actor: "real-llm-agent",
    mode: "apply",
    surfaces: ["workflow", "pattern", "policy", "forgetting"],
    limit: 100,
    max_mutations: 50,
    snapshot_limit: 500,
  });
}

function nullableDelta(before: number | null, after: number | null): number | null {
  return typeof before === "number" && typeof after === "number" ? before - after : null;
}

function compareRuns(baseline: AgentRun, aionis: AgentRun): JsonObject {
  return {
    verifier_improved: !baseline.metrics.verifier_passed && aionis.metrics.verifier_passed,
    verifier_equal_or_better: baseline.metrics.verifier_passed === aionis.metrics.verifier_passed || aionis.metrics.verifier_passed,
    assisted_verifier_regressed: baseline.metrics.verifier_passed && !aionis.metrics.verifier_passed,
    first_action_improved: baseline.metrics.first_action_correct !== true && aionis.metrics.first_action_correct === true,
    first_write_step_delta: nullableDelta(baseline.metrics.first_write_step, aionis.metrics.first_write_step),
    first_target_write_step_delta: nullableDelta(baseline.metrics.first_target_write_step, aionis.metrics.first_target_write_step),
    first_write_latency_ms_delta: nullableDelta(baseline.metrics.first_write_latency_ms, aionis.metrics.first_write_latency_ms),
    first_target_write_latency_ms_delta: nullableDelta(baseline.metrics.first_target_write_latency_ms, aionis.metrics.first_target_write_latency_ms),
    repeated_discovery_delta: baseline.metrics.repeated_discovery_steps - aionis.metrics.repeated_discovery_steps,
    wrong_file_touch_delta: baseline.metrics.wrong_file_touches - aionis.metrics.wrong_file_touches,
    tool_step_delta: baseline.metrics.tool_step_count - aionis.metrics.tool_step_count,
    token_delta: (baseline.metrics.input_tokens + baseline.metrics.output_tokens) - (aionis.metrics.input_tokens + aionis.metrics.output_tokens),
    time_delta_ms: baseline.metrics.time_to_finish_ms - aionis.metrics.time_to_finish_ms,
  };
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function nativeKickoffRecommendation(report: JsonObject): JsonObject | null {
  const aionis = asObject(report.aionis);
  const context = asObject(aionis?.aionis_context);
  const kickoffResponse = asObject(context?.kickoff);
  return asObject(kickoffResponse?.kickoff_recommendation);
}

function nativeKickoffTargetFilesSatisfied(report: JsonObject, task: EvalTask | undefined): boolean {
  const kickoff = nativeKickoffRecommendation(report);
  const contract = asObject(kickoff?.execution_contract_v1);
  const editBoundary = asObject(kickoff?.edit_boundary_v1);
  const repair = asObject(kickoff?.verification_repair_v1);
  const repairAffected = Array.isArray(repair?.affected_files)
    ? repair.affected_files.map((entry) => asString(asObject(entry)?.path))
    : [];
  const targetFiles = uniqueStringValues([
    contract?.target_files,
    kickoff?.target_files,
    contract?.file_path,
    kickoff?.file_path,
    editBoundary?.allowed_edit_files,
    repairAffected,
  ], 24);
  const expected = task?.expected?.target_files ?? [];
  if (expected.length > 0) return expected.every((file) => targetFiles.includes(file));
  return targetFiles.length > 0;
}

function nativeKickoffFirstActionSatisfied(report: JsonObject, task: EvalTask | undefined): boolean {
  const kickoff = nativeKickoffRecommendation(report);
  const firstAction = asObject(kickoff?.first_action_v1);
  const action = asString(firstAction?.action);
  const priority = asString(firstAction?.priority);
  const filePath = asString(firstAction?.file_path);
  const actionTargetFiles = uniqueStringValues([firstAction?.target_files, filePath], 24);
  const expected = task?.expected?.target_files ?? [];
  if (action !== "read_file" || priority !== "required" || !filePath) return false;
  if (expected.length > 0) {
    return expected.includes(filePath) && actionTargetFiles.includes(filePath);
  }
  return actionTargetFiles.includes(filePath);
}

function nativeKickoffEditBoundarySatisfied(report: JsonObject, task: EvalTask | undefined): boolean {
  const kickoff = nativeKickoffRecommendation(report);
  const boundary = asObject(kickoff?.edit_boundary_v1);
  const allowed = stringList(boundary?.allowed_edit_files);
  const forbidden = stringList(boundary?.forbidden_edit_files);
  const verifiers = stringList(boundary?.required_verifiers);
  const expectedAllowed = task?.expected?.allowed_edit_files ?? task?.expected?.target_files ?? [];
  const expectedForbidden = task?.expected?.forbidden_edit_files ?? [];
  const expectedVerifiers = task?.expected?.required_verifiers ?? task?.expected?.acceptance_checks ?? [];
  if (!boundary) return false;
  if (expectedAllowed.length > 0 && !expectedAllowed.every((file) => allowed.includes(file))) return false;
  if (expectedForbidden.length > 0 && !expectedForbidden.every((file) => forbidden.includes(file))) return false;
  if (expectedVerifiers.length > 0 && !expectedVerifiers.every((command) => verifiers.includes(command))) return false;
  return allowed.length > 0 || forbidden.length > 0 || verifiers.length > 0;
}

function assistedFirstActionTargetSatisfied(report: JsonObject, task: EvalTask | undefined): boolean {
  const aionis = asObject(report.aionis);
  const metrics = asObject(aionis?.metrics);
  const expected = task?.expected?.target_files ?? [];
  const replayApplied = metrics?.runtime_success_replay_applied === true;
  if (replayApplied) {
    const replayFiles = stringList(metrics.runtime_success_replay_files);
    if (expected.length > 0) {
      return replayFiles.length > 0 && replayFiles.every((file) => expected.includes(file));
    }
    return replayFiles.length > 0 || metrics?.first_action_correct === true;
  }
  const trace = asObject(aionis?.trace);
  const events = Array.isArray(trace?.events) ? trace.events : [];
  const firstEvent = asObject(events[0]);
  const firstInput = asObject(firstEvent?.tool_input);
  const firstPath = asString(firstInput?.path);
  if (expected.length > 0) {
    return (
      firstEvent?.tool_name === "read_file"
      && !!firstPath
      && expected.includes(firstPath)
      && metrics?.first_action_correct === true
    );
  }
  return metrics?.first_action_correct === true;
}

function defaultEffectGate(): Required<EvalEffectGate> {
  return {
    min_tasks: 1,
    require_assisted_success: true,
    require_assisted_first_action_target: false,
    require_native_kickoff_target_files: false,
    require_native_first_action: false,
    require_native_edit_boundary: false,
    min_assisted_success_rate: 1,
    min_improved_task_count: 1,
    min_average_repeated_discovery_delta: 0,
    min_average_wrong_file_touch_delta: 0,
    min_average_tool_step_delta: -1000000,
    fail_on_assisted_verifier_regression: true,
    fail_on_average_repeated_discovery_regression: true,
    fail_on_assisted_forbidden_file_write: false,
    max_llm_api_error_count: null,
    max_assisted_llm_api_error_count: null,
    max_assisted_llm_protocol_error_count: null,
    max_assisted_llm_protocol_error_rate_per_run: null,
    min_assisted_llm_protocol_repair_rate: null,
  };
}

function resolveEffectGate(suite: EvalSuite): Required<EvalEffectGate> {
  return {
    ...defaultEffectGate(),
    ...(suite.effect_gate ?? {}),
  };
}

function evaluateEffectGate(args: {
  suite: EvalSuite;
  taskReports: JsonObject[];
  summary: JsonObject;
}): EffectGateReport {
  const gate = resolveEffectGate(args.suite);
  const taskById = new Map(args.suite.tasks.map((task) => [task.id, task]));
  const comparisons = args.taskReports.map((report) => asObject(report.comparison) ?? {});
  const taskCount = args.taskReports.length;
  const aionisOnlyPriorReportMode = taskCount > 0 && args.taskReports.every((report) => (
    (asString(report.run_mode) ?? "").startsWith("aionis_only_prior_report")
  ));
  const staleSuccessReplayMode = taskCount > 0 && args.taskReports.every((report) => (
    asString(report.run_mode) === "aionis_only_prior_report_stale_replay"
  ));
  const assistedSuccessCount = numeric(args.summary.assisted_success_count);
  const assistedSuccessRate = taskCount > 0 ? assistedSuccessCount / taskCount : 0;
  const runtimeSuccessReplayPresentCount = args.taskReports.filter((report) => (
    metricBoolean(asObject(report.aionis), "runtime_success_replay_present")
  )).length;
  const successReplayMode = staleSuccessReplayMode || (
    aionisOnlyPriorReportMode
    && taskCount > 0
    && runtimeSuccessReplayPresentCount === taskCount
  );
  const skipNativeRunChecks = aionisOnlyPriorReportMode || successReplayMode;
  const runtimeSuccessReplayAttemptedCount = args.taskReports.filter((report) => (
    metricBoolean(asObject(report.aionis), "runtime_success_replay_attempted")
  )).length;
  const runtimeSuccessReplayAppliedCount = args.taskReports.filter((report) => (
    metricsFromRun(asObject(report.aionis)).runtime_success_replay_applied === true
  )).length;
  const runtimeSuccessReplaySucceededCount = args.taskReports.filter((report) => (
    metricsFromRun(asObject(report.aionis)).runtime_success_replay_applied === true
    && metricBoolean(asObject(report.aionis), "verifier_passed")
  )).length;
  const runtimeSuccessReplayFailedCandidateTaskCount = args.taskReports.filter((report) => (
    metricNumber(asObject(report.aionis), "runtime_success_replay_failed_candidate_count") > 0
  )).length;
  const runtimeSuccessReplayStaleCandidateTaskCount = args.taskReports.filter((report) => (
    metricNumber(asObject(report.aionis), "runtime_success_replay_stale_candidate_count") > 0
  )).length;
  const runtimeSuccessReplayAdaptedAfterFailureCount = args.taskReports.filter((report) => (
    metricBoolean(asObject(report.aionis), "runtime_success_replay_adapted_after_failure")
  )).length;
  const runtimeSuccessReplayAdaptationWithinBoundaryCount = args.taskReports.filter((report) => (
    metricsFromRun(asObject(report.aionis)).runtime_success_replay_adaptation_within_boundary === true
  )).length;
  const runtimeSuccessReplayAdaptationSucceededCount = args.taskReports.filter((report) => (
    metricBoolean(asObject(report.aionis), "runtime_success_replay_adaptation_succeeded")
  )).length;
  const nativeKickoffTargetFilesCount = args.taskReports.filter((report) => (
    nativeKickoffTargetFilesSatisfied(report, taskById.get(asString(report.task_id) ?? ""))
  )).length;
  const nativeFirstActionCount = args.taskReports.filter((report) => (
    nativeKickoffFirstActionSatisfied(report, taskById.get(asString(report.task_id) ?? ""))
  )).length;
  const nativeEditBoundaryCount = args.taskReports.filter((report) => (
    nativeKickoffEditBoundarySatisfied(report, taskById.get(asString(report.task_id) ?? ""))
  )).length;
  const assistedFirstActionTargetCount = args.taskReports.filter((report) => (
    assistedFirstActionTargetSatisfied(report, taskById.get(asString(report.task_id) ?? ""))
  )).length;
  const improvedTaskCount = comparisons.filter((comparison) => (
    booleanValue(comparison.verifier_improved)
    || booleanValue(comparison.first_action_improved)
    || numeric(comparison.repeated_discovery_delta) > 0
    || numeric(comparison.wrong_file_touch_delta) > 0
    || numeric(comparison.tool_step_delta) > 0
  )).length;
  const assistedVerifierRegressionCount = comparisons.filter((comparison) => (
    booleanValue(comparison.assisted_verifier_regressed)
  )).length;
  const assistedForbiddenWriteCount = args.taskReports.filter((report) => {
    const metrics = asObject(asObject(report.aionis)?.metrics);
    return numeric(metrics?.forbidden_file_writes) > 0;
  }).length;
  const allRuns = args.taskReports.flatMap((report) => [
    asObject(report.seed),
    asObject(report.baseline),
    ...(Array.isArray(report.aionis_attempts)
      ? report.aionis_attempts.map((attempt) => asObject(attempt))
      : []),
  ]).filter((run): run is JsonObject => !!run);
  const assistedRuns = args.taskReports.flatMap((report) => (
    Array.isArray(report.aionis_attempts)
      ? report.aionis_attempts.map((attempt) => asObject(attempt))
      : [asObject(report.aionis)]
  )).filter((run): run is JsonObject => !!run);
  const nonQuarantinedAssistedRuns = assistedRuns.filter((run) => !runtimeLearningQuarantineReasonFromRun(run));
  const assistedProtocolEffectRuns = nonQuarantinedAssistedRuns.length > 0 ? nonQuarantinedAssistedRuns : assistedRuns;
  const llmApiErrorCount = allRuns.reduce((sum, run) => (
    sum + metricNumber(run, "llm_api_error_count")
  ), 0);
  const assistedLlmApiErrorCount = assistedRuns.reduce((sum, run) => (
    sum + metricNumber(run, "llm_api_error_count")
  ), 0);
  const assistedProtocolErrorCount = assistedProtocolEffectRuns.reduce((sum, run) => (
    sum + metricNumber(run, "llm_protocol_error_count")
  ), 0);
  const assistedProtocolRepairCount = assistedProtocolEffectRuns.reduce((sum, run) => (
    sum + metricNumber(run, "llm_protocol_repair_count")
  ), 0);
  const assistedUnrepairedProtocolErrorCount = Math.max(0, assistedProtocolErrorCount - assistedProtocolRepairCount);
  const assistedUnrepairedProtocolErrorRate = assistedProtocolEffectRuns.length > 0
    ? assistedUnrepairedProtocolErrorCount / assistedProtocolEffectRuns.length
    : 0;
  const assistedProtocolRepairRate = assistedProtocolErrorCount > 0
    ? assistedProtocolRepairCount / assistedProtocolErrorCount
    : 1;
  const providerHealthRuns = successReplayMode ? assistedRuns : allRuns;
  const providerHealthLlmApiErrorCount = providerHealthRuns.reduce((sum, run) => (
    sum + metricNumber(run, "llm_api_error_count")
  ), 0);
  const checks: EffectGateReport["checks"] = [
    {
      id: "min_tasks",
      scope: "effect",
      pass: taskCount >= gate.min_tasks,
      observed: taskCount,
      expected: gate.min_tasks,
    },
    {
      id: "assisted_success_required",
      scope: "effect",
      pass: !gate.require_assisted_success || assistedSuccessCount === taskCount,
      observed: assistedSuccessCount,
      expected: gate.require_assisted_success ? taskCount : false,
    },
    ...(successReplayMode
      ? [
          {
            id: "runtime_success_replay_attempted_required",
            scope: "effect" as const,
            pass: runtimeSuccessReplayAttemptedCount === taskCount,
            observed: runtimeSuccessReplayAttemptedCount,
            expected: taskCount,
          },
          ...(staleSuccessReplayMode
            ? [
                {
                  id: "runtime_success_replay_failed_candidate_required",
                  scope: "effect" as const,
                  pass: runtimeSuccessReplayFailedCandidateTaskCount === taskCount,
                  observed: runtimeSuccessReplayFailedCandidateTaskCount,
                  expected: taskCount,
                },
                {
                  id: "runtime_success_replay_stale_candidate_required",
                  scope: "effect" as const,
                  pass: runtimeSuccessReplayStaleCandidateTaskCount === taskCount,
                  observed: runtimeSuccessReplayStaleCandidateTaskCount,
                  expected: taskCount,
                },
                {
                  id: "runtime_success_replay_adapted_after_failure_required",
                  scope: "effect" as const,
                  pass: runtimeSuccessReplayAdaptedAfterFailureCount === taskCount,
                  observed: runtimeSuccessReplayAdaptedAfterFailureCount,
                  expected: taskCount,
                },
                {
                  id: "runtime_success_replay_adaptation_within_boundary_required",
                  scope: "effect" as const,
                  pass: runtimeSuccessReplayAdaptationWithinBoundaryCount === taskCount,
                  observed: runtimeSuccessReplayAdaptationWithinBoundaryCount,
                  expected: taskCount,
                },
                {
                  id: "runtime_success_replay_adaptation_succeeded_required",
                  scope: "effect" as const,
                  pass: runtimeSuccessReplayAdaptationSucceededCount === taskCount,
                  observed: runtimeSuccessReplayAdaptationSucceededCount,
                  expected: taskCount,
                },
              ]
            : [
                {
                  id: "runtime_success_replay_applied_required",
                  scope: "effect" as const,
                  pass: runtimeSuccessReplayAppliedCount === taskCount,
                  observed: runtimeSuccessReplayAppliedCount,
                  expected: taskCount,
                },
                {
                  id: "runtime_success_replay_succeeded_required",
                  scope: "effect" as const,
                  pass: runtimeSuccessReplaySucceededCount === taskCount,
                  observed: runtimeSuccessReplaySucceededCount,
                  expected: taskCount,
                },
              ]),
        ]
      : []),
    {
      id: "assisted_first_action_target_required",
      scope: "effect",
      pass: successReplayMode || !gate.require_assisted_first_action_target || assistedFirstActionTargetCount === taskCount,
      observed: assistedFirstActionTargetCount,
      expected: successReplayMode ? false : gate.require_assisted_first_action_target ? taskCount : false,
    },
    {
      id: "native_kickoff_target_files_required",
      scope: "effect",
      pass: skipNativeRunChecks || !gate.require_native_kickoff_target_files || nativeKickoffTargetFilesCount === taskCount,
      observed: nativeKickoffTargetFilesCount,
      expected: skipNativeRunChecks ? false : gate.require_native_kickoff_target_files ? taskCount : false,
    },
    {
      id: "native_first_action_required",
      scope: "effect",
      pass: skipNativeRunChecks || !gate.require_native_first_action || nativeFirstActionCount === taskCount,
      observed: nativeFirstActionCount,
      expected: skipNativeRunChecks ? false : gate.require_native_first_action ? taskCount : false,
    },
    {
      id: "native_edit_boundary_required",
      scope: "effect",
      pass: skipNativeRunChecks || !gate.require_native_edit_boundary || nativeEditBoundaryCount === taskCount,
      observed: nativeEditBoundaryCount,
      expected: skipNativeRunChecks ? false : gate.require_native_edit_boundary ? taskCount : false,
    },
    {
      id: "min_assisted_success_rate",
      scope: "effect",
      pass: assistedSuccessRate >= gate.min_assisted_success_rate,
      observed: Math.round(assistedSuccessRate * 1000) / 1000,
      expected: gate.min_assisted_success_rate,
    },
    {
      id: "min_improved_task_count",
      scope: "effect",
      pass: improvedTaskCount >= gate.min_improved_task_count,
      observed: improvedTaskCount,
      expected: gate.min_improved_task_count,
    },
    {
      id: "min_average_repeated_discovery_delta",
      scope: "effect",
      pass: numeric(args.summary.average_repeated_discovery_delta) >= gate.min_average_repeated_discovery_delta,
      observed: numeric(args.summary.average_repeated_discovery_delta),
      expected: gate.min_average_repeated_discovery_delta,
    },
    {
      id: "min_average_wrong_file_touch_delta",
      scope: "effect",
      pass: numeric(args.summary.average_wrong_file_touch_delta) >= gate.min_average_wrong_file_touch_delta,
      observed: numeric(args.summary.average_wrong_file_touch_delta),
      expected: gate.min_average_wrong_file_touch_delta,
    },
    {
      id: "min_average_tool_step_delta",
      scope: "effect",
      pass: numeric(args.summary.average_tool_step_delta) >= gate.min_average_tool_step_delta,
      observed: numeric(args.summary.average_tool_step_delta),
      expected: gate.min_average_tool_step_delta,
    },
    {
      id: "no_assisted_verifier_regression",
      scope: "effect",
      pass: !gate.fail_on_assisted_verifier_regression || assistedVerifierRegressionCount === 0,
      observed: assistedVerifierRegressionCount,
      expected: 0,
    },
    {
      id: "no_average_repeated_discovery_regression",
      scope: "effect",
      pass: !gate.fail_on_average_repeated_discovery_regression || numeric(args.summary.average_repeated_discovery_delta) >= 0,
      observed: numeric(args.summary.average_repeated_discovery_delta),
      expected: 0,
    },
    {
      id: "no_assisted_forbidden_file_write",
      scope: "effect",
      pass: !gate.fail_on_assisted_forbidden_file_write || assistedForbiddenWriteCount === 0,
      observed: assistedForbiddenWriteCount,
      expected: 0,
    },
    ...(typeof gate.max_llm_api_error_count === "number"
        ? [{
            id: "max_llm_api_error_count",
          scope: "provider_health" as const,
          pass: providerHealthLlmApiErrorCount <= gate.max_llm_api_error_count,
          observed: providerHealthLlmApiErrorCount,
          expected: gate.max_llm_api_error_count,
        }]
      : []),
    ...(typeof gate.max_assisted_llm_api_error_count === "number"
        ? [{
            id: "max_assisted_llm_api_error_count",
          scope: "provider_health" as const,
          pass: assistedLlmApiErrorCount <= gate.max_assisted_llm_api_error_count,
          observed: assistedLlmApiErrorCount,
          expected: gate.max_assisted_llm_api_error_count,
        }]
      : []),
    ...(typeof gate.max_assisted_llm_protocol_error_count === "number"
        ? [{
            id: "max_assisted_unrepaired_llm_protocol_error_count",
          scope: "effect" as const,
          pass: assistedUnrepairedProtocolErrorCount <= gate.max_assisted_llm_protocol_error_count,
          observed: assistedUnrepairedProtocolErrorCount,
          expected: gate.max_assisted_llm_protocol_error_count,
        }]
      : []),
    ...(typeof gate.max_assisted_llm_protocol_error_rate_per_run === "number"
        ? [{
            id: "max_assisted_unrepaired_llm_protocol_error_rate_per_run",
          scope: "effect" as const,
          pass: assistedUnrepairedProtocolErrorRate <= gate.max_assisted_llm_protocol_error_rate_per_run,
          observed: Math.round(assistedUnrepairedProtocolErrorRate * 1000) / 1000,
          expected: gate.max_assisted_llm_protocol_error_rate_per_run,
        }]
      : []),
    ...(typeof gate.min_assisted_llm_protocol_repair_rate === "number"
        ? [{
            id: "min_assisted_llm_protocol_repair_rate",
          scope: "effect" as const,
          pass: assistedProtocolRepairRate >= gate.min_assisted_llm_protocol_repair_rate,
          observed: Math.round(assistedProtocolRepairRate * 1000) / 1000,
          expected: gate.min_assisted_llm_protocol_repair_rate,
        }]
      : []),
  ];
  const failedChecks = checks.filter((check) => !check.pass).map((check) => check.id);
  const failedEffectChecks = checks
    .filter((check) => check.scope === "effect" && !check.pass)
    .map((check) => check.id);
  const failedProviderHealthChecks = checks
    .filter((check) => check.scope === "provider_health" && !check.pass)
    .map((check) => check.id);
  return {
    gate_version: "aionis_real_llm_effect_gate_v1",
    status: failedChecks.length === 0 ? "pass" : "fail",
    effect_status: failedEffectChecks.length === 0 ? "pass" : "fail",
    provider_health_status: failedProviderHealthChecks.length === 0 ? "pass" : "fail",
    checks,
    failed_checks: failedChecks,
    failed_effect_checks: failedEffectChecks,
    failed_provider_health_checks: failedProviderHealthChecks,
  };
}

function buildSuiteSummary(taskReports: JsonObject[]): JsonObject {
  const comparisons = taskReports.map((report) => asObject(report.comparison) ?? {});
  const comparisonNumbers = (key: string): number[] => comparisons
    .map((item) => item[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const passedAssisted = taskReports.filter((report) => asObject(report.aionis)?.status === "success").length;
  const runtimeEffectRollup = buildRuntimeEffectRollupFromTaskReports(taskReports);
  return {
    task_count: taskReports.length,
    assisted_success_count: passedAssisted,
    average_repeated_discovery_delta:
      comparisons.reduce((sum, item) => sum + Number(item.repeated_discovery_delta ?? 0), 0) / Math.max(1, comparisons.length),
    average_wrong_file_touch_delta:
      comparisons.reduce((sum, item) => sum + Number(item.wrong_file_touch_delta ?? 0), 0) / Math.max(1, comparisons.length),
    average_tool_step_delta:
      comparisons.reduce((sum, item) => sum + Number(item.tool_step_delta ?? 0), 0) / Math.max(1, comparisons.length),
    average_first_write_step_delta: averageNumber(comparisonNumbers("first_write_step_delta")),
    average_first_target_write_step_delta: averageNumber(comparisonNumbers("first_target_write_step_delta")),
    average_first_write_latency_ms_delta: averageNumber(comparisonNumbers("first_write_latency_ms_delta")),
    average_first_target_write_latency_ms_delta: averageNumber(comparisonNumbers("first_target_write_latency_ms_delta")),
    assisted_forbidden_file_write_count:
      taskReports.filter((report) => numeric(asObject(asObject(report.aionis)?.metrics)?.forbidden_file_writes) > 0).length,
    runtime_effect_rollup: runtimeEffectRollup,
  };
}

function metricsFromRun(run: unknown): JsonObject {
  return asObject(asObject(run)?.metrics) ?? {};
}

function agentRunFromReport(value: unknown, label: string): AgentRun {
  const run = asObject(value);
  if (!run) throw new Error(`${label} is missing from prior real report`);
  const trace = asObject(run.trace);
  const events = Array.isArray(trace?.events) ? trace.events : [];
  const verifier = asObject(run.verifier);
  const metrics = asObject(run.metrics);
  if (!run.run_id || !run.task_id || !run.arm || !trace || events.length === 0 || !verifier || !metrics) {
    throw new Error(`${label} is not a complete real AgentRun in prior report`);
  }
  return run as unknown as AgentRun;
}

function priorTaskReportsByIdFromReport(report: JsonObject, reportFile: string, suite: EvalSuite): Map<string, JsonObject> {
  const tasks = Array.isArray(report.tasks)
    ? report.tasks.map((task) => asObject(task)).filter((task): task is JsonObject => !!task)
    : [];
  if (tasks.length === 0) throw new Error("--aionis-only-prior-report must contain real report tasks");
  const suiteTaskIds = new Set(suite.tasks.map((task) => task.id));
  const out = new Map<string, JsonObject>();
  for (const taskReport of tasks) {
    const taskId = asString(taskReport.task_id);
    if (!taskId || !suiteTaskIds.has(taskId)) continue;
    agentRunFromReport(taskReport.seed, `${reportFile}:${taskId}.seed`);
    agentRunFromReport(taskReport.baseline, `${reportFile}:${taskId}.baseline`);
    out.set(taskId, taskReport);
  }
  const missing = suite.tasks.map((task) => task.id).filter((taskId) => !out.has(taskId));
  if (missing.length > 0) {
    throw new Error(`--aionis-only-prior-report is missing selected task(s): ${missing.join(", ")}`);
  }
  return out;
}

function priorRunsForTaskReport(taskReport: JsonObject): AgentRun[] {
  const attempts = Array.isArray(taskReport.aionis_attempts)
    ? taskReport.aionis_attempts
    : [];
  return [
    agentRunFromReport(taskReport.seed, `${asString(taskReport.task_id) ?? "task"}.seed`),
    agentRunFromReport(taskReport.baseline, `${asString(taskReport.task_id) ?? "task"}.baseline`),
    ...attempts.map((attempt, index) => agentRunFromReport(
      attempt,
      `${asString(taskReport.task_id) ?? "task"}.aionis_attempts[${index}]`,
    )),
  ];
}

function timestampMs(value: unknown, fallback: number): number {
  const text = asString(value);
  if (!text) return fallback;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function recomputeAgentRunMetricsFromTrace(task: EvalTask, run: JsonObject): JsonObject {
  const trace = asObject(run.trace);
  const verifier = asObject(run.verifier);
  if (!trace || !verifier || !Array.isArray(trace.events)) return run;
  const oldMetrics = metricsFromRun(run);
  const startedMs = timestampMs(trace.started_at, Date.now());
  const endedMs = timestampMs(trace.ended_at, startedMs + metricNumber(run, "time_to_finish_ms"));
  const metrics = computeMetrics({
    task,
    events: trace.events as ToolEvent[],
    verifier: verifier as unknown as CommandResult,
    tokenUsage: {
      input: metricNumber(run, "input_tokens"),
      output: metricNumber(run, "output_tokens"),
    },
    startedMs,
    endedMs,
    llmApiErrorCount: metricNumber(run, "llm_api_error_count"),
    llmProtocolErrorCount: metricNumber(run, "llm_protocol_error_count"),
    llmProtocolRepairCount: metricNumber(run, "llm_protocol_repair_count"),
    policyBlockRecoveryModeCount: metricNumber(run, "policy_block_recovery_mode_count"),
    policyBlockRecoveryProtocolErrorCount: metricNumber(run, "policy_block_recovery_protocol_error_count"),
    repairActionCompilerPresent: metricBoolean(run, "repair_action_compiler_present"),
    aionisGuidance: asObject(run.aionis_guidance),
  });
  return {
    ...run,
    metrics: {
      ...oldMetrics,
      ...metrics,
    },
  };
}

function recomputeTaskReportMetricsFromTrace(suite: EvalSuite, taskReport: JsonObject): JsonObject {
  const taskId = asString(taskReport.task_id);
  const task = suite.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return taskReport;
  const seed = recomputeAgentRunMetricsFromTrace(task, asObject(taskReport.seed) ?? {});
  const baseline = recomputeAgentRunMetricsFromTrace(task, asObject(taskReport.baseline) ?? {});
  const attempts = Array.isArray(taskReport.aionis_attempts)
    ? taskReport.aionis_attempts
      .map((attempt) => asObject(attempt))
      .filter((attempt): attempt is JsonObject => !!attempt)
      .map((attempt) => recomputeAgentRunMetricsFromTrace(task, attempt))
    : [];
  const oldAionis = asObject(taskReport.aionis);
  const selectedAttempt = representativeAionisAttempt(attempts);
  const aionis = selectedAttempt
    ? selectedAttempt.run as JsonObject
    : oldAionis
      ? recomputeAgentRunMetricsFromTrace(task, oldAionis)
      : {};
  return {
    ...taskReport,
    seed,
    baseline,
    aionis,
    aionis_attempts: attempts,
    ...(selectedAttempt
      ? {
          aionis_selected_attempt: selectedAttempt.index + 1,
          aionis_selected_attempt_reason: selectedAttempt.reason,
        }
      : {}),
    comparison: compareRuns(baseline as unknown as AgentRun, aionis as unknown as AgentRun),
  };
}

function metricNumber(run: unknown, key: string): number {
  return numeric(metricsFromRun(run)[key]);
}

function metricBoolean(run: unknown, key: string): boolean {
  return metricsFromRun(run)[key] === true;
}

function metricStringList(run: unknown, key: string): string[] {
  return stringList(metricsFromRun(run)[key]);
}

function learningControlCandidatesFromRun(run: unknown): JsonObject[] {
  const candidates = asObject(run)?.learning_control_candidates;
  return Array.isArray(candidates)
    ? candidates.map((candidate) => asObject(candidate)).filter((candidate): candidate is JsonObject => !!candidate)
    : [];
}

function semanticCandidateProducerFromRun(run: unknown): JsonObject | null {
  return asObject(asObject(run)?.semantic_candidate_producer);
}

function traceEventsFromRun(run: unknown): JsonObject[] {
  const events = asObject(asObject(run)?.trace)?.events;
  return Array.isArray(events)
    ? events.map((event) => asObject(event)).filter((event): event is JsonObject => !!event)
    : [];
}

function runtimeLearningQuarantineReasonFromRun(run: unknown): string | null {
  const metrics = metricsFromRun(run);
  const explicitReason = asString(metrics.runtime_learning_quarantine_reason);
  if (explicitReason) return explicitReason;
  const events = traceEventsFromRun(run);
  const agentToolEvents = events.filter((event) => {
    const toolName = asString(event.tool_name);
    return toolName !== "llm_call" && toolName !== "llm_protocol";
  });
  const eventWriteCount = events.reduce((sum, event) => sum + stringList(event.write_files).length, 0);
  const editedFileCount = stringList(metrics.edited_files).length + eventWriteCount;
  if (metrics.verifier_passed !== true && stringList(metrics.failure_categories).includes("llm_protocol_fatal")) {
    return "tool_protocol_failure_before_completed_run";
  }
  if (metrics.verifier_passed === true || editedFileCount > 0 || agentToolEvents.length > 0) return null;
  if (numeric(metrics.llm_api_error_count) > 0) return "provider_failure_before_tool_action";
  if (numeric(metrics.llm_protocol_error_count) > 0) return "tool_protocol_failure_before_tool_action";
  return null;
}

function eligibleForRuntimeLearning(run: unknown): boolean {
  return !runtimeLearningQuarantineReasonFromRun(run);
}

function representativeAionisAttemptIndex(attempts: readonly unknown[]): number {
  if (attempts.length === 0) return -1;
  const passedIndex = attempts.findIndex((attempt) => metricsFromRun(attempt).verifier_passed === true);
  if (passedIndex >= 0) return passedIndex;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (!runtimeLearningQuarantineReasonFromRun(attempts[index])) return index;
  }
  return attempts.length - 1;
}

function representativeAionisAttempt<T>(attempts: readonly T[]): { run: T; index: number; reason: string } | null {
  const index = representativeAionisAttemptIndex(attempts);
  if (index < 0) return null;
  const run = attempts[index];
  const reason = metricsFromRun(run).verifier_passed === true
    ? "verifier_passed"
    : runtimeLearningQuarantineReasonFromRun(run)
      ? "all_attempts_quarantined_latest_retained"
      : "latest_non_quarantined_attempt";
  return { run, index, reason };
}

function stopsFurtherAionisAttempts(quarantineReason: string | null): boolean {
  return quarantineReason === "provider_failure_before_tool_action"
    || quarantineReason === "tool_protocol_failure_before_tool_action";
}

function filterAionisPriorRuns(runs: AgentRun[], mode: AionisPriorEvidenceMode): AgentRun[] {
  if (mode === "none") return [];
  const eligible = runs.filter(eligibleForRuntimeLearning);
  if (mode === "failure-only") return eligible.filter((run) => !run.metrics.verifier_passed);
  return eligible;
}

function metricNullableNumber(run: unknown, key: string): number | null {
  const value = metricsFromRun(run)[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function incrementCount(map: Map<string, number>, key: string, increment = 1): void {
  map.set(key, (map.get(key) ?? 0) + increment);
}

function countsObject(map: Map<string, number>): JsonObject {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function averageNumber(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deltaNumber(before: number | null, after: number | null): number | null {
  return before === null || after === null ? null : before - after;
}

function normalizeFailureCategory(category: string): string {
  if (category.includes("provider_failure") || category.includes("llm_api_error") || category.includes("llm_call_failure")) return "provider_failure";
  if (category.includes("edit_operation")) return "edit_operation_failure";
  if (category.includes("lint_or_format")) return "lint_or_format_failure";
  if (category.includes("type_contract")) return "type_contract_failure";
  if (category.includes("test_assertion")) return "test_assertion_failure";
  if (category.includes("verifier")) return "verifier_failure";
  if (category.includes("tool_schema")) return "tool_schema_error";
  if (category.includes("write_policy") || category.includes("forbidden_file")) return "edit_boundary_write_policy_violation";
  return category;
}

function normalizedCategories(values: string[]): string[] {
  return uniqueStringValues(values.map(normalizeFailureCategory), 32);
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value, index) => rightSet.has(value) && left.indexOf(value) === index).sort();
}

function runTraceEvents(run: unknown): JsonObject[] {
  const trace = asObject(asObject(run)?.trace);
  return Array.isArray(trace?.events)
    ? trace.events.map((event) => asObject(event)).filter((event): event is JsonObject => !!event)
    : [];
}

function repairGuidanceFromRun(run: unknown): JsonObject | null {
  return asObject(asObject(asObject(run)?.aionis_guidance)?.verification_repair_v1);
}

function verifierFailurePhaseFromRun(run: unknown): JsonObject | null {
  const guidance = asObject(asObject(run)?.aionis_guidance);
  return asObject(guidance?.verifier_failure_phase_v1)
    ?? asObject(repairGuidanceFromRun(run)?.verifier_failure_phase_v1);
}

function finalVerifierFailurePhaseFromRun(task: EvalTask | undefined, run: unknown): JsonObject | null {
  if (!task || metricBoolean(run, "verifier_passed")) return null;
  const verifier = asObject(asObject(run)?.verifier);
  const stdout = asString(verifier?.stdout) ?? "";
  const stderr = asString(verifier?.stderr) ?? "";
  const outputText = `${stdout}\n${stderr}`.trim();
  if (!outputText) return null;
  return directVerifierFailurePhaseFromEvidence({
    evidence: [{ evidence_kind: "final_verifier_output" }],
    directFailureTexts: [
      outputText,
      ...metricStringList(run, "failure_categories"),
    ],
    directBlockingAssertions: [],
    directRepairActions: [],
    allowedEditFiles: task.expected?.allowed_edit_files ?? task.expected?.target_files ?? [],
    requiredVerifiers: [
      asString(verifier?.command) ?? task.verifier.command,
      ...(task.expected?.required_verifiers ?? task.expected?.acceptance_checks ?? []),
    ],
  });
}

function repairAffectedFilesFromRun(run: unknown): string[] {
  const guidance = asObject(asObject(run)?.aionis_guidance);
  const expanded = stringList(guidance?.repair_affected_files);
  const repair = repairGuidanceFromRun(run);
  const affected = Array.isArray(repair?.affected_files)
    ? repair.affected_files.map((entry) => asString(asObject(entry)?.path))
    : [];
  return uniqueStringValues([expanded, affected], 32);
}

function extractCommandCandidates(text: string): string[] {
  const patterns = [
    /node\s+\S*github-real-project-contracts\.mjs\s+[\w.-]+/g,
    /npx\s+xo\s+--fix(?:\s+[\w./-]*\.[\w.-]+)+/g,
    /npm\s+(?:run\s+-s\s+|run\s+)?test(?:\s+[\w:./-]+)*/g,
  ];
  return uniqueStringValues(
    patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => (
      match[0].replace(/[.,;:]+$/g, "").replace(/\s+/g, " ").trim()
    ))),
    16,
  );
}

function repairCommandsFromRun(run: unknown): string[] {
  const repair = repairGuidanceFromRun(run);
  if (!repair) return [];
  const actionCommands = stringList(repair.next_actions).flatMap(extractCommandCandidates);
  const instruction = asString(repair.instruction);
  return uniqueStringValues([
    stringList(repair.failed_commands),
    actionCommands,
    instruction ? extractCommandCandidates(instruction) : [],
  ], 32);
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function commandMatches(observed: string, expected: string): boolean {
  const left = normalizeCommand(observed);
  const right = normalizeCommand(expected);
  return left === right || left.includes(right) || right.includes(left);
}

function matchedRepairCommandsFromRun(run: unknown, repairCommands: string[]): string[] {
  if (repairCommands.length === 0) return [];
  const observedCommands = runTraceEvents(run)
    .map((event) => asString(asObject(event.tool_input)?.command))
    .filter((command): command is string => !!command);
  return uniqueStringValues(observedCommands.filter((observed) => (
    repairCommands.some((expected) => commandMatches(observed, expected))
  )), 32);
}

function buildLearningDiagnostics(taskReports: JsonObject[], suite?: EvalSuite): JsonObject {
  const taskById = new Map((suite?.tasks ?? []).map((task) => [task.id, task]));
  const categoryCounts = new Map<string, number>();
  const verifierFailurePhaseCounts = new Map<string, number>();
  const byTask: JsonObject[] = [];
  const firstWriteStepDeltas: number[] = [];
  const firstTargetWriteStepDeltas: number[] = [];
  const firstWriteLatencyDeltas: number[] = [];
  const firstTargetWriteLatencyDeltas: number[] = [];
  let runCount = 0;
  let assistedRunCount = 0;
  let verifierPassedCount = 0;
  let assistedVerifierPassedCount = 0;
  let llmApiErrorCount = 0;
  let assistedLlmApiErrorCount = 0;
  let llmProtocolErrorCount = 0;
  let assistedLlmProtocolErrorCount = 0;
  let assistedCompletedRunCount = 0;
  let assistedCompletedLlmProtocolErrorCount = 0;
  let llmProtocolRepairCount = 0;
  let assistedLlmProtocolRepairCount = 0;
  let assistedCompletedLlmProtocolRepairCount = 0;
  let policyBlockRecoveryModeCount = 0;
  let policyBlockRecoveryProtocolErrorCount = 0;
  let assistedPolicyBlockRecoveryModeCount = 0;
  let assistedPolicyBlockRecoveryProtocolErrorCount = 0;
  let failedToolCallCount = 0;
  let assistedFailedToolCallCount = 0;
  let verifierCommandRunCount = 0;
  let assistedVerifierCommandRunCount = 0;
  let commandWriteCount = 0;
  let assistedCommandWriteCount = 0;
  let forbiddenFileWriteCount = 0;
  let assistedForbiddenFileWriteCount = 0;
  let wrongFileTouchCount = 0;
  let assistedWrongFileTouchCount = 0;
  let continuityRepairCount = 0;
  let repairGuidancePresentCount = 0;
  let repairGuidanceUsedCount = 0;
  let repairGuidanceSucceededCount = 0;
  let repairCommandRerunCount = 0;
  let repairAffectedFileEditCount = 0;
  let firstActionSequencePresentCount = 0;
  let firstActionSequenceFollowedCount = 0;
  let firstActionSequenceViolatedCount = 0;
  let firstActionSequenceCleanFollowCount = 0;
  let firstActionSequencePolicyBlockCount = 0;
  let firstActionSequenceRecoveredCount = 0;
  let firstActionSequenceUnrecoveredCount = 0;
  let preRepairWriteBroadReadCount = 0;
  let repairSecondWritePresentCount = 0;
  let repairSecondWriteSatisfiedCount = 0;
  let postFirstRepairPreSecondBroadActionCount = 0;
  let actionSynthesisPlanPresentCount = 0;
  let repairActionCompilerPresentCount = 0;
  let cognitiveEntropyEnginePresentCount = 0;
  let cognitiveEntropyCounterfactualProbeRequiredCount = 0;
  let cognitiveEntropyCounterfactualProbeAttemptedCount = 0;
  let runtimeSuccessReplayPresentCount = 0;
  let runtimeSuccessReplayAttemptedCount = 0;
  let runtimeSuccessReplayAppliedCount = 0;
  let runtimeSuccessReplaySucceededCount = 0;
  let runtimeSuccessReplayFailedCandidateCount = 0;
  let runtimeSuccessReplayStaleCandidateCount = 0;
  let runtimeSuccessReplayInvalidCandidateCount = 0;
  let runtimeSuccessReplayAdaptedAfterFailureCount = 0;
  let runtimeSuccessReplayAdaptationWithinBoundaryCount = 0;
  let runtimeSuccessReplayAdaptationSucceededCount = 0;
  let runtimeLearningQuarantineCount = 0;
  let assistedRuntimeLearningQuarantineCount = 0;
  let semanticCandidateProducerRunCount = 0;
  let semanticCandidateProducedRunCount = 0;
  let semanticCandidateCount = 0;
  let semanticCandidateRejectedRunCount = 0;
  let semanticCandidateProviderFailureCount = 0;
  let semanticCandidateProtocolFailureCount = 0;
  let runtimeMaintenanceRunCount = 0;
  let runtimeMaintenanceAppliedCount = 0;
  let runtimeMaintenanceWorkflowPromotionCount = 0;
  let runtimeMaintenancePolicyRetirementCount = 0;
  let runtimeMaintenanceMemoryDemotionCount = 0;
  let runtimeMaintenanceMemoryArchiveCount = 0;
  let runtimeMaintenanceHotVisibilityDelta = 0;
  let runtimeMaintenanceArchiveVisibilityDelta = 0;
  let runtimeMaintenanceFeedbackPositiveTotal = 0;
  let runtimeMaintenanceFeedbackNegativeTotal = 0;
  let runtimeMaintenanceUsageCountTotal = 0;
  let runtimeMaintenanceReuseSuccessTotal = 0;
  let runtimeMaintenanceReuseFailureTotal = 0;
  let runtimeEffectSummaryCount = 0;
  let runtimeEffectBaselineComparisonRequiredCount = 0;
  let runtimeEffectContextOverBudgetCount = 0;
  let runtimeEffectContextItemsReducedCount = 0;
  let runtimeEffectRepeatedDiscoveryCount = 0;
  let runtimeEffectRepeatedFailedActionCount = 0;
  let runtimeEffectWorkflowReuseSuccessCount = 0;
  let runtimeEffectWorkflowReuseFailureCount = 0;
  let runtimeEffectVerifierSuccessCount = 0;
  let runtimeEffectVerifierFailureCount = 0;
  let runtimeEffectProviderQuarantineCount = 0;
  let promotionQualitySummaryCount = 0;
  const runtimeLearningQuarantineReasons = new Map<string, number>();
  const runtimeEffectPostureCounts = new Map<string, number>();
  const promotionInvalidationPressureCounts = new Map<string, number>();

  for (const report of taskReports) {
    const task = taskById.get(asString(report.task_id) ?? "");
    const seed = asObject(report.seed);
    const baseline = asObject(report.baseline);
    const attempts = Array.isArray(report.aionis_attempts)
      ? report.aionis_attempts.map((attempt) => asObject(attempt)).filter((attempt): attempt is JsonObject => !!attempt)
      : [];
    const finalAionis = asObject(report.aionis);
    const selectedAttemptNumber = numeric(report.aionis_selected_attempt);
    const selectedAttemptIndex = selectedAttemptNumber > 0
      ? selectedAttemptNumber - 1
      : representativeAionisAttemptIndex(attempts);
    const attemptsBeforeSelected = selectedAttemptIndex >= 0
      ? attempts.slice(0, selectedAttemptIndex)
      : attempts.slice(0, Math.max(0, attempts.length - 1));
    const runs = [seed, baseline, ...attempts].filter((run): run is JsonObject => !!run);
    const observedCategories = new Set<string>();
    const assistedCategories = new Set<string>();
    const finalPassed = metricBoolean(finalAionis, "verifier_passed");
    const attemptsToSuccessIndex = attempts.findIndex((attempt) => metricBoolean(attempt, "verifier_passed"));
    const attemptsToSuccess = attemptsToSuccessIndex >= 0 ? attemptsToSuccessIndex + 1 : null;
    const priorFailedRuns = [seed, baseline, ...attemptsBeforeSelected]
      .filter((run): run is JsonObject => !!run && !metricBoolean(run, "verifier_passed"));
    const priorFailureCategories = normalizedCategories(
      codeRepairFailureCategories(priorFailedRuns.flatMap((run) => metricStringList(run, "failure_categories"))),
    );
    const repairGuidance = repairGuidanceFromRun(finalAionis);
    const verifierFailurePhase = finalVerifierFailurePhaseFromRun(task, finalAionis)
      ?? verifierFailurePhaseFromRun(finalAionis);
    const verifierFailurePhaseName = asString(verifierFailurePhase?.phase);
    const finalSemanticCandidates = learningControlCandidatesFromRun(finalAionis);
    const runtimeMaintenance = asObject(report.runtime_maintenance);
    const runtimeMaintenanceEffect = asObject(runtimeMaintenance?.effect_summary);
    const runtimeMaintenanceReuse = asObject(runtimeMaintenanceEffect?.memory_reuse_signals);
    const runtimeMaintenanceApplied = numeric(runtimeMaintenance?.applied_count);
    const runtimeMaintenanceWorkflowPromotions = numeric(runtimeMaintenanceEffect?.workflow_promotions);
    const runtimeMaintenancePolicyRetirements = numeric(runtimeMaintenanceEffect?.policy_retirements);
    const runtimeMaintenanceMemoryDemotions = numeric(runtimeMaintenanceEffect?.memory_demotions);
    const runtimeMaintenanceMemoryArchives = numeric(runtimeMaintenanceEffect?.memory_archives);
    const runtimeMaintenanceHotDelta = numeric(runtimeMaintenanceEffect?.hot_visibility_delta);
    const runtimeMaintenanceArchiveDelta = numeric(runtimeMaintenanceEffect?.archive_visibility_delta);
    const runtimeEffectSummary = runtimeEffectSummaryFromTaskReport(report);
    const runtimeEffectTokenContext = asObject(runtimeEffectSummary?.token_context);
    const runtimeEffectContinuity = asObject(runtimeEffectSummary?.continuity);
    const runtimeEffectVerification = asObject(runtimeEffectSummary?.verification);
    const runtimeEffectLearning = asObject(runtimeEffectSummary?.learning);
    const promotionQualitySummary = promotionQualitySummaryFromTaskReport(report);
    if (runtimeMaintenance) runtimeMaintenanceRunCount += 1;
    runtimeMaintenanceAppliedCount += runtimeMaintenanceApplied;
    runtimeMaintenanceWorkflowPromotionCount += runtimeMaintenanceWorkflowPromotions;
    runtimeMaintenancePolicyRetirementCount += runtimeMaintenancePolicyRetirements;
    runtimeMaintenanceMemoryDemotionCount += runtimeMaintenanceMemoryDemotions;
    runtimeMaintenanceMemoryArchiveCount += runtimeMaintenanceMemoryArchives;
    runtimeMaintenanceHotVisibilityDelta += runtimeMaintenanceHotDelta;
    runtimeMaintenanceArchiveVisibilityDelta += runtimeMaintenanceArchiveDelta;
    runtimeMaintenanceFeedbackPositiveTotal += numeric(runtimeMaintenanceReuse?.feedback_positive_total);
    runtimeMaintenanceFeedbackNegativeTotal += numeric(runtimeMaintenanceReuse?.feedback_negative_total);
    runtimeMaintenanceUsageCountTotal += numeric(runtimeMaintenanceReuse?.usage_count_total);
    runtimeMaintenanceReuseSuccessTotal += numeric(runtimeMaintenanceReuse?.reuse_success_total);
    runtimeMaintenanceReuseFailureTotal += numeric(runtimeMaintenanceReuse?.reuse_failure_total);
    if (runtimeEffectSummary) {
      runtimeEffectSummaryCount += 1;
      if (runtimeEffectSummary.baseline_comparison_required === true) runtimeEffectBaselineComparisonRequiredCount += 1;
      const posture = asString(runtimeEffectSummary.measurable_effect_posture);
      if (posture) incrementCount(runtimeEffectPostureCounts, posture);
      runtimeEffectContextOverBudgetCount += numeric(runtimeEffectTokenContext?.over_budget_count);
      runtimeEffectContextItemsReducedCount += numeric(runtimeEffectTokenContext?.context_items_reduced_count);
      runtimeEffectRepeatedDiscoveryCount += numeric(runtimeEffectContinuity?.repeated_discovery_count);
      runtimeEffectRepeatedFailedActionCount += numeric(runtimeEffectContinuity?.repeated_failed_action_count);
      runtimeEffectWorkflowReuseSuccessCount += numeric(runtimeEffectLearning?.workflow_reuse_success_count);
      runtimeEffectWorkflowReuseFailureCount += numeric(runtimeEffectLearning?.workflow_reuse_failure_count);
      runtimeEffectVerifierSuccessCount += numeric(runtimeEffectVerification?.verifier_success_count);
      runtimeEffectVerifierFailureCount += numeric(runtimeEffectVerification?.verifier_failure_count);
      runtimeEffectProviderQuarantineCount += numeric(runtimeEffectVerification?.provider_quarantine_count);
    }
    if (promotionQualitySummary) {
      promotionQualitySummaryCount += 1;
      const pressure = asString(promotionQualitySummary.invalidation_pressure);
      if (pressure) incrementCount(promotionInvalidationPressureCounts, pressure);
    }
    if (verifierFailurePhaseName) incrementCount(verifierFailurePhaseCounts, verifierFailurePhaseName);
    const repairCategories = normalizedCategories(codeRepairFailureCategories(stringList(repairGuidance?.categories)));
    const repairCategoryOverlap = intersection(priorFailureCategories, repairCategories);
    const repairAffectedFiles = repairAffectedFilesFromRun(finalAionis);
    const assistedTouchedRepairFiles = intersection(metricStringList(finalAionis, "touched_files"), repairAffectedFiles);
    const assistedEditedRepairFiles = intersection(metricStringList(finalAionis, "edited_files"), repairAffectedFiles);
    const repairCommands = repairCommandsFromRun(finalAionis);
    const assistedMatchedRepairCommands = matchedRepairCommandsFromRun(finalAionis, repairCommands);
    const repairGuidancePresent = !!repairGuidance;
    const repairGuidanceUsed = repairGuidancePresent
      && repairCategoryOverlap.length > 0
      && (assistedEditedRepairFiles.length > 0 || assistedMatchedRepairCommands.length > 0);
    const repairGuidanceSucceeded = repairGuidanceUsed && finalPassed;
    const firstActionSequencePresent = metricBoolean(finalAionis, "first_action_sequence_present");
    const firstActionSequenceFollowed = metricsFromRun(finalAionis).first_action_sequence_followed === true;
    const firstActionSequenceViolation = asString(metricsFromRun(finalAionis).first_action_sequence_violation);
    const firstActionSequenceCleanFollow = metricsFromRun(finalAionis).first_action_sequence_clean_follow === true;
    const firstActionSequenceRecovered = metricsFromRun(finalAionis).first_action_sequence_recovered === true;
    const firstActionSequencePolicyBlocks = metricNumber(finalAionis, "first_action_sequence_policy_block_count");
    const runtimeSuccessReplayPresent = metricBoolean(finalAionis, "runtime_success_replay_present");
    const runtimeSuccessReplayAttempted = metricBoolean(finalAionis, "runtime_success_replay_attempted");
    const runtimeSuccessReplayApplied = metricsFromRun(finalAionis).runtime_success_replay_applied === true;
    const runtimeSuccessReplaySucceeded = runtimeSuccessReplayApplied && finalPassed;
    const runtimeSuccessReplayAdaptedAfterFailure = metricBoolean(finalAionis, "runtime_success_replay_adapted_after_failure");
    const runtimeSuccessReplayAdaptationWithinBoundary = metricsFromRun(finalAionis).runtime_success_replay_adaptation_within_boundary === true;
    const runtimeSuccessReplayAdaptationSucceeded = metricBoolean(finalAionis, "runtime_success_replay_adaptation_succeeded");
    if (firstActionSequencePresent) firstActionSequencePresentCount += 1;
    if (firstActionSequenceFollowed) firstActionSequenceFollowedCount += 1;
    if (firstActionSequencePresent && !firstActionSequenceFollowed) firstActionSequenceViolatedCount += 1;
    if (firstActionSequenceCleanFollow) firstActionSequenceCleanFollowCount += 1;
    if (firstActionSequenceRecovered) firstActionSequenceRecoveredCount += 1;
    if (firstActionSequencePresent && firstActionSequencePolicyBlocks > 0 && !firstActionSequenceRecovered) {
      firstActionSequenceUnrecoveredCount += 1;
    }
    firstActionSequencePolicyBlockCount += firstActionSequencePolicyBlocks;
    preRepairWriteBroadReadCount += metricNumber(finalAionis, "pre_repair_write_broad_read_count");
    if (metricBoolean(finalAionis, "repair_second_write_present")) repairSecondWritePresentCount += 1;
    if (metricNullableNumber(finalAionis, "second_repair_file_write_step") !== null) repairSecondWriteSatisfiedCount += 1;
    postFirstRepairPreSecondBroadActionCount += metricNumber(finalAionis, "post_first_repair_pre_second_broad_action_count");
    if (metricBoolean(finalAionis, "action_synthesis_plan_present")) actionSynthesisPlanPresentCount += 1;
    if (metricBoolean(finalAionis, "repair_action_compiler_present")) repairActionCompilerPresentCount += 1;
    if (metricBoolean(finalAionis, "cognitive_entropy_engine_present")) cognitiveEntropyEnginePresentCount += 1;
    if (metricBoolean(finalAionis, "cognitive_entropy_counterfactual_probe_required")) cognitiveEntropyCounterfactualProbeRequiredCount += 1;
    if (metricBoolean(finalAionis, "cognitive_entropy_counterfactual_probe_attempted")) cognitiveEntropyCounterfactualProbeAttemptedCount += 1;
    if (runtimeSuccessReplayPresent) runtimeSuccessReplayPresentCount += 1;
    if (runtimeSuccessReplayAttempted) runtimeSuccessReplayAttemptedCount += 1;
    if (runtimeSuccessReplayApplied) runtimeSuccessReplayAppliedCount += 1;
    if (runtimeSuccessReplaySucceeded) runtimeSuccessReplaySucceededCount += 1;
    runtimeSuccessReplayFailedCandidateCount += metricNumber(finalAionis, "runtime_success_replay_failed_candidate_count");
    runtimeSuccessReplayStaleCandidateCount += metricNumber(finalAionis, "runtime_success_replay_stale_candidate_count");
    runtimeSuccessReplayInvalidCandidateCount += metricNumber(finalAionis, "runtime_success_replay_invalid_candidate_count");
    if (runtimeSuccessReplayAdaptedAfterFailure) runtimeSuccessReplayAdaptedAfterFailureCount += 1;
    if (runtimeSuccessReplayAdaptationWithinBoundary) runtimeSuccessReplayAdaptationWithinBoundaryCount += 1;
    if (runtimeSuccessReplayAdaptationSucceeded) runtimeSuccessReplayAdaptationSucceededCount += 1;
    if (repairGuidancePresent) repairGuidancePresentCount += 1;
    if (repairGuidanceUsed) repairGuidanceUsedCount += 1;
    if (repairGuidanceSucceeded) repairGuidanceSucceededCount += 1;
    if (assistedMatchedRepairCommands.length > 0) repairCommandRerunCount += 1;
    if (assistedEditedRepairFiles.length > 0) repairAffectedFileEditCount += 1;
    const firstWriteStepDelta = deltaNumber(
      metricNullableNumber(baseline, "first_write_step"),
      metricNullableNumber(finalAionis, "first_write_step"),
    );
    const firstTargetWriteStepDelta = deltaNumber(
      metricNullableNumber(baseline, "first_target_write_step"),
      metricNullableNumber(finalAionis, "first_target_write_step"),
    );
    const firstWriteLatencyDelta = deltaNumber(
      metricNullableNumber(baseline, "first_write_latency_ms"),
      metricNullableNumber(finalAionis, "first_write_latency_ms"),
    );
    const firstTargetWriteLatencyDelta = deltaNumber(
      metricNullableNumber(baseline, "first_target_write_latency_ms"),
      metricNullableNumber(finalAionis, "first_target_write_latency_ms"),
    );
    if (firstWriteStepDelta !== null) firstWriteStepDeltas.push(firstWriteStepDelta);
    if (firstTargetWriteStepDelta !== null) firstTargetWriteStepDeltas.push(firstTargetWriteStepDelta);
    if (firstWriteLatencyDelta !== null) firstWriteLatencyDeltas.push(firstWriteLatencyDelta);
    if (firstTargetWriteLatencyDelta !== null) firstTargetWriteLatencyDeltas.push(firstTargetWriteLatencyDelta);
    const repairedByContinuity = attemptsBeforeSelected.length > 0
      && finalPassed
      && attemptsBeforeSelected.some((attempt) => !metricBoolean(attempt, "verifier_passed"));
    if (repairedByContinuity) continuityRepairCount += 1;

    for (const run of runs) {
      runCount += 1;
      const quarantineReason = runtimeLearningQuarantineReasonFromRun(run);
      if (quarantineReason) {
        runtimeLearningQuarantineCount += 1;
        incrementCount(runtimeLearningQuarantineReasons, quarantineReason);
      }
      if (metricBoolean(run, "verifier_passed")) verifierPassedCount += 1;
      const semanticProducer = semanticCandidateProducerFromRun(run);
      const semanticProducerStatus = asString(semanticProducer?.status);
      if (semanticProducer) semanticCandidateProducerRunCount += 1;
      if (semanticProducerStatus === "produced") semanticCandidateProducedRunCount += 1;
      if (semanticProducerStatus === "rejected") semanticCandidateRejectedRunCount += 1;
      if (semanticProducerStatus === "provider_failure") semanticCandidateProviderFailureCount += 1;
      if (semanticProducerStatus === "protocol_failure") semanticCandidateProtocolFailureCount += 1;
      semanticCandidateCount += learningControlCandidatesFromRun(run).length;
      llmApiErrorCount += metricNumber(run, "llm_api_error_count");
      llmProtocolErrorCount += metricNumber(run, "llm_protocol_error_count");
      llmProtocolRepairCount += metricNumber(run, "llm_protocol_repair_count");
      policyBlockRecoveryModeCount += metricNumber(run, "policy_block_recovery_mode_count");
      policyBlockRecoveryProtocolErrorCount += metricNumber(run, "policy_block_recovery_protocol_error_count");
      failedToolCallCount += metricNumber(run, "retry_count");
      verifierCommandRunCount += metricNumber(run, "verifier_command_run_count");
      commandWriteCount += metricNumber(run, "command_write_count");
      forbiddenFileWriteCount += metricNumber(run, "forbidden_file_writes");
      wrongFileTouchCount += metricNumber(run, "wrong_file_touches");
      for (const category of metricStringList(run, "failure_categories")) {
        incrementCount(categoryCounts, category);
        observedCategories.add(category);
      }
    }

    for (const attempt of attempts) {
      assistedRunCount += 1;
      const assistedQuarantineReason = runtimeLearningQuarantineReasonFromRun(attempt);
      if (assistedQuarantineReason) {
        assistedRuntimeLearningQuarantineCount += 1;
      } else {
        assistedCompletedRunCount += 1;
        assistedCompletedLlmProtocolErrorCount += metricNumber(attempt, "llm_protocol_error_count");
        assistedCompletedLlmProtocolRepairCount += metricNumber(attempt, "llm_protocol_repair_count");
      }
      if (metricBoolean(attempt, "verifier_passed")) assistedVerifierPassedCount += 1;
      assistedLlmApiErrorCount += metricNumber(attempt, "llm_api_error_count");
      assistedLlmProtocolErrorCount += metricNumber(attempt, "llm_protocol_error_count");
      assistedLlmProtocolRepairCount += metricNumber(attempt, "llm_protocol_repair_count");
      assistedPolicyBlockRecoveryModeCount += metricNumber(attempt, "policy_block_recovery_mode_count");
      assistedPolicyBlockRecoveryProtocolErrorCount += metricNumber(attempt, "policy_block_recovery_protocol_error_count");
      assistedFailedToolCallCount += metricNumber(attempt, "retry_count");
      assistedVerifierCommandRunCount += metricNumber(attempt, "verifier_command_run_count");
      assistedCommandWriteCount += metricNumber(attempt, "command_write_count");
      assistedForbiddenFileWriteCount += metricNumber(attempt, "forbidden_file_writes");
      assistedWrongFileTouchCount += metricNumber(attempt, "wrong_file_touches");
      for (const category of metricStringList(attempt, "failure_categories")) {
        assistedCategories.add(category);
      }
    }

    byTask.push({
      task_id: asString(report.task_id),
      baseline_passed: metricBoolean(baseline, "verifier_passed"),
      assisted_passed: finalPassed,
      aionis_selected_attempt: selectedAttemptIndex >= 0 ? selectedAttemptIndex + 1 : null,
      aionis_selected_attempt_reason: asString(report.aionis_selected_attempt_reason),
      attempts_to_success: attemptsToSuccess,
      repaired_by_continuity: repairedByContinuity,
      repair_guidance_present: repairGuidancePresent,
      repair_guidance_used: repairGuidanceUsed,
      repair_guidance_succeeded: repairGuidanceSucceeded,
      verifier_failure_phase: verifierFailurePhase,
      prior_failure_categories: priorFailureCategories,
      repair_guidance_categories: repairCategories,
      repair_category_overlap: repairCategoryOverlap,
      repair_affected_files: repairAffectedFiles,
      assisted_touched_repair_files: assistedTouchedRepairFiles,
      assisted_edited_repair_files: assistedEditedRepairFiles,
      repair_commands: repairCommands,
      assisted_matched_repair_commands: assistedMatchedRepairCommands,
      first_action_sequence_present: firstActionSequencePresent,
      first_action_sequence_followed: metricsFromRun(finalAionis).first_action_sequence_followed ?? null,
      first_action_sequence_violation: firstActionSequenceViolation,
      first_action_sequence_clean_follow: metricsFromRun(finalAionis).first_action_sequence_clean_follow ?? null,
      first_action_sequence_policy_block_count: firstActionSequencePolicyBlocks,
      first_action_sequence_recovered: metricsFromRun(finalAionis).first_action_sequence_recovered ?? null,
      first_repair_file_write_step: metricNullableNumber(finalAionis, "first_repair_file_write_step"),
      pre_repair_write_broad_read_count: metricNumber(finalAionis, "pre_repair_write_broad_read_count"),
      repair_second_write_present: metricBoolean(finalAionis, "repair_second_write_present"),
      second_repair_file_write_step: metricNullableNumber(finalAionis, "second_repair_file_write_step"),
      post_first_repair_pre_second_broad_action_count: metricNumber(finalAionis, "post_first_repair_pre_second_broad_action_count"),
      action_synthesis_plan_present: metricBoolean(finalAionis, "action_synthesis_plan_present"),
      repair_action_compiler_present: metricBoolean(finalAionis, "repair_action_compiler_present"),
      cognitive_entropy_engine_present: metricBoolean(finalAionis, "cognitive_entropy_engine_present"),
      cognitive_entropy_counterfactual_probe_required: metricBoolean(finalAionis, "cognitive_entropy_counterfactual_probe_required"),
      cognitive_entropy_counterfactual_probe_attempted: metricBoolean(finalAionis, "cognitive_entropy_counterfactual_probe_attempted"),
      cognitive_entropy_counterfactual_probe_files: metricStringList(finalAionis, "cognitive_entropy_counterfactual_probe_files"),
      runtime_success_replay_present: runtimeSuccessReplayPresent,
      runtime_success_replay_attempted: runtimeSuccessReplayAttempted,
      runtime_success_replay_applied: metricsFromRun(finalAionis).runtime_success_replay_applied ?? null,
      runtime_success_replay_patch_count: metricNumber(finalAionis, "runtime_success_replay_patch_count"),
      runtime_success_replay_candidate_count: metricNumber(finalAionis, "runtime_success_replay_candidate_count"),
      runtime_success_replay_attempted_candidate_count: metricNumber(finalAionis, "runtime_success_replay_attempted_candidate_count"),
      runtime_success_replay_failed_candidate_count: metricNumber(finalAionis, "runtime_success_replay_failed_candidate_count"),
      runtime_success_replay_stale_candidate_count: metricNumber(finalAionis, "runtime_success_replay_stale_candidate_count"),
      runtime_success_replay_invalid_candidate_count: metricNumber(finalAionis, "runtime_success_replay_invalid_candidate_count"),
      runtime_success_replay_adapted_after_failure: runtimeSuccessReplayAdaptedAfterFailure,
      runtime_success_replay_adaptation_within_boundary: metricsFromRun(finalAionis).runtime_success_replay_adaptation_within_boundary ?? null,
      runtime_success_replay_adaptation_succeeded: runtimeSuccessReplayAdaptationSucceeded,
      runtime_success_replay_files: metricStringList(finalAionis, "runtime_success_replay_files"),
      runtime_success_replay_succeeded: runtimeSuccessReplaySucceeded,
      semantic_candidate_count: finalSemanticCandidates.length,
      semantic_repair_candidates: finalSemanticCandidates,
      runtime_maintenance_applied_count: runtimeMaintenanceApplied,
      runtime_maintenance_effect_summary: runtimeMaintenanceEffect ?? null,
      runtime_effect_posture: asString(runtimeEffectSummary?.measurable_effect_posture) ?? null,
      runtime_effect_baseline_comparison_required: runtimeEffectSummary?.baseline_comparison_required === true,
      runtime_effect_context_over_budget_count: numeric(runtimeEffectTokenContext?.over_budget_count),
      runtime_effect_workflow_reuse_success_count: numeric(runtimeEffectLearning?.workflow_reuse_success_count),
      runtime_effect_workflow_reuse_failure_count: numeric(runtimeEffectLearning?.workflow_reuse_failure_count),
      runtime_effect_verifier_success_count: numeric(runtimeEffectVerification?.verifier_success_count),
      runtime_effect_verifier_failure_count: numeric(runtimeEffectVerification?.verifier_failure_count),
      promotion_quality_invalidation_pressure: asString(promotionQualitySummary?.invalidation_pressure) ?? null,
      promotion_quality_recommended_learning_posture: asString(promotionQualitySummary?.recommended_learning_posture) ?? null,
      baseline_first_write_step: metricNullableNumber(baseline, "first_write_step"),
      assisted_first_write_step: metricNullableNumber(finalAionis, "first_write_step"),
      first_write_step_delta: firstWriteStepDelta,
      baseline_first_target_write_step: metricNullableNumber(baseline, "first_target_write_step"),
      assisted_first_target_write_step: metricNullableNumber(finalAionis, "first_target_write_step"),
      first_target_write_step_delta: firstTargetWriteStepDelta,
      first_write_latency_ms_delta: firstWriteLatencyDelta,
      first_target_write_latency_ms_delta: firstTargetWriteLatencyDelta,
      edit_boundary_respected:
        metricNumber(finalAionis, "forbidden_file_writes") === 0
        && metricNumber(finalAionis, "wrong_file_touches") === 0,
      observed_failure_categories: [...observedCategories].sort(),
      assisted_failure_categories: [...assistedCategories].sort(),
      assisted_command_write_files: metricStringList(finalAionis, "command_write_files"),
      assisted_llm_api_error_count: metricNumber(finalAionis, "llm_api_error_count"),
      assisted_llm_protocol_error_count: metricNumber(finalAionis, "llm_protocol_error_count"),
      assisted_llm_protocol_repair_count: metricNumber(finalAionis, "llm_protocol_repair_count"),
      policy_block_recovery_mode_count: metricNumber(finalAionis, "policy_block_recovery_mode_count"),
      policy_block_recovery_protocol_error_count: metricNumber(finalAionis, "policy_block_recovery_protocol_error_count"),
      assisted_llm_protocol_unrepaired_count: Math.max(
        0,
        metricNumber(finalAionis, "llm_protocol_error_count") - metricNumber(finalAionis, "llm_protocol_repair_count"),
      ),
      assisted_verifier_command_run_count: metricNumber(finalAionis, "verifier_command_run_count"),
      runtime_learning_quarantined_attempts: attempts
        .filter((attempt) => runtimeLearningQuarantineReasonFromRun(attempt))
        .map((attempt) => ({
          attempt: Number(attempt.attempt ?? 0) || null,
          reason: runtimeLearningQuarantineReasonFromRun(attempt),
          llm_api_error_count: metricNumber(attempt, "llm_api_error_count"),
          llm_protocol_error_count: metricNumber(attempt, "llm_protocol_error_count"),
        })),
    });
  }

  const learningSignals = uniqueStringValues([
    continuityRepairCount > 0 ? "failed_attempt_evidence_helped_later_attempt" : null,
    repairGuidanceUsedCount > 0 ? "failure_evidence_reused_by_assisted_run" : null,
    repairGuidanceSucceededCount > 0 ? "repair_guidance_led_to_verifier_pass" : null,
    verifierFailurePhaseCounts.size > 0 ? "verifier_failure_phase_classified" : null,
    verifierFailurePhaseCounts.has("hidden_contract_failure") ? "hidden_contract_failure_phase_observed" : null,
    verifierFailurePhaseCounts.has("lint_type_failure") ? "lint_type_failure_phase_observed" : null,
    verifierFailurePhaseCounts.has("provider_failure") ? "provider_failure_phase_observed" : null,
    firstActionSequenceFollowedCount > 0 ? "first_action_sequence_contract_followed" : null,
    firstActionSequenceViolatedCount > 0 ? "first_action_sequence_contract_not_followed" : null,
    firstActionSequenceCleanFollowCount > 0 ? "first_action_sequence_clean_follow_observed" : null,
    firstActionSequenceRecoveredCount > 0 ? "first_action_sequence_policy_recovered" : null,
    firstActionSequenceUnrecoveredCount > 0 ? "first_action_sequence_policy_unrecovered" : null,
    repairSecondWriteSatisfiedCount > 0 ? "repair_second_write_satisfied" : null,
    postFirstRepairPreSecondBroadActionCount > 0 ? "repair_second_write_runtime_recovered_broad_action" : null,
    actionSynthesisPlanPresentCount > 0 ? "action_synthesis_plan_visible" : null,
    repairActionCompilerPresentCount > 0 ? "repair_action_compiler_visible" : null,
    cognitiveEntropyEnginePresentCount > 0 ? "cognitive_entropy_engine_visible" : null,
    cognitiveEntropyCounterfactualProbeRequiredCount > 0 ? "cognitive_entropy_counterfactual_probe_required" : null,
    cognitiveEntropyCounterfactualProbeAttemptedCount > 0 ? "cognitive_entropy_counterfactual_probe_attempted" : null,
    runtimeSuccessReplayAppliedCount > 0 ? "runtime_success_replay_applied" : null,
    runtimeSuccessReplaySucceededCount > 0 ? "runtime_success_replay_led_to_verifier_pass" : null,
    runtimeSuccessReplayStaleCandidateCount > 0 ? "runtime_success_replay_stale_candidate_observed" : null,
    runtimeSuccessReplayInvalidCandidateCount > 0 ? "runtime_success_replay_invalid_candidate_observed" : null,
    runtimeSuccessReplayAdaptedAfterFailureCount > 0 ? "runtime_success_replay_adapted_after_failed_candidates" : null,
    runtimeSuccessReplayAdaptationSucceededCount > 0 ? "runtime_success_replay_failed_then_controlled_adaptation_passed" : null,
    (averageNumber(firstTargetWriteStepDeltas) ?? 0) > 0 ? "first_target_write_step_improved" : null,
    (averageNumber(firstTargetWriteLatencyDeltas) ?? 0) > 0 ? "first_target_write_latency_improved" : null,
    llmApiErrorCount > 0 ? "llm_api_errors_observed" : null,
    llmProtocolErrorCount > 0 ? "llm_tool_protocol_errors_observed" : null,
    llmProtocolRepairCount > 0 ? "llm_tool_protocol_repairs_observed" : null,
    policyBlockRecoveryModeCount > 0 ? "policy_block_recovery_mode_observed" : null,
    policyBlockRecoveryModeCount > 0 && policyBlockRecoveryProtocolErrorCount === 0
      ? "policy_block_recovery_without_protocol_errors_observed"
      : null,
    runtimeLearningQuarantineCount > 0 ? "runtime_learning_quarantine_observed" : null,
    assistedRuntimeLearningQuarantineCount > 0 ? "assisted_runtime_learning_quarantine_observed" : null,
    semanticCandidateProducedRunCount > 0 ? "llm_semantic_repair_candidates_produced" : null,
    semanticCandidateCount > 0 ? "runtime_adjudicated_semantic_candidates_visible" : null,
    runtimeMaintenanceRunCount > 0 ? "runtime_maintenance_closed_loop_observed" : null,
    runtimeMaintenanceAppliedCount > 0 ? "runtime_maintenance_applied_mutations" : null,
    runtimeMaintenanceWorkflowPromotionCount > 0 ? "runtime_maintenance_promoted_workflow_memory" : null,
    runtimeMaintenancePolicyRetirementCount > 0 ? "runtime_maintenance_retired_policy_memory" : null,
    runtimeMaintenanceMemoryDemotionCount > 0 || runtimeMaintenanceMemoryArchiveCount > 0
      ? "runtime_maintenance_controlled_forgetting_applied"
      : null,
    runtimeMaintenanceUsageCountTotal > 0 || runtimeMaintenanceReuseSuccessTotal > 0
      ? "runtime_maintenance_reuse_signals_reported"
      : null,
    runtimeEffectSummaryCount > 0 ? "runtime_effect_summary_reported" : null,
    runtimeEffectBaselineComparisonRequiredCount > 0 ? "runtime_effect_requires_baseline_comparison" : null,
    (runtimeEffectPostureCounts.get("positive") ?? 0) > 0 ? "runtime_effect_positive_posture_observed" : null,
    (runtimeEffectPostureCounts.get("constrained") ?? 0) + (runtimeEffectPostureCounts.get("blocked") ?? 0) > 0
      ? "runtime_effect_constrained_or_blocked_observed"
      : null,
    promotionQualitySummaryCount > 0 ? "promotion_quality_summary_reported" : null,
    (promotionInvalidationPressureCounts.get("high") ?? 0) > 0
      ? "promotion_quality_high_invalidation_pressure_observed"
      : null,
    commandWriteCount > 0 ? "run_command_write_tracking_observed" : null,
    assistedForbiddenFileWriteCount === 0 && assistedWrongFileTouchCount === 0
      ? "edit_boundary_respected_in_assisted_runs"
      : null,
    [...categoryCounts.keys()].includes("lint_or_format_failure") ? "format_repair_guidance_needed" : null,
    [...categoryCounts.keys()].includes("type_contract_failure") ? "type_surface_repair_guidance_needed" : null,
    [...categoryCounts.keys()].includes("test_assertion_failure") ? "test_contract_repair_guidance_needed" : null,
  ].filter((value): value is string => !!value), 32);

  return {
    diagnostics_version: "aionis_real_llm_learning_diagnostics_v1",
    run_count: runCount,
    assisted_run_count: assistedRunCount,
    verifier_passed_count: verifierPassedCount,
    assisted_verifier_passed_count: assistedVerifierPassedCount,
    llm_api_error_count: llmApiErrorCount,
    assisted_llm_api_error_count: assistedLlmApiErrorCount,
    llm_api_error_rate_per_run: runCount > 0 ? llmApiErrorCount / runCount : null,
    assisted_llm_api_error_rate_per_run: assistedRunCount > 0 ? assistedLlmApiErrorCount / assistedRunCount : null,
    llm_protocol_error_count: llmProtocolErrorCount,
    llm_protocol_unrepaired_count: Math.max(0, llmProtocolErrorCount - llmProtocolRepairCount),
    assisted_llm_protocol_error_count: assistedLlmProtocolErrorCount,
    assisted_llm_protocol_unrepaired_count: Math.max(0, assistedLlmProtocolErrorCount - assistedLlmProtocolRepairCount),
    llm_protocol_error_rate_per_run: runCount > 0 ? llmProtocolErrorCount / runCount : null,
    assisted_llm_protocol_error_rate_per_run: assistedRunCount > 0 ? assistedLlmProtocolErrorCount / assistedRunCount : null,
    assisted_completed_run_count: assistedCompletedRunCount,
    assisted_completed_llm_protocol_error_count: assistedCompletedLlmProtocolErrorCount,
    assisted_completed_llm_protocol_unrepaired_count: Math.max(
      0,
      assistedCompletedLlmProtocolErrorCount - assistedCompletedLlmProtocolRepairCount,
    ),
    assisted_completed_llm_protocol_error_rate_per_run: assistedCompletedRunCount > 0 ? assistedCompletedLlmProtocolErrorCount / assistedCompletedRunCount : null,
    llm_protocol_repair_count: llmProtocolRepairCount,
    assisted_llm_protocol_repair_count: assistedLlmProtocolRepairCount,
    policy_block_recovery_mode_count: policyBlockRecoveryModeCount,
    policy_block_recovery_protocol_error_count: policyBlockRecoveryProtocolErrorCount,
    assisted_policy_block_recovery_mode_count: assistedPolicyBlockRecoveryModeCount,
    assisted_policy_block_recovery_protocol_error_count: assistedPolicyBlockRecoveryProtocolErrorCount,
    llm_protocol_repair_rate_per_error: llmProtocolErrorCount > 0 ? llmProtocolRepairCount / llmProtocolErrorCount : null,
    assisted_llm_protocol_repair_rate_per_error: assistedLlmProtocolErrorCount > 0 ? assistedLlmProtocolRepairCount / assistedLlmProtocolErrorCount : null,
    assisted_completed_llm_protocol_repair_count: assistedCompletedLlmProtocolRepairCount,
    assisted_completed_llm_protocol_repair_rate_per_error: assistedCompletedLlmProtocolErrorCount > 0 ? assistedCompletedLlmProtocolRepairCount / assistedCompletedLlmProtocolErrorCount : null,
    runtime_learning_quarantine_count: runtimeLearningQuarantineCount,
    assisted_runtime_learning_quarantine_count: assistedRuntimeLearningQuarantineCount,
    runtime_learning_quarantine_reasons: countsObject(runtimeLearningQuarantineReasons),
    semantic_candidate_producer_run_count: semanticCandidateProducerRunCount,
    semantic_candidate_produced_run_count: semanticCandidateProducedRunCount,
    semantic_candidate_count: semanticCandidateCount,
    semantic_candidate_rejected_run_count: semanticCandidateRejectedRunCount,
    semantic_candidate_provider_failure_count: semanticCandidateProviderFailureCount,
    semantic_candidate_protocol_failure_count: semanticCandidateProtocolFailureCount,
    runtime_maintenance_run_count: runtimeMaintenanceRunCount,
    runtime_maintenance_applied_count: runtimeMaintenanceAppliedCount,
    runtime_maintenance_workflow_promotion_count: runtimeMaintenanceWorkflowPromotionCount,
    runtime_maintenance_policy_retirement_count: runtimeMaintenancePolicyRetirementCount,
    runtime_maintenance_memory_demotion_count: runtimeMaintenanceMemoryDemotionCount,
    runtime_maintenance_memory_archive_count: runtimeMaintenanceMemoryArchiveCount,
    runtime_maintenance_hot_visibility_delta: runtimeMaintenanceHotVisibilityDelta,
    runtime_maintenance_archive_visibility_delta: runtimeMaintenanceArchiveVisibilityDelta,
    runtime_maintenance_feedback_positive_total: runtimeMaintenanceFeedbackPositiveTotal,
    runtime_maintenance_feedback_negative_total: runtimeMaintenanceFeedbackNegativeTotal,
    runtime_maintenance_usage_count_total: runtimeMaintenanceUsageCountTotal,
    runtime_maintenance_reuse_success_total: runtimeMaintenanceReuseSuccessTotal,
    runtime_maintenance_reuse_failure_total: runtimeMaintenanceReuseFailureTotal,
    runtime_effect_summary_count: runtimeEffectSummaryCount,
    runtime_effect_baseline_comparison_required_count: runtimeEffectBaselineComparisonRequiredCount,
    runtime_effect_posture_counts: countsObject(runtimeEffectPostureCounts),
    runtime_effect_context_over_budget_count: runtimeEffectContextOverBudgetCount,
    runtime_effect_context_items_reduced_count: runtimeEffectContextItemsReducedCount,
    runtime_effect_repeated_discovery_count: runtimeEffectRepeatedDiscoveryCount,
    runtime_effect_repeated_failed_action_count: runtimeEffectRepeatedFailedActionCount,
    runtime_effect_workflow_reuse_success_count: runtimeEffectWorkflowReuseSuccessCount,
    runtime_effect_workflow_reuse_failure_count: runtimeEffectWorkflowReuseFailureCount,
    runtime_effect_verifier_success_count: runtimeEffectVerifierSuccessCount,
    runtime_effect_verifier_failure_count: runtimeEffectVerifierFailureCount,
    runtime_effect_provider_quarantine_count: runtimeEffectProviderQuarantineCount,
    promotion_quality_summary_count: promotionQualitySummaryCount,
    promotion_invalidation_pressure_counts: countsObject(promotionInvalidationPressureCounts),
    failed_tool_call_count: failedToolCallCount,
    assisted_failed_tool_call_count: assistedFailedToolCallCount,
    verifier_command_run_count: verifierCommandRunCount,
    assisted_verifier_command_run_count: assistedVerifierCommandRunCount,
    command_write_count: commandWriteCount,
    assisted_command_write_count: assistedCommandWriteCount,
    forbidden_file_write_count: forbiddenFileWriteCount,
    assisted_forbidden_file_write_count: assistedForbiddenFileWriteCount,
    wrong_file_touch_count: wrongFileTouchCount,
    assisted_wrong_file_touch_count: assistedWrongFileTouchCount,
    continuity_repair_count: continuityRepairCount,
    repair_guidance_present_count: repairGuidancePresentCount,
    repair_guidance_used_count: repairGuidanceUsedCount,
    repair_guidance_succeeded_count: repairGuidanceSucceededCount,
    repair_command_rerun_count: repairCommandRerunCount,
    repair_affected_file_edit_count: repairAffectedFileEditCount,
    first_action_sequence_present_count: firstActionSequencePresentCount,
    first_action_sequence_followed_count: firstActionSequenceFollowedCount,
    first_action_sequence_violated_count: firstActionSequenceViolatedCount,
    first_action_sequence_clean_follow_count: firstActionSequenceCleanFollowCount,
    first_action_sequence_policy_block_count: firstActionSequencePolicyBlockCount,
    first_action_sequence_recovered_count: firstActionSequenceRecoveredCount,
    first_action_sequence_unrecovered_count: firstActionSequenceUnrecoveredCount,
    pre_repair_write_broad_read_count: preRepairWriteBroadReadCount,
    repair_second_write_present_count: repairSecondWritePresentCount,
    repair_second_write_satisfied_count: repairSecondWriteSatisfiedCount,
    post_first_repair_pre_second_broad_action_count: postFirstRepairPreSecondBroadActionCount,
    action_synthesis_plan_present_count: actionSynthesisPlanPresentCount,
    repair_action_compiler_present_count: repairActionCompilerPresentCount,
    cognitive_entropy_engine_present_count: cognitiveEntropyEnginePresentCount,
    cognitive_entropy_counterfactual_probe_required_count: cognitiveEntropyCounterfactualProbeRequiredCount,
    cognitive_entropy_counterfactual_probe_attempted_count: cognitiveEntropyCounterfactualProbeAttemptedCount,
    runtime_success_replay_present_count: runtimeSuccessReplayPresentCount,
    runtime_success_replay_attempted_count: runtimeSuccessReplayAttemptedCount,
    runtime_success_replay_applied_count: runtimeSuccessReplayAppliedCount,
    runtime_success_replay_succeeded_count: runtimeSuccessReplaySucceededCount,
    runtime_success_replay_failed_candidate_count: runtimeSuccessReplayFailedCandidateCount,
    runtime_success_replay_stale_candidate_count: runtimeSuccessReplayStaleCandidateCount,
    runtime_success_replay_invalid_candidate_count: runtimeSuccessReplayInvalidCandidateCount,
    runtime_success_replay_adapted_after_failure_count: runtimeSuccessReplayAdaptedAfterFailureCount,
    runtime_success_replay_adaptation_within_boundary_count: runtimeSuccessReplayAdaptationWithinBoundaryCount,
    runtime_success_replay_adaptation_succeeded_count: runtimeSuccessReplayAdaptationSucceededCount,
    average_first_write_step_delta: averageNumber(firstWriteStepDeltas),
    average_first_target_write_step_delta: averageNumber(firstTargetWriteStepDeltas),
    average_first_write_latency_ms_delta: averageNumber(firstWriteLatencyDeltas),
    average_first_target_write_latency_ms_delta: averageNumber(firstTargetWriteLatencyDeltas),
    failure_category_counts: countsObject(categoryCounts),
    verifier_failure_phase_counts: countsObject(verifierFailurePhaseCounts),
    learning_signals: learningSignals,
    by_task: byTask,
  };
}

async function runSuite(args: {
  suite: EvalSuite;
  provider: RealLlmProviderConfig;
  runtime: RuntimeHandle;
  outDir: string;
  progress: EvalProgressLogger;
  priorTaskReports?: Map<string, JsonObject>;
  priorReportFile?: string | null;
  workspaceRefOverride?: string | null;
  runMode?: SuiteRunMode;
  aionisPriorEvidenceMode?: AionisPriorEvidenceMode;
}): Promise<JsonObject> {
  const taskReports: JsonObject[] = [];
  const runMode: SuiteRunMode = args.runMode
    ?? (args.priorTaskReports ? "aionis_only_prior_report" : "full_seed_baseline_aionis");
  const aionisPriorEvidenceMode = args.aionisPriorEvidenceMode ?? "all";
  args.progress.emit("suite_start", {
    suite_id: args.suite.suite_id,
    task_count: args.suite.tasks.length,
    provider: args.provider.provider,
    model: args.provider.model,
    openai_json_mode: args.provider.openAiJsonMode,
    request_timeout_ms: args.provider.timeoutMs,
    step_timeout_ms: args.provider.stepTimeoutMs,
    max_retries: args.provider.maxRetries,
    max_protocol_exhausted_steps: args.provider.maxProtocolExhaustedSteps,
    runtime_url: args.runtime.baseUrl,
    run_mode: runMode,
    aionis_prior_evidence_mode: aionisPriorEvidenceMode,
    prior_report_file: args.priorReportFile ?? null,
    workspace_ref_override: args.workspaceRefOverride ?? null,
  });
  for (const [taskIndex, task] of args.suite.tasks.entries()) {
    args.progress.emit("task_start", {
      suite_id: args.suite.suite_id,
      task_id: task.id,
      task_index: taskIndex + 1,
      task_count: args.suite.tasks.length,
      title: task.title ?? task.id,
    });
    const priorTaskReport = args.priorTaskReports?.get(task.id);
    let seed: AgentRun;
    let baseline: AgentRun;
    let seedPersistence: JsonObject;
    let baselinePersistence: JsonObject;
    let loadedPriorRuns: AgentRun[] | null = null;
    if (priorTaskReport) {
      loadedPriorRuns = priorRunsForTaskReport(priorTaskReport);
      seed = loadedPriorRuns[0] as AgentRun;
      baseline = loadedPriorRuns[1] as AgentRun;
      seedPersistence = {
        loaded_from_prior_report: true,
        prior_report_file: args.priorReportFile ?? null,
        run_id: seed.run_id,
        status: seed.status,
      };
      baselinePersistence = {
        loaded_from_prior_report: true,
        prior_report_file: args.priorReportFile ?? null,
        run_id: baseline.run_id,
        status: baseline.status,
      };
      args.progress.emit("prior_report_loaded", {
        task_id: task.id,
        prior_report_file: args.priorReportFile ?? null,
        prior_run_count: loadedPriorRuns.length,
        prior_success_count: loadedPriorRuns.filter((run) => run.metrics.verifier_passed).length,
        seed_status: seed.status,
        baseline_status: baseline.status,
      });
    } else {
      const seedWorkspace = await prepareWorkspace(task, "seed", args.outDir);
      args.progress.emit("workspace_ready", {
        task_id: task.id,
        arm: "seed",
        workspace_dir: seedWorkspace,
      });
      seed = await runAgent({
        provider: args.provider,
        task,
        arm: "seed",
        workspaceDir: seedWorkspace,
        aionisContext: null,
        progress: args.progress,
      });
      args.progress.emit("persistence_start", {
        task_id: task.id,
        arm: "seed",
        run_id: seed.run_id,
        status: seed.status,
        runtime_learning_quarantine_reason: runtimeLearningQuarantineReasonFromRun(seed),
      });
      seedPersistence = await storeAionisOutcome({
        baseUrl: args.runtime.baseUrl,
        task,
        run: seed,
      });
      args.progress.emit("persistence_end", {
        task_id: task.id,
        arm: "seed",
        run_id: seed.run_id,
        status: seed.status,
        runtime_learning_quarantine_reason: runtimeLearningQuarantineReasonFromRun(seed),
      });

      const baselineWorkspace = await prepareWorkspace(task, "baseline", args.outDir);
      args.progress.emit("workspace_ready", {
        task_id: task.id,
        arm: "baseline",
        workspace_dir: baselineWorkspace,
      });
      baseline = await runAgent({
        provider: args.provider,
        task,
        arm: "baseline",
        workspaceDir: baselineWorkspace,
        aionisContext: null,
        progress: args.progress,
      });
      args.progress.emit("persistence_start", {
        task_id: task.id,
        arm: "baseline",
        run_id: baseline.run_id,
        status: baseline.status,
        runtime_learning_quarantine_reason: runtimeLearningQuarantineReasonFromRun(baseline),
      });
      baselinePersistence = await storeAionisOutcome({
        baseUrl: args.runtime.baseUrl,
        task,
        run: baseline,
      });
      args.progress.emit("persistence_end", {
        task_id: task.id,
        arm: "baseline",
        run_id: baseline.run_id,
        status: baseline.status,
        runtime_learning_quarantine_reason: runtimeLearningQuarantineReasonFromRun(baseline),
      });
    }

    const aionisAttempts: AgentRun[] = [];
    const aionisPersistences: JsonObject[] = [];
    const priorRunsForAionis: AgentRun[] = filterAionisPriorRuns(
      loadedPriorRuns ?? [seed, baseline],
      aionisPriorEvidenceMode,
    );
    const maxAionisAttempts = task.aionis_attempts ?? 1;
    for (let attempt = 1; attempt <= maxAionisAttempts; attempt += 1) {
      const assistedWorkspace = await prepareWorkspace(
        task,
        maxAionisAttempts === 1 ? "aionis" : `aionis-attempt-${attempt}`,
        args.outDir,
      );
      args.progress.emit("workspace_ready", {
        task_id: task.id,
        arm: "aionis",
        attempt,
        workspace_dir: assistedWorkspace,
      });
      args.progress.emit("aionis_context_start", {
        task_id: task.id,
        arm: "aionis",
        attempt,
        prior_run_count: priorRunsForAionis.length,
        failed_prior_run_count: priorRunsForAionis.filter((run) => !run.metrics.verifier_passed).length,
        aionis_prior_evidence_mode: aionisPriorEvidenceMode,
      });
      const aionisContext = await buildAionisContext({
        baseUrl: args.runtime.baseUrl,
        task,
        runId: `${task.id}-aionis-context-attempt-${attempt}-${crypto.randomUUID()}`,
        priorRuns: priorRunsForAionis,
      });
      args.progress.emit("aionis_context_end", {
        task_id: task.id,
        arm: "aionis",
        attempt,
        has_kickoff: !!asObject(aionisContext.kickoff),
        has_planning: !!asObject(aionisContext.planning),
        has_assembly: !!asObject(aionisContext.assembly),
      });
      const aionisAttempt = await runAgent({
        provider: args.provider,
        task,
        arm: "aionis",
        workspaceDir: assistedWorkspace,
        aionisContext,
        progress: args.progress,
        attempt,
      });
      const quarantineReason = runtimeLearningQuarantineReasonFromRun(aionisAttempt);
      args.progress.emit("persistence_start", {
        task_id: task.id,
        arm: "aionis",
        attempt,
        run_id: aionisAttempt.run_id,
        status: aionisAttempt.status,
        runtime_learning_quarantine_reason: quarantineReason,
      });
      const aionisPersistence = await storeAionisOutcome({
        baseUrl: args.runtime.baseUrl,
        task,
        run: aionisAttempt,
      });
      args.progress.emit("persistence_end", {
        task_id: task.id,
        arm: "aionis",
        attempt,
        run_id: aionisAttempt.run_id,
        status: aionisAttempt.status,
        runtime_learning_quarantine_reason: quarantineReason,
      });
      aionisAttempts.push(aionisAttempt);
      aionisPersistences.push(aionisPersistence);
      if (aionisAttempt.metrics.verifier_passed) break;
      if (!quarantineReason) {
        priorRunsForAionis.push(aionisAttempt);
      } else {
        args.progress.emit("aionis_prior_evidence_quarantined", {
          task_id: task.id,
          arm: "aionis",
          attempt,
          run_id: aionisAttempt.run_id,
          runtime_learning_quarantine_reason: quarantineReason,
        });
        if (stopsFurtherAionisAttempts(quarantineReason)) {
          args.progress.emit("aionis_attempts_stopped_for_quarantine", {
            task_id: task.id,
            arm: "aionis",
            attempt,
            run_id: aionisAttempt.run_id,
            max_aionis_attempts: maxAionisAttempts,
            runtime_learning_quarantine_reason: quarantineReason,
          });
          break;
        }
      }
    }
    const selectedAionisAttempt = representativeAionisAttempt(aionisAttempts);
    if (!selectedAionisAttempt) throw new Error(`task ${task.id} did not produce an Aionis attempt`);
    const aionis = selectedAionisAttempt.run;
    const aionisPersistence = aionisPersistences[selectedAionisAttempt.index] ?? {};
    args.progress.emit("runtime_maintenance_start", {
      suite_id: args.suite.suite_id,
      task_id: task.id,
      scope: `real-llm-eval:${task.id}`,
    });
    const runtimeMaintenance = await runTaskRuntimeMaintenance({
      baseUrl: args.runtime.baseUrl,
      task,
    });
    args.progress.emit("runtime_maintenance_end", {
      suite_id: args.suite.suite_id,
      task_id: task.id,
      applied_count: numeric(runtimeMaintenance.applied_count),
      effect_summary: asObject(runtimeMaintenance.effect_summary) ?? {},
    });

    taskReports.push({
      task_id: task.id,
      title: task.title ?? task.id,
      run_mode: priorTaskReport ? runMode : "full_seed_baseline_aionis",
      aionis_prior_evidence_mode: aionisPriorEvidenceMode,
      workspace_ref: task.workspace.source === "git" ? task.workspace.ref : null,
      ...(args.workspaceRefOverride ? { workspace_ref_override: args.workspaceRefOverride } : {}),
      ...(priorTaskReport
        ? {
            prior_report_file: args.priorReportFile ?? null,
            prior_report_run_count: loadedPriorRuns?.length ?? 0,
            prior_report_success_count: (loadedPriorRuns ?? []).filter((run) => run.metrics.verifier_passed).length,
          }
        : {}),
      seed,
      baseline,
      aionis,
      aionis_attempts: aionisAttempts,
      aionis_selected_attempt: selectedAionisAttempt.index + 1,
      aionis_selected_attempt_reason: selectedAionisAttempt.reason,
      comparison: compareRuns(baseline, aionis),
      runtime_maintenance: runtimeMaintenance,
      aionis_persistence: {
        seed: seedPersistence,
        baseline: baselinePersistence,
        assisted: aionisPersistence,
        assisted_attempts: aionisPersistences,
      },
    });
    args.progress.emit("task_end", {
      suite_id: args.suite.suite_id,
      task_id: task.id,
      status: aionis.status,
      assisted_verifier_passed: aionis.metrics.verifier_passed,
      aionis_attempt_count: aionisAttempts.length,
      aionis_selected_attempt: selectedAionisAttempt.index + 1,
      aionis_selected_attempt_reason: selectedAionisAttempt.reason,
      comparison: compareRuns(baseline, aionis),
    });
  }
  const summary = buildSuiteSummary(taskReports);
  const effectGate = evaluateEffectGate({
    suite: args.suite,
    taskReports,
    summary,
  });
  const learningDiagnostics = buildLearningDiagnostics(taskReports, args.suite);
  args.progress.emit("suite_end", {
    suite_id: args.suite.suite_id,
    status: effectGate.status,
    failed_checks: effectGate.failed_checks,
    summary,
    learning_diagnostics: learningDiagnostics,
  });
  return {
    report_version: REPORT_VERSION,
    layer_boundary: REAL_EVAL_LAYER_BOUNDARY,
    suite_id: args.suite.suite_id,
    run_mode: runMode,
    aionis_prior_evidence_mode: aionisPriorEvidenceMode,
    ...(args.priorReportFile ? { prior_report_file: args.priorReportFile } : {}),
    ...(args.workspaceRefOverride ? { workspace_ref_override: args.workspaceRefOverride } : {}),
    generated_at: new Date().toISOString(),
    llm: {
      provider: args.provider.provider,
      base_url: args.provider.baseUrl,
      model: args.provider.model,
      request_timeout_ms: args.provider.timeoutMs,
      step_timeout_ms: args.provider.stepTimeoutMs,
      max_retries: args.provider.maxRetries,
      protocol_retries: args.provider.protocolRetries,
      max_protocol_exhausted_steps: args.provider.maxProtocolExhaustedSteps,
      openai_json_mode: args.provider.openAiJsonMode,
      openai_extra_body_present: !!args.provider.openAiExtraBody,
      api_key_present: true,
    },
    runtime: {
      base_url: args.runtime.baseUrl,
      health: await getRuntime(args.runtime.baseUrl, "/health"),
    },
    summary,
    effect_gate: effectGate,
    learning_diagnostics: learningDiagnostics,
    tasks: taskReports,
  };
}

async function rescoreReport(args: {
  suite: EvalSuite;
  reportFile: string;
  outDir: string;
}): Promise<{ report: JsonObject; reportFile: string }> {
  const priorReport = await readJsonFile<JsonObject>(args.reportFile);
  const rawTaskReports = Array.isArray(priorReport.tasks)
    ? priorReport.tasks.map((task) => asObject(task)).filter((task): task is JsonObject => !!task)
    : [];
  if (rawTaskReports.length === 0) throw new Error("--rescore-report input must contain a non-empty tasks array from a real eval report");
  const suiteTaskIds = new Set(args.suite.tasks.map((task) => task.id));
  const unknownTaskIds = rawTaskReports
    .map((task) => asString(task.task_id))
    .filter((taskId): taskId is string => !!taskId && !suiteTaskIds.has(taskId));
  if (unknownTaskIds.length > 0) {
    throw new Error(`--rescore-report contains task ids not present in the selected suite: ${uniqueStringValues(unknownTaskIds, 16).join(", ")}`);
  }
  const taskReports = rawTaskReports.map((taskReport) => recomputeTaskReportMetricsFromTrace(args.suite, taskReport));
  const summary = buildSuiteSummary(taskReports);
  const effectGate = evaluateEffectGate({
    suite: args.suite,
    taskReports,
    summary,
  });
  const learningDiagnostics = buildLearningDiagnostics(taskReports, args.suite);
  const report: JsonObject = {
    ...priorReport,
    report_version: REPORT_VERSION,
    layer_boundary: REAL_EVAL_LAYER_BOUNDARY,
    rescored_from_report_file: args.reportFile,
    rescored_at: new Date().toISOString(),
    suite_id: args.suite.suite_id,
    summary,
    effect_gate: effectGate,
    learning_diagnostics: learningDiagnostics,
    tasks: taskReports,
  };
  const defaultReportFile = path.join(path.dirname(args.reportFile), "real-llm-eval-report.rescored.json");
  const targetReportFile = args.outDir === path.dirname(args.reportFile)
    ? defaultReportFile
    : path.join(args.outDir, "real-llm-eval-report.rescored.json");
  await fsp.mkdir(path.dirname(targetReportFile), { recursive: true });
  await fsp.writeFile(targetReportFile, JSON.stringify(report, null, 2), "utf8");
  return { report, reportFile: targetReportFile };
}

function compactTaskOutcomes(report: JsonObject): JsonObject[] {
  const diagnosticsByTask = new Map<string, JsonObject>();
  for (const diagnostic of jsonObjectList(asObject(report.learning_diagnostics)?.by_task)) {
    const taskId = asString(diagnostic.task_id);
    if (taskId) diagnosticsByTask.set(taskId, diagnostic);
  }
  return jsonObjectList(report.tasks).map((taskReport) => {
    const taskId = asString(taskReport.task_id) ?? null;
    const attempts = jsonObjectList(taskReport.aionis_attempts);
    const aionis = asObject(taskReport.aionis);
    const maintenanceEffect = asObject(asObject(taskReport.runtime_maintenance)?.effect_summary);
    const runtimeEffect = runtimeEffectSummaryFromTaskReport(taskReport);
    const runtimeEffectTokenContext = asObject(runtimeEffect?.token_context);
    const promotionQuality = promotionQualitySummaryFromTaskReport(taskReport);
    const diagnostic = taskId ? diagnosticsByTask.get(taskId) : undefined;
    const verifierFailurePhase = asObject(diagnostic?.verifier_failure_phase);
    const lineHints = jsonObjectList(verifierFailurePhase?.line_hints)
      .map((hint) => ({
        path: asString(hint.path) ?? null,
        line: typeof hint.line === "number" ? hint.line : null,
        column: typeof hint.column === "number" ? hint.column : null,
      }))
      .filter((hint) => !!hint.path)
      .slice(0, 4);
    return {
      task_id: taskId,
      aionis_selected_attempt: numeric(taskReport.aionis_selected_attempt) > 0
        ? numeric(taskReport.aionis_selected_attempt)
        : null,
      aionis_selected_attempt_reason: asString(taskReport.aionis_selected_attempt_reason) ?? null,
      assisted_status: asString(aionis?.status) ?? null,
      assisted_passed: metricBoolean(aionis, "verifier_passed"),
      verifier_failure_phase: asString(verifierFailurePhase?.phase) ?? null,
      verifier_failure_primary_files: stringList(verifierFailurePhase?.primary_files),
      verifier_failure_line_hints: lineHints,
      runtime_maintenance: maintenanceEffect || runtimeEffect || promotionQuality
        ? {
            applied_count: numeric(asObject(taskReport.runtime_maintenance)?.applied_count),
            workflow_promotions: numeric(maintenanceEffect?.workflow_promotions),
            policy_retirements: numeric(maintenanceEffect?.policy_retirements),
            memory_demotions: numeric(maintenanceEffect?.memory_demotions),
            memory_archives: numeric(maintenanceEffect?.memory_archives),
            hot_visibility_delta: numeric(maintenanceEffect?.hot_visibility_delta),
            archive_visibility_delta: numeric(maintenanceEffect?.archive_visibility_delta),
            runtime_effect_posture: asString(runtimeEffect?.measurable_effect_posture) ?? null,
            runtime_effect_baseline_comparison_required: runtimeEffect?.baseline_comparison_required === true,
            runtime_effect_context_over_budget_count: numeric(runtimeEffectTokenContext?.over_budget_count),
            promotion_invalidation_pressure: asString(promotionQuality?.invalidation_pressure) ?? null,
            promotion_recommended_learning_posture: asString(promotionQuality?.recommended_learning_posture) ?? null,
          }
        : null,
      runtime_learning_quarantined_attempts: attempts
        .flatMap((attempt, index): JsonObject[] => {
          const reason = runtimeLearningQuarantineReasonFromRun(attempt);
          return reason
            ? [{
                attempt: index + 1,
                reason,
                llm_api_error_count: metricNumber(attempt, "llm_api_error_count"),
                llm_protocol_error_count: metricNumber(attempt, "llm_protocol_error_count"),
                edited_files: metricStringList(attempt, "edited_files"),
              }]
            : [];
        }),
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const suitePath = typeof args.suite === "string" ? path.resolve(process.cwd(), args.suite) : "";
  if (!suitePath) throw new Error("--suite is required; real evaluation requires an explicit task suite");
  const outDir = path.resolve(
    process.cwd(),
    typeof args.out === "string" ? args.out : path.join(".tmp", "real-llm-eval", new Date().toISOString().replace(/[:.]/g, "-")),
  );
  await fsp.mkdir(outDir, { recursive: true });
  const progress = createProgressLogger({
    outDir,
    quiet: args["quiet-progress"] === true || process.env.AIONIS_REAL_LLM_PROGRESS === "0",
  });
  const workspaceRefOverride = typeof args["workspace-ref-override"] === "string"
    ? args["workspace-ref-override"]
    : null;
  const expectStaleSuccessReplay = args["expect-stale-success-replay"] === true;
  const aionisPriorEvidenceMode = resolveAionisPriorEvidenceMode(args["aionis-prior-evidence"]);
  progress.emit("runner_start", {
    suite_path: suitePath,
    out_dir: outDir,
    task_filter: typeof args.task === "string" ? args.task : null,
    aionis_only_prior_report: typeof args["aionis-only-prior-report"] === "string" ? args["aionis-only-prior-report"] : null,
    workspace_ref_override: workspaceRefOverride,
    expect_stale_success_replay: expectStaleSuccessReplay,
    aionis_prior_evidence_mode: aionisPriorEvidenceMode,
  });
  const suite = suiteWithWorkspaceRefOverride(
    selectSuiteTasks(
      await readJsonFile<EvalSuite>(suitePath),
      typeof args.task === "string" ? args.task : undefined,
    ),
    workspaceRefOverride,
  );
  validateSuite(suite);
  const priorReportFile = typeof args["aionis-only-prior-report"] === "string"
    ? path.resolve(process.cwd(), args["aionis-only-prior-report"])
    : null;
  const priorTaskReports = priorReportFile
    ? priorTaskReportsByIdFromReport(await readJsonFile<JsonObject>(priorReportFile), priorReportFile, suite)
    : undefined;
  if (typeof args["rescore-report"] === "string") {
    const sourceReportFile = path.resolve(process.cwd(), args["rescore-report"]);
    const { report, reportFile } = await rescoreReport({
      suite,
      reportFile: sourceReportFile,
      outDir,
    });
    const effectGate = asObject(report.effect_gate);
    const effectGateStatus = asString(effectGate?.status) ?? "fail";
    progress.emit("report_rescored", {
      suite_id: suite.suite_id,
      status: effectGateStatus,
      report_file: reportFile,
      source_report_file: sourceReportFile,
    });
    console.log(JSON.stringify({
      ok: effectGateStatus === "pass",
      report_version: REPORT_VERSION,
      layer_boundary: REAL_EVAL_LAYER_BOUNDARY,
      suite_id: suite.suite_id,
      run_mode: asString(report.run_mode) ?? "full_seed_baseline_aionis",
      aionis_prior_evidence_mode: asString(report.aionis_prior_evidence_mode) ?? aionisPriorEvidenceMode,
      prior_report_file: asString(report.prior_report_file) ?? null,
      report_file: reportFile,
      source_report_file: sourceReportFile,
      task_count: suite.tasks.length,
      effect_gate_status: effectGateStatus,
      effect_status: asString(effectGate?.effect_status) ?? effectGateStatus,
      provider_health_status: asString(effectGate?.provider_health_status) ?? effectGateStatus,
      failed_checks: Array.isArray(effectGate?.failed_checks) ? effectGate.failed_checks : [],
      failed_effect_checks: Array.isArray(effectGate?.failed_effect_checks) ? effectGate.failed_effect_checks : [],
      failed_provider_health_checks: Array.isArray(effectGate?.failed_provider_health_checks) ? effectGate.failed_provider_health_checks : [],
      task_outcomes: compactTaskOutcomes(report),
    }, null, 2));
    if (effectGateStatus !== "pass") {
      process.exitCode = 1;
    }
    return;
  }
  const provider = resolveProviderConfig();
  const providerPreflight = args["skip-provider-preflight"] === true
    ? {
        status: "skipped",
        provider: provider.provider,
        base_url: provider.baseUrl,
        model: provider.model,
        reason: "--skip-provider-preflight",
      }
    : await runProviderPreflight(provider, progress);
  if (asString(providerPreflight.status) === "fail") {
    console.log(JSON.stringify({
      ok: false,
      report_version: REPORT_VERSION,
      layer_boundary: REAL_EVAL_LAYER_BOUNDARY,
      suite_id: suite.suite_id,
      run_mode: priorTaskReports
        ? expectStaleSuccessReplay
          ? "aionis_only_prior_report_stale_replay"
          : "aionis_only_prior_report"
        : "full_seed_baseline_aionis",
      provider: provider.provider,
      model: provider.model,
      provider_preflight: providerPreflight,
      effect_gate_status: "fail",
      effect_status: "not_run",
      provider_health_status: "fail",
      failed_checks: ["provider_preflight"],
      failed_effect_checks: [],
      failed_provider_health_checks: ["provider_preflight"],
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (args["provider-preflight-only"] === true) {
    console.log(JSON.stringify({
      ok: true,
      report_version: REPORT_VERSION,
      layer_boundary: REAL_EVAL_LAYER_BOUNDARY,
      suite_id: suite.suite_id,
      provider: provider.provider,
      model: provider.model,
      provider_preflight: providerPreflight,
      effect_gate_status: "not_run",
      effect_status: "not_run",
      provider_health_status: "pass",
    }, null, 2));
    return;
  }
  progress.emit("runtime_start", {
    suite_id: suite.suite_id,
    runtime_url: typeof args["runtime-url"] === "string" ? args["runtime-url"] : null,
  });
  const runtime = await startRuntimeIfNeeded({
    runtimeUrl: typeof args["runtime-url"] === "string" ? args["runtime-url"] : undefined,
    outDir,
    provider,
  });
  progress.emit("runtime_ready", {
    suite_id: suite.suite_id,
    runtime_url: runtime.baseUrl,
  });
  try {
    const report = await runSuite({
      suite,
      provider,
      runtime,
      outDir,
      progress,
      priorTaskReports,
      priorReportFile,
      workspaceRefOverride,
      aionisPriorEvidenceMode,
      runMode: priorTaskReports
        ? expectStaleSuccessReplay
          ? "aionis_only_prior_report_stale_replay"
          : "aionis_only_prior_report"
        : "full_seed_baseline_aionis",
    });
    const reportWithPreflight: JsonObject = {
      ...report,
      provider_preflight: providerPreflight,
    };
    const reportFile = path.join(outDir, "real-llm-eval-report.json");
    await fsp.writeFile(reportFile, JSON.stringify(reportWithPreflight, null, 2), "utf8");
    const effectGate = asObject(reportWithPreflight.effect_gate);
    const effectGateStatus = asString(effectGate?.status) ?? "fail";
    progress.emit("report_written", {
      suite_id: suite.suite_id,
      status: effectGateStatus,
      report_file: reportFile,
      progress_file: progress.file,
    });
    console.log(JSON.stringify({
      ok: effectGateStatus === "pass",
      report_version: REPORT_VERSION,
      layer_boundary: REAL_EVAL_LAYER_BOUNDARY,
      suite_id: suite.suite_id,
      run_mode: asString(reportWithPreflight.run_mode) ?? "full_seed_baseline_aionis",
      aionis_prior_evidence_mode: asString(reportWithPreflight.aionis_prior_evidence_mode) ?? aionisPriorEvidenceMode,
      prior_report_file: asString(reportWithPreflight.prior_report_file) ?? null,
      workspace_ref_override: asString(reportWithPreflight.workspace_ref_override) ?? null,
      report_file: reportFile,
      progress_file: progress.file,
      task_count: suite.tasks.length,
      runtime_url: runtime.baseUrl,
      provider: provider.provider,
      model: provider.model,
      provider_preflight: providerPreflight,
      effect_gate_status: effectGateStatus,
      effect_status: asString(effectGate?.effect_status) ?? effectGateStatus,
      provider_health_status: asString(effectGate?.provider_health_status) ?? effectGateStatus,
      failed_checks: Array.isArray(effectGate?.failed_checks) ? effectGate.failed_checks : [],
      failed_effect_checks: Array.isArray(effectGate?.failed_effect_checks) ? effectGate.failed_effect_checks : [],
      failed_provider_health_checks: Array.isArray(effectGate?.failed_provider_health_checks) ? effectGate.failed_provider_health_checks : [],
      task_outcomes: compactTaskOutcomes(reportWithPreflight),
    }, null, 2));
    if (effectGateStatus !== "pass") {
      process.exitCode = 1;
    }
  } finally {
    await runtime.stop();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    report_version: REPORT_VERSION,
    layer_boundary: REAL_EVAL_LAYER_BOUNDARY,
    error: err instanceof Error ? err.message : String(err),
  }, null, 2));
  process.exitCode = 1;
});
