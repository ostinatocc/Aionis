import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { EmbeddingProvider } from "../../src/embeddings/types.ts";
import {
  createLiteExecutionStateStore,
  createLiteExecutionStateStoreFromDatabase,
} from "../../src/execution/state-store.ts";
import {
  createLiteExecutionTreeStore,
  createLiteExecutionTreeStoreFromDatabase,
} from "../../src/execution/tree-store.ts";
import { createExecutionTreeV1 } from "../../src/execution/tree.ts";
import { createProductObserveService } from "../../src/product/observe-service.ts";
import { createHandoffRouteService } from "../../src/routes/handoff.ts";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.ts";
import { createLiteClaimLedgerStoreFromDatabase } from "../../src/store/lite-claim-ledger-store.ts";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabaseFaultInjector,
} from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStoreFromDatabase,
  createLiteWriteStore,
  type LiteWriteAnnSync,
} from "../../src/store/lite-write-store.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";

function atomicEnv() {
  return {
    AIONIS_EDITION: "lite",
    APP_ENV: "test",
    MEMORY_TENANT_ID: "default",
    MEMORY_SCOPE: "default",
    LITE_LOCAL_ACTOR_ID: "local-user",
    MAX_TEXT_LEN: 20_000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    MEMORY_WRITE_REQUIRE_NODES: false,
    MEMORY_LIFECYCLE_RELATION_HTTP_MODEL_PROVIDER_ENABLED: false,
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    EXECUTION_TREE_DEFAULT_ENABLED: true,
    LITE_INLINE_EMBEDDING_TIMEOUT_MS: 1_000,
  } as any;
}

function openAtomicRuntime(
  dbPath: string,
  faultInjector?: LiteRuntimeDatabaseFaultInjector,
  options: { embedder?: EmbeddingProvider | null; annSync?: LiteWriteAnnSync | null } = {},
) {
  const database = createLiteRuntimeDatabase(dbPath, { faultInjector });
  const writeStore = createLiteWriteStoreFromDatabase(database, {
    closeDatabaseOnClose: true,
    annSync: options.annSync ?? null,
  });
  const claimStore = createLiteClaimLedgerStoreFromDatabase(database);
  const claimLedgerAccess = claimStore.createClaimLedgerAccess();
  const executionStateStore = createLiteExecutionStateStoreFromDatabase(database.db, {
    path: database.path,
    transaction: database.transaction,
  });
  const executionTreeStore = createLiteExecutionTreeStoreFromDatabase(database.db, {
    path: database.path,
    transaction: database.transaction,
  });
  const env = atomicEnv();
  const memoryWrite = createMemoryWriteRouteService({
    env,
    embedder: options.embedder ?? null,
    liteWriteStore: writeStore,
    executionStateStore,
    executionTreeStore,
  });
  const handoffStore = createHandoffRouteService({
    env,
    embedder: options.embedder ?? null,
    liteWriteStore: writeStore,
    executionStateStore,
    executionTreeStore,
  });
  const observe = createProductObserveService({
    defaultTenantId: env.MEMORY_TENANT_ID,
    defaultScope: env.MEMORY_SCOPE,
    memoryWrite,
    handoffStore,
    atomicWrite: writeStore,
    claimLedgerAccess,
  });
  return {
    observe,
    memoryWrite,
    handoffStore,
    writeStore,
    claimLedgerAccess,
    executionStateStore,
    executionTreeStore,
    async close() {
      await executionTreeStore.close();
      await executionStateStore.close();
      await claimStore.close();
      await writeStore.close();
    },
  };
}

