import test from "node:test";
import assert from "node:assert/strict";
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

async function makeServerEnv(): Promise<Env> {
  return withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "api_key",
      MEMORY_API_KEYS_JSON: JSON.stringify({
        "tenant-a-key": {
          tenant_id: "tenant-a",
          agent_id: "agent-a",
          team_id: "team-a",
          role: "developer",
          default_scope: "tenant-a/default",
          allowed_scopes: ["tenant-a/default", "shared-demo"],
        },
      }),
      SANDBOX_ENABLED: "false",
    },
    () => loadEnv(),
  );
}

async function authorizedBody(input: Record<string, unknown>, headers: Record<string, string> = {}) {
  const env = await makeServerEnv();
  const guards = makeGuards(env);
  const req = {
    headers: {
      "x-api-key": "tenant-a-key",
      ...headers,
    },
  };
  const principal = await guards.requireMemoryPrincipal(req);
  return guards.withIdentityFromRequest(req, input, principal, "recall") as Record<string, unknown>;
}

test("server principal injects tenant and default scope when omitted", async () => {
  const body = await authorizedBody({ query_text: "continue" });
  assert.equal(body.tenant_id, "tenant-a");
  assert.equal(body.scope, "tenant-a/default");
});

test("server principal allows scopes under its tenant prefix", async () => {
  const body = await authorizedBody({ tenant_id: "tenant-a", scope: "tenant-a/project-1", query_text: "continue" });
  assert.equal(body.tenant_id, "tenant-a");
  assert.equal(body.scope, "tenant-a/project-1");
});

test("server principal allows explicitly listed shared scopes", async () => {
  const body = await authorizedBody({ scope: "shared-demo", query_text: "continue" });
  assert.equal(body.tenant_id, "tenant-a");
  assert.equal(body.scope, "shared-demo");
});

test("server principal rejects body tenant override", async () => {
  await assert.rejects(
    () => authorizedBody({ tenant_id: "tenant-b", scope: "tenant-a/project-1", query_text: "continue" }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "tenant_forbidden");
      return true;
    },
  );
});

test("server principal rejects x-tenant-id header override", async () => {
  await assert.rejects(
    () => authorizedBody({ scope: "tenant-a/project-1", query_text: "continue" }, { "x-tenant-id": "tenant-b" }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "tenant_forbidden");
      return true;
    },
  );
});

test("server principal rejects cross-tenant scope", async () => {
  await assert.rejects(
    () => authorizedBody({ tenant_id: "tenant-a", scope: "tenant-b/project-1", query_text: "continue" }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "scope_forbidden");
      return true;
    },
  );
});

test("server principal rejects tenant override inside slots", async () => {
  await assert.rejects(
    () => authorizedBody({
      tenant_id: "tenant-a",
      scope: "tenant-a/project-1",
      query_text: "continue",
      slots: { tenant_id: "tenant-b" },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "tenant_forbidden");
      return true;
    },
  );
});
