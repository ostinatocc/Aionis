import type pg from "pg";
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
  cancelQueuedRun(args: { id: string }): Promise<SandboxRunRow | null>;
  touchRunningRun(args: { id: string }): Promise<void>;
  listStaleRunningRuns(args: { staleAfterSeconds: number; limit: number }): Promise<SandboxRunRow[]>;
  claimQueuedRun(args: { id: string }): Promise<SandboxRunRow | null>;
  getRunningRun(args: { id: string }): Promise<SandboxRunRow | null>;
  finalizeRun(args: SandboxRunFinalizeArgs): Promise<SandboxRunRow | null>;
  finalizeRunningRun(args: SandboxRunFinalizeArgs): Promise<SandboxRunRow | null>;
  recordRunTelemetry(args: SandboxRunTelemetryInsertArgs): Promise<void>;
  readBudgetUsage(args: SandboxBudgetUsageArgs): Promise<SandboxBudgetUsage>;
}

export type SandboxStoreAccessClient = {
  sandboxStoreAccess: SandboxStoreAccess;
};

export function hasSandboxStoreAccess(client: unknown): client is SandboxStoreAccessClient {
  return typeof (client as any)?.sandboxStoreAccess?.createSession === "function";
}

export function sandboxStoreAccessForClient(client: pg.PoolClient): SandboxStoreAccess {
  return hasSandboxStoreAccess(client) ? client.sandboxStoreAccess : createPostgresSandboxStoreAccess(client);
}

const runSelectColumns = `
  id::text,
  session_id::text,
  tenant_id,
  scope,
  project_id,
  planner_run_id,
  decision_id::text,
  action_kind::text AS action_kind,
  action_json,
  mode::text,
  status::text,
  timeout_ms,
  stdout_text,
  stderr_text,
  output_truncated,
  exit_code,
  error,
  cancel_requested,
  cancel_reason,
  metadata,
  result_json,
  started_at::text,
  finished_at::text,
  created_at::text,
  updated_at::text
`;

function normalizeRunRow(row: SandboxRunRow): SandboxRunRow {
  return {
    ...row,
    action_kind: "command",
    mode: row.mode === "sync" ? "sync" : "async",
    status: normalizeRunStatus(row.status),
    output_truncated: !!row.output_truncated,
    cancel_requested: !!row.cancel_requested,
  };
}

