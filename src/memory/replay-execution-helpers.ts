import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import net from "node:net";
import path from "node:path";
import { HttpError } from "../util/http.js";

export type PreconditionResult = {
  kind: string;
  state: "pass" | "fail" | "unknown";
  ok: boolean;
  message: string;
  input: Record<string, unknown>;
};

export type LocalCommandOutcome = {
  ok: boolean;
  status: "success" | "failed" | "timeout";
  command: string;
  argv: string[];
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  error: string | null;
};

export type SignatureCheck = {
  check: string;
  ok: boolean;
  message: string;
};

export type ReplayExecutionBackend = "local_process" | "sandbox_sync" | "sandbox_async";
export type ReplaySensitiveReviewMode = "block" | "warn";

export type ReplaySandboxExecutor = (input: {
  tenant_id: string;
  scope: string;
  project_id: string | null;
  argv: string[];
  timeout_ms: number;
  mode: "sync" | "async";
  metadata?: Record<string, unknown>;
}) => Promise<{
  ok: boolean;
  status: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  error: string | null;
  run_id?: string | null;
}>;

export type ReplayCommandExecutionResult = {
  outcome: LocalCommandOutcome | null;
  pending: boolean;
  backend: ReplayExecutionBackend;
  sandbox_run_id: string | null;
  raw_status: string | null;
  raw_error: string | null;
};

const SENSITIVE_COMMANDS = new Set<string>([
  "rm",
  "mv",
  "cp",
  "chmod",
  "chown",
  "chgrp",
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  "truncate",
  "reboot",
  "shutdown",
  "kill",
  "killall",
  "pkill",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",
  "ln",
  "mount",
  "umount",
  "sed",
  "perl",
]);

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function asStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}

export function normalizeReplayExecutionBackend(raw: string | null): ReplayExecutionBackend {
  if (raw === "sandbox_sync" || raw === "sandbox_async" || raw === "local_process") return raw;
  return "local_process";
}

export function normalizeReplaySensitiveReviewMode(raw: string | null): ReplaySensitiveReviewMode {
  if (raw === "warn") return "warn";
  return "block";
}

export function detectSensitiveCommand(command: string, argv: string[]): {
  sensitive: boolean;
  reason: string | null;
  risk_level: "low" | "medium" | "high";
} {
  const cmd = command.trim();
  if (!cmd) return { sensitive: false, reason: null, risk_level: "low" };
  const lower = cmd.toLowerCase();
  if (!SENSITIVE_COMMANDS.has(lower)) return { sensitive: false, reason: null, risk_level: "low" };

  if (lower === "rm") {
    const joined = argv.join(" ");
    if (/\s-rf(\s|$)/.test(joined) || /\s-fr(\s|$)/.test(joined)) {
      return { sensitive: true, reason: "destructive_delete_recursive", risk_level: "high" };
    }
    return { sensitive: true, reason: "delete_operation", risk_level: "high" };
  }
  if (lower === "dd" || lower === "mkfs" || lower === "fdisk" || lower === "parted") {
    return { sensitive: true, reason: "disk_mutation_operation", risk_level: "high" };
  }
  if (lower === "chmod" || lower === "chown" || lower === "chgrp" || lower === "usermod" || lower === "useradd" || lower === "userdel") {
    return { sensitive: true, reason: "permission_or_identity_mutation", risk_level: "high" };
  }
  if (lower === "sed" || lower === "perl") {
    const joined = argv.join(" ");
    if (/\s-i(\s|$)/.test(joined) || /\s-i[^ ]+/.test(joined)) {
      return { sensitive: true, reason: "in_place_file_mutation", risk_level: "medium" };
    }
    return { sensitive: true, reason: "shell_mutation_tool", risk_level: "medium" };
  }
  return { sensitive: true, reason: "mutation_operation", risk_level: "medium" };
}

