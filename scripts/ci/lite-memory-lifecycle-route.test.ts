import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { prepareMemoryWrite, applyMemoryWrite } from "../../src/memory/write.ts";
import { registerLiteMemoryLifecycleRoutes } from "../../src/routes/memory-lifecycle-lite.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-lifecycle-route-"));
  return path.join(dir, `${name}.sqlite`);
}

async function seedLifecycleFixture(store: ReturnType<typeof createLiteWriteStore>) {
  const archivedNodeId = randomUUID();
  const activatedNodeId = randomUUID();
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    input_text: "seed lifecycle fixture",
    nodes: [
      {
        id: archivedNodeId,
        type: "procedure",
        tier: "archive",
        memory_lane: "private",
        owner_agent_id: "local-user",
        title: "Archived workflow candidate",
        text_summary: "Rehydrate this archived workflow when the task returns",
        slots: {
          lifecycle_state: "archived",
        },
      },
      {
        id: activatedNodeId,
        type: "procedure",
        tier: "warm",
        memory_lane: "private",
        owner_agent_id: "local-user",
        title: "Recently reused workflow",
        text_summary: "Apply this workflow when the export route fails",
        slots: {
          continuity_marker_v1: {
            workflow_signature: "workflow:export-route-repair",
            source: "lifecycle-route-fixture",
          },
          summary_kind: "workflow_anchor",
        },
      },
    ],
    edges: [],
  }, "default", "default", {
    maxTextLen: 10000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
  }, null);

  await store.withTx(() => applyMemoryWrite(prepared, {
    maxTextLen: 10000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
    write_access: store,
  }));

  return { archivedNodeId, activatedNodeId };
}

function buildRequestGuards() {
  return createRequestGuards({
    env: {
      AIONIS_EDITION: "lite",
      MEMORY_AUTH_MODE: "off",
      TENANT_QUOTA_ENABLED: false,
      LITE_LOCAL_ACTOR_ID: "local-user",
      MEMORY_TENANT_ID: "default",
      MEMORY_SCOPE: "default",
      APP_ENV: "test",
      ADMIN_TOKEN: "",
      TRUST_PROXY: false,
      TRUSTED_PROXY_CIDRS: [],
      RATE_LIMIT_ENABLED: false,
      RATE_LIMIT_BYPASS_LOOPBACK: false,
      WRITE_RATE_LIMIT_MAX_WAIT_MS: 0,
    } as any,
    embedder: null,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });
}

test("lite memory lifecycle routes can rehydrate archived nodes into active tiers", async () => {
  const app = Fastify();
  const store = createLiteWriteStore(tmpDbPath("rehydrate"));
  try {
    const fixture = await seedLifecycleFixture(store);
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    registerLiteMemoryLifecycleRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10000,
        PII_REDACTION: false,
      } as any,
      liteWriteStore: store,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/archive/rehydrate",
      payload: {
        node_ids: [fixture.archivedNodeId],
        target_tier: "hot",
        reason: "task returned to active queue",
        input_text: "restore archived workflow for the same repair family",
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.target_tier, "hot");
    assert.equal(body.rehydrated.moved_nodes, 1);
    assert.deepEqual(body.rehydrated.moved_ids, [fixture.archivedNodeId]);

    const { rows } = await store.findNodes({
      scope: "default",
      id: fixture.archivedNodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.tier, "hot");
    assert.equal(rows[0]?.slots.last_rehydrated_job, "archive_rehydrate");
    assert.equal(rows[0]?.slots.last_rehydrated_to_tier, "hot");
    assert.equal(rows[0]?.slots.semantic_forgetting_v1?.current_tier, "hot");
    assert.equal(rows[0]?.slots.archive_relocation_v1?.relocation_state, "none");
  } finally {
    await app.close();
    await store.close();
  }
});

test("lite memory lifecycle routes can record activation feedback on nodes", async () => {
  const app = Fastify();
  const store = createLiteWriteStore(tmpDbPath("activate"));
  try {
    const fixture = await seedLifecycleFixture(store);
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    registerLiteMemoryLifecycleRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10000,
        PII_REDACTION: false,
      } as any,
      liteWriteStore: store,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/nodes/activate",
      payload: {
        node_ids: [fixture.activatedNodeId],
        run_id: "run-lifecycle-activate-1",
        outcome: "positive",
        activate: true,
        reason: "workflow reused successfully",
        input_text: "confirm successful reuse for the same export fix path",
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.activated.updated_nodes, 1);
    assert.equal(body.activated.outcome, "positive");
    assert.equal(body.activated.activate, true);

    const { rows } = await store.findNodes({
      scope: "default",
      id: fixture.activatedNodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.feedback_positive, 1);
    assert.equal(rows[0]?.slots.feedback_negative, 0);
    assert.equal(rows[0]?.slots.last_feedback_outcome, "positive");
    assert.equal(rows[0]?.slots.last_feedback_run_id, "run-lifecycle-activate-1");
    assert.deepEqual(rows[0]?.slots.continuity_marker_v1, {
      workflow_signature: "workflow:export-route-repair",
      source: "lifecycle-route-fixture",
    });
    assert.equal(rows[0]?.slots.summary_kind, "workflow_anchor");
    assert.ok(typeof rows[0]?.slots.last_activated_at === "string");
    assert.equal(rows[0]?.slots.semantic_forgetting_v1?.action, "retain");
    assert.equal(rows[0]?.slots.archive_relocation_v1?.relocation_state, "none");
  } finally {
    await app.close();
    await store.close();
  }
});
