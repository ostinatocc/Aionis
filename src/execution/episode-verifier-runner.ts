import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";

import stableStringify from "fast-json-stable-stringify";

import { sha256Hex } from "../util/crypto.js";

const MAX_EXECUTABLE_BYTES = 4 * 1024;
const MAX_CWD_BYTES = 4 * 1024;
const MAX_ARG_COUNT = 256;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_ENTRY_COUNT = 256;
const MAX_ENVIRONMENT_KEY_BYTES = 4 * 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 256 * 1024;
const MAX_INFRASTRUCTURE_EXIT_CODE_COUNT = 255;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_TERMINATE_GRACE_MS = 60 * 1_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;
const DEFAULT_CAPTURE_BYTES = 1024 * 1024;
const MAX_SPAWN_ERROR_BYTES = 8 * 1024;

export type EpisodeVerifierRunnerStatus =
  | "passed"
  | "failed"
  | "infrastructure_error";

export type EpisodeVerifierRunnerConfig = {
  executable: string;
  argv: readonly string[];
  cwd: string;
  environment?: Readonly<Record<string, string>>;
  infrastructure_exit_codes?: readonly number[];
  timeout_ms: number;
  terminate_grace_ms?: number;
  max_stdout_bytes?: number;
  max_stderr_bytes?: number;
};

export type EpisodeVerifierSpawnObservation = Readonly<{
  process_id: number;
  started_at: string;
}>;

/**
 * Observes the operating-system process created for a verifier invocation.
 *
 * The callback runs only after ChildProcess emits its real `spawn` event.
 * runEpisodeVerifier does not settle until the callback settles, so callers
 * can durably bind the process identity before accepting its terminal result.
 */
export type EpisodeVerifierRunnerLifecycleObserver = Readonly<{
  on_spawn_observed(
    observation: EpisodeVerifierSpawnObservation,
  ): void | Promise<void>;
}>;

export type CanonicalEpisodeVerifierRunnerConfigV1 = {
  contract_version: "episode_verifier_runner_config_v1";
  executable: string;
  argv: string[];
  cwd: string;
  environment: Array<{
    key: string;
    value: string;
  }>;
  infrastructure_exit_codes: number[];
  timeout_ms: number;
  terminate_grace_ms: number;
  max_stdout_bytes: number;
  max_stderr_bytes: number;
};

export type EpisodeVerifierOutputCaptureV1 = {
  captured_base64: string;
  captured_byte_length: number;
  total_byte_length: number;
  truncated: boolean;
  sha256: string;
};

export type EpisodeVerifierSpawnErrorV1 = {
  code: string | null;
  message: string;
};

export type EpisodeVerifierRunnerResultV1 = {
  contract_version: "episode_verifier_runner_result_v1";
  config_sha256: string;
  status: EpisodeVerifierRunnerStatus;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  termination_requested: "none" | "sigterm" | "sigkill";
  spawn_error: EpisodeVerifierSpawnErrorV1 | null;
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
  stdout: EpisodeVerifierOutputCaptureV1;
  stderr: EpisodeVerifierOutputCaptureV1;
  result_sha256: string;
};

type EpisodeVerifierRunnerResultMaterialV1 =
  Omit<EpisodeVerifierRunnerResultV1, "result_sha256">;

type AuthenticEpisodeVerifierExecutionRecord = Readonly<{
  canonical_result_json: string;
  config: CanonicalEpisodeVerifierRunnerConfigV1;
  executable_sha256: string | null;
}>;

const AUTHENTIC_EPISODE_VERIFIER_EXECUTIONS = new WeakMap<
  EpisodeVerifierRunnerResultV1,
  AuthenticEpisodeVerifierExecutionRecord
>();

type OutputAccumulator = {
  push(chunk: Uint8Array | string): void;
  finish(): EpisodeVerifierOutputCaptureV1;
};

function assertBoundedExactString(
  value: unknown,
  label: string,
  maxUtf8Bytes: number,
  options: {
    allowEmpty?: boolean;
    disallowEquals?: boolean;
  } = {},
): asserts value is string {
  if (
    typeof value !== "string"
    || (!options.allowEmpty && value.length === 0)
    || value.includes("\u0000")
    || (options.disallowEquals && value.includes("="))
    || Buffer.byteLength(value, "utf8") > maxUtf8Bytes
  ) {
    throw new TypeError(
      `${label} must be ${options.allowEmpty ? "" : "non-empty, "}NUL-free, and at most ${maxUtf8Bytes} UTF-8 bytes`,
    );
  }
}

function assertBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
}

function canonicalUtf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
): CanonicalEpisodeVerifierRunnerConfigV1["environment"] {
  const entries = Object.entries(environment ?? {});
  if (entries.length > MAX_ENVIRONMENT_ENTRY_COUNT) {
    throw new TypeError(
      `Verifier environment cannot exceed ${MAX_ENVIRONMENT_ENTRY_COUNT} entries`,
    );
  }
  for (const [key, value] of entries) {
    assertBoundedExactString(
      key,
      "Verifier environment key",
      MAX_ENVIRONMENT_KEY_BYTES,
      { disallowEquals: true },
    );
    assertBoundedExactString(
      value,
      `Verifier environment value for ${key}`,
      MAX_ENVIRONMENT_VALUE_BYTES,
      { allowEmpty: true },
    );
  }
  return entries
    .sort(([left], [right]) => canonicalUtf8Compare(left, right))
    .map(([key, value]) => ({ key, value }));
}

function canonicalInfrastructureExitCodes(
  value: readonly number[] | undefined,
): number[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > MAX_INFRASTRUCTURE_EXIT_CODE_COUNT
  ) {
    throw new TypeError(
      `Verifier infrastructure_exit_codes must be an array of at most ${MAX_INFRASTRUCTURE_EXIT_CODE_COUNT} entries`,
    );
  }
  const codes = Array.from(value, (candidate, index) => {
    assertBoundedInteger(
      candidate,
      `Verifier infrastructure_exit_codes[${index}]`,
      1,
      255,
    );
    return candidate;
  }).sort((left, right) => left - right);
  if (new Set(codes).size !== codes.length) {
    throw new TypeError(
      "Verifier infrastructure_exit_codes must contain unique integers",
    );
  }
  return codes;
}

export function canonicalEpisodeVerifierRunnerConfig(
  input: EpisodeVerifierRunnerConfig,
): CanonicalEpisodeVerifierRunnerConfigV1 {
  assertBoundedExactString(
    input.executable,
    "Verifier executable",
    MAX_EXECUTABLE_BYTES,
  );
  if (!isAbsolute(input.executable)) {
    throw new TypeError("Verifier executable must be an absolute path");
  }
  assertBoundedExactString(input.cwd, "Verifier cwd", MAX_CWD_BYTES);
  if (!isAbsolute(input.cwd)) {
    throw new TypeError("Verifier cwd must be an absolute path");
  }
  if (!Array.isArray(input.argv) || input.argv.length > MAX_ARG_COUNT) {
    throw new TypeError(`Verifier argv cannot exceed ${MAX_ARG_COUNT} entries`);
  }
  const argv = input.argv.map((argument, index) => {
    assertBoundedExactString(
      argument,
      `Verifier argv[${index}]`,
      MAX_ARG_BYTES,
      { allowEmpty: true },
    );
    return argument;
  });

  assertBoundedInteger(input.timeout_ms, "Verifier timeout_ms", 1, MAX_TIMEOUT_MS);
  const terminateGraceMs =
    input.terminate_grace_ms ?? DEFAULT_TERMINATE_GRACE_MS;
  assertBoundedInteger(
    terminateGraceMs,
    "Verifier terminate_grace_ms",
    0,
    MAX_TERMINATE_GRACE_MS,
  );
  const maxStdoutBytes = input.max_stdout_bytes ?? DEFAULT_CAPTURE_BYTES;
  const maxStderrBytes = input.max_stderr_bytes ?? DEFAULT_CAPTURE_BYTES;
  assertBoundedInteger(
    maxStdoutBytes,
    "Verifier max_stdout_bytes",
    0,
    MAX_CAPTURE_BYTES,
  );
  assertBoundedInteger(
    maxStderrBytes,
    "Verifier max_stderr_bytes",
    0,
    MAX_CAPTURE_BYTES,
  );

  return {
    contract_version: "episode_verifier_runner_config_v1",
    executable: input.executable,
    argv,
    cwd: input.cwd,
    environment: canonicalEnvironment(input.environment),
    infrastructure_exit_codes: canonicalInfrastructureExitCodes(
      input.infrastructure_exit_codes,
    ),
    timeout_ms: input.timeout_ms,
    terminate_grace_ms: terminateGraceMs,
    max_stdout_bytes: maxStdoutBytes,
    max_stderr_bytes: maxStderrBytes,
  };
}

