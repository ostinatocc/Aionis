import { buildAionisUri } from "./uri.js";
import {
  evaluatePrecondition,
  isAllowedReplayCommand,
  isSafeCommandReference,
  type PreconditionResult,
} from "./replay-execution-helpers.js";
import { isReplayCommandTool, parseStepArgv } from "./replay-guided-repair.js";

export type ReplayShadowValidationLocalExecutorOptions = {
  enabled: boolean;
  mode: "disabled" | "local_process";
  allowedCommands: Set<string>;
};

export type ShadowValidationGateMetrics = {
  pass: boolean;
  total_steps: number;
  succeeded_steps: number;
  failed_steps: number;
  blocked_steps: number;
  unknown_steps: number;
  success_ratio: number;
};

function asObject(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function cloneJson<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

export function applyPlaybookRepairPatch(
  sourceSlots: Record<string, unknown>,
  patchObj: Record<string, unknown>,
): {
  nextSlots: Record<string, unknown>;
  summary: Record<string, unknown>;
} {
  const nextSlots = cloneJson(sourceSlots);
  const summary: Record<string, unknown> = {
    steps_override: false,
    step_patches_applied: 0,
    steps_removed: 0,
    top_level_updates: [] as string[],
  };

  const sourceStepsRaw = Array.isArray(nextSlots.steps_template) ? nextSlots.steps_template : [];
  let steps: Array<Record<string, unknown>> = sourceStepsRaw.map((s) => {
    const obj = asObject(s);
    return obj ? cloneJson(obj) : {};
  });

  const stepsOverride = Array.isArray(patchObj.steps_override) ? patchObj.steps_override : null;
  if (stepsOverride) {
    steps = stepsOverride.map((s) => {
      const obj = asObject(s);
      return obj ? cloneJson(obj) : {};
    });
    summary.steps_override = true;
  }

  const removeIndices = Array.isArray(patchObj.remove_step_indices)
    ? patchObj.remove_step_indices
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v))
        .map((v) => Math.trunc(v))
    : [];
  if (removeIndices.length > 0) {
    const before = steps.length;
    const deny = new Set(removeIndices);
    steps = steps.filter((step) => {
      const idx = Number(step.step_index ?? NaN);
      return !Number.isFinite(idx) || !deny.has(Math.trunc(idx));
    });
    summary.steps_removed = Math.max(0, before - steps.length);
  }

  const stepPatches = Array.isArray(patchObj.step_patches) ? patchObj.step_patches : [];
  for (const rawPatch of stepPatches) {
    const p = asObject(rawPatch);
    if (!p) continue;
    const stepIndex = Number(p.step_index ?? NaN);
    if (!Number.isFinite(stepIndex)) continue;
    const set = asObject(p.set);
    if (!set) continue;
    const idx = Math.trunc(stepIndex);
    const pos = steps.findIndex((s) => Number(s.step_index ?? NaN) === idx);
    if (pos < 0) continue;
    steps[pos] = {
      ...steps[pos],
      ...set,
    };
    summary.step_patches_applied = Number(summary.step_patches_applied ?? 0) + 1;
  }
  nextSlots.steps_template = steps;

  if (asObject(patchObj.matchers)) {
    nextSlots.matchers = cloneJson(asObject(patchObj.matchers));
    (summary.top_level_updates as string[]).push("matchers");
  }
  if (asObject(patchObj.success_criteria)) {
    nextSlots.success_criteria = cloneJson(asObject(patchObj.success_criteria));
    (summary.top_level_updates as string[]).push("success_criteria");
  }
  const riskProfile = toStringOrNull(patchObj.risk_profile);
  if (riskProfile === "low" || riskProfile === "medium" || riskProfile === "high") {
    nextSlots.risk_profile = riskProfile;
    (summary.top_level_updates as string[]).push("risk_profile");
  }
  const policyConstraints = asObject(patchObj.policy_constraints);
  if (policyConstraints) {
    nextSlots.policy_constraints = cloneJson(policyConstraints);
    (summary.top_level_updates as string[]).push("policy_constraints");
  }

  return { nextSlots, summary };
}

export async function validatePlaybookShadowReadiness(
  stepsRaw: unknown[],
  localExecutor: ReplayShadowValidationLocalExecutorOptions | undefined,
): Promise<{
  pass: boolean;
  total_steps: number;
  ready_steps: number;
  blocked_steps: number;
  unknown_steps: number;
  checks: Array<Record<string, unknown>>;
}> {
  const checks: Array<Record<string, unknown>> = [];
  let readySteps = 0;
  let blockedSteps = 0;
  let unknownSteps = 0;

  for (const step of stepsRaw) {
    const stepObj = asObject(step) ?? {};
    const stepIndex = Number(stepObj.step_index ?? 0) || null;
    const toolName = toStringOrNull(stepObj.tool_name);
    const preconditions = Array.isArray(stepObj.preconditions) ? stepObj.preconditions : [];
    const preChecks: PreconditionResult[] = [];
    for (const cond of preconditions) preChecks.push(await evaluatePrecondition(cond));
    const preFailed = preChecks.filter((c) => c.state === "fail");
    const preUnknown = preChecks.filter((c) => c.state === "unknown");

    let commandCheck: Record<string, unknown> | null = null;
    let commandState: "pass" | "fail" | "unknown" = "pass";
    if (isReplayCommandTool(toolName)) {
      const argv = parseStepArgv(stepObj, toolName);
      const command = String(argv[0] ?? "").trim();
      if (!command || argv.length === 0 || !isSafeCommandReference(command)) {
        commandState = "fail";
        commandCheck = {
          state: "fail",
          reason: "invalid_command_argv",
          command,
        };
      } else if (!localExecutor?.enabled || localExecutor.mode !== "local_process") {
        commandState = "unknown";
        commandCheck = {
          state: "unknown",
          reason: "local_executor_not_enabled",
          command,
        };
      } else if (!isAllowedReplayCommand(command, localExecutor.allowedCommands)) {
        commandState = "fail";
        commandCheck = {
          state: "fail",
          reason: "command_not_allowed",
          command,
        };
      } else {
        commandState = "pass";
        commandCheck = {
          state: "pass",
          reason: "allowed_command",
          command,
        };
      }
    }

    let readiness: "ready" | "blocked" | "unknown";
    if (preFailed.length > 0 || commandState === "fail") {
      readiness = "blocked";
      blockedSteps += 1;
    } else if (preUnknown.length > 0 || commandState === "unknown") {
      readiness = "unknown";
      unknownSteps += 1;
    } else {
      readiness = "ready";
      readySteps += 1;
    }

    checks.push({
      step_index: stepIndex,
      tool_name: toolName,
      readiness,
      preconditions: preChecks,
      command_check: commandCheck,
    });
  }

  return {
    pass: blockedSteps === 0,
    total_steps: stepsRaw.length,
    ready_steps: readySteps,
    blocked_steps: blockedSteps,
    unknown_steps: unknownSteps,
    checks,
  };
}

