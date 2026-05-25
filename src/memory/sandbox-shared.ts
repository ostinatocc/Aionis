import type pg from "pg";
import { summarizeToolResult } from "./tool-result-summary.js";

export type SandboxDefaults = {
  defaultScope: string;
  defaultTenantId: string;
  defaultTimeoutMs: number;
};

export type SandboxRunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "timeout";
export type SandboxMode = "async" | "sync";

export type SandboxRunRow = {
  id: string;
  session_id: string;
  tenant_id: string;
  scope: string;
  project_id?: string | null;
  planner_run_id: string | null;
  decision_id: string | null;
  action_kind: "command";
  action_json: any;
  mode: SandboxMode;
  status: SandboxRunStatus;
  timeout_ms: number;
  stdout_text: string;
  stderr_text: string;
  output_truncated: boolean;
  exit_code: number | null;
  error: string | null;
  cancel_requested: boolean;
  cancel_reason: string | null;
  metadata: any;
  result_json: any;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SandboxSessionRow = {
  id: string;
  tenant_id: string;
  scope: string;
  profile: "default" | "restricted";
  metadata: any;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SandboxStore = {
  withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
};

export function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const out = v.trim();
  return out.length > 0 ? out : null;
}

export function jsonObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

export function normalizeTimeoutMs(input: number | undefined, defaultTimeoutMs: number): number {
  if (!Number.isFinite(input)) return defaultTimeoutMs;
  return Math.max(100, Math.min(600000, Math.trunc(input!)));
}

export function tailText(input: string, maxBytes: number): string {
  const text = String(input ?? "");
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  return buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
}

export function clampOutputAppend(
  current: string,
  chunk: Buffer,
  maxBytes: number,
): { next: string; truncated: boolean } {
  if (maxBytes <= 0) return { next: "", truncated: true };
  const cur = Buffer.from(current, "utf8");
  if (cur.length >= maxBytes) return { next: cur.toString("utf8"), truncated: true };
  const remaining = maxBytes - cur.length;
  const take = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  const merged = Buffer.concat([cur, take], Math.min(maxBytes, cur.length + take.length));
  return { next: merged.toString("utf8"), truncated: chunk.length > remaining };
}

export const TERMINAL_SANDBOX_STATUSES = new Set<SandboxRunStatus>([
  "succeeded",
  "failed",
  "canceled",
  "timeout",
]);

export function normalizeSandboxStatus(input: unknown): SandboxRunStatus | null {
  const raw = trimOrNull(input);
  if (!raw) return null;
  if (
    raw === "queued"
    || raw === "running"
    || raw === "succeeded"
    || raw === "failed"
    || raw === "canceled"
    || raw === "timeout"
  ) {
    return raw;
  }
  return null;
}

export function asFiniteIntOrNull(input: unknown): number | null {
  if (!Number.isFinite(Number(input))) return null;
  return Math.trunc(Number(input));
}

export function toRunPayload(row: SandboxRunRow) {
  const resultSummary = summarizeToolResult({
    stdout: row.stdout_text,
    stderr: row.stderr_text,
    result: row.result_json ?? {},
    exit_code: row.exit_code,
    error: row.error,
    truncated: row.output_truncated,
  });
  return {
    run_id: row.id,
    session_id: row.session_id,
    project_id: row.project_id ?? null,
    planner_run_id: row.planner_run_id,
    decision_id: row.decision_id,
    action: {
      kind: row.action_kind,
      ...(row.action_json ?? {}),
    },
    mode: row.mode,
    status: row.status,
    timeout_ms: row.timeout_ms,
    output: {
      stdout: row.stdout_text ?? "",
      stderr: row.stderr_text ?? "",
      truncated: !!row.output_truncated,
    },
    exit_code: row.exit_code,
    error: row.error,
    cancel_requested: row.cancel_requested,
    cancel_reason: row.cancel_reason,
    result: row.result_json ?? {},
    result_summary: resultSummary,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
