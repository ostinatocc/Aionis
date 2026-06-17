import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntimeServices } from "../../src/app/runtime-services.ts";
import { loadEnv, type Env } from "../../src/config.ts";
import { createHttpApp, registerBootstrapLifecycle } from "../../src/server/bootstrap.ts";
import { registerHealthRoute, registerRuntimeErrorHandler } from "../../src/server/http-server.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claim-ledger-product-"));
  return path.join(dir, `${name}.sqlite`);
}

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

async function liteEnv(writePath: string, replayPath: string): Promise<Env> {
  return withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      MEMORY_AUTH_MODE: "off",
      MEMORY_TENANT_ID: "claim-ledger-tenant",
      MEMORY_SCOPE: "claim-ledger/default",
      LITE_LOCAL_ACTOR_ID: "claim-ledger-local",
      LITE_WRITE_SQLITE_PATH: writePath,
      LITE_REPLAY_SQLITE_PATH: replayPath,
      SANDBOX_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      AUTO_TOPIC_CLUSTER_ON_WRITE: "false",
      WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: "false",
    },
    () => loadEnv(),
  );
}

test("claim ledger is wired into Runtime services and health", async () => {
  const writePath = tmpDbPath("write");
  const replayPath = tmpDbPath("replay");
  const env = await liteEnv(writePath, replayPath);
  const services = await createRuntimeServices(env);
  const app = createHttpApp(env);
  registerRuntimeErrorHandler(app);
  registerHealthRoute({
    app,
    env,
    liteReplayStore: services.liteReplayStore,
    liteRecallStore: services.liteRecallStore,
    liteWriteStore: services.liteWriteStore,
    liteClaimLedgerStore: services.liteClaimLedgerStore,
    executionStateStore: services.executionStateStore,
    executionTreeStore: services.executionTreeStore,
    sandboxExecutor: services.sandboxExecutor,
    sandboxTenantBudgetPolicy: services.sandboxTenantBudgetPolicy,
    sandboxRemoteAllowedCidrs: services.sandboxRemoteAllowedCidrs,
  });
  registerBootstrapLifecycle({
    app,
    store: services.store,
    sandboxExecutor: services.sandboxExecutor,
    liteRecallStore: services.liteRecallStore,
    liteReplayStore: services.liteReplayStore,
    liteWriteStore: services.liteWriteStore,
    liteClaimLedgerStore: services.liteClaimLedgerStore,
    executionStateStore: services.executionStateStore,
    executionTreeStore: services.executionTreeStore,
  });

  try {
    const claim = await services.claimLedgerAccess.writeClaim({
      scope: env.MEMORY_SCOPE,
      tenantId: env.MEMORY_TENANT_ID,
      now: "2026-06-17T01:00:00.000Z",
      claim: {
        contract_version: "aionis_claim_write_v1",
        client_id: "claim:runtime:wiring:status",
        subject_key: "project:aionis",
        predicate: "claim_ledger_runtime_status",
        slot_key: "project:aionis.claim_ledger_runtime_status",
        value: { status: "wired" },
        value_text: "wired",
        claim_kind: "ordinary_fact",
        conflict_policy: "singleton_latest",
        authority: "advisory",
        confidence: 0.9,
        evidence_refs: ["runtime://claim-ledger/wiring-test"],
      },
    });

    const live = await services.claimLedgerAccess.findLiveClaims({
      scope: env.MEMORY_SCOPE,
      slotKey: "project:aionis.claim_ledger_runtime_status",
      limit: 10,
    });
    assert.deepEqual(live.rows.map((row) => row.claim_id), [claim.claim_id]);

    const ready = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(ready.statusCode, 200, ready.body);
    const readyBody = ready.json() as Record<string, any>;
    assert.equal(readyBody.checks.claim_ledger_store, true);

    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200, health.body);
    const healthBody = health.json() as Record<string, any>;
    assert.equal(healthBody.lite.stores.claim_ledger.mode, "sqlite_claim_ledger_v1");
    assert.equal(healthBody.lite.stores.claim_ledger.path_configured, true);
  } finally {
    await app.close();
  }
});