function combinedObserveInput(operationId: string) {
  const observedAt = "2026-07-12T00:00:00.000Z";
  const stateId = `${operationId}:state`;
  const memoryStateId = `${operationId}:memory-state`;
  const baseState = {
    version: 1 as const,
    scope: "default",
    task_brief: "Prove observe UoW includes execution state and tree",
    current_stage: "review" as const,
    active_role: "review" as const,
    owned_files: [],
    modified_files: [],
    pending_validations: [],
    completed_validations: [],
    last_accepted_hypothesis: null,
    rejected_paths: [],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    reviewer_contract: null,
    resume_anchor: null,
    updated_at: observedAt,
  };
  const tree = createExecutionTreeV1({
    tree_id: `${operationId}:tree`,
    scope: "default",
    task_brief: "Prove observe UoW includes execution state and tree",
    at: observedAt,
  });
  return {
    operation_id: operationId,
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    producer_agent_id: "local-user",
    owner_agent_id: "local-user",
    input_text: "Atomic observe memory",
    auto_embed: false,
    nodes: [{
      client_id: `${operationId}:memory`,
      type: "event",
      title: "Prior atomic persistence workflow",
      text_summary: "The prior legacy atomic persistence workflow used the earlier transaction route.",
      confidence: 0.9,
      slots: {
        atomic_uow: true,
        execution_state_v1: {
          ...baseState,
          state_id: memoryStateId,
        },
      },
    }, {
      client_id: `${operationId}:prior-route`,
      type: "concept",
      title: "Prior legacy atomic persistence route for src/atomic.ts",
      text_summary: "The prior legacy atomic persistence workflow used src/atomic.ts and the earlier transaction route.",
      confidence: 0.9,
      slots: { lifecycle_state: "active", atomic_uow_prior_route: true },
    }],
    handoff: {
      handoff_kind: "task_handoff",
      anchor: `${operationId}:handoff`,
      title: "Atomic handoff",
      summary: "The later atomic persistence workflow for src/atomic.ts supersedes the prior legacy transaction route.",
      handoff_text: "Use the later atomic persistence workflow for src/atomic.ts and replace the prior legacy route.",
      target_files: ["src/atomic.ts"],
      confidence: 0.9,
      salience: 0.9,
      importance: 0.9,
      execution_tree_default_disabled: true,
      execution_state_v1: {
        ...baseState,
        state_id: stateId,
      },
      execution_transitions_v1: [{
        transition_id: `${operationId}:transition`,
        state_id: stateId,
        scope: "default",
        actor_role: "review",
        at: observedAt,
        type: "validation_added",
        validations: ["atomic-uow-check"],
      }],
      execution_tree_v1: tree,
      execution_tree_operations_v1: [{
        operation_id: `${operationId}:tree-operation`,
        tree_id: tree.tree_id,
        scope: tree.scope,
        actor_role: "review",
        at: observedAt,
        type: "grow",
        action: "persist the complete UoW",
        observation: "all mutation families are included",
        title: "Atomic UoW",
        tool_name: null,
        refs: [],
      }],
    },
    claims: [{
      contract_version: "aionis_claim_write_v1",
      client_id: `${operationId}:claim`,
      subject_key: "runtime:atomic-uow",
      predicate: "status",
      value: { status: "committed" },
      value_text: "committed",
      slot_key: "runtime:atomic-uow.status",
      claim_kind: "execution_fact",
      conflict_policy: "multi_value",
      authority: "advisory",
      confidence: 0.9,
      evidence_refs: [`observe://${operationId}`],
    }],
  };
}

function tableCounts(dbPath: string): Record<string, number> {
  const db = createSqliteDatabase(dbPath);
  try {
    const tables = [
      "lite_memory_commits",
      "lite_memory_nodes",
      "lite_claim_ledger_claims",
      "lite_claim_ledger_events",
      "lite_execution_states",
      "lite_execution_state_transitions",
      "lite_execution_trees",
      "lite_execution_tree_operations",
      "lite_runtime_write_operations",
    ];
    const counts = Object.fromEntries(tables.map((table) => {
      const row = db.prepare<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get();
      return [table, Number(row.count)];
    }));
    const handoff = db.prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM lite_memory_nodes
      WHERE type = 'event' AND json_extract(slots_json, '$.summary_kind') = 'handoff'
    `).get();
    const stateRevision = db.prepare<{ revision: number | null }>(
      "SELECT MAX(revision) AS revision FROM lite_execution_states",
    ).get();
    const treeRevision = db.prepare<{ revision: number | null }>(
      "SELECT MAX(revision) AS revision FROM lite_execution_trees",
    ).get();
    const workflowObservedCount = db.prepare<{ observed_count: number | null }>(`
      SELECT MAX(CAST(json_extract(slots_json, '$.execution_native_v1.workflow_promotion.observed_count') AS INTEGER)) AS observed_count
      FROM lite_memory_nodes
      WHERE json_extract(slots_json, '$.execution_native_v1.execution_kind') = 'workflow_candidate'
    `).get();
    const lifecycleRelations = db.prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM lite_memory_edges
      WHERE type IN ('supersedes', 'contradicts', 'invalidates')
    `).get();
    return {
      ...counts,
      handoff_nodes: Number(handoff.count),
      execution_state_max_revision: Number(stateRevision.revision ?? 0),
      execution_tree_max_revision: Number(treeRevision.revision ?? 0),
      workflow_projection_max_observed_count: Number(workflowObservedCount.observed_count ?? 0),
      same_observe_lifecycle_relation_count: Number(lifecycleRelations.count),
    };
  } finally {
    db.close();
  }
}

