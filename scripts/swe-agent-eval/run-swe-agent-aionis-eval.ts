import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAionisAgentRuntimeContext,
  type AgentRuntimeIdentity,
} from "../agent-runtime/aionis-agent-runtime-adapter.js";
import { buildRuntimeEffectRollupFromTaskReports, type JsonObject } from "../real-llm-eval/report-runtime-effect-rollup.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type CommandSpec = {
  command: string;
  timeout_ms?: number;
  env?: Record<string, string>;
};

type WorkspaceSpec = {
  source: "git" | "local";
  repo_url?: string;
  path?: string;
  ref?: string;
  checkout_depth?: number;
  setup_commands?: CommandSpec[];
  exclude?: string[];
};

type VerifierSpec = {
  command: string;
  timeout_ms?: number;
};

type ExpectedSpec = {
  target_files?: string[];
  allowed_read_files?: string[];
  allowed_edit_files?: string[];
  forbidden_edit_files?: string[];
  acceptance_checks?: string[];
  required_verifiers?: string[];
  anti_shortcut_rules?: string[];
  first_action_keywords?: string[];
};

type SweAgentConfig = {
  command?: string;
  command_template?: string;
  model?: string;
  cost_limit?: number;
  deployment?: "local" | "custom";
  config_files?: string[];
  extra_args?: string[];
  timeout_ms?: number;
  apply_patch_locally?: boolean;
  env?: Record<string, string>;
};

type EvalTask = {
  id: string;
  title?: string;
  task_family?: string;
  prompt: string;
  workspace: WorkspaceSpec;
  verifier: VerifierSpec;
  expected?: ExpectedSpec;
  max_steps?: number;
  baseline_attempts?: number;
  aionis_attempts?: number;
  max_repair_attempts?: number;
  swe_agent?: SweAgentConfig;
};

type EvalSuite = {
  suite_id: string;
  description?: string;
  swe_agent?: SweAgentConfig;
  tasks: EvalTask[];
};

type CliArgs = {
  suiteFile: string;
  outDir: string;
  runtimeUrl: string | null;
  taskIds: Set<string> | null;
  sweagentBin: string | null;
  model: string | null;
  costLimit: number | null;
  armMode: "both" | "baseline" | "aionis";
  keepWorkspaces: boolean;
  priorReportFiles: string[];
};

type CommandResult = {
  command: string;
  cwd: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

type TrajectoryStep = {
  step_index: number;
  response: string | null;
  thought: string | null;
  action: string | null;
  observation: string | null;
  state: unknown;
};

type AgentRun = {
  arm: "baseline" | "aionis";
  run_id: string;
  task_id: string;
  workspace_dir: string;
  output_dir: string;
  problem_file: string;
  swe_agent_command: CommandResult;
  verifier: CommandResult;
  trajectory_file: string | null;
  trajectory_steps: TrajectoryStep[];
  patch: string;
  status: "success" | "failed" | "provider_failure" | "agent_failure";
  summary: string;
  aionis_context: JsonObject | null;
  aionis_store: JsonObject | null;
  metrics: JsonObject;
  repair_passes: AgentPass[];
};

type AgentPass = {
  pass_index: number;
  kind: "initial" | "repair";
  problem_file: string;
  output_dir: string;
  swe_agent_command: CommandResult;
  verifier: CommandResult;
  trajectory_file: string | null;
  trajectory_steps: TrajectoryStep[];
  patch: string;
  changed_files: string[];
  submitted_patch_sync: SubmittedPatchSync;
  verifier_failure_evidence: JsonObject | null;
  model_stats: JsonObject | null;
};

type SubmittedPatchSync = {
  patch_file: string | null;
  source: "swe_agent_patch_file" | "trajectory_submission" | null;
  applied_to_workspace: boolean;
  skipped_reason: string | null;
  error: string | null;
};

type RepairLoopSummary = {
  swe_agent_command: CommandResult;
  verifier: CommandResult;
  patch: string;
  changed_files: string[];
  trajectory_file: string | null;
  trajectory_steps: TrajectoryStep[];
  passes: AgentPass[];
  final_problem_file: string;
};

type NonLearningFailureReason =
  | "agent_action_format_failure"
  | "agent_deployment_failure"
  | "agent_framework_configuration_failure"
  | "agent_process_signal_failure"
  | "agent_tool_protocol_failure"
  | "agent_timeout_failure"
  | "provider_failure";

type AssistanceMode =
  | "no_op"
  | "minimal_boundary"
  | "compact_contract"
  | "semantic_evidence"
  | "strict_governance";

const AIONIS_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SWAGENT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_VERIFIER_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MODEL = "gpt-4o";

function usage(): string {
  return [
    "Usage:",
    "  npm run -s eval:swe-agent -- --suite <suite.json> --out <dir> --runtime-url <url> [--task <id[,id]>]",
    "",
    "Options:",
    "  --suite <file>          Real task suite. Reuses the real-llm-eval suite shape.",
    "  --out <dir>             Output directory for reports, workspaces, trajectories, and diffs.",
    "  --runtime-url <url>     Aionis Lite Runtime base URL. Required for Aionis arm.",
    "  --task <id[,id]>        Run only selected tasks.",
    "  --sweagent-bin <bin>    SWE-agent executable. Defaults to suite config or sweagent.",
    "  --model <name>          SWE-agent model name. Defaults to suite config or gpt-4o.",
    "  --cost-limit <number>   Per-instance SWE-agent cost limit.",
    "  --arm <both|baseline|aionis>",
    "  --prior-report <file>   Previous SWE-agent/Aionis eval report for scoped feedback gating. May be repeated.",
    "  --keep-workspaces       Do not delete per-run workspaces.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    runtimeUrl: null,
    taskIds: null,
    sweagentBin: null,
    model: null,
    costLimit: null,
    armMode: "both",
    keepWorkspaces: false,
    priorReportFiles: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--suite") args.suiteFile = next();
    else if (arg === "--out") args.outDir = next();
    else if (arg === "--runtime-url") args.runtimeUrl = next().replace(/\/$/, "");
    else if (arg === "--task") args.taskIds = new Set(next().split(",").map((value) => value.trim()).filter(Boolean));
    else if (arg === "--sweagent-bin") args.sweagentBin = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--cost-limit") args.costLimit = Number(next());
    else if (arg === "--prior-report") {
      args.priorReportFiles = [
        ...(args.priorReportFiles ?? []),
        ...next().split(",").map((value) => value.trim()).filter(Boolean),
      ];
    }
    else if (arg === "--arm") {
      const value = next();
      if (value !== "both" && value !== "baseline" && value !== "aionis") throw new Error(`invalid --arm ${value}`);
      args.armMode = value;
    } else if (arg === "--keep-workspaces") args.keepWorkspaces = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}\n${usage()}`);
    }
  }
  if (!args.suiteFile) throw new Error(`--suite is required\n${usage()}`);
  if (!args.outDir) throw new Error(`--out is required\n${usage()}`);
  if ((args.armMode === "both" || args.armMode === "aionis") && !args.runtimeUrl) {
    throw new Error("--runtime-url is required when running the Aionis arm");
  }
  if (args.costLimit !== null && !Number.isFinite(args.costLimit)) throw new Error("--cost-limit must be a number");
  return args as CliArgs;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function stableShortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 32))}\n...[truncated ${text.length - limit} chars]`;
}

function compactOneLine(text: string, limit: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), limit);
}

function normalizeEvidenceLine(line: string): string {
  return line
    .replace(/^\+/, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/;$/, "");
}

function collectAddedPatchLines(patch: string): Array<{ file: string; line: string }> {
  const out: Array<{ file: string; line: string }> = [];
  let currentFile: string | null = null;
  for (const rawLine of patch.split("\n")) {
    const diffMatch = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      currentFile = diffMatch[2] ?? diffMatch[1] ?? null;
      continue;
    }
    const newFileMatch = rawLine.match(/^\+\+\+ b\/(.+)$/);
    if (newFileMatch) {
      currentFile = newFileMatch[1] ?? currentFile;
      continue;
    }
    if (!currentFile || !rawLine.startsWith("+") || rawLine.startsWith("+++")) continue;
    const normalized = normalizeEvidenceLine(rawLine);
    if (!normalized || normalized.startsWith("//") || normalized.startsWith("*")) continue;
    out.push({ file: currentFile, line: normalized });
  }
  return out;
}

function semanticInvariant(args: {
  task: EvalTask;
  run?: AgentRun;
  verifierPassed?: boolean;
  kind: string;
  file: string;
  normalizedValue: string;
  evidenceLine: string;
}): JsonObject {
  const scopeKey = [
    args.task.task_family ?? args.task.id,
    args.kind,
    args.file,
    args.normalizedValue,
  ].join("\n");
  const runVerifierPassed = args.run?.metrics.verifier_passed === true;
  const verifierPassed = runVerifierPassed || args.verifierPassed === true;
  return {
    schema_version: "swe_agent_patch_semantic_invariant_v1",
    invariant_id: `patch-invariant:${stableShortHash(scopeKey)}`,
    kind: args.kind,
    file: args.file,
    normalized_value: truncate(args.normalizedValue, 240),
    evidence_line: truncate(args.evidenceLine, 240),
    authority: runVerifierPassed
      ? "scoped_prior_success_evidence"
      : verifierPassed ? "current_verified_run_observation" : "current_run_observation",
    task_family: args.task.task_family ?? null,
    verifier_passed: verifierPassed,
    source_run_id: args.run?.run_id ?? null,
    source_arm: args.run?.arm ?? null,
  };
}

function extractPatchSemanticInvariants(
  task: EvalTask,
  patch: string,
  run?: AgentRun,
  verifierPassed?: boolean,
): JsonObject[] {
  const seen = new Set<string>();
  const invariants: JsonObject[] = [];
  const add = (kind: string, file: string, normalizedValue: string, evidenceLine: string) => {
    const key = `${kind}\n${file}\n${normalizedValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    invariants.push(semanticInvariant({ task, run, verifierPassed, kind, file, normalizedValue, evidenceLine }));
  };

  for (const entry of collectAddedPatchLines(patch)) {
    const line = entry.line;
    const returnMatch = line.match(/^return\s+(.+)$/);
    if (returnMatch) add("return_expression", entry.file, `return ${returnMatch[1]!.trim()}`, line);

    if (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(line) && /\.(?:size|length)\b/.test(line)) {
      add("state_capture_before_mutation", entry.file, line, line);
    }

    if (/\b(?:t\.is|t\.deepEqual|assert\.(?:equal|strictEqual|deepStrictEqual)|expect(?:Type)?<|expect\()/.test(line)) {
      add("test_or_type_assertion", entry.file, line, line);
    }

    if (/^test(?:\.\w+)?\(['"`].+/.test(line)) {
      add("test_case_name", entry.file, line, line);
    }

    if ((entry.file.endsWith(".d.ts") || entry.file.endsWith(".ts")) && /:\s*[^=;{}]+$/.test(line)) {
      add("type_contract_signature", entry.file, line, line);
    }

    if (/^export\s+/.test(line) || /^module\.exports\b/.test(line)) {
      add("public_api_surface", entry.file, line, line);
    }
  }

  const priority: Record<string, number> = {
    return_expression: 0,
    state_capture_before_mutation: 1,
    test_or_type_assertion: 2,
    type_contract_signature: 3,
    test_case_name: 4,
    public_api_surface: 5,
  };
  return invariants
    .sort((a, b) => (priority[stringValue(a.kind) ?? ""] ?? 99) - (priority[stringValue(b.kind) ?? ""] ?? 99))
    .slice(0, 80);
}

function priorSuccessEvidencePacket(task: EvalTask, priorRuns: AgentRun[]): JsonObject | null {
  const successfulRuns = priorRuns.filter((run) =>
    run.metrics.verifier_passed === true && run.metrics.runtime_learning_quarantined !== true
  );
  if (successfulRuns.length === 0) return null;
  const invariants = successfulRuns.flatMap((run) => extractPatchSemanticInvariants(task, run.patch, run));
  return {
    schema_version: "swe_agent_prior_success_evidence_packet_v1",
    authority: "advisory_scoped_evidence_not_runtime_rule",
    task_family: task.task_family ?? null,
    match_scope: "same_task_family_or_current_eval_pair",
    prior_success_run_count: successfulRuns.length,
    invariant_count: invariants.length,
    invariants: invariants.slice(0, 60),
    usage_contract: [
      "Treat these as verifier-passing prior patch signals, not commands.",
      "Use them only when current files and task contract still match.",
      "The LLM/Agent owns semantic repair; Aionis only supplies scoped evidence.",
      "The external verifier remains the final authority.",
    ],
  };
}

function finiteNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function feedbackMatchesTaskScope(task: EvalTask, feedback: JsonObject): boolean {
  const feedbackFamily = stringValue(feedback.task_family);
  if (feedbackFamily) return feedbackFamily === (task.task_family ?? null);
  const feedbackTaskId = stringValue(feedback.task_id);
  return feedbackTaskId === task.id;
}

function contextFeedbackFromReport(report: JsonObject): JsonObject | null {
  const existing = asObject(report.aionis_context_feedback);
  if (existing) return existing;
  const comparison = asObject(report.comparison);
  if (!comparison) return null;
  return aionisContextFeedbackFromComparison({
    id: stringValue(report.task_id) ?? "unknown-task",
    task_family: stringValue(report.task_family) ?? undefined,
  }, comparison);
}

function priorNegativeTransferEvidencePacket(task: EvalTask, priorTaskReports: JsonObject[]): JsonObject | null {
  const scopedFeedback = priorTaskReports
    .map(contextFeedbackFromReport)
    .filter((feedback): feedback is JsonObject => !!feedback)
    .filter((feedback) => feedback.negative_transfer === true && feedbackMatchesTaskScope(task, feedback));
  if (scopedFeedback.length === 0) return null;

  const reasons = unique(scopedFeedback.flatMap((feedback) => stringList(feedback.reasons))).slice(0, 16);
  const sourceTaskIds = unique(scopedFeedback
    .map((feedback) => stringValue(feedback.task_id))
    .filter((taskId): taskId is string => !!taskId))
    .slice(0, 32);

  return {
    schema_version: "aionis_prior_negative_transfer_evidence_packet_v1",
    authority: "advisory_scoped_counter_evidence_not_runtime_rule",
    task_id: task.id,
    task_family: task.task_family ?? null,
    match_scope: task.task_family ? "same_task_family" : "same_task_id",
    prior_negative_transfer_count: scopedFeedback.length,
    source_task_ids: sourceTaskIds,
    recommended_next_assistance_mode: "minimal_boundary",
    suppress_surfaces: [
      "semantic_invariants",
      "prior_success_evidence_payload",
      "strict_governance_action_hints",
      "runtime_owned_repair_guidance",
    ],
    reasons,
    usage_contract: [
      "Treat this as evidence that previous Aionis context harmed this scoped task family.",
      "Restore LLM/Agent semantic autonomy; Aionis should provide only task boundaries and verifier contracts.",
      "Do not mutate Runtime source code from this evidence. It is eval feedback and scoped counter-evidence.",
    ],
    source_code_change_allowed: false,
  };
}

function taskTargetFiles(task: EvalTask): string[] {
  return unique(task.expected?.allowed_edit_files ?? task.expected?.target_files ?? []);
}

function taskVerifierCommands(task: EvalTask): string[] {
  return task.expected?.required_verifiers ?? task.expected?.acceptance_checks ?? [task.verifier.command];
}

function learnablePriorRuns(priorRuns: AgentRun[]): AgentRun[] {
  return priorRuns.filter((run) => run.metrics.runtime_learning_quarantined !== true);
}

