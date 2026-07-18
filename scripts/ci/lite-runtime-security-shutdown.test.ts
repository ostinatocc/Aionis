import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { SandboxExecutor } from "../../src/memory/sandbox-executor.js";
import { createSandboxStore } from "../../src/store/sandbox-access.js";
import {
  createLiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.js";
import { createLiteRuntimeStore } from "../../src/store/lite-runtime-store.js";
import {
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

test("Lite Runtime SQLite makes an existing data directory and all live artifacts owner-only", {
  skip: process.platform === "win32" ? "POSIX mode bits are not a Windows ACL" : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-runtime-permissions-"));
  const directory = join(root, "authority");
  const databasePath = join(directory, "runtime.sqlite");
  try {
    preparePrivateRuntimeSqlitePath(databasePath);
    chmodSync(directory, 0o755);
    chmodSync(databasePath, 0o644);

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

test("sandbox shutdown cancels and waits for a real active child before the store closes", {
  skip: process.platform === "win32" ? "POSIX child signal contract" : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-sandbox-shutdown-"));
  const store = createLiteRuntimeStore(join(root, "authority", "runtime.sqlite"));
  const sandboxStore = createSandboxStore(store);
  const runId = randomUUID();
  try {
    const session = await sandboxStore.withTx((access) => access.createSession({
      tenantId: "default",
      scope: "default",
      profile: "default",
      metadataJson: "{}",
      expiresAt: null,
    }));
    await sandboxStore.withTx((access) => access.insertRun({
      id: runId,
      sessionId: session.id,
      tenantId: "default",
      scope: "default",
      projectId: null,
      plannerRunId: null,
      decisionId: null,
      actionJson: JSON.stringify({
        argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
      }),
      mode: "sync",
      timeoutMs: 30_000,
      metadataJson: "{}",
    }));
    const executor = new SandboxExecutor(sandboxStore, {
      enabled: true,
      mode: "local_process",
      maxConcurrency: 1,
      defaultTimeoutMs: 30_000,
      stdioMaxBytes: 64 * 1024,
      workdir: root,
      allowedCommands: new Set([process.execPath]),
      remote: {
        url: null,
        authHeader: "authorization",
        authToken: "",
        timeoutMs: 30_000,
        allowedHosts: new Set(),
        allowedEgressCidrs: new Set(),
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
    const execution = executor.executeSync(runId);

    const runningDeadline = Date.now() + 5_000;
    let running = false;
    while (Date.now() < runningDeadline) {
      const row = await sandboxStore.withClient((access) => access.getRun({
        id: runId,
        tenantId: "default",
        scope: "default",
      }));
      if (row?.status === "running") {
        running = true;
        break;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
    }
    assert.equal(running, true);

    await within(executor.shutdown(), "sandbox shutdown", 5_000);
    await within(execution, "sandbox execution finalization", 5_000);
    const terminal = await sandboxStore.withClient((access) => access.getRun({
      id: runId,
      tenantId: "default",
      scope: "default",
    }));
    assert.equal(terminal?.status, "canceled");
    assert.equal(terminal?.finished_at === null, false);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
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
