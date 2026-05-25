import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryStore } from "./memory-store.js";
import type {
  SandboxBudgetUsage,
  SandboxRunFinalizeArgs,
  SandboxRunLogRow,
  SandboxRunTelemetryInsertArgs,
  SandboxStoreAccess,
} from "./sandbox-access.js";
import { createSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

type QueryResult<T = any> = {
  rows: T[];
  rowCount: number;
};

type SandboxSessionRecord = {
  id: string;
  tenant_id: string;
  scope: string;
  profile: string;
  metadata_json: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type SandboxRunRecord = {
  id: string;
  session_id: string;
  tenant_id: string;
  scope: string;
  project_id: string | null;
  planner_run_id: string | null;
  decision_id: string | null;
  action_kind: string;
  action_json: string;
  mode: string;
  status: string;
  timeout_ms: number;
  stdout_text: string;
  stderr_text: string;
  output_truncated: number;
  exit_code: number | null;
  error: string | null;
  cancel_requested: number;
  cancel_reason: string | null;
  metadata_json: string;
  result_json: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

type QueryClient = {
  sandboxStoreAccess: SandboxStoreAccess;
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function throwUnsupportedLiteHostSql(normalizedSql: string): never {
  const preview = normalizedSql.slice(0, 240);
  const err = new Error(`unsupported lite host store SQL: ${preview}`);
  (err as any).code = "lite_host_store_unsupported_sql";
  (err as any).details = { sql_preview: preview };
  throw err;
}

function sqliteChangeCount(result: unknown): number {
  const value = (result as any)?.changes;
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed stored JSON and fall back to empty object
  }
  return {};
}

function toRunPayloadRow(record: SandboxRunRecord) {
  return {
    id: record.id,
    session_id: record.session_id,
    tenant_id: record.tenant_id,
    scope: record.scope,
    project_id: record.project_id,
    planner_run_id: record.planner_run_id,
    decision_id: record.decision_id,
    action_kind: record.action_kind,
    action_json: parseJsonObject(record.action_json),
    mode: record.mode,
    status: record.status,
    timeout_ms: record.timeout_ms,
    stdout_text: record.stdout_text ?? "",
    stderr_text: record.stderr_text ?? "",
    output_truncated: record.output_truncated === 1,
    exit_code: record.exit_code,
    error: record.error,
    cancel_requested: record.cancel_requested === 1,
    cancel_reason: record.cancel_reason,
    metadata: parseJsonObject(record.metadata_json),
    result_json: parseJsonObject(record.result_json),
    started_at: record.started_at,
    finished_at: record.finished_at,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function toSessionRow(record: SandboxSessionRecord) {
  return {
    id: record.id,
    tenant_id: record.tenant_id,
    scope: record.scope,
    profile: record.profile,
    metadata: parseJsonObject(record.metadata_json),
    expires_at: record.expires_at,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function createQueryClient(db: SqliteDatabase): QueryClient {
  const insertSession = db.prepare(`
    INSERT INTO memory_sandbox_sessions (
      id, tenant_id, scope, profile, metadata_json, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getSession = db.prepare<SandboxSessionRecord>(`
    SELECT id, tenant_id, scope, profile, metadata_json, expires_at, created_at, updated_at
    FROM memory_sandbox_sessions
    WHERE id = ? AND tenant_id = ? AND scope = ?
    LIMIT 1
  `);

  const insertRunStmt = db.prepare(`
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
      stdout_text,
      stderr_text,
      output_truncated,
      exit_code,
      error,
      cancel_requested,
      cancel_reason,
      metadata_json,
      result_json,
      started_at,
      finished_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 0, NULL, NULL, 0, NULL, ?, '{}', NULL, NULL, ?, ?)
  `);
  const getRunByIdTenantScope = db.prepare<SandboxRunRecord>(`
    SELECT *
    FROM memory_sandbox_runs
    WHERE id = ? AND tenant_id = ? AND scope = ?
    LIMIT 1
  `);
  const getRunLogsStmt = db.prepare<Pick<SandboxRunRecord, "id" | "status" | "stdout_text" | "stderr_text" | "output_truncated">>(`
    SELECT id, status, stdout_text, stderr_text, output_truncated
    FROM memory_sandbox_runs
    WHERE id = ? AND tenant_id = ? AND scope = ?
    LIMIT 1
  `);
  const updateCancelRequested = db.prepare(`
    UPDATE memory_sandbox_runs
    SET cancel_requested = 1,
        cancel_reason = COALESCE(?, cancel_reason),
        updated_at = ?
    WHERE id = ? AND tenant_id = ? AND scope = ?
  `);
  const getRunStatusAndCancel = db.prepare<Pick<SandboxRunRecord, "id" | "status" | "cancel_requested" | "cancel_reason">>(`
    SELECT id, status, cancel_requested, cancel_reason
    FROM memory_sandbox_runs
    WHERE id = ? AND tenant_id = ? AND scope = ?
    LIMIT 1
  `);
  const cancelQueuedRunStmt = db.prepare(`
    UPDATE memory_sandbox_runs
    SET status = 'canceled',
        finished_at = ?,
        error = COALESCE(error, 'canceled_before_execution'),
        result_json = ?,
        updated_at = ?
    WHERE id = ? AND status = 'queued'
  `);
  const claimQueuedRunStmt = db.prepare(`
    UPDATE memory_sandbox_runs
    SET status = 'running',
        started_at = COALESCE(started_at, ?),
        updated_at = ?
    WHERE id = ? AND status = 'queued'
  `);
  const getRunningRunStmt = db.prepare<SandboxRunRecord>(`
    SELECT *
    FROM memory_sandbox_runs
    WHERE id = ? AND status = 'running'
    LIMIT 1
  `);
  const finalizeRunStmt = db.prepare(`
    UPDATE memory_sandbox_runs
    SET status = ?,
        stdout_text = ?,
        stderr_text = ?,
        output_truncated = ?,
        exit_code = ?,
        error = ?,
        result_json = ?,
        finished_at = ?,
        updated_at = ?
    WHERE id = ?
  `);
  const finalizeIfRunningStmt = db.prepare(`
    UPDATE memory_sandbox_runs
    SET status = ?,
        stdout_text = ?,
        stderr_text = ?,
        output_truncated = ?,
        exit_code = ?,
        error = ?,
        result_json = ?,
        finished_at = ?,
        updated_at = ?
    WHERE id = ? AND status = 'running'
  `);
  const touchRunningRunStmt = db.prepare(`
    UPDATE memory_sandbox_runs
    SET updated_at = ?
    WHERE id = ? AND status = 'running'
  `);
  const listStaleRunningRunsStmt = db.prepare<SandboxRunRecord>(`
    SELECT *
    FROM memory_sandbox_runs
    WHERE status = 'running' AND updated_at < ?
    ORDER BY updated_at ASC
    LIMIT ?
  `);
  const insertTelemetry = db.prepare(`
    INSERT INTO memory_sandbox_run_telemetry (
      id,
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
      error_code,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const readBudgetUsageStmt = db.prepare<{
    total_runs: number;
    timeout_runs: number | null;
    failed_runs: number | null;
  }>(`
    SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timeout_runs,
      SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed_runs
    FROM memory_sandbox_runs
    WHERE tenant_id = ?
      AND created_at >= ?
      AND (? IS NULL OR scope = ?)
      AND (? IS NULL OR project_id = ?)
  `);

  const finalizeSandboxRun = (args: SandboxRunFinalizeArgs, onlyIfRunning: boolean): SandboxRunRecord | undefined => {
    const finishedAt = nowIso();
    const update = onlyIfRunning ? finalizeIfRunningStmt : finalizeRunStmt;
    const result = update.run(
      args.status,
      args.stdoutText,
      args.stderrText,
      args.outputTruncated ? 1 : 0,
      args.exitCode,
      args.error,
      args.resultJson,
      finishedAt,
      finishedAt,
      args.id,
    );
    if (sqliteChangeCount(result) < 1) return undefined;
    return getRunById(db, args.id);
  };

  const insertSandboxTelemetry = (args: SandboxRunTelemetryInsertArgs): void => {
    insertTelemetry.run(
      args.runId,
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
      args.cancelRequested ? 1 : 0,
      args.outputTruncated ? 1 : 0,
      args.exitCode,
      args.errorCode,
      nowIso(),
    );
  };

  const readSandboxBudgetUsage = (args: {
    tenantId: string;
    windowHours: number;
    scopeFilter: string | null;
    projectFilter: string | null;
  }): SandboxBudgetUsage => {
    const cutoff = new Date(Date.now() - Math.max(1, Math.trunc(args.windowHours)) * 60 * 60 * 1000).toISOString();
    const row = readBudgetUsageStmt.get(
      args.tenantId,
      cutoff,
      args.scopeFilter,
      args.scopeFilter,
      args.projectFilter,
      args.projectFilter,
    );
    return {
      total_runs: Number(row?.total_runs ?? 0),
      timeout_runs: Number(row?.timeout_runs ?? 0),
      failed_runs: Number(row?.failed_runs ?? 0),
    };
  };

  const sandboxStoreAccess: SandboxStoreAccess = {
    async createSession(args) {
      const id = randomUUID();
      const createdAt = nowIso();
      insertSession.run(
        id,
        args.tenantId,
        args.scope,
        args.profile,
        args.metadataJson,
        args.expiresAt,
        createdAt,
        createdAt,
      );
      const session = getSession.get(id, args.tenantId, args.scope) as SandboxSessionRecord | undefined;
      if (!session) throw new Error(`lite sandbox session insert failed: ${id}`);
      return toSessionRow(session) as any;
    },

    async getSessionRef(args) {
      const session = getSession.get(args.id, args.tenantId, args.scope) as SandboxSessionRecord | undefined;
      return session ? { id: session.id, expires_at: session.expires_at } : null;
    },

    async insertRun(args) {
      const createdAt = nowIso();
      insertRunStmt.run(
        args.id,
        args.sessionId,
        args.tenantId,
        args.scope,
        args.projectId,
        args.plannerRunId,
        args.decisionId,
        "command",
        args.actionJson,
        args.mode,
        "queued",
        args.timeoutMs,
        args.metadataJson,
        createdAt,
        createdAt,
      );
      const run = getRunByIdTenantScope.get(args.id, args.tenantId, args.scope) as SandboxRunRecord | undefined;
      if (!run) throw new Error(`lite sandbox run insert failed: ${args.id}`);
      return toRunPayloadRow(run) as any;
    },

    async getRun(args) {
      const run = getRunByIdTenantScope.get(args.id, args.tenantId, args.scope) as SandboxRunRecord | undefined;
      return run ? (toRunPayloadRow(run) as any) : null;
    },

    async getRunLogs(args): Promise<SandboxRunLogRow | null> {
      const run = getRunLogsStmt.get(args.id, args.tenantId, args.scope) as
        | Pick<SandboxRunRecord, "id" | "status" | "stdout_text" | "stderr_text" | "output_truncated">
        | undefined;
      return run
        ? ({
            id: run.id,
            status: run.status,
            stdout_text: run.stdout_text ?? "",
            stderr_text: run.stderr_text ?? "",
            output_truncated: run.output_truncated === 1,
          } as SandboxRunLogRow)
        : null;
    },

    async requestCancel(args) {
      const updatedAt = nowIso();
      updateCancelRequested.run(args.reason, updatedAt, args.id, args.tenantId, args.scope);
      const run = getRunStatusAndCancel.get(args.id, args.tenantId, args.scope) as
        | Pick<SandboxRunRecord, "id" | "status" | "cancel_requested" | "cancel_reason">
        | undefined;
      return run
        ? ({
            id: run.id,
            status: run.status,
            cancel_requested: run.cancel_requested === 1,
            cancel_reason: run.cancel_reason,
          } as any)
        : null;
    },

    async cancelQueuedRun(args) {
      const finishedAt = nowIso();
      const existing = getRunningOrQueuedRunById(db, args.id);
      const nextResult = JSON.stringify({
        ...parseJsonObject(existing?.result_json),
        canceled: true,
      });
      const updateResult = cancelQueuedRunStmt.run(finishedAt, nextResult, finishedAt, args.id);
      if (sqliteChangeCount(updateResult) < 1) return null;
      const run = getRunById(db, args.id);
      return run ? (toRunPayloadRow(run) as any) : null;
    },

    async touchRunningRun(args) {
      touchRunningRunStmt.run(nowIso(), args.id);
    },

    async listStaleRunningRuns(args) {
      const cutoff = new Date(Date.now() - Math.max(1, Math.trunc(args.staleAfterSeconds)) * 1000).toISOString();
      const limit = Math.max(1, Math.trunc(args.limit));
      return listStaleRunningRunsStmt
        .all(cutoff, limit)
        .map((row) => toRunPayloadRow(row) as any);
    },

    async claimQueuedRun(args) {
      const startedAt = nowIso();
      const updateResult = claimQueuedRunStmt.run(startedAt, startedAt, args.id);
      if (sqliteChangeCount(updateResult) < 1) return null;
      const run = getRunningRunStmt.get(args.id) as SandboxRunRecord | undefined;
      return run ? (toRunPayloadRow(run) as any) : null;
    },

    async getRunningRun(args) {
      const run = getRunningRunStmt.get(args.id) as SandboxRunRecord | undefined;
      return run ? (toRunPayloadRow(run) as any) : null;
    },

    async finalizeRun(args) {
      const run = finalizeSandboxRun(args, false);
      return run ? (toRunPayloadRow(run) as any) : null;
    },

    async finalizeRunningRun(args) {
      const run = finalizeSandboxRun(args, true);
      return run ? (toRunPayloadRow(run) as any) : null;
    },

    async recordRunTelemetry(args) {
      insertSandboxTelemetry(args);
    },

    async readBudgetUsage(args) {
      return readSandboxBudgetUsage(args);
    },
  };

  return {
    sandboxStoreAccess,

    async query<T = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
      const normalized = normalizeSql(sql);
      throwUnsupportedLiteHostSql(normalized);
    },
  };
}

function getRunById(db: SqliteDatabase, runId: string): SandboxRunRecord | undefined {
  return db.prepare<SandboxRunRecord>(`
    SELECT *
    FROM memory_sandbox_runs
    WHERE id = ?
    LIMIT 1
  `).get(runId);
}

function getRunningOrQueuedRunById(db: SqliteDatabase, runId: string): SandboxRunRecord | undefined {
  return db.prepare<SandboxRunRecord>(`
    SELECT *
    FROM memory_sandbox_runs
    WHERE id = ? AND status IN ('queued', 'running')
    LIMIT 1
  `).get(runId);
}

function initialize(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sandbox_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      profile TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_sandbox_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_id TEXT,
      planner_run_id TEXT,
      decision_id TEXT,
      action_kind TEXT NOT NULL,
      action_json TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      stdout_text TEXT NOT NULL DEFAULT '',
      stderr_text TEXT NOT NULL DEFAULT '',
      output_truncated INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      error TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_sandbox_runs_tenant_scope
      ON memory_sandbox_runs (tenant_id, scope, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_sandbox_runs_status_updated
      ON memory_sandbox_runs (status, updated_at);

    CREATE TABLE IF NOT EXISTS memory_sandbox_run_telemetry (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      session_id TEXT,
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      mode TEXT,
      status TEXT NOT NULL,
      executor TEXT,
      timeout_ms INTEGER,
      queue_wait_ms INTEGER,
      runtime_ms INTEGER,
      total_latency_ms INTEGER,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      output_truncated INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      error_code TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const telemetryMigrations = [
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN session_id TEXT",
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN mode TEXT",
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN executor TEXT",
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN timeout_ms INTEGER",
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN queue_wait_ms INTEGER",
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN runtime_ms INTEGER",
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN total_latency_ms INTEGER",
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN output_truncated INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN exit_code INTEGER",
    "ALTER TABLE memory_sandbox_run_telemetry ADD COLUMN error_code TEXT",
  ];
  for (const sql of telemetryMigrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists in initialized databases.
    }
  }
}

export function createLiteHostStore(path: string): MemoryStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = createSqliteDatabase(path);
  initialize(db);
  const client = createQueryClient(db);
  let txDepth = 0;

  return {
    backend: "embedded",
    async withClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
      return fn(client);
    },
    async withTx<T>(fn: (client: any) => Promise<T>): Promise<T> {
      if (txDepth > 0) return fn(client);
      db.exec("BEGIN IMMEDIATE");
      txDepth += 1;
      try {
        const out = await fn(client);
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        txDepth -= 1;
      }
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}
