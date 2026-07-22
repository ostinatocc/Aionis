export const CONTINUATION_RUNTIME_V1_SHUTDOWN_SIGNALS = Object.freeze([
  "SIGINT",
  "SIGTERM",
] as const);

export const CONTINUATION_RUNTIME_V1_SHUTDOWN_PHASES = Object.freeze([
  "stop_new_work",
  "drain_in_flight",
  "close_database",
] as const);

export type ContinuationRuntimeV1ShutdownSignal =
  (typeof CONTINUATION_RUNTIME_V1_SHUTDOWN_SIGNALS)[number];

export type ContinuationRuntimeV1ShutdownPhase =
  (typeof CONTINUATION_RUNTIME_V1_SHUTDOWN_PHASES)[number];

export type ContinuationRuntimeV1ShutdownStatus =
  | "graceful"
  | "failed"
  | "timed_out";

export type ContinuationRuntimeV1ShutdownResult = Readonly<{
  schema_version: "continuation_runtime_shutdown_result_v1";
  status: ContinuationRuntimeV1ShutdownStatus;
  signal: ContinuationRuntimeV1ShutdownSignal;
  exit_code: 0 | 1;
  terminal_phase: ContinuationRuntimeV1ShutdownPhase | "complete";
  failure_code: "phase_failed" | "shutdown_timeout" | null;
  completed_phases: readonly ContinuationRuntimeV1ShutdownPhase[];
}>;

export type ContinuationRuntimeV1ProcessHost = Readonly<{
  addSignalListener(
    signal: ContinuationRuntimeV1ShutdownSignal,
    listener: () => void,
  ): void;
  removeSignalListener(
    signal: ContinuationRuntimeV1ShutdownSignal,
    listener: () => void,
  ): void;
  setExitCode(code: 0 | 1): void;
}>;

export type ContinuationRuntimeV1ProcessLifecycle = Readonly<{
  requestShutdown(
    signal: ContinuationRuntimeV1ShutdownSignal,
  ): Promise<ContinuationRuntimeV1ShutdownResult>;
  waitForShutdown(): Promise<ContinuationRuntimeV1ShutdownResult>;
  shutdownRequested(): boolean;
  currentPhase(): ContinuationRuntimeV1ShutdownPhase | null;
  result(): ContinuationRuntimeV1ShutdownResult | null;
  dispose(): void;
}>;

export type ContinuationRuntimeV1ProcessLifecycleHook =
  () => void | Promise<void>;

export type ContinuationRuntimeV1ProcessLifecycleInput = Readonly<{
  shutdownTimeoutMs: number;
  stopNewWork: ContinuationRuntimeV1ProcessLifecycleHook;
  drainInFlight: ContinuationRuntimeV1ProcessLifecycleHook;
  closeDatabase: ContinuationRuntimeV1ProcessLifecycleHook;
  host?: ContinuationRuntimeV1ProcessHost;
}>;

const INPUT_KEYS = Object.freeze([
  "closeDatabase",
  "drainInFlight",
  "host",
  "shutdownTimeoutMs",
  "stopNewWork",
] as const);

const HOST_KEYS = Object.freeze([
  "addSignalListener",
  "removeSignalListener",
  "setExitCode",
] as const);