function assistanceGateDecision(
  task: EvalTask,
  priorRuns: AgentRun[],
  priorSuccessEvidence: JsonObject | null,
  priorNegativeTransferEvidence: JsonObject | null,
): JsonObject {
  const learnableRuns = learnablePriorRuns(priorRuns);
  const priorSuccessCount = learnableRuns.filter((run) => run.metrics.verifier_passed === true).length;
  const priorFailureCount = learnableRuns.filter((run) => run.metrics.verifier_passed !== true).length;
  const priorForbiddenWriteCount = learnableRuns
    .reduce((sum, run) => sum + Math.max(0, Number(run.metrics.forbidden_file_writes ?? 0)), 0);
  const targetFileCount = taskTargetFiles(task).length;
  const forbiddenFileCount = task.expected?.forbidden_edit_files?.length ?? 0;
  const antiShortcutRuleCount = task.expected?.anti_shortcut_rules?.length ?? 0;
  const setupCommandCount = task.workspace.setup_commands?.length ?? 0;
  const hasSemanticEvidence = Number(priorSuccessEvidence?.invariant_count ?? 0) > 0;
  const priorNegativeTransferCount = Math.max(0, Number(priorNegativeTransferEvidence?.prior_negative_transfer_count ?? 0));
  const semanticEvidenceSuppressedByCounterEvidence = priorNegativeTransferCount > 0;
  const effectiveHasSemanticEvidence = hasSemanticEvidence && !semanticEvidenceSuppressedByCounterEvidence;
  const complexityScore =
    (targetFileCount >= 8 ? 3 : targetFileCount >= 5 ? 2 : targetFileCount >= 3 ? 1 : 0)
    + (forbiddenFileCount > 0 ? 1 : 0)
    + (antiShortcutRuleCount >= 4 ? 2 : antiShortcutRuleCount > 0 ? 1 : 0)
    + (setupCommandCount > 0 ? 1 : 0)
    + ((task.max_steps ?? 0) >= 30 ? 1 : 0)
    + (priorFailureCount > 0 ? 2 : 0)
    + (priorForbiddenWriteCount > 0 ? 2 : 0);

  let mode: AssistanceMode;
  if (priorNegativeTransferCount > 0) mode = "minimal_boundary";
  else if (priorForbiddenWriteCount > 0 || priorFailureCount >= 2 || complexityScore >= 8) mode = "strict_governance";
  else if (effectiveHasSemanticEvidence) mode = "semantic_evidence";
  else if (complexityScore >= 4) mode = "compact_contract";
  else if (targetFileCount === 0 && antiShortcutRuleCount === 0 && priorRuns.length === 0) mode = "no_op";
  else mode = "minimal_boundary";

  const contextBudgetByMode: Record<AssistanceMode, number> = {
    no_op: 0,
    minimal_boundary: 1200,
    compact_contract: 2400,
    semantic_evidence: 3600,
    strict_governance: 5200,
  };
  const reasons = [
    effectiveHasSemanticEvidence ? "prior_verifier_success_semantic_evidence_available" : null,
    priorNegativeTransferCount > 0 ? "prior_assisted_negative_transfer_present" : null,
    semanticEvidenceSuppressedByCounterEvidence ? "semantic_evidence_downgraded_by_counter_evidence" : null,
    priorNegativeTransferCount > 0 ? "llm_agent_autonomy_restored_after_negative_transfer" : null,
    priorFailureCount > 0 ? "prior_learnable_failure_present" : null,
    priorForbiddenWriteCount > 0 ? "prior_forbidden_write_present" : null,
    targetFileCount >= 3 ? "multi_file_task_surface" : null,
    antiShortcutRuleCount >= 4 ? "explicit_contract_rules_present" : null,
    setupCommandCount > 0 ? "real_project_setup_required" : null,
    mode === "no_op" ? "simple_task_no_prior_runtime_value" : null,
  ].filter((reason): reason is string => !!reason);

  return {
    schema_version: "aionis_assistance_gate_v1",
    mode,
    authority: "runtime_cost_gate",
    context_budget_chars: contextBudgetByMode[mode],
    complexity_score: complexityScore,
    target_file_count: targetFileCount,
    forbidden_file_count: forbiddenFileCount,
    anti_shortcut_rule_count: antiShortcutRuleCount,
    setup_command_count: setupCommandCount,
    prior_run_count: priorRuns.length,
    learnable_prior_run_count: learnableRuns.length,
    prior_success_count: priorSuccessCount,
    prior_failure_count: priorFailureCount,
    prior_forbidden_write_count: priorForbiddenWriteCount,
    semantic_evidence_available: hasSemanticEvidence,
    semantic_evidence_suppressed_by_counter_evidence: semanticEvidenceSuppressedByCounterEvidence,
    prior_negative_transfer_count: priorNegativeTransferCount,
    reasons,
  };
}

function invariantLimitForMode(mode: AssistanceMode): number {
  if (mode === "strict_governance") return 8;
  if (mode === "semantic_evidence") return 5;
  if (mode === "compact_contract") return 2;
  return 0;
}

function firstActionFromPlanning(planning: JsonObject | null): JsonObject | null {
  const planningSummary = asObject(planning?.planning_summary);
  const planningAction = asObject(asObject(planningSummary?.first_step_recommendation)?.first_action_v1);
  if (planningAction && stringValue(planningAction.action) !== "request_operator_review") return planningAction;
  return null;
}

function firstActionFromExperience(experience: JsonObject | null): JsonObject | null {
  const actionRetrieval = asObject(experience?.action_retrieval);
  const actionContract = asObject(experience?.action_intelligence_runtime_contract);
  const preActionGate = asObject(actionContract?.pre_action_gate);
  const recommendedActions = stringList(preActionGate?.recommended_actions);
  if (preActionGate?.authority_blocked === true || recommendedActions.includes("request_operator_review")) return null;

  const recommendation = asObject(experience?.recommendation);
  const selectedTool = stringValue(actionContract?.selected_tool) ?? stringValue(actionRetrieval?.selected_tool);
  const recommendedFile = stringValue(actionRetrieval?.recommended_file_path);
  const recommendedNextAction = stringValue(actionContract?.recommended_next_action)
    ?? stringValue(actionRetrieval?.recommended_next_action)
    ?? stringValue(recommendation?.combined_next_action);
  const targetFiles = stringList(actionContract?.target_files);
  if (!selectedTool && !recommendedFile && !recommendedNextAction && targetFiles.length === 0) return null;

  return {
    action: "proceed",
    tool_name: selectedTool,
    file_path: recommendedFile,
    target_files: targetFiles,
    instruction: recommendedNextAction,
  };
}

function verifierFailureEvidence(result: CommandResult): JsonObject {
  const text = result.stderr.trim().length > 0 ? result.stderr : result.stdout;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const assertionLine = lines.find((line) => /AssertionError|ERR_ASSERTION|Expected|actual|must|should/i.test(line));
  const diffLine = lines.find((line) => / !== | === | deepStrictEqual|strictEqual|notStrictEqual/.test(line));
  const stackAnchor = lines.find((line) => /\b(?:file:\/\/|\/).+\.(?:mjs|cjs|js|ts):\d+:\d+/.test(line));
  const assertionMessage = assertionLine
    ? assertionLine.replace(/^AssertionError(?: \[[^\]]+\])?:\s*/i, "")
    : null;
  const excerpt = lines
    .filter((line) =>
      /AssertionError|ERR_ASSERTION|Expected|actual|must|should| !== | === |\.mjs:\d+:\d+|\.js:\d+:\d+|\.ts:\d+:\d+/i.test(line)
    )
    .slice(0, 8)
    .join(" | ");

  return {
    assertion_message: assertionMessage ? compactOneLine(assertionMessage, 220) : null,
    diff_line: diffLine ? compactOneLine(diffLine, 120) : null,
    stack_anchor: stackAnchor ? compactOneLine(stackAnchor, 220) : null,
    stderr_excerpt: compactOneLine(excerpt || text, 360),
  };
}

function failureEvidenceSignature(evidence: JsonObject | null): string | null {
  if (!evidence) return null;
  const assertion = stringValue(evidence.assertion_message);
  const diff = stringValue(evidence.diff_line);
  const stack = stringValue(evidence.stack_anchor);
  const excerpt = stringValue(evidence.stderr_excerpt);
  const signature = [assertion, diff, stack ?? excerpt].filter((item): item is string => !!item).join(" | ");
  return signature.length > 0 ? signature : null;
}

function repeatedFailureCount(passes: AgentPass[]): number {
  const signatures = passes
    .map((pass) => failureEvidenceSignature(pass.verifier_failure_evidence))
    .filter((signature): signature is string => !!signature);
  return Math.max(0, signatures.length - new Set(signatures).size);
}

function priorFailureSummaries(priorRuns: AgentRun[], limit: number): JsonObject[] {
  return learnablePriorRuns(priorRuns)
    .filter((run) => run.metrics.verifier_passed !== true)
    .slice(-limit)
    .map((run) => {
      const failure = verifierFailureEvidence(run.verifier);
      return {
        schema_version: "swe_agent_prior_failure_summary_v1",
        run_id: run.run_id,
        arm: run.arm,
        status: run.status,
        edited_files: stringList(run.metrics.edited_files),
        verifier_exit_code: run.verifier.exit_code,
        assertion_message: failure.assertion_message,
        diff_line: failure.diff_line,
        stack_anchor: failure.stack_anchor,
        stderr_excerpt: failure.stderr_excerpt,
        instruction: "Use this as scoped prior verifier evidence; inspect current files and repair the failing contract without copying blindly.",
      };
    });
}

function compactFirstAction(action: JsonObject | null): JsonObject | null {
  if (!action) return null;
  return {
    action: stringValue(action.action),
    tool_name: stringValue(action.tool_name),
    file_path: stringValue(action.file_path),
    target_files: stringList(action.target_files).slice(0, 8),
    instruction: stringValue(action.instruction) ? compactOneLine(stringValue(action.instruction)!, 160) : null,
  };
}

function compactEntropyProfile(profile: JsonObject | null): JsonObject | null {
  if (!profile) return null;
  return {
    entropy_level: stringValue(profile.entropy_level),
    exploration_budget: typeof profile.exploration_budget === "number" ? profile.exploration_budget : null,
    control_strength: typeof profile.control_strength === "number" ? profile.control_strength : null,
    plasticity_level: stringValue(profile.plasticity_level),
    recall_breadth: stringValue(profile.recall_breadth),
    verification_depth: stringValue(profile.verification_depth),
    promotion_threshold: stringValue(profile.promotion_threshold),
    mutation_authority: stringValue(profile.mutation_authority),
    runtime_signal_trend_posture: stringValue(profile.runtime_signal_trend_posture),
    reason_codes: stringList(profile.reason_codes).slice(0, 4),
    source_signals: stringList(profile.source_signals).slice(0, 6),
  };
}

function compactActionRetrievalUncertainty(uncertainty: JsonObject | null): JsonObject | null {
  if (!uncertainty) return null;
  return {
    level: stringValue(uncertainty.level),
    confidence: typeof uncertainty.confidence === "number" ? uncertainty.confidence : null,
    evidence_gap_count: typeof uncertainty.evidence_gap_count === "number" ? uncertainty.evidence_gap_count : null,
    reasons: stringList(uncertainty.reasons).slice(0, 4),
    recommended_actions: stringList(uncertainty.recommended_actions).slice(0, 4),
  };
}

function compactActionRetrieval(retrieval: JsonObject | null): JsonObject | null {
  if (!retrieval) return null;
  const evidence = asObject(retrieval.evidence);
  const rationale = asObject(retrieval.rationale);
  return {
    summary_version: stringValue(retrieval.summary_version),
    history_applied: retrieval.history_applied === true,
    tool_source_kind: stringValue(retrieval.tool_source_kind),
    selected_tool: stringValue(retrieval.selected_tool),
    recommended_file_path: stringValue(retrieval.recommended_file_path),
    recommended_next_action: stringValue(retrieval.recommended_next_action)
      ? compactOneLine(stringValue(retrieval.recommended_next_action)!, 180)
      : null,
    evidence: evidence
      ? {
          stable_workflow_count: Number(evidence.stable_workflow_count ?? 0),
          candidate_workflow_count: Number(evidence.candidate_workflow_count ?? 0),
          trusted_pattern_count: Number(evidence.trusted_pattern_count ?? 0),
          policy_memory_count: Number(evidence.policy_memory_count ?? 0),
        }
      : null,
    uncertainty: compactActionRetrievalUncertainty(asObject(retrieval.uncertainty)),
    rationale: stringValue(rationale?.summary) ? compactOneLine(stringValue(rationale?.summary)!, 180) : null,
  };
}

function compactRuntimeEntropyControls(controls: JsonObject | null): JsonObject | null {
  if (!controls) return null;
  const recall = asObject(controls.recall);
  const verifier = asObject(controls.verifier);
  const promotion = asObject(controls.promotion);
  const maintenance = asObject(controls.maintenance);
  return {
    recall: recall
      ? {
          breadth: stringValue(recall.breadth),
          recommended_limit: typeof recall.recommended_limit === "number" ? recall.recommended_limit : null,
          reason: stringValue(recall.reason) ? compactOneLine(stringValue(recall.reason)!, 120) : null,
        }
      : null,
    verifier: verifier
      ? {
          schedule: stringValue(verifier.schedule),
          runtime_verifier_required: verifier.runtime_verifier_required === true,
          reason: stringValue(verifier.reason) ? compactOneLine(stringValue(verifier.reason)!, 120) : null,
        }
      : null,
    promotion: promotion
      ? {
          promotion_threshold: stringValue(promotion.promotion_threshold),
          mutation_authority: stringValue(promotion.mutation_authority),
          stable_promotion_allowed: promotion.stable_promotion_allowed === true,
          minimum_observations: typeof promotion.minimum_observations === "number" ? promotion.minimum_observations : null,
        }
      : null,
    maintenance: maintenance
      ? {
          recommended_profile: stringValue(maintenance.recommended_profile),
          run_after_task: maintenance.run_after_task === true,
        }
      : null,
  };
}

function compactActionIntelligence(contract: JsonObject | null): JsonObject | null {
  if (!contract) return null;
  const preActionGate = asObject(contract.pre_action_gate);
  const lifecycle = asObject(contract.lifecycle);
  return {
    contract_version: stringValue(contract.contract_version),
    loop_version: stringValue(contract.loop_version),
    selected_tool: stringValue(contract.selected_tool),
    recommended_next_action: stringValue(contract.recommended_next_action)
      ? compactOneLine(stringValue(contract.recommended_next_action)!, 180)
      : null,
    target_files: stringList(contract.target_files).slice(0, 8),
    workflow_anchor_id: stringValue(contract.workflow_anchor_id),
    policy_memory_id: stringValue(contract.policy_memory_id),
    pre_action_gate: preActionGate
      ? {
          known_enough: preActionGate.known_enough === true,
          requires_recall: preActionGate.requires_recall === true,
          requires_rehydration: preActionGate.requires_rehydration === true,
          requires_operator_review: preActionGate.requires_operator_review === true,
          authority_blocked: preActionGate.authority_blocked === true,
          uncertainty_level: stringValue(preActionGate.uncertainty_level),
          confidence: typeof preActionGate.confidence === "number" ? preActionGate.confidence : null,
          recommended_actions: stringList(preActionGate.recommended_actions).slice(0, 5),
          primary_reason: stringValue(preActionGate.primary_reason)
            ? compactOneLine(stringValue(preActionGate.primary_reason)!, 140)
            : null,
        }
      : null,
    runtime_entropy_profile: compactEntropyProfile(asObject(contract.runtime_entropy_profile)),
    runtime_entropy_controls: compactRuntimeEntropyControls(asObject(contract.runtime_entropy_controls)),
    lifecycle: lifecycle
      ? {
          history_applied: lifecycle.history_applied === true,
          post_action_material_present: lifecycle.post_action_material_present === true,
          workflow_candidate_available: lifecycle.workflow_candidate_available === true,
          policy_candidate_available: lifecycle.policy_candidate_available === true,
          mutation_candidate_available: lifecycle.mutation_candidate_available === true,
          maintenance_ready: lifecycle.maintenance_ready === true,
          recommended_maintenance_profile: stringValue(lifecycle.recommended_maintenance_profile),
        }
      : null,
  };
}

