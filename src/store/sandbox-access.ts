import type { LiteRuntimeStore, LiteRuntimeStoreSession } from "./memory-store.js";
import {
  TERMINAL_SANDBOX_STATUSES,
  trimOrNull,
  type SandboxMode,
  type SandboxRunRow,
  type SandboxRunStatus,
  type SandboxSessionRow,
} from "../memory/sandbox-shared.js";

export type SandboxSessionInsertArgs = {
  tenantId: string;
  scope: string;
  profile: "default" | "restricted";
  metadataJson: string;
  expiresAt: string | null;
};

export type SandboxSessionRef = {
  id: string;
  expires_at: string | null;
};

export type SandboxRunInsertArgs = {
  id: string;
  sessionId: string;
  tenantId: string;
  scope: string;
  projectId: string | null;
  plannerRunId: string | null;
  decisionId: string | null;
  actionJson: string;
  mode: SandboxMode;
  timeoutMs: number;
  metadataJson: string;
};

export type SandboxRunLogRow = Pick<SandboxRunRow, "id" | "status" | "stdout_text" | "stderr_text" | "output_truncated">;

export type SandboxCancelStateRow = Pick<SandboxRunRow, "id" | "status" | "cancel_requested" | "cancel_reason">;

export type SandboxRunFinalizeArgs = {
  id: string;
  status: SandboxRunStatus;
  stdoutText: string;
  stderrText: string;
  outputTruncated: boolean;
  exitCode: number | null;
  error: string | null;
  resultJson: string;
};

export type SandboxRunTelemetryInsertArgs = {
  runId: string;
  sessionId: string;
  tenantId: string;
  scope: string;
  mode: SandboxMode;
  status: SandboxRunStatus;
  executor: string | null;
  timeoutMs: number;
  queueWaitMs: number;
  runtimeMs: number;
  totalLatencyMs: number;
  cancelRequested: boolean;
  outputTruncated: boolean;
  exitCode: number | null;
  errorCode: string | null;
};

export type SandboxBudgetUsageArgs = {
  tenantId: string;
  windowHours: number;
  scopeFilter: string | null;
  projectFilter: string | null;
};

export type SandboxBudgetUsage = {
  total_runs: number;
  timeout_runs: number;
  failed_runs: number;
};

export interface SandboxStoreAccess {
  createSession(args: SandboxSessionInsertArgs): Promise<SandboxSessionRow>;
  getSessionRef(args: { id: string; tenantId: string; scope: string }): Promise<SandboxSessionRef | null>;
  insertRun(args: SandboxRunInsertArgs): Promise<SandboxRunRow>;
  getRun(args: { id: string; tenantId: string; scope: string }): Promise<SandboxRunRow | null>;
  getRunLogs(args: { id: string; tenantId: string; scope: string }): Promise<SandboxRunLogRow | null>;
  requestCancel(args: { id: string; tenantId: string; scope: string; reason: string | null }): Promise<SandboxCancelStateRow | null>;
  cancelQueuedRun(args: { id: string; cause: "request" | "shutdown" }): Promise<SandboxRunRow | null>;
  touchRunningRun(args: { id: string }): Promise<void>;
  listStaleRunningRuns(args: { staleAfterSeconds: number; limit: number }): Promise<SandboxRunRow[]>;
  claimQueuedRun(args: { id: string }): Promise<SandboxRunRow | null>;
  getRunningRun(args: { id: string }): Promise<SandboxRunRow | null>;
  finalizeRun(args: SandboxRunFinalizeArgs): Promise<SandboxRunRow | null>;
  finalizeRunningRun(args: SandboxRunFinalizeArgs): Promise<SandboxRunRow | null>;
  recordRunTelemetry(args: SandboxRunTelemetryInsertArgs): Promise<void>;
  readBudgetUsage(args: SandboxBudgetUsageArgs): Promise<SandboxBudgetUsage>;
}

export type SandboxStoreAccessSession = {
  sandboxStoreAccess: SandboxStoreAccess;
};

export function hasSandboxStoreAccess(session: unknown): session is SandboxStoreAccessSession {
  return typeof (session as any)?.sandboxStoreAccess?.createSession === "function";
}

function sandboxStoreAccessForSession(session: LiteRuntimeStoreSession): SandboxStoreAccess {
  if (!hasSandboxStoreAccess(session)) {
    throw new Error("runtime store session does not expose sandbox store access");
  }
  return session.sandboxStoreAccess;
}

export type SandboxStore = {
  withTx<T>(fn: (access: SandboxStoreAccess) => Promise<T>): Promise<T>;
  withClient<T>(fn: (access: SandboxStoreAccess) => Promise<T>): Promise<T>;
};

export function createSandboxStore(store: LiteRuntimeStore): SandboxStore {
  return {
    withTx: async <T>(fn: (access: SandboxStoreAccess) => Promise<T>): Promise<T> =>
      store.withTx((session) => fn(sandboxStoreAccessForSession(session))),
    withClient: async <T>(fn: (access: SandboxStoreAccess) => Promise<T>): Promise<T> =>
      store.withClient((session) => fn(sandboxStoreAccessForSession(session))),
  };
}

function isoToMs(v: string | null): number | null {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function deltaMs(startMs: number | null, endMs: number | null): number {
  if (!Number.isFinite(startMs ?? NaN) || !Number.isFinite(endMs ?? NaN)) return 0;
  return Math.max(0, Number(endMs) - Number(startMs));
}

function normalizeTelemetryErrorCode(v: string | null): string | null {
  const raw = trimOrNull(v);
  if (!raw) return null;
  const compact = raw.toLowerCase().replace(/[^a-z0-9:_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!compact) return null;
  return compact.slice(0, 120);
}

function telemetryExecutor(row: SandboxRunRow): string | null {
  const value = row.result_json && typeof row.result_json === "object" ? (row.result_json as any).executor : null;
  const normalized = trimOrNull(typeof value === "string" ? value : null);
  return normalized ? normalized.slice(0, 32) : null;
}

export async function recordSandboxRunTelemetryRow(
  access: SandboxStoreAccess,
  row: SandboxRunRow,
): Promise<void> {
  if (!TERMINAL_SANDBOX_STATUSES.has(row.status)) return;
  const createdMs = isoToMs(row.created_at);
  const startedMs = isoToMs(row.started_at);
  const finishedMs = isoToMs(row.finished_at) ?? isoToMs(row.updated_at);

  await access.recordRunTelemetry({
    runId: row.id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    scope: row.scope,
    mode: row.mode,
    status: row.status,
    executor: telemetryExecutor(row),
    timeoutMs: row.timeout_ms,
    queueWaitMs: startedMs !== null ? deltaMs(createdMs, startedMs) : deltaMs(createdMs, finishedMs),
    runtimeMs: startedMs !== null ? deltaMs(startedMs, finishedMs) : 0,
    totalLatencyMs: deltaMs(createdMs, finishedMs),
    cancelRequested: row.cancel_requested,
    outputTruncated: row.output_truncated,
    exitCode: row.exit_code,
    errorCode: normalizeTelemetryErrorCode(row.error),
  });
}
