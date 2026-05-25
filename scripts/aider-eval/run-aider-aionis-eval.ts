import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  buildAionisAgentRuntimeContext,
  type AgentRuntimeIdentity,
} from "../agent-runtime/aionis-agent-runtime-adapter.js";
import { buildRuntimeEffectRollupFromTaskReports, type JsonObject } from "../real-llm-eval/report-runtime-effect-rollup.js";

type CommandSpec = { command: string; timeout_ms?: number; env?: Record<string, string> };
type WorkspaceSpec = {
  source: "git" | "local";
  repo_url?: string;
  path?: string;
  ref?: string;
  checkout_depth?: number;
  setup_commands?: CommandSpec[];
  exclude?: string[];
};
type VerifierSpec = { command: string; timeout_ms?: number };
type ExpectedSpec = {
  target_files?: string[];
  allowed_read_files?: string[];
  allowed_edit_files?: string[];
  forbidden_edit_files?: string[];
  acceptance_checks?: string[];
  required_verifiers?: string[];
  anti_shortcut_rules?: string[];
};
type AiderConfig = {
  command?: string;
  model?: string;
  timeout_ms?: number;
  extra_args?: string[];
  map_tokens?: number;
  env?: Record<string, string>;
};
type EvalTask = {
  id: string;
  title?: string;
  task_family?: string;
  source_issue_url?: string;
  prompt: string;
  workspace: WorkspaceSpec;
  verifier: VerifierSpec;
  expected?: ExpectedSpec;
  baseline_attempts?: number;
  aionis_attempts?: number;
  max_repair_attempts?: number;
  aider?: AiderConfig;
};
type EvalSuite = { suite_id: string; description?: string; aider?: AiderConfig; tasks: EvalTask[] };
type CliArgs = {
  suiteFile: string;
  outDir: string;
  runtimeUrl: string | null;
  taskIds: Set<string> | null;
  aiderBin: string | null;
  model: string | null;
  aiderExtraArgs: string[];
  aiderTimeoutMs: number | null;
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
type AiderPass = {
  pass_index: number;
  kind: "initial" | "repair";
  problem_file: string;
  output_dir: string;
  aider_command: CommandResult;
  verifier: CommandResult;
  patch: string;
  changed_files: string[];
  verifier_failure_evidence: JsonObject | null;
};
type AgentRun = {
  arm: "baseline" | "aionis";
  run_id: string;
  task_id: string;
  workspace_dir: string;
  output_dir: string;
  problem_file: string;
  aider_command: CommandResult;
  verifier: CommandResult;
  patch: string;
  status: "success" | "failed" | "provider_failure" | "agent_failure";
  summary: string;
  aionis_context: JsonObject | null;
  aionis_store: JsonObject | null;
  metrics: JsonObject;
  repair_passes: AiderPass[];
};
type NonLearningFailureReason =
  | "agent_deployment_failure"
  | "agent_framework_configuration_failure"
  | "agent_process_signal_failure"
  | "agent_timeout_failure"
  | "provider_failure";

const AIONIS_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_AIDER_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_VERIFIER_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MODEL = "gpt-4o";

function usage(): string {
  return [
    "Usage:",
    "  npm run -s eval:aider -- --suite <suite.json> --out <dir> --runtime-url <url> [--task <id[,id]>]",
    "",
    "Options:",
    "  --suite <file>          Real task suite. Reuses the real-llm-eval suite shape.",
    "  --out <dir>             Output directory for reports, workspaces, prompts, and diffs.",
    "  --runtime-url <url>     Aionis Lite Runtime base URL. Required for Aionis arm.",
    "  --task <id[,id]>        Run only selected tasks.",
    "  --aider-bin <bin>       Aider executable. Defaults to suite config or aider.",
    "  --model <name>          Aider model name. Defaults to suite config, AIDER_MODEL, or gpt-4o.",
    "  --aider-arg <arg>       Extra raw Aider CLI argument. May be repeated.",
    "  --aider-timeout-ms <n>  Override Aider process timeout.",
    "  --arm <both|baseline|aionis>",
    "  --prior-report <file>   Previous Aider/Aionis eval report for scoped Runtime evidence. May be repeated.",
    "  --keep-workspaces       Do not delete per-run workspaces.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    runtimeUrl: null,
    taskIds: null,
    aiderBin: null,
    model: null,
    aiderExtraArgs: [],
    aiderTimeoutMs: null,
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
    else if (arg === "--aider-bin") args.aiderBin = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--aider-arg") args.aiderExtraArgs = [...(args.aiderExtraArgs ?? []), next()];
    else if (arg === "--aider-timeout-ms") args.aiderTimeoutMs = Number(next());
    else if (arg === "--prior-report") {
      args.priorReportFiles = [...(args.priorReportFiles ?? []), ...next().split(",").map((value) => value.trim()).filter(Boolean)];
    } else if (arg === "--arm") {
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
  if (args.aiderTimeoutMs !== null && !Number.isFinite(args.aiderTimeoutMs)) throw new Error("--aider-timeout-ms must be a number");
  return args as CliArgs;
}

async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, "utf8")) as T;
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 32))}\n...[truncated ${text.length - limit} chars]`;
}

function compactOneLine(text: string, limit: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), limit);
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function taskTargetFiles(task: EvalTask): string[] {
  return task.expected?.allowed_edit_files ?? task.expected?.target_files ?? [];
}

function taskVerifierCommands(task: EvalTask): string[] {
  return task.expected?.required_verifiers ?? task.expected?.acceptance_checks ?? [task.verifier.command];
}

function placeholders(task: EvalTask, workspaceDir: string, outDir: string): Record<string, string> {
  return { AIONIS_ROOT, WORKSPACE: workspaceDir, TASK_ID: task.id, OUT_DIR: outDir };
}

function expandPlaceholders(command: string, values: Record<string, string>): string {
  return command.replace(/\{([A-Z0-9_]+)\}/g, (match, key: string) => values[key] ?? match);
}

async function runCommand(command: string, args: string[], opts: {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5000).unref();
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

async function runShell(command: string, opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<CommandResult> {
  return await runCommand("/bin/sh", ["-lc", command], opts);
}

async function cloneWorkspace(task: EvalTask, arm: "baseline" | "aionis", outDir: string): Promise<string> {
  const workspaceDir = path.join(outDir, "workspaces", `${task.id}-${arm}`);
  await fsp.rm(workspaceDir, { recursive: true, force: true });
  await ensureDir(path.dirname(workspaceDir));
  if (task.workspace.source === "local") {
    if (!task.workspace.path) throw new Error(`${task.id}: local workspace path is required`);
    const excludeArgs = [".git", ...(task.workspace.exclude ?? [])].flatMap((entry) => ["--exclude", entry]);
    const copy = await runCommand("rsync", ["-a", ...excludeArgs, `${path.resolve(task.workspace.path)}/`, `${workspaceDir}/`], {
      cwd: AIONIS_ROOT,
      timeoutMs: 10 * 60 * 1000,
    });
    if (copy.exit_code !== 0) throw new Error(`${task.id}: local workspace copy failed\n${copy.stderr || copy.stdout}`);
    const init = await runCommand("git", ["-C", workspaceDir, "init"], { cwd: AIONIS_ROOT, timeoutMs: 60 * 1000 });
    if (init.exit_code !== 0) throw new Error(`${task.id}: git init failed\n${init.stderr || init.stdout}`);
    const add = await runCommand("git", ["-C", workspaceDir, "add", "-A"], { cwd: AIONIS_ROOT, timeoutMs: 60 * 1000 });
    if (add.exit_code !== 0) throw new Error(`${task.id}: git add failed\n${add.stderr || add.stdout}`);
    await runCommand("git", ["-C", workspaceDir, "commit", "-m", "baseline"], {
      cwd: AIONIS_ROOT,
      timeoutMs: 60 * 1000,
      env: {
        GIT_AUTHOR_NAME: "Aionis Eval",
        GIT_AUTHOR_EMAIL: "aionis-eval@example.invalid",
        GIT_COMMITTER_NAME: "Aionis Eval",
        GIT_COMMITTER_EMAIL: "aionis-eval@example.invalid",
      },
    });
    return workspaceDir;
  }
  if (!task.workspace.repo_url) throw new Error(`${task.id}: git repo_url is required`);
  const cloneArgs = ["clone"];
  if (task.workspace.checkout_depth) cloneArgs.push("--depth", String(task.workspace.checkout_depth));
  cloneArgs.push(task.workspace.repo_url, workspaceDir);
  const clone = await runCommand("git", cloneArgs, { cwd: AIONIS_ROOT, timeoutMs: 10 * 60 * 1000 });
  if (clone.exit_code !== 0) throw new Error(`${task.id}: git clone failed\n${clone.stderr || clone.stdout}`);
  if (task.workspace.ref) {
    const fetch = await runCommand("git", [
      "-C",
      workspaceDir,
      "fetch",
      "--depth",
      String(task.workspace.checkout_depth ?? 1),
      "origin",
      task.workspace.ref,
    ], {
      cwd: AIONIS_ROOT,
      timeoutMs: 5 * 60 * 1000,
    });
    const checkoutTarget = fetch.exit_code === 0 ? "FETCH_HEAD" : task.workspace.ref;
    const checkout = await runCommand("git", ["-C", workspaceDir, "checkout", checkoutTarget], {
      cwd: AIONIS_ROOT,
      timeoutMs: 2 * 60 * 1000,
    });
    if (checkout.exit_code !== 0) throw new Error(`${task.id}: git checkout failed\n${checkout.stderr || checkout.stdout}`);
  }
  return workspaceDir;
}

async function runSetupCommands(task: EvalTask, workspaceDir: string): Promise<void> {
  for (const setup of task.workspace.setup_commands ?? []) {
    const result = await runShell(expandPlaceholders(setup.command, placeholders(task, workspaceDir, workspaceDir)), {
      cwd: workspaceDir,
      timeoutMs: setup.timeout_ms ?? 10 * 60 * 1000,
      env: { ...(setup.env ?? {}), AIONIS_ROOT },
    });
    if (result.exit_code !== 0) throw new Error(`${task.id}: setup command failed: ${setup.command}\n${result.stderr || result.stdout}`);
  }
  const dirtyTrackedFiles = await runCommand("git", ["-C", workspaceDir, "diff", "--quiet", "HEAD"], {
    cwd: AIONIS_ROOT,
    timeoutMs: 60 * 1000,
  });
  if (dirtyTrackedFiles.exit_code === 1) {
    const restore = await runCommand("git", ["-C", workspaceDir, "restore", "--source=HEAD", "--staged", "--worktree", "."], {
      cwd: AIONIS_ROOT,
      timeoutMs: 60 * 1000,
    });
    if (restore.exit_code !== 0) throw new Error(`${task.id}: setup cleanup failed\n${restore.stderr || restore.stdout}`);
  }
}

async function runVerifier(task: EvalTask, workspaceDir: string, outDir: string): Promise<CommandResult> {
  const command = expandPlaceholders(task.verifier.command, placeholders(task, workspaceDir, outDir));
  return await runShell(command, {
    cwd: workspaceDir,
    timeoutMs: task.verifier.timeout_ms ?? DEFAULT_VERIFIER_TIMEOUT_MS,
    env: { AIONIS_ROOT },
  });
}

async function gitDiff(workspaceDir: string): Promise<string> {
  return (await runCommand("git", ["-C", workspaceDir, "diff", "--binary", "HEAD"], {
    cwd: AIONIS_ROOT,
    timeoutMs: 60 * 1000,
  })).stdout;
}

async function gitChangedFiles(workspaceDir: string): Promise<string[]> {
  return (await runCommand("git", ["-C", workspaceDir, "diff", "--name-only", "HEAD"], {
    cwd: AIONIS_ROOT,
    timeoutMs: 60 * 1000,
  })).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function postRuntime(baseUrl: string, route: string, payload: JsonObject): Promise<JsonObject> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as JsonObject : {};
  if (!response.ok) throw new Error(`Runtime ${route} failed: ${response.status} ${truncate(JSON.stringify(parsed), 2000)}`);
  return parsed;
}

function runtimePayloadBase(task: EvalTask, runId: string): AgentRuntimeIdentity {
  return {
    tenant_id: "aider-eval",
    scope: `aider-eval:${task.task_family ?? task.id}`,
    actor: "aider",
    consumer_agent_id: "aider",
    producer_agent_id: "aider",
    owner_agent_id: "aider",
    memory_lane: "private",
    run_id: runId,
  };
}

function priorRunsFromReports(reports: JsonObject[], task: EvalTask): AgentRun[] {
  const runs: AgentRun[] = [];
  for (const report of reports) {
    for (const rawTask of Array.isArray(report.tasks) ? report.tasks : []) {
      const taskReport = asObject(rawTask);
      if (!taskReport || taskReport.task_id !== task.id) continue;
      for (const arm of ["baseline", "aionis"] as const) {
        const run = asObject(taskReport[arm]);
        if (run) runs.push(run as unknown as AgentRun);
      }
    }
  }
  return runs;
}

function verifierFailureEvidence(result: CommandResult): JsonObject {
  const text = result.stderr.trim().length > 0 ? result.stderr : result.stdout;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const assertionLine = lines.find((line) => /AssertionError|ERR_ASSERTION|Expected|actual|must|should|FAIL|Error:/i.test(line));
  const stackAnchor = lines.find((line) => /\b(?:file:\/\/|\/).+\.(?:mjs|cjs|js|ts):\d+:\d+/.test(line));
  return {
    assertion_message: assertionLine ? compactOneLine(assertionLine, 220) : null,
    stack_anchor: stackAnchor ? compactOneLine(stackAnchor, 220) : null,
    stderr_excerpt: compactOneLine(lines.slice(0, 10).join(" | ") || text, 500),
  };
}

function compactRuntimeSurface(surface: JsonObject | null): JsonObject | null {
  if (!surface) return null;
  const actionRetrieval = asObject(surface.action_retrieval);
  const actionContract = asObject(surface.action_intelligence_runtime_contract);
  const planningSummary = asObject(surface.planning_summary);
  const assemblySummary = asObject(surface.assembly_summary);
  return {
    action_retrieval: actionRetrieval
      ? {
          history_applied: actionRetrieval.history_applied === true,
          selected_tool: stringValue(actionRetrieval.selected_tool),
          recommended_file_path: stringValue(actionRetrieval.recommended_file_path),
          recommended_next_action: stringValue(actionRetrieval.recommended_next_action)
            ? compactOneLine(stringValue(actionRetrieval.recommended_next_action)!, 180)
            : null,
        }
      : null,
    action_intelligence: actionContract
      ? {
          selected_tool: stringValue(actionContract.selected_tool),
          target_files: stringList(actionContract.target_files).slice(0, 8),
          recommended_next_action: stringValue(actionContract.recommended_next_action)
            ? compactOneLine(stringValue(actionContract.recommended_next_action)!, 180)
            : null,
          pre_action_gate: asObject(actionContract.pre_action_gate),
          runtime_entropy_profile: asObject(actionContract.runtime_entropy_profile),
        }
      : null,
    planning_summary: planningSummary
      ? {
          first_step_recommendation: asObject(planningSummary.first_step_recommendation),
          runtime_entropy_profile: asObject(planningSummary.runtime_entropy_profile),
        }
      : null,
    assembly_summary: assemblySummary ? { runtime_entropy_profile: asObject(assemblySummary.runtime_entropy_profile) } : null,
    tool_selection: asObject(surface.selection_summary),
  };
}

function compactAionisContext(context: JsonObject | null): JsonObject | null {
  if (!context) return null;
  return {
    context_version: context.context_version,
    role: context.role,
    agent_runtime_adapter: asObject(context.agent_runtime_adapter),
    runtime_routes: asObject(context.runtime_routes),
    compact_execution_contract: asObject(context.compact_execution_contract),
    runtime_surface: asObject(context.runtime_surface),
  };
}

async function buildAionisContext(baseUrl: string, task: EvalTask, runId: string, priorRuns: AgentRun[]): Promise<JsonObject> {
  const base = runtimePayloadBase(task, runId);
  const learnableRuns = priorRuns.filter((run) => run.metrics?.runtime_learning_quarantined !== true);
  const editBoundaryContext = {
    allowed_edit_files: task.expected?.allowed_edit_files ?? task.expected?.target_files ?? [],
    forbidden_edit_files: task.expected?.forbidden_edit_files ?? [],
    required_verifiers: taskVerifierCommands(task),
    anti_shortcut_rules: task.expected?.anti_shortcut_rules ?? [],
  };
  const runtimeContext = await buildAionisAgentRuntimeContext({
    baseUrl,
    identity: base,
    host: { host_kind: "agent_framework_eval", agent_id: "aider", adapter_id: "aider-eval-adapter-v1" },
    task: {
      task_id: task.id,
      task_family: task.task_family ?? null,
      query_text: task.prompt,
      context: { task_id: task.id, task_family: task.task_family ?? null, source_issue_url: task.source_issue_url ?? null, verifier: task.verifier },
      edit_boundary_context: editBoundaryContext,
      candidates: ["inspect", "search", "edit", "test", "verify"],
      execution_evidence: learnableRuns.slice(-5).map((run) => ({
        schema_version: "aider_prior_run_evidence_v1",
        arm: run.arm,
        status: run.status,
        verifier_passed: run.metrics?.verifier_passed === true,
        edited_files: stringList(run.metrics?.edited_files),
        verifier: {
          command: run.verifier?.command,
          exit_code: run.verifier?.exit_code,
          stdout_tail: truncate(run.verifier?.stdout ?? "", 2000),
          stderr_tail: truncate(run.verifier?.stderr ?? "", 2000),
        },
      })),
      execution_result_summary: {
        prior_run_count: priorRuns.length,
        learnable_prior_run_count: learnableRuns.length,
        prior_success_count: learnableRuns.filter((run) => run.metrics?.verifier_passed === true).length,
        prior_failure_count: learnableRuns.filter((run) => run.metrics?.verifier_passed !== true).length,
      },
    },
    contextCharBudget: 12000,
  });
  return {
    context_version: "aionis_aider_context_packet_v1",
    role: "advisory_runtime_evidence_not_agent_execution",
    agent_runtime_adapter: runtimeContext.adapter,
    runtime_routes: runtimeContext.runtime_routes,
    compact_execution_contract: {
      schema_version: "aionis_aider_compact_execution_contract_v1",
      authority: "advisory_runtime_evidence_not_agent_execution",
      agent_owns_semantic_repair: true,
      runtime_may_not_block_exploration: true,
      target_files: taskTargetFiles(task),
      allowed_read_files: task.expected?.allowed_read_files ?? [],
      forbidden_edit_files: task.expected?.forbidden_edit_files ?? [],
      verifier_commands: taskVerifierCommands(task),
      anti_shortcut_rules: task.expected?.anti_shortcut_rules ?? [],
      operating_rules: [
        "The LLM/Agent owns semantic repair and final code choices.",
        "Aionis supplies continuity, scoped evidence, controlled forgetting signals, and dynamic governance only.",
        "Runtime evidence is advisory; when current verifier evidence contradicts it, current verifier evidence wins.",
        "Do not turn task-specific observations into Runtime source rules.",
        "Explore outside target files only when current source evidence or verifier output proves the declared boundary is incomplete.",
      ],
    },
    runtime_surface: {
      experience_intelligence: compactRuntimeSurface(runtimeContext.experience_intelligence),
      planning: compactRuntimeSurface(runtimeContext.planning),
      assembly: compactRuntimeSurface(runtimeContext.assembly),
      tools: compactRuntimeSurface(runtimeContext.tools),
    },
  };
}

function renderList(title: string, items: string[] | undefined): string {
  const list = (items ?? []).filter(Boolean);
  return list.length === 0 ? "" : [`${title}:`, ...list.map((item) => `- ${item}`), ""].join("\n");
}

function buildProblemStatement(task: EvalTask, aionisContext: JsonObject | null): string {
  const lines = [
    `# ${task.title ?? task.id}`,
    "",
    "You are working in a real Git checkout. Implement the requested change completely and run the provided verifier before finishing.",
    "",
    "## Task",
    task.prompt,
    "",
    "## Editing Contract",
    renderList("Target files", task.expected?.target_files),
    renderList("Allowed read files", task.expected?.allowed_read_files),
    renderList("Allowed edit files", task.expected?.allowed_edit_files),
    renderList("Forbidden edit files", task.expected?.forbidden_edit_files),
    renderList("Acceptance checks", task.expected?.acceptance_checks ?? [task.verifier.command]),
    renderList("Anti-shortcut rules", task.expected?.anti_shortcut_rules),
    "## Required Verifier",
    expandPlaceholders(task.verifier.command, { AIONIS_ROOT, WORKSPACE: "<workspace>", TASK_ID: task.id, OUT_DIR: "<out>" }),
    "",
  ];
  if (aionisContext) {
    lines.push(
      "## Aionis Runtime Context",
      "This context is advisory runtime evidence only. It must not replace your own semantic analysis.",
      "Use it for continuity, scoped prior evidence, dynamic governance, and forgetting/negative-transfer awareness.",
      "If it conflicts with current source code or verifier output, trust current evidence.",
      "",
      "```json",
      JSON.stringify(compactAionisContext(aionisContext), null, 2),
      "```",
      "",
    );
  }
  return lines.join("\n");
}

