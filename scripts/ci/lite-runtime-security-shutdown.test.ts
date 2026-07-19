import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { persistInitialExecutionDecisionAuthority } from "../../src/memory/execution-decision-authority.js";
import { SandboxExecutor } from "../../src/memory/sandbox-executor.js";
import { createSandboxStore } from "../../src/store/sandbox-access.js";
import {
  createLiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.js";
import { createLiteRuntimeStore } from "../../src/store/lite-runtime-store.js";
import { createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.js";
import {
  hardenPrivateRuntimeSqlitePathOffline,
  preparePrivateRuntimeSqlitePath,
} from "../../src/store/sqlite.js";
import {
  closeBootstrapResources,
  registerRuntimeSignalShutdown,
  type RuntimeShutdownHost,
  type RuntimeShutdownSignal,
} from "../../src/server/bootstrap.js";

const ROOT = resolve(import.meta.dirname, "..", "..");

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ControlledShutdownHost implements RuntimeShutdownHost {
  readonly listeners = new Map<RuntimeShutdownSignal, Set<() => void>>();
  readonly forced = deferred<number>();
  exitCode: number | null = null;

  addSignalListener(signal: RuntimeShutdownSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  removeSignalListener(signal: RuntimeShutdownSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }

  forceExit(code: number): void {
    this.forced.resolve(code);
  }

  emit(signal: RuntimeShutdownSignal): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener();
  }
}

test("Lite Runtime SQLite safely hardens an existing 0755 directory under umask 000", {
  skip: process.platform === "win32" ? "POSIX mode bits are not a Windows ACL" : false,
}, async () => {
  const previousUmask = process.umask(0o000);
  let root: string | null = null;
  try {
    root = mkdtempSync(join(tmpdir(), "aionis-runtime-permissions-"));
    const directory = join(root, "authority");
    const databasePath = join(directory, "runtime.sqlite");
    mkdirSync(directory, { mode: 0o755 });
    assert.equal(mode(directory), 0o755);

    const database = createLiteRuntimeDatabase(databasePath);
    try {
      database.db.exec("CREATE TABLE permission_probe (value TEXT); INSERT INTO permission_probe VALUES ('ok')");
      assert.equal(mode(directory), 0o700);
      for (const artifact of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        assert.equal(existsSync(artifact), true, `${artifact} should exist while WAL connections are live`);
        assert.equal(mode(artifact), 0o600, `${artifact} should be owner-only`);
      }
    } finally {
      await database.close();
    }
  } finally {
    process.umask(previousUmask);
    if (root !== null) rmSync(root, { recursive: true, force: true });
  }
});

test("Lite Runtime SQLite rejects old 0644 databases until explicit offline hardening", {
  skip: process.platform === "win32" ? "POSIX mode bits are not a Windows ACL" : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-runtime-mode-drift-"));
  const directory = join(root, "authority");
  const databasePath = join(directory, "runtime.sqlite");
  try {
    preparePrivateRuntimeSqlitePath(databasePath);
    chmodSync(databasePath, 0o644);
    assert.throws(
      () => createLiteRuntimeDatabase(databasePath),
      /runtime_sqlite_artifact_mode_invalid/u,
    );
    assert.equal(mode(databasePath), 0o644, "startup must not repair an existing file by pathname");

    hardenPrivateRuntimeSqlitePathOffline(databasePath);
    assert.equal(mode(directory), 0o700);
    assert.equal(mode(databasePath), 0o600);
    const database = createLiteRuntimeDatabase(databasePath);
    try {
      database.db.exec("CREATE TABLE mode_probe (value TEXT); INSERT INTO mode_probe VALUES ('ok')");
      for (const artifact of [`${databasePath}-wal`, `${databasePath}-shm`]) {
        assert.equal(existsSync(artifact), true);
        chmodSync(artifact, 0o644);
        assert.throws(
          () => createLiteRuntimeDatabase(databasePath),
          /runtime_sqlite_artifact_mode_invalid/u,
        );
        assert.equal(mode(artifact), 0o644, "startup must not repair a live SQLite sidecar");
        chmodSync(artifact, 0o600);
      }
    } finally {
      await database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Lite Runtime SQLite refuses main-file symlinks without touching the target", {
  skip: process.platform === "win32" ? "symlink setup requires platform privileges" : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-runtime-symlink-"));
  const directory = join(root, "authority");
  const victim = join(root, "victim.sqlite");
  const databasePath = join(directory, "runtime.sqlite");
  try {
    preparePrivateRuntimeSqlitePath(join(directory, "anchor.sqlite"));
    writeFileSync(victim, "must-not-open", { mode: 0o600 });
    symlinkSync(victim, databasePath);
    assert.throws(
      () => createLiteRuntimeDatabase(databasePath),
      /runtime_sqlite_artifact_must_be_regular_file/u,
    );
    assert.equal(statSync(victim).size, Buffer.byteLength("must-not-open"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Lite Runtime SQLite refuses sidecar symlinks before opening SQLite", {
  skip: process.platform === "win32" ? "symlink setup requires platform privileges" : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-runtime-sidecar-symlink-"));
  const directory = join(root, "authority");
  const databasePath = join(directory, "runtime.sqlite");
  const victim = join(root, "victim.wal");
  try {
    const initial = createLiteRuntimeDatabase(databasePath);
    await initial.close();
    writeFileSync(victim, "must-not-open", { mode: 0o600 });
    symlinkSync(victim, `${databasePath}-wal`);
    assert.throws(
      () => createLiteRuntimeDatabase(databasePath),
      /runtime_sqlite_artifact_must_be_regular_file/u,
    );
    assert.equal(statSync(victim).size, Buffer.byteLength("must-not-open"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Lite Runtime SQLite refuses a shared sticky parent instead of chmodding it", {
  skip: process.platform === "win32" ? "POSIX shared directory contract" : false,
}, () => {
  const sharedDirectory = "/tmp";
  const before = statSync(sharedDirectory).mode & 0o7777;
  const databasePath = join(sharedDirectory, `aionis-forbidden-${process.pid}-${Date.now()}.sqlite`);
  assert.throws(
    () => preparePrivateRuntimeSqlitePath(databasePath),
    /runtime_sqlite_requires_dedicated_data_directory/u,
  );
  assert.equal(statSync(sharedDirectory).mode & 0o7777, before);
  assert.equal(existsSync(databasePath), false);
});

test("signal shutdown is idempotent on the first signal and forces on a second signal", async () => {
  const app = Fastify({ logger: false });
  const closeStarted = deferred();
  const releaseClose = deferred();
  app.addHook("onClose", async () => {
    closeStarted.resolve();
    await releaseClose.promise;
  });
  const host = new ControlledShutdownHost();
  const controller = registerRuntimeSignalShutdown({ app, host, timeoutMs: 5_000 });

  host.emit("SIGTERM");
  await within(closeStarted.promise, "Fastify close start");
  assert.equal(host.exitCode, 0);
  assert.equal(controller.shutdownRequested(), true);

  host.emit("SIGTERM");
  assert.equal(await within(host.forced.promise, "second-signal force"), 143);
  releaseClose.resolve();
  await within(controller.waitForShutdown(), "Fastify close finish");
});

test("signal shutdown has a bounded deadline", async () => {
  const app = Fastify({ logger: false });
  const releaseClose = deferred();
  app.addHook("onClose", async () => {
    await releaseClose.promise;
  });
  const host = new ControlledShutdownHost();
  const controller = registerRuntimeSignalShutdown({ app, host, timeoutMs: 30 });

  host.emit("SIGINT");
  assert.equal(await within(host.forced.promise, "shutdown timeout force"), 130);
  releaseClose.resolve();
  await within(controller.waitForShutdown(), "timed-out Fastify close finish");
});

test("bootstrap close attempts every worker and store before surfacing failures", async () => {
  const calls: string[] = [];
  const closeable = (label: string) => ({
    close: async () => {
      calls.push(label);
    },
  });
  await assert.rejects(
    closeBootstrapResources({
      store: closeable("runtime_store") as never,
      sandboxExecutor: {
        shutdown: () => {
          calls.push("sandbox_executor");
          throw new Error("expected shutdown failure");
        },
      },
      associativeLinkWorker: {
        shutdown: async () => {
          calls.push("associative_link_worker");
        },
      },
      learningControlWorker: {
        shutdown: async () => {
          calls.push("learning_control_worker");
        },
      },
      projectionWorker: {
        shutdown: async () => {
          calls.push("projection_worker");
        },
      },
      executionTreeStore: closeable("execution_tree_store"),
      executionStateStore: closeable("execution_state_store"),
      liteRecallStore: closeable("recall_store"),
      liteReplayStore: closeable("replay_store"),
      liteWriteStore: closeable("write_store"),
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some((entry) => String(entry).includes("sandbox_executor")),
  );
  assert.deepEqual(new Set(calls), new Set([
    "associative_link_worker",
    "learning_control_worker",
    "projection_worker",
    "sandbox_executor",
    "execution_tree_store",
    "execution_state_store",
    "recall_store",
    "replay_store",
    "write_store",
    "runtime_store",
  ]));
});

test("Lite write-store close drains accepted work and seals later write and projection admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-write-store-drain-"));
  const database = createLiteRuntimeDatabase(join(root, "authority", "runtime.sqlite"));
  const store = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
  const accepted = deferred();
  const releaseAccepted = deferred();
  let activeTransaction: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  try {
    database.db.exec("CREATE TABLE close_drain_probe (value TEXT NOT NULL)");
    activeTransaction = store.withTx(async () => {
      database.db.prepare("INSERT INTO close_drain_probe (value) VALUES (?)").run("accepted-before-close");
      accepted.resolve();
      await releaseAccepted.promise;
    });
    await within(accepted.promise, "accepted write transaction start");

    let closeSettled = false;
    closing = store.close();
    void closing.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );

    await assert.rejects(
      store.withTx(async () => undefined),
      /lite_write_store_closing/u,
    );
    await assert.rejects(
      store.claimProjectionJobs({
        leaseOwner: "shutdown-regression",
        leaseMs: 1_000,
        limit: 1,
      }),
      /sqlite_transaction_runner_sealed/u,
    );
    await Promise.resolve();
    assert.equal(closeSettled, false, "close must wait for the already accepted transaction");

    releaseAccepted.resolve();
    await within(activeTransaction, "accepted write transaction finish");
    await within(closing, "write-store close finish");
    const probe = database.db.prepare(
      "SELECT value FROM close_drain_probe",
    ).get() as { value: string } | undefined;
    assert.equal(probe?.value, "accepted-before-close");
  } finally {
    releaseAccepted.resolve();
    await Promise.allSettled([
      ...(activeTransaction ? [activeTransaction] : []),
      ...(closing ? [closing] : []),
    ]);
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent Lite write-store close calls share one safe shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-write-store-concurrent-close-"));
  const databasePath = join(root, "authority", "runtime.sqlite");
  const database = createLiteRuntimeDatabase(databasePath);
  const store = createLiteWriteStoreFromDatabase(database, {
    annProjectionEnabled: false,
    closeDatabaseOnClose: true,
  });
  try {
    const closes = [store.close(), store.close(), store.close()];
    await within(Promise.all(closes), "concurrent write-store close");

    const reopened = createLiteRuntimeDatabase(databasePath);
    try {
      const integrity = reopened.db.prepare<{ integrity_check: string }>(
        "PRAGMA integrity_check",
      ).get();
      assert.equal(integrity.integrity_check, "ok");
    } finally {
      await reopened.close();
    }
  } finally {
    await Promise.allSettled([store.close(), database.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Lite write-store close fails closed when its final authority audit finds live tamper", async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-write-store-final-audit-"));
  const database = createLiteRuntimeDatabase(join(root, "authority", "runtime.sqlite"));
  const store = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
  const scope = "shutdown-final-audit";
  const decisionId = "shutdown-final-audit-decision";
  try {
    await persistInitialExecutionDecisionAuthority({
      store,
      actor: "shutdown-regression",
      decision: {
        id: decisionId,
        scope,
        decisionKind: "tools_select",
        runId: null,
        selectedTool: "read",
        candidatesJson: [{ tool: "read" }],
        contextSha256: "a".repeat(64),
        policySha256: "b".repeat(64),
        sourceRuleIds: [],
        metadataJson: { source: "shutdown-regression" },
        commitId: null,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });
    database.db.prepare(
      `UPDATE lite_memory_execution_decisions
       SET selected_tool = 'tampered-after-commit'
       WHERE scope = ? AND id = ?`,
    ).run(scope, decisionId);

    await assert.rejects(
      store.close(),
      /lite_memory_commit_authority_terminal_row_mismatch/u,
    );
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function createShutdownTestSandboxExecutor(
  sandboxStore: ReturnType<typeof createSandboxStore>,
  workdir: string,
  remoteUrl: string | null = null,
): SandboxExecutor {
  return new SandboxExecutor(sandboxStore, {
    enabled: true,
    mode: remoteUrl ? "http_remote" : "local_process",
    maxConcurrency: 1,
    defaultTimeoutMs: 30_000,
    stdioMaxBytes: 64 * 1024,
    workdir,
    allowedCommands: new Set([process.execPath]),
    remote: {
      url: remoteUrl,
      authHeader: "authorization",
      authToken: "",
      timeoutMs: 30_000,
      allowedHosts: new Set(remoteUrl ? ["127.0.0.1"] : []),
      allowedEgressCidrs: new Set(remoteUrl ? ["127.0.0.1/32"] : []),
      denyPrivateIps: true,
      mtlsCertPem: "",
      mtlsKeyPem: "",
      mtlsCaPem: "",
      mtlsServerName: "",
    },
    artifactObjectStoreBaseUri: null,
    heartbeatIntervalMs: 0,
    staleAfterMs: 60_000,
    recoveryPollIntervalMs: 0,
    recoveryBatchSize: 10,
  });
}

async function insertShutdownTestSandboxRun(args: {
  sandboxStore: ReturnType<typeof createSandboxStore>;
  runId: string;
  argv: string[];
  mode: "sync" | "async";
  timeoutMs?: number;
}): Promise<void> {
  const session = await args.sandboxStore.withTx((access) => access.createSession({
    tenantId: "default",
    scope: "default",
    profile: "default",
    metadataJson: "{}",
    expiresAt: null,
  }));
  await args.sandboxStore.withTx((access) => access.insertRun({
    id: args.runId,
    sessionId: session.id,
    tenantId: "default",
    scope: "default",
    projectId: null,
    plannerRunId: null,
    decisionId: null,
    actionJson: JSON.stringify({ argv: args.argv }),
    mode: args.mode,
    timeoutMs: args.timeoutMs ?? 30_000,
    metadataJson: "{}",
  }));
}

function flattenErrorMessages(error: unknown, seen = new Set<unknown>()): string {
  if (seen.has(error)) return "";
  seen.add(error);
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map((nested) => flattenErrorMessages(nested, seen))]
      .filter(Boolean)
      .join("\n");
  }
  if (error instanceof Error) {
    return [error.message, flattenErrorMessages(error.cause, seen)].filter(Boolean).join("\n");
  }
  return error === undefined ? "" : String(error);
}

async function waitForNoSockets(sockets: Set<net.Socket>): Promise<void> {
  while (sockets.size > 0) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
  }
}

async function cleanupShutdownTestFixture(args: {
  root: string;
  store: ReturnType<typeof createLiteRuntimeStore>;
  executor: SandboxExecutor | null;
  server?: HttpServer;
  sockets?: Set<net.Socket>;
  allowShutdownFailure?: boolean;
}): Promise<void> {
  const failures: unknown[] = [];
  const transportTasks: Promise<unknown>[] = [];
  if (args.sockets) {
    const sockets = [...args.sockets];
    const closed = sockets.map((socket) => new Promise<void>((resolveClose) => socket.once("close", resolveClose)));
    for (const socket of sockets) socket.destroy();
    transportTasks.push(within(Promise.all(closed).then(() => undefined), "sandbox test socket cleanup", 5_000));
  }
  if (args.server?.listening) {
    transportTasks.push(within(
      new Promise<void>((resolveClose, rejectClose) => {
        args.server!.close((error) => error ? rejectClose(error) : resolveClose());
      }),
      "sandbox test HTTP server cleanup",
      5_000,
    ));
  }
  if (args.executor) {
    transportTasks.push(within(args.executor.shutdown(), "sandbox test executor cleanup", 5_000));
  }

  const transportResults = await Promise.allSettled(transportTasks);
  for (const result of transportResults) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (args.allowShutdownFailure && args.executor) {
    const expected = await Promise.allSettled([args.executor.shutdown()]);
    const expectedFailure = expected[0];
    if (expectedFailure?.status === "rejected") {
      const index = failures.indexOf(expectedFailure.reason);
      if (index >= 0) failures.splice(index, 1);
    }
  }
  if (args.sockets && args.sockets.size > 0) {
    failures.push(new Error(`sandbox test leaked ${args.sockets.size} transport socket(s)`));
  }

  const storeResult = await Promise.allSettled([args.store.close()]);
  if (storeResult[0]?.status === "rejected") failures.push(storeResult[0].reason);
  try {
    rmSync(args.root, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "sandbox shutdown test cleanup failed");
  }
}

test("sandbox shutdown cancels and waits for a real active child before the store closes", {
  skip: process.platform === "win32" ? "POSIX child signal contract" : false,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aionis-sandbox-shutdown-"));
  const store = createLiteRuntimeStore(join(root, "authority", "runtime.sqlite"));
  const sandboxStore = createSandboxStore(store);
  const runId = randomUUID();
  const executor = createShutdownTestSandboxExecutor(sandboxStore, root);
  t.after(async () => await cleanupShutdownTestFixture({ root, store, executor }));
  await insertShutdownTestSandboxRun({
    sandboxStore,
    runId,
    argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
    mode: "sync",
  });
  const execution = executor.executeSync(runId);

  const activeDeadline = Date.now() + 5_000;
  let active = false;
  while (Date.now() < activeDeadline) {
    if (executor.healthSnapshot().active_runs === 1) {
      active = true;
      break;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
  }
  assert.equal(active, true);

  await within(executor.shutdown(), "sandbox shutdown", 5_000);
  await within(execution, "sandbox execution finalization", 5_000);
  const terminal = await sandboxStore.withClient((access) => access.getRun({
    id: runId,
    tenantId: "default",
    scope: "default",
  }));
  assert.equal(terminal?.status, "canceled");
  assert.equal(terminal?.error, "canceled_by_shutdown");
  assert.equal(terminal?.result_json?.canceled_by, "shutdown");
  assert.equal(terminal?.finished_at === null, false);
});

test("sandbox shutdown seals pre-active execution and durably cancels queued backlog", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aionis-sandbox-shutdown-seal-"));
  const store = createLiteRuntimeStore(join(root, "authority", "runtime.sqlite"));
  const sandboxStore = createSandboxStore(store);
  const startingRunId = randomUUID();
  const queuedRunId = randomUUID();
  const startingMarker = join(root, "starting-child-created");
  const queuedMarker = join(root, "queued-child-created");
  const executor = createShutdownTestSandboxExecutor(sandboxStore, root);
  t.after(async () => await cleanupShutdownTestFixture({ root, store, executor }));
  await insertShutdownTestSandboxRun({
    sandboxStore,
    runId: startingRunId,
    argv: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(startingMarker)}, "started")`],
    mode: "sync",
  });
  await insertShutdownTestSandboxRun({
    sandboxStore,
    runId: queuedRunId,
    argv: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(queuedMarker)}, "started")`],
    mode: "async",
  });
  const execution = executor.executeSync(startingRunId);
  executor.enqueue(queuedRunId);
  const shutdown = executor.shutdown();

  assert.strictEqual(executor.shutdown(), shutdown);
  await within(Promise.all([execution, shutdown]), "sealed sandbox shutdown", 5_000);
  await assert.rejects(executor.executeSync(startingRunId), {
    name: "HttpError",
    code: "sandbox_shutting_down",
    statusCode: 503,
  });

  for (const [runId, marker] of [
    [startingRunId, startingMarker],
    [queuedRunId, queuedMarker],
  ] as const) {
    const terminal = await sandboxStore.withClient((access) => access.getRun({
      id: runId,
      tenantId: "default",
      scope: "default",
    }));
    assert.equal(terminal?.status, "canceled");
    assert.equal(terminal?.error, "canceled_by_shutdown");
    assert.equal(terminal?.result_json?.canceled_by, "shutdown");
    assert.equal(terminal?.finished_at === null, false);
    assert.equal(existsSync(marker), false, "shutdown seal must prevent a new child side effect");
    if (runId === startingRunId) {
      assert.equal(terminal?.result_json?.stage, "shutdown_before_activation");
    }
  }
});

test("sandbox shutdown reports durable cancellation failures and still attempts every queued run", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aionis-sandbox-shutdown-failure-"));
  const databasePath = join(root, "authority", "runtime.sqlite");
  const store = createLiteRuntimeStore(databasePath);
  const sandboxStore = createSandboxStore(store);
  const failedRunId = randomUUID();
  const siblingRunId = randomUUID();
  const executor = createShutdownTestSandboxExecutor(sandboxStore, root);
  t.after(async () => await cleanupShutdownTestFixture({
    root,
    store,
    executor,
    allowShutdownFailure: true,
  }));

  for (const runId of [failedRunId, siblingRunId]) {
    await insertShutdownTestSandboxRun({
      sandboxStore,
      runId,
      argv: [process.execPath, "-e", "process.exit(0)"],
      mode: "async",
    });
  }

  const injector = createLiteRuntimeDatabase(databasePath);
  try {
    injector.db.exec(`
      CREATE TRIGGER reject_one_sandbox_shutdown_cancel
      BEFORE UPDATE OF status ON memory_sandbox_runs
      WHEN OLD.id = '${failedRunId}'
        AND OLD.status = 'queued'
        AND NEW.status = 'canceled'
        AND NEW.error = 'canceled_by_shutdown'
      BEGIN
        SELECT RAISE(ABORT, 'injected sandbox shutdown cancel failure');
      END;
    `);
  } finally {
    await injector.close();
  }

  executor.enqueue(failedRunId);
  executor.enqueue(siblingRunId);
  assert.equal(executor.healthSnapshot().queue_depth, 2);
  const shutdown = executor.shutdown();
  await assert.rejects(within(shutdown, "failed sandbox shutdown", 5_000), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(flattenErrorMessages(error), /injected sandbox shutdown cancel failure/u);
    return true;
  });

  const [failed, sibling] = await Promise.all([
    sandboxStore.withClient((access) => access.getRun({
      id: failedRunId,
      tenantId: "default",
      scope: "default",
    })),
    sandboxStore.withClient((access) => access.getRun({
      id: siblingRunId,
      tenantId: "default",
      scope: "default",
    })),
  ]);
  assert.equal(failed?.status, "queued");
  assert.equal(failed?.finished_at, null);
  assert.equal(sibling?.status, "canceled");
  assert.equal(sibling?.error, "canceled_by_shutdown");
  assert.equal(sibling?.result_json?.canceled_by, "shutdown");
  assert.equal(sibling?.finished_at === null, false);
});

test("sandbox shutdown preserves a prior durable request cancellation cause", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aionis-sandbox-shutdown-request-cause-"));
  const store = createLiteRuntimeStore(join(root, "authority", "runtime.sqlite"));
  const sandboxStore = createSandboxStore(store);
  const runId = randomUUID();
  const executor = createShutdownTestSandboxExecutor(sandboxStore, root);
  t.after(async () => await cleanupShutdownTestFixture({ root, store, executor }));
  await insertShutdownTestSandboxRun({
    sandboxStore,
    runId,
    argv: [process.execPath, "-e", "process.exit(0)"],
    mode: "sync",
  });
  await sandboxStore.withTx((access) => access.requestCancel({
    id: runId,
    tenantId: "default",
    scope: "default",
    reason: "requested before activation",
  }));

  const execution = executor.executeSync(runId);
  const shutdown = executor.shutdown();
  await within(Promise.all([execution, shutdown]), "request-first sandbox shutdown", 5_000);
  const terminal = await sandboxStore.withClient((access) => access.getRun({
    id: runId,
    tenantId: "default",
    scope: "default",
  }));
  assert.equal(terminal?.status, "canceled");
  assert.equal(terminal?.error, "canceled_before_execution");
  assert.equal(terminal?.result_json?.canceled_by, "request");
  assert.equal(terminal?.result_json?.stage, "pre_start");
});

test("sandbox timeout remains the first terminal cause when shutdown follows", {
  skip: process.platform === "win32" ? "POSIX child signal contract" : false,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aionis-sandbox-shutdown-timeout-cause-"));
  const store = createLiteRuntimeStore(join(root, "authority", "runtime.sqlite"));
  const sandboxStore = createSandboxStore(store);
  const runId = randomUUID();
  const executor = createShutdownTestSandboxExecutor(sandboxStore, root);
  t.after(async () => await cleanupShutdownTestFixture({ root, store, executor }));
  await insertShutdownTestSandboxRun({
    sandboxStore,
    runId,
    argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
    mode: "sync",
    timeoutMs: 100,
  });
  const execution = executor.executeSync(runId);
  const activeDeadline = Date.now() + 5_000;
  while (executor.healthSnapshot().active_runs !== 1 && Date.now() < activeDeadline) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5));
  }
  assert.equal(executor.healthSnapshot().active_runs, 1);
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
  await within(Promise.all([execution, executor.shutdown()]), "timeout-first sandbox shutdown", 5_000);

  const terminal = await sandboxStore.withClient((access) => access.getRun({
    id: runId,
    tenantId: "default",
    scope: "default",
  }));
  assert.equal(terminal?.status, "timeout");
  assert.equal(terminal?.error, "execution_timeout");
  assert.equal(terminal?.result_json?.timed_out, true);
  assert.equal(terminal?.result_json?.canceled, false);
});

test("sandbox shutdown aborts a real active remote request before store close", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aionis-sandbox-remote-shutdown-"));
  const store = createLiteRuntimeStore(join(root, "authority", "runtime.sqlite"));
  const sandboxStore = createSandboxStore(store);
  const requestSeen = deferred();
  const sockets = new Set<net.Socket>();
  const server = createHttpServer((request) => {
    request.resume();
    requestSeen.resolve();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let executor: SandboxExecutor | null = null;
  t.after(async () => await cleanupShutdownTestFixture({ root, store, executor, server, sockets }));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  executor = createShutdownTestSandboxExecutor(
    sandboxStore,
    root,
    `http://127.0.0.1:${address.port}/execute`,
  );
  const runId = randomUUID();
  await insertShutdownTestSandboxRun({
    sandboxStore,
    runId,
    argv: [process.execPath, "-e", "process.exit(0)"],
    mode: "sync",
  });
  const execution = executor.executeSync(runId);
  await within(requestSeen.promise, "remote sandbox request start", 5_000);
  await within(Promise.all([execution, executor.shutdown()]), "remote sandbox shutdown", 5_000);
  await within(waitForNoSockets(sockets), "remote sandbox transport drain", 5_000);

  const terminal = await sandboxStore.withClient((access) => access.getRun({
    id: runId,
    tenantId: "default",
    scope: "default",
  }));
  assert.equal(terminal?.status, "canceled");
  assert.equal(terminal?.error, "canceled_by_shutdown");
  assert.equal(terminal?.result_json?.canceled_by, "shutdown");
  assert.equal(terminal?.finished_at === null, false);
  assert.equal(sockets.size, 0);
});

test("sandbox shutdown seals a pre-active remote run before any request is sent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aionis-sandbox-remote-shutdown-seal-"));
  const store = createLiteRuntimeStore(join(root, "authority", "runtime.sqlite"));
  const sandboxStore = createSandboxStore(store);
  const sockets = new Set<net.Socket>();
  let requestCount = 0;
  const server = createHttpServer((request, response) => {
    requestCount += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "succeeded", exit_code: 0 }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let executor: SandboxExecutor | null = null;
  t.after(async () => await cleanupShutdownTestFixture({ root, store, executor, server, sockets }));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  executor = createShutdownTestSandboxExecutor(
    sandboxStore,
    root,
    `http://127.0.0.1:${address.port}/execute`,
  );
  const runId = randomUUID();
  await insertShutdownTestSandboxRun({
    sandboxStore,
    runId,
    argv: [process.execPath, "-e", "process.exit(0)"],
    mode: "sync",
  });

  const execution = executor.executeSync(runId);
  const shutdown = executor.shutdown();
  await within(Promise.all([execution, shutdown]), "pre-active remote sandbox shutdown", 5_000);
  const terminal = await sandboxStore.withClient((access) => access.getRun({
    id: runId,
    tenantId: "default",
    scope: "default",
  }));
  assert.equal(terminal?.status, "canceled");
  assert.equal(terminal?.error, "canceled_by_shutdown");
  assert.equal(terminal?.result_json?.canceled_by, "shutdown");
  assert.equal(terminal?.result_json?.stage, "shutdown_before_activation");
  assert.equal(requestCount, 0);
});

async function findFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate test port")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function childClose(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
}

