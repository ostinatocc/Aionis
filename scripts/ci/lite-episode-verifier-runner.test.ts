import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertAuthenticEpisodeVerifierExecution,
  canonicalEpisodeVerifierRunnerConfig,
  episodeVerifierRunnerConfigDigest,
  episodeVerifierRunnerResultDigest,
  runEpisodeVerifier,
  type EpisodeVerifierRunnerConfig,
  type EpisodeVerifierSpawnObservation,
} from "../../src/execution/episode-verifier-runner.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workspace(t: test.TestContext, name: string): string {
  const path = mkdtempSync(join(tmpdir(), `aionis-real-verifier-${name}-`));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function writeExecutableFixture(
  directory: string,
  name: string,
  source: string,
): string {
  const path = join(directory, name);
  writeFileSync(path, source, { encoding: "utf8", mode: 0o600 });
  return path;
}

function baseConfig(
  cwd: string,
  argv: string[],
): EpisodeVerifierRunnerConfig {
  return {
    executable: process.execPath,
    argv,
    cwd,
    environment: {
      AIONIS_VERIFIER_FIXTURE: "real-process",
    },
    timeout_ms: 2_000,
    terminate_grace_ms: 100,
    max_stdout_bytes: 64,
    max_stderr_bytes: 32,
  };
}

test("real verifier process passes, uses literal argv, writes the workspace, and bounds output", async (t) => {
  const directory = workspace(t, "pass");
  const inputPath = join(directory, "input.txt");
  const outputPath = join(directory, "verified.txt");
  writeFileSync(inputPath, "expected-state", "utf8");
  const fixturePath = writeExecutableFixture(
    directory,
    "pass-verifier.mjs",
    `
      import { readFileSync, writeFileSync } from "node:fs";
      const [, , inputPath, outputPath, literalArgument] = process.argv;
      if (readFileSync(inputPath, "utf8") !== "expected-state") process.exit(41);
      if (literalArgument !== "literal;$(never-a-shell)") process.exit(42);
      if (process.env.AIONIS_VERIFIER_FIXTURE !== "real-process") process.exit(43);
      writeFileSync(outputPath, "verified-real-state", "utf8");
      process.stdout.write("P".repeat(257));
      process.stderr.write("E".repeat(129));
    `,
  );
  const config = baseConfig(directory, [
    fixturePath,
    inputPath,
    outputPath,
    "literal;$(never-a-shell)",
  ]);

  const result = await runEpisodeVerifier(config);

  assert.equal(result.status, "passed");
  assert.equal(result.exit_code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timed_out, false);
  assert.equal(result.spawn_error, null);
  assert.equal(readFileSync(outputPath, "utf8"), "verified-real-state");
  assert.equal(
    Buffer.from(result.stdout.captured_base64, "base64").toString("utf8"),
    "P".repeat(64),
  );
  assert.deepEqual(
    {
      captured: result.stdout.captured_byte_length,
      total: result.stdout.total_byte_length,
      truncated: result.stdout.truncated,
      sha256: result.stdout.sha256,
    },
    {
      captured: 64,
      total: 257,
      truncated: true,
      sha256: sha256("P".repeat(257)),
    },
  );
  assert.equal(
    Buffer.from(result.stderr.captured_base64, "base64").toString("utf8"),
    "E".repeat(32),
  );
  assert.equal(result.stderr.total_byte_length, 129);
  assert.equal(result.stderr.sha256, sha256("E".repeat(129)));
  assert.equal(
    result.result_sha256,
    episodeVerifierRunnerResultDigest(result),
  );
  assert.equal(
    assertAuthenticEpisodeVerifierExecution(result).config.executable,
    process.execPath,
  );
  assert.throws(
    () => assertAuthenticEpisodeVerifierExecution({ ...result }),
    /episode_verifier_execution_evidence_not_authentic/u,
  );
});