function compactExperienceAdaptationTrace(trace: JsonObject | null): JsonObject | null {
  if (!trace) return null;
  const trajectory = asObject(trace.trajectory);
  const sources = asObject(trace.experience_sources);
  const retrieval = asObject(trace.retrieval);
  const adaptation = asObject(trace.adaptation);
  const stages = Array.isArray(trace.stages)
    ? trace.stages
        .map((stage) => asObject(stage))
        .filter((stage): stage is JsonObject => !!stage)
        .slice(0, 8)
        .map((stage) => ({
          stage: stringValue(stage.stage),
          status: stringValue(stage.status),
          summary: stringValue(stage.summary) ? compactOneLine(stringValue(stage.summary)!, 120) : null,
        }))
    : [];
  return {
    summary_version: stringValue(trace.summary_version),
    activation_state: stringValue(trace.activation_state),
    trajectory: trajectory
      ? {
          present: trajectory.present === true,
          compiled: trajectory.compiled === true,
          task_family: stringValue(trajectory.task_family),
          target_file_count: Number(trajectory.target_file_count ?? 0),
          acceptance_check_count: Number(trajectory.acceptance_check_count ?? 0),
          likely_tool: stringValue(trajectory.likely_tool),
        }
      : null,
    experience_sources: sources
      ? {
          stable_workflow_count: Number(sources.stable_workflow_count ?? 0),
          candidate_workflow_count: Number(sources.candidate_workflow_count ?? 0),
          trusted_pattern_count: Number(sources.trusted_pattern_count ?? 0),
          rehydration_candidate_count: Number(sources.rehydration_candidate_count ?? 0),
          adaptive_guidance_candidate_count: Number(sources.adaptive_guidance_candidate_count ?? 0),
          delegation_recommendation_count: Number(sources.delegation_recommendation_count ?? 0),
        }
      : null,
    retrieval: retrieval
      ? {
          selected_tool: stringValue(retrieval.selected_tool),
          tool_source_kind: stringValue(retrieval.tool_source_kind),
          path_source_kind: stringValue(retrieval.path_source_kind),
          evidence_entry_count: Number(retrieval.evidence_entry_count ?? 0),
          uncertainty_level: stringValue(retrieval.uncertainty_level),
          confidence: typeof retrieval.confidence === "number" ? retrieval.confidence : null,
        }
      : null,
    adaptation: adaptation
      ? {
          activation_state: stringValue(adaptation.activation_state),
          selected_candidate_ids: stringList(adaptation.selected_candidate_ids).slice(0, 5),
          adapted_instruction_count: Number(adaptation.adapted_instruction_count ?? 0),
          primary_instruction: stringValue(adaptation.primary_instruction)
            ? compactOneLine(stringValue(adaptation.primary_instruction)!, 180)
            : null,
          recommended_actions: stringList(adaptation.recommended_actions).slice(0, 5),
          confidence_delta: typeof adaptation.confidence_delta === "number" ? adaptation.confidence_delta : null,
        }
      : null,
    stages,
  };
}

function buildCompactExecutionContract(args: {
  task: EvalTask;
  gate: JsonObject;
  priorRuns: AgentRun[];
  priorSuccessEvidence: JsonObject | null;
  priorNegativeTransferEvidence?: JsonObject | null;
  experience?: JsonObject | null;
  planning?: JsonObject | null;
  assembly?: JsonObject | null;
  tools?: JsonObject | null;
}): JsonObject | null {
  const mode = stringValue(args.gate.mode) as AssistanceMode | null;
  if (!mode || mode === "no_op") return null;

  const allPriorInvariants = Array.isArray(args.priorSuccessEvidence?.invariants)
    ? args.priorSuccessEvidence.invariants.filter((entry): entry is JsonObject => !!asObject(entry)).map((entry) => asObject(entry)!)
    : [];
  const semanticEvidenceSuppressed = args.gate.semantic_evidence_suppressed_by_counter_evidence === true;
  const semanticInvariants = semanticEvidenceSuppressed ? [] : allPriorInvariants.slice(0, invariantLimitForMode(mode));
  const actionRetrieval = asObject(args.experience?.action_retrieval);
  const actionContract = asObject(args.experience?.action_intelligence_runtime_contract);
  const experienceTrace = asObject(args.experience?.experience_adaptation_trace)
    ?? asObject(actionRetrieval?.experience_adaptation_trace);
  const planningSummary = asObject(args.planning?.planning_summary);
  const assemblySummary = asObject(args.assembly?.assembly_summary);
  const firstAction = mode === "compact_contract" || mode === "strict_governance"
    ? firstActionFromExperience(args.experience ?? null) ?? firstActionFromPlanning(args.planning ?? null)
    : null;
  const entropyProfile = compactEntropyProfile(
    asObject(actionContract?.runtime_entropy_profile)
      ?? asObject(planningSummary?.runtime_entropy_profile)
      ?? asObject(assemblySummary?.runtime_entropy_profile),
  );

  return {
    schema_version: "aionis_compact_execution_contract_v1",
    mode,
    authority: "advisory_runtime_contract_not_agent_execution",
    target_files: taskTargetFiles(args.task),
    forbidden_edit_files: args.task.expected?.forbidden_edit_files ?? [],
    verifier_commands: taskVerifierCommands(args.task),
    semantic_invariants: semanticInvariants,
    negative_transfer_control: args.priorNegativeTransferEvidence
      ? {
          authority: "advisory_scoped_counter_evidence_not_runtime_rule",
          prior_negative_transfer_count: args.priorNegativeTransferEvidence.prior_negative_transfer_count,
          recommended_next_assistance_mode: args.priorNegativeTransferEvidence.recommended_next_assistance_mode,
          suppress_surfaces: Array.isArray(args.priorNegativeTransferEvidence.suppress_surfaces)
            ? args.priorNegativeTransferEvidence.suppress_surfaces.slice(0, 8)
            : [],
          reasons: stringList(args.priorNegativeTransferEvidence.reasons).slice(0, 6),
        }
      : null,
    known_failures_to_avoid: priorFailureSummaries(args.priorRuns, mode === "strict_governance" ? 3 : 1),
    first_action: compactFirstAction(firstAction),
    runtime_entropy_profile: mode === "strict_governance" ? entropyProfile : null,
    action_retrieval: mode === "compact_contract" || mode === "strict_governance"
      ? compactActionRetrieval(actionRetrieval)
      : null,
    action_intelligence: mode === "strict_governance" ? compactActionIntelligence(actionContract) : null,
    experience_adaptation_trace: mode === "strict_governance" ? compactExperienceAdaptationTrace(experienceTrace) : null,
    tool_hint: mode === "strict_governance" ? asObject(args.tools?.selection_summary) : null,
    operating_rules: [
      "The LLM/Agent owns semantic repair and final code choices.",
      "Use Runtime evidence only when current files and task contract match.",
      "Do not broaden edits beyond target_files unless current verifier output proves the boundary is wrong.",
      semanticInvariants.length > 0 ? "Prior success invariants are scoped verifier-passing evidence to consider, not commands." : null,
      args.priorNegativeTransferEvidence ? "Prior Aionis context caused measurable negative transfer in this scope; use only boundaries and your own semantic analysis." : null,
      mode === "strict_governance" ? "Prior failures or high complexity require narrower verification before declaring success." : null,
    ].filter((rule): rule is string => !!rule),
  };
}

function normalizedInvariantKey(invariant: JsonObject): string | null {
  const kind = stringValue(invariant.kind);
  const file = stringValue(invariant.file);
  const value = stringValue(invariant.normalized_value);
  return kind && file && value ? `${kind}\n${file}\n${value}` : null;
}

function semanticInvariantUptakeMetrics(
  task: EvalTask,
  patch: string,
  priorRuns: AgentRun[],
  aionisContext: JsonObject | null,
  verifierPassed: boolean,
): JsonObject {
  const priorPacket = priorSuccessEvidencePacket(task, priorRuns);
  const contract = asObject(aionisContext?.compact_execution_contract);
  const sentInvariants = Array.isArray(contract?.semantic_invariants)
    ? contract.semantic_invariants.filter((entry): entry is JsonObject => !!asObject(entry)).map((entry) => asObject(entry)!)
    : [];
  const availablePriorInvariants = Array.isArray(priorPacket?.invariants)
    ? priorPacket.invariants.filter((entry): entry is JsonObject => !!asObject(entry)).map((entry) => asObject(entry)!)
    : [];
  const priorInvariants = sentInvariants.length > 0 ? sentInvariants : availablePriorInvariants;
  const currentInvariants = extractPatchSemanticInvariants(task, patch, undefined, verifierPassed);
  const currentKeys = new Set(currentInvariants.map(normalizedInvariantKey).filter((key): key is string => !!key));
  const matched = priorInvariants.filter((invariant) => {
    const key = normalizedInvariantKey(invariant);
    return key ? currentKeys.has(key) : false;
  });
  const missing = priorInvariants.filter((invariant) => {
    const key = normalizedInvariantKey(invariant);
    return key ? !currentKeys.has(key) : false;
  });
  const priorCount = priorInvariants.length;
  return {
    semantic_invariant_count: currentInvariants.length,
    semantic_invariants: currentInvariants.slice(0, 40),
    available_prior_success_invariant_count: availablePriorInvariants.length,
    sent_prior_success_invariant_count: sentInvariants.length,
    prior_success_invariant_count: priorCount,
    prior_success_invariant_uptake_count: matched.length,
    prior_success_invariant_uptake_rate: priorCount > 0 ? Number((matched.length / priorCount).toFixed(6)) : null,
    prior_success_invariant_missing_count: missing.length,
    prior_success_invariant_missing: missing.slice(0, 20),
  };
}

function expandPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{([A-Z0-9_]+)\}/g, (match, key) => values[key] ?? match);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, "utf8")) as T;
}