function isCanonicalEpisodeVerifierRunnerConfig(
  input: EpisodeVerifierRunnerConfig | CanonicalEpisodeVerifierRunnerConfigV1,
): input is CanonicalEpisodeVerifierRunnerConfigV1 {
  return "contract_version" in input
    && input.contract_version === "episode_verifier_runner_config_v1";
}

export function episodeVerifierRunnerConfigDigest(
  input: EpisodeVerifierRunnerConfig | CanonicalEpisodeVerifierRunnerConfigV1,
): string {
  const canonical = isCanonicalEpisodeVerifierRunnerConfig(input)
    ? input
    : canonicalEpisodeVerifierRunnerConfig(input);
  return sha256Hex(stableStringify({
    contract: "episode_verifier_runner_config_digest_v1",
    config: canonical,
  }));
}

function createOutputAccumulator(limit: number): OutputAccumulator {
  const hash: Hash = createHash("sha256");
  const parts: Buffer[] = [];
  let capturedByteLength = 0;
  let totalByteLength = 0;

  return {
    push(chunkInput): void {
      const chunk = typeof chunkInput === "string"
        ? Buffer.from(chunkInput, "utf8")
        : Buffer.from(chunkInput);
      hash.update(chunk);
      totalByteLength = Math.min(
        Number.MAX_SAFE_INTEGER,
        totalByteLength + chunk.byteLength,
      );
      const remaining = limit - capturedByteLength;
      if (remaining <= 0) return;
      const captured = chunk.subarray(0, remaining);
      parts.push(captured);
      capturedByteLength += captured.byteLength;
    },
    finish(): EpisodeVerifierOutputCaptureV1 {
      const captured = Buffer.concat(parts, capturedByteLength);
      return {
        captured_base64: captured.toString("base64"),
        captured_byte_length: capturedByteLength,
        total_byte_length: totalByteLength,
        truncated: totalByteLength > capturedByteLength,
        sha256: hash.digest("hex"),
      };
    },
  };
}

function environmentObject(
  entries: CanonicalEpisodeVerifierRunnerConfigV1["environment"],
): NodeJS.ProcessEnv {
  const environment = Object.create(null) as NodeJS.ProcessEnv;
  for (const entry of entries) environment[entry.key] = entry.value;
  return environment;
}

function boundedErrorText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_SPAWN_ERROR_BYTES) return text;
  return bytes.subarray(0, MAX_SPAWN_ERROR_BYTES).toString("utf8");
}

function spawnErrorRecord(error: unknown): EpisodeVerifierSpawnErrorV1 {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;
  return {
    code,
    message: boundedErrorText(error),
  };
}

function canonicalResultMaterial(
  value: EpisodeVerifierRunnerResultMaterialV1,
): EpisodeVerifierRunnerResultMaterialV1 {
  return {
    contract_version: "episode_verifier_runner_result_v1",
    config_sha256: value.config_sha256,
    status: value.status,
    exit_code: value.exit_code,
    signal: value.signal,
    timed_out: value.timed_out,
    termination_requested: value.termination_requested,
    spawn_error: value.spawn_error === null
      ? null
      : {
          code: value.spawn_error.code,
          message: value.spawn_error.message,
        },
    started_at: value.started_at,
    completed_at: value.completed_at,
    elapsed_ms: value.elapsed_ms,
    stdout: {
      captured_base64: value.stdout.captured_base64,
      captured_byte_length: value.stdout.captured_byte_length,
      total_byte_length: value.stdout.total_byte_length,
      truncated: value.stdout.truncated,
      sha256: value.stdout.sha256,
    },
    stderr: {
      captured_base64: value.stderr.captured_base64,
      captured_byte_length: value.stderr.captured_byte_length,
      total_byte_length: value.stderr.total_byte_length,
      truncated: value.stderr.truncated,
      sha256: value.stderr.sha256,
    },
  };
}

