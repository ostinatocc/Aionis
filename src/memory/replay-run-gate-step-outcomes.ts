import type { PreconditionResult } from "./replay-execution-helpers.js";
import {
  buildReplayBlockedStepReport,
  buildReplayGuidedPartialStepReport,
} from "./replay-run-surfaces.js";

type ReplaySensitiveReview = {
  command: string;
  argv: string[];
  reason: string | null;
  risk_level: "low" | "medium" | "high";
  required_param: "params.allow_sensitive_exec=true";
} | null;

type ReplayRepairRecord = Record<string, unknown> | null;

export function buildReplayStrictGateStepArtifacts(input: {
  stepIndex: number | null;
  toolName: string | null;
  reason: string;
  preconditions?: PreconditionResult[];
  command?: string | null;
  allowedCommands?: string[];
  sensitiveReview?: ReplaySensitiveReview;
}): {
  report: Record<string, unknown>;
  writeOutputSignature: Record<string, unknown>;
} {
  return {
    report: buildReplayBlockedStepReport({
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      preconditions: input.preconditions,
      error: input.reason,
      command: input.command ?? undefined,
      allowedCommands: input.allowedCommands,
      sensitiveReview: input.sensitiveReview ?? undefined,
    }),
    writeOutputSignature: {
      reason: input.reason,
      ...(input.preconditions ? { preconditions: input.preconditions } : {}),
      ...(input.command != null ? { command: input.command } : {}),
      ...(input.allowedCommands ? { allowed_commands: input.allowedCommands } : {}),
      ...(input.sensitiveReview ? { sensitive_review: input.sensitiveReview } : {}),
    },
  };
}

export function buildReplayGuidedGateStepArtifacts(input: {
  stepIndex: number | null;
  toolName: string | null;
  readiness: "blocked" | "unknown";
  reason: string;
  repair: ReplayRepairRecord;
  preconditions?: PreconditionResult[];
  command?: string | null;
  argv?: string[];
  sensitiveReview?: ReplaySensitiveReview;
}): {
  report: Record<string, unknown>;
  writeOutputSignature: Record<string, unknown>;
} {
  return {
    report: buildReplayGuidedPartialStepReport({
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      readiness: input.readiness,
      preconditions: input.preconditions,
      command: input.command ?? undefined,
      argv: input.argv,
      sensitiveReview: input.sensitiveReview ?? undefined,
      repair: input.repair,
    }),
    writeOutputSignature: {
      reason: input.reason,
      ...(input.preconditions ? { preconditions: input.preconditions } : {}),
      ...(input.command != null ? { command: input.command } : {}),
      ...(input.sensitiveReview ? { sensitive_review: input.sensitiveReview } : {}),
      repair: input.repair,
    },
  };
}