function fail(reason: string): never {
  throw new Error(`continuation_runtime_v1_process_lifecycle_invalid:${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  reason: string,
): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) fail(reason);
  const keys = ownKeys as string[];
  if (keys.some((key) => !allowed.includes(key))
    || required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail(reason);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
      fail(reason);
    }
  }
}

function processHost(): ContinuationRuntimeV1ProcessHost {
  return Object.freeze({
    addSignalListener: (
      signal: ContinuationRuntimeV1ShutdownSignal,
      listener: () => void,
    ): void => {
      process.on(signal, listener);
    },
    removeSignalListener: (
      signal: ContinuationRuntimeV1ShutdownSignal,
      listener: () => void,
    ): void => {
      process.off(signal, listener);
    },
    setExitCode: (code: 0 | 1): void => {
      process.exitCode = code;
    },
  });
}

function validatedInput(
  value: unknown,
): Required<ContinuationRuntimeV1ProcessLifecycleInput> {
  if (!isRecord(value)) fail("input_must_be_plain_record");
  exactKeys(
    value,
    INPUT_KEYS,
    ["closeDatabase", "drainInFlight", "shutdownTimeoutMs", "stopNewWork"],
    "input_fields_invalid",
  );
  if (!Number.isSafeInteger(value.shutdownTimeoutMs)
    || (value.shutdownTimeoutMs as number) < 1
    || (value.shutdownTimeoutMs as number) > 300_000) {
    fail("shutdown_timeout_ms_invalid");
  }
  for (const name of ["stopNewWork", "drainInFlight", "closeDatabase"] as const) {
    if (typeof value[name] !== "function") fail(`${name}_must_be_function`);
  }
  const hostValue = value.host ?? processHost();
  if (!isRecord(hostValue)) fail("host_must_be_plain_record");
  exactKeys(hostValue, HOST_KEYS, HOST_KEYS, "host_fields_invalid");
  for (const name of HOST_KEYS) {
    if (typeof hostValue[name] !== "function") fail(`${name}_must_be_function`);
  }
  return {
    shutdownTimeoutMs: value.shutdownTimeoutMs as number,
    stopNewWork: value.stopNewWork as ContinuationRuntimeV1ProcessLifecycleHook,
    drainInFlight: value.drainInFlight as ContinuationRuntimeV1ProcessLifecycleHook,
    closeDatabase: value.closeDatabase as ContinuationRuntimeV1ProcessLifecycleHook,
    host: hostValue as ContinuationRuntimeV1ProcessHost,
  };
}

function frozenResult(input: {
  status: ContinuationRuntimeV1ShutdownStatus;
  signal: ContinuationRuntimeV1ShutdownSignal;
  terminalPhase: ContinuationRuntimeV1ShutdownPhase | "complete";
  completedPhases: readonly ContinuationRuntimeV1ShutdownPhase[];
}): ContinuationRuntimeV1ShutdownResult {
  const failed = input.status !== "graceful";
  return Object.freeze({
    schema_version: "continuation_runtime_shutdown_result_v1",
    status: input.status,
    signal: input.signal,
    exit_code: failed ? 1 : 0,
    terminal_phase: input.terminalPhase,
    failure_code: input.status === "failed"
      ? "phase_failed"
      : input.status === "timed_out"
        ? "shutdown_timeout"
        : null,
    completed_phases: Object.freeze([...input.completedPhases]),
  });
}

/**
 * Owns the complete daemon/worker process shutdown sequence.
 *
 * The three hooks are deliberately not a general resource stack. New work is
 * fenced first (HTTP admission for a daemon; polling and lease acquisition for
 * a worker), accepted work is then drained, and only then may SQLite close.
 * A deadline never skips ahead to database close because doing so could sever
 * an operation that was already accepted.
 */
export function createContinuationRuntimeV1ProcessLifecycle(
  value: ContinuationRuntimeV1ProcessLifecycleInput,
): ContinuationRuntimeV1ProcessLifecycle {
  const input = validatedInput(value);
  let disposed = false;
  let requested = false;
  let settledResult: ContinuationRuntimeV1ShutdownResult | null = null;
  let activePhase: ContinuationRuntimeV1ShutdownPhase | null = null;
  let timer: NodeJS.Timeout | null = null;
  const completedPhases: ContinuationRuntimeV1ShutdownPhase[] = [];

  let resolveCompletion!: (result: ContinuationRuntimeV1ShutdownResult) => void;
  const completion = new Promise<ContinuationRuntimeV1ShutdownResult>((resolve) => {
    resolveCompletion = resolve;
  });

  const onSigint = (): void => {
    void requestShutdown("SIGINT");
  };
  const onSigterm = (): void => {
    void requestShutdown("SIGTERM");
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    input.host.removeSignalListener("SIGINT", onSigint);
    input.host.removeSignalListener("SIGTERM", onSigterm);
  };

  const settle = (result: ContinuationRuntimeV1ShutdownResult): void => {
    if (settledResult) return;
    settledResult = result;
    if (timer) clearTimeout(timer);
    timer = null;
    dispose();
    input.host.setExitCode(result.exit_code);
    resolveCompletion(result);
  };

  const phaseHooks: ReadonlyArray<readonly [
    ContinuationRuntimeV1ShutdownPhase,
    ContinuationRuntimeV1ProcessLifecycleHook,
  ]> = [
    ["stop_new_work", input.stopNewWork],
    ["drain_in_flight", input.drainInFlight],
    ["close_database", input.closeDatabase],
  ];

  const run = async (signal: ContinuationRuntimeV1ShutdownSignal): Promise<void> => {
    for (const [phase, hook] of phaseHooks) {
      if (settledResult) return;
      activePhase = phase;
      try {
        await hook();
      } catch {
        activePhase = null;
        settle(frozenResult({
          status: "failed",
          signal,
          terminalPhase: phase,
          completedPhases,
        }));
        return;
      }
      if (settledResult) {
        activePhase = null;
        return;
      }
      completedPhases.push(phase);
    }
    activePhase = null;
    settle(frozenResult({
      status: "graceful",
      signal,
      terminalPhase: "complete",
      completedPhases,
    }));
  };

  const requestShutdown = (
    signal: ContinuationRuntimeV1ShutdownSignal,
  ): Promise<ContinuationRuntimeV1ShutdownResult> => {
    if (!CONTINUATION_RUNTIME_V1_SHUTDOWN_SIGNALS.includes(signal)) {
      fail("shutdown_signal_invalid");
    }
    if (requested) return completion;
    requested = true;
    timer = setTimeout(() => {
      settle(frozenResult({
        status: "timed_out",
        signal,
        terminalPhase: activePhase ?? "stop_new_work",
        completedPhases,
      }));
    }, input.shutdownTimeoutMs);
    void run(signal);
    return completion;
  };

  input.host.addSignalListener("SIGINT", onSigint);
  input.host.addSignalListener("SIGTERM", onSigterm);

  return Object.freeze({
    requestShutdown,
    waitForShutdown: () => completion,
    shutdownRequested: () => requested,
    currentPhase: () => activePhase,
    result: () => settledResult,
    dispose,
  });
}