test("real spawn lifecycle observation carries the child PID and delays result settlement until its async work completes", async (t) => {
  const directory = workspace(t, "spawn-observer");
  const pidPath = join(directory, "verifier.pid");
  const fixturePath = writeExecutableFixture(
    directory,
    "spawn-observer-verifier.mjs",
    `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], String(process.pid), "utf8");
      process.stdout.write("spawn-observer-complete");
    `,
  );
  let releaseObservation!: () => void;
  const observationBarrier = new Promise<void>((resolve) => {
    releaseObservation = resolve;
  });
  let publishObservation!: (value: EpisodeVerifierSpawnObservation) => void;
  const observationPublished = new Promise<EpisodeVerifierSpawnObservation>(
    (resolve) => {
      publishObservation = resolve;
    },
  );
  let observationCalls = 0;
  let runnerSettled = false;
  const beforeRunMs = Date.now();

  const resultPromise = runEpisodeVerifier(
    baseConfig(directory, [fixturePath, pidPath]),
    {
      on_spawn_observed(observation) {
        observationCalls += 1;
        publishObservation(observation);
        return observationBarrier;
      },
    },
  );
  void resultPromise.then(
    () => {
      runnerSettled = true;
    },
    () => {
      runnerSettled = true;
    },
  );

  const observation = await observationPublished;
  const afterObservationMs = Date.now();
  const pidDeadlineMs = Date.now() + 2_000;
  while (!existsSync(pidPath) && Date.now() < pidDeadlineMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(pidPath), true);
  const childExitDeadlineMs = Date.now() + 2_000;
  let childStillExists = true;
  while (childStillExists && Date.now() < childExitDeadlineMs) {
    try {
      process.kill(observation.process_id, 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ESRCH"
      ) {
        childStillExists = false;
      } else {
        throw error;
      }
    }
  }
  assert.equal(childStillExists, false);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(observationCalls, 1);
  assert.equal(
    observation.process_id,
    Number.parseInt(readFileSync(pidPath, "utf8"), 10),
  );
  const observedStartedAtMs = Date.parse(observation.started_at);
  assert.ok(Number.isFinite(observedStartedAtMs));
  assert.ok(observedStartedAtMs >= beforeRunMs);
  assert.ok(observedStartedAtMs <= afterObservationMs);
  assert.equal(
    runnerSettled,
    false,
    "the child result must wait for durable lifecycle observation",
  );

  releaseObservation();
  const result = await resultPromise;

  assert.equal(result.status, "passed");
  assert.equal(result.started_at, observation.started_at);
  assert.equal(
    Buffer.from(result.stdout.captured_base64, "base64").toString("utf8"),
    "spawn-observer-complete",
  );
  assert.equal(observationCalls, 1);
});

test("real spawn lifecycle observer rejection rejects the runner and reaps the child", async (t) => {
  const directory = workspace(t, "spawn-observer-rejection");
  const fixturePath = writeExecutableFixture(
    directory,
    "long-running-verifier.mjs",
    `
      process.stdout.write("running");
      setInterval(() => {}, 10_000);
    `,
  );
  const observerFailure = new Error("durable launch observation failed");
  let observationCalls = 0;
  let observedProcessId: number | null = null;
  const config = {
    ...baseConfig(directory, [fixturePath]),
    timeout_ms: 2_000,
    terminate_grace_ms: 50,
  };

  await assert.rejects(
    runEpisodeVerifier(config, {
      async on_spawn_observed(observation) {
        observationCalls += 1;
        observedProcessId = observation.process_id;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        throw observerFailure;
      },
    }),
    (error: unknown) => error === observerFailure,
  );

  assert.equal(observationCalls, 1);
  assert.notEqual(observedProcessId, null);
  assert.throws(
    () => process.kill(observedProcessId!, 0),
    (error: unknown) =>
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ESRCH",
  );
});

test("real verifier exit 1 is a semantic failure with its real exit code", async (t) => {
  const directory = workspace(t, "fail");
  const fixturePath = writeExecutableFixture(
    directory,
    "fail-verifier.mjs",
    `
      import { readFileSync } from "node:fs";
      const value = readFileSync(process.argv[2], "utf8");
      process.stdout.write("checked:" + value);
      process.stderr.write("verification rejected");
      process.exit(1);
    `,
  );
  const targetPath = join(directory, "target.txt");
  writeFileSync(targetPath, "incorrect-state", "utf8");

  const result = await runEpisodeVerifier({
    ...baseConfig(directory, [fixturePath, targetPath]),
    infrastructure_exit_codes: [75],
  });

  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.timed_out, false);
  assert.equal(result.spawn_error, null);
  assert.equal(
    Buffer.from(result.stdout.captured_base64, "base64").toString("utf8"),
    "checked:incorrect-state",
  );
  assert.equal(
    Buffer.from(result.stderr.captured_base64, "base64").toString("utf8"),
    "verification rejected",
  );
  assert.equal(
    result.result_sha256,
    episodeVerifierRunnerResultDigest(result),
  );
  const originalStatus = result.status;
  result.status = "passed";
  assert.throws(
    () => assertAuthenticEpisodeVerifierExecution(result),
    /episode_verifier_execution_evidence_not_authentic/u,
  );
  result.status = originalStatus;
  assert.equal(
    assertAuthenticEpisodeVerifierExecution(result).config.executable,
    process.execPath,
  );
});

test("configured real verifier exit 75 is an infrastructure error while preserving its exit code", async (t) => {
  const directory = workspace(t, "infrastructure-exit");
  const fixturePath = writeExecutableFixture(
    directory,
    "infrastructure-exit-verifier.mjs",
    `
      process.stderr.write("temporary verifier infrastructure failure");
      process.exit(75);
    `,
  );
  const config: EpisodeVerifierRunnerConfig = {
    ...baseConfig(directory, [fixturePath]),
    infrastructure_exit_codes: [75],
  };

  const result = await runEpisodeVerifier(config);

  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.exit_code, 75);
  assert.equal(result.signal, null);
  assert.equal(result.timed_out, false);
  assert.equal(result.spawn_error, null);
  assert.deepEqual(
    assertAuthenticEpisodeVerifierExecution(result)
      .config.infrastructure_exit_codes,
    [75],
  );
  assert.equal(
    Buffer.from(result.stderr.captured_base64, "base64").toString("utf8"),
    "temporary verifier infrastructur",
  );
  assert.equal(result.stderr.truncated, true);
});

