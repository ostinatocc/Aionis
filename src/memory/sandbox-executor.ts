import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { recordSandboxRunTelemetryRow, type SandboxStore } from "../store/sandbox-access.js";
import { HttpError, badRequest } from "../util/http.js";
import {
  ipInCidrs,
  isPrivateOrLocalIp,
  parseCidrRule,
  postJsonWithTls,
  sandboxRemoteEgressAllowed,
  sandboxRemoteHostAllowed,
  type ParsedCidr,
} from "./sandbox-network.js";
import {
  TERMINAL_SANDBOX_STATUSES,
  SandboxRunRow,
  SandboxRunStatus,
  asFiniteIntOrNull,
  clampOutputAppend,
  jsonObject,
  normalizeSandboxStatus,
  normalizeTimeoutMs,
  tailText,
  trimOrNull,
} from "./sandbox-shared.js";

export type SandboxExecutorConfig = {
  enabled: boolean;
  mode: "local_process" | "http_remote";
  maxConcurrency: number;
  defaultTimeoutMs: number;
  stdioMaxBytes: number;
  workdir: string;
  allowedCommands: Set<string>;
  remote: {
    url: string | null;
    authHeader: string;
    authToken: string;
    timeoutMs: number;
    allowedHosts: Set<string>;
    allowedEgressCidrs: Set<string>;
    denyPrivateIps: boolean;
    mtlsCertPem: string;
    mtlsKeyPem: string;
    mtlsCaPem: string;
    mtlsServerName: string;
  };
  artifactObjectStoreBaseUri: string | null;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  recoveryPollIntervalMs: number;
  recoveryBatchSize: number;
};

type ActiveRunTerminalCause = "timeout" | "request" | "shutdown";

type ActiveRunState =
  | {
      kind: "local_process";
      child: ChildProcessWithoutNullStreams;
      terminalCause: ActiveRunTerminalCause | null;
    }
  | {
      kind: "http_remote";
      abort: AbortController;
      terminalCause: ActiveRunTerminalCause | null;
    };

function stopActiveRun(state: ActiveRunState, cause: ActiveRunTerminalCause): void {
  state.terminalCause ??= cause;
  try {
    if (state.kind === "local_process") state.child.kill("SIGKILL");
    else state.abort.abort();
  } catch {
    // Cancellation is best-effort; shutdown still waits for terminal finalization.
  }
}

function activeRunTerminalCause(state: ActiveRunState, run: SandboxRunRow): ActiveRunTerminalCause | null {
  return state.terminalCause ?? (run.cancel_requested ? "request" : null);
}

function cancellationError(cause: "request" | "shutdown"): string {
  return cause === "shutdown" ? "canceled_by_shutdown" : "canceled_by_request";
}

