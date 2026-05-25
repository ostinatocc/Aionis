import type {
  LocalCommandOutcome,
  PreconditionResult,
  SignatureEvaluation,
} from "./replay-execution-helpers.js";
import type { ReplayRunGateDecision } from "./replay-run-gates.js";
import {
  mergeReplayUsage,
  makeGuidedRepairPatch,
  type ReplayGuidedRepairStrategy,
} from "./replay-guided-repair.js";
import {
  buildReplayGuidedGateStepArtifacts,
  buildReplayStrictGateStepArtifacts,
} from "./replay-run-gate-step-outcomes.js";
import {
  buildReplayGuidedPartialStepArtifacts,
  buildReplayPendingStepArtifacts,
  buildReplayStrictFailureStepArtifacts,
  buildReplaySuccessStepArtifacts,
} from "./replay-run-step-outcomes.js";

type ReplayExecutionBackend = "local_process" | "sandbox_sync" | "sandbox_async";

type ReplaySensitiveReviewInfo = {
  command: string;
  argv: string[];
  reason: string | null;
  risk_level: "low" | "medium" | "high";
  mode: "block" | "warn";
  override_used: boolean;
} | null;

type ReplayResultSummaryRecord = Record<string, unknown>;

type ReplayGuidedRepairConfig = {
  strategy: ReplayGuidedRepairStrategy;
  allowedCommands: Set<string>;
  commandAliasMap: Record<string, string>;
  maxErrorChars: number;
  httpEndpoint?: string | null;
  httpTimeoutMs?: number;
  httpAuthToken?: string | null;
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;
  llmModel?: string | null;
  llmTimeoutMs?: number;
  llmMaxTokens?: number;
  llmTemperature?: number;
};

export type ReplayRunStepCounterDelta = {
  executedSteps?: number;
  succeededSteps?: number;
  failedSteps?: number;
  repairedSteps?: number;
  blockedSteps?: number;
  skippedSteps?: number;
  pendingSteps?: number;
};

export type ReplayRunCounters = {
  executedSteps: number;
  succeededSteps: number;
  failedSteps: number;
  repairedSteps: number;
  blockedSteps: number;
  skippedSteps: number;
  pendingSteps: number;
};

type ReplayStepAfterWriter = (input: {
  stepId: string | null;
  stepIndex: number | null;
  status: "success" | "partial" | "failed";
  outputSignature: Record<string, unknown>;
  postconditions: PreconditionResult[];
  artifactRefs: unknown[];
  repairApplied: boolean;
  repairNote?: string;
  error?: string;
}) => Promise<void>;

