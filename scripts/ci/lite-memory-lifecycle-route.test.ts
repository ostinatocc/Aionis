import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareMemoryWrite, applyMemoryWrite } from "../../src/memory/write.ts";
import { createProductLifecycleService } from "../../src/product/lifecycle-service.ts";
import { ProductForgetRequest } from "../../src/product/product-services.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

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
            workflow_signature: "workflow:durable-validation-recovery",
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

function createLifecycleService(store: ReturnType<typeof createLiteWriteStore>) {
  return createProductLifecycleService({
    env: {
      AIONIS_EDITION: "lite",
      MEMORY_SCOPE: "default",
      MEMORY_TENANT_ID: "default",
      LITE_LOCAL_ACTOR_ID: "local-user",
      MAX_TEXT_LEN: 10000,
      PII_REDACTION: false,
    } as any,
    liteWriteStore: store,
  });
}

test("product lifecycle service can rehydrate archived nodes into active tiers", async () => {
  const store = createLiteWriteStore(tmpDbPath("rehydrate"));
  try {
    const fixture = await seedLifecycleFixture(store);
    const service = createLifecycleService(store);
    const response = await service.execute(
      ProductForgetRequest.parse({
        operation: "rehydrate",
        target: "archive",
        node_ids: [fixture.archivedNodeId],
        target_tier: "hot",
        reason: "task returned to active queue",
        payload: {
          input_text: "restore archived workflow for the same repair family",
        },
      }),
      "rehydrate",
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.statusCode, 200);
    const body = response.body as any;
    assert.equal(body.result.target_tier, "hot");
    assert.equal(body.result.rehydrated.moved_nodes, 1);
    assert.deepEqual(body.result.rehydrated.moved_ids, [fixture.archivedNodeId]);

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
    await store.close();
  }
});

test("product lifecycle service can record activation feedback on nodes", async () => {
  const store = createLiteWriteStore(tmpDbPath("activate"));
  try {
    const fixture = await seedLifecycleFixture(store);
    const service = createLifecycleService(store);
    const response = await service.execute(
      ProductForgetRequest.parse({
        operation: "activate",
        target: "memory",
        node_ids: [fixture.activatedNodeId],
        run_id: "run-lifecycle-activate-1",
        outcome: "positive",
        used_surface: "use_now",
        activate: true,
        reason: "workflow reused successfully",
        payload: {
          input_text: "confirm successful reuse for the same export fix path",
        },
      }),
      "feedback",
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.statusCode, 200);
    const body = response.body as any;
    assert.equal(body.result.activated.updated_nodes, 1);
    assert.equal(body.result.activated.outcome, "positive");
    assert.equal(body.result.activated.activate, true);

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
      workflow_signature: "workflow:durable-validation-recovery",
      source: "lifecycle-route-fixture",
    });
    assert.equal(rows[0]?.slots.summary_kind, "workflow_anchor");
    assert.ok(typeof rows[0]?.slots.last_activated_at === "string");
    assert.equal(rows[0]?.slots.semantic_forgetting_v1?.action, "retain");
    assert.equal(rows[0]?.slots.archive_relocation_v1?.relocation_state, "none");
  } finally {
    await store.close();
  }
});
