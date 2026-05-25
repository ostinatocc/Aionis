import { spawn } from "node:child_process";
import { z } from "zod";
import { ExecutionPacketV1Schema, type ExecutionPacketV1 } from "./types.js";

const StringList = z.array(z.string().trim().min(1).max(512)).max(64).default([]);
const OutputTailLimit = 4096;

export const RuntimeVerificationBoundarySchema = z.enum([
  "runtime_orchestrator",
  "external_verifier",
]);
export type RuntimeVerificationBoundary = z.infer<typeof RuntimeVerificationBoundarySchema>;

export const RuntimeVerificationRequestV1Schema = z.object({
  version: z.literal(1),
  verifier_id: z.string().trim().min(1).max(128),
  command: z.string().trim().min(1).max(4096),
  cwd: z.string().trim().min(1).nullable().default(null),
  timeout_ms: z.number().int().positive().max(300_000).default(30_000),
  fresh_shell: z.boolean().default(true),
  after_agent_exit: z.boolean().default(false),
  external_visibility_required: z.boolean().default(false),
  validation_boundary: RuntimeVerificationBoundarySchema.default("runtime_orchestrator"),
  evidence_refs: StringList,
}).strict();
export type RuntimeVerificationRequestV1 = z.infer<typeof RuntimeVerificationRequestV1Schema>;

export const RuntimeVerificationCommandResultV1Schema = z.object({
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  stdout_tail: z.string(),
  stderr_tail: z.string(),
  duration_ms: z.number().int().nonnegative(),
  success: z.boolean(),
}).strict();
export type RuntimeVerificationCommandResultV1 = z.infer<typeof RuntimeVerificationCommandResultV1Schema>;

export const RuntimeVerifierExecutionEvidenceV1Schema = z.object({
  schema_version: z.literal("execution_evidence_v1"),
  validation_passed: z.boolean().nullable(),
  after_exit_revalidated: z.boolean().nullable(),
  fresh_shell_probe_passed: z.boolean().nullable(),
  validation_boundary: z.enum(["runtime_orchestrator", "external_verifier"]),
  failure_reason: z.string().trim().min(1).max(256).nullable(),
  false_confidence_detected: z.boolean(),
  evidence_refs: StringList,
}).strict();
export type RuntimeVerifierExecutionEvidenceV1 = z.infer<typeof RuntimeVerifierExecutionEvidenceV1Schema>;

export const RuntimeVerificationResultV1Schema = z.object({
  result_version: z.literal("runtime_verification_result_v1"),
  request: RuntimeVerificationRequestV1Schema,
  command_result: RuntimeVerificationCommandResultV1Schema,
  execution_evidence_v1: RuntimeVerifierExecutionEvidenceV1Schema,
}).strict();
export type RuntimeVerificationResultV1 = z.infer<typeof RuntimeVerificationResultV1Schema>;

export const RuntimeVerificationModeSchema = z.enum(["off", "plan", "execute"]);
export type RuntimeVerificationMode = z.infer<typeof RuntimeVerificationModeSchema>;

export const RuntimeVerifierAgentLifecycleStateSchema = z.enum(["unknown", "agent_running", "agent_exited"]);
export type RuntimeVerifierAgentLifecycleState = z.infer<typeof RuntimeVerifierAgentLifecycleStateSchema>;

export const RuntimeVerificationControlV1Schema = z.object({
  version: z.literal(1).default(1),
  mode: RuntimeVerificationModeSchema.default("plan"),
  agent_lifecycle_state: RuntimeVerifierAgentLifecycleStateSchema.default("unknown"),
  include_pending_validations: z.boolean().default(true),
  validation_boundary: RuntimeVerificationBoundarySchema.default("runtime_orchestrator"),
  timeout_ms: z.number().int().positive().max(300_000).default(30_000),
  max_requests: z.number().int().positive().max(32).default(8),
  cwd: z.string().trim().min(1).nullable().default(null),
  agent_claimed_success: z.boolean().default(false),
}).strict();
export type RuntimeVerificationControlV1 = z.infer<typeof RuntimeVerificationControlV1Schema>;

const RuntimeVerificationExecutionStateSchema = z.enum([
  "off",
  "planned",
  "executed",
  "partially_executed",
  "blocked",
  "no_requests",
]);
export type RuntimeVerificationExecutionState = z.infer<typeof RuntimeVerificationExecutionStateSchema>;

