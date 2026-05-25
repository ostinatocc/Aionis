import fs from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;

type CliArgs = {
  reports: string[];
  outDir: string;
  minReports: number;
  minTasks: number;
  requiredSignals: string[];
};

const REPORT_VERSION = "aionis_real_llm_agent_eval_v1";
const ROLLUP_VERSION = "aionis_real_llm_portfolio_rollup_v1";
const DEFAULT_REQUIRED_SIGNALS = [
  "failure_evidence_reused_by_assisted_run",
  "repair_guidance_led_to_verifier_pass",
  "verifier_failure_phase_classified",
  "edit_boundary_respected_in_assisted_runs",
];

function usage(): string {
  return `
Usage:
  npm run eval:real-llm-rollup -- --report <real-llm-eval-report.json> [--report <...>] --out <dir>

Options:
  --report <file>            Real Aionis LLM eval report. Repeat for portfolio evidence.
  --out <dir>                Output directory for real-llm-portfolio-rollup.json.
  --min-reports <n>          Minimum report count, default 1.
  --min-tasks <n>            Minimum unique task count, default 1.
  --require-signal <name>    Required learning signal. Repeat to override the default signal set.

This command only accepts real ${REPORT_VERSION} reports. It does not run a mock provider
and does not synthesize task success.
`.trim();
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function parsePositiveInt(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  const reports: string[] = [];
  let outDir = "";
  let minReports = 1;
  let minTasks = 1;
  const requiredSignals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--report") {
      if (!next) throw new Error("--report requires a file path");
      reports.push(next);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      if (!next) throw new Error("--out requires a directory path");
      outDir = next;
      index += 1;
      continue;
    }
    if (arg === "--min-reports") {
      if (!next) throw new Error("--min-reports requires a number");
      minReports = parsePositiveInt(next, "--min-reports");
      index += 1;
      continue;
    }
    if (arg === "--min-tasks") {
      if (!next) throw new Error("--min-tasks requires a number");
      minTasks = parsePositiveInt(next, "--min-tasks");
      index += 1;
      continue;
    }
    if (arg === "--require-signal") {
      if (!next) throw new Error("--require-signal requires a signal name");
      requiredSignals.push(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (reports.length === 0) throw new Error("At least one --report is required");
  if (!outDir) throw new Error("--out is required");
  return {
    reports,
    outDir,
    minReports,
    minTasks,
    requiredSignals: requiredSignals.length > 0 ? uniqueStrings(requiredSignals) : DEFAULT_REQUIRED_SIGNALS,
  };
}

async function readReport(file: string): Promise<JsonObject> {
  const report = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  const obj = asObject(report);
  if (!obj) throw new Error(`${file} is not a JSON object`);
  if (obj.report_version !== REPORT_VERSION) {
    throw new Error(`${file} is not a real ${REPORT_VERSION} report`);
  }
  const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
  if (tasks.length === 0) throw new Error(`${file} does not contain task reports`);
  return obj;
}

function taskReports(report: JsonObject): JsonObject[] {
  return Array.isArray(report.tasks)
    ? report.tasks.map((task) => asObject(task)).filter((task): task is JsonObject => !!task)
    : [];
}

function taskIdFromReport(report: JsonObject, task: JsonObject, index: number): string {
  return asString(task.task_id)
    ?? asString(task.id)
    ?? asString(asObject(task.task)?.id)
    ?? `${asString(report.suite_id) ?? "suite"}:task:${index + 1}`;
}

function finalAionisRun(task: JsonObject): JsonObject | null {
  const direct = asObject(task.aionis);
  if (direct) return direct;
  const attempts = Array.isArray(task.aionis_attempts)
    ? task.aionis_attempts.map((attempt) => asObject(attempt)).filter((attempt): attempt is JsonObject => !!attempt)
    : [];
  return attempts.at(-1) ?? null;
}

function metrics(run: JsonObject | null): JsonObject {
  return asObject(run?.metrics) ?? {};
}

function diagnostics(report: JsonObject): JsonObject {
  return asObject(report.learning_diagnostics) ?? {};
}

function effectGate(report: JsonObject): JsonObject {
  return asObject(report.effect_gate) ?? {};
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reports = await Promise.all(args.reports.map(async (file) => ({
    file: path.resolve(file),
    report: await readReport(file),
  })));

  const taskRows = reports.flatMap(({ file, report }) => taskReports(report).map((task, index) => {
    const aionis = finalAionisRun(task);
    const runMetrics = metrics(aionis);
    return {
      report_file: file,
      suite_id: asString(report.suite_id),
      task_id: taskIdFromReport(report, task, index),
      run_mode: asString(report.run_mode),
      effect_gate_status: asString(effectGate(report).status),
      effect_status: asString(effectGate(report).effect_status),
      provider_health_status: asString(effectGate(report).provider_health_status),
      failed_checks: stringList(effectGate(report).failed_checks),
      aionis_status: asString(aionis?.status),
      verifier_passed: runMetrics.verifier_passed === true,
      llm_api_error_count: asNumber(runMetrics.llm_api_error_count),
      llm_protocol_error_count: asNumber(runMetrics.llm_protocol_error_count),
      forbidden_file_write_count: asNumber(runMetrics.forbidden_file_write_count),
      edited_files: stringList(runMetrics.edited_files),
    };
  }));

  const learningSignals = uniqueStrings(reports.flatMap(({ report }) => stringList(diagnostics(report).learning_signals)));
  const uniqueTaskIds = uniqueStrings(taskRows.map((task) => task.task_id));
  const failedChecks: string[] = [];
  const reportCount = reports.length;
  const uniqueTaskCount = uniqueTaskIds.length;
  const assistedSuccessCount = taskRows.filter((task) => task.aionis_status === "success").length;
  const verifierPassedCount = taskRows.filter((task) => task.verifier_passed).length;
  const assistedLlmApiErrorCount = reports.reduce((sum, { report }) => (
    sum + asNumber(diagnostics(report).assisted_llm_api_error_count)
  ), 0);
  const assistedLlmProtocolErrorCount = reports.reduce((sum, { report }) => (
    sum + asNumber(diagnostics(report).assisted_llm_protocol_error_count)
  ), 0);
  const runtimeMaintenanceRunCount = reports.reduce((sum, { report }) => (
    sum + asNumber(diagnostics(report).runtime_maintenance_run_count)
  ), 0);
  const runtimeMaintenanceAppliedCount = reports.reduce((sum, { report }) => (
    sum + asNumber(diagnostics(report).runtime_maintenance_applied_count)
  ), 0);
  const runtimeMaintenanceMemoryArchiveCount = reports.reduce((sum, { report }) => (
    sum + asNumber(diagnostics(report).runtime_maintenance_memory_archive_count)
  ), 0);
  const forbiddenFileWriteCount = taskRows.reduce((sum, task) => sum + task.forbidden_file_write_count, 0);

  if (reportCount < args.minReports) failedChecks.push("min_reports");
  if (uniqueTaskCount < args.minTasks) failedChecks.push("min_tasks");
  if (taskRows.some((task) => task.effect_gate_status !== "pass")) failedChecks.push("all_effect_gates_pass");
  if (taskRows.some((task) => task.provider_health_status !== "pass")) failedChecks.push("all_provider_health_pass");
  if (assistedSuccessCount !== taskRows.length) failedChecks.push("all_assisted_runs_success");
  if (verifierPassedCount !== taskRows.length) failedChecks.push("all_final_verifiers_pass");
  if (assistedLlmApiErrorCount !== 0) failedChecks.push("zero_assisted_llm_api_errors");
  if (forbiddenFileWriteCount !== 0) failedChecks.push("zero_forbidden_file_writes");
  for (const signal of args.requiredSignals) {
    if (!learningSignals.includes(signal)) failedChecks.push(`required_signal:${signal}`);
  }

  const rollup = {
    rollup_version: ROLLUP_VERSION,
    generated_at: new Date().toISOString(),
    status: failedChecks.length === 0 ? "pass" : "fail",
    failed_checks: failedChecks,
    gates: {
      min_reports: args.minReports,
      min_tasks: args.minTasks,
      required_signals: args.requiredSignals,
      require_all_effect_gates_pass: true,
      require_all_provider_health_pass: true,
      require_all_final_verifiers_pass: true,
      require_zero_assisted_llm_api_errors: true,
      require_zero_forbidden_file_writes: true,
    },
    summary: {
      report_count: reportCount,
      task_count: taskRows.length,
      unique_task_count: uniqueTaskCount,
      unique_task_ids: uniqueTaskIds,
      assisted_success_count: assistedSuccessCount,
      final_verifier_passed_count: verifierPassedCount,
      assisted_llm_api_error_count: assistedLlmApiErrorCount,
      assisted_llm_protocol_error_count: assistedLlmProtocolErrorCount,
      runtime_maintenance_run_count: runtimeMaintenanceRunCount,
      runtime_maintenance_applied_count: runtimeMaintenanceAppliedCount,
      runtime_maintenance_memory_archive_count: runtimeMaintenanceMemoryArchiveCount,
      forbidden_file_write_count: forbiddenFileWriteCount,
      learning_signals: learningSignals,
    },
    reports: reports.map(({ file, report }) => ({
      file,
      suite_id: asString(report.suite_id),
      run_mode: asString(report.run_mode),
      effect_gate_status: asString(effectGate(report).status),
      provider_health_status: asString(effectGate(report).provider_health_status),
      failed_checks: stringList(effectGate(report).failed_checks),
    })),
    tasks: taskRows,
  };

  await fs.mkdir(args.outDir, { recursive: true });
  const outFile = path.join(args.outDir, "real-llm-portfolio-rollup.json");
  await fs.writeFile(outFile, `${JSON.stringify(rollup, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: rollup.status === "pass",
    rollup_file: outFile,
    status: rollup.status,
    failed_checks: rollup.failed_checks,
    report_count: reportCount,
    unique_task_count: uniqueTaskCount,
  }, null, 2));
  if (rollup.status !== "pass") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
