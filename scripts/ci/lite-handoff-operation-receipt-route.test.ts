import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { createExecutionTreeV1, type ExecutionTreeOperationV1 } from "../../src/execution/tree.ts";
import { createLiteExecutionTreeStoreFromDatabase } from "../../src/execution/tree-store.ts";
import { registerHandoffRoutes } from "../../src/routes/handoff.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import { createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.ts";
import type { AuthPrincipal } from "../../src/util/auth.ts";

const OPERATION_KIND = "handoff_store_v1";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-handoff-operation-receipt-"));
  return path.join(dir, `${name}.sqlite`);
}

function handoffEnv(executionTreeEnabled = false) {
  return {
    AIONIS_EDITION: "lite",
    APP_ENV: "test",
    MEMORY_AUTH_MODE: "off",
    TENANT_QUOTA_ENABLED: false,
    MEMORY_TENANT_ID: "default",
    MEMORY_SCOPE: "default",
    LITE_LOCAL_ACTOR_ID: "local-user",
    MAX_TEXT_LEN: 20_000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    MEMORY_WRITE_REQUIRE_NODES: false,
    MEMORY_LIFECYCLE_RELATION_HTTP_MODEL_PROVIDER_ENABLED: false,
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    EXECUTION_TREE_DEFAULT_ENABLED: executionTreeEnabled,
    LITE_INLINE_EMBEDDING_TIMEOUT_MS: 1_000,
  } as any;
}