export type ReplayHandledStepResult = {
  report: Record<string, unknown>;
  delta: ReplayRunStepCounterDelta;
  stop: boolean;
  usage?: Record<string, unknown> | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function guidedRepairUsage(repair: unknown): Record<string, unknown> | null {
  return asObject(asObject(repair)?.usage);
}

async function writeReplayStepAfter(
  writer: ReplayStepAfterWriter | null | undefined,
  input: Parameters<ReplayStepAfterWriter>[0],
) {
  if (!writer) return;
  await writer(input);
}

export function applyReplayRunStepDelta(
  counters: ReplayRunCounters,
  delta: ReplayRunStepCounterDelta,
) {
  counters.executedSteps += delta.executedSteps ?? 0;
  counters.succeededSteps += delta.succeededSteps ?? 0;
  counters.failedSteps += delta.failedSteps ?? 0;
  counters.repairedSteps += delta.repairedSteps ?? 0;
  counters.blockedSteps += delta.blockedSteps ?? 0;
  counters.skippedSteps += delta.skippedSteps ?? 0;
  counters.pendingSteps += delta.pendingSteps ?? 0;
}

export async function handleReplayStrictGateStep(input: {
  gate: ReplayRunGateDecision;
  stepId: string | null;
  stepIndex: number | null;
  toolName: string | null;
  preconditions?: PreconditionResult[];
  writeStepAfter?: ReplayStepAfterWriter | null;
  stopOnFailure: boolean;
  countBlocked?: boolean;
}): Promise<ReplayHandledStepResult> {
  const artifacts = buildReplayStrictGateStepArtifacts({
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    reason: input.gate.reason,
    preconditions: input.preconditions,
    command: input.gate.command,
    allowedCommands: input.gate.allowedCommands,
    sensitiveReview: input.gate.sensitiveReview,
  });
  await writeReplayStepAfter(input.writeStepAfter, {
    stepId: input.stepId,
    stepIndex: input.stepIndex,
    status: "failed",
    outputSignature: artifacts.writeOutputSignature,
    postconditions: [],
    artifactRefs: [],
    repairApplied: false,
    error: input.gate.reason,
  });
  return {
    report: artifacts.report,
    delta: {
      failedSteps: 1,
      blockedSteps: input.countBlocked ? 1 : 0,
    },
    stop: input.stopOnFailure,
  };
}

export async function handleReplayGuidedGateStep(input: {
  gate: ReplayRunGateDecision;
  stepId: string | null;
  stepIndex: number | null;
  toolName: string | null;
  stepObj: Record<string, unknown>;
  preconditions?: PreconditionResult[];
  writeStepAfter?: ReplayStepAfterWriter | null;
  guidedRepair: ReplayGuidedRepairConfig;
  countBlocked?: boolean;
}): Promise<ReplayHandledStepResult> {
  const repair = await makeGuidedRepairPatch({
    strategy: input.guidedRepair.strategy,
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    reason: input.gate.reason,
    detail: input.gate.detail,
    stepObj: input.stepObj,
    command: input.gate.command ?? undefined,
    argv: input.gate.sensitiveReview?.argv,
    allowedCommands: input.guidedRepair.allowedCommands,
    commandAliasMap: input.guidedRepair.commandAliasMap,
    maxErrorChars: input.guidedRepair.maxErrorChars,
    httpEndpoint: input.guidedRepair.httpEndpoint,
    httpTimeoutMs: input.guidedRepair.httpTimeoutMs,
    httpAuthToken: input.guidedRepair.httpAuthToken,
    llmBaseUrl: input.guidedRepair.llmBaseUrl,
    llmApiKey: input.guidedRepair.llmApiKey,
    llmModel: input.guidedRepair.llmModel,
    llmTimeoutMs: input.guidedRepair.llmTimeoutMs,
    llmMaxTokens: input.guidedRepair.llmMaxTokens,
    llmTemperature: input.guidedRepair.llmTemperature,
    mode: "guided",
  });
  const repairRecord = asObject(repair);
  const artifacts = buildReplayGuidedGateStepArtifacts({
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    readiness: input.gate.readiness,
    reason: input.gate.reason,
    repair: repairRecord,
    preconditions: input.preconditions,
    command: input.gate.command,
    argv: input.gate.sensitiveReview?.argv,
    sensitiveReview: input.gate.sensitiveReview,
  });
  await writeReplayStepAfter(input.writeStepAfter, {
    stepId: input.stepId,
    stepIndex: input.stepIndex,
    status: "partial",
    outputSignature: artifacts.writeOutputSignature,
    postconditions: [],
    artifactRefs: [],
    repairApplied: true,
    repairNote: input.gate.reason,
  });
  return {
    report: artifacts.report,
    delta: {
      repairedSteps: 1,
      skippedSteps: 1,
      blockedSteps: input.countBlocked ? 1 : 0,
    },
    stop: false,
    usage: guidedRepairUsage(repair),
  };
}

export async function handleReplayPendingStep(input: {
  stepId: string | null;
  stepIndex: number | null;
  toolName: string | null;
  mode: "strict" | "guided";
  command: string;
  argv: string[];
  executionBackend: ReplayExecutionBackend;
  sandboxRunId: string | null;
  sandboxStatus: string | null;
  writeStepAfter?: ReplayStepAfterWriter | null;
  stopOnFailure: boolean;
}): Promise<ReplayHandledStepResult> {
  const artifacts = buildReplayPendingStepArtifacts({
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    mode: input.mode,
    command: input.command,
    argv: input.argv,
    executionBackend: input.executionBackend,
    sandboxRunId: input.sandboxRunId,
    sandboxStatus: input.sandboxStatus,
    reason: "sandbox_async_execution_pending",
  });
  await writeReplayStepAfter(input.writeStepAfter, {
    stepId: input.stepId,
    stepIndex: input.stepIndex,
    status: artifacts.writeStatus,
    outputSignature: artifacts.writeOutputSignature,
    postconditions: [],
    artifactRefs: [],
    repairApplied: artifacts.repairApplied,
    repairNote: artifacts.repairNote,
    error: artifacts.error,
  });
  return {
    report: artifacts.report,
    delta: {
      executedSteps: 1,
      pendingSteps: 1,
      repairedSteps: input.mode === "guided" ? 1 : 0,
      failedSteps: input.mode === "strict" ? 1 : 0,
    },
    stop: input.mode === "strict" && input.stopOnFailure,
  };
}

export async function handleReplaySuccessStep(input: {
  stepId: string | null;
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
  writeStepAfter?: ReplayStepAfterWriter | null;
}): Promise<ReplayHandledStepResult> {
  const artifacts = buildReplaySuccessStepArtifacts({
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    command: input.command,
    argv: input.argv,
    executionBackend: input.executionBackend,
    sandboxRunId: input.sandboxRunId,
    sensitiveReview: input.sensitiveReview,
    execution: input.execution,
    resultSummary: input.resultSummary,
    signature: input.signature,
    postconditions: input.postconditions,
  });
  await writeReplayStepAfter(input.writeStepAfter, {
    stepId: input.stepId,
    stepIndex: input.stepIndex,
    status: "success",
    outputSignature: artifacts.writeOutputSignature,
    postconditions: input.postconditions,
    artifactRefs: [],
    repairApplied: false,
  });
  return {
    report: artifacts.report,
    delta: {
      executedSteps: 1,
      succeededSteps: 1,
    },
    stop: false,
  };
}

export async function handleReplayStrictFailureStep(input: {
  stepId: string | null;
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
  writeStepAfter?: ReplayStepAfterWriter | null;
  stopOnFailure: boolean;
}): Promise<ReplayHandledStepResult> {
  const artifacts = buildReplayStrictFailureStepArtifacts({
    stepIndex: input.stepIndex,
    toolName: input.toolName,
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
    error: input.error,
  });
  await writeReplayStepAfter(input.writeStepAfter, {
    stepId: input.stepId,
    stepIndex: input.stepIndex,
    status: "failed",
    outputSignature: artifacts.writeOutputSignature,
    postconditions: input.postconditions,
    artifactRefs: [],
    repairApplied: false,
    error: input.error,
  });
  return {
    report: artifacts.report,
    delta: {
      executedSteps: 1,
      failedSteps: 1,
    },
    stop: input.stopOnFailure,
  };
}

export async function handleReplayGuidedFailureStep(input: {
  stepId: string | null;
  stepIndex: number | null;
  toolName: string | null;
  stepObj: Record<string, unknown>;
  command: string;
  argv: string[];
  executionBackend: ReplayExecutionBackend;
  sandboxRunId: string | null;
  sensitiveReview: ReplaySensitiveReviewInfo;
  execution: LocalCommandOutcome;
  resultSummary: ReplayResultSummaryRecord;
  signature: SignatureEvaluation;
  postconditions: PreconditionResult[];
  error: string;
  writeStepAfter?: ReplayStepAfterWriter | null;
  guidedRepair: ReplayGuidedRepairConfig;
}): Promise<ReplayHandledStepResult> {
  const repair = await makeGuidedRepairPatch({
    strategy: input.guidedRepair.strategy,
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    reason: "execution_failed_guided_skip",
    detail: input.error,
    stepObj: input.stepObj,
    command: input.command,
    argv: input.argv,
    allowedCommands: input.guidedRepair.allowedCommands,
    commandAliasMap: input.guidedRepair.commandAliasMap,
    maxErrorChars: input.guidedRepair.maxErrorChars,
    httpEndpoint: input.guidedRepair.httpEndpoint,
    httpTimeoutMs: input.guidedRepair.httpTimeoutMs,
    httpAuthToken: input.guidedRepair.httpAuthToken,
    llmBaseUrl: input.guidedRepair.llmBaseUrl,
    llmApiKey: input.guidedRepair.llmApiKey,
    llmModel: input.guidedRepair.llmModel,
    llmTimeoutMs: input.guidedRepair.llmTimeoutMs,
    llmMaxTokens: input.guidedRepair.llmMaxTokens,
    llmTemperature: input.guidedRepair.llmTemperature,
    mode: "guided",
  });
  const repairRecord = asObject(repair);
  const artifacts = buildReplayGuidedPartialStepArtifacts({
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    command: input.command,
    argv: input.argv,
    executionBackend: input.executionBackend,
    sandboxRunId: input.sandboxRunId,
    sensitiveReview: input.sensitiveReview,
    execution: input.execution,
    resultSummary: input.resultSummary,
    signature: input.signature,
    postconditions: input.postconditions,
    repair: repairRecord,
  });
  await writeReplayStepAfter(input.writeStepAfter, {
    stepId: input.stepId,
    stepIndex: input.stepIndex,
    status: "partial",
    outputSignature: artifacts.writeOutputSignature,
    postconditions: input.postconditions,
    artifactRefs: [],
    repairApplied: true,
    repairNote: input.error,
    error: input.error,
  });
  return {
    report: artifacts.report,
    delta: {
      executedSteps: 1,
      repairedSteps: 1,
    },
    stop: false,
    usage: guidedRepairUsage(repair),
  };
}