async function readPriorTaskReports(files: string[]): Promise<JsonObject[]> {
  const taskReports: JsonObject[] = [];
  for (const file of files) {
    const parsed = await readJsonFile<JsonObject>(file);
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.filter((task): task is JsonObject => !!asObject(task)).map((task) => asObject(task)!)
      : [];
    if (tasks.length > 0) {
      taskReports.push(...tasks);
    } else if (asObject(parsed.baseline) || asObject(parsed.aionis) || asObject(parsed.comparison)) {
      taskReports.push(parsed);
    }
  }
  return taskReports;
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function runCommand(command: string, args: string[], opts: {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2500).unref();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        command: [command, ...args].join(" "),
        cwd: opts.cwd,
        exit_code: null,
        signal: null,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        command: [command, ...args].join(" "),
        cwd: opts.cwd,
        exit_code: code,
        signal,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

async function runShell(command: string, opts: {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}): Promise<CommandResult> {
  return await runCommand("/bin/sh", ["-lc", command], opts);
}

function isTransientGitFailure(result: CommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return [
    "ssl_error_syscall",
    "connection reset",
    "connection timed out",
    "failed to connect",
    "could not resolve host",
    "the remote end hung up unexpectedly",
    "early eof",
    "rpc failed",
    "http/2 stream",
    "tls",
    "network is unreachable",
    "operation timed out",
  ].some((needle) => text.includes(needle));
}

async function runGitCommandWithTransientRetry(args: string[], opts: {
  cwd: string;
  timeoutMs?: number;
  maxAttempts?: number;
}): Promise<CommandResult> {
  const attempts = Math.max(1, opts.maxAttempts ?? 3);
  let last: CommandResult | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runCommand("git", args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    last = result;
    if (result.exit_code === 0 || !isTransientGitFailure(result) || attempt === attempts) return result;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  return last!;
}

async function cloneWorkspace(task: EvalTask, arm: "baseline" | "aionis", outDir: string): Promise<string> {
  const workspaceDir = path.join(outDir, "workspaces", `${task.id}-${arm}-${crypto.randomUUID()}`);
  await ensureDir(path.dirname(workspaceDir));
  if (task.workspace.source === "local") {
    if (!task.workspace.path) throw new Error(`${task.id}: workspace.path is required for local workspace`);
    await fsp.cp(path.resolve(task.workspace.path), workspaceDir, {
      recursive: true,
      filter: (source) => {
        const rel = path.relative(path.resolve(task.workspace.path as string), source);
        return !task.workspace.exclude?.some((entry) => rel === entry || rel.startsWith(`${entry}${path.sep}`));
      },
    });
    return workspaceDir;
  }
  if (!task.workspace.repo_url) throw new Error(`${task.id}: workspace.repo_url is required for git workspace`);
  const depth = Math.max(1, task.workspace.checkout_depth ?? 1);
  const clone = await runGitCommandWithTransientRetry(["clone", "--no-checkout", "--depth", String(depth), task.workspace.repo_url, workspaceDir], {
    cwd: AIONIS_ROOT,
    timeoutMs: 10 * 60 * 1000,
  });
  if (clone.exit_code !== 0) throw new Error(`${task.id}: git clone failed\n${clone.stderr || clone.stdout}`);
  if (task.workspace.ref) {
    const fetch = await runGitCommandWithTransientRetry(["-C", workspaceDir, "fetch", "--depth", String(depth), "origin", task.workspace.ref], {
      cwd: AIONIS_ROOT,
      timeoutMs: 10 * 60 * 1000,
    });
    if (fetch.exit_code === 0) {
      const checkoutFetch = await runCommand("git", ["-C", workspaceDir, "checkout", "--detach", "FETCH_HEAD"], {
        cwd: AIONIS_ROOT,
        timeoutMs: 2 * 60 * 1000,
      });
      if (checkoutFetch.exit_code !== 0) throw new Error(`${task.id}: git checkout FETCH_HEAD failed\n${checkoutFetch.stderr}`);
    } else {
      const checkout = await runCommand("git", ["-C", workspaceDir, "checkout", "--detach", task.workspace.ref], {
        cwd: AIONIS_ROOT,
        timeoutMs: 2 * 60 * 1000,
      });
      if (checkout.exit_code !== 0) throw new Error(`${task.id}: git fetch/checkout failed\n${fetch.stderr}\n${checkout.stderr}`);
    }
  } else {
    const checkout = await runCommand("git", ["-C", workspaceDir, "checkout"], {
      cwd: AIONIS_ROOT,
      timeoutMs: 2 * 60 * 1000,
    });
    if (checkout.exit_code !== 0) throw new Error(`${task.id}: git checkout failed\n${checkout.stderr}`);
  }
  return workspaceDir;
}

async function runSetupCommands(task: EvalTask, workspaceDir: string): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const setup of task.workspace.setup_commands ?? []) {
    const result = await runShell(expandPlaceholders(setup.command, placeholders(task, workspaceDir, workspaceDir)), {
      cwd: workspaceDir,
      timeoutMs: setup.timeout_ms ?? 10 * 60 * 1000,
      env: { ...(setup.env ?? {}), AIONIS_ROOT },
    });
    results.push(result);
    if (result.exit_code !== 0) {
      throw new Error(`${task.id}: setup command failed: ${setup.command}\n${result.stderr || result.stdout}`);
    }
  }
  return results;
}

function placeholders(task: EvalTask, workspaceDir: string, outDir: string): Record<string, string> {
  return {
    AIONIS_ROOT,
    WORKSPACE: workspaceDir,
    TASK_ID: task.id,
    OUT_DIR: outDir,
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

function runtimePayloadBase(task: EvalTask, runId: string): AgentRuntimeIdentity {
  return {
    tenant_id: "swe-agent-eval",
    scope: `swe-agent-eval:${task.task_family ?? task.id}`,
    actor: "swe-agent",
    consumer_agent_id: "swe-agent",
    producer_agent_id: "swe-agent",
    owner_agent_id: "swe-agent",
    memory_lane: "private",
    run_id: runId,
  };
}

async function buildAionisContext(
  baseUrl: string,
  task: EvalTask,
  runId: string,
  priorRuns: AgentRun[],
  priorTaskReports: JsonObject[],
): Promise<JsonObject> {
  const base = runtimePayloadBase(task, runId);
  const learnableRuns = learnablePriorRuns(priorRuns);
  const context = {
    task_id: task.id,
    task_family: task.task_family ?? null,
    prompt: task.prompt,
    verifier: task.verifier,
  };
  const editBoundaryContext = {
    allowed_edit_files: task.expected?.allowed_edit_files ?? task.expected?.target_files ?? [],
    forbidden_edit_files: task.expected?.forbidden_edit_files ?? [],
    required_verifiers: task.expected?.required_verifiers ?? task.expected?.acceptance_checks ?? [task.verifier.command],
    anti_shortcut_rules: task.expected?.anti_shortcut_rules ?? [],
  };
  const priorSuccessEvidence = priorSuccessEvidencePacket(task, learnableRuns);
  const priorNegativeTransferEvidence = priorNegativeTransferEvidencePacket(task, priorTaskReports);
  const assistanceGate = assistanceGateDecision(task, priorRuns, priorSuccessEvidence, priorNegativeTransferEvidence);
  const assistanceMode = stringValue(assistanceGate.mode) as AssistanceMode | null;

  if (assistanceMode === "no_op" || assistanceMode === "minimal_boundary" || assistanceMode === "semantic_evidence") {
    return {
      context_version: "aionis_swe_agent_context_packet_v1",
      role: "advisory_runtime_evidence_not_agent_execution",
      assistance_gate: assistanceGate,
      prior_success_evidence: priorSuccessEvidence,
      prior_negative_transfer_evidence: priorNegativeTransferEvidence,
      compact_execution_contract: buildCompactExecutionContract({
        task,
        gate: assistanceGate,
        priorRuns,
        priorSuccessEvidence,
        priorNegativeTransferEvidence,
      }),
    };
  }

  const evidence = learnableRuns.map((run) => ({
    schema_version: "swe_agent_prior_run_evidence_v1",
    arm: run.arm,
    status: run.status,
    verifier_passed: run.metrics.verifier_passed === true,
    edited_files: stringList(run.metrics.edited_files),
    verifier: {
      command: run.verifier.command,
      exit_code: run.verifier.exit_code,
      stdout_tail: truncate(run.verifier.stdout, 3000),
      stderr_tail: truncate(run.verifier.stderr, 3000),
    },
    semantic_invariants: extractPatchSemanticInvariants(task, run.patch, run).slice(0, 40),
  }));
  const executionResultSummary = {
    prior_run_count: priorRuns.length,
    learnable_prior_run_count: learnableRuns.length,
    quarantined_prior_run_count: priorRuns.length - learnableRuns.length,
    failed_prior_run_count: learnableRuns.filter((run) => run.metrics.verifier_passed !== true).length,
  };
  const runtimeContext = await buildAionisAgentRuntimeContext({
    baseUrl,
    identity: base,
    host: {
      host_kind: "agent_framework_eval",
      agent_id: "swe-agent",
      adapter_id: "swe-agent-eval-adapter-v1",
    },
    task: {
      task_id: task.id,
      task_family: task.task_family ?? null,
      query_text: task.prompt,
      context,
      edit_boundary_context: editBoundaryContext,
      candidates: ["bash", "read_file", "search", "edit", "submit"],
      execution_evidence: evidence,
      execution_result_summary: executionResultSummary,
    },
    contextCharBudget: 16000,
  });
  return {
    context_version: "aionis_swe_agent_context_packet_v2",
    role: "advisory_runtime_evidence_not_agent_execution",
    agent_runtime_adapter: runtimeContext.adapter,
    runtime_routes: runtimeContext.runtime_routes,
    assistance_gate: assistanceGate,
    prior_success_evidence: priorSuccessEvidence,
    prior_negative_transfer_evidence: priorNegativeTransferEvidence,
    compact_execution_contract: buildCompactExecutionContract({
      task,
      gate: assistanceGate,
      priorRuns,
      priorSuccessEvidence,
      priorNegativeTransferEvidence,
      experience: runtimeContext.experience_intelligence,
      planning: runtimeContext.planning,
      assembly: runtimeContext.assembly,
      tools: runtimeContext.tools,
    }),
    experience_intelligence: runtimeContext.experience_intelligence,
    planning: runtimeContext.planning,
    assembly: runtimeContext.assembly,
    tools: runtimeContext.tools,
  };
}

function compactAionisContext(context: JsonObject | null): JsonObject | null {
  if (!context) return null;
  return {
    context_version: context.context_version,
    role: context.role,
    agent_runtime_adapter: asObject(context.agent_runtime_adapter),
    runtime_routes: asObject(context.runtime_routes),
    assistance_gate: asObject(context.assistance_gate),
    compact_execution_contract: asObject(context.compact_execution_contract),
  };
}

function jsonCloneObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function compactContextJsonLength(context: JsonObject): number {
  return JSON.stringify(context, null, 2).length;
}

function fitCompactContextToBudget(context: JsonObject): JsonObject {
  const gate = asObject(context.assistance_gate);
  const budget = Number(gate?.context_budget_chars ?? 0);
  if (budget <= 0 || compactContextJsonLength(context) <= budget) return context;

  const fitted = jsonCloneObject(context);
  const fittedGate = asObject(fitted.assistance_gate);
  const contract = asObject(fitted.compact_execution_contract);
  if (fittedGate && Array.isArray(fittedGate.reasons)) {
    fittedGate.reasons = fittedGate.reasons.slice(0, 3);
  }
  const negativeTransferEvidence = asObject(fitted.prior_negative_transfer_evidence);
  if (negativeTransferEvidence && Array.isArray(negativeTransferEvidence.reasons)) {
    negativeTransferEvidence.reasons = negativeTransferEvidence.reasons.slice(0, 3);
  }
  if (!contract) return fitted;

  contract.experience_adaptation_trace = null;
  contract.action_intelligence = null;
  contract.runtime_entropy_profile = null;
  contract.tool_hint = null;
  if (Array.isArray(contract.operating_rules)) contract.operating_rules = contract.operating_rules.slice(0, 2);
  const negativeTransferControl = asObject(contract.negative_transfer_control);
  if (negativeTransferControl && Array.isArray(negativeTransferControl.reasons)) {
    negativeTransferControl.reasons = negativeTransferControl.reasons.slice(0, 3);
  }
  const firstAction = asObject(contract.first_action);
  if (firstAction) {
    contract.first_action = {
      action: stringValue(firstAction.action),
      tool_name: stringValue(firstAction.tool_name),
      file_path: stringValue(firstAction.file_path),
    };
  }
  const actionRetrieval = asObject(contract.action_retrieval);
  if (actionRetrieval) {
    contract.action_retrieval = {
      tool_source_kind: stringValue(actionRetrieval.tool_source_kind),
      selected_tool: stringValue(actionRetrieval.selected_tool),
      recommended_file_path: stringValue(actionRetrieval.recommended_file_path),
      uncertainty: asObject(actionRetrieval.uncertainty)
        ? {
            level: stringValue(asObject(actionRetrieval.uncertainty)?.level),
            recommended_actions: stringList(asObject(actionRetrieval.uncertainty)?.recommended_actions).slice(0, 2),
          }
        : null,
    };
  }
  if (Array.isArray(contract.known_failures_to_avoid)) {
    contract.known_failures_to_avoid = contract.known_failures_to_avoid.slice(0, 1).map((entry) => {
      const failure = asObject(entry) ?? {};
      return {
        status: stringValue(failure.status),
        verifier_exit_code: failure.verifier_exit_code,
        assertion_message: compactOneLine(stringValue(failure.assertion_message) ?? "", 140),
        diff_line: compactOneLine(stringValue(failure.diff_line) ?? "", 80),
        stack_anchor: compactOneLine(stringValue(failure.stack_anchor) ?? "", 120),
      };
    });
  }
  if (compactContextJsonLength(fitted) <= budget) return fitted;

  if (Array.isArray(contract.known_failures_to_avoid)) contract.known_failures_to_avoid = [];
  if (Array.isArray(contract.semantic_invariants)) contract.semantic_invariants = contract.semantic_invariants.slice(0, 3);
  if (Array.isArray(contract.forbidden_edit_files)) contract.forbidden_edit_files = contract.forbidden_edit_files.slice(0, 4);
  if (Array.isArray(contract.verifier_commands)) contract.verifier_commands = contract.verifier_commands.slice(0, 1);
  if (negativeTransferControl) {
    negativeTransferControl.suppress_surfaces = [];
    negativeTransferControl.reasons = stringList(negativeTransferControl.reasons).slice(0, 2);
  }
  if (compactContextJsonLength(fitted) <= budget) return fitted;

  if (Array.isArray(contract.forbidden_edit_files)) contract.forbidden_edit_files = [];
  if (Array.isArray(contract.verifier_commands)) contract.verifier_commands = [];
  contract.known_failures_to_avoid = [];
  contract.action_retrieval = null;
  contract.action_intelligence = null;
  contract.experience_adaptation_trace = null;
  contract.tool_hint = null;
  if (Array.isArray(contract.operating_rules)) contract.operating_rules = contract.operating_rules.slice(0, 1);
  if (compactContextJsonLength(fitted) <= budget) return fitted;

  fitted.compact_execution_contract = {
    schema_version: contract.schema_version,
    mode: contract.mode,
    authority: contract.authority,
    target_files: Array.isArray(contract.target_files) ? contract.target_files : [],
    semantic_invariants: Array.isArray(contract.semantic_invariants) ? contract.semantic_invariants : [],
    negative_transfer_control: negativeTransferControl
      ? {
          authority: negativeTransferControl.authority,
          prior_negative_transfer_count: negativeTransferControl.prior_negative_transfer_count,
          recommended_next_assistance_mode: negativeTransferControl.recommended_next_assistance_mode,
        }
      : null,
  };
  return fitted;
}

function renderedCompactAionisContext(context: JsonObject | null): JsonObject | null {
  const compact = compactAionisContext(context);
  if (!compact) return null;
  return fitCompactContextToBudget(compact);
}

function buildProblemStatement(task: EvalTask, aionisContext: JsonObject | null): string {
  const lines = [
    "# Task",
    "",
    task.prompt.trim(),
    "",
    "# External verifier",
    "",
    "The evaluation harness will run this exact verifier after you submit the patch:",
    "",
    expandPlaceholders(task.verifier.command, { AIONIS_ROOT, WORKSPACE: "<workspace>", TASK_ID: task.id, OUT_DIR: "<out>" }),
    "",
    "This verifier path may not exist inside the SWE-agent runtime. If it is unavailable, do not search for host paths or repair the harness. Run repository-local checks or focused source-level checks that are available in the runtime, then submit; the harness will execute the external verifier on the final workspace.",
  ];
  const expected = task.expected ?? {};
  if ((expected.allowed_edit_files ?? expected.target_files)?.length || expected.forbidden_edit_files?.length || expected.acceptance_checks?.length) {
    lines.push("", "# Runtime-visible task contract", "");
    if ((expected.allowed_edit_files ?? expected.target_files)?.length) {
      lines.push(`Allowed edit files: ${(expected.allowed_edit_files ?? expected.target_files ?? []).join(", ")}`);
    }
    if (expected.forbidden_edit_files?.length) lines.push(`Forbidden edit files: ${expected.forbidden_edit_files.join(", ")}`);
    if (expected.acceptance_checks?.length) lines.push(`Acceptance checks: ${expected.acceptance_checks.join(" | ")}`);
    for (const rule of expected.anti_shortcut_rules ?? []) lines.push(`- ${rule}`);
  }
  const compactContext = renderedCompactAionisContext(aionisContext);
  const compactGate = asObject(compactContext?.assistance_gate);
  const compactMode = stringValue(compactGate?.mode);
  if (compactContext && compactMode !== "no_op") {
    lines.push(
      "",
      "# Aionis Runtime context",
      "",
      "The following is a compact advisory contract from Aionis Runtime. Use it to reduce repeated discovery and to choose safer verification strategy. It is not a command executor, not a source-code patch, and not proof of correctness. If semantic invariants are present, treat them as scoped verifier-passing evidence to consider, not as commands to copy blindly. Verify the final result with the required verifier.",
      "",
      "```json",
      JSON.stringify(compactContext, null, 2),
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildVerifierRepairProblemStatement(args: {
  task: EvalTask;
  aionisContext: JsonObject | null;
  passIndex: number;
  previousPass: AgentPass;
  previousPasses: AgentPass[];
}): string {
  const previousFailureSignature = failureEvidenceSignature(args.previousPass.verifier_failure_evidence);
  const repeatedCurrentFailureCount = previousFailureSignature
    ? args.previousPasses
      .map((pass) => failureEvidenceSignature(pass.verifier_failure_evidence))
      .filter((signature) => signature === previousFailureSignature).length
    : 0;
  const stagnationDetected = repeatedCurrentFailureCount >= 2;
  const repairPacket: JsonObject = {
    schema_version: "swe_agent_verifier_feedback_repair_packet_v1",
    authority: "verifier_feedback_for_agent_repair",
    pass_index: args.passIndex,
    previous_pass_index: args.previousPass.pass_index,
    verifier_command: expandPlaceholders(args.task.verifier.command, {
      AIONIS_ROOT,
      WORKSPACE: "<workspace>",
      TASK_ID: args.task.id,
      OUT_DIR: "<out>",
    }),
    previous_changed_files: args.previousPass.changed_files,
    previous_verifier_exit_code: args.previousPass.verifier.exit_code,
    verifier_failure_evidence: args.previousPass.verifier_failure_evidence,
    failure_history: args.previousPasses
      .filter((pass) => pass.verifier_failure_evidence)
      .slice(-3)
      .map((pass) => ({
        pass_index: pass.pass_index,
        assertion_message: stringValue(pass.verifier_failure_evidence?.assertion_message),
        diff_line: stringValue(pass.verifier_failure_evidence?.diff_line),
        stack_anchor: stringValue(pass.verifier_failure_evidence?.stack_anchor),
      })),
    repeated_current_failure_count: repeatedCurrentFailureCount,
    stagnation_detected: stagnationDetected,
    repair_contract: [
      "You are continuing in the same workspace after a verifier failure.",
      "Do not restart from scratch or broaden the task unless current files disprove the failure evidence.",
      "Inspect the current edited target files and repair the failing verifier contract.",
      "The LLM/Agent owns semantic repair; Aionis only supplies evidence and boundaries.",
      "Do not modify package metadata, dependency files, documentation, or forbidden files unless the original task explicitly allows them.",
      "If repository-local dependency launchers fail due runtime transfer or symlink issues, do not repair dependencies; use focused source-level checks and submit for the external verifier.",
      ...(stagnationDetected
        ? ["The same verifier failure has repeated. Change repair hypothesis before editing; identify why the previous patch still triggers the same assertion."]
        : []),
    ],
  };

  const lines = [
    "# Verifier feedback repair pass",
    "",
    args.task.prompt.trim(),
    "",
    "The previous Agent submission failed the external verifier. You are continuing in the same repository workspace with the previous edits already applied.",
    "",
    "# Structured verifier failure evidence",
    "",
    "Use this packet to focus the repair. It is evidence, not a source-code patch.",
    "",
    "```json",
    JSON.stringify(repairPacket, null, 2),
    "```",
    "",
    "# External verifier",
    "",
    "The evaluation harness will rerun this exact verifier after you submit:",
    "",
    expandPlaceholders(args.task.verifier.command, { AIONIS_ROOT, WORKSPACE: "<workspace>", TASK_ID: args.task.id, OUT_DIR: "<out>" }),
    "",
    "This verifier path may not exist inside the SWE-agent runtime. If it is unavailable, do not search for host paths or repair the harness. Run repository-local checks or focused source-level checks that are available in the runtime, then submit; the harness will execute the external verifier on the final workspace.",
  ];

  const expected = args.task.expected ?? {};
  if ((expected.allowed_edit_files ?? expected.target_files)?.length || expected.forbidden_edit_files?.length || expected.acceptance_checks?.length) {
    lines.push("", "# Runtime-visible task contract", "");
    if ((expected.allowed_edit_files ?? expected.target_files)?.length) {
      lines.push(`Allowed edit files: ${(expected.allowed_edit_files ?? expected.target_files ?? []).join(", ")}`);
    }
    if (expected.forbidden_edit_files?.length) lines.push(`Forbidden edit files: ${expected.forbidden_edit_files.join(", ")}`);
    if (expected.acceptance_checks?.length) lines.push(`Acceptance checks: ${expected.acceptance_checks.join(" | ")}`);
    for (const rule of expected.anti_shortcut_rules ?? []) lines.push(`- ${rule}`);
  }

  const compactContext = renderedCompactAionisContext(args.aionisContext);
  const compactGate = asObject(compactContext?.assistance_gate);
  const compactMode = stringValue(compactGate?.mode);
  if (compactContext && compactMode !== "no_op") {
    lines.push(
      "",
      "# Aionis Runtime context",
      "",
      "The following remains advisory Runtime context. It is not a semantic patch and does not override current verifier evidence.",
      "",
      "```json",
      JSON.stringify(compactContext, null, 2),
      "```",
    );
  }

  return `${lines.join("\n")}\n`;
}

function assertRenderedAionisContextValid(problemStatement: string): void {
  const match = problemStatement.match(/# Aionis Runtime context[\s\S]*?```json\n([\s\S]*?)\n```/);
  if (!match) return;
  JSON.parse(match[1]!);
}

function mergeSweAgentConfig(suite: EvalSuite, task: EvalTask, cli: CliArgs): SweAgentConfig {
  return {
    deployment: "local",
    ...(suite.swe_agent ?? {}),
    ...(task.swe_agent ?? {}),
    ...(cli.sweagentBin ? { command: cli.sweagentBin } : {}),
    ...(cli.model ? { model: cli.model } : {}),
    ...(cli.costLimit !== null ? { cost_limit: cli.costLimit } : {}),
  };
}

function workspaceRepoNameForLocalDeployment(workspaceDir: string): string {
  return path.resolve(workspaceDir).replace(/^\/+/, "");
}

function focusedSweAgentDeployment(config: SweAgentConfig): "local" | "custom" {
  const deployment = (config as { deployment?: unknown }).deployment ?? "local";
  if (deployment !== "local" && deployment !== "custom") {
    throw new Error(`focused SWE-agent eval supports local or custom deployment only, got ${String(deployment)}`);
  }
  return deployment;
}

function focusedSweAgentExtraArgs(extraArgs: string[] | undefined): string[] {
  const blockedLocalKeys = new Set([
    "--env.deployment.image",
    "--env.deployment.pull",
    "--env.deployment.docker_args",
    "--env.deployment.platform",
    "--env.deployment.python_standalone_dir",
    "--env.deployment.container_runtime",
    "--env.deployment.remove_images",
    "--env.deployment.remove_container",
    "--env.deployment.port",
    "--env.repo.path",
    "--env.repo.github_url",
  ]);
  const args = extraArgs ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const key = arg.split("=", 1)[0]!;
    if (blockedLocalKeys.has(key)) {
      throw new Error(`focused SWE-agent eval does not accept Docker/repo deployment arg ${key}`);
    }
  }
  return args;
}

function pythonForSweAgentCommand(command: string | undefined): string {
  if (!command) return "python3";
  const candidate = path.join(path.dirname(command), "python");
  return fs.existsSync(candidate) ? candidate : "python3";
}

async function runSweAgent(args: {
  suite: EvalSuite;
  task: EvalTask;
  cli: CliArgs;
  arm: "baseline" | "aionis";
  workspaceDir: string;
  armOutDir: string;
  problemFile: string;
}): Promise<CommandResult> {
  const config = mergeSweAgentConfig(args.suite, args.task, args.cli);
  const deployment = focusedSweAgentDeployment(config);
  const localRuntimeRoot = deployment === "local" ? path.join(args.armOutDir, "local-runtime-root") : null;
  const env = {
    ...(config.env ?? {}),
    SWE_AGENT_TRAJECTORY_DIR: path.join(args.armOutDir, "trajectories"),
    ...(localRuntimeRoot ? { AIONIS_SWE_AGENT_LOCAL_ROOT: localRuntimeRoot } : {}),
  };
  await ensureDir(env.SWE_AGENT_TRAJECTORY_DIR);
  if (localRuntimeRoot) await ensureDir(localRuntimeRoot);
  const values = placeholders(args.task, args.workspaceDir, args.armOutDir);
  if (config.command_template) {
    const command = expandPlaceholders(config.command_template, {
      ...values,
      PROBLEM_FILE: args.problemFile,
      SWE_AGENT_OUTPUT_DIR: args.armOutDir,
      MODEL: config.model ?? DEFAULT_MODEL,
    });
    return await runShell(command, {
      cwd: args.workspaceDir,
      timeoutMs: config.timeout_ms ?? DEFAULT_SWAGENT_TIMEOUT_MS,
      env,
    });
  }
  const localWrapper = path.join(AIONIS_ROOT, "scripts", "swe-agent-eval", "local-sweagent-wrapper.py");
  const sweagent = deployment === "local" ? pythonForSweAgentCommand(config.command) : config.command ?? "sweagent";
  const runArgs = deployment === "local" ? [localWrapper, "run"] : ["run"];
  for (const file of config.config_files ?? []) {
    runArgs.push("--config", path.resolve(AIONIS_ROOT, file));
  }
  runArgs.push(`--agent.model.name=${config.model ?? DEFAULT_MODEL}`);
  if (config.cost_limit !== undefined) {
    runArgs.push(`--agent.model.per_instance_cost_limit=${config.cost_limit}`);
  }
  if (Number.isFinite(Number(args.task.max_steps)) && Number(args.task.max_steps) > 0) {
    runArgs.push(`--agent.model.per_instance_call_limit=${Math.floor(Number(args.task.max_steps))}`);
  }
  if (deployment === "local") {
    runArgs.push("--env.deployment.type=local");
    runArgs.push("--env.repo.type=preexisting");
    runArgs.push(`--env.repo.repo_name=${workspaceRepoNameForLocalDeployment(args.workspaceDir)}`);
    runArgs.push("--env.repo.base_commit=HEAD");
  } else if (deployment === "custom") {
    runArgs.push(`--env.repo.path=${args.workspaceDir}`);
  }
  runArgs.push(`--problem_statement.path=${args.problemFile}`);
  runArgs.push(`--output_dir=${args.armOutDir}`);
  if (config.apply_patch_locally !== false) runArgs.push("--actions.apply_patch_locally=true");
  runArgs.push(...focusedSweAgentExtraArgs(config.extra_args));
  return await runCommand(sweagent, runArgs, {
    cwd: args.workspaceDir,
    timeoutMs: config.timeout_ms ?? DEFAULT_SWAGENT_TIMEOUT_MS,
    env,
  });
}

async function runVerifier(task: EvalTask, workspaceDir: string, outDir: string): Promise<CommandResult> {
  return await runShell(expandPlaceholders(task.verifier.command, placeholders(task, workspaceDir, outDir)), {
    cwd: workspaceDir,
    timeoutMs: task.verifier.timeout_ms ?? DEFAULT_VERIFIER_TIMEOUT_MS,
    env: { AIONIS_ROOT },
  });
}

async function gitDiff(workspaceDir: string): Promise<string> {
  const result = await runCommand("git", ["-C", workspaceDir, "diff", "--binary", "HEAD"], {
    cwd: AIONIS_ROOT,
    timeoutMs: 2 * 60 * 1000,
  });
  return result.stdout;
}

async function gitChangedFiles(workspaceDir: string): Promise<string[]> {
  const diff = await runCommand("git", ["-C", workspaceDir, "diff", "--name-only", "HEAD"], {
    cwd: AIONIS_ROOT,
    timeoutMs: 2 * 60 * 1000,
  });
  const status = await runCommand("git", ["-C", workspaceDir, "status", "--porcelain"], {
    cwd: AIONIS_ROOT,
    timeoutMs: 2 * 60 * 1000,
  });
  const diffFiles = diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const statusFiles = status.stdout.split("\n").map((line) => line.slice(3).trim()).filter(Boolean);
  return unique([...diffFiles, ...statusFiles]);
}

async function findTrajectoryFile(outputDir: string): Promise<string | null> {
  const candidates: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".traj")) candidates.push(full);
    }
  }
  await walk(outputDir);
  if (candidates.length === 0) return null;
  const stats = await Promise.all(candidates.map(async (file) => ({ file, stat: await fsp.stat(file) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats[0]?.file ?? null;
}

async function readTrajectory(file: string | null): Promise<TrajectoryStep[]> {
  if (!file) return [];
  const parsed = await readJsonFile<JsonObject>(file);
  const trajectory = Array.isArray(parsed.trajectory) ? parsed.trajectory : [];
  return trajectory.map((entry, index) => {
    const obj = asObject(entry) ?? {};
    return {
      step_index: index + 1,
      response: stringValue(obj.response),
      thought: stringValue(obj.thought),
      action: stringValue(obj.action),
      observation: stringValue(obj.observation),
      state: obj.state ?? null,
    };
  });
}

async function readTrajectoryModelStats(file: string | null): Promise<JsonObject | null> {
  if (!file) return null;
  const parsed = await readJsonFile<JsonObject>(file);
  return asObject(asObject(parsed.info)?.model_stats);
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function aggregateTrajectoryModelStats(stats: Array<JsonObject | null>): {
  input_tokens: number;
  output_tokens: number;
  api_calls: number;
  instance_cost: number;
} {
  type Accumulator = {
    input_tokens: number;
    output_tokens: number;
    api_calls: number;
    instance_cost: number;
  };
  const initial: Accumulator = {
    input_tokens: 0,
    output_tokens: 0,
    api_calls: 0,
    instance_cost: 0,
  };
  return stats.reduce<Accumulator>((acc, entry) => {
    if (!entry) return acc;
    acc.input_tokens += finiteNumber(entry.tokens_sent ?? entry.input_tokens ?? entry.prompt_tokens);
    acc.output_tokens += finiteNumber(entry.tokens_received ?? entry.output_tokens ?? entry.completion_tokens);
    acc.api_calls += finiteNumber(entry.api_calls);
    acc.instance_cost += finiteNumber(entry.instance_cost ?? entry.cost);
    return acc;
  }, initial);
}

async function existingNonEmptyFile(file: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function submittedPatchFromTrajectory(args: {
  trajectoryFile: string | null;
  outDir: string;
}): Promise<{ patchFile: string | null; source: SubmittedPatchSync["source"] }> {
  if (!args.trajectoryFile) return { patchFile: null, source: null };

  const siblingPatchFile = args.trajectoryFile.replace(/\.traj$/, ".patch");
  if (siblingPatchFile !== args.trajectoryFile && await existingNonEmptyFile(siblingPatchFile)) {
    return { patchFile: siblingPatchFile, source: "swe_agent_patch_file" };
  }

  const parsed = await readJsonFile<JsonObject>(args.trajectoryFile);
  const submission = stringValue(asObject(parsed.info)?.submission);
  if (!submission) return { patchFile: null, source: null };

  const patchFile = path.join(args.outDir, "submitted-from-trajectory.patch");
  await fsp.writeFile(patchFile, submission);
  return { patchFile, source: "trajectory_submission" };
}

async function syncSubmittedPatchToWorkspace(args: {
  workspaceDir: string;
  trajectoryFile: string | null;
  outDir: string;
}): Promise<SubmittedPatchSync> {
  const submittedPatch = await submittedPatchFromTrajectory({
    trajectoryFile: args.trajectoryFile,
    outDir: args.outDir,
  });
  const base: SubmittedPatchSync = {
    patch_file: submittedPatch.patchFile,
    source: submittedPatch.source,
    applied_to_workspace: false,
    skipped_reason: null,
    error: null,
  };
  if (!submittedPatch.patchFile) {
    return { ...base, skipped_reason: "no_submitted_patch" };
  }

  const hostPatch = await gitDiff(args.workspaceDir);
  if (hostPatch.trim().length > 0) {
    return { ...base, skipped_reason: "workspace_already_has_diff" };
  }

  const check = await runCommand("git", ["-C", args.workspaceDir, "apply", "--check", submittedPatch.patchFile], {
    cwd: AIONIS_ROOT,
    timeoutMs: 2 * 60 * 1000,
  });
  if (check.exit_code !== 0 || check.timed_out) {
    return {
      ...base,
      skipped_reason: "submitted_patch_not_applicable",
      error: compactOneLine(`${check.stderr}\n${check.stdout}`, 1000),
    };
  }

  const apply = await runCommand("git", ["-C", args.workspaceDir, "apply", submittedPatch.patchFile], {
    cwd: AIONIS_ROOT,
    timeoutMs: 2 * 60 * 1000,
  });
  if (apply.exit_code !== 0 || apply.timed_out) {
    return {
      ...base,
      skipped_reason: "submitted_patch_apply_failed",
      error: compactOneLine(`${apply.stderr}\n${apply.stdout}`, 1000),
    };
  }

  return { ...base, applied_to_workspace: true };
}

function toolNameFromAction(action: string | null): string {
  if (!action) return "unknown";
  const firstLine = action.trim().split("\n")[0] ?? "";
  const firstToken = firstLine.trim().split(/\s+/)[0] ?? "";
  if (!firstToken) return "unknown";
  if (firstToken === "open" || firstToken === "search_file" || firstToken === "search_dir" || firstToken === "find_file") return firstToken;
  if (firstToken === "edit" || firstToken === "submit") return firstToken;
  return "bash";
}

function firstActionMatchesExpected(steps: TrajectoryStep[], task: EvalTask): boolean {
  const keywords = task.expected?.first_action_keywords ?? task.expected?.target_files ?? [];
  if (keywords.length === 0) return false;
  const firstAction = steps.find((step) => step.action)?.action ?? "";
  return keywords.some((keyword) => firstAction.includes(keyword));
}

function nonLearningFailureReason(result: CommandResult): NonLearningFailureReason | null {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.signal) return "agent_process_signal_failure";
  if (result.timed_out) return "agent_timeout_failure";
  if ([
    "repeated format/blocklist/bash syntax errors",
    "bashincorrectsyntaxerror",
    "your output was not formatted correctly",
    "error (exit code 2) while checking bash command",
  ].some((needle) => text.includes(needle))) return "agent_action_format_failure";
  if ([
    "insufficient balance",
    "rate limit",
    "api key",
    "authentication",
    "unauthorized",
    "provider error",
    "litellm.authenticationerror",
    "litellm.rateLimitError".toLowerCase(),
  ].some((needle) => text.includes(needle))) return "provider_failure";
  if ([
    "modelconfigurationerror",
    "error calculating cost",
    "model isn't mapped yet",
    "invalid command line arguments",
    "unrecognized arguments",
    "settingserror",
    "usage: sweagent",
  ].some((needle) => text.includes(needle))) return "agent_framework_configuration_failure";
  if ([
    "failed to deserialize json body",
    "tools[0]",
    "unknown variant `custom`",
    "unknown variant custom",
  ].some((needle) => text.includes(needle))) return "agent_tool_protocol_failure";
  if ([
    "swerex-remote: not found",
    "no module named pip",
    "/usr/bin/env: ‘python’: no such file or directory",
    "/usr/bin/env: 'python': no such file or directory",
    "env: python: no such file or directory",
    "container process terminated",
    "failed to start runtime",
    "read-only file system",
    "oserror: [errno 30]",
    "externally-managed-environment",
  ].some((needle) => text.includes(needle))) return "agent_deployment_failure";
  return null;
}

function providerFailure(result: CommandResult): boolean {
  return nonLearningFailureReason(result) === "provider_failure";
}

function metricsForRun(args: {
  task: EvalTask;
  sweAgentResult: CommandResult;
  verifier: CommandResult;
  steps: TrajectoryStep[];
  changedFiles: string[];
  patch: string;
  priorRuns: AgentRun[];
  aionisContext: JsonObject | null;
  problemStatement: string;
  sweAgentResults?: CommandResult[];
  verifierResults?: CommandResult[];
  repairAttemptCount?: number;
  repairFailureEvidenceCount?: number;
  repairRepeatedFailureCount?: number;
  trajectoryModelStats?: Array<JsonObject | null>;
}): JsonObject {
  const expected = args.task.expected ?? {};
  const forbidden = new Set(expected.forbidden_edit_files ?? []);
  const targetFiles = new Set(expected.target_files ?? expected.allowed_edit_files ?? []);
  const actionTexts = args.steps.map((step) => step.action ?? "");
  const repeatedDiscoverySteps = actionTexts.filter((action) =>
    /(^|\n)\s*(ls|find|grep|rg|search_dir|find_file)\b/.test(action)
  ).length;
  const wrongFileTouches = targetFiles.size === 0
    ? 0
    : args.changedFiles.filter((file) => !targetFiles.has(file)).length;
  const forbiddenFileWrites = args.changedFiles.filter((file) => forbidden.has(file));
  const verifierPassed = args.verifier.exit_code === 0 && !args.verifier.timed_out;
  const rawQuarantineReason = nonLearningFailureReason(args.sweAgentResult)
    ?? (args.sweAgentResult.exit_code !== 0 && args.steps.length === 0 ? "agent_deployment_failure" : null);
  const producedTaskEvidence = args.changedFiles.length > 0 || args.patch.trim().length > 0;
  const quarantineReason = verifierPassed || (rawQuarantineReason === "agent_action_format_failure" && producedTaskEvidence)
    ? null
    : rawQuarantineReason;
  const invariantMetrics = semanticInvariantUptakeMetrics(
    args.task,
    args.patch,
    args.priorRuns,
    args.aionisContext,
    verifierPassed,
  );
  const compactContext = renderedCompactAionisContext(args.aionisContext);
  const assistanceGate = asObject(compactContext?.assistance_gate);
  const compactContract = asObject(compactContext?.compact_execution_contract);
  const actionRetrieval = asObject(compactContract?.action_retrieval);
  const actionIntelligence = asObject(compactContract?.action_intelligence);
  const actionIntelligenceGate = asObject(actionIntelligence?.pre_action_gate);
  const experienceTrace = asObject(compactContract?.experience_adaptation_trace);
  const experienceSources = asObject(experienceTrace?.experience_sources);
  const assistanceMode = stringValue(assistanceGate?.mode);
  const renderedContextCharCount = compactContext && assistanceMode !== "no_op"
    ? JSON.stringify(compactContext).length
    : 0;
  const compactContractCharCount = compactContract ? JSON.stringify(compactContract).length : 0;
  const contextBudgetChars = Number(assistanceGate?.context_budget_chars ?? 0);
  const sweAgentResults = args.sweAgentResults ?? [args.sweAgentResult];
  const verifierResults = args.verifierResults ?? [args.verifier];
  const repairAttemptCount = Math.max(0, Number(args.repairAttemptCount ?? 0));
  const totalSweAgentDurationMs = sweAgentResults.reduce((sum, result) => sum + result.duration_ms, 0);
  const totalVerifierDurationMs = verifierResults.reduce((sum, result) => sum + result.duration_ms, 0);
  const modelStats = aggregateTrajectoryModelStats(args.trajectoryModelStats ?? []);
  const aionisExperienceSourceCount = [
    experienceSources?.stable_workflow_count,
    experienceSources?.candidate_workflow_count,
    experienceSources?.trusted_pattern_count,
    experienceSources?.rehydration_candidate_count,
    experienceSources?.adaptive_guidance_candidate_count,
    experienceSources?.delegation_recommendation_count,
  ]
    .map((value) => Math.max(0, Number(value ?? 0)))
    .reduce((sum, value) => sum + value, 0);
  return {
    verifier_passed: verifierPassed,
    swe_agent_exit_code: args.sweAgentResult.exit_code,
    swe_agent_timed_out: args.sweAgentResult.timed_out,
    swe_agent_pass_count: sweAgentResults.length,
    verifier_attempt_count: verifierResults.length,
    repair_attempt_count: repairAttemptCount,
    repair_loop_used: repairAttemptCount > 0,
    repair_loop_succeeded: repairAttemptCount > 0 && verifierPassed,
    repair_failure_evidence_count: Math.max(0, Number(args.repairFailureEvidenceCount ?? 0)),
    repair_repeated_failure_count: Math.max(0, Number(args.repairRepeatedFailureCount ?? 0)),
    repair_stagnation_detected: Number(args.repairRepeatedFailureCount ?? 0) > 0,
    provider_failure: quarantineReason === "provider_failure",
    non_learning_failure_reason: quarantineReason,
    runtime_learning_quarantined: quarantineReason !== null,
    tool_step_count: args.steps.length,
    repeated_discovery_steps: repeatedDiscoverySteps,
    wrong_file_touches: wrongFileTouches,
    forbidden_file_writes: forbiddenFileWrites.length,
    forbidden_file_write_files: forbiddenFileWrites,
    edited_files: args.changedFiles,
    touched_files: args.changedFiles,
    first_action_correct: firstActionMatchesExpected(args.steps, args.task),
    first_write_step: null,
    first_target_write_step: null,
    first_write_latency_ms: null,
    first_target_write_latency_ms: null,
    input_tokens: modelStats.input_tokens,
    output_tokens: modelStats.output_tokens,
    llm_api_calls: modelStats.api_calls,
    llm_instance_cost: modelStats.instance_cost,
    time_to_finish_ms: totalSweAgentDurationMs + totalVerifierDurationMs,
    problem_statement_char_count: args.problemStatement.length,
    aionis_assistance_mode: assistanceMode,
    aionis_context_char_count: renderedContextCharCount,
    aionis_compact_contract_char_count: compactContractCharCount,
    aionis_context_budget_chars: contextBudgetChars,
    aionis_context_budget_exceeded: contextBudgetChars > 0 && renderedContextCharCount > contextBudgetChars,
    aionis_action_retrieval_present: actionRetrieval !== null,
    aionis_action_retrieval_tool_source_kind: stringValue(actionRetrieval?.tool_source_kind),
    aionis_action_intelligence_present: actionIntelligence !== null,
    aionis_action_intelligence_known_enough: actionIntelligenceGate?.known_enough === true,
    aionis_action_intelligence_authority_blocked: actionIntelligenceGate?.authority_blocked === true,
    aionis_experience_trace_present: experienceTrace !== null,
    aionis_experience_trace_activation_state: stringValue(experienceTrace?.activation_state),
    aionis_experience_source_count: aionisExperienceSourceCount,
    ...invariantMetrics,
  };
}

async function storeAionisOutcome(baseUrl: string, task: EvalTask, run: AgentRun): Promise<JsonObject> {
  const quarantineReason = stringValue(run.metrics.non_learning_failure_reason) ?? (
    run.status === "provider_failure" ? "provider_failure" : null
  );
  if (quarantineReason) {
    return {
      persisted: false,
      runtime_learning_quarantined: true,
      runtime_learning_quarantine_reason: quarantineReason,
      run_id: run.run_id,
      arm: run.arm,
    };
  }
  const base = runtimePayloadBase(task, run.run_id);
  const semanticInvariants = extractPatchSemanticInvariants(task, run.patch, run).slice(0, 40);
  const semanticInvariantSummary = semanticInvariants
    .slice(0, 8)
    .map((invariant) => {
      const kind = stringValue(invariant.kind) ?? "invariant";
      const file = stringValue(invariant.file) ?? "unknown";
      const value = stringValue(invariant.normalized_value) ?? "";
      return `${kind} ${file}: ${value}`;
    })
    .join("; ");
  const started = await postRuntime(baseUrl, "/v1/memory/replay/run/start", {
    ...base,
    goal: task.prompt,
    context_snapshot_ref: run.aionis_context ? `aionis-swe-agent-context:${run.run_id}` : undefined,
    metadata: {
      suite_source: "swe_agent_eval",
      agent_framework: "swe-agent",
      arm: run.arm,
      trajectory_file: run.trajectory_file,
    },
  });
  const replayRunId = stringValue(started.run_id) ?? run.run_id;
  const replaySteps: JsonObject[] = [];
  for (const step of run.trajectory_steps) {
    const before = await postRuntime(baseUrl, "/v1/memory/replay/step/before", {
      ...base,
      run_id: replayRunId,
      step_index: step.step_index,
      tool_name: toolNameFromAction(step.action),
      tool_input: {
        action: step.action,
        thought: step.thought,
      },
      safety_level: toolNameFromAction(step.action) === "edit" ? "needs_confirm" : "auto_ok",
      metadata: { arm: run.arm, response: truncate(step.response ?? "", 2000) },
    });
    const after = await postRuntime(baseUrl, "/v1/memory/replay/step/after", {
      ...base,
      run_id: replayRunId,
      step_id: stringValue(before.step_id) ?? undefined,
      step_index: step.step_index,
      status: "success",
      output_signature: truncate(step.observation ?? "", 4000),
      artifact_refs: stringList(run.metrics.edited_files).map((file) => `workspace://${run.run_id}/${file}`),
      metadata: { arm: run.arm, state: step.state ?? null },
    });
    replaySteps.push({ before, after });
  }
  const ended = await postRuntime(baseUrl, "/v1/memory/replay/run/end", {
    ...base,
    run_id: replayRunId,
    status: run.metrics.verifier_passed === true ? "success" : "failed",
    summary: run.summary,
    success_criteria: {
      verifier_command: task.verifier.command,
      verifier_passed: run.metrics.verifier_passed === true,
      acceptance_checks: task.expected?.acceptance_checks ?? [task.verifier.command],
    },
    metrics: run.metrics,
    metadata: { arm: run.arm, agent_framework: "swe-agent" },
  });
  const compile = run.metrics.verifier_passed === true && run.trajectory_steps.length > 0
    ? await postRuntime(baseUrl, "/v1/memory/replay/playbooks/compile_from_run", {
        ...base,
        run_id: replayRunId,
        success_criteria: {
          verifier_command: task.verifier.command,
          verifier_passed: true,
        },
        allow_partial: false,
        risk_profile: "medium",
        metadata: { arm: run.arm, agent_framework: "swe-agent" },
      })
    : null;
  const targetFiles = stringList(run.metrics.edited_files).length > 0
    ? stringList(run.metrics.edited_files)
    : task.expected?.target_files ?? [];
  const handoff = await postRuntime(baseUrl, "/v1/handoff/store", {
    tenant_id: base.tenant_id,
    scope: base.scope,
    actor: base.actor,
    handoff_kind: "task_handoff",
    task_family: task.task_family ?? undefined,
    anchor: `swe-agent-eval:${task.id}:${run.arm}`,
    summary: run.summary,
    handoff_text: `SWE-agent ${run.arm} run for ${task.id}: ${run.summary}${semanticInvariantSummary ? `; semantic invariants: ${semanticInvariantSummary}` : ""}`,
    memory_lane: "private",
    target_files: targetFiles,
    acceptance_checks: task.expected?.acceptance_checks ?? [task.verifier.command],
    next_action: run.metrics.verifier_passed === true
      ? "Reuse as scoped execution evidence only when task family, target files, and verifier match."
      : "Treat as failed execution evidence; inspect verifier output before reuse.",
    must_keep: task.expected?.forbidden_edit_files ?? [],
    execution_result_summary: {
      status: run.status,
      verifier_passed: run.metrics.verifier_passed === true,
      metrics: run.metrics,
      verifier: {
        command: run.verifier.command,
        exit_code: run.verifier.exit_code,
        timed_out: run.verifier.timed_out,
        stdout_tail: truncate(run.verifier.stdout, 4000),
        stderr_tail: truncate(run.verifier.stderr, 4000),
      },
      semantic_invariants: semanticInvariants,
    },
    execution_evidence: [
      {
        schema_version: "swe_agent_verifier_evidence_v1",
        kind: "verifier",
        arm: run.arm,
        command: run.verifier.command,
        passed: run.metrics.verifier_passed === true,
        exit_code: run.verifier.exit_code,
        stdout_tail: truncate(run.verifier.stdout, 4000),
        stderr_tail: truncate(run.verifier.stderr, 4000),
      },
      {
        schema_version: "swe_agent_patch_semantic_invariants_v1",
        kind: "patch_semantic_invariants",
        arm: run.arm,
        authority: run.metrics.verifier_passed === true
          ? "scoped_prior_success_evidence"
          : "failed_run_observation",
        verifier_passed: run.metrics.verifier_passed === true,
        invariant_count: semanticInvariants.length,
        invariants: semanticInvariants,
      },
    ],
    execution_packet_v1: {
      version: 1,
      state_id: run.run_id,
      current_stage: "patch",
      active_role: "patch",
      task_brief: task.prompt,
      target_files: targetFiles,
      next_action: run.metrics.verifier_passed === true
        ? "Scoped replay candidate; require matching verifier before reuse."
        : "Failed evidence; do not promote without successful rerun.",
      hard_constraints: [
        "Use real verifier evidence only.",
        ...(task.expected?.anti_shortcut_rules ?? []),
      ],
      accepted_facts: run.metrics.verifier_passed === true ? [`Verifier passed: ${task.verifier.command}`] : [],
      rejected_paths: [],
      pending_validations: run.metrics.verifier_passed === true ? [] : [task.verifier.command],
      unresolved_blockers: run.metrics.verifier_passed === true ? [] : ["SWE-agent run did not satisfy verifier"],
      rollback_notes: [],
      review_contract: null,
      resume_anchor: {
        anchor: `swe-agent-eval:${task.id}:${run.arm}`,
        file_path: targetFiles[0] ?? null,
        symbol: null,
        repo_root: run.workspace_dir,
      },
      artifact_refs: targetFiles.map((file) => `workspace://${run.run_id}/${file}`),
      evidence_refs: [`verifier://${run.run_id}`],
      acceptance_checks: task.expected?.acceptance_checks ?? [task.verifier.command],
      verifier_command: task.verifier.command,
      contract_trust: run.metrics.verifier_passed === true ? "authoritative" : "advisory",
    },
  });
  const maintenance = await postRuntime(baseUrl, "/v1/memory/runtime-maintenance/run", {
    tenant_id: base.tenant_id,
    scope: base.scope,
    actor: base.actor,
    mode: "apply",
    surfaces: ["workflow", "pattern", "policy", "forgetting"],
    limit: 100,
    max_mutations: 50,
    snapshot_limit: 500,
  });
  const introspection = await postRuntime(baseUrl, "/v1/memory/execution/introspect", {
    tenant_id: base.tenant_id,
    scope: base.scope,
    consumer_agent_id: base.consumer_agent_id,
    run_id: replayRunId,
    limit: 20,
  });
  return {
    persisted: true,
    runtime_learning_quarantined: false,
    run_id: run.run_id,
    arm: run.arm,
    semantic_invariant_count: semanticInvariants.length,
    started,
    replay_steps: replaySteps,
    ended,
    compile,
    handoff,
    maintenance,
    introspection,
  };
}

function maxAgentPassCount(task: EvalTask, arm: "baseline" | "aionis"): number {
  const configured = arm === "aionis"
    ? task.aionis_attempts ?? task.max_repair_attempts
    : task.baseline_attempts;
  return Math.max(1, Math.min(5, Math.floor(Number(configured ?? 1))));
}

function shouldStopBeforeRepair(sweAgentCommand: CommandResult): boolean {
  const reason = nonLearningFailureReason(sweAgentCommand);
  return reason === "provider_failure"
    || reason === "agent_deployment_failure"
    || reason === "agent_framework_configuration_failure"
    || reason === "agent_process_signal_failure"
    || reason === "agent_tool_protocol_failure";
}

function verifierSkipReasonAfterAgentFailure(
  sweAgentCommand: CommandResult,
  changedFiles: string[],
): NonLearningFailureReason | null {
  const reason = nonLearningFailureReason(sweAgentCommand);
  if (!reason) return null;
  return changedFiles.length === 0 ? reason : null;
}

function skippedVerifierResult(args: {
  task: EvalTask;
  workspaceDir: string;
  outDir: string;
  reason: NonLearningFailureReason;
}): CommandResult {
  return {
    command: `${expandPlaceholders(args.task.verifier.command, placeholders(args.task, args.workspaceDir, args.outDir))} (skipped: ${args.reason})`,
    cwd: args.workspaceDir,
    exit_code: null,
    signal: null,
    timed_out: false,
    duration_ms: 0,
    stdout: "",
    stderr: `Verifier skipped because SWE-agent ended with ${args.reason} before producing changed files.`,
  };
}

function aggregateCommandResults(results: CommandResult[], label: string): CommandResult {
  if (results.length === 0) {
    return {
      command: label,
      cwd: AIONIS_ROOT,
      exit_code: null,
      signal: null,
      timed_out: false,
      duration_ms: 0,
      stdout: "",
      stderr: "",
    };
  }
  if (results.length === 1) return results[0]!;
  const final = results[results.length - 1]!;
  return {
    command: `${label}: ${results.map((result) => result.command).join(" && ")}`,
    cwd: final.cwd,
    exit_code: final.exit_code,
    signal: final.signal,
    timed_out: results.some((result) => result.timed_out),
    duration_ms: results.reduce((sum, result) => sum + result.duration_ms, 0),
    stdout: results.map((result, index) => `--- pass ${index + 1} stdout ---\n${result.stdout}`).join("\n"),
    stderr: results.map((result, index) => `--- pass ${index + 1} stderr ---\n${result.stderr}`).join("\n"),
  };
}

async function runAgentPass(args: {
  suite: EvalSuite;
  task: EvalTask;
  cli: CliArgs;
  arm: "baseline" | "aionis";
  workspaceDir: string;
  passIndex: number;
  kind: "initial" | "repair";
  problemFile: string;
  passOutDir: string;
}): Promise<AgentPass> {
  await ensureDir(args.passOutDir);
  const sweAgentCommand = await runSweAgent({
    suite: args.suite,
    task: args.task,
    cli: args.cli,
    arm: args.arm,
    workspaceDir: args.workspaceDir,
    armOutDir: args.passOutDir,
    problemFile: args.problemFile,
  });
  const trajectoryFile = await findTrajectoryFile(args.passOutDir);
  const submittedPatchSync = await syncSubmittedPatchToWorkspace({
    workspaceDir: args.workspaceDir,
    trajectoryFile,
    outDir: args.passOutDir,
  });
  const [patch, changedFiles] = await Promise.all([
    gitDiff(args.workspaceDir),
    gitChangedFiles(args.workspaceDir),
  ]);
  const [trajectorySteps, modelStats] = await Promise.all([
    readTrajectory(trajectoryFile),
    readTrajectoryModelStats(trajectoryFile),
  ]);
  const verifierSkipReason = verifierSkipReasonAfterAgentFailure(sweAgentCommand, changedFiles);
  const verifier = verifierSkipReason
    ? skippedVerifierResult({
      task: args.task,
      workspaceDir: args.workspaceDir,
      outDir: args.passOutDir,
      reason: verifierSkipReason,
    })
    : await runVerifier(args.task, args.workspaceDir, args.passOutDir);
  const verifierPassed = verifier.exit_code === 0 && !verifier.timed_out;
  const pass: AgentPass = {
    pass_index: args.passIndex,
    kind: args.kind,
    problem_file: args.problemFile,
    output_dir: args.passOutDir,
    swe_agent_command: sweAgentCommand,
    verifier,
    trajectory_file: trajectoryFile,
    trajectory_steps: trajectorySteps,
    patch,
    changed_files: changedFiles,
    submitted_patch_sync: submittedPatchSync,
    verifier_failure_evidence: verifierSkipReason || verifierPassed ? null : verifierFailureEvidence(verifier),
    model_stats: modelStats,
  };
  await fsp.writeFile(path.join(args.passOutDir, "patch.diff"), patch);
  await writeJsonFile(path.join(args.passOutDir, "pass.json"), serializeAgentPass(pass));
  return pass;
}

async function runAgentRepairLoop(args: {
  suite: EvalSuite;
  task: EvalTask;
  cli: CliArgs;
  arm: "baseline" | "aionis";
  workspaceDir: string;
  armOutDir: string;
  aionisContext: JsonObject | null;
  initialProblemStatement: string;
}): Promise<RepairLoopSummary> {
  const passes: AgentPass[] = [];
  const maxPasses = maxAgentPassCount(args.task, args.arm);
  let problemStatement = args.initialProblemStatement;
  let problemFile = path.join(args.armOutDir, "problem.md");
  let finalProblemFile = problemFile;

  for (let passIndex = 0; passIndex < maxPasses; passIndex += 1) {
    assertRenderedAionisContextValid(problemStatement);
    await fsp.writeFile(problemFile, problemStatement);
    finalProblemFile = problemFile;
    const pass = await runAgentPass({
      suite: args.suite,
      task: args.task,
      cli: args.cli,
      arm: args.arm,
      workspaceDir: args.workspaceDir,
      passIndex,
      kind: passIndex === 0 ? "initial" : "repair",
      problemFile,
      passOutDir: path.join(args.armOutDir, passIndex === 0 ? "initial" : `repair-${passIndex}`),
    });
    passes.push(pass);

    const verifierPassed = pass.verifier.exit_code === 0 && !pass.verifier.timed_out;
    if (verifierPassed || passIndex + 1 >= maxPasses || shouldStopBeforeRepair(pass.swe_agent_command)) break;

    problemFile = path.join(args.armOutDir, `repair-${passIndex + 1}.problem.md`);
    problemStatement = buildVerifierRepairProblemStatement({
      task: args.task,
      aionisContext: args.aionisContext,
      passIndex: passIndex + 1,
      previousPass: pass,
      previousPasses: passes,
    });
  }

  const finalPass = passes[passes.length - 1];
  if (!finalPass) throw new Error(`${args.task.id}: repair loop did not execute any Agent pass`);
  const trajectorySteps = passes.flatMap((pass) => pass.trajectory_steps)
    .map((step, index) => ({ ...step, step_index: index + 1 }));
  return {
    swe_agent_command: aggregateCommandResults(passes.map((pass) => pass.swe_agent_command), `${args.arm} swe-agent passes`),
    verifier: finalPass.verifier,
    patch: finalPass.patch,
    changed_files: finalPass.changed_files,
    trajectory_file: finalPass.trajectory_file,
    trajectory_steps: trajectorySteps,
    passes,
    final_problem_file: finalProblemFile,
  };
}

async function runArm(args: {
  suite: EvalSuite;
  task: EvalTask;
  cli: CliArgs;
  arm: "baseline" | "aionis";
  taskOutDir: string;
  priorRuns: AgentRun[];
  priorTaskReports: JsonObject[];
}): Promise<AgentRun> {
  const runId = crypto.randomUUID();
  const armOutDir = path.join(args.taskOutDir, args.arm);
  await ensureDir(armOutDir);
  const workspaceDir = await cloneWorkspace(args.task, args.arm, args.taskOutDir);
  await runSetupCommands(args.task, workspaceDir);
  const aionisContext = args.arm === "aionis" && args.cli.runtimeUrl
    ? await buildAionisContext(args.cli.runtimeUrl, args.task, runId, args.priorRuns, args.priorTaskReports)
    : null;
  const problemStatement = buildProblemStatement(args.task, aionisContext);
  const repairLoop = await runAgentRepairLoop({
    suite: args.suite,
    task: args.task,
    cli: args.cli,
    arm: args.arm,
    workspaceDir,
    armOutDir,
    aionisContext,
    initialProblemStatement: problemStatement,
  });
  const sweAgentCommand = repairLoop.swe_agent_command;
  const verifier = repairLoop.verifier;
  const patch = repairLoop.patch;
  const changedFiles = repairLoop.changed_files;
  const trajectoryFile = repairLoop.trajectory_file;
  const trajectorySteps = repairLoop.trajectory_steps;
  const metrics = metricsForRun({
    task: args.task,
    sweAgentResult: sweAgentCommand,
    verifier,
    steps: trajectorySteps,
    changedFiles,
    patch,
    priorRuns: args.priorRuns,
    aionisContext,
    problemStatement: await fsp.readFile(repairLoop.final_problem_file, "utf8"),
    sweAgentResults: repairLoop.passes.map((pass) => pass.swe_agent_command),
    verifierResults: repairLoop.passes.map((pass) => pass.verifier),
    repairAttemptCount: Math.max(0, repairLoop.passes.length - 1),
    repairFailureEvidenceCount: repairLoop.passes.filter((pass) => pass.verifier_failure_evidence).length,
    repairRepeatedFailureCount: repeatedFailureCount(repairLoop.passes),
    trajectoryModelStats: repairLoop.passes.map((pass) => pass.model_stats),
  });
  const quarantineReason = stringValue(metrics.non_learning_failure_reason);
  const status: AgentRun["status"] =
    quarantineReason === "provider_failure" ? "provider_failure"
      : metrics.verifier_passed === true ? "success"
        : sweAgentCommand.exit_code !== 0 ? "agent_failure"
          : "failed";
  const summary = `${args.arm} SWE-agent run ${status}; verifier_passed=${metrics.verifier_passed === true}; edited_files=${changedFiles.join(", ") || "none"}`;
  const run: AgentRun = {
    arm: args.arm,
    run_id: runId,
    task_id: args.task.id,
    workspace_dir: workspaceDir,
    output_dir: armOutDir,
    problem_file: repairLoop.final_problem_file,
    swe_agent_command: sweAgentCommand,
    verifier,
    trajectory_file: trajectoryFile,
    trajectory_steps: trajectorySteps,
    patch,
    status,
    summary,
    aionis_context: aionisContext,
    aionis_store: null,
    metrics,
    repair_passes: repairLoop.passes,
  };
  await fsp.writeFile(path.join(armOutDir, "patch.diff"), patch);
  await writeJsonFile(path.join(armOutDir, "run.json"), serializeRun(run));
  if (args.cli.runtimeUrl) {
    run.aionis_store = await storeAionisOutcome(args.cli.runtimeUrl, args.task, run);
    await writeJsonFile(path.join(armOutDir, "aionis-store.json"), run.aionis_store);
    await writeJsonFile(path.join(armOutDir, "run.json"), serializeRun(run));
  }
  if (!args.cli.keepWorkspaces) {
    await fsp.rm(workspaceDir, { recursive: true, force: true });
  }
  return run;
}

function serializeCommand(result: CommandResult): JsonObject {
  return {
    command: result.command,
    cwd: result.cwd,
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    duration_ms: result.duration_ms,
    stdout_tail: truncate(result.stdout, 12000),
    stderr_tail: truncate(result.stderr, 12000),
  };
}

function serializeAgentPass(pass: AgentPass): JsonObject {
  return {
    pass_index: pass.pass_index,
    kind: pass.kind,
    problem_file: pass.problem_file,
    output_dir: pass.output_dir,
    swe_agent_command: serializeCommand(pass.swe_agent_command),
    verifier: serializeCommand(pass.verifier),
    trajectory_file: pass.trajectory_file,
    trajectory_step_count: pass.trajectory_steps.length,
    changed_files: pass.changed_files,
    submitted_patch_sync: pass.submitted_patch_sync,
    model_stats: pass.model_stats,
    patch_file: path.join(pass.output_dir, "patch.diff"),
    verifier_failure_evidence: pass.verifier_failure_evidence,
  };
}

function serializeRun(run: AgentRun): JsonObject {
  return {
    arm: run.arm,
    run_id: run.run_id,
    task_id: run.task_id,
    workspace_dir: run.workspace_dir,
    output_dir: run.output_dir,
    problem_file: run.problem_file,
    swe_agent_command: serializeCommand(run.swe_agent_command),
    verifier: serializeCommand(run.verifier),
    trajectory_file: run.trajectory_file,
    trajectory_step_count: run.trajectory_steps.length,
    trajectory_steps: run.trajectory_steps.slice(0, 200),
    patch_file: path.join(run.output_dir, "patch.diff"),
    status: run.status,
    summary: run.summary,
    metrics: run.metrics,
    aionis_context: run.aionis_context ? compactAionisContext(run.aionis_context) : null,
    aionis_store: run.aionis_store,
    repair_passes: run.repair_passes.map(serializeAgentPass),
  };
}

function nullableDelta(before: unknown, after: unknown): number | null {
  const a = Number(before);
  const b = Number(after);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

function comparisonSignalSummary(comparison: JsonObject): JsonObject {
  const positiveSignals: string[] = [];
  const regressionSignals: string[] = [];

  if (comparison.verifier_improved === true) positiveSignals.push("verifier_improved");
  if (comparison.first_action_improved === true) positiveSignals.push("first_action_improved");

  const repeatedDiscoveryDelta = Number(comparison.repeated_discovery_delta);
  if (Number.isFinite(repeatedDiscoveryDelta)) {
    if (repeatedDiscoveryDelta > 0) positiveSignals.push("fewer_repeated_discovery_steps");
    if (repeatedDiscoveryDelta < 0) regressionSignals.push("more_repeated_discovery_steps");
  }

  const wrongFileTouchDelta = Number(comparison.wrong_file_touch_delta);
  if (Number.isFinite(wrongFileTouchDelta)) {
    if (wrongFileTouchDelta > 0) positiveSignals.push("fewer_wrong_file_touches");
    if (wrongFileTouchDelta < 0) regressionSignals.push("more_wrong_file_touches");
  }

  const toolStepDelta = Number(comparison.tool_step_delta);
  if (Number.isFinite(toolStepDelta)) {
    if (toolStepDelta > 0) positiveSignals.push("fewer_tool_steps");
    if (toolStepDelta < 0) regressionSignals.push("more_tool_steps");
  }

  const tokenDelta = Number(comparison.token_delta);
  if (Number.isFinite(tokenDelta)) {
    if (tokenDelta > 0) positiveSignals.push("lower_token_usage");
    if (tokenDelta < 0) regressionSignals.push("higher_token_usage");
  }

  const timeDelta = Number(comparison.time_delta_ms);
  if (Number.isFinite(timeDelta)) {
    if (timeDelta > 0) positiveSignals.push("faster_finish");
    if (timeDelta < 0) regressionSignals.push("slower_finish");
  }

  if (Number(comparison.assisted_prior_success_invariant_uptake_count ?? 0) > 0) {
    positiveSignals.push("prior_success_invariant_uptake");
  }
  if (comparison.assisted_repair_loop_succeeded === true) {
    positiveSignals.push("verifier_feedback_repair_succeeded");
  }

  if (comparison.assisted_context_budget_exceeded === true) {
    regressionSignals.push("context_budget_exceeded");
  }

  if (comparison.assisted_verifier_regressed === true) {
    regressionSignals.unshift("verifier_regressed");
  }
  if (comparison.assisted_verifier_passed !== true) {
    regressionSignals.unshift("assisted_verifier_failed");
  }

  let assistedEffectQuality = "neutral";
  if (comparison.assisted_verifier_regressed === true) {
    assistedEffectQuality = "regressed";
  } else if (comparison.assisted_verifier_passed !== true && positiveSignals.length > 0) {
    assistedEffectQuality = "failed_but_improved";
  } else if (comparison.assisted_verifier_passed !== true) {
    assistedEffectQuality = "failed";
  } else if (positiveSignals.length > 0 && regressionSignals.length === 0) {
    assistedEffectQuality = "positive";
  } else if (positiveSignals.length > 0 && regressionSignals.length > 0) {
    assistedEffectQuality = "mixed_positive";
  } else if (positiveSignals.length === 0 && regressionSignals.length > 0) {
    assistedEffectQuality = "mixed_negative";
  }

  return {
    assisted_effect_quality: assistedEffectQuality,
    assisted_effect_positive_signals: positiveSignals,
    assisted_effect_regression_signals: regressionSignals,
  };
}

function compareRuns(baseline: AgentRun | null, aionis: AgentRun | null): JsonObject | null {
  if (!baseline || !aionis) return null;
  const baselineTotalTokens = Number(baseline.metrics.input_tokens ?? 0) + Number(baseline.metrics.output_tokens ?? 0);
  const assistedTotalTokens = Number(aionis.metrics.input_tokens ?? 0) + Number(aionis.metrics.output_tokens ?? 0);
  const baselineToolSteps = Number(baseline.metrics.tool_step_count ?? 0);
  const assistedToolSteps = Number(aionis.metrics.tool_step_count ?? 0);
  const comparison: JsonObject = {
    baseline_verifier_passed: baseline.metrics.verifier_passed === true,
    assisted_verifier_passed: aionis.metrics.verifier_passed === true,
    verifier_improved: baseline.metrics.verifier_passed !== true && aionis.metrics.verifier_passed === true,
    verifier_equal_or_better: baseline.metrics.verifier_passed === aionis.metrics.verifier_passed || aionis.metrics.verifier_passed === true,
    assisted_verifier_regressed: baseline.metrics.verifier_passed === true && aionis.metrics.verifier_passed !== true,
    first_action_improved: baseline.metrics.first_action_correct !== true && aionis.metrics.first_action_correct === true,
    repeated_discovery_delta: nullableDelta(baseline.metrics.repeated_discovery_steps, aionis.metrics.repeated_discovery_steps),
    wrong_file_touch_delta: nullableDelta(baseline.metrics.wrong_file_touches, aionis.metrics.wrong_file_touches),
    tool_step_delta: nullableDelta(baseline.metrics.tool_step_count, aionis.metrics.tool_step_count),
    baseline_tool_step_count: baselineToolSteps,
    assisted_tool_step_count: assistedToolSteps,
    assisted_tool_step_ratio: baselineToolSteps > 0 ? Number((assistedToolSteps / baselineToolSteps).toFixed(6)) : null,
    baseline_total_tokens: baselineTotalTokens,
    assisted_total_tokens: assistedTotalTokens,
    assisted_token_ratio: baselineTotalTokens > 0 ? Number((assistedTotalTokens / baselineTotalTokens).toFixed(6)) : null,
    token_delta: baselineTotalTokens - assistedTotalTokens,
    time_delta_ms: nullableDelta(baseline.metrics.time_to_finish_ms, aionis.metrics.time_to_finish_ms),
    assisted_prior_success_invariant_count: aionis.metrics.prior_success_invariant_count ?? 0,
    assisted_prior_success_invariant_uptake_count: aionis.metrics.prior_success_invariant_uptake_count ?? 0,
    assisted_prior_success_invariant_uptake_rate: aionis.metrics.prior_success_invariant_uptake_rate ?? null,
    assisted_prior_success_invariant_missing_count: aionis.metrics.prior_success_invariant_missing_count ?? 0,
    assisted_assistance_mode: aionis.metrics.aionis_assistance_mode ?? null,
    assisted_aionis_context_char_count: aionis.metrics.aionis_context_char_count ?? 0,
    assisted_aionis_compact_contract_char_count: aionis.metrics.aionis_compact_contract_char_count ?? 0,
    assisted_context_budget_chars: aionis.metrics.aionis_context_budget_chars ?? 0,
    assisted_context_budget_exceeded: aionis.metrics.aionis_context_budget_exceeded === true,
    baseline_swe_agent_pass_count: baseline.metrics.swe_agent_pass_count ?? 1,
    assisted_swe_agent_pass_count: aionis.metrics.swe_agent_pass_count ?? 1,
    baseline_repair_attempt_count: baseline.metrics.repair_attempt_count ?? 0,
    assisted_repair_attempt_count: aionis.metrics.repair_attempt_count ?? 0,
    assisted_repair_loop_used: aionis.metrics.repair_loop_used === true,
    assisted_repair_loop_succeeded: aionis.metrics.repair_loop_succeeded === true,
    assisted_repair_failure_evidence_count: aionis.metrics.repair_failure_evidence_count ?? 0,
    assisted_repair_repeated_failure_count: aionis.metrics.repair_repeated_failure_count ?? 0,
    assisted_repair_stagnation_detected: aionis.metrics.repair_stagnation_detected === true,
  };
  return {
    ...comparison,
    ...comparisonSignalSummary(comparison),
  };
}

function aionisContextFeedbackFromComparison(
  task: Pick<EvalTask, "id" | "task_family">,
  comparison: JsonObject | null,
): JsonObject | null {
  if (!comparison) return null;
  const quality = stringValue(comparison.assisted_effect_quality) ?? "unknown";
  const regressionSignals = stringList(comparison.assisted_effect_regression_signals);
  const positiveSignals = stringList(comparison.assisted_effect_positive_signals);
  const reasons: string[] = [];
  const efficiencySignals: string[] = [];

  const assistedFailedWhereBaselineSucceeded = comparison.baseline_verifier_passed === true
    && comparison.assisted_verifier_passed !== true;
  if (comparison.assisted_verifier_regressed === true) reasons.push("assisted_verifier_regressed_against_baseline");
  if (assistedFailedWhereBaselineSucceeded) {
    reasons.push("baseline_passed_assisted_failed");
  }
  if (quality === "regressed" || (quality === "failed" && assistedFailedWhereBaselineSucceeded)) {
    reasons.push(`assisted_effect_quality_${quality}`);
  }

  const repeatedDiscoveryDelta = finiteNumberOrNull(comparison.repeated_discovery_delta);
  if (repeatedDiscoveryDelta !== null && repeatedDiscoveryDelta <= -5) efficiencySignals.push("repeated_discovery_regression");

  const wrongFileTouchDelta = finiteNumberOrNull(comparison.wrong_file_touch_delta);
  if (wrongFileTouchDelta !== null && wrongFileTouchDelta < 0) efficiencySignals.push("wrong_file_touch_regression");

  const toolStepDelta = finiteNumberOrNull(comparison.tool_step_delta);
  const assistedToolStepRatio = finiteNumberOrNull(comparison.assisted_tool_step_ratio);
  if (
    (toolStepDelta !== null && toolStepDelta <= -20)
    || (assistedToolStepRatio !== null && assistedToolStepRatio >= 1.8)
  ) {
    efficiencySignals.push("tool_step_regression");
  }

  const tokenDelta = finiteNumberOrNull(comparison.token_delta);
  const assistedTokenRatio = finiteNumberOrNull(comparison.assisted_token_ratio);
  if (
    (tokenDelta !== null && tokenDelta <= -10000)
    || (assistedTokenRatio !== null && assistedTokenRatio >= 1.8)
  ) {
    efficiencySignals.push("token_usage_regression");
  }

  const timeDelta = finiteNumberOrNull(comparison.time_delta_ms);
  if (timeDelta !== null && timeDelta <= -60000) efficiencySignals.push("time_to_finish_regression");
  if (comparison.assisted_context_budget_exceeded === true) efficiencySignals.push("context_budget_exceeded");

  const outcomeRegression = reasons.length > 0;
  const efficiencyRegression = comparison.baseline_verifier_passed === true
    && comparison.assisted_verifier_passed === true
    && efficiencySignals.length >= 2;
  const negativeTransfer = outcomeRegression || efficiencyRegression;
  const negativeTransferKind = outcomeRegression
    ? "outcome_regression"
    : efficiencyRegression ? "efficiency_regression" : "none";
  const allReasons = unique([...reasons, ...efficiencySignals]);

  return {
    schema_version: "aionis_agent_context_feedback_v1",
    feedback_type: "baseline_comparison_negative_transfer_control",
    authority: "measurement_feedback_not_runtime_rule",
    task_id: task.id,
    task_family: task.task_family ?? null,
    negative_transfer: negativeTransfer,
    negative_transfer_kind: negativeTransferKind,
    decision: negativeTransfer ? "downgrade_future_aionis_context_for_scope" : "observe_only",
    recommended_next_assistance_mode: negativeTransfer ? "minimal_boundary" : null,
    semantic_evidence_allowed_next: !negativeTransfer,
    runtime_source_mutation_allowed: false,
    source_code_change_allowed: false,
    reasons: allReasons,
    assisted_effect_quality: quality,
    positive_signals: positiveSignals,
    regression_signals: regressionSignals,
    metrics: {
      repeated_discovery_delta: comparison.repeated_discovery_delta,
      wrong_file_touch_delta: comparison.wrong_file_touch_delta,
      tool_step_delta: comparison.tool_step_delta,
      assisted_tool_step_ratio: comparison.assisted_tool_step_ratio,
      token_delta: comparison.token_delta,
      assisted_token_ratio: comparison.assisted_token_ratio,
      time_delta_ms: comparison.time_delta_ms,
    },
    usage_contract: [
      "This feedback can suppress future Aionis context in the same task family.",
      "It cannot create source-code rules, repository-specific repairs, or Runtime-owned semantic patches.",
      "The LLM/Agent remains responsible for semantic diagnosis and final code edits.",
    ],
  };
}

async function runTask(
  suite: EvalSuite,
  task: EvalTask,
  cli: CliArgs,
  priorTaskReports: JsonObject[],
): Promise<JsonObject> {
  const taskOutDir = path.join(cli.outDir, "tasks", task.id);
  await ensureDir(taskOutDir);
  const priorRuns: AgentRun[] = [];
  let baseline: AgentRun | null = null;
  let aionis: AgentRun | null = null;
  if (cli.armMode === "both" || cli.armMode === "baseline") {
    baseline = await runArm({ suite, task, cli, arm: "baseline", taskOutDir, priorRuns, priorTaskReports });
    priorRuns.push(baseline);
  }
  if (cli.armMode === "both" || cli.armMode === "aionis") {
    aionis = await runArm({ suite, task, cli, arm: "aionis", taskOutDir, priorRuns, priorTaskReports });
    priorRuns.push(aionis);
  }
  const runtimeMaintenance = asObject(aionis?.aionis_store)?.maintenance ?? asObject(baseline?.aionis_store)?.maintenance ?? null;
  const comparison = compareRuns(baseline, aionis);
  const report: JsonObject = {
    report_version: "aionis_swe_agent_task_report_v1",
    task_id: task.id,
    task_title: task.title ?? null,
    task_family: task.task_family ?? null,
    baseline: baseline ? serializeRun(baseline) : null,
    aionis: aionis ? serializeRun(aionis) : null,
    comparison,
    aionis_context_feedback: aionisContextFeedbackFromComparison(task, comparison),
    runtime_maintenance: runtimeMaintenance,
  };
  await writeJsonFile(path.join(taskOutDir, "task-report.json"), report);
  return report;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  cli.suiteFile = path.resolve(cli.suiteFile);
  cli.outDir = path.resolve(cli.outDir);
  cli.priorReportFiles = cli.priorReportFiles.map((file) => path.resolve(file));
  const suite = await readJsonFile<EvalSuite>(cli.suiteFile);
  const priorTaskReports = await readPriorTaskReports(cli.priorReportFiles);
  await ensureDir(cli.outDir);
  const tasks = suite.tasks.filter((task) => !cli.taskIds || cli.taskIds.has(task.id));
  if (tasks.length === 0) throw new Error("no tasks selected");
  const taskReports: JsonObject[] = [];
  for (const task of tasks) {
    process.stderr.write(`[swe-agent-eval] task=${task.id} arms=${cli.armMode}\n`);
    taskReports.push(await runTask(suite, task, cli, [...priorTaskReports, ...taskReports]));
  }
  const report = {
    report_version: "aionis_swe_agent_eval_report_v1",
    generated_at: new Date().toISOString(),
    suite_id: suite.suite_id,
    suite_file: cli.suiteFile,
    prior_report_files: cli.priorReportFiles,
    description: suite.description ?? null,
    layer_boundary: {
      layer: "swe_agent_eval_harness",
      agent_framework: "swe-agent",
      aionis_role: "runtime_context_evidence_learning_and_forgetting_only",
      forbidden_authority: [
        "project_specific_runtime_source_rules",
        "runtime_owned_semantic_patch_generation",
        "agent_execution_takeover",
      ],
      measurement_authority_only: true,
    },
    summary: {
      task_count: taskReports.length,
      prior_task_report_count: priorTaskReports.length,
      baseline_success_count: taskReports.filter((report) => asObject(report.baseline)?.status === "success").length,
      assisted_success_count: taskReports.filter((report) => asObject(report.aionis)?.status === "success").length,
      runtime_effect_rollup: buildRuntimeEffectRollupFromTaskReports(taskReports),
    },
    tasks: taskReports,
  };
  const reportFile = path.join(cli.outDir, "swe-agent-aionis-eval-report.json");
  await writeJsonFile(reportFile, report);
  process.stdout.write(`${reportFile}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