function buildRepairProblemStatement(args: { task: EvalTask; aionisContext: JsonObject | null; passIndex: number; previousPass: AiderPass }): string {
  return [
    `# Repair pass ${args.passIndex} for ${args.task.id}`,
    "",
    "The previous real verifier did not pass. Inspect the actual files and repair the cause. Do not guess from the prompt alone.",
    "",
    "## Original Task",
    args.task.prompt,
    "",
    "## Changed Files So Far",
    ...(args.previousPass.changed_files.length > 0 ? args.previousPass.changed_files.map((file) => `- ${file}`) : ["- none"]),
    "",
    "## Verifier Failure Evidence",
    "```text",
    truncate((args.previousPass.verifier.stderr || args.previousPass.verifier.stdout || "").trim(), 6000),
    "```",
    "",
    args.aionisContext
      ? [
          "## Aionis Runtime Context",
          "Advisory only. Current verifier failure is stronger evidence than prior Runtime guidance.",
          "```json",
          JSON.stringify(compactAionisContext(args.aionisContext), null, 2),
          "```",
          "",
        ].join("\n")
      : "",
  ].join("\n");
}

function resolvedAiderConfig(suite: EvalSuite, task: EvalTask, cli: CliArgs): Required<AiderConfig> {
  return {
    command: cli.aiderBin ?? task.aider?.command ?? suite.aider?.command ?? "aider",
    model: cli.model ?? task.aider?.model ?? suite.aider?.model ?? process.env.AIDER_MODEL ?? DEFAULT_MODEL,
    timeout_ms: cli.aiderTimeoutMs ?? task.aider?.timeout_ms ?? suite.aider?.timeout_ms ?? DEFAULT_AIDER_TIMEOUT_MS,
    extra_args: [...(suite.aider?.extra_args ?? []), ...(task.aider?.extra_args ?? []), ...cli.aiderExtraArgs],
    map_tokens: task.aider?.map_tokens ?? suite.aider?.map_tokens ?? 2048,
    env: { ...(suite.aider?.env ?? {}), ...(task.aider?.env ?? {}) },
  };
}