async function isPortFree(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

export function isSafeCommandName(raw: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(raw);
}

export function isSafeCommandReference(raw: string): boolean {
  const command = raw.trim();
  if (!command) return false;
  if (isSafeCommandName(command)) return true;
  if (!path.isAbsolute(command)) return false;
  const segments = command.split(path.sep).filter((segment) => segment.length > 0);
  return segments.length > 0 && segments.every((segment) => isSafeCommandName(segment));
}

export function resolveCommandReferenceAliases(raw: string): string[] {
  const command = raw.trim();
  if (!isSafeCommandReference(command)) return [];
  const aliases = new Set<string>();
  aliases.add(command);
  const base = path.basename(command);
  if (base !== command && isSafeCommandName(base)) aliases.add(base);
  return [...aliases.values()];
}

export function isAllowedReplayCommand(raw: string, allowedCommands: Set<string>): boolean {
  const aliases = resolveCommandReferenceAliases(raw);
  return aliases.some((alias) => allowedCommands.has(alias));
}

export async function evaluatePrecondition(raw: unknown): Promise<PreconditionResult> {
  const obj = asObject(raw) ?? {};
  const kind = toStringOrNull(obj.kind) ?? "unknown";
  try {
    if (kind === "always") {
      const value = obj.value !== false;
      return {
        kind,
        state: value ? "pass" : "fail",
        ok: value,
        message: value ? "always=true" : "always=false",
        input: obj,
      };
    }
    if (kind === "file_exists") {
      const path = toStringOrNull(obj.path);
      if (!path) return { kind, state: "unknown", ok: false, message: "path is required", input: obj };
      try {
        accessSync(path, fsConstants.F_OK);
        return { kind, state: "pass", ok: true, message: `file exists: ${path}`, input: obj };
      } catch {
        return { kind, state: "fail", ok: false, message: `file missing: ${path}`, input: obj };
      }
    }
    if (kind === "path_not_exists") {
      const path = toStringOrNull(obj.path);
      if (!path) return { kind, state: "unknown", ok: false, message: "path is required", input: obj };
      try {
        accessSync(path, fsConstants.F_OK);
        return { kind, state: "fail", ok: false, message: `path exists: ${path}`, input: obj };
      } catch {
        return { kind, state: "pass", ok: true, message: `path absent: ${path}`, input: obj };
      }
    }
    if (kind === "command_available") {
      const command = toStringOrNull(obj.command);
      if (!command) return { kind, state: "unknown", ok: false, message: "command is required", input: obj };
      if (!isSafeCommandName(command)) {
        return { kind, state: "unknown", ok: false, message: "command contains unsafe characters", input: obj };
      }
      const probe = spawnSync("which", [command], { stdio: "pipe", encoding: "utf8" });
      if ((probe.status ?? 1) === 0) {
        return { kind, state: "pass", ok: true, message: `command available: ${command}`, input: obj };
      }
      return { kind, state: "fail", ok: false, message: `command missing: ${command}`, input: obj };
    }
    if (kind === "env_exists") {
      const name = toStringOrNull(obj.name);
      if (!name) return { kind, state: "unknown", ok: false, message: "name is required", input: obj };
      const value = process.env[name];
      const ok = typeof value === "string" && value.trim().length > 0;
      return {
        kind,
        state: ok ? "pass" : "fail",
        ok,
        message: ok ? `env exists: ${name}` : `env missing: ${name}`,
        input: obj,
      };
    }
    if (kind === "env_equals") {
      const name = toStringOrNull(obj.name);
      const value = toStringOrNull(obj.value);
      if (!name || value == null) return { kind, state: "unknown", ok: false, message: "name/value are required", input: obj };
      const current = process.env[name] ?? "";
      const ok = current === value;
      return {
        kind,
        state: ok ? "pass" : "fail",
        ok,
        message: ok ? `env matched: ${name}` : `env mismatch: ${name}`,
        input: obj,
      };
    }
    if (kind === "port_free") {
      const port = Number(obj.port);
      const host = toStringOrNull(obj.host) ?? "127.0.0.1";
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return { kind, state: "unknown", ok: false, message: "valid port is required", input: obj };
      }
      const free = await isPortFree(host, port);
      return {
        kind,
        state: free ? "pass" : "fail",
        ok: free,
        message: free ? `port free: ${host}:${port}` : `port occupied: ${host}:${port}`,
        input: obj,
      };
    }
    if (kind === "cwd_contains") {
      const token = toStringOrNull(obj.token);
      const cwd = process.cwd();
      if (!token) return { kind, state: "unknown", ok: false, message: "token is required", input: obj };
      const ok = cwd.includes(token);
      return {
        kind,
        state: ok ? "pass" : "fail",
        ok,
        message: ok ? `cwd contains token: ${token}` : `cwd missing token: ${token}`,
        input: obj,
      };
    }
    return { kind, state: "unknown", ok: false, message: `unsupported precondition kind: ${kind}`, input: obj };
  } catch (err) {
    return {
      kind,
      state: "unknown",
      ok: false,
      message: `precondition evaluation error: ${String(err)}`,
      input: obj,
    };
  }
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function runLocalCommand(
  argv: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    stdioMaxBytes: number;
  },
): LocalCommandOutcome {
  const startedAt = Date.now();
  const command = String(argv[0] ?? "").trim();
  if (!command || argv.length === 0) {
    return {
      ok: false,
      status: "failed",
      command: command || "",
      argv,
      stdout: "",
      stderr: "",
      exit_code: null,
      duration_ms: 0,
      timed_out: false,
      error: "invalid_command_argv",
    };
  }

  try {
    const out = spawnSync(command, argv.slice(1), {
      cwd: opts.cwd,
      shell: false,
      timeout: Math.max(100, opts.timeoutMs),
      maxBuffer: Math.max(1024, opts.stdioMaxBytes),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    const stdout = typeof out.stdout === "string" ? out.stdout : Buffer.from(out.stdout ?? "").toString("utf8");
    const stderr = typeof out.stderr === "string" ? out.stderr : Buffer.from(out.stderr ?? "").toString("utf8");
    const timedOut = String((out.error as { code?: string } | undefined)?.code ?? "").toUpperCase() === "ETIMEDOUT";
    const exitCode = Number.isFinite(out.status ?? NaN) ? Number(out.status) : null;
    const error = out.error ? String((out.error as { message?: string }).message ?? out.error) : null;
    const status: "success" | "failed" | "timeout" = timedOut ? "timeout" : exitCode === 0 && !error ? "success" : "failed";
    return {
      ok: status === "success",
      status,
      command,
      argv,
      stdout,
      stderr,
      exit_code: exitCode,
      duration_ms: Math.max(0, Date.now() - startedAt),
      timed_out: timedOut,
      error,
    };
  } catch (err) {
    return {
      ok: false,
      status: "failed",
      command,
      argv,
      stdout: "",
      stderr: "",
      exit_code: null,
      duration_ms: Math.max(0, Date.now() - startedAt),
      timed_out: false,
      error: String(err),
    };
  }
}

export function sandboxResultToOutcome(
  input: {
    ok: boolean;
    status: string;
    stdout: string;
    stderr: string;
    exit_code: number | null;
    error: string | null;
  },
  argv: string[],
  durationMs: number,
): LocalCommandOutcome {
  const command = String(argv[0] ?? "").trim();
  const status: "success" | "failed" | "timeout" =
    input.status === "succeeded" || input.ok
      ? "success"
      : input.status === "timeout"
        ? "timeout"
        : "failed";
  return {
    ok: status === "success",
    status,
    command,
    argv,
    stdout: String(input.stdout ?? ""),
    stderr: String(input.stderr ?? ""),
    exit_code: Number.isFinite(input.exit_code ?? NaN) ? Number(input.exit_code) : null,
    duration_ms: Math.max(0, Math.trunc(durationMs)),
    timed_out: status === "timeout",
    error: input.error ? String(input.error) : null,
  };
}

export async function executeReplayCommand(args: {
  backend: ReplayExecutionBackend;
  tenant_id: string;
  scope: string;
  project_id: string | null;
  argv: string[];
  timeout_ms: number;
  local: {
    cwd: string;
    stdioMaxBytes: number;
  };
  sandboxExecutor?: ReplaySandboxExecutor;
}): Promise<ReplayCommandExecutionResult> {
  if (args.backend === "local_process") {
    const localOut = runLocalCommand(args.argv, {
      cwd: args.local.cwd,
      timeoutMs: args.timeout_ms,
      stdioMaxBytes: args.local.stdioMaxBytes,
    });
    return {
      outcome: localOut,
      pending: false,
      backend: args.backend,
      sandbox_run_id: null,
      raw_status: localOut.status,
      raw_error: localOut.error,
    };
  }

  if (!args.sandboxExecutor) {
    throw new HttpError(
      400,
      "replay_sandbox_executor_not_enabled",
      "sandbox execution backend is requested but sandbox executor is not configured",
      { backend: args.backend },
    );
  }

  const startedAt = Date.now();
  const sandboxMode: "sync" | "async" = args.backend === "sandbox_sync" ? "sync" : "async";
  const sandboxOut = await args.sandboxExecutor({
    tenant_id: args.tenant_id,
    scope: args.scope,
    project_id: args.project_id,
    argv: args.argv,
    timeout_ms: args.timeout_ms,
    mode: sandboxMode,
    metadata: {
      source: "replay_playbook_run",
      backend: args.backend,
    },
  });

  const rawStatus = toStringOrNull(sandboxOut.status) ?? "unknown";
  const pending =
    sandboxMode === "async"
    || rawStatus === "queued"
    || rawStatus === "running";
  if (pending) {
    return {
      outcome: null,
      pending: true,
      backend: args.backend,
      sandbox_run_id: toStringOrNull(sandboxOut.run_id) ?? null,
      raw_status: rawStatus,
      raw_error: toStringOrNull(sandboxOut.error),
    };
  }

  const outcome = sandboxResultToOutcome(
    {
      ok: sandboxOut.ok,
      status: rawStatus,
      stdout: String(sandboxOut.stdout ?? ""),
      stderr: String(sandboxOut.stderr ?? ""),
      exit_code: Number.isFinite(sandboxOut.exit_code ?? NaN) ? Number(sandboxOut.exit_code) : null,
      error: sandboxOut.error ? String(sandboxOut.error) : null,
    },
    args.argv,
    Date.now() - startedAt,
  );
  return {
    outcome,
    pending: false,
    backend: args.backend,
    sandbox_run_id: toStringOrNull(sandboxOut.run_id) ?? null,
    raw_status: rawStatus,
    raw_error: toStringOrNull(sandboxOut.error),
  };
}

export type SignatureEvaluation = { ok: boolean; checks: SignatureCheck[] };

export function evaluateExpectedSignature(expected: unknown, outcome: LocalCommandOutcome): SignatureEvaluation {
  const checks: SignatureCheck[] = [];
  const spec = asObject(expected);
  if (!spec) return { ok: true, checks };

  const combinedOutput = `${outcome.stdout}\n${outcome.stderr}`;
  if (spec.exit_code !== undefined) {
    const expectedCode = Number(spec.exit_code);
    const ok = Number.isFinite(expectedCode) && outcome.exit_code === Math.trunc(expectedCode);
    checks.push({
      check: "exit_code",
      ok,
      message: ok
        ? `exit_code matched (${Math.trunc(expectedCode)})`
        : `exit_code mismatch (expected=${Math.trunc(expectedCode)}, actual=${String(outcome.exit_code)})`,
    });
  }
  if (spec.stdout_contains !== undefined) {
    const values = Array.isArray(spec.stdout_contains) ? asStringArray(spec.stdout_contains) : asStringArray([spec.stdout_contains]);
    for (const token of values) {
      const ok = outcome.stdout.includes(token);
      checks.push({
        check: "stdout_contains",
        ok,
        message: ok ? `stdout contains '${token}'` : `stdout missing '${token}'`,
      });
    }
  }
  if (spec.stderr_contains !== undefined) {
    const values = Array.isArray(spec.stderr_contains) ? asStringArray(spec.stderr_contains) : asStringArray([spec.stderr_contains]);
    for (const token of values) {
      const ok = outcome.stderr.includes(token);
      checks.push({
        check: "stderr_contains",
        ok,
        message: ok ? `stderr contains '${token}'` : `stderr missing '${token}'`,
      });
    }
  }
  if (spec.output_regex !== undefined) {
    const raw = toStringOrNull(spec.output_regex);
    if (!raw) {
      checks.push({ check: "output_regex", ok: false, message: "output_regex is empty" });
    } else {
      try {
        const re = new RegExp(raw, "m");
        const ok = re.test(combinedOutput);
        checks.push({
          check: "output_regex",
          ok,
          message: ok ? `output_regex matched /${raw}/` : `output_regex not matched /${raw}/`,
        });
      } catch {
        checks.push({ check: "output_regex", ok: false, message: "output_regex is invalid" });
      }
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export async function evaluatePostcondition(raw: unknown, outcome: LocalCommandOutcome): Promise<PreconditionResult> {
  const obj = asObject(raw) ?? {};
  const kind = toStringOrNull(obj.kind) ?? "unknown";
  if (kind === "exit_code") {
    const expected = Number(obj.value);
    if (!Number.isFinite(expected)) {
      return { kind, state: "unknown", ok: false, message: "postcondition exit_code requires numeric value", input: obj };
    }
    const ok = outcome.exit_code === Math.trunc(expected);
    return {
      kind,
      state: ok ? "pass" : "fail",
      ok,
      message: ok
        ? `postcondition exit_code matched (${Math.trunc(expected)})`
        : `postcondition exit_code mismatch (expected=${Math.trunc(expected)}, actual=${String(outcome.exit_code)})`,
      input: obj,
    };
  }
  if (kind === "stdout_contains") {
    const token = toStringOrNull(obj.value);
    if (!token) return { kind, state: "unknown", ok: false, message: "postcondition stdout_contains requires value", input: obj };
    const ok = outcome.stdout.includes(token);
    return {
      kind,
      state: ok ? "pass" : "fail",
      ok,
      message: ok ? `stdout contains '${token}'` : `stdout missing '${token}'`,
      input: obj,
    };
  }
  if (kind === "stderr_contains") {
    const token = toStringOrNull(obj.value);
    if (!token) return { kind, state: "unknown", ok: false, message: "postcondition stderr_contains requires value", input: obj };
    const ok = outcome.stderr.includes(token);
    return {
      kind,
      state: ok ? "pass" : "fail",
      ok,
      message: ok ? `stderr contains '${token}'` : `stderr missing '${token}'`,
      input: obj,
    };
  }
  return await evaluatePrecondition(raw);
}