function basePayload(operationId?: string) {
  return {
    ...(operationId ? { operation_id: operationId } : {}),
    tenant_id: "default",
    scope: "default",
    memory_lane: "private",
    actor: "local-user",
    producer_agent_id: "local-user",
    owner_agent_id: "local-user",
    anchor: "receipt:durable-handoff",
    handoff_kind: "task_handoff",
    title: "Durable handoff receipt",
    summary: "Persist this handoff exactly once",
    handoff_text: "Resume from the committed handoff",
    target_files: ["src/routes/handoff.ts"],
    next_action: "Continue from the stored handoff receipt",
  };
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function openRoute(args: {
  dbPath: string;
  principals?: Record<string, AuthPrincipal>;
  executionTreeEnabled?: boolean;
}) {
  const database = createLiteRuntimeDatabase(args.dbPath);
  const writeStore = createLiteWriteStoreFromDatabase(database, { closeDatabaseOnClose: true });
  const executionTreeStore = createLiteExecutionTreeStoreFromDatabase(database.db, {
    path: database.path,
    transaction: database.transaction,
    readDatabase: database.readDb,
  });
  const app = Fastify({ logger: false });
  const env = handoffEnv(args.executionTreeEnabled ?? false);
  registerRuntimeErrorHandler(app);
  registerHandoffRoutes({
    app,
    env,
    embedder: null,
    liteWriteStore: writeStore,
    executionStateStore: null,
    executionTreeStore,
    requireMemoryPrincipal: async (req) => {
      const key = headerValue(req.headers["x-api-key"]);
      return key ? args.principals?.[key] ?? null : null;
    },
    // The service also binds its programmatic entrypoint. Keeping the route adapter
    // identity-neutral here proves callers cannot bypass principal binding by invoking it directly.
    withIdentityFromRequest: (_req, body) => body,
    enforceRateLimit: async () => {},
    enforceTenantQuota: async () => {},
    tenantFromBody: (body) => {
      const tenantId = (body as Record<string, unknown> | null)?.tenant_id;
      return typeof tenantId === "string" ? tenantId : "default";
    },
    acquireInflightSlot: async () => ({ release() {} }),
  });
  return {
    app,
    database,
    writeStore,
    executionTreeStore,
    async close() {
      await app.close();
      await executionTreeStore.close();
      await writeStore.close();
    },
  };
}

function countRows(runtime: ReturnType<typeof openRoute>, table: string, where = "", params: unknown[] = []): number {
  const row = runtime.database.readDb.prepare<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`,
  ).get(...params);
  return Number(row.count);
}

test("handoff/store replays its durable receipt after restart, including a server-generated operation id", async () => {
  const dbPath = tmpDbPath("restart-replay");
  const firstRuntime = openRoute({ dbPath });
  const payload = basePayload();
  let firstBody: Record<string, any>;
  try {
    const first = await firstRuntime.app.inject({ method: "POST", url: "/v1/handoff/store", payload });
    assert.equal(first.statusCode, 200, first.body);
    firstBody = first.json();
    assert.equal(firstBody.contract_version, "aionis_handoff_store_result_v1");
    assert.match(firstBody.operation_id, /^handoff_[0-9a-f-]+$/);
    assert.equal(countRows(firstRuntime, "lite_memory_commits"), 1);
    assert.equal(countRows(firstRuntime, "lite_runtime_write_operations", "operation_kind = ?", [OPERATION_KIND]), 1);
  } finally {
    await firstRuntime.close();
  }

  const restarted = openRoute({ dbPath });
  try {
    const replay = await restarted.app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: { ...payload, operation_id: firstBody!.operation_id },
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), firstBody!);
    assert.equal(countRows(restarted, "lite_memory_commits"), 1);
    assert.equal(countRows(restarted, "lite_memory_nodes"), 2);
    assert.equal(countRows(restarted, "lite_runtime_write_operations", "operation_kind = ?", [OPERATION_KIND]), 1);
  } finally {
    await restarted.close();
  }
});

test("concurrent handoff/store requests with the same operation id commit once", async () => {
  const runtime = openRoute({ dbPath: tmpDbPath("concurrent") });
  try {
    const payload = basePayload("handoff-concurrent-1");
    const [left, right] = await Promise.all([
      runtime.app.inject({ method: "POST", url: "/v1/handoff/store", payload }),
      runtime.app.inject({ method: "POST", url: "/v1/handoff/store", payload }),
    ]);
    assert.equal(left.statusCode, 200, left.body);
    assert.equal(right.statusCode, 200, right.body);
    assert.deepEqual(left.json(), right.json());
    assert.equal(countRows(runtime, "lite_memory_commits"), 1);
    assert.equal(countRows(runtime, "lite_memory_nodes"), 2);
    assert.equal(countRows(runtime, "lite_runtime_write_operations", "operation_kind = ?", [OPERATION_KIND]), 1);
  } finally {
    await runtime.close();
  }
});

test("handoff/store rejects operation id reuse with different effective content and leaves no side effects", async () => {
  const runtime = openRoute({ dbPath: tmpDbPath("conflict") });
  try {
    const payload = basePayload("handoff-conflict-1");
    const first = await runtime.app.inject({ method: "POST", url: "/v1/handoff/store", payload });
    assert.equal(first.statusCode, 200, first.body);
    const conflicting = await runtime.app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: { ...payload, summary: "A different handoff intent" },
    });
    assert.equal(conflicting.statusCode, 409, conflicting.body);
    assert.equal(conflicting.json().error, "handoff_operation_id_conflict");
    assert.equal(countRows(runtime, "lite_memory_commits"), 1);
    assert.equal(countRows(runtime, "lite_memory_nodes"), 2);
    assert.equal(countRows(runtime, "lite_runtime_write_operations", "operation_kind = ?", [OPERATION_KIND]), 1);
  } finally {
    await runtime.close();
  }
});

test("handoff/store replays the historical tree receipt after the live tree advances", async () => {
  const runtime = openRoute({ dbPath: tmpDbPath("historical-tree"), executionTreeEnabled: false });
  const tree = createExecutionTreeV1({
    tree_id: "tree:durable-handoff",
    scope: "aionis://execution-tree/durable-handoff",
    task_brief: "Keep the original handoff response stable",
    at: "2026-07-12T08:00:00.000Z",
  });
  const firstOperation: ExecutionTreeOperationV1 = {
    operation_id: "tree:durable-handoff:grow:1",
    tree_id: tree.tree_id,
    scope: tree.scope,
    actor_role: "worker",
    at: "2026-07-12T08:01:00.000Z",
    type: "grow",
    action: "Persist the handoff",
    observation: "The semantic commit completed",
    title: "Committed handoff",
    tool_name: null,
    refs: [],
  };
  try {
    const payload = {
      ...basePayload("handoff-tree-history-1"),
      execution_tree_disabled: true,
      execution_tree_v1: tree,
      execution_tree_operations_v1: [firstOperation],
    };
    const first = await runtime.app.inject({ method: "POST", url: "/v1/handoff/store", payload });
    assert.equal(first.statusCode, 200, first.body);
    const firstBody = first.json();
    assert.equal(runtime.executionTreeStore.get(tree.scope, tree.tree_id)?.revision, 2);

    await runtime.writeStore.withTx(async () => {
      runtime.executionTreeStore.applyOperation({
        operation_id: "tree:durable-handoff:compress:2",
        tree_id: tree.tree_id,
        scope: tree.scope,
        actor_role: "reviewer",
        at: "2026-07-12T08:02:00.000Z",
        expected_revision: 2,
        type: "compress",
        summary: "The live execution tree advanced after the handoff response.",
        title: "Later tree state",
      });
    });
    assert.equal(runtime.executionTreeStore.get(tree.scope, tree.tree_id)?.revision, 3);

    const replay = await runtime.app.inject({ method: "POST", url: "/v1/handoff/store", payload });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), firstBody);
    assert.equal(countRows(runtime, "lite_memory_commits"), 1);
  } finally {
    await runtime.close();
  }
});

test("handoff/store binds authenticated ownership and never exposes another principal's receipt", async () => {
  const principals: Record<string, AuthPrincipal> = {
    "key-a": {
      tenant_id: "tenant-shared",
      agent_id: "agent-a",
      team_id: "team-a",
      role: "developer",
      default_scope: "shared-scope",
      allowed_scopes: ["shared-scope"],
      source: "api_key",
    },
    "key-b": {
      tenant_id: "tenant-shared",
      agent_id: "agent-b",
      team_id: "team-b",
      role: "developer",
      default_scope: "shared-scope",
      allowed_scopes: ["shared-scope"],
      source: "api_key",
    },
  };
  const runtime = openRoute({ dbPath: tmpDbPath("principal-binding"), principals });
  try {
    const payload = {
      ...basePayload("handoff-principal-1"),
      tenant_id: "tenant-shared",
      scope: "shared-scope",
      actor: "spoofed-actor",
      producer_agent_id: "spoofed-producer",
      owner_agent_id: "spoofed-owner",
      owner_team_id: "spoofed-team",
    };
    const stored = await runtime.app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      headers: { "x-api-key": "key-a" },
      payload,
    });
    assert.equal(stored.statusCode, 200, stored.body);
    const node = runtime.database.readDb.prepare<{
      producer_agent_id: string | null;
      owner_agent_id: string | null;
      owner_team_id: string | null;
    }>(
      "SELECT producer_agent_id, owner_agent_id, owner_team_id FROM lite_memory_nodes LIMIT 1",
    ).get();
    assert.equal(node.producer_agent_id, "agent-a");
    assert.equal(node.owner_agent_id, "agent-a");
    assert.equal(node.owner_team_id, "team-a");

    const foreignReplay = await runtime.app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      headers: { "x-api-key": "key-b" },
      payload,
    });
    assert.equal(foreignReplay.statusCode, 409, foreignReplay.body);
    assert.equal(foreignReplay.json().error, "handoff_operation_id_conflict");
    assert.notDeepEqual(foreignReplay.json(), stored.json());
    assert.equal(countRows(runtime, "lite_memory_commits"), 1);
  } finally {
    await runtime.close();
  }
});

test("handoff/store fails closed on a corrupt durable receipt", async () => {
  const runtime = openRoute({ dbPath: tmpDbPath("corrupt-receipt") });
  try {
    const payload = basePayload("handoff-corrupt-receipt-1");
    const first = await runtime.app.inject({ method: "POST", url: "/v1/handoff/store", payload });
    assert.equal(first.statusCode, 200, first.body);
    runtime.database.db.prepare(
      "UPDATE lite_runtime_write_operations SET receipt_json = ? WHERE operation_kind = ? AND operation_id = ?",
    ).run("{not-json", OPERATION_KIND, payload.operation_id);

    const replay = await runtime.app.inject({ method: "POST", url: "/v1/handoff/store", payload });
    assert.equal(replay.statusCode, 500, replay.body);
    assert.equal(replay.json().error, "handoff_operation_receipt_corrupt");
    assert.equal(countRows(runtime, "lite_memory_commits"), 1);
  } finally {
    await runtime.close();
  }
});

test("handoff/store rolls back the semantic write when durable receipt insertion fails", async () => {
  const runtime = openRoute({ dbPath: tmpDbPath("receipt-insert-rollback") });
  try {
    runtime.database.db.exec(`
      CREATE TRIGGER reject_handoff_operation_receipt
      BEFORE INSERT ON lite_runtime_write_operations
      WHEN NEW.operation_kind = '${OPERATION_KIND}'
      BEGIN
        SELECT RAISE(ABORT, 'injected handoff receipt failure');
      END;
    `);
    const response = await runtime.app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: basePayload("handoff-receipt-insert-failure-1"),
    });
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(countRows(runtime, "lite_memory_commits"), 0);
    assert.equal(countRows(runtime, "lite_memory_nodes"), 0);
    assert.equal(countRows(runtime, "lite_runtime_write_operations", "operation_kind = ?", [OPERATION_KIND]), 0);
  } finally {
    await runtime.close();
  }
});