test("a downstream claim conflict rolls back memory, handoff, execution, claims, and receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-atomic-domain-fault-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  try {
    const input = combinedObserveInput("observe-domain-fault");
    input.claims.push({
      ...input.claims[0],
      value: { status: "different" },
      value_text: "different",
    });
    const result = await runtime.observe.execute(input as any, { principal: null });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal((result.body as any).error, "claim_client_id_conflict");
  } finally {
    await runtime.close();
  }

  const counts = tableCounts(dbPath);
  for (const [table, count] of Object.entries(counts)) {
    assert.equal(count, 0, `${table} must remain empty after rollback and reopen`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a before-commit SQLite fault leaves no earlier mutation visible after reopen", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-atomic-sqlite-fault-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  let injected = false;
  const runtime = openAtomicRuntime(dbPath, (phase) => {
    if (phase === "before_commit" && !injected) {
      injected = true;
      throw new Error("injected before-commit fault");
    }
  });
  try {
    const result = await runtime.observe.execute(combinedObserveInput("observe-sqlite-fault") as any, { principal: null });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
    assert.equal(injected, true);
  } finally {
    await runtime.close();
  }

  const counts = tableCounts(dbPath);
  for (const [table, count] of Object.entries(counts)) {
    assert.equal(count, 0, `${table} must remain empty after injected fault and reopen`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test("observe operation receipt is stable across close/reopen and conflicts on content reuse", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-atomic-idempotency-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const input = combinedObserveInput("observe-stable-receipt");
  const firstRuntime = openAtomicRuntime(dbPath);
  const first = await firstRuntime.observe.execute(input as any, { principal: null });
  assert.equal(first.ok, true);
  assert.deepEqual((first.body as any).post_commit_projections, {
    semantic_commit: "committed",
    embedding: "not_requested",
    ann_sync: "not_requested",
  });
  let retryPrepareCalled = false;
  firstRuntime.memoryWrite.prepare = async () => {
    retryPrepareCalled = true;
    throw new Error("prepare must not run for a committed operation replay");
  };
  const sameProcessReplay = await firstRuntime.observe.execute(input as any, { principal: null });
  assert.deepEqual(sameProcessReplay, first);
  assert.equal(retryPrepareCalled, false);
  await firstRuntime.close();
  const afterFirst = tableCounts(dbPath);
  assert.equal(afterFirst.lite_memory_commits, 2);
  assert.ok(afterFirst.lite_memory_nodes >= 2);
  assert.equal(afterFirst.handoff_nodes, 1);
  assert.equal(afterFirst.lite_claim_ledger_claims, 1);
  assert.equal(afterFirst.lite_claim_ledger_events, 1);
  assert.equal(afterFirst.lite_runtime_write_operations, 1);
  assert.equal(afterFirst.lite_execution_states, 2);
  assert.equal(afterFirst.lite_execution_state_transitions, 1);
  assert.equal(afterFirst.execution_state_max_revision, 2);
  assert.ok(afterFirst.lite_execution_trees >= 1);
  assert.ok(afterFirst.lite_execution_tree_operations >= 1);
  assert.ok(afterFirst.execution_tree_max_revision >= 2);
  assert.ok(afterFirst.workflow_projection_max_observed_count >= 1);
  assert.ok(afterFirst.same_observe_lifecycle_relation_count >= 1);

  const reopened = openAtomicRuntime(dbPath);
  try {
    const replay = await reopened.observe.execute(input as any, { principal: null });
    assert.deepEqual(replay, first);
    assert.deepEqual(tableCounts(dbPath), afterFirst);

    const changed = combinedObserveInput("observe-stable-receipt");
    changed.nodes[0].text_summary = "Different content under the same operation id.";
    const conflict = await reopened.observe.execute(changed as any, { principal: null });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.body as any).error, "observe_operation_id_conflict");
    assert.deepEqual(tableCounts(dbPath), afterFirst);
  } finally {
    await reopened.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("observe rejects nested memory and handoff identity overrides before any domain write", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-observe-nested-identity-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  try {
    const memoryConflict = await runtime.observe.execute({
      operation_id: "observe-nested-memory-identity",
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory: {
        tenant_id: "other-tenant",
        scope: "other-scope",
        actor: "other-actor",
        input_text: "must not cross the top-level observe boundary",
        auto_embed: false,
        nodes: [{
          client_id: "nested-memory-identity",
          type: "concept",
          title: "Nested identity override",
          text_summary: "This node must never be persisted.",
        }],
      },
      claims: [{
        contract_version: "aionis_claim_write_v1",
        client_id: "nested-memory-identity-claim",
        subject_key: "runtime:nested-identity",
        predicate: "status",
        value: { status: "rejected" },
        claim_kind: "execution_fact",
        conflict_policy: "multi_value",
        authority: "advisory",
        confidence: 0.9,
        evidence_refs: [],
      }],
    } as any, { principal: null });
    assert.equal(memoryConflict.ok, false);
    assert.equal(memoryConflict.statusCode, 400);
    assert.equal((memoryConflict.body as any).error, "observe_nested_identity_conflict");

    const handoffConflict = await runtime.observe.execute({
      operation_id: "observe-nested-handoff-identity",
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      handoff: {
        tenant_id: "other-tenant",
        scope: "other-scope",
        actor: "other-actor",
        handoff_kind: "task_handoff",
        anchor: "nested-handoff-identity",
        summary: "Nested handoff identity must not escape the observe boundary.",
        handoff_text: "Reject before persistence.",
      },
    } as any, { principal: null });
    assert.equal(handoffConflict.ok, false);
    assert.equal(handoffConflict.statusCode, 400);
    assert.equal((handoffConflict.body as any).error, "observe_nested_identity_conflict");
  } finally {
    await runtime.close();
  }

  for (const [table, count] of Object.entries(tableCounts(dbPath))) {
    assert.equal(count, 0, `${table} must remain empty after nested identity rejection`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test("observe rejects a stale execution state snapshot and rolls back memory, claims, and receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-observe-stale-state-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  const observedAt = "2026-07-12T01:00:00.000Z";
  const staleState = {
    version: 1 as const,
    state_id: "observe-stale-state",
    scope: "default",
    task_brief: "Reject stale state snapshots atomically",
    current_stage: "patch" as const,
    active_role: "patch" as const,
    owned_files: [],
    modified_files: [],
    pending_validations: [],
    completed_validations: [],
    last_accepted_hypothesis: null,
    rejected_paths: [],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    reviewer_contract: null,
    resume_anchor: null,
    updated_at: observedAt,
  };
  try {
    await runtime.writeStore.withTx(async () => {
      runtime.executionStateStore.initialize(staleState);
      runtime.executionStateStore.applyTransition({
        transition_id: "observe-stale-state:advance",
        state_id: staleState.state_id,
        scope: staleState.scope,
        actor_role: "review",
        at: "2026-07-12T01:01:00.000Z",
        type: "validation_added",
        validations: ["continuity advanced"],
        expected_revision: 1,
      });
    });
    const before = tableCounts(dbPath);
    const result = await runtime.observe.execute({
      operation_id: "observe-stale-state-write",
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "This write carries an obsolete execution snapshot.",
      auto_embed: false,
      nodes: [{
        client_id: "observe-stale-state-memory",
        type: "event",
        title: "Stale state overlay",
        text_summary: "The complete observe event must roll back.",
        slots: { execution_state_v1: staleState },
      }],
      claims: [{
        contract_version: "aionis_claim_write_v1",
        client_id: "observe-stale-state-claim",
        subject_key: "runtime:stale-state",
        predicate: "status",
        value: { status: "must-not-persist" },
        claim_kind: "execution_fact",
        conflict_policy: "multi_value",
        authority: "advisory",
        confidence: 0.9,
        evidence_refs: [],
      }],
    } as any, { principal: null });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal((result.body as any).error, "execution_state_snapshot_conflict");
    assert.deepEqual(tableCounts(dbPath), before);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("observe rejects a stale execution tree snapshot and rolls back the complete event", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-observe-stale-tree-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  const staleTree = createExecutionTreeV1({
    tree_id: "observe-stale-tree",
    scope: "default",
    task_brief: "Reject stale tree snapshots atomically",
    at: "2026-07-12T02:00:00.000Z",
  });
  try {
    await runtime.writeStore.withTx(async () => {
      runtime.executionTreeStore.initialize(staleTree);
      runtime.executionTreeStore.applyOperation({
        operation_id: "observe-stale-tree:advance",
        tree_id: staleTree.tree_id,
        scope: staleTree.scope,
        actor_role: "execute",
        at: "2026-07-12T02:01:00.000Z",
        type: "grow",
        action: "advance canonical tree",
        observation: "revision two",
        title: "Canonical advance",
        tool_name: null,
        refs: [],
        expected_revision: 1,
      });
    });
    const before = tableCounts(dbPath);
    const result = await runtime.observe.execute({
      operation_id: "observe-stale-tree-write",
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "This write carries an obsolete execution tree snapshot.",
      auto_embed: false,
      nodes: [{
        client_id: "observe-stale-tree-memory",
        type: "event",
        title: "Stale tree overlay",
        text_summary: "The complete observe event must roll back.",
        slots: { execution_tree_v1: staleTree, execution_tree_disabled: true },
      }],
    } as any, { principal: null });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal((result.body as any).error, "execution_tree_snapshot_conflict");
    assert.deepEqual(tableCounts(dbPath), before);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("direct handoff builds its receipt inside the transaction so receipt failure rolls back memory", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-handoff-receipt-atomic-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  const tree = createExecutionTreeV1({
    tree_id: "handoff-receipt-atomic-tree",
    scope: "default",
    task_brief: "Receipt failure must roll back the handoff",
    at: "2026-07-12T03:00:00.000Z",
  });
  const originalGet = runtime.executionTreeStore.get.bind(runtime.executionTreeStore);
  runtime.executionTreeStore.get = () => {
    throw new Error("injected handoff receipt read failure");
  };
  try {
    await assert.rejects(
      runtime.handoffStore.store({
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        handoff_kind: "task_handoff",
        anchor: "handoff-receipt-atomic",
        summary: "The response receipt is part of the atomic handoff event.",
        handoff_text: "Roll back if the receipt cannot be constructed.",
        execution_tree_default_disabled: true,
        execution_tree_v1: tree,
      } as any),
      /injected handoff receipt read failure/,
    );
  } finally {
    runtime.executionTreeStore.get = originalGet;
    await runtime.close();
  }
  for (const [table, count] of Object.entries(tableCounts(dbPath))) {
    assert.equal(count, 0, `${table} must remain empty after handoff receipt rollback`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test("operation receipts cannot be inserted outside the shared Runtime transaction", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-operation-receipt-boundary-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const writeStore = createLiteWriteStore(dbPath);
  try {
    await assert.rejects(
      writeStore.insertWriteOperation({
        tenantId: "default",
        scope: "default",
        operationKind: "product_observe_v1",
        operationId: "outside-transaction",
        requestSha256: "a".repeat(64),
        receiptJson: "{}",
        commitId: null,
      }),
      /must be inserted inside the shared Runtime transaction/,
    );
    assert.equal(await writeStore.getWriteOperation({
      tenantId: "default",
      scope: "default",
      operationKind: "product_observe_v1",
      operationId: "outside-transaction",
    }), null);
  } finally {
    await writeStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a prepared projection is rejected when another write advances its commit base", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-projection-stale-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  try {
    const writeBody = (clientId: string) => ({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      auto_embed: false,
      input_text: clientId,
      nodes: [{
        client_id: clientId,
        type: "concept",
        title: clientId,
        text_summary: `prepared projection ${clientId}`,
      }],
    });
    const firstPlan = await runtime.memoryWrite.prepare(writeBody("projection-first"));
    const stalePlan = await runtime.memoryWrite.prepare(writeBody("projection-stale"));
    await runtime.writeStore.withTx(() => runtime.memoryWrite.persist(firstPlan));
    await assert.rejects(
      runtime.writeStore.withTx(() => runtime.memoryWrite.persist(stalePlan)),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.equal((error as { code?: string }).code, "write_projection_stale");
        return true;
      },
    );
  } finally {
    await runtime.close();
  }
  const counts = tableCounts(dbPath);
  assert.equal(counts.lite_memory_commits, 1);
  assert.equal(counts.lite_memory_nodes, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("failing post-commit embedding and ANN keep semantic observe success and immutable receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-post-commit-failure-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  let embedCalls = 0;
  let annCalls = 0;
  const runtime = openAtomicRuntime(dbPath, undefined, {
    embedder: {
      name: "failing:test",
      dim: 1536,
      async embed() {
        embedCalls += 1;
        throw new Error("injected embedding failure");
      },
    },
    annSync: {
      async syncNode() {
        annCalls += 1;
        throw new Error("injected ANN sync failure");
      },
      async deleteNode() {
        annCalls += 1;
        throw new Error("injected ANN delete failure");
      },
    },
  });
  const input = combinedObserveInput("observe-post-commit-failure");
  input.auto_embed = true;
  try {
    const first = await runtime.observe.execute(input as any, { principal: null });
    assert.equal(first.ok, true);
    assert.deepEqual((first.body as any).post_commit_projections, {
      semantic_commit: "committed",
      embedding: "scheduled",
      ann_sync: "scheduled",
    });
    assert.ok(embedCalls > 0);
    assert.ok(annCalls > 0);
    const replay = await runtime.observe.execute(input as any, { principal: null });
    assert.deepEqual(replay, first);
    assert.equal(tableCounts(dbPath).lite_runtime_write_operations, 1);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("route services reject execution stores from a different transaction runner", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-uow-identity-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const writeStore = createLiteWriteStore(dbPath);
  const stateStore = createLiteExecutionStateStore(dbPath);
  const treeStore = createLiteExecutionTreeStore(dbPath);
  const claimDatabase = createLiteRuntimeDatabase(path.join(directory, "claims.sqlite"));
  const claimStore = createLiteClaimLedgerStoreFromDatabase(claimDatabase, { closeDatabaseOnClose: true });
  const claimLedgerAccess = claimStore.createClaimLedgerAccess();
  try {
    assert.throws(
      () => createMemoryWriteRouteService({
        env: atomicEnv(),
        embedder: null,
        liteWriteStore: writeStore,
        executionStateStore: stateStore,
      }),
      /must share the Lite write transaction runner/,
    );
    assert.throws(
      () => createHandoffRouteService({
        env: atomicEnv(),
        embedder: null,
        liteWriteStore: writeStore,
        executionTreeStore: treeStore,
      }),
      /must share the Lite write transaction runner/,
    );
    assert.throws(
      () => createProductObserveService({
        defaultTenantId: "default",
        defaultScope: "default",
        atomicWrite: writeStore,
        memoryWrite: null,
        handoffStore: null,
        claimLedgerAccess,
      }),
      /claim ledger must share the atomic write transaction runner/,
    );
  } finally {
    await claimStore.close();
    await treeStore.close();
    await stateStore.close();
    await writeStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