export const RuntimeVerificationSummaryV1Schema = z.object({
  summary_version: z.literal("runtime_verification_summary_v1"),
  requires_after_agent_exit: z.boolean(),
  requires_fresh_shell: z.boolean(),
  external_visibility_required: z.boolean(),
  validation_passed: z.boolean().nullable(),
  after_exit_revalidated: z.boolean().nullable(),
  fresh_shell_probe_passed: z.boolean().nullable(),
  false_confidence_detected: z.boolean(),
  authoritative_evidence_ready: z.boolean(),
  reason_codes: z.array(z.string().min(1).max(128)).max(16),
}).strict();
export type RuntimeVerificationSummaryV1 = z.infer<typeof RuntimeVerificationSummaryV1Schema>;

export const RuntimeVerificationSurfaceV1Schema = z.object({
  surface_version: z.literal("runtime_verification_surface_v1"),
  requested_mode: RuntimeVerificationModeSchema,
  execution_state: RuntimeVerificationExecutionStateSchema,
  agent_lifecycle_state: RuntimeVerifierAgentLifecycleStateSchema,
  request_count: z.number().int().nonnegative(),
  executable_request_count: z.number().int().nonnegative(),
  blocked_request_count: z.number().int().nonnegative(),
  result_count: z.number().int().nonnegative(),
  requests: z.array(RuntimeVerificationRequestV1Schema).max(32),
  blocked_requests: z.array(z.object({
    verifier_id: z.string().min(1).max(128),
    command: z.string().min(1).max(4096),
    reason: z.string().min(1).max(128),
  }).strict()).max(32),
  results: z.array(RuntimeVerificationResultV1Schema).max(32),
  execution_evidence: z.array(RuntimeVerifierExecutionEvidenceV1Schema).max(32),
  evidence_for_trust_gate: RuntimeVerifierExecutionEvidenceV1Schema.nullable(),
  summary: RuntimeVerificationSummaryV1Schema,
}).strict();
export type RuntimeVerificationSurfaceV1 = z.infer<typeof RuntimeVerificationSurfaceV1Schema>;

