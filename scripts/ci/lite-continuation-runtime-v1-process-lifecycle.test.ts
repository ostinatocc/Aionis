import assert from "node:assert/strict";
import test from "node:test";

import {
  createContinuationRuntimeV1ProcessLifecycle,
  type ContinuationRuntimeV1ProcessHost,
  type ContinuationRuntimeV1ShutdownSignal,
} from "../../src/runtime-v1/process-lifecycle.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function controlledHost() {
  const listeners = new Map<ContinuationRuntimeV1ShutdownSignal, Set<() => void>>([
    ["SIGINT", new Set()],
    ["SIGTERM", new Set()],
  ]);
  const exitCodes: number[] = [];
  const host: ContinuationRuntimeV1ProcessHost = Object.freeze({
    addSignalListener: (signal, listener) => {
      listeners.get(signal)!.add(listener);
    },
    removeSignalListener: (signal, listener) => {
      listeners.get(signal)!.delete(listener);
    },
    setExitCode: (code) => {
      exitCodes.push(code);
    },
  });
  return {
    host,
    exitCodes,
    emit(signal: ContinuationRuntimeV1ShutdownSignal) {
      for (const listener of [...listeners.get(signal)!]) listener();
    },
    listenerCount(signal: ContinuationRuntimeV1ShutdownSignal) {
      return listeners.get(signal)!.size;
    },
  };
}

function lifecycleInput(overrides: Partial<{
  shutdownTimeoutMs: number;
  stopNewWork: () => void | Promise<void>;
  drainInFlight: () => void | Promise<void>;
  closeDatabase: () => void | Promise<void>;
  host: ContinuationRuntimeV1ProcessHost;
}> = {}) {
  const controlled = controlledHost();
  return {
    controlled,
    input: {
      shutdownTimeoutMs: 5_000,
      stopNewWork: () => undefined,
      drainInFlight: () => undefined,
      closeDatabase: () => undefined,
      host: controlled.host,
      ...overrides,
    },
  };
}

test("process lifecycle strictly validates its authority surface", () => {
  const { input } = lifecycleInput();
  for (const shutdownTimeoutMs of [0, 300_001, 1.5, Number.NaN]) {
    assert.throws(
      () => createContinuationRuntimeV1ProcessLifecycle({
        ...input,
        shutdownTimeoutMs,
      }),
      /shutdown_timeout_ms_invalid/u,
    );
  }
  assert.throws(
    () => createContinuationRuntimeV1ProcessLifecycle({
      ...input,
      legacyClose: () => undefined,
    } as never),
    /input_fields_invalid/u,
  );
  assert.throws(
    () => createContinuationRuntimeV1ProcessLifecycle({
      ...input,
      host: { ...input.host, forceExit: () => undefined },
    } as never),
    /host_fields_invalid/u,
  );
  assert.throws(
    () => createContinuationRuntimeV1ProcessLifecycle({
      ...input,
      stopNewWork: null,
    } as never),
    /stopNewWork_must_be_function/u,
  );
  const symbol = Symbol("legacy");
  assert.throws(
    () => createContinuationRuntimeV1ProcessLifecycle(Object.assign(
      { ...input },
      { [symbol]: true },
    )),
    /input_fields_invalid/u,
  );
});