function normalizeRunStatus(status: unknown): SandboxRunStatus {
  if (
    status === "queued"
    || status === "running"
    || status === "succeeded"
    || status === "failed"
    || status === "canceled"
    || status === "timeout"
  ) {
    return status;
  }
  return "failed";
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
  client: pg.PoolClient,
  row: SandboxRunRow,
): Promise<void> {
  if (!TERMINAL_SANDBOX_STATUSES.has(row.status)) return;
  const createdMs = isoToMs(row.created_at);
  const startedMs = isoToMs(row.started_at);
  const finishedMs = isoToMs(row.finished_at) ?? isoToMs(row.updated_at);

  await sandboxStoreAccessForClient(client).recordRunTelemetry({
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

export function createPostgresSandboxStoreAccess(client: pg.PoolClient): SandboxStoreAccess {
  return {
    async createSession(args): Promise<SandboxSessionRow> {
      const row = await client.query<SandboxSessionRow>(
        `
        INSERT INTO memory_sandbox_sessions (
          tenant_id, scope, profile, metadata, expires_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5)
        RETURNING
          id::text,
          tenant_id,
          scope,
          profile::text AS profile,
          metadata,
          expires_at::text AS expires_at,
          created_at::text AS created_at,
          updated_at::text AS updated_at
        `,
        [args.tenantId, args.scope, args.profile, args.metadataJson, args.expiresAt],
      );
      return row.rows[0];
    },

    async getSessionRef(args): Promise<SandboxSessionRef | null> {
      const out = await client.query<SandboxSessionRef>(
        `
        SELECT id::text, expires_at::text AS expires_at
        FROM memory_sandbox_sessions
        WHERE id = $1
          AND tenant_id = $2
          AND scope = $3
        LIMIT 1
        `,
        [args.id, args.tenantId, args.scope],
      );
      return out.rows[0] ?? null;
    },

    async insertRun(args): Promise<SandboxRunRow> {
      const out = await client.query<SandboxRunRow>(
        `
        INSERT INTO memory_sandbox_runs (
          id,
          session_id,
          tenant_id,
          scope,
          project_id,
          planner_run_id,
          decision_id,
          action_kind,
          action_json,
          mode,
          status,
          timeout_ms,
          metadata
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, 'command', $8::jsonb, $9, 'queued', $10, $11::jsonb
        )
        RETURNING ${runSelectColumns}
        `,
        [
          args.id,
          args.sessionId,
          args.tenantId,
          args.scope,
          args.projectId,
          args.plannerRunId,
          args.decisionId,
          args.actionJson,
          args.mode,
          args.timeoutMs,
          args.metadataJson,
        ],
      );
      return normalizeRunRow(out.rows[0]);
    },

    async getRun(args): Promise<SandboxRunRow | null> {
      const out = await client.query<SandboxRunRow>(
        `
        SELECT ${runSelectColumns}
        FROM memory_sandbox_runs
        WHERE id = $1
          AND tenant_id = $2
          AND scope = $3
        LIMIT 1
        `,
        [args.id, args.tenantId, args.scope],
      );
      const row = out.rows[0] ?? null;
      return row ? normalizeRunRow(row) : null;
    },

    async getRunLogs(args): Promise<SandboxRunLogRow | null> {
      const out = await client.query<SandboxRunLogRow>(
        `
        SELECT
          id::text,
          status::text,
          stdout_text,
          stderr_text,
          output_truncated
        FROM memory_sandbox_runs
        WHERE id = $1
          AND tenant_id = $2
          AND scope = $3
        LIMIT 1
        `,
        [args.id, args.tenantId, args.scope],
      );
      const row = out.rows[0] ?? null;
      return row ? { ...row, status: normalizeRunStatus(row.status), output_truncated: !!row.output_truncated } : null;
    },

    async requestCancel(args): Promise<SandboxCancelStateRow | null> {
      const out = await client.query<SandboxCancelStateRow>(
        `
        UPDATE memory_sandbox_runs
        SET
          cancel_requested = true,
          cancel_reason = COALESCE($4, cancel_reason),
          updated_at = now()
        WHERE id = $1
          AND tenant_id = $2
          AND scope = $3
        RETURNING
          id::text,
          status::text,
          cancel_requested,
          cancel_reason
        `,
        [args.id, args.tenantId, args.scope, args.reason],
      );
      const row = out.rows[0] ?? null;
      return row ? { ...row, status: normalizeRunStatus(row.status), cancel_requested: !!row.cancel_requested } : null;
    },

    async cancelQueuedRun(args): Promise<SandboxRunRow | null> {
      const canceled = await client.query<SandboxRunRow>(
        `
        UPDATE memory_sandbox_runs
        SET
          status = 'canceled',
          finished_at = now(),
          error = COALESCE(error, 'canceled_before_execution'),
          result_json = COALESCE(result_json, '{}'::jsonb) || jsonb_build_object('canceled', true),
          updated_at = now()
        WHERE id = $1
          AND status = 'queued'
        RETURNING ${runSelectColumns}
        `,
        [args.id],
      );
      const row = canceled.rows[0] ?? null;
      return row ? normalizeRunRow(row) : null;
    },

    async touchRunningRun(args): Promise<void> {
      await client.query(
        `
        UPDATE memory_sandbox_runs
        SET updated_at = now()
        WHERE id = $1
          AND status = 'running'
        `,
        [args.id],
      );
    },

    async listStaleRunningRuns(args): Promise<SandboxRunRow[]> {
      const out = await client.query<SandboxRunRow>(
        `
        SELECT ${runSelectColumns}
        FROM memory_sandbox_runs
        WHERE status = 'running'
          AND updated_at < now() - make_interval(secs => $1::int)
        ORDER BY updated_at ASC
        LIMIT $2
        `,
        [Math.max(1, Math.trunc(args.staleAfterSeconds)), Math.max(1, Math.trunc(args.limit))],
      );
      return out.rows.map((row) => normalizeRunRow(row));
    },

    async claimQueuedRun(args): Promise<SandboxRunRow | null> {
      const out = await client.query<SandboxRunRow>(
        `
        UPDATE memory_sandbox_runs
        SET
          status = 'running',
          started_at = COALESCE(started_at, now()),
          updated_at = now()
        WHERE id = $1
          AND status = 'queued'
        RETURNING ${runSelectColumns}
        `,
        [args.id],
      );
      const row = out.rows[0] ?? null;
      return row ? normalizeRunRow(row) : null;
    },

    async getRunningRun(args): Promise<SandboxRunRow | null> {
      const out = await client.query<SandboxRunRow>(
        `
        SELECT ${runSelectColumns}
        FROM memory_sandbox_runs
        WHERE id = $1
          AND status = 'running'
        LIMIT 1
        `,
        [args.id],
      );
      const row = out.rows[0] ?? null;
      return row ? normalizeRunRow(row) : null;
    },

    async finalizeRun(args): Promise<SandboxRunRow | null> {
      const out = await client.query<SandboxRunRow>(
        `
        UPDATE memory_sandbox_runs
        SET
          status = $2,
          stdout_text = $3,
          stderr_text = $4,
          output_truncated = $5,
          exit_code = $6,
          error = $7,
          result_json = $8::jsonb,
          finished_at = now(),
          updated_at = now()
        WHERE id = $1
        RETURNING ${runSelectColumns}
        `,
        [
          args.id,
          args.status,
          args.stdoutText,
          args.stderrText,
          args.outputTruncated,
          args.exitCode,
          args.error,
          args.resultJson,
        ],
      );
      const row = out.rows[0] ?? null;
      return row ? normalizeRunRow(row) : null;
    },

    async finalizeRunningRun(args): Promise<SandboxRunRow | null> {
      const out = await client.query<SandboxRunRow>(
        `
        UPDATE memory_sandbox_runs
        SET
          status = $2,
          stdout_text = $3,
          stderr_text = $4,
          output_truncated = $5,
          exit_code = $6,
          error = $7,
          result_json = $8::jsonb,
          finished_at = now(),
          updated_at = now()
        WHERE id = $1
          AND status = 'running'
        RETURNING ${runSelectColumns}
        `,
        [
          args.id,
          args.status,
          args.stdoutText,
          args.stderrText,
          args.outputTruncated,
          args.exitCode,
          args.error,
          args.resultJson,
        ],
      );
      const row = out.rows[0] ?? null;
      return row ? normalizeRunRow(row) : null;
    },

    async recordRunTelemetry(args): Promise<void> {
      try {
        await client.query(
          `
          INSERT INTO memory_sandbox_run_telemetry (
            run_id,
            session_id,
            tenant_id,
            scope,
            mode,
            status,
            executor,
            timeout_ms,
            queue_wait_ms,
            runtime_ms,
            total_latency_ms,
            cancel_requested,
            output_truncated,
            exit_code,
            error_code
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15
          )
          ON CONFLICT (run_id) DO NOTHING
          `,
          [
            args.runId,
            args.sessionId,
            args.tenantId,
            args.scope,
            args.mode,
            args.status,
            args.executor,
            args.timeoutMs,
            args.queueWaitMs,
            args.runtimeMs,
            args.totalLatencyMs,
            args.cancelRequested,
            args.outputTruncated,
            args.exitCode,
            args.errorCode,
          ],
        );
      } catch (err: any) {
        if (String(err?.code ?? "") === "42P01") return;
        throw err;
      }
    },

    async readBudgetUsage(args): Promise<SandboxBudgetUsage> {
      const out = await client.query<{
        total_runs: string;
        timeout_runs: string;
        failed_runs: string;
      }>(
        `
        SELECT
          count(*)::text AS total_runs,
          count(*) FILTER (WHERE status = 'timeout')::text AS timeout_runs,
          count(*) FILTER (WHERE status IN ('failed', 'timeout'))::text AS failed_runs
        FROM memory_sandbox_runs
        WHERE tenant_id = $1
          AND created_at >= now() - make_interval(hours => $2::int)
          AND ($3::text IS NULL OR scope = $3)
          AND ($4::text IS NULL OR project_id = $4)
        `,
        [args.tenantId, args.windowHours, args.scopeFilter, args.projectFilter],
      );
      return {
        total_runs: Number(out.rows[0]?.total_runs ?? "0"),
        timeout_runs: Number(out.rows[0]?.timeout_runs ?? "0"),
        failed_runs: Number(out.rows[0]?.failed_runs ?? "0"),
      };
    },
  };
}
