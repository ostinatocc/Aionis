import test from "node:test";
import assert from "node:assert/strict";
import { TEST_AUTHORITY_RECEIPT_ENV } from "./authority-fixture-helpers.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { loadEnv, type Env } from "../../src/config.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";
import { HttpError } from "../../src/util/http.ts";

async function withIsolatedEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env;
  const next: NodeJS.ProcessEnv = {
    PATH: previous.PATH ?? "",
    HOME: previous.HOME ?? "",
    TMPDIR: previous.TMPDIR ?? "",
    USER: previous.USER ?? "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) next[key] = value;
  }
  process.env = next;
  try {
    return await fn();
  } finally {
    process.env = previous;
  }
}

function makeGate(): InflightGate {
  return new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 1000 });
}

function makeGuards(env: Env) {
  return createRequestGuards({
    env,
    embedder: null,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: makeGate(),
    writeInflightGate: makeGate(),
  });
}

async function makeServerEnv(overrides: Record<string, string | undefined> = {}): Promise<Env> {
  return withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "api_key",
      MEMORY_API_KEYS_JSON: JSON.stringify({
        "dev-key": {
          tenant_id: "tenant-a",
          agent_id: "agent-a",
          team_id: "team-a",
          role: "developer",
        },
      }),
      SANDBOX_ENABLED: "false",
      ...TEST_AUTHORITY_RECEIPT_ENV,
      ...overrides,
    },
    () => loadEnv(),
  );
}

test("lite request guards still reject auth modes other than off", async () => {
  await withIsolatedEnv({}, () => {
    const env = {
      ...loadEnv(),
      MEMORY_AUTH_MODE: "api_key",
    } as Env;
    assert.throws(
      () => makeGuards(env),
      /aionis-lite request guards only support MEMORY_AUTH_MODE=off/i,
    );
  });
});

test("server request guards accept api key mode", async () => {
  const env = await makeServerEnv();
  const guards = makeGuards(env);
  assert.ok(guards);
});

test("server request guards reject missing credentials", async () => {
  const env = await makeServerEnv();
  const guards = makeGuards(env);
  await assert.rejects(
    () => guards.requireMemoryPrincipal({ headers: {} }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.statusCode, 401);
      assert.equal(err.code, "unauthorized");
      return true;
    },
  );
});

test("server request guards resolve api key principal", async () => {
  const env = await makeServerEnv();
  const guards = makeGuards(env);
  const principal = await guards.requireMemoryPrincipal({ headers: { "x-api-key": "dev-key" } });
  assert.equal(principal?.tenant_id, "tenant-a");
  assert.equal(principal?.agent_id, "agent-a");
  assert.equal(principal?.team_id, "team-a");
  assert.equal(principal?.role, "developer");
  assert.equal(principal?.source, "api_key");
});

test("server request guards allow auth-off only under explicit development posture", async () => {
  const env = await makeServerEnv({
    APP_ENV: "dev",
    MEMORY_AUTH_MODE: "off",
    AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV: "true",
    TENANT_QUOTA_ENABLED: "false",
  });
  const guards = makeGuards(env);
  const principal = await guards.requireMemoryPrincipal({ headers: {} });
  assert.equal(principal, null);
});

test("server request guards enforce tenant quota by tenant id", async () => {
  const env = await makeServerEnv({
    TENANT_RECALL_RATE_LIMIT_RPS: "0.001",
    TENANT_RECALL_RATE_LIMIT_BURST: "1",
  });
  const guards = makeGuards(env);
  const reply = {
    headers: new Map<string, unknown>(),
    header(name: string, value: unknown) {
      this.headers.set(name, value);
    },
  };

  await guards.enforceTenantQuota({}, reply, "recall", "tenant-a");
  await assert.rejects(
    () => guards.enforceTenantQuota({}, reply, "recall", "tenant-a"),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.statusCode, 429);
      assert.equal(err.code, "tenant_quota_exceeded_recall");
      return true;
    },
  );
  await guards.enforceTenantQuota({}, reply, "recall", "tenant-b");
});
