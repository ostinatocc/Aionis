import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { Env } from "../../src/config.ts";
import { registerHealthRoute } from "../../src/server/http-server.ts";

test("/health redacts local store paths from public health snapshots", async () => {
  const app = Fastify();
  const env = {
    AIONIS_EDITION: "lite",
    AIONIS_MODE: "local",
    AIONIS_RUNTIME_PACKAGE_NAME: "",
    AIONIS_RUNTIME_PACKAGE_VERSION: "",
    AIONIS_RUNTIME_STARTED_AT: "",
    LITE_LOCAL_ACTOR_ID: "local-user",
    SANDBOX_TENANT_BUDGET_WINDOW_HOURS: 24,
    SANDBOX_REMOTE_EXECUTOR_EGRESS_DENY_PRIVATE_IPS: true,
    SANDBOX_ARTIFACT_OBJECT_STORE_BASE_URI: "",
  } as Env;
  const store = {
    healthSnapshot: () => ({
      path: "/tmp/aionis-secret/aionis-lite-write.sqlite",
      mode: "sqlite_write_v1",
    }),
  };

  registerHealthRoute({
    app,
    env,
    liteRecallStore: store,
    liteWriteStore: store,
    executionStateStore: store,
    executionTreeStore: store,
    liteReplayStore: store,
    learningControlWorker: {
      healthSnapshot: () => ({
        running: false,
        closed: false,
        last_error_code: null,
        last_terminalization_error_code: null,
        backlog: {
          pending: 2,
          leased: 0,
          expired_leases: 0,
          completed: 4,
          dead_letter: 1,
          exhausted: 0,
        },
      }),
    },
    sandboxExecutor: {
      healthSnapshot: () => ({ enabled: false, mode: "disabled" }),
    },
    sandboxTenantBudgetPolicy: new Map(),
    sandboxRemoteAllowedCidrs: new Set(),
  });

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    lite: {
      stores: {
        write: {
          path?: string;
          path_configured?: boolean;
          mode?: string;
        };
        learning_control_worker: {
          closed: boolean;
          backlog: { pending: number; dead_letter: number; exhausted: number };
        };
      };
    };
  };
  assert.equal(body.lite.stores.write.mode, "sqlite_write_v1");
  assert.equal(body.lite.stores.write.path, undefined);
  assert.equal(body.lite.stores.write.path_configured, true);
  assert.equal(body.lite.stores.learning_control_worker.closed, false);
  assert.equal(body.lite.stores.learning_control_worker.backlog.pending, 2);
  assert.equal(body.lite.stores.learning_control_worker.backlog.dead_letter, 1);
  assert.equal(body.lite.stores.learning_control_worker.backlog.exhausted, 0);
  assert.doesNotMatch(response.body, /aionis-secret/);
  assert.doesNotMatch(response.body, /aionis-lite-write\.sqlite/);

  await app.close();
});