export function episodeVerifierRunnerResultDigest(
  value: EpisodeVerifierRunnerResultMaterialV1 | EpisodeVerifierRunnerResultV1,
): string {
  const {
    result_sha256: _resultSha256,
    ...material
  } = value as EpisodeVerifierRunnerResultV1;
  return sha256Hex(stableStringify({
    contract: "episode_verifier_runner_result_digest_v1",
    result: canonicalResultMaterial(material),
  }));
}

/**
 * Returns the exact launch configuration only for an untouched result object
 * minted by runEpisodeVerifier in this process. Deserialized or caller-built
 * lookalikes cannot acquire this capability.
 */
export type AuthenticEpisodeVerifierExecutionEvidence = Readonly<{
  config: CanonicalEpisodeVerifierRunnerConfigV1;
  executable_sha256: string | null;
}>;

export function assertAuthenticEpisodeVerifierExecution(
  value: EpisodeVerifierRunnerResultV1,
): AuthenticEpisodeVerifierExecutionEvidence {
  const record = AUTHENTIC_EPISODE_VERIFIER_EXECUTIONS.get(value);
  if (
    !record
    || stableStringify(value) !== record.canonical_result_json
    || value.result_sha256 !== episodeVerifierRunnerResultDigest(value)
    || value.config_sha256 !== episodeVerifierRunnerConfigDigest(record.config)
  ) {
    throw new Error("episode_verifier_execution_evidence_not_authentic");
  }
  return {
    config: record.config,
    executable_sha256: record.executable_sha256,
  };
}

async function sha256FileOrNull(path: string): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk: Buffer | string) => hash.update(chunk));
    input.once("error", () => resolve(null));
    input.once("end", () => resolve(hash.digest("hex")));
  });
}

function statusForCompletion(args: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: EpisodeVerifierSpawnErrorV1 | null;
  infrastructureExitCodes: readonly number[];
}): EpisodeVerifierRunnerStatus {
  if (
    args.timedOut
    || args.spawnError !== null
    || args.signal !== null
    || args.exitCode === null
  ) {
    return "infrastructure_error";
  }
  if (args.exitCode === 0) return "passed";
  return args.infrastructureExitCodes.includes(args.exitCode)
    ? "infrastructure_error"
    : "failed";
}

