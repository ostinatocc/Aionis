import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { authorityArtifactPublicKeySha256 } from
  "../../src/continuation/authority-artifact.js";
import {
  composeContinuationRuntimeV1Worker,
  continuationRuntimeV1AnnIndexSegmentRoot,
  continuationRuntimeV1VectorArtifactRoot,
} from "../../src/runtime-v1/worker-composition.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENTRY = fileURLToPath(
  new URL("../../src/runtime-v1/worker-entry.ts", import.meta.url),
);
const PROVIDER_SECRET = "provider-key-that-must-never-cross-public-config";

type WorkerFixture = Readonly<{
  root: string;
  dataPath: string;
  environment: Readonly<Record<string, string>>;
  cleanup(): void;
}>;

function workerFixture(
  role: "embedding" | "ann" | "effect" | "retention" = "embedding",
): WorkerFixture {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-worker-composition-"));
  const trustRootPath = join(root, "authority-root.pem");
  const dataPath = join(root, "data", "runtime.sqlite");
  const pair = generateKeyPairSync("ed25519");
  const effectPair = generateKeyPairSync("ed25519");
  writeFileSync(
    trustRootPath,
    pair.publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o600 },
  );
  const effectSignerPath = join(root, "effect-signer.pem");
  writeFileSync(
    effectSignerPath,
    effectPair.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const effectSpki = createPublicKey(effectPair.privateKey).export({
    type: "spki",
    format: "der",
  }) as Buffer;
  const common = {
    AIONIS_DATA_PATH: dataPath,
    AIONIS_JOB_BATCH_SIZE: "4",
    AIONIS_JOB_LEASE_MS: "5000",
    AIONIS_JOB_POLL_MS: "10",
    AIONIS_LOG_LEVEL: "info",
    AIONIS_SHUTDOWN_TIMEOUT_MS: "10000",
    AIONIS_TENANT_ID: "tenant-worker",
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: trustRootPath,
    AIONIS_TRUST_ROOT_SHA256:
      authorityArtifactPublicKeySha256(pair.publicKey),
    AIONIS_WORKER_ROLE: role,
  };
  return {
    root,
    dataPath,
    environment: Object.freeze(role === "embedding"
      ? {
          ...common,
          AIONIS_EMBEDDING_API_KEY: PROVIDER_SECRET,
          AIONIS_EMBEDDING_BASE_URL: "https://embedding.invalid/v1",
          AIONIS_EMBEDDING_DIMENSIONS: "16",
          AIONIS_EMBEDDING_MODEL: "embedding-contract-model-v1",
        }
      : role === "effect"
        ? {
            ...common,
            AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH: effectSignerPath,
            AIONIS_EFFECT_SIGNER_SHA256:
              createHash("sha256").update(effectSpki).digest("hex"),
          }
        : common),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function childEnvironment(fixture: WorkerFixture): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AIONIS_")),
  );
  return { ...inherited, NODE_NO_WARNINGS: "1", ...fixture.environment };
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("worker test wait timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("real embedding worker composition is role-confined and fully redacted", async () => {
  const fixture = workerFixture();
  let worker: Awaited<ReturnType<typeof composeContinuationRuntimeV1Worker>> | null = null;
  try {
    worker = await composeContinuationRuntimeV1Worker(fixture.environment);
    assert.equal(worker.service.workerPrincipal().worker_role, "embedding");
    assert.deepEqual(worker.publicConfig.embedding, {
      baseUrl: "https://embedding.invalid/v1",
      model: "embedding-contract-model-v1",
      dimensions: 16,
      apiKeyConfigured: true,
    });
    const projection = JSON.stringify(worker.publicConfig);
    assert.equal(projection.includes(PROVIDER_SECRET), false);
    assert.equal(projection.includes(fixture.root), false);
    assert.equal(projection.includes("tenant-worker"), false);
    assert.equal(
      continuationRuntimeV1VectorArtifactRoot(fixture.dataPath),
      `${fixture.dataPath}.vector-artifacts-v1`,
    );
    await Promise.all([worker.close(), worker.close()]);
    worker = null;
    assert.equal(existsSync(`${fixture.dataPath}-wal`), false);
    assert.equal(existsSync(`${fixture.dataPath}-shm`), false);
  } finally {
    await worker?.close();
    fixture.cleanup();
  }
});