test("real Runtime drains on SIGTERM and leaves a reopenable authority database", {
  skip: process.platform === "win32" ? "POSIX SIGTERM and mode contract" : false,
  timeout: 45_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-runtime-sigterm-"));
  const writeDirectory = join(root, "write");
  const replayDirectory = join(root, "replay");
  const writePath = join(writeDirectory, "runtime.sqlite");
  const replayPath = join(replayDirectory, "replay.sqlite");
  const port = await findFreePort();
  let child: ChildProcessWithoutNullStreams | null = null;
  let logs = "";
  try {
    child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        AIONIS_EDITION: "lite",
        AIONIS_MODE: "local",
        AIONIS_LISTEN_HOST: "127.0.0.1",
        APP_ENV: "dev",
        EMBEDDING_PROVIDER: "none",
        LITE_REPLAY_SQLITE_PATH: replayPath,
        LITE_WRITE_SQLITE_PATH: writePath,
        MEMORY_AUTH_MODE: "off",
        PORT: String(port),
        SANDBOX_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = childClose(child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });

    const readyDeadline = Date.now() + 25_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Runtime is still starting.
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
    assert.equal(ready, true, `Runtime did not become ready:\n${logs.slice(-4_000)}`);

    for (const directory of [writeDirectory, replayDirectory]) {
      assert.equal(mode(directory), 0o700);
    }
    for (const databasePath of [writePath, replayPath]) {
      for (const artifact of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        assert.equal(existsSync(artifact), true, `${artifact} should be live before SIGTERM`);
        assert.equal(mode(artifact), 0o600, `${artifact} should be owner-only`);
      }
    }

    assert.equal(child.kill("SIGTERM"), true);
    const exit = await within(closed, "Runtime SIGTERM exit", 15_000);
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
    assert.match(logs, /draining Runtime before shutdown/u);

    const reopened = createLiteRuntimeDatabase(writePath);
    try {
      const integrity = reopened.db.prepare<{ integrity_check: string }>(
        "PRAGMA integrity_check",
      ).get();
      assert.equal(integrity.integrity_check, "ok");
    } finally {
      await reopened.close();
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
  }
});