async function runAider(args: {
  suite: EvalSuite;
  task: EvalTask;
  cli: CliArgs;
  workspaceDir: string;
  passOutDir: string;
  problemFile: string;
}): Promise<CommandResult> {
  const config = resolvedAiderConfig(args.suite, args.task, args.cli);
  const commandArgs = [
    "--yes",
    "--no-auto-commits",
    "--no-dirty-commits",
    "--no-auto-lint",
    "--no-auto-test",
    "--no-pretty",
    "--no-stream",
    "--no-gitignore",
    "--no-detect-urls",
    "--model",
    config.model,
    "--map-tokens",
    String(config.map_tokens),
    "--chat-history-file",
    path.join(args.passOutDir, "aider.chat.history.md"),
    "--llm-history-file",
    path.join(args.passOutDir, "aider.llm.history"),
    "--message-file",
    args.problemFile,
    ...config.extra_args,
    ...taskTargetFiles(args.task),
  ];
  return await runCommand(config.command, commandArgs, {
    cwd: args.workspaceDir,
    timeoutMs: config.timeout_ms,
    env: { ...config.env, AIONIS_ROOT, AIDER_ANALYTICS: "false", AIDER_CHECK_UPDATE: "false" },
  });
}

function nonLearningFailureReason(result: CommandResult): NonLearningFailureReason | null {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.timed_out) return "agent_timeout_failure";
  if (result.signal) return "agent_process_signal_failure";
  if (
    text.includes("insufficient balance")
    || text.includes("authentication")
    || text.includes("invalid api key")
    || text.includes("api key")
    || text.includes("rate limit")
    || text.includes("quota")
    || text.includes("overloaded")
    || text.includes("service unavailable")
    || text.includes("litellm.authenticationerror")
    || text.includes("litellm.ratelimiterror")
    || text.includes("providererror")
    || text.includes("error code: 401")
    || text.includes("error code: 402")
    || text.includes("error code: 429")
    || text.includes("status code: 401")
    || text.includes("status code: 402")
    || text.includes("status code: 429")
  ) return "provider_failure";
  if (text.includes("no such file or directory") && text.includes("aider")) return "agent_deployment_failure";
  if (text.includes("unrecognized arguments") || text.includes("unknown model") || text.includes("model must be")) {
    return "agent_framework_configuration_failure";
  }
  return null;
}

