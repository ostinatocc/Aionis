import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { authorityArtifactPublicKeySha256 } from
  "../../src/continuation/authority-artifact.js";
import {
  composeContinuationRuntimeV1Daemon,
  startContinuationRuntimeV1Daemon,
} from "../../src/runtime-v1/daemon-composition.js";
import { openContinuationRuntimeV1Database } from
  "../../src/store/continuation-runtime-v1-database.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENTRY = fileURLToPath(
  new URL("../../src/runtime-v1/daemon-entry.ts", import.meta.url),
);
const HOST_TOKEN = "host-token-that-is-at-least-thirty-two-bytes";
const OPERATOR_TOKEN = "operator-token-that-is-distinct-and-long";

type DaemonFixture = Readonly<{
  root: string;
  dataPath: string;
  trustRootPath: string;
  environment: Readonly<Record<string, string>>;
  cleanup(): void;
}>;

function daemonFixture(port: number): DaemonFixture {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-daemon-"));
  const trustRootPath = join(root, "authority-root.pem");
  const dataPath = join(root, "data", "runtime.sqlite");
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(
    trustRootPath,
    pair.publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o600 },
  );
  return {
    root,
    dataPath,
    trustRootPath,
    environment: Object.freeze({
      AIONIS_DATA_PATH: dataPath,
      AIONIS_HOST_API_KEY: HOST_TOKEN,
      AIONIS_HOST_PRINCIPAL_ID: "trusted-host-a",
      AIONIS_HTTP_BODY_LIMIT_BYTES: "1048576",
      AIONIS_HTTP_HOST: "127.0.0.1",
      AIONIS_HTTP_PORT: String(port),
      AIONIS_LOG_LEVEL: "info",
      AIONIS_OPERATOR_API_KEY: OPERATOR_TOKEN,
      AIONIS_OPERATOR_PRINCIPAL_ID: "operator-a",
      AIONIS_SHUTDOWN_TIMEOUT_MS: "10000",
      AIONIS_TENANT_ID: "tenant-a",
      AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: trustRootPath,
      AIONIS_TRUST_ROOT_SHA256:
        authorityArtifactPublicKeySha256(pair.publicKey),
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function reserveUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await closeServer(server);
  return port;
}

async function occupiedPort(): Promise<Readonly<{ server: Server; port: number }>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

function childClose(child: ChildProcessWithoutNullStreams): Promise<Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout:${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanChildEnvironment(
  fixture: DaemonFixture,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AIONIS_")),
  );
  return { ...inherited, NODE_NO_WARNINGS: "1", ...fixture.environment };
}

function localTypeScriptClosure(entryPaths: readonly string[]): readonly string[] {
  const pending = [...entryPaths];
  const visited = new Set<string>();
  const importPattern = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const source = readFileSync(current, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!;
      const target = resolve(
        dirname(current),
        specifier.endsWith(".js")
          ? `${specifier.slice(0, -3)}.ts`
          : specifier,
      );
      if (existsSync(target) && !visited.has(target)) pending.push(target);
    }
  }
  return [...visited].sort();
}

test("fresh authority DB composes the real daemon and remains explicitly unready", async () => {
  const fixture = daemonFixture(await reserveUnusedPort());
  let daemon: Awaited<ReturnType<typeof composeContinuationRuntimeV1Daemon>> | null = null;
  try {
    daemon = await composeContinuationRuntimeV1Daemon(fixture.environment);
    assert.equal(daemon.server.server.address(), null);

    const health = await daemon.server.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), {
      schema_version: "continuation_runtime_health_v1",
      status: "alive",
    });

    const readiness = await daemon.server.inject({ method: "GET", url: "/readyz" });
    assert.equal(readiness.statusCode, 503);
    assert.deepEqual(readiness.json(), {
      schema_version: "continuation_runtime_readiness_v1",
      status: "not_ready",
      reason_codes: ["policy_bundle_unavailable"],
    });
    assert.deepEqual(Object.keys(daemon.publicConfig).sort(), [
      "dataPathConfigured",
      "hostPrincipalIdSha256",
      "httpBodyLimitBytes",
      "httpHost",
      "httpPort",
      "logLevel",
      "operatorPrincipalIdSha256",
      "shutdownTimeoutMs",
      "tenantIdSha256",
      "trustRootPublicKeyPathConfigured",
      "trustRootSha256",
    ]);
    await Promise.all([daemon.close(), daemon.close()]);
    daemon = null;
    assert.equal(existsSync(`${fixture.dataPath}-wal`), false);
    assert.equal(existsSync(`${fixture.dataPath}-shm`), false);
  } finally {
    await daemon?.close();
    fixture.cleanup();
  }
});

