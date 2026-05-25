import type {
  LocalCommandOutcome,
  PreconditionResult,
  SignatureEvaluation,
} from "./replay-execution-helpers.js";
import {
  buildReplayExecutionFailureStepReport,
  buildReplayExecutionSuccessStepReport,
  buildReplayGuidedPartialStepReport,
  buildReplayPendingStepReport,
} from "./replay-run-surfaces.js";
import {
  buildReplayFailureOutputSignature,
  buildReplayGuidedPartialOutputSignature,
  buildReplayPendingOutputSignature,
  buildReplaySuccessOutputSignature,
} from "./replay-run-results.js";

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
type ReplayExecutionBackend = "local_process" | "sandbox_sync" | "sandbox_async";
type ReplayMode = "simulate" | "strict" | "guided";

export function buildReplayPendingStepArtifacts(input: {
  stepIndex: number | null;
  toolName: string | null;
  mode: ReplayMode;
  command: string;
  argv: string[];
  executionBackend: ReplayExecutionBackend;
  sandboxRunId: string | null;
  sandboxStatus: string | null;
  reason: "sandbox_async_execution_pending";
}): {
  report: Record<string, unknown>;
  writeStatus: "partial" | "failed";
  writeOutputSignature: Record<string, unknown>;
  repairApplied: boolean;
  repairNote: string | undefined;
  error: string | undefined;
} {
  const guided = input.mode === "guided";
  return {
    report: buildReplayPendingStepReport({
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      mode: input.mode,
      command: input.command,
      argv: input.argv,
      executionBackend: input.executionBackend,
      sandboxRunId: input.sandboxRunId,
      error: input.reason,
    }),
    writeStatus: guided ? "partial" : "failed",
    writeOutputSignature: buildReplayPendingOutputSignature({
      reason: input.reason,
      executionBackend: input.executionBackend,
      sandboxRunId: input.sandboxRunId,
      sandboxStatus: input.sandboxStatus,
    }),
    repairApplied: guided,
    repairNote: guided ? input.reason : undefined,
    error: guided ? undefined : input.reason,
  };
}

export function buildReplaySuccessStepArtifacts(input: {
  stepIndex: number | null;
  toolName: string | null;
  command: string;
  argv: string[];
  executionBackend: ReplayExecutionBackend;
  sandboxRunId: string | null;
  sensitiveReview: ReplaySensitiveReviewInfo;
  execution: LocalCommandOutcome;
  resultSummary: ReplayResultSummaryRecord;
  signature: SignatureEvaluation;
  postconditions: PreconditionResult[];
}): {
  report: Record<string, unknown>;
  writeOutputSignature: Record<string, unknown>;
} {
  return {
    report: buildReplayExecutionSuccessStepReport({
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      command: input.command,
      argv: input.argv,
      executionBackend: input.executionBackend,
      sandboxRunId: input.sandboxRunId,
      sensitiveReview: input.sensitiveReview,
      execution: input.execution as unknown as Record<string, unknown>,
      resultSummary: input.resultSummary,
      signature: input.signature as unknown as Record<string, unknown>,
      postconditions: input.postconditions,
    }),
    writeOutputSignature: buildReplaySuccessOutputSignature({
      command: input.command,
      argv: input.argv,
      executionBackend: input.executionBackend,
      sandboxRunId: input.sandboxRunId,
      sensitiveReview: input.sensitiveReview,
      execution: input.execution,
      resultSummary: input.resultSummary,
      signature: input.signature,
    }),
  };
}

export function buildReplayStrictFailureStepArtifacts(input: {
  stepIndex: number | null;
  toolName: string | null;
  command: string;
  argv: string[];
  executionBackend: ReplayExecutionBackend;
  sandboxRunId: string | null;
  sensitiveReview: ReplaySensitiveReviewInfo;
  execution: LocalCommandOutcome;
  resultSummary: ReplayResultSummaryRecord;
  signature: SignatureEvaluation;
  preconditions: PreconditionResult[];
  postconditions: PreconditionResult[];
  error: string;
}): {
  report: Record<string, unknown>;
  writeOutputSignature: Record<string, unknown>;
} {
  return {
    report: buildReplayExecutionFailureStepReport({
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      command: input.command,
      argv: input.argv,
      executionBackend: input.executionBackend,
      sandboxRunId: input.sandboxRunId,
      sensitiveReview: input.sensitiveReview,
      execution: input.execution as unknown as Record<string, unknown>,
      resultSummary: input.resultSummary,
      signature: input.signature as unknown as Record<string, unknown>,
      postconditions: input.postconditions,
      error: input.error,
    }),
    writeOutputSignature: buildReplayFailureOutputSignature({
      command: input.command,
      argv: input.argv,
      executionBackend: input.executionBackend,
      sandboxRunId: input.sandboxRunId,
      sensitiveReview: input.sensitiveReview,
      execution: input.execution,
      resultSummary: input.resultSummary,
      signature: input.signature,
      preconditions: input.preconditions,
      postconditions: input.postconditions,
    }),
  };
}

export function buildReplayGuidedPartialStepArtifacts(input: {
  stepIndex: number | null;
  toolName: string | null;
  command: string;
  argv: string[];
  executionBackend: ReplayExecutionBackend;
  sandboxRunId: string | null;
  sensitiveReview: ReplaySensitiveReviewInfo;
  execution: LocalCommandOutcome;
  resultSummary: ReplayResultSummaryRecord;
  signature: SignatureEvaluation;
  postconditions: PreconditionResult[];
  repair: ReplayRepairRecord;
}): {
  report: Record<string, unknown>;
  writeOutputSignature: Record<string, unknown>;
} {
  return {
    report: buildReplayGuidedPartialStepReport({
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      readiness: "partial",
      command: input.command,
      argv: input.argv,
      executionBackend: input.executionBackend,
      sandboxRunId: input.sandboxRunId,
      sensitiveReview: input.sensitiveReview,
      execution: input.execution as unknown as Record<string, unknown>,
      resultSummary: input.resultSummary,
      signature: input.signature as unknown as Record<string, unknown>,
      postconditions: input.postconditions,
      repair: input.repair,
    }),
    writeOutputSignature: buildReplayGuidedPartialOutputSignature({
      command: input.command,
      argv: input.argv,
      executionBackend: input.executionBackend,
      sandboxRunId: input.sandboxRunId,
      sensitiveReview: input.sensitiveReview,
      execution: input.execution,
      resultSummary: input.resultSummary,
      signature: input.signature,
      postconditions: input.postconditions,
      repair: input.repair,
    }),
  };
}
