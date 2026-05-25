import type {
  LocalCommandOutcome,
  PreconditionResult,
  SignatureEvaluation,
} from "./replay-execution-helpers.js";

type ReplaySensitiveReviewInfo = {
  command: string;
  argv: string[];
  reason: string | null;
  risk_level: "low" | "medium" | "high";
  mode: "block" | "warn";
  override_used: boolean;
} | null;

type ReplayResultSummaryRecord = Record<string, unknown>;
type ReplayRepairRecord = Record<string, unknown> | null;

export function isReplayExecutionPassed(input: {
  execution: LocalCommandOutcome;
  signature: SignatureEvaluation;
  postconditions: PreconditionResult[];
}): boolean {
  const failedPost = input.postconditions.some((entry) => entry.state === "fail");
  const unknownPost = input.postconditions.some((entry) => entry.state === "unknown");
  return input.execution.ok && input.signature.ok && !failedPost && !unknownPost;
}

export function resolveReplayExecutionFailureReason(execution: LocalCommandOutcome): string {
  return execution.error ?? (execution.status === "timeout" ? "execution_timeout" : "execution_failed");
}

export function buildReplayPendingOutputSignature(input: {
  reason: "sandbox_async_execution_pending";
  executionBackend: "local_process" | "sandbox_sync" | "sandbox_async";
  sandboxRunId: string | null;
  sandboxStatus: string | null;
}): Record<string, unknown> {
  return {
    reason: input.reason,
    execution_backend: input.executionBackend,
    sandbox_run_id: input.sandboxRunId,
    sandbox_status: input.sandboxStatus,
  };
}

export function buildReplaySuccessOutputSignature(input: {
  command: string;
  argv: string[];
  executionBackend: "local_process" | "sandbox_sync" | "sandbox_async";
  sandboxRunId: string | null;
  sensitiveReview: ReplaySensitiveReviewInfo;
  execution: LocalCommandOutcome;
  resultSummary: ReplayResultSummaryRecord;
  signature: SignatureEvaluation;
}): Record<string, unknown> {
  return {
    command: input.command,
    argv: input.argv,
    execution_backend: input.executionBackend,
    sandbox_run_id: input.sandboxRunId,
    sensitive_review: input.sensitiveReview,
    exit_code: input.execution.exit_code,
    duration_ms: input.execution.duration_ms,
    result_summary: input.resultSummary,
    signature: input.signature,
  };
}

export function buildReplayFailureOutputSignature(input: {
  command: string;
  argv: string[];
  executionBackend: "local_process" | "sandbox_sync" | "sandbox_async";
  sandboxRunId: string | null;
  sensitiveReview: ReplaySensitiveReviewInfo;
  execution: LocalCommandOutcome;
  resultSummary: ReplayResultSummaryRecord;
  signature: SignatureEvaluation;
  preconditions: PreconditionResult[];
  postconditions: PreconditionResult[];
}): Record<string, unknown> {
  return {
    command: input.command,
    argv: input.argv,
    execution_backend: input.executionBackend,
    sandbox_run_id: input.sandboxRunId,
    sensitive_review: input.sensitiveReview,
    exit_code: input.execution.exit_code,
    duration_ms: input.execution.duration_ms,
    result_summary: input.resultSummary,
    signature: input.signature,
    preconditions: input.preconditions,
    postconditions: input.postconditions,
  };
}

export function buildReplayGuidedPartialOutputSignature(input: {
  command: string;
  argv: string[];
  executionBackend: "local_process" | "sandbox_sync" | "sandbox_async";
  sandboxRunId: string | null;
  sensitiveReview: ReplaySensitiveReviewInfo;
  execution: LocalCommandOutcome;
  resultSummary: ReplayResultSummaryRecord;
  signature: SignatureEvaluation;
  postconditions: PreconditionResult[];
  repair: ReplayRepairRecord;
}): Record<string, unknown> {
  return {
    command: input.command,
    argv: input.argv,
    execution_backend: input.executionBackend,
    sandbox_run_id: input.sandboxRunId,
    sensitive_review: input.sensitiveReview,
    exit_code: input.execution.exit_code,
    duration_ms: input.execution.duration_ms,
    result_summary: input.resultSummary,
    signature: input.signature,
    postconditions: input.postconditions,
    repair: input.repair,
  };
}