function tail(value: string, limit = OutputTailLimit): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function uniqueStrings(values: string[], limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function verifierId(...parts: string[]): string {
  const normalized = parts
    .join(":")
    .replace(/[^a-zA-Z0-9:_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || "runtime_verifier").slice(0, 128);
}

function commandLooksExternal(command: string): boolean {
  return /\b(curl|wget|nc)\b|https?:\/\/|localhost|127\.0\.0\.1/i.test(command);
}

export function buildRuntimeVerificationRequestsFromPacketV1(
  input: ExecutionPacketV1 | z.input<typeof ExecutionPacketV1Schema>,
  options: {
    includePendingValidations?: boolean;
    validationBoundary?: RuntimeVerificationBoundary;
    timeoutMs?: number;
  } = {},
): RuntimeVerificationRequestV1[] {
  const packet = ExecutionPacketV1Schema.parse(input);
  const validationBoundary = options.validationBoundary ?? "runtime_orchestrator";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const out: RuntimeVerificationRequestV1[] = [];
  const seenCommands = new Set<string>();

  for (const [constraintIndex, constraint] of packet.service_lifecycle_constraints.entries()) {
    const commands = constraint.health_checks.length > 0 ? constraint.health_checks : [];
    for (const [commandIndex, command] of commands.entries()) {
      if (seenCommands.has(command)) continue;
      seenCommands.add(command);
      out.push(RuntimeVerificationRequestV1Schema.parse({
        version: 1,
        verifier_id: verifierId(packet.state_id, constraint.label, String(constraintIndex), String(commandIndex)),
        command,
        timeout_ms: timeoutMs,
        fresh_shell: constraint.revalidate_from_fresh_shell || constraint.must_survive_agent_exit,
        after_agent_exit: constraint.must_survive_agent_exit,
        external_visibility_required: Boolean(constraint.endpoint) || commandLooksExternal(command),
        validation_boundary: validationBoundary,
        evidence_refs: uniqueStrings([
          `execution_packet:${packet.state_id}`,
          `service_lifecycle:${constraint.label}`,
          constraint.endpoint ? `endpoint:${constraint.endpoint}` : "",
          ...packet.evidence_refs,
        ]),
      }));
    }
  }

  if (options.includePendingValidations !== false) {
    for (const [index, command] of packet.pending_validations.entries()) {
      if (seenCommands.has(command)) continue;
      seenCommands.add(command);
      out.push(RuntimeVerificationRequestV1Schema.parse({
        version: 1,
        verifier_id: verifierId(packet.state_id, "pending_validation", String(index)),
        command,
        timeout_ms: timeoutMs,
        fresh_shell: true,
        after_agent_exit: false,
        external_visibility_required: commandLooksExternal(command),
        validation_boundary: validationBoundary,
        evidence_refs: uniqueStrings([
          `execution_packet:${packet.state_id}`,
          `pending_validation:${index}`,
          ...packet.evidence_refs,
        ]),
      }));
    }
  }

  return out;
}

function failureReasonFor(result: RuntimeVerificationCommandResultV1): string | null {
  if (result.success) return null;
  if (result.timed_out) return "runtime_verifier_timeout";
  return `runtime_verifier_exit_code_${result.exit_code ?? "null"}`;
}

function firstFailedResult(results: RuntimeVerificationResultV1[]): RuntimeVerificationResultV1 | null {
  return results.find((result) => !result.command_result.success) ?? null;
}

function allRequestedResultsSatisfied(args: {
  requests: RuntimeVerificationRequestV1[];
  results: RuntimeVerificationResultV1[];
  predicate: (request: RuntimeVerificationRequestV1) => boolean;
}): boolean | null {
  const requested = args.requests.filter(args.predicate);
  if (requested.length === 0) return null;
  const resultByVerifierId = new Map(args.results.map((result) => [result.request.verifier_id, result]));
  let sawResult = false;
  for (const request of requested) {
    const result = resultByVerifierId.get(request.verifier_id);
    if (!result) return null;
    sawResult = true;
    if (!result.command_result.success) return false;
  }
  return sawResult ? true : null;
}

function aggregateValidationPassed(args: {
  requests: RuntimeVerificationRequestV1[];
  results: RuntimeVerificationResultV1[];
}): boolean | null {
  if (args.results.some((result) => !result.command_result.success)) return false;
  if (args.requests.length === 0) return null;
  if (args.results.length < args.requests.length) return null;
  return true;
}

export function buildRuntimeVerifierAggregateExecutionEvidenceV1(args: {
  requests: RuntimeVerificationRequestV1[] | Array<z.input<typeof RuntimeVerificationRequestV1Schema>>;
  results: RuntimeVerificationResultV1[] | Array<z.input<typeof RuntimeVerificationResultV1Schema>>;
  agentClaimedSuccess?: boolean;
  blockedReasons?: string[];
}): RuntimeVerifierExecutionEvidenceV1 | null {
  const requests = args.requests.map((request) => RuntimeVerificationRequestV1Schema.parse(request));
  const results = args.results.map((result) => RuntimeVerificationResultV1Schema.parse(result));
  if (requests.length === 0 && results.length === 0) return null;
  const failed = firstFailedResult(results);
  const validationPassed = aggregateValidationPassed({ requests, results });
  const afterExitRevalidated = allRequestedResultsSatisfied({
    requests,
    results,
    predicate: (request) => request.after_agent_exit,
  });
  const freshShellProbePassed = allRequestedResultsSatisfied({
    requests,
    results,
    predicate: (request) => request.fresh_shell,
  });
  const failureReason =
    failed?.execution_evidence_v1.failure_reason
    ?? args.blockedReasons?.find((reason) => reason.trim().length > 0)
    ?? null;
  const falseConfidenceDetected = args.agentClaimedSuccess === true && results.some((result) => !result.command_result.success);
  const validationBoundary = requests.some((request) => request.validation_boundary === "external_verifier")
    ? "external_verifier"
    : "runtime_orchestrator";
  return RuntimeVerifierExecutionEvidenceV1Schema.parse({
    schema_version: "execution_evidence_v1",
    validation_passed: validationPassed,
    after_exit_revalidated: afterExitRevalidated,
    fresh_shell_probe_passed: freshShellProbePassed,
    validation_boundary: validationBoundary,
    failure_reason: failureReason,
    false_confidence_detected: falseConfidenceDetected,
    evidence_refs: uniqueStrings([
      "runtime_verifier:aggregate",
      ...requests.map((request) => `runtime_verifier:${request.verifier_id}`),
      ...results.flatMap((result) => result.execution_evidence_v1.evidence_refs),
    ]),
  });
}

function buildRuntimeVerificationSummary(args: {
  control: RuntimeVerificationControlV1;
  requests: RuntimeVerificationRequestV1[];
  executableRequests: RuntimeVerificationRequestV1[];
  blockedRequests: Array<{ verifier_id: string; command: string; reason: string }>;
  results: RuntimeVerificationResultV1[];
  evidenceForTrustGate: RuntimeVerifierExecutionEvidenceV1 | null;
  executionBlockedReason?: string | null;
}): RuntimeVerificationSummaryV1 {
  const requiresAfterAgentExit = args.requests.some((request) => request.after_agent_exit);
  const requiresFreshShell = args.requests.some((request) => request.fresh_shell);
  const externalVisibilityRequired = args.requests.some((request) => request.external_visibility_required);
  const failed = args.results.some((result) => !result.command_result.success);
  const reasonCodes: string[] = [];
  if (args.control.mode === "off") reasonCodes.push("runtime_verification_off");
  if (args.requests.length === 0 && args.control.mode !== "off") reasonCodes.push("no_runtime_verification_requests");
  if (args.control.mode === "plan" && args.requests.length > 0) reasonCodes.push("planned_not_executed");
  if (args.executionBlockedReason) reasonCodes.push(args.executionBlockedReason);
  for (const blocked of args.blockedRequests) reasonCodes.push(blocked.reason);
  if (failed) reasonCodes.push("runtime_verifier_failed");
  if (args.evidenceForTrustGate?.false_confidence_detected) reasonCodes.push("false_confidence_detected");
  if (args.evidenceForTrustGate?.validation_passed === true) reasonCodes.push("validation_passed");
  if (args.evidenceForTrustGate?.after_exit_revalidated === true) reasonCodes.push("after_exit_revalidated");
  if (args.evidenceForTrustGate?.fresh_shell_probe_passed === true) reasonCodes.push("fresh_shell_probe_passed");
  const authoritativeEvidenceReady =
    args.evidenceForTrustGate?.validation_passed === true
    && (!requiresAfterAgentExit || args.evidenceForTrustGate.after_exit_revalidated === true)
    && (!requiresFreshShell || args.evidenceForTrustGate.fresh_shell_probe_passed === true)
    && !args.evidenceForTrustGate.false_confidence_detected
    && args.blockedRequests.length === 0;
  return RuntimeVerificationSummaryV1Schema.parse({
    summary_version: "runtime_verification_summary_v1",
    requires_after_agent_exit: requiresAfterAgentExit,
    requires_fresh_shell: requiresFreshShell,
    external_visibility_required: externalVisibilityRequired,
    validation_passed: args.evidenceForTrustGate?.validation_passed ?? null,
    after_exit_revalidated: args.evidenceForTrustGate?.after_exit_revalidated ?? null,
    fresh_shell_probe_passed: args.evidenceForTrustGate?.fresh_shell_probe_passed ?? null,
    false_confidence_detected: args.evidenceForTrustGate?.false_confidence_detected ?? false,
    authoritative_evidence_ready: authoritativeEvidenceReady,
    reason_codes: uniqueStrings(reasonCodes, 16),
  });
}

function splitExecutableRequests(args: {
  requests: RuntimeVerificationRequestV1[];
  control: RuntimeVerificationControlV1;
}): {
  executableRequests: RuntimeVerificationRequestV1[];
  blockedRequests: Array<{ verifier_id: string; command: string; reason: string }>;
} {
  const executableRequests: RuntimeVerificationRequestV1[] = [];
  const blockedRequests: Array<{ verifier_id: string; command: string; reason: string }> = [];
  for (const request of args.requests) {
    if (request.after_agent_exit && args.control.agent_lifecycle_state !== "agent_exited") {
      blockedRequests.push({
        verifier_id: request.verifier_id,
        command: request.command,
        reason: "agent_exit_not_confirmed",
      });
      continue;
    }
    executableRequests.push(request);
  }
  return { executableRequests, blockedRequests };
}

function buildSurface(args: {
  control: RuntimeVerificationControlV1;
  requests: RuntimeVerificationRequestV1[];
  executableRequests?: RuntimeVerificationRequestV1[];
  blockedRequests?: Array<{ verifier_id: string; command: string; reason: string }>;
  results?: RuntimeVerificationResultV1[];
  executionBlockedReason?: string | null;
}): RuntimeVerificationSurfaceV1 {
  const executableRequests = args.executableRequests ?? [];
  const blockedRequests = args.blockedRequests ?? [];
  const results = args.results ?? [];
  const executionEvidence = results.map((result) => result.execution_evidence_v1);
  const evidenceForTrustGate = results.length > 0
    ? buildRuntimeVerifierAggregateExecutionEvidenceV1({
        requests: args.requests,
        results,
        agentClaimedSuccess: args.control.agent_claimed_success,
        blockedReasons: blockedRequests.map((request) => request.reason),
      })
    : null;
  const executionState: RuntimeVerificationExecutionState =
    args.control.mode === "off"
      ? "off"
      : args.requests.length === 0
        ? "no_requests"
        : args.control.mode === "plan"
          ? "planned"
          : args.executionBlockedReason || (blockedRequests.length > 0 && executableRequests.length === 0)
            ? "blocked"
            : blockedRequests.length > 0 || results.length < args.requests.length
              ? "partially_executed"
              : "executed";
  return RuntimeVerificationSurfaceV1Schema.parse({
    surface_version: "runtime_verification_surface_v1",
    requested_mode: args.control.mode,
    execution_state: executionState,
    agent_lifecycle_state: args.control.agent_lifecycle_state,
    request_count: args.requests.length,
    executable_request_count: executableRequests.length,
    blocked_request_count: blockedRequests.length,
    result_count: results.length,
    requests: args.requests,
    blocked_requests: blockedRequests,
    results,
    execution_evidence: executionEvidence,
    evidence_for_trust_gate: evidenceForTrustGate,
    summary: buildRuntimeVerificationSummary({
      control: args.control,
      requests: args.requests,
      executableRequests,
      blockedRequests,
      results,
      evidenceForTrustGate,
      executionBlockedReason: args.executionBlockedReason,
    }),
  });
}

export function buildRuntimeVerificationSurfaceV1(
  input: ExecutionPacketV1 | z.input<typeof ExecutionPacketV1Schema> | null | undefined,
  controlInput: RuntimeVerificationControlV1 | z.input<typeof RuntimeVerificationControlV1Schema> = {},
): RuntimeVerificationSurfaceV1 {
  const control = RuntimeVerificationControlV1Schema.parse(controlInput);
  const requests = control.mode === "off" || !input
    ? []
    : buildRuntimeVerificationRequestsFromPacketV1(input, {
        includePendingValidations: control.include_pending_validations,
        validationBoundary: control.validation_boundary,
        timeoutMs: control.timeout_ms,
      })
        .slice(0, control.max_requests)
        .map((request) =>
          RuntimeVerificationRequestV1Schema.parse({
            ...request,
            cwd: control.cwd ?? request.cwd,
          })
        );
  const { executableRequests, blockedRequests } = splitExecutableRequests({ requests, control });
  return buildSurface({
    control,
    requests,
    executableRequests,
    blockedRequests,
    results: [],
  });
}

export function buildRuntimeVerifierExecutionEvidenceV1(args: {
  request: RuntimeVerificationRequestV1 | z.input<typeof RuntimeVerificationRequestV1Schema>;
  commandResult: RuntimeVerificationCommandResultV1 | z.input<typeof RuntimeVerificationCommandResultV1Schema>;
  agentClaimedSuccess?: boolean;
  failureReason?: string | null;
}): RuntimeVerifierExecutionEvidenceV1 {
  const request = RuntimeVerificationRequestV1Schema.parse(args.request);
  const commandResult = RuntimeVerificationCommandResultV1Schema.parse(args.commandResult);
  return RuntimeVerifierExecutionEvidenceV1Schema.parse({
    schema_version: "execution_evidence_v1",
    validation_passed: commandResult.success,
    after_exit_revalidated: request.after_agent_exit ? commandResult.success : null,
    fresh_shell_probe_passed: request.fresh_shell ? commandResult.success : null,
    validation_boundary: request.validation_boundary,
    failure_reason: args.failureReason ?? failureReasonFor(commandResult),
    false_confidence_detected: args.agentClaimedSuccess === true && !commandResult.success,
    evidence_refs: uniqueStrings([
      `runtime_verifier:${request.verifier_id}`,
      `runtime_verifier_command:${request.command}`,
      request.after_agent_exit ? "runtime_verifier:after_agent_exit" : "",
      request.fresh_shell ? "runtime_verifier:fresh_shell" : "",
      request.external_visibility_required ? "runtime_verifier:external_visibility" : "",
      ...request.evidence_refs,
    ]),
  });
}

export function buildRuntimeVerificationResultV1(args: {
  request: RuntimeVerificationRequestV1 | z.input<typeof RuntimeVerificationRequestV1Schema>;
  commandResult: RuntimeVerificationCommandResultV1 | z.input<typeof RuntimeVerificationCommandResultV1Schema>;
  agentClaimedSuccess?: boolean;
  failureReason?: string | null;
}): RuntimeVerificationResultV1 {
  const request = RuntimeVerificationRequestV1Schema.parse(args.request);
  const commandResult = RuntimeVerificationCommandResultV1Schema.parse(args.commandResult);
  return RuntimeVerificationResultV1Schema.parse({
    result_version: "runtime_verification_result_v1",
    request,
    command_result: commandResult,
    execution_evidence_v1: buildRuntimeVerifierExecutionEvidenceV1({
      request,
      commandResult,
      agentClaimedSuccess: args.agentClaimedSuccess,
      failureReason: args.failureReason,
    }),
  });
}

export async function runRuntimeVerifierCommandV1(
  input: RuntimeVerificationRequestV1 | z.input<typeof RuntimeVerificationRequestV1Schema>,
  options: {
    shellPath?: string;
    agentClaimedSuccess?: boolean;
  } = {},
): Promise<RuntimeVerificationResultV1> {
  const request = RuntimeVerificationRequestV1Schema.parse(input);
  const shellPath = options.shellPath ?? process.env.SHELL ?? "/bin/sh";
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const commandResult = await new Promise<RuntimeVerificationCommandResultV1>((resolve) => {
    const child = spawn(shellPath, ["-lc", request.command], {
      cwd: request.cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, request.timeout_ms);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = tail(stdout + chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = tail(stderr + chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const durationMs = Math.max(0, Date.now() - startedAt);
      resolve(RuntimeVerificationCommandResultV1Schema.parse({
        exit_code: timedOut ? null : code,
        timed_out: timedOut,
        stdout_tail: stdout,
        stderr_tail: stderr,
        duration_ms: durationMs,
        success: !timedOut && code === 0,
      }));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      const durationMs = Math.max(0, Date.now() - startedAt);
      resolve(RuntimeVerificationCommandResultV1Schema.parse({
        exit_code: null,
        timed_out: timedOut,
        stdout_tail: stdout,
        stderr_tail: tail(stderr + error.message),
        duration_ms: durationMs,
        success: false,
      }));
    });
  });

  return buildRuntimeVerificationResultV1({
    request,
    commandResult,
    agentClaimedSuccess: options.agentClaimedSuccess,
  });
}

export async function runRuntimeVerificationSurfaceV1(
  input: ExecutionPacketV1 | z.input<typeof ExecutionPacketV1Schema> | null | undefined,
  controlInput: RuntimeVerificationControlV1 | z.input<typeof RuntimeVerificationControlV1Schema> = {},
  options: {
    allowExecution?: boolean;
    executionBlockedReason?: string;
    shellPath?: string;
  } = {},
): Promise<RuntimeVerificationSurfaceV1> {
  const control = RuntimeVerificationControlV1Schema.parse(controlInput);
  const planned = buildRuntimeVerificationSurfaceV1(input, control);
  if (control.mode !== "execute" || planned.request_count === 0) return planned;
  if (options.allowExecution === false) {
    return buildSurface({
      control,
      requests: planned.requests,
      executableRequests: [],
      blockedRequests: planned.requests.map((request) => ({
        verifier_id: request.verifier_id,
        command: request.command,
        reason: options.executionBlockedReason ?? "runtime_verifier_execution_blocked",
      })),
      results: [],
      executionBlockedReason: options.executionBlockedReason ?? "runtime_verifier_execution_blocked",
    });
  }
  const { executableRequests, blockedRequests } = splitExecutableRequests({
    requests: planned.requests,
    control,
  });
  const results: RuntimeVerificationResultV1[] = [];
  for (const request of executableRequests) {
    results.push(await runRuntimeVerifierCommandV1(request, {
      shellPath: options.shellPath,
      agentClaimedSuccess: control.agent_claimed_success,
    }));
  }
  return buildSurface({
    control,
    requests: planned.requests,
    executableRequests,
    blockedRequests,
    results,
  });
}