test("listen failure closes the newly opened SQLite authority atomically", async () => {
  const occupied = await occupiedPort();
  const fixture = daemonFixture(occupied.port);
  try {
    await assert.rejects(
      startContinuationRuntimeV1Daemon(fixture.environment),
      /continuation_runtime_v1_daemon_listen_failed/u,
    );
    assert.equal(existsSync(fixture.dataPath), true);
    assert.equal(lstatSync(fixture.dataPath).mode & 0o7777, 0o600);
    assert.equal(existsSync(`${fixture.dataPath}-wal`), false);
    assert.equal(existsSync(`${fixture.dataPath}-shm`), false);

    const reopened = openContinuationRuntimeV1Database(fixture.dataPath);
    try {
      assert.equal(reopened.db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    } finally {
      await reopened.close();
    }
  } finally {
    await closeServer(occupied.server);
    fixture.cleanup();
  }
});

test("the executable binds only the configured endpoint and SIGTERM drains once", {
  skip: process.platform === "win32" ? "POSIX signal contract" : false,
  timeout: 30_000,
}, async () => {
  const fixture = daemonFixture(await reserveUnusedPort());
  let child: ChildProcessWithoutNullStreams | null = null;
  let stdout = "";
  let stderr = "";
  try {
    child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
      cwd: ROOT,
      env: cleanChildEnvironment(fixture),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const closed = childClose(child);

    const deadline = Date.now() + 20_000;
    let health: Response | null = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const response = await fetch(
          `http://127.0.0.1:${fixture.environment.AIONIS_HTTP_PORT}/healthz`,
          { signal: AbortSignal.timeout(1_000) },
        );
        if (response.ok) {
          health = response;
          break;
        }
      } catch {
        // The configured listener is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(health, `daemon did not answer healthz:\n${stdout}\n${stderr}`);
    assert.deepEqual(await health.json(), {
      schema_version: "continuation_runtime_health_v1",
      status: "alive",
    });

    assert.equal(child.kill("SIGTERM"), true);
    const exit = await within(closed, "daemon SIGTERM exit", 10_000);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(stderr, "");

    const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0].event, "listening");
    assert.equal(
      events[0].public_config.httpPort,
      Number(fixture.environment.AIONIS_HTTP_PORT),
    );
    assert.equal(events[1].event, "shutdown_complete");
    assert.deepEqual(events[1].shutdown, {
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
    const logs = JSON.stringify(events);
    for (const secret of [
      HOST_TOKEN,
      OPERATOR_TOKEN,
      "tenant-a",
      "trusted-host-a",
      "operator-a",
      fixture.dataPath,
      fixture.trustRootPath,
    ]) {
      assert.equal(logs.includes(secret), false);
    }
    assert.equal(existsSync(`${fixture.dataPath}-wal`), false);
    assert.equal(existsSync(`${fixture.dataPath}-shm`), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await childClose(child).catch(() => undefined);
    }
    fixture.cleanup();
  }
});

test("daemon source closure cannot load worker credentials or signing keys", () => {
  const compositionPath = fileURLToPath(
    new URL("../../src/runtime-v1/daemon-composition.ts", import.meta.url),
  );
  const closure = localTypeScriptClosure([compositionPath, ENTRY]);
  for (const forbidden of [
    "effect-signer.ts",
    "provisioning.ts",
    "worker-config.ts",
    "worker-identity.ts",
    "worker-service.ts",
  ]) {
    assert.equal(
      closure.some((path) => path.endsWith(`/runtime-v1/${forbidden}`)),
      false,
      `daemon closure imported ${forbidden}`,
    );
  }
  assert.equal(
    closure.some((path) => path.endsWith(
      "/store/continuation-runtime-v1-effect-certificate-writer.ts",
    )),
    false,
    "daemon closure imported the effect certificate writer",
  );
  for (const path of closure) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /AIONIS_(?:EFFECT|EMBEDDING|PROVIDER).*PRIVATE_KEY/u);
  }
});
