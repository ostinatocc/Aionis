import { detectSensitiveCommand, evaluatePrecondition, type PreconditionResult } from "./replay-execution-helpers.js";
import { isReplayCommandTool, parseStepArgv } from "./replay-guided-repair.js";
import { buildReplaySimulateStepReport } from "./replay-run-surfaces.js";

type ReplaySimulatePersistStep = (input: {
  stepIndex: number;
  toolName: string;
  toolInput: unknown;
  expectedOutputSignature: unknown;
  preconditions: unknown[];
  retryPolicy?: Record<string, unknown>;
  safetyLevel: "auto_ok" | "needs_confirm" | "manual_only";
  readiness: "ready" | "blocked" | "unknown";
  command: string | null;
  argv: string[];
  error?: "simulate_blocked" | "simulate_unknown";
}) => Promise<void>;

export async function simulateReplaySteps(input: {
  stepsRaw: unknown[];
  persistStep?: ReplaySimulatePersistStep | null;
}): Promise<{
  stepReports: Array<Record<string, unknown>>;
  readySteps: number;
  blockedSteps: number;
  unknownSteps: number;
}> {
  let readySteps = 0;
  let blockedSteps = 0;
  let unknownSteps = 0;
  const stepReports: Array<Record<string, unknown>> = [];

  for (const step of input.stepsRaw) {
    const stepObj = asObject(step) ?? {};
    const stepIndex = Number(stepObj.step_index ?? 0) || null;
    const toolName = toStringOrNull(stepObj.tool_name);
    const argv = isReplayCommandTool(toolName) ? parseStepArgv(stepObj, toolName) : [];
    const command = String(argv[0] ?? "").trim();
    const sensitive = command ? detectSensitiveCommand(command, argv) : { sensitive: false, reason: null, risk_level: "low" as const };
    const preconditions = Array.isArray(stepObj.preconditions) ? stepObj.preconditions : [];
    const checks: PreconditionResult[] = [];
    for (const cond of preconditions) {
      checks.push(await evaluatePrecondition(cond));
    }
    const failed = checks.filter((entry) => entry.state === "fail");
    const unknown = checks.filter((entry) => entry.state === "unknown");
    let readiness: "ready" | "blocked" | "unknown";
    if (failed.length > 0) {
      readiness = "blocked";
      blockedSteps += 1;
    } else if (unknown.length > 0) {
      readiness = "unknown";
      unknownSteps += 1;
    } else {
      readiness = "ready";
      readySteps += 1;
    }

    if (input.persistStep && stepIndex != null && toolName) {
      await input.persistStep({
        stepIndex,
        toolName,
        toolInput: stepObj.tool_input_template ?? stepObj.tool_input ?? {},
        expectedOutputSignature: stepObj.expected_output_signature ?? null,
        preconditions,
        retryPolicy: asObject(stepObj.retry_policy) ?? undefined,
        safetyLevel: (toStringOrNull(stepObj.safety_level) ?? "needs_confirm") as "auto_ok" | "needs_confirm" | "manual_only",
        readiness,
        command: command || null,
        argv,
        error:
          readiness === "blocked"
            ? "simulate_blocked"
            : readiness === "unknown"
              ? "simulate_unknown"
              : undefined,
      });
    }

    stepReports.push(
      buildReplaySimulateStepReport({
        stepIndex,
        toolName,
        safetyLevel: toStringOrNull(stepObj.safety_level) ?? "needs_confirm",
        readiness,
        command: command || null,
        argv,
        sensitiveReview: sensitive.sensitive
          ? {
              required_override: true,
              reason: sensitive.reason,
              risk_level: sensitive.risk_level,
              default_mode: "block",
            }
          : null,
        checks,
      }),
    );
  }

  return {
    stepReports,
    readySteps,
    blockedSteps,
    unknownSteps,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