function skippedVerifierResult(task: EvalTask, workspaceDir: string, outDir: string, reason: NonLearningFailureReason): CommandResult {
  return {
    command: `${expandPlaceholders(task.verifier.command, placeholders(task, workspaceDir, outDir))} (skipped: ${reason})`,
    cwd: workspaceDir,
    exit_code: null,
    signal: null,
    timed_out: false,
    duration_ms: 0,
    stdout: "",
    stderr: `Verifier skipped because Aider did not produce workspace changes after ${reason}.`,
  };
}

async function runAiderPass(args: {
  suite: EvalSuite;
  task: EvalTask;
  cli: CliArgs;
  workspaceDir: string;
  passIndex: number;
  kind: "initial" | "repair";
  problemFile: string;
  passOutDir: string;
}): Promise<AiderPass> {
  await ensureDir(args.passOutDir);
  const aiderCommand = await runAider(args);
  const [patch, changedFiles] = await Promise.all([gitDiff(args.workspaceDir), gitChangedFiles(args.workspaceDir)]);
  const skipReason = nonLearningFailureReason(aiderCommand);
  const verifier = skipReason && changedFiles.length === 0
    ? skippedVerifierResult(args.task, args.workspaceDir, args.passOutDir, skipReason)
    : await runVerifier(args.task, args.workspaceDir, args.passOutDir);
  const pass: AiderPass = {
    pass_index: args.passIndex,
    kind: args.kind,
    problem_file: args.problemFile,
    output_dir: args.passOutDir,
    aider_command: aiderCommand,
    verifier,
    patch,
    changed_files: changedFiles,
    verifier_failure_evidence: verifier.exit_code === 0 && !verifier.timed_out ? null : verifierFailureEvidence(verifier),
  };
  await fsp.writeFile(path.join(args.passOutDir, "patch.diff"), patch);
  await writeJsonFile(path.join(args.passOutDir, "pass.json"), serializePass(pass));
  return pass;
}

