import type { ReplayPlaybookRow } from "../store/replay-access.js";
import { buildAionisUri } from "./uri.js";

type ReplayRunSurfaceOut = Record<string, unknown> | null;

export function buildReplayRunPlaybookSurface(args: {
  tenantId: string;
  scope: string;
  playbookId: string;
  row: ReplayPlaybookRow;
}) {
  return {
    playbook_id: args.playbookId,
    version: args.row.version_num,
    status: args.row.playbook_status ?? "draft",
    name: args.row.title,
    uri: buildAionisUri({
      tenant_id: args.tenantId,
      scope: args.scope,
      type: args.row.type,
      id: args.row.id,
    }),
  };
}

export function buildReplayRunSurface(args: {
  runId: string;
  status: string;
  runStartOut: ReplayRunSurfaceOut;
  runEndOut: ReplayRunSurfaceOut;
}) {
  return {
    run_id: args.runId,
    status: args.status,
    run_uri: typeof args.runStartOut?.run_uri === "string" ? args.runStartOut.run_uri : null,
    run_end_uri: typeof args.runEndOut?.run_end_uri === "string" ? args.runEndOut.run_end_uri : null,
    commit_id_start: typeof args.runStartOut?.commit_id === "string" ? args.runStartOut.commit_id : null,
    commit_id_end: typeof args.runEndOut?.commit_id === "string" ? args.runEndOut.commit_id : null,
  };
}

export function buildReplaySimulateSummary(args: {
  totalSteps: number;
  readySteps: number;
  blockedSteps: number;
  unknownSteps: number;
}) {
  return {
    total_steps: args.totalSteps,
    ready_steps: args.readySteps,
    blocked_steps: args.blockedSteps,
    unknown_steps: args.unknownSteps,
    replay_readiness: args.blockedSteps > 0 ? "blocked" : args.unknownSteps > 0 ? "partial" : "ready",
    next_action:
      args.blockedSteps > 0
        ? "Fix blocked preconditions before strict replay or use guided repair."
        : args.unknownSteps > 0
          ? "Define unsupported precondition kinds or run guided mode with repair."
          : "Safe to run strict replay when execution backend policy is satisfied.",
  };
}

export function buildReplayExecutionSummary(args: {
  totalSteps: number;
  executedSteps: number;
  succeededSteps: number;
  failedSteps: number;
  repairedSteps: number;
  blockedSteps: number;
  skippedSteps: number;
  pendingSteps: number;
}) {
  return {
    total_steps: args.totalSteps,
    executed_steps: args.executedSteps,
    succeeded_steps: args.succeededSteps,
    failed_steps: args.failedSteps,
    repaired_steps: args.repairedSteps,
    blocked_steps: args.blockedSteps,
    skipped_steps: args.skippedSteps,
    pending_steps: args.pendingSteps,
    replay_readiness:
      args.failedSteps > 0
        ? "failed"
        : args.pendingSteps > 0 || args.repairedSteps > 0 || args.skippedSteps > 0
          ? "partial"
          : "success",
    next_action:
      args.failedSteps > 0
        ? "Inspect failed step outputs and fix playbook/tool constraints."
        : args.pendingSteps > 0
          ? "Wait for queued sandbox runs and then replay run_get for completion evidence."
          : args.repairedSteps > 0 || args.skippedSteps > 0
            ? "Review guided repair patches and promote a new playbook version if accepted."
            : "Replay run passed with no repair.",
  };
}

export function buildReplayExecutionSurface(args: {
  inferenceSkipped: boolean;
  deterministicGateMatched: boolean;
  executionBackend: string;
  localExecutorEnabled: boolean;
  sandboxExecutorAvailable: boolean;
  sandboxProjectId: string | null;
  workdir: string;
  timeoutMs: number;
  stdioMaxBytes: number;
  allowedCommands: string[];
  autoConfirm: boolean;
  stopOnFailure: boolean;
  recordRun: boolean;
  sensitiveReviewMode: string;
  allowSensitiveExec: boolean;
  guidedRepairStrategy: string;
  guidedRepairMaxErrorChars: number;
  guidedRepairHttpConfigured: boolean;
  guidedRepairBuiltinLlmConfigured: boolean;
}) {
  return {
    inference_skipped: args.inferenceSkipped,
    deterministic_gate_matched: args.deterministicGateMatched,
    execution_backend: args.executionBackend,
    local_executor_enabled: args.localExecutorEnabled,
    sandbox_executor_available: args.sandboxExecutorAvailable,
    sandbox_project_id: args.sandboxProjectId,
    workdir: args.workdir,
    timeout_ms: args.timeoutMs,
    stdio_max_bytes: args.stdioMaxBytes,
    allowed_commands: args.allowedCommands,
    auto_confirm: args.autoConfirm,
    stop_on_failure: args.stopOnFailure,
    record_run: args.recordRun,
    sensitive_review_mode: args.sensitiveReviewMode,
    allow_sensitive_exec: args.allowSensitiveExec,
    guided_repair_strategy: args.guidedRepairStrategy,
    guided_repair_max_error_chars: args.guidedRepairMaxErrorChars,
    guided_repair_http_configured: args.guidedRepairHttpConfigured,
    guided_repair_builtin_llm_configured: args.guidedRepairBuiltinLlmConfigured,
  };
}