export class SandboxExecutor {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly active = new Map<string, ActiveRunState>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly recoveryTimer: NodeJS.Timeout | null;
  private readonly remoteAllowedCidrs: ParsedCidr[];
  private running = 0;
  private pumping = false;
  private shuttingDown = false;
  private recoveryInFlight = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly store: SandboxStore,
    private readonly config: SandboxExecutorConfig,
  ) {
    this.remoteAllowedCidrs = [...this.config.remote.allowedEgressCidrs.values()]
      .map((rule) => parseCidrRule(rule))
      .filter((rule): rule is ParsedCidr => !!rule);
    this.recoveryTimer =
      this.config.enabled && this.config.recoveryPollIntervalMs > 0
        ? setInterval(() => {
            void this.track(this.recoverStaleRuns()).catch(() => {
              // Recovery remains best-effort; shutdown still waits for it.
            });
          }, this.config.recoveryPollIntervalMs)
        : null;
  }

  enqueue(runId: string): void {
    if (!this.config.enabled || this.shuttingDown) return;
    const id = String(runId ?? "").trim();
    if (!id || this.queued.has(id)) return;
    this.queue.push(id);
    this.queued.add(id);
    this.kick();
  }

  async executeSync(runId: string): Promise<void> {
    if (!this.config.enabled) throw new HttpError(400, "sandbox_disabled", "sandbox interface is disabled");
    if (this.shuttingDown) {
      throw new HttpError(503, "sandbox_shutting_down", "sandbox executor is shutting down");
    }
    await this.track(this.processRun(String(runId ?? "").trim()));
  }

  healthSnapshot() {
    return {
      enabled: this.config.enabled,
      mode: this.config.mode,
      queue_depth: this.queue.length,
      active_runs: this.active.size,
      max_concurrency: this.config.maxConcurrency,
      remote_executor_configured: this.config.mode === "http_remote" ? !!this.config.remote.url : false,
      remote_executor_timeout_ms: this.config.mode === "http_remote" ? this.config.remote.timeoutMs : null,
      remote_executor_allowlist_count: this.config.mode === "http_remote" ? this.config.remote.allowedHosts.size : null,
      remote_executor_egress_cidr_count: this.config.mode === "http_remote" ? this.remoteAllowedCidrs.length : null,
      remote_executor_deny_private_ips: this.config.mode === "http_remote" ? this.config.remote.denyPrivateIps : null,
      remote_executor_mtls_enabled:
        this.config.mode === "http_remote"
          ? !!(
              trimOrNull(this.config.remote.mtlsCertPem)
              || trimOrNull(this.config.remote.mtlsKeyPem)
              || trimOrNull(this.config.remote.mtlsCaPem)
              || trimOrNull(this.config.remote.mtlsServerName)
            )
          : null,
      heartbeat_interval_ms: this.config.heartbeatIntervalMs,
      stale_after_ms: this.config.staleAfterMs,
      recovery_poll_interval_ms: this.config.recoveryPollIntervalMs,
    };
  }

  requestCancel(runId: string): boolean {
    const id = String(runId ?? "").trim();
    const state = this.active.get(id);
    if (!state) return false;
    stopActiveRun(state, "request");
    return true;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    for (const t of this.heartbeatTimers.values()) clearInterval(t);
    this.heartbeatTimers.clear();
    for (const state of this.active.values()) stopActiveRun(state, "shutdown");
    const queuedRunIds = this.queue.splice(0);
    this.queued.clear();
    const pending = [...this.inFlight];
    this.shutdownPromise = Promise.allSettled([
      ...pending,
      this.cancelQueuedRunsBeforeShutdown(queuedRunIds),
    ]).then((results) => {
      this.active.clear();
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "sandbox shutdown failed to durably terminalize every accepted run");
      }
    });
    return this.shutdownPromise;
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.inFlight.add(task);
    void task.then(
      () => this.inFlight.delete(task),
      () => this.inFlight.delete(task),
    );
    return task;
  }

  private kick(): void {
    if (this.pumping || this.shuttingDown) return;
    this.pumping = true;
    setImmediate(async () => {
      try {
        while (!this.shuttingDown && this.running < this.config.maxConcurrency && this.queue.length > 0) {
          const nextId = this.queue.shift()!;
          this.queued.delete(nextId);
          this.running += 1;
          void this.track(this.processRun(nextId)).finally(() => {
            this.running = Math.max(0, this.running - 1);
            this.kick();
          }).catch(() => undefined);
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  private async processRun(runId: string): Promise<void> {
    if (!runId) return;
    let run = await this.claimQueuedRun(runId);
    if (!run) {
      run = await this.loadRunningRun(runId);
      if (!run) return;
    }
    if (run.cancel_requested) {
      await this.finalize(run.id, {
        status: "canceled",
        stdout: run.stdout_text ?? "",
        stderr: run.stderr_text ?? "",
        truncated: !!run.output_truncated,
        exitCode: run.exit_code,
        error: "canceled_before_execution",
        result: {
          ...(run.error ? { prior_error: run.error } : {}),
          canceled: true,
          canceled_by: "request",
          stage: "pre_start",
        },
      });
      return;
    }
    const shutdownFinalization = this.shutdownBeforeActivation(run, this.config.mode);
    if (shutdownFinalization) {
      await shutdownFinalization;
      return;
    }
    if (this.config.mode === "local_process") {
      const stopHeartbeat = this.startRunHeartbeat(run.id);
      try {
        await this.executeLocalProcess(run);
      } finally {
        stopHeartbeat();
      }
      return;
    }
    const stopHeartbeat = this.startRunHeartbeat(run.id);
    try {
      await this.executeRemote(run);
    } finally {
      stopHeartbeat();
    }
  }

  private startRunHeartbeat(runId: string): () => void {
    const intervalMs = this.config.heartbeatIntervalMs;
    if (intervalMs <= 0) return () => {};
    const id = String(runId ?? "").trim();
    if (!id) return () => {};
    const prev = this.heartbeatTimers.get(id);
    if (prev) clearInterval(prev);
    const timer = setInterval(() => {
      void this.store.withClient(async (access) => {
        await access.touchRunningRun({ id });
      }).catch(() => {
        // heartbeat failures are best-effort and should not crash executor loop
      });
    }, intervalMs);
    this.heartbeatTimers.set(id, timer);
    return () => {
      const active = this.heartbeatTimers.get(id);
      if (active) clearInterval(active);
      this.heartbeatTimers.delete(id);
    };
  }

  private async recoverStaleRuns(): Promise<void> {
    if (!this.config.enabled || this.shuttingDown || this.recoveryInFlight || this.config.recoveryPollIntervalMs <= 0) return;
    this.recoveryInFlight = true;
    try {
      const staleRows = await this.store.withClient(async (access) => {
        return await access.listStaleRunningRuns({
          staleAfterSeconds: Math.max(1, Math.trunc(this.config.staleAfterMs / 1000)),
          limit: this.config.recoveryBatchSize,
        });
      });

      for (const row of staleRows) {
        if (this.active.has(row.id)) continue;
        await this.finalizeIfRunning(row.id, {
          status: "timeout",
          stdout: row.stdout_text ?? "",
          stderr: row.stderr_text ?? "",
          truncated: !!row.output_truncated,
          exitCode: row.exit_code,
          error: row.error ?? "executor_stale_recovered",
          result: {
            ...(row.result_json && typeof row.result_json === "object" ? row.result_json : {}),
            recovery: {
              stale_recovered: true,
              stale_after_ms: this.config.staleAfterMs,
            },
          },
        });
      }
    } finally {
      this.recoveryInFlight = false;
    }
  }

  private async parseCommandArgv(
    run: SandboxRunRow,
    executor: "local_process" | "http_remote",
  ): Promise<{ argv: string[]; file: string } | null> {
    const argvRaw = Array.isArray(run.action_json?.argv) ? run.action_json.argv : null;
    if (!argvRaw || argvRaw.length === 0) {
      await this.finalize(run.id, {
        status: "failed",
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: null,
        error: "invalid_command_argv",
        result: { executor },
      });
      return null;
    }
    const argv = argvRaw.map((v: any) => String(v));
    const file = String(argv[0] ?? "").trim();
    if (!file) {
      await this.finalize(run.id, {
        status: "failed",
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: null,
        error: "invalid_command_name",
        result: { executor },
      });
      return null;
    }
    if (!this.config.allowedCommands.has(file)) {
      await this.finalize(run.id, {
        status: "failed",
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: null,
        error: "sandbox_command_not_allowed",
        result: { executor, command: file },
      });
      return null;
    }
    return { argv, file };
  }

  private async executeLocalProcess(run: SandboxRunRow): Promise<void> {
    const command = await this.parseCommandArgv(run, "local_process");
    if (!command) return;
    const { argv, file } = command;

    await mkdir(this.config.workdir, { recursive: true });
    const shutdownFinalization = this.shutdownBeforeActivation(run, "local_process");
    if (shutdownFinalization) {
      await shutdownFinalization;
      return;
    }
    const args = argv.slice(1);
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let spawnErr: string | null = null;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;

    const child = spawn(file, args, {
      cwd: this.config.workdir,
      shell: false,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    const state: ActiveRunState = { kind: "local_process", child, terminalCause: null };
    this.active.set(run.id, state);

    const timeoutMs = normalizeTimeoutMs(run.timeout_ms, this.config.defaultTimeoutMs);
    const timer = setTimeout(() => {
      stopActiveRun(state, "timeout");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const out = clampOutputAppend(stdout, chunk, this.config.stdioMaxBytes);
      stdout = out.next;
      if (out.truncated) truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const out = clampOutputAppend(stderr, chunk, this.config.stdioMaxBytes);
      stderr = out.next;
      if (out.truncated) truncated = true;
    });
    child.on("error", (err: Error) => {
      spawnErr = String(err?.message ?? err);
    });

    await new Promise<void>((resolve) => {
      child.on("close", (code, sig) => {
        exitCode = Number.isFinite(code ?? NaN) ? Number(code) : null;
        signal = sig ?? null;
        resolve();
      });
    });

    clearTimeout(timer);
    this.active.delete(run.id);

    let status: SandboxRunStatus = "failed";
    let error: string | null = null;
    const terminalCause = activeRunTerminalCause(state, run);
    if (terminalCause === "timeout") {
      status = "timeout";
      error = "execution_timeout";
    } else if (terminalCause) {
      status = "canceled";
      error = cancellationError(terminalCause);
    } else if (spawnErr) {
      status = "failed";
      error = spawnErr;
    } else if (exitCode === 0) {
      status = "succeeded";
      error = null;
    } else {
      status = "failed";
      error = `non_zero_exit_code:${String(exitCode ?? "null")}`;
    }

    await this.finalize(run.id, {
      status,
      stdout,
      stderr,
      truncated,
      exitCode,
      error,
      result: {
        executor: "local_process",
        command: file,
        argv,
        signal,
        timed_out: terminalCause === "timeout",
        canceled: terminalCause === "request" || terminalCause === "shutdown",
        canceled_by: terminalCause === "request" || terminalCause === "shutdown" ? terminalCause : null,
      },
    });
  }

  private async executeRemote(run: SandboxRunRow): Promise<void> {
    const command = await this.parseCommandArgv(run, "http_remote");
    if (!command) return;
    const remoteUrl = trimOrNull(this.config.remote.url);
    if (!remoteUrl) {
      await this.finalize(run.id, {
        status: "failed",
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: null,
        error: "remote_executor_not_configured",
        result: { executor: "http_remote" },
      });
      return;
    }
    let parsedRemoteUrl: URL;
    try {
      parsedRemoteUrl = new URL(remoteUrl);
    } catch {
      await this.finalize(run.id, {
        status: "failed",
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: null,
        error: "remote_executor_url_invalid",
        result: { executor: "http_remote" },
      });
      return;
    }
    if (!sandboxRemoteHostAllowed(parsedRemoteUrl.hostname, this.config.remote.allowedHosts)) {
      await this.finalize(run.id, {
        status: "failed",
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: null,
        error: "remote_executor_host_not_allowed",
        result: { executor: "http_remote", host: parsedRemoteUrl.hostname },
      });
      return;
    }
    if (this.remoteAllowedCidrs.length === 0) {
      await this.finalize(run.id, {
        status: "failed",
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: null,
        error: "remote_executor_egress_cidr_blocked",
        result: {
          executor: "http_remote",
          host: parsedRemoteUrl.hostname,
          resolved_ips: [],
          blocked_ips: [],
        },
      });
      return;
    }
    let resolvedIps: string[] = [];
    try {
      const resolved = await lookup(parsedRemoteUrl.hostname, { all: true, verbatim: true });
      resolvedIps = resolved
        .map((entry) => String(entry?.address ?? "").trim())
        .filter((entry) => isIP(entry) !== 0);
    } catch {
      await this.finalize(run.id, {
        status: "failed",
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: null,
        error: "remote_executor_dns_lookup_failed",
        result: { executor: "http_remote", host: parsedRemoteUrl.hostname },
      });
      return;
    }
    if (resolvedIps.length === 0) {
      await this.finalize(run.id, {
        status: "failed",
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: null,
        error: "remote_executor_no_resolved_ip",
        result: { executor: "http_remote", host: parsedRemoteUrl.hostname },
      });
      return;
    }
    if (!sandboxRemoteEgressAllowed(resolvedIps, this.remoteAllowedCidrs)) {
      const blocked = resolvedIps.filter((ip) => !ipInCidrs(ip, this.remoteAllowedCidrs));
      await this.finalize(run.id, {
        status: "failed",
        stdout: "",
        stderr: "",
        truncated: false,
        exitCode: null,
        error: "remote_executor_egress_cidr_blocked",
        result: {
          executor: "http_remote",
          host: parsedRemoteUrl.hostname,
          resolved_ips: resolvedIps,
          blocked_ips: blocked,
        },
      });
      return;
    }
    if (this.config.remote.denyPrivateIps) {
      const blockedPrivate = resolvedIps.filter(
        (ip) => isPrivateOrLocalIp(ip) && !ipInCidrs(ip, this.remoteAllowedCidrs),
      );
      if (blockedPrivate.length > 0) {
        await this.finalize(run.id, {
          status: "failed",
          stdout: "",
          stderr: "",
          truncated: false,
          exitCode: null,
          error: "remote_executor_private_egress_blocked",
          result: {
            executor: "http_remote",
            host: parsedRemoteUrl.hostname,
            resolved_ips: resolvedIps,
            blocked_private_ips: blockedPrivate,
          },
        });
        return;
      }
    }

    const shutdownFinalization = this.shutdownBeforeActivation(run, "http_remote");
    if (shutdownFinalization) {
      await shutdownFinalization;
      return;
    }

    const timeoutMs = normalizeTimeoutMs(
      Math.min(run.timeout_ms, this.config.remote.timeoutMs),
      Math.min(this.config.defaultTimeoutMs, this.config.remote.timeoutMs),
    );
    const connectIp = resolvedIps[0] ?? null;
    const maxRemoteResponseBytes = Math.max(this.config.stdioMaxBytes * 8, 256 * 1024);
    const startedAt = Date.now();
    const abort = new AbortController();
    const state: ActiveRunState = { kind: "http_remote", abort, terminalCause: null };
    this.active.set(run.id, state);
    const timer = setTimeout(() => {
      stopActiveRun(state, "timeout");
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let exitCode: number | null = null;
    let status: SandboxRunStatus = "failed";
    let error: string | null = null;
    let result: Record<string, unknown> = {
      executor: "http_remote",
      command: command.file,
      argv: command.argv,
      host: parsedRemoteUrl.hostname,
      resolved_ips: resolvedIps,
      connect_ip: connectIp,
      remote_response_max_bytes: maxRemoteResponseBytes,
    };

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const authHeader = trimOrNull(this.config.remote.authHeader);
      const authToken = trimOrNull(this.config.remote.authToken);
      if (authHeader && authToken) headers[authHeader.toLowerCase()] = authToken;

      const requestBody = JSON.stringify({
        run_id: run.id,
        tenant_id: run.tenant_id,
        scope: run.scope,
        project_id: run.project_id ?? null,
        session_id: run.session_id,
        planner_run_id: run.planner_run_id,
        decision_id: run.decision_id,
        mode: run.mode,
        timeout_ms: timeoutMs,
        action: {
          kind: "command",
          argv: command.argv,
        },
        metadata: jsonObject(run.metadata),
      });
      const remoteResponse = await postJsonWithTls(
        parsedRemoteUrl,
        requestBody,
        headers,
        timeoutMs,
        abort.signal,
        {
          certPem: this.config.remote.mtlsCertPem,
          keyPem: this.config.remote.mtlsKeyPem,
          caPem: this.config.remote.mtlsCaPem,
          serverName: this.config.remote.mtlsServerName,
        },
        {
          resolvedAddress: connectIp,
          maxBodyBytes: maxRemoteResponseBytes,
        },
      );
      const rawBodyText = remoteResponse.bodyText;
      const body = rawBodyText.length > 0
        ? (() => {
            try {
              return JSON.parse(rawBodyText);
            } catch {
              return null;
            }
          })()
        : null;
      const outputObj = body && typeof body === "object" ? (body as any).output : null;
      const rawStdout = body && typeof body === "object" ? (body as any).stdout : null;
      const rawStderr = body && typeof body === "object" ? (body as any).stderr : null;
      stdout = tailText(
        typeof rawStdout === "string"
          ? rawStdout
          : outputObj && typeof outputObj.stdout === "string"
            ? outputObj.stdout
            : "",
        this.config.stdioMaxBytes,
      );
      stderr = tailText(
        typeof rawStderr === "string"
          ? rawStderr
          : outputObj && typeof outputObj.stderr === "string"
            ? outputObj.stderr
            : "",
        this.config.stdioMaxBytes,
      );
      truncated = !!(
        (outputObj && typeof outputObj === "object" && (outputObj as any).truncated)
        || (body && typeof body === "object" && (body as any).output_truncated)
      );
      exitCode = asFiniteIntOrNull(body && typeof body === "object" ? (body as any).exit_code : null);
      if (remoteResponse.status < 200 || remoteResponse.status >= 300) {
        status = "failed";
        error = `remote_executor_http_${remoteResponse.status}`;
      } else {
        status =
          normalizeSandboxStatus(body && typeof body === "object" ? (body as any).status : null)
          ?? (exitCode === 0 ? "succeeded" : "failed");
        if (!TERMINAL_SANDBOX_STATUSES.has(status)) {
          status = "failed";
          error = "remote_executor_non_terminal_status";
        }
        if (!error) {
          error = trimOrNull(body && typeof body === "object" ? (body as any).error : null);
          if (!error && status !== "succeeded") error = "remote_executor_failed";
        }
      }
      const resultPayload =
        body && typeof body === "object" && body.result && typeof body.result === "object" ? body.result : {};
      result = {
        ...result,
        remote_http_status: remoteResponse.status,
        remote_request_ms: Math.max(0, Date.now() - startedAt),
        result: resultPayload,
      };
    } catch (err: any) {
      const terminalCause = activeRunTerminalCause(state, run);
      if (terminalCause === "timeout") {
        status = "timeout";
        error = "execution_timeout";
      } else if (terminalCause) {
        status = "canceled";
        error = cancellationError(terminalCause);
      } else if (String(err?.message ?? err) === "response_too_large") {
        status = "failed";
        error = "remote_executor_response_too_large";
      } else {
        status = "failed";
        error = `remote_executor_error:${String(err?.message ?? err)}`;
      }
      result = {
        ...result,
        remote_request_ms: Math.max(0, Date.now() - startedAt),
      };
    } finally {
      clearTimeout(timer);
      this.active.delete(run.id);
    }

    const terminalCause = activeRunTerminalCause(state, run);
    if (terminalCause === "timeout") {
      status = "timeout";
      error = "execution_timeout";
      result = { ...result, timed_out: true };
    } else if (terminalCause) {
      status = "canceled";
      error = cancellationError(terminalCause);
      result = { ...result, canceled: true, canceled_by: terminalCause };
    }

    await this.finalize(run.id, {
      status,
      stdout,
      stderr,
      truncated,
      exitCode,
      error,
      result,
    });
  }

  private async claimQueuedRun(runId: string): Promise<SandboxRunRow | null> {
    return await this.store.withTx(async (access) => {
      return await access.claimQueuedRun({ id: runId });
    });
  }

  private async loadRunningRun(runId: string): Promise<SandboxRunRow | null> {
    return await this.store.withClient(async (access) => {
      return await access.getRunningRun({ id: runId });
    });
  }

  private shutdownBeforeActivation(
    run: SandboxRunRow,
    executor: SandboxExecutorConfig["mode"],
  ): Promise<void> | null {
    if (!this.shuttingDown) return null;
    return this.finalizeIfRunning(run.id, {
      status: "canceled",
      stdout: run.stdout_text ?? "",
      stderr: run.stderr_text ?? "",
      truncated: !!run.output_truncated,
      exitCode: run.exit_code,
      error: "canceled_by_shutdown",
      result: {
        executor,
        canceled: true,
        canceled_by: "shutdown",
        stage: "shutdown_before_activation",
      },
    });
  }

  private async cancelQueuedRunsBeforeShutdown(runIds: string[]): Promise<void> {
    const failures: unknown[] = [];
    for (const id of runIds) {
      try {
        await this.store.withTx(async (access) => {
          const row = await access.cancelQueuedRun({ id, cause: "shutdown" });
          if (row) await recordSandboxRunTelemetryRow(access, row);
        });
      } catch (error) {
        failures.push(new Error(`failed to cancel queued sandbox run ${id} during shutdown`, { cause: error }));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "sandbox shutdown failed to cancel every queued run");
    }
  }

  private async finalize(
    runId: string,
    args: {
      status: SandboxRunStatus;
      stdout: string;
      stderr: string;
      truncated: boolean;
      exitCode: number | null;
      error: string | null;
      result: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.store.withClient(async (access) => {
      const row = await access.finalizeRun({
        id: runId,
        status: args.status,
        stdoutText: args.stdout,
        stderrText: args.stderr,
        outputTruncated: args.truncated,
        exitCode: args.exitCode,
        error: args.error,
        resultJson: JSON.stringify(args.result),
      });
      if (row) {
        await recordSandboxRunTelemetryRow(access, row);
      }
    });
  }

  private async finalizeIfRunning(
    runId: string,
    args: {
      status: SandboxRunStatus;
      stdout: string;
      stderr: string;
      truncated: boolean;
      exitCode: number | null;
      error: string | null;
      result: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.store.withClient(async (access) => {
      const row = await access.finalizeRunningRun({
        id: runId,
        status: args.status,
        stdoutText: args.stdout,
        stderrText: args.stderr,
        outputTruncated: args.truncated,
        exitCode: args.exitCode,
        error: args.error,
        resultJson: JSON.stringify(args.result),
      });
      if (row) {
        await recordSandboxRunTelemetryRow(access, row);
      }
    });
  }
}

export function parseAllowedSandboxCommands(raw: string): Set<string> {
  let parsed: unknown = [];
  try {
    parsed = raw.trim().length > 0 ? JSON.parse(raw) : [];
  } catch {
    badRequest("invalid_sandbox_allowed_commands", "SANDBOX_ALLOWED_COMMANDS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    badRequest("invalid_sandbox_allowed_commands", "SANDBOX_ALLOWED_COMMANDS_JSON must be a JSON array");
  }
  const out = new Set<string>();
  for (const v of parsed) {
    if (typeof v !== "string") continue;
    const cmd = v.trim();
    if (!cmd) continue;
    out.add(cmd);
  }
  return out;
}