function maxAgentPassCount(task: EvalTask, arm: "baseline" | "aionis"): number {
  const configured = arm === "aionis"
    ? task.aionis_attempts ?? (task.max_repair_attempts !== undefined ? task.max_repair_attempts + 1 : undefined)
    : task.baseline_attempts;
  return Math.max(1, Math.min(5, Math.floor(Number(configured ?? 1))));
}

async function runRepairLoop(args: {
  suite: EvalSuite;
  task: EvalTask;
  cli: CliArgs;
  arm: "baseline" | "aionis";
  workspaceDir: string;
  armOutDir: string;
  aionisContext: JsonObject | null;
  initialProblemStatement: string;
}): Promise<{ passes: AiderPass[]; final_problem_file: string }> {
  const passes: AiderPass[] = [];
  let problemStatement = args.initialProblemStatement;
  let problemFile = path.join(args.armOutDir, "problem.md");
  let finalProblemFile = problemFile;
  for (let passIndex = 0; passIndex < maxAgentPassCount(args.task, args.arm); passIndex += 1) {
    await fsp.writeFile(problemFile, problemStatement);
    finalProblemFile = problemFile;
    const pass = await runAiderPass({
      suite: args.suite,
      task: args.task,
      cli: args.cli,
      workspaceDir: args.workspaceDir,
      passIndex,
      kind: passIndex === 0 ? "initial" : "repair",
      problemFile,
      passOutDir: path.join(args.armOutDir, passIndex === 0 ? "initial" : `repair-${passIndex}`),
    });
    passes.push(pass);
    if ((pass.verifier.exit_code === 0 && !pass.verifier.timed_out) || passIndex + 1 >= maxAgentPassCount(args.task, args.arm) || nonLearningFailureReason(pass.aider_command)) {
      break;
    }
    problemFile = path.join(args.armOutDir, `repair-${passIndex + 1}.problem.md`);
    problemStatement = buildRepairProblemStatement({ task: args.task, aionisContext: args.aionisContext, passIndex: passIndex + 1, previousPass: pass });
  }
  return { passes, final_problem_file: finalProblemFile };
}