export function buildReplaySimulateStepReport(args: {
  stepIndex: number | null;
  toolName: string | null;
  safetyLevel: string;
  readiness: "ready" | "blocked" | "unknown";
  command: string | null;
  argv: string[];
  sensitiveReview: Record<string, unknown> | null;
  checks: unknown[];
}) {
  return {
    step_index: args.stepIndex,
    tool_name: args.toolName,
    safety_level: args.safetyLevel,
    readiness: args.readiness,
    command: args.command,
    argv: args.argv,
    sensitive_review: args.sensitiveReview,
    precondition_total: args.checks.length,
    checks: args.checks,
    notes:
      args.readiness === "blocked"
        ? ["One or more preconditions failed; strict replay would stop here."]
        : args.readiness === "unknown"
          ? ["Some preconditions are unsupported/ambiguous; guided mode may need repair."]
          : ["Preconditions passed."],
  };
}

export function buildReplayBlockedStepReport(args: {
  stepIndex: number | null;
  toolName: string | null;
  error: string;
  readiness?: "blocked" | "unknown";
  preconditions?: unknown[];
  command?: string;
  allowedCommands?: string[];
  sensitiveReview?: Record<string, unknown> | null;
}) {
  return {
    step_index: args.stepIndex,
    tool_name: args.toolName,
    status: "failed",
    readiness: args.readiness ?? "blocked",
    ...(args.preconditions ? { preconditions: args.preconditions } : {}),
    ...(args.command !== undefined ? { command: args.command } : {}),
    ...(args.allowedCommands ? { allowed_commands: args.allowedCommands } : {}),
    ...(args.sensitiveReview ? { sensitive_review: args.sensitiveReview } : {}),
    error: args.error,
  };
}

export function buildReplayGuidedPartialStepReport(args: {
  stepIndex: number | null;
  toolName: string | null;
  readiness: "blocked" | "unknown" | "partial";
  repair: unknown;
  command?: string;
  argv?: string[];
  preconditions?: unknown[];
  executionBackend?: string;
  sandboxRunId?: string | null;
  sensitiveReview?: Record<string, unknown> | null;
  execution?: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
  signature?: Record<string, unknown>;
  postconditions?: unknown[];
}) {
  return {
    step_index: args.stepIndex,
    tool_name: args.toolName,
    status: "partial",
    readiness: args.readiness,
    ...(args.command !== undefined ? { command: args.command } : {}),
    ...(args.argv ? { argv: args.argv } : {}),
    ...(args.preconditions ? { preconditions: args.preconditions } : {}),
    ...(args.executionBackend ? { execution_backend: args.executionBackend } : {}),
    ...(args.sandboxRunId !== undefined ? { sandbox_run_id: args.sandboxRunId } : {}),
    ...(args.sensitiveReview ? { sensitive_review: args.sensitiveReview } : {}),
    ...(args.execution ? { execution: args.execution } : {}),
    ...(args.resultSummary ? { result_summary: args.resultSummary } : {}),
    ...(args.signature ? { signature: args.signature } : {}),
    ...(args.postconditions ? { postconditions: args.postconditions } : {}),
    repair_applied: true,
    repair: args.repair,
  };
}

export function buildReplayPendingStepReport(args: {
  stepIndex: number | null;
  toolName: string | null;
  mode: "simulate" | "strict" | "guided";
  command: string;
  argv: string[];
  executionBackend: string;
  sandboxRunId?: string | null;
  error: string;
}) {
  return {
    step_index: args.stepIndex,
    tool_name: args.toolName,
    status: args.mode === "guided" ? "partial" : "failed",
    readiness: "pending",
    command: args.command,
    argv: args.argv,
    execution_backend: args.executionBackend,
    sandbox_run_id: args.sandboxRunId ?? null,
    pending: true,
    error: args.error,
  };
}

export function buildReplayExecutionSuccessStepReport(args: {
  stepIndex: number | null;
  toolName: string | null;
  command: string;
  argv: string[];
  executionBackend: string;
  sandboxRunId?: string | null;
  sensitiveReview: Record<string, unknown> | null;
  execution: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
  signature: Record<string, unknown>;
  postconditions: unknown[];
}) {
  return {
    step_index: args.stepIndex,
    tool_name: args.toolName,
    status: "success",
    readiness: "ready",
    command: args.command,
    argv: args.argv,
    execution_backend: args.executionBackend,
    sandbox_run_id: args.sandboxRunId ?? null,
    sensitive_review: args.sensitiveReview,
    execution: args.execution,
    result_summary: args.resultSummary,
    signature: args.signature,
    postconditions: args.postconditions,
  };
}

export function buildReplayExecutionFailureStepReport(args: {
  stepIndex: number | null;
  toolName: string | null;
  command: string;
  argv: string[];
  executionBackend: string;
  sandboxRunId?: string | null;
  sensitiveReview: Record<string, unknown> | null;
  execution: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
  signature: Record<string, unknown>;
  postconditions: unknown[];
  error: string;
}) {
  return {
    step_index: args.stepIndex,
    tool_name: args.toolName,
    status: "failed",
    readiness: "blocked",
    command: args.command,
    argv: args.argv,
    execution_backend: args.executionBackend,
    sandbox_run_id: args.sandboxRunId ?? null,
    sensitive_review: args.sensitiveReview,
    execution: args.execution,
    result_summary: args.resultSummary,
    signature: args.signature,
    postconditions: args.postconditions,
    error: args.error,
  };
}