test("real ANN worker composition has only rebuildable sidecar capabilities", async () => {
  const fixture = workerFixture("ann");
  let worker: Awaited<ReturnType<typeof composeContinuationRuntimeV1Worker>> | null = null;
  try {
    worker = await composeContinuationRuntimeV1Worker(fixture.environment);
    assert.equal(worker.service.workerPrincipal().worker_role, "ann");
    assert.equal(worker.publicConfig.embedding, null);
    assert.equal(worker.publicConfig.effect, null);
    assert.equal(
      continuationRuntimeV1AnnIndexSegmentRoot(fixture.dataPath),
      `${fixture.dataPath}.vector-artifacts-v1/index-segments-v1`,
    );
    const projection = JSON.stringify(worker.publicConfig);
    assert.equal(projection.includes(fixture.root), false);
    assert.equal(projection.includes("index-segments-v1"), false);
    assert.equal(projection.includes(PROVIDER_SECRET), false);
    await worker.close();
    worker = null;
    assert.equal(existsSync(fixture.dataPath), true);
    assert.equal(existsSync(`${fixture.dataPath}-wal`), false);
    assert.equal(existsSync(`${fixture.dataPath}-shm`), false);
  } finally {
    await worker?.close();
    fixture.cleanup();
  }
});

test("real effect worker composition owns only pinned root and dedicated signer", async () => {
  const fixture = workerFixture("effect");
  let worker: Awaited<ReturnType<typeof composeContinuationRuntimeV1Worker>> | null = null;
  try {
    worker = await composeContinuationRuntimeV1Worker(fixture.environment);
    assert.equal(worker.service.workerPrincipal().worker_role, "effect");
    assert.equal(worker.publicConfig.embedding, null);
    assert.deepEqual(worker.publicConfig.effect, {
      signerPrivateKeyPathConfigured: true,
      signerSha256: fixture.environment.AIONIS_EFFECT_SIGNER_SHA256,
    });
    const projection = JSON.stringify(worker.publicConfig);
    assert.equal(projection.includes(fixture.root), false);
    assert.equal(projection.includes("PRIVATE KEY"), false);
    assert.equal(projection.includes("tenant-worker"), false);
    assert.equal(projection.includes(PROVIDER_SECRET), false);
    await worker.close();
    worker = null;
    assert.equal(existsSync(fixture.dataPath), true);
    assert.equal(existsSync(`${fixture.dataPath}-wal`), false);
    assert.equal(existsSync(`${fixture.dataPath}-shm`), false);
  } finally {
    await worker?.close();
    fixture.cleanup();
  }
});

test("real retention worker composition can only resolve authority and delete sidecars", async () => {
  const fixture = workerFixture("retention");
  let worker: Awaited<ReturnType<typeof composeContinuationRuntimeV1Worker>> | null = null;
  try {
    worker = await composeContinuationRuntimeV1Worker(fixture.environment);
    assert.equal(worker.service.workerPrincipal().worker_role, "retention");
    assert.equal(worker.publicConfig.embedding, null);
    assert.equal(worker.publicConfig.effect, null);
    const projection = JSON.stringify(worker.publicConfig);
    assert.equal(projection.includes(fixture.root), false);
    assert.equal(projection.includes("vector-artifacts-v1"), false);
    assert.equal(projection.includes("index-segments-v1"), false);
    assert.equal(projection.includes(PROVIDER_SECRET), false);
    await worker.close();
    worker = null;
    assert.equal(existsSync(fixture.dataPath), true);
    assert.equal(existsSync(`${fixture.dataPath}-wal`), false);
    assert.equal(existsSync(`${fixture.dataPath}-shm`), false);
  } finally {
    await worker?.close();
    fixture.cleanup();
  }
});

test("worker executable polls then SIGTERM fences leases, drains, and closes SQLite", {
  skip: process.platform === "win32" ? "POSIX signal contract" : false,
  timeout: 30_000,
}, async () => {
  const fixture = workerFixture();
  let child: ChildProcessWithoutNullStreams | null = null;
  let stdout = "";
  let stderr = "";
  try {
    child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
      cwd: ROOT,
      env: childEnvironment(fixture),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const closed = childClose(child);
    await waitFor(() => stdout.includes('"event":"polling"'), 20_000);
    child.kill("SIGTERM");
    const result = await closed;
    child = null;
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, "");
    assert.match(stdout, /"event":"shutdown_complete"/u);
    assert.match(stdout, /"status":"graceful"/u);
    assert.equal(stdout.includes(PROVIDER_SECRET), false);
    assert.equal(stdout.includes(fixture.root), false);
    assert.equal(stdout.includes("tenant-worker"), false);
    assert.equal(existsSync(`${fixture.dataPath}-wal`), false);
    assert.equal(existsSync(`${fixture.dataPath}-shm`), false);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    fixture.cleanup();
  }
});