function forbiddenFileWriteCount(task: EvalTask, changedFiles: string[]): number {
  const forbidden = task.expected?.forbidden_edit_files ?? [];
  return changedFiles.filter((file) => forbidden.some((rule) => file === rule || file.startsWith(`${rule.replace(/\/$/, "")}/`))).length;
}

function targetFileTouchCount(task: EvalTask, changedFiles: string[]): number {
  const targets = taskTargetFiles(task);
  return changedFiles.filter((file) => targets.includes(file)).length;
}

function nonTargetFileWriteCount(task: EvalTask, changedFiles: string[]): number {
  const targets = taskTargetFiles(task);
  if (targets.length === 0) return 0;
  return changedFiles.filter((file) => !targets.includes(file)).length;
}

function metricsForRun(args: {
  task: EvalTask;
  aiderResults: CommandResult[];
  verifier: CommandResult;
  changedFiles: string[];
  patch: string;
  problemStatement: string;
  aionisContext: JsonObject | null;
  repairAttemptCount: number;
}): JsonObject {
  const tokenText = args.aiderResults.map((result) => `${result.stdout}\n${result.stderr}`).join("\n");
  const inputTokens = Number(tokenText.match(/input tokens:\s*([0-9,]+)/i)?.[1]?.replace(/,/g, "") ?? NaN);
  const outputTokens = Number(tokenText.match(/output tokens:\s*([0-9,]+)/i)?.[1]?.replace(/,/g, "") ?? NaN);
  const contextText = args.aionisContext ? JSON.stringify(compactAionisContext(args.aionisContext)) : "";
  const providerWarningPresent = args.aiderResults.some((result) => nonLearningFailureReason(result) === "provider_failure");
  const nonLearningReason = args.aiderResults
    .map((result) => {
      const reason = nonLearningFailureReason(result);
      if (!reason) return null;
      if (result.exit_code === 0 && !result.timed_out && !result.signal && args.changedFiles.length > 0) return null;
      return reason;
    })
    .find((reason): reason is NonLearningFailureReason => !!reason) ?? null;
  return {
    agent_framework: "aider",
    verifier_passed: args.verifier.exit_code === 0 && !args.verifier.timed_out,
    verifier_exit_code: args.verifier.exit_code,
    verifier_timed_out: args.verifier.timed_out,
    edited_files: args.changedFiles,
    edited_file_count: args.changedFiles.length,
    target_file_touch_count: targetFileTouchCount(args.task, args.changedFiles),
    non_target_file_writes: nonTargetFileWriteCount(args.task, args.changedFiles),
    forbidden_file_writes: forbiddenFileWriteCount(args.task, args.changedFiles),
    patch_char_count: args.patch.length,
    repair_attempt_count: args.repairAttemptCount,
    non_learning_failure_reason: nonLearningReason,
    provider_warning_present: providerWarningPresent,
    runtime_learning_quarantined: nonLearningReason !== null,
    time_to_finish_ms: args.aiderResults.reduce((sum, result) => sum + result.duration_ms, 0) + args.verifier.duration_ms,
    aider_duration_ms: args.aiderResults.reduce((sum, result) => sum + result.duration_ms, 0),
    verifier_duration_ms: args.verifier.duration_ms,
    problem_statement_char_count: args.problemStatement.length,
    aionis_context_present: args.aionisContext !== null,
    aionis_context_char_count: contextText.length,
    token_usage_input_estimate: Number.isFinite(inputTokens) ? inputTokens : null,
    token_usage_output_estimate: Number.isFinite(outputTokens) ? outputTokens : null,
  };
}