test("timed out real verifier is terminated and remains infrastructure error", async (t) => {
  const directory = workspace(t, "timeout");
  const pidPath = join(directory, "verifier.pid");
  const fixturePath = writeExecutableFixture(
    directory,
    "timeout-verifier.mjs",
    `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], String(process.pid), "utf8");
      process.on("SIGTERM", () => {
        process.stderr.write("ignored-sigterm");
      });
      process.stdout.write("started");
      setInterval(() => {}, 10_000);
    `,
  );
  const config = {
    ...baseConfig(directory, [fixturePath, pidPath]),
    timeout_ms: 500,
    terminate_grace_ms: 100,
  };

  const result = await runEpisodeVerifier(config);

  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.exit_code, null);
  assert.equal(result.timed_out, true);
  assert.ok(
    result.termination_requested === "sigterm"
      || result.termination_requested === "sigkill",
  );
  assert.ok(result.elapsed_ms >= 500);
  assert.ok(result.elapsed_ms < 4_000);
  const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) =>
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ESRCH",
  );
  assert.equal(
    result.result_sha256,
    episodeVerifierRunnerResultDigest(result),
  );
});

test("real spawn error has no exit code and remains infrastructure error", async (t) => {
  const directory = workspace(t, "spawn-error");
  let lifecycleObservationCalls = 0;
  const config: EpisodeVerifierRunnerConfig = {
    ...baseConfig(directory, []),
    executable: join(directory, "executable-does-not-exist"),
    timeout_ms: 1_000,
  };

  const result = await runEpisodeVerifier(config, {
    on_spawn_observed() {
      lifecycleObservationCalls += 1;
    },
  });

  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.exit_code, null);
  assert.equal(result.signal, null);
  assert.equal(result.timed_out, false);
  assert.equal(result.termination_requested, "none");
  assert.equal(result.spawn_error?.code, "ENOENT");
  assert.match(result.spawn_error?.message ?? "", /ENOENT|no such file/iu);
  assert.equal(lifecycleObservationCalls, 0);
  assert.equal(
    result.result_sha256,
    episodeVerifierRunnerResultDigest(result),
  );
});

test("canonical config digest is stable across environment key order and explicit defaults", () => {
  const cwd = tmpdir();
  const left: EpisodeVerifierRunnerConfig = {
    executable: process.execPath,
    argv: ["verifier.mjs", "", "literal argument"],
    cwd,
    environment: {
      Z_VALUE: "last",
      A_VALUE: "first",
    },
    timeout_ms: 2_000,
    terminate_grace_ms: 1_000,
    max_stdout_bytes: 1024 * 1024,
    max_stderr_bytes: 1024 * 1024,
  };
  const right: EpisodeVerifierRunnerConfig = {
    executable: process.execPath,
    argv: ["verifier.mjs", "", "literal argument"],
    cwd,
    environment: {
      A_VALUE: "first",
      Z_VALUE: "last",
    },
    timeout_ms: 2_000,
  };

  assert.equal(
    episodeVerifierRunnerConfigDigest(left),
    episodeVerifierRunnerConfigDigest(right),
  );
});

test("canonical infrastructure exit codes are sorted, unique, bounded, and digest-bound", () => {
  const base: EpisodeVerifierRunnerConfig = {
    executable: process.execPath,
    argv: ["verifier.mjs"],
    cwd: tmpdir(),
    timeout_ms: 2_000,
  };
  const left = {
    ...base,
    infrastructure_exit_codes: [75, 70],
  };
  const right = {
    ...base,
    infrastructure_exit_codes: [70, 75],
  };

  assert.deepEqual(
    canonicalEpisodeVerifierRunnerConfig(left).infrastructure_exit_codes,
    [70, 75],
  );
  assert.equal(
    episodeVerifierRunnerConfigDigest(left),
    episodeVerifierRunnerConfigDigest(right),
  );
  assert.notEqual(
    episodeVerifierRunnerConfigDigest(left),
    episodeVerifierRunnerConfigDigest({
      ...base,
      infrastructure_exit_codes: [75],
    }),
  );
  for (const invalid of [[0], [256], [75, 75], [1.5]]) {
    assert.throws(
      () => canonicalEpisodeVerifierRunnerConfig({
        ...base,
        infrastructure_exit_codes: invalid,
      }),
      /infrastructure_exit_codes/u,
    );
  }
  assert.throws(
    () => canonicalEpisodeVerifierRunnerConfig({
      ...base,
      infrastructure_exit_codes: Array(1),
    }),
    /infrastructure_exit_codes/u,
  );
  assert.throws(
    () => canonicalEpisodeVerifierRunnerConfig({
      ...base,
      infrastructure_exit_codes:
        Array.from({ length: 256 }, (_, index) => (index % 255) + 1),
    }),
    /at most 255 entries/u,
  );
});