test("SIGTERM fences new work, drains accepted work, then closes SQLite", async () => {
  const calls: string[] = [];
  const stopStarted = deferred();
  const allowStop = deferred();
  const drainStarted = deferred();
  const allowDrain = deferred();
  const { input, controlled } = lifecycleInput({
    stopNewWork: async () => {
      calls.push("stop_new_work");
      stopStarted.resolve();
      await allowStop.promise;
    },
    drainInFlight: async () => {
      calls.push("drain_in_flight");
      drainStarted.resolve();
      await allowDrain.promise;
    },
    closeDatabase: () => {
      calls.push("close_database");
    },
  });
  const lifecycle = createContinuationRuntimeV1ProcessLifecycle(input);
  assert.throws(
    () => lifecycle.requestShutdown("SIGHUP" as never),
    /shutdown_signal_invalid/u,
  );
  const waitedBeforeSignal = lifecycle.waitForShutdown();

  controlled.emit("SIGTERM");
  await stopStarted.promise;
  assert.deepEqual(calls, ["stop_new_work"]);
  assert.equal(lifecycle.currentPhase(), "stop_new_work");
  allowStop.resolve();
  await drainStarted.promise;
  assert.deepEqual(calls, ["stop_new_work", "drain_in_flight"]);
  assert.equal(lifecycle.currentPhase(), "drain_in_flight");
  allowDrain.resolve();

  const result = await waitedBeforeSignal;
  assert.deepEqual(calls, [
    "stop_new_work",
    "drain_in_flight",
    "close_database",
  ]);
  assert.deepEqual(result, {
    schema_version: "continuation_runtime_shutdown_result_v1",
    status: "graceful",
    signal: "SIGTERM",
    exit_code: 0,
    terminal_phase: "complete",
    failure_code: null,
    completed_phases: [
      "stop_new_work",
      "drain_in_flight",
      "close_database",
    ],
  });
  assert.equal(lifecycle.result(), result);
  assert.equal(lifecycle.currentPhase(), null);
  assert.deepEqual(controlled.exitCodes, [0]);
  assert.equal(controlled.listenerCount("SIGINT"), 0);
  assert.equal(controlled.listenerCount("SIGTERM"), 0);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.completed_phases));
});

test("repeated and mixed signals share one exactly-once shutdown", async () => {
  const calls = { stop: 0, drain: 0, close: 0 };
  const drain = deferred();
  const drainStarted = deferred();
  const { input, controlled } = lifecycleInput({
    stopNewWork: () => {
      calls.stop += 1;
    },
    drainInFlight: async () => {
      calls.drain += 1;
      drainStarted.resolve();
      await drain.promise;
    },
    closeDatabase: () => {
      calls.close += 1;
    },
  });
  const lifecycle = createContinuationRuntimeV1ProcessLifecycle(input);

  const first = lifecycle.requestShutdown("SIGINT");
  const repeated = lifecycle.requestShutdown("SIGTERM");
  controlled.emit("SIGTERM");
  controlled.emit("SIGINT");
  await drainStarted.promise;
  assert.equal(first, repeated);
  assert.equal(lifecycle.shutdownRequested(), true);
  assert.deepEqual(calls, { stop: 1, drain: 1, close: 0 });
  drain.resolve();

  const result = await first;
  assert.equal(result.status, "graceful");
  assert.equal(result.signal, "SIGINT");
  assert.deepEqual(calls, { stop: 1, drain: 1, close: 1 });
  assert.equal(await lifecycle.requestShutdown("SIGTERM"), result);
  assert.deepEqual(calls, { stop: 1, drain: 1, close: 1 });
  assert.deepEqual(controlled.exitCodes, [0]);
});

