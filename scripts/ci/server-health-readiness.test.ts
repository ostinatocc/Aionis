import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { Env } from "../../src/config.ts";
import { registerHealthRoute } from "../../src/server/http-server.ts";

function serverEnv(overrides: Partial<Env> = {}): Env {
  return {
    AIONIS_EDITION: "server",
    AIONIS_MODE: "service",
    AIONIS_RUNTIME_PACKAGE_NAME: "@aionis/runtime",
    AIONIS_RUNTIME_PACKAGE_VERSION: "0.1.0-test",
    AIONIS_RUNTIME_STARTED_AT: "2026-06-16T00:00:00.000Z",
    MEMORY_AUTH_MODE: "api_key",
    LITE_LOCAL_ACTOR_ID: "local-user",
    SANDBOX_TENANT_BUDGET_WINDOW_HOURS: 24,
    SANDBOX_REMOTE_EXECUTOR_EGRESS_DENY_PRIVATE_IPS: true,
    SANDBOX_ARTIFACT_OBJECT_STORE_BASE_URI: "",
    ...overrides,
  } as Env;
}

function store(path: string, mode = "sqlite_write_v1") {
  return {
    healthSnapshot: () => ({
      path,
      mode,
    }),
  };
}

function registerTestHealthRoute(env: Env, failingStore = false) {
  const app = Fastify();
  const provider = failingStore
    ? { healthSnapshot: () => { throw new Error("database path /tmp/secret.sqlite failed"); } }
    : store("/tmp/aionis-secret/aionis-lite-write.sqlite");
  registerHealthRoute({
    app,
    env,
    liteRecallStore: provider,
    liteWriteStore: provider,
    executionStateStore: provider,
    executionTreeStore: provider,
    liteReplayStore: provider,
    sandboxExecutor: {
      healthSnapshot: () => ({ enabled: false, mode: "disabled" }),
    },
    sandboxTenantBudgetPolicy: new Map([["tenant-a", {}]]),
    sandboxRemoteAllowedCidrs: new Set(["10.0.0.0/8"]),
  });
  return app;
}

test("/healthz returns hosted-safe liveness metadata", async () => {
  const app = registerTestHealthRoute(serverEnv());
  const response = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(response.statusCode, 200);
  const body = response.json() as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.edition, "server");
  assert.equal(body.mode, "service");
  assert.equal(body.storage_backend, "lite_sqlite");
  assert.equal(body.auth_mode, "api_key");
  assert.equal(body.package_name, "@aionis/runtime");
  assert.equal(body.package_version, "0.1.0-test");
  assert.doesNotMatch(response.body, /aionis-secret/);
  assert.doesNotMatch(response.body, /aionis-lite-write\.sqlite/);
  assert.doesNotMatch(response.body, /\/tmp\//);
  assert.doesNotMatch(response.body, /api-key|dev-key|secret/i);
  await app.close();
});

test("/readyz returns hosted-safe readiness checks without paths", async () => {
  const app = registerTestHealthRoute(serverEnv());
  const response = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    ok: boolean;
    ready: boolean;
    checks: Record<string, boolean>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.ready, true);
  assert.equal(body.checks.recall_store, true);
  assert.equal(body.checks.write_store, true);
  assert.equal(body.checks.execution_state_store, true);
  assert.equal(body.checks.execution_tree_store, true);
  assert.equal(body.checks.replay_store, true);
  assert.equal(body.checks.sandbox, true);
  assert.doesNotMatch(response.body, /aionis-secret/);
  assert.doesNotMatch(response.body, /aionis-lite-write\.sqlite/);
  await app.close();
});

test("/readyz returns 503 when a readiness dependency throws and redacts details", async () => {
  const app = registerTestHealthRoute(serverEnv(), true);
  const response = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(response.statusCode, 503);
  const body = response.json() as {
    ok: boolean;
    ready: boolean;
    checks: Record<string, boolean>;
  };
  assert.equal(body.ok, false);
  assert.equal(body.ready, false);
  assert.equal(body.checks.recall_store, false);
  assert.doesNotMatch(response.body, /secret\.sqlite/);
  assert.doesNotMatch(response.body, /database path/);
  await app.close();
});