export async function runEpisodeVerifier(
  input: EpisodeVerifierRunnerConfig,
  lifecycleObserver?: EpisodeVerifierRunnerLifecycleObserver,
): Promise<EpisodeVerifierRunnerResultV1> {
  if (
    lifecycleObserver !== undefined
    && (
      lifecycleObserver === null
      || typeof lifecycleObserver !== "object"
      || typeof lifecycleObserver.on_spawn_observed !== "function"
    )
  ) {
    throw new TypeError(
      "Verifier lifecycle observer must provide on_spawn_observed",
    );
  }
  const config = canonicalEpisodeVerifierRunnerConfig(input);
  const configSha256 = episodeVerifierRunnerConfigDigest(config);
  const executableSha256 = await sha256FileOrNull(config.executable);
  const stdout = createOutputAccumulator(config.max_stdout_bytes);
  const stderr = createOutputAccumulator(config.max_stderr_bytes);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  return await new Promise<EpisodeVerifierRunnerResultV1>((resolve, reject) => {
    let timedOut = false;
    let terminationRequested: EpisodeVerifierRunnerResultV1["termination_requested"] = "none";
    let errorRecord: EpisodeVerifierSpawnErrorV1 | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let forceKillHandle: NodeJS.Timeout | null = null;
    let settled = false;
    let closeObserved = false;
    let observedExitCode: number | null = null;
    let observedSignal: NodeJS.Signals | null = null;
    let observerState:
      | "not_requested"
      | "awaiting_spawn"
      | "pending"
      | "fulfilled"
      | "rejected" = lifecycleObserver === undefined
        ? "not_requested"
        : "awaiting_spawn";
    let observerFailure: unknown;

    const child = spawn(config.executable, config.argv, {
      cwd: config.cwd,
      env: environmentObject(config.environment),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onStdoutData = (chunk: Buffer | string): void => stdout.push(chunk);
    const onStderrData = (chunk: Buffer | string): void => stderr.push(chunk);

    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);

    const clearTimers = (): void => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (forceKillHandle !== null) {
        clearTimeout(forceKillHandle);
        forceKillHandle = null;
      }
    };

    const detachChildListeners = (): void => {
      child.stdout.off("data", onStdoutData);
      child.stderr.off("data", onStderrData);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.off("close", onClose);
    };

    const finish = (
      exitCodeObserved: number | null,
      signalObserved: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      const completedAtMs = Date.now();
      const exitCode = errorRecord === null ? exitCodeObserved : null;
      const signal = errorRecord === null ? signalObserved : null;
      const material: EpisodeVerifierRunnerResultMaterialV1 = {
        contract_version: "episode_verifier_runner_result_v1",
        config_sha256: configSha256,
        status: statusForCompletion({
          exitCode,
          signal,
          timedOut,
          spawnError: errorRecord,
          infrastructureExitCodes: config.infrastructure_exit_codes,
        }),
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        termination_requested: terminationRequested,
        spawn_error: errorRecord,
        started_at: startedAt,
        completed_at: new Date(completedAtMs).toISOString(),
        elapsed_ms: Math.max(0, completedAtMs - startedAtMs),
        stdout: stdout.finish(),
        stderr: stderr.finish(),
      };
      const result: EpisodeVerifierRunnerResultV1 = {
        ...material,
        result_sha256: episodeVerifierRunnerResultDigest(material),
      };
      AUTHENTIC_EPISODE_VERIFIER_EXECUTIONS.set(result, {
        canonical_result_json: stableStringify(result),
        config,
        executable_sha256: executableSha256,
      });
      resolve(result);
    };

    const settleAfterCloseAndObservation = (): void => {
      if (!closeObserved || settled || observerState === "pending") return;
      if (observerState === "rejected") {
        settled = true;
        clearTimers();
        reject(observerFailure);
        return;
      }
      finish(observedExitCode, observedSignal);
    };

    const abortChildAfterObserverFailure = (): void => {
      clearTimers();
      if (closeObserved) return;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      forceKillHandle = setTimeout(() => {
        if (closeObserved || settled) return;
        child.kill("SIGKILL");
      }, config.terminate_grace_ms);
    };

    const rejectForObserverFailure = (error: unknown): void => {
      if (observerState !== "pending" || settled) return;
      observerState = "rejected";
      observerFailure = error;
      abortChildAfterObserverFailure();
      settleAfterCloseAndObservation();
    };

    function onSpawn(): void {
      if (lifecycleObserver === undefined || settled) return;
      observerState = "pending";
      const processId = child.pid;
      if (
        processId === undefined
        || !Number.isSafeInteger(processId)
        || processId <= 0
      ) {
        rejectForObserverFailure(
          new Error("Spawned verifier process did not expose a valid process id"),
        );
        return;
      }
      let observationResult: void | Promise<void>;
      try {
        observationResult = lifecycleObserver.on_spawn_observed({
          process_id: processId,
          started_at: startedAt,
        });
      } catch (error) {
        rejectForObserverFailure(error);
        return;
      }
      Promise.resolve(observationResult).then(
        () => {
          if (observerState !== "pending" || settled) return;
          observerState = "fulfilled";
          settleAfterCloseAndObservation();
        },
        (error: unknown) => rejectForObserverFailure(error),
      );
    }

    function onError(error: unknown): void {
      errorRecord = spawnErrorRecord(error);
    }

    function onClose(
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void {
      if (closeObserved || settled) return;
      closeObserved = true;
      observedExitCode = exitCode;
      observedSignal = signal;
      clearTimers();
      detachChildListeners();
      settleAfterCloseAndObservation();
    }

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("close", onClose);

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminationRequested = "sigterm";
      const terminated = child.kill("SIGTERM");
      if (!terminated) return;
      forceKillHandle = setTimeout(() => {
        if (settled) return;
        terminationRequested = "sigkill";
        child.kill("SIGKILL");
      }, config.terminate_grace_ms);
    }, config.timeout_ms);
  });
}