async function storeAionisOutcome(baseUrl: string, task: EvalTask, run: AgentRun): Promise<JsonObject> {
  const quarantineReason = stringValue(run.metrics.non_learning_failure_reason) ?? (run.status === "provider_failure" ? "provider_failure" : null);
  if (quarantineReason) {
    return { persisted: false, runtime_learning_quarantined: true, runtime_learning_quarantine_reason: quarantineReason, run_id: run.run_id, arm: run.arm, agent_framework: "aider" };
  }
  const base = runtimePayloadBase(task, run.run_id);
  const started = await postRuntime(baseUrl, "/v1/memory/replay/run/start", {
    ...base,
    goal: task.prompt,
    context_snapshot_ref: run.aionis_context ? `aionis-aider-context:${run.run_id}` : undefined,
    metadata: { suite_source: "aider_eval", agent_framework: "aider", arm: run.arm },
  });
  const replayRunId = stringValue(started.run_id) ?? run.run_id;
  const before = await postRuntime(baseUrl, "/v1/memory/replay/step/before", {
    ...base,
    run_id: replayRunId,
    step_index: 1,
    tool_name: "aider",
    tool_input: { command: run.aider_command.command, prompt_file: run.problem_file },
    safety_level: "needs_confirm",
    metadata: { arm: run.arm, agent_framework: "aider" },
  });
  const after = await postRuntime(baseUrl, "/v1/memory/replay/step/after", {
    ...base,
    run_id: replayRunId,
    step_id: stringValue(before.step_id) ?? undefined,
    step_index: 1,
    status: run.metrics.verifier_passed === true ? "success" : "failed",
    output_signature: truncate(run.aider_command.stdout || run.aider_command.stderr, 4000),
    artifact_refs: stringList(run.metrics.edited_files).map((file) => `workspace://${run.run_id}/${file}`),
    metadata: { arm: run.arm, agent_framework: "aider", verifier_exit_code: run.verifier.exit_code },
  });
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
    metadata: { arm: run.arm, agent_framework: "aider" },
  });
  const compile = run.metrics.verifier_passed === true
    ? await postRuntime(baseUrl, "/v1/memory/replay/playbooks/compile_from_run", {
        ...base,
        run_id: replayRunId,
        success_criteria: { verifier_command: task.verifier.command, verifier_passed: true },
        allow_partial: false,
        risk_profile: "medium",
        metadata: { arm: run.arm, agent_framework: "aider" },
      })
    : null;
  const targetFiles = stringList(run.metrics.edited_files).length > 0 ? stringList(run.metrics.edited_files) : task.expected?.target_files ?? [];
  const handoff = await postRuntime(baseUrl, "/v1/handoff/store", {
    tenant_id: base.tenant_id,
    scope: base.scope,
    actor: base.actor,
    handoff_kind: "task_handoff",
    task_family: task.task_family ?? undefined,
    anchor: `aider-eval:${task.id}:${run.arm}`,
    summary: run.summary,
    handoff_text: `Aider ${run.arm} run for ${task.id}: ${run.summary}`,
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
    },
    execution_evidence: [
      {
        schema_version: "aider_verifier_evidence_v1",
        kind: "verifier",
        arm: run.arm,
        command: run.verifier.command,
        passed: run.metrics.verifier_passed === true,
        exit_code: run.verifier.exit_code,
        stdout_tail: truncate(run.verifier.stdout, 4000),
        stderr_tail: truncate(run.verifier.stderr, 4000),
      },
      {
        schema_version: "aider_patch_evidence_v1",
        kind: "patch",
        arm: run.arm,
        authority: run.metrics.verifier_passed === true ? "scoped_prior_success_evidence" : "failed_run_observation",
        verifier_passed: run.metrics.verifier_passed === true,
        changed_files: targetFiles,
        patch_excerpt: truncate(run.patch, 4000),
      },
    ],
    execution_packet_v1: {
      version: 1,
      state_id: run.run_id,
      current_stage: "patch",
      active_role: "patch",
      task_brief: task.prompt,
      target_files: targetFiles,
      next_action: run.metrics.verifier_passed === true ? "Scoped replay candidate; require matching verifier before reuse." : "Failed evidence; do not promote without successful rerun.",
      hard_constraints: ["Use real verifier evidence only.", "Do not turn this project-specific result into Runtime source code.", ...(task.expected?.anti_shortcut_rules ?? [])],
      accepted_facts: run.metrics.verifier_passed === true ? [`Verifier passed: ${task.verifier.command}`] : [],
      rejected_paths: [],
      pending_validations: run.metrics.verifier_passed === true ? [] : [task.verifier.command],
      unresolved_blockers: run.metrics.verifier_passed === true ? [] : ["Aider run did not satisfy verifier"],
      rollback_notes: [],
      review_contract: null,
      resume_anchor: { anchor: `aider-eval:${task.id}:${run.arm}`, file_path: targetFiles[0] ?? null, symbol: null, repo_root: run.workspace_dir },
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
  return { persisted: true, runtime_learning_quarantined: false, run_id: run.run_id, arm: run.arm, agent_framework: "aider", started, replay_steps: [{ before, after }], ended, compile, handoff, maintenance, introspection };
}

function aggregateCommandResults(results: CommandResult[], label: string): CommandResult {
  return {
    command: label,
    cwd: results[0]?.cwd ?? AIONIS_ROOT,
    exit_code: results.every((result) => result.exit_code === 0) ? 0 : results.find((result) => result.exit_code !== 0)?.exit_code ?? null,
    signal: results.find((result) => result.signal)?.signal ?? null,
    timed_out: results.some((result) => result.timed_out),
    duration_ms: results.reduce((sum, result) => sum + result.duration_ms, 0),
    stdout: results.map((result) => result.stdout).join("\n"),
    stderr: results.map((result) => result.stderr).join("\n"),
  };
}

async function runArm(args: { suite: EvalSuite; task: EvalTask; cli: CliArgs; arm: "baseline" | "aionis"; taskOutDir: string; priorRuns: AgentRun[] }): Promise<AgentRun> {
  const runId = crypto.randomUUID();
  const armOutDir = path.join(args.taskOutDir, args.arm);
  await ensureDir(armOutDir);
  const workspaceDir = await cloneWorkspace(args.task, args.arm, args.taskOutDir);
  await runSetupCommands(args.task, workspaceDir);
  const aionisContext = args.arm === "aionis" && args.cli.runtimeUrl ? await buildAionisContext(args.cli.runtimeUrl, args.task, runId, args.priorRuns) : null;
  const problemStatement = buildProblemStatement(args.task, aionisContext);
  const repairLoop = await runRepairLoop({ suite: args.suite, task: args.task, cli: args.cli, arm: args.arm, workspaceDir, armOutDir, aionisContext, initialProblemStatement: problemStatement });
  const finalPass = repairLoop.passes[repairLoop.passes.length - 1];
  if (!finalPass) throw new Error(`${args.task.id}: Aider repair loop did not run`);
  const aiderCommand = aggregateCommandResults(repairLoop.passes.map((pass) => pass.aider_command), `${args.arm} aider passes`);
  const metrics = metricsForRun({
    task: args.task,
    aiderResults: repairLoop.passes.map((pass) => pass.aider_command),
    verifier: finalPass.verifier,
    changedFiles: finalPass.changed_files,
    patch: finalPass.patch,
    problemStatement: await fsp.readFile(repairLoop.final_problem_file, "utf8"),
    aionisContext,
    repairAttemptCount: Math.max(0, repairLoop.passes.length - 1),
  });
  const quarantineReason = stringValue(metrics.non_learning_failure_reason);
  const status: AgentRun["status"] = quarantineReason === "provider_failure"
    ? "provider_failure"
    : metrics.verifier_passed === true ? "success" : quarantineReason ? "agent_failure" : "failed";
  const summary = `${args.arm} Aider run ${status}; verifier_passed=${metrics.verifier_passed === true}; edited_files=${finalPass.changed_files.join(", ") || "none"}`;
  const run: AgentRun = {
    arm: args.arm,
    run_id: runId,
    task_id: args.task.id,
    workspace_dir: workspaceDir,
    output_dir: armOutDir,
    problem_file: repairLoop.final_problem_file,
    aider_command: aiderCommand,
    verifier: finalPass.verifier,
    patch: finalPass.patch,
    status,
    summary,
    aionis_context: aionisContext,
    aionis_store: null,
    metrics,
    repair_passes: repairLoop.passes,
  };
  await fsp.writeFile(path.join(armOutDir, "patch.diff"), finalPass.patch);
  await writeJsonFile(path.join(armOutDir, "run.json"), serializeRun(run));
  if (args.cli.runtimeUrl) {
    run.aionis_store = await storeAionisOutcome(args.cli.runtimeUrl, args.task, run);
    await writeJsonFile(path.join(armOutDir, "run.json"), serializeRun(run));
  }
  if (!args.cli.keepWorkspaces) await fsp.rm(workspaceDir, { recursive: true, force: true });
  return run;
}

function comparisonForRuns(task: EvalTask, baseline: AgentRun | null, aionis: AgentRun | null): JsonObject {
  if (!baseline || !aionis) return {};
  const baselineVerifier = baseline.metrics.verifier_passed === true;
  const aionisVerifier = aionis.metrics.verifier_passed === true;
  return {
    verifier_improved: !baselineVerifier && aionisVerifier,
    verifier_regressed: baselineVerifier && !aionisVerifier,
    both_passed: baselineVerifier && aionisVerifier,
    both_failed: !baselineVerifier && !aionisVerifier,
    token_delta: Number(baseline.metrics.token_usage_input_estimate ?? 0) - Number(aionis.metrics.token_usage_input_estimate ?? 0),
    time_delta_ms: Number(baseline.metrics.time_to_finish_ms ?? 0) - Number(aionis.metrics.time_to_finish_ms ?? 0),
    wrong_file_touch_delta: forbiddenFileWriteCount(task, stringList(baseline.metrics.edited_files)) - forbiddenFileWriteCount(task, stringList(aionis.metrics.edited_files)),
    baseline_status: baseline.status,
    aionis_status: aionis.status,
  };
}

async function runTask(suite: EvalSuite, task: EvalTask, cli: CliArgs, priorReports: JsonObject[]): Promise<JsonObject> {
  const taskOutDir = path.join(cli.outDir, task.id);
  await ensureDir(taskOutDir);
  const priorRuns = priorRunsFromReports(priorReports, task);
  const baseline = cli.armMode === "both" || cli.armMode === "baseline"
    ? await runArm({ suite, task, cli, arm: "baseline", taskOutDir, priorRuns })
    : null;
  const aionisPriorRuns = baseline ? [...priorRuns, baseline] : priorRuns;
  const aionis = cli.armMode === "both" || cli.armMode === "aionis"
    ? await runArm({ suite, task, cli, arm: "aionis", taskOutDir, priorRuns: aionisPriorRuns })
    : null;
  const report = {
    task_id: task.id,
    title: task.title ?? null,
    task_family: task.task_family ?? null,
    source_issue_url: task.source_issue_url ?? null,
    baseline: baseline ? serializeRun(baseline) : null,
    aionis: aionis ? serializeRun(aionis) : null,
    comparison: comparisonForRuns(task, baseline, aionis),
  };
  await writeJsonFile(path.join(taskOutDir, "task-report.json"), report);
  return report;
}

async function readPriorReports(files: string[]): Promise<JsonObject[]> {
  const reports: JsonObject[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`prior report not found: ${file}`);
    reports.push(await readJsonFile<JsonObject>(file));
  }
  return reports;
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

function serializePass(pass: AiderPass): JsonObject {
  return {
    pass_index: pass.pass_index,
    kind: pass.kind,
    problem_file: pass.problem_file,
    output_dir: pass.output_dir,
    aider_command: serializeCommand(pass.aider_command),
    verifier: serializeCommand(pass.verifier),
    patch_file: path.join(pass.output_dir, "patch.diff"),
    changed_files: pass.changed_files,
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
    aider_command: serializeCommand(run.aider_command),
    verifier: serializeCommand(run.verifier),
    patch_file: path.join(run.output_dir, "patch.diff"),
    status: run.status,
    summary: run.summary,
    metrics: run.metrics,
    aionis_context: compactAionisContext(run.aionis_context),
    aionis_store: run.aionis_store,
    repair_passes: run.repair_passes.map(serializePass),
  };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  cli.suiteFile = path.resolve(cli.suiteFile);
  cli.outDir = path.resolve(cli.outDir);
  cli.priorReportFiles = cli.priorReportFiles.map((file) => path.resolve(file));
  const suite = await readJsonFile<EvalSuite>(cli.suiteFile);
  const priorReports = await readPriorReports(cli.priorReportFiles);
  await ensureDir(cli.outDir);
  const tasks = suite.tasks.filter((task) => !cli.taskIds || cli.taskIds.has(task.id));
  if (tasks.length === 0) throw new Error("no tasks selected");
  const taskReports: JsonObject[] = [];
  for (const task of tasks) {
    process.stderr.write(`[aider-eval] task=${task.id} arms=${cli.armMode}\n`);
    taskReports.push(await runTask(suite, task, cli, [...priorReports, ...taskReports]));
  }
  const report = {
    report_version: "aionis_aider_eval_report_v1",
    generated_at: new Date().toISOString(),
    suite_id: suite.suite_id,
    suite_file: cli.suiteFile,
    prior_report_files: cli.priorReportFiles,
    description: suite.description ?? null,
    layer_boundary: {
      layer: "aider_eval_harness",
      agent_framework: "aider",
      aionis_role: "runtime_context_evidence_learning_forgetting_and_dynamic_governance_only",
      llm_agent_role: "semantic_analysis_code_editing_and_task_solution",
      forbidden_authority: ["project_specific_runtime_source_rules", "runtime_owned_semantic_patch_generation", "agent_execution_takeover"],
      measurement_authority_only: true,
    },
    summary: {
      task_count: taskReports.length,
      prior_report_count: priorReports.length,
      baseline_success_count: taskReports.filter((report) => asObject(report.baseline)?.status === "success").length,
      assisted_success_count: taskReports.filter((report) => asObject(report.aionis)?.status === "success").length,
      runtime_effect_rollup: buildRuntimeEffectRollupFromTaskReports(taskReports),
    },
    tasks: taskReports,
  };
  const reportFile = path.join(cli.outDir, "aider-aionis-eval-report.json");
  await writeJsonFile(reportFile, report);
  process.stdout.write(`${reportFile}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
