import {
  isAllowedReplayCommand,
  isSafeCommandReference,
  type PreconditionResult,
  type ReplaySensitiveReviewMode,
} from "./replay-execution-helpers.js";
import { isReplayCommandTool } from "./replay-guided-repair.js";

export type ReplayRunGateDecision = {
  reason:
    | "preconditions_failed"
    | "preconditions_unknown"
    | "manual_only_step"
    | "confirmation_required"
    | "unsupported_tool_for_command_executor"
    | "command_not_allowed_or_missing"
    | "sensitive_command_requires_override";
  readiness: "blocked" | "unknown";
  detail: string | null;
  command: string | null;
  allowedCommands?: string[];
  sensitiveReview?: {
    command: string;
    argv: string[];
    reason: string | null;
    risk_level: "low" | "medium" | "high";
    required_param: "params.allow_sensitive_exec=true";
  } | null;
};

export function resolveReplayPreconditionGate(preChecks: PreconditionResult[]): ReplayRunGateDecision | null {
  const failed = preChecks.filter((entry) => entry.state === "fail");
  if (failed.length > 0) {
    return {
      reason: "preconditions_failed",
      readiness: "blocked",
      detail: "one or more replay preconditions failed",
      command: null,
    };
  }
  const unknown = preChecks.filter((entry) => entry.state === "unknown");
  if (unknown.length > 0) {
    return {
      reason: "preconditions_unknown",
      readiness: "unknown",
      detail: "one or more replay preconditions remained unknown",
      command: null,
    };
  }
  return null;
}

export function resolveReplayConfirmationGate(input: {
  safetyLevel: string;
  autoConfirm: boolean;
}): ReplayRunGateDecision | null {
  if (input.safetyLevel === "manual_only") {
    return {
      reason: "manual_only_step",
      readiness: "blocked",
      detail: "step requires manual execution and cannot be auto-replayed",
      command: null,
    };
  }
  if (input.safetyLevel === "needs_confirm" && !input.autoConfirm) {
    return {
      reason: "confirmation_required",
      readiness: "blocked",
      detail: "step requires explicit confirmation before replay execution",
      command: null,
    };
  }
  return null;
}

export function resolveReplayUnsupportedToolGate(toolName: string | null): ReplayRunGateDecision | null {
  if (isReplayCommandTool(toolName)) {
    return null;
  }
  return {
    reason: "unsupported_tool_for_command_executor",
    readiness: "unknown",
    detail: "tool is not mapped to the command-style replay executor",
    command: null,
  };
}

export function resolveReplayCommandAllowlistGate(input: {
  argv: string[];
  allowedCommands: Set<string>;
}): ReplayRunGateDecision | null {
  const command = String(input.argv[0] ?? "").trim();
  if (
    input.argv.length > 0
    && command
    && isSafeCommandReference(command)
    && isAllowedReplayCommand(command, input.allowedCommands)
  ) {
    return null;
  }
  return {
    reason: "command_not_allowed_or_missing",
    readiness: "blocked",
    detail: command ? `command '${command}' is not allowed` : "argv is missing",
    command: command || null,
    allowedCommands: [...input.allowedCommands.values()],
  };
}

export function resolveReplaySensitiveCommandGate(input: {
  command: string;
  argv: string[];
  sensitive: boolean;
  sensitiveReason: string | null;
  riskLevel: "low" | "medium" | "high";
  sensitiveReviewMode: ReplaySensitiveReviewMode;
  allowSensitiveExec: boolean;
}): ReplayRunGateDecision | null {
  if (!input.sensitive || input.sensitiveReviewMode !== "block" || input.allowSensitiveExec) {
    return null;
  }
  return {
    reason: "sensitive_command_requires_override",
    readiness: "blocked",
    detail: "sensitive replay command requires explicit override",
    command: input.command,
    sensitiveReview: {
      command: input.command,
      argv: input.argv,
      reason: input.sensitiveReason,
      risk_level: input.riskLevel,
      required_param: "params.allow_sensitive_exec=true",
    },
  };
}