export function extractShadowValidationGateMetrics(
  validation: Record<string, unknown> | null,
): ShadowValidationGateMetrics | null {
  if (!validation) return null;
  const pass = Boolean(validation.pass === true);
  const summary = asObject(validation.summary);

  if (summary) {
    const total = Math.max(0, Math.trunc(Number(summary.total_steps ?? 0) || 0));
    const succeeded = Math.max(0, Math.trunc(Number(summary.succeeded_steps ?? 0) || 0));
    const failed = Math.max(0, Math.trunc(Number(summary.failed_steps ?? 0) || 0));
    const blocked = Math.max(0, Math.trunc(Number(summary.blocked_steps ?? 0) || 0));
    const unknown = Math.max(0, Math.trunc(Number(summary.unknown_steps ?? 0) || 0));
    const ratio = total > 0 ? succeeded / total : 0;
    return {
      pass,
      total_steps: total,
      succeeded_steps: succeeded,
      failed_steps: failed,
      blocked_steps: blocked,
      unknown_steps: unknown,
      success_ratio: ratio,
    };
  }

  const total = Math.max(0, Math.trunc(Number(validation.total_steps ?? 0) || 0));
  const ready = Math.max(0, Math.trunc(Number(validation.ready_steps ?? 0) || 0));
  const blocked = Math.max(0, Math.trunc(Number(validation.blocked_steps ?? 0) || 0));
  const unknown = Math.max(0, Math.trunc(Number(validation.unknown_steps ?? 0) || 0));
  const failed = blocked;
  const ratio = total > 0 ? ready / total : 0;
  return {
    pass,
    total_steps: total,
    succeeded_steps: ready,
    failed_steps: failed,
    blocked_steps: blocked,
    unknown_steps: unknown,
    success_ratio: ratio,
  };
}

export function evaluateAutoPromoteGate(
  metrics: ShadowValidationGateMetrics | null,
  gate: Record<string, unknown>,
): {
  pass: boolean;
  reasons: string[];
  gate_echo: Record<string, unknown>;
  metrics: ShadowValidationGateMetrics | null;
} {
  const requireShadowPass = gate.require_shadow_pass !== false;
  const minTotalSteps = Math.max(0, Math.trunc(Number(gate.min_total_steps ?? 0) || 0));
  const maxFailedSteps = Math.max(0, Math.trunc(Number(gate.max_failed_steps ?? 0) || 0));
  const maxBlockedSteps = Math.max(0, Math.trunc(Number(gate.max_blocked_steps ?? 0) || 0));
  const maxUnknownSteps = Math.max(0, Math.trunc(Number(gate.max_unknown_steps ?? 0) || 0));
  const minSuccessRatio = Math.max(0, Math.min(1, Number(gate.min_success_ratio ?? 1)));
  const reasons: string[] = [];

  if (!metrics) {
    reasons.push("missing_shadow_validation_metrics");
  } else {
    if (requireShadowPass && !metrics.pass) reasons.push("shadow_validation_not_pass");
    if (metrics.total_steps < minTotalSteps) reasons.push("total_steps_below_threshold");
    if (metrics.failed_steps > maxFailedSteps) reasons.push("failed_steps_above_threshold");
    if (metrics.blocked_steps > maxBlockedSteps) reasons.push("blocked_steps_above_threshold");
    if (metrics.unknown_steps > maxUnknownSteps) reasons.push("unknown_steps_above_threshold");
    if (metrics.success_ratio < minSuccessRatio) reasons.push("success_ratio_below_threshold");
  }

  return {
    pass: reasons.length === 0,
    reasons,
    gate_echo: {
      require_shadow_pass: requireShadowPass,
      min_total_steps: minTotalSteps,
      max_failed_steps: maxFailedSteps,
      max_blocked_steps: maxBlockedSteps,
      max_unknown_steps: maxUnknownSteps,
      min_success_ratio: minSuccessRatio,
    },
    metrics,
  };
}

export function buildCommitUri(tenantId: string, scope: string, commitId: string) {
  return buildAionisUri({
    tenant_id: tenantId,
    scope,
    type: "commit",
    id: commitId,
  });
}