test("a failed phase is redacted and cannot advance to a less safe phase", async () => {
  const secret = "database-password-do-not-leak";
  for (const fixture of [
    {
      phase: "stop_new_work" as const,
      expected: [] as string[],
      hooks: {
        stopNewWork: () => { throw new Error(secret); },
        drainInFlight: () => { throw new Error("must not run"); },
        closeDatabase: () => { throw new Error("must not run"); },
      },
    },
    {
      phase: "drain_in_flight" as const,
      expected: ["stop_new_work"],
      hooks: {
        stopNewWork: () => undefined,
        drainInFlight: async () => { throw new Error(secret); },
        closeDatabase: () => { throw new Error("must not run"); },
      },
    },
    {
      phase: "close_database" as const,
      expected: ["stop_new_work", "drain_in_flight"],
      hooks: {
        stopNewWork: () => undefined,
        drainInFlight: () => undefined,
        closeDatabase: () => { throw { secret }; },
      },
    },
  ]) {
    const { input, controlled } = lifecycleInput(fixture.hooks);
    const result = await createContinuationRuntimeV1ProcessLifecycle(input)
      .requestShutdown("SIGTERM");
    assert.deepEqual(result, {
      schema_version: "continuation_runtime_shutdown_result_v1",
      status: "failed",
      signal: "SIGTERM",
      exit_code: 1,
      terminal_phase: fixture.phase,
      failure_code: "phase_failed",
      completed_phases: fixture.expected,
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
    assert.deepEqual(controlled.exitCodes, [1]);
  }
});

test("the total deadline returns a stable result and never closes under active work", async () => {
  const drain = deferred();
  let closeCalls = 0;
  let postDrainReleases = 0;
  const { input, controlled } = lifecycleInput({
    shutdownTimeoutMs: 20,
    drainInFlight: async () => {
      await drain.promise;
      postDrainReleases += 1;
    },
    closeDatabase: () => {
      closeCalls += 1;
    },
  });
  const lifecycle = createContinuationRuntimeV1ProcessLifecycle(input);
  const result = await lifecycle.requestShutdown("SIGINT");

  assert.deepEqual(result, {
    schema_version: "continuation_runtime_shutdown_result_v1",
    status: "timed_out",
    signal: "SIGINT",
    exit_code: 1,
    terminal_phase: "drain_in_flight",
    failure_code: "shutdown_timeout",
    completed_phases: ["stop_new_work"],
  });
  assert.equal(closeCalls, 0);
  assert.deepEqual(controlled.exitCodes, [1]);
  assert.equal(controlled.listenerCount("SIGINT"), 0);
  assert.equal(controlled.listenerCount("SIGTERM"), 0);

  drain.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(postDrainReleases, 1);
  assert.equal(closeCalls, 0);
  assert.equal(lifecycle.result(), result);
  assert.deepEqual(controlled.exitCodes, [1]);
});

test("a stop-phase timeout still permits eventual drain release without closing", async () => {
  const stop = deferred();
  const drain = deferred();
  let drainPromise: Promise<void> | null = null;
  let releases = 0;
  let closeCalls = 0;
  const drainInFlight = (): Promise<void> => (
    drainPromise ??= drain.promise.then(() => { releases += 1; })
  );
  const { input } = lifecycleInput({
    shutdownTimeoutMs: 20,
    stopNewWork: async () => {
      void drainInFlight().catch(() => undefined);
      await stop.promise;
    },
    drainInFlight,
    closeDatabase: () => { closeCalls += 1; },
  });
  const lifecycle = createContinuationRuntimeV1ProcessLifecycle(input);
  const result = await lifecycle.requestShutdown("SIGTERM");
  assert.equal(result.status, "timed_out");
  assert.equal(result.terminal_phase, "stop_new_work");
  assert.deepEqual(result.completed_phases, []);
  assert.equal(releases, 0);
  assert.equal(closeCalls, 0);

  stop.resolve();
  drain.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases, 1);
  assert.equal(closeCalls, 0);
});

test("a timeout cannot duplicate a database close already in progress", async () => {
  const close = deferred();
  let closeCalls = 0;
  const { input } = lifecycleInput({
    shutdownTimeoutMs: 20,
    closeDatabase: async () => {
      closeCalls += 1;
      await close.promise;
    },
  });
  const lifecycle = createContinuationRuntimeV1ProcessLifecycle(input);
  const result = await lifecycle.requestShutdown("SIGTERM");
  assert.equal(result.status, "timed_out");
  assert.equal(result.terminal_phase, "close_database");
  assert.equal(closeCalls, 1);

  close.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
  assert.equal(lifecycle.result(), result);
});

test("dispose removes handlers without secretly initiating shutdown", async () => {
  let calls = 0;
  const { input, controlled } = lifecycleInput({
    stopNewWork: () => { calls += 1; },
  });
  const lifecycle = createContinuationRuntimeV1ProcessLifecycle(input);
  assert.equal(controlled.listenerCount("SIGINT"), 1);
  assert.equal(controlled.listenerCount("SIGTERM"), 1);

  lifecycle.dispose();
  lifecycle.dispose();
  controlled.emit("SIGTERM");
  assert.equal(calls, 0);
  assert.equal(lifecycle.shutdownRequested(), false);
  assert.equal(lifecycle.result(), null);
  assert.equal(controlled.listenerCount("SIGINT"), 0);
  assert.equal(controlled.listenerCount("SIGTERM"), 0);

  const result = await lifecycle.requestShutdown("SIGTERM");
  assert.equal(result.status, "graceful");
  assert.equal(calls, 1);
});
