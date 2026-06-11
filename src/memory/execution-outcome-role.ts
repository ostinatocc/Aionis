export type ExecutionOutcomeRole = "passed_solution" | "failed_branch" | "blocked" | "unknown";

const EXECUTION_OUTCOME_ROLES = new Set<ExecutionOutcomeRole>([
  "passed_solution",
  "failed_branch",
  "blocked",
  "unknown",
]);

const PASSED_OUTCOME_TOKENS = new Set([
  "success",
  "succeeded",
  "successful",
  "passed",
  "pass",
  "accepted",
  "approved",
  "ok",
  "positive",
  "complete",
  "completed",
  "valid",
  "validated",
]);

const FAILED_OUTCOME_TOKENS = new Set([
  "failed",
  "failure",
  "fail",
  "rejected",
  "reject",
  "error",
  "errored",
  "negative",
  "invalid",
  "regression",
  "broken",
]);

const BLOCKED_OUTCOME_TOKENS = new Set([
  "blocked",
  "blocker",
  "timeout",
  "timed_out",
  "cancelled",
  "canceled",
  "aborted",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeOutcomeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function failureTextIsNegated(value: string): boolean {
  return /\b(?:not|no|never|without)\s+(?:a\s+)?(?:fail(?:ed|ure)?|error|regression|rejection)\b/i.test(value);
}

function outcomeRoleFromString(value: unknown): ExecutionOutcomeRole | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = normalizeOutcomeToken(trimmed);
  if (EXECUTION_OUTCOME_ROLES.has(normalized as ExecutionOutcomeRole)) return normalized as ExecutionOutcomeRole;
  if (PASSED_OUTCOME_TOKENS.has(normalized)) return "passed_solution";
  if (BLOCKED_OUTCOME_TOKENS.has(normalized)) return "blocked";
  if (FAILED_OUTCOME_TOKENS.has(normalized)) return failureTextIsNegated(trimmed) ? null : "failed_branch";
  return null;
}

export function normalizeExecutionOutcomeRoleFromValue(value: unknown): ExecutionOutcomeRole | null {
  const direct = outcomeRoleFromString(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  return outcomeRoleFromString(record.execution_outcome_role)
    ?? outcomeRoleFromString(record.outcome_role)
    ?? outcomeRoleFromString(record.status)
    ?? outcomeRoleFromString(record.result)
    ?? outcomeRoleFromString(record.verdict)
    ?? outcomeRoleFromString(record.outcome);
}

export function executionOutcomeRoleBlocksDirectUse(role: unknown): boolean {
  return role === "failed_branch" || role === "blocked";
}
