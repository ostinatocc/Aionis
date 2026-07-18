import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  activateMemoryNodesLite,
  applyUnusedExposureLearningControlLite,
  rehydrateArchiveNodesLite,
} from "../../src/memory/lifecycle-lite.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { SELF_COMMIT_REFERENCE } from "../../src/memory/write-serialization.ts";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.ts";
import type { WriteExistingNodeState } from "../../src/store/write-access.ts";
import {
  APPLIED_AUTHORITY_TABLE_CONTRACTS,
  normalizeAppliedAuthorityRow,
} from "../../src/store/write-commit-authority.ts";
import { HttpError } from "../../src/util/http.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-lifecycle-authority-"));
  return path.join(dir, `${name}.sqlite`);
}

const lifecycleOptions = {
  maxTextLen: 10_000,
  piiRedaction: false,
  defaultActor: "local-user",
};

const writeOptions = {
  maxTextLen: 10_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
} as const;

type SeedNode = {
  id: string;
  type?: "procedure" | "concept";
  tier?: "hot" | "warm" | "cold" | "archive";
  title: string;
  textSummary: string;
  slots?: Record<string, unknown>;
  embedding?: number[];
  embeddingModel?: string;
  rawRef?: string;
  evidenceRef?: string;
  salience?: number;
  importance?: number;
  confidence?: number;
};

type CommitRow = {
  id: string;
  parent_commit_id: string | null;
  diff_json: string;
  commit_hash: string;
  digest_version: number;
  revision: number;
  mutation_digest: string;
};

type AuthorityMutation = {
  table: string;
  identity: Record<string, unknown>;
  operation: "update";
  before: Record<string, unknown>;
  requested: Record<string, unknown>;
  after: Record<string, unknown>;
};

type AuthorityDiff = {
  contract: string;
  digest_version: number;
  authority_kind: string;
  mutations: AuthorityMutation[];
};

async function seedNodes(
  store: LiteWriteStore,
  nodes: readonly SeedNode[],
  input = "seed lifecycle authority fixture",
) {
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    input_text: input,
    auto_embed: false,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type ?? "procedure",
      tier: node.tier ?? "warm",
      memory_lane: "private" as const,
      owner_agent_id: "local-user",
      title: node.title,
      text_summary: node.textSummary,
      slots: node.slots ?? {},
      raw_ref: node.rawRef,
      evidence_ref: node.evidenceRef,
      embedding: node.embedding,
      embedding_model: node.embeddingModel,
      salience: node.salience,
      importance: node.importance,
      confidence: node.confidence,
    })),
    edges: [],
  }, "default", "default", writeOptions, null);
  return await store.withTx(() => applyMemoryWrite(prepared, {
    ...writeOptions,
    write_access: store,
  }));
}

async function nodeState(store: LiteWriteStore, nodeId: string): Promise<WriteExistingNodeState> {
  const state = (await store.nodeStatesByIds("default", [nodeId])).get(nodeId);
  assert.ok(state);
  return state;
}

function parseCanonicalJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function authorityNodeState(
  state: WriteExistingNodeState,
  selfCommitId?: string,
): Record<string, unknown> {
  const row = {
    id: state.id,
    scope: state.scope,
    client_id: state.clientId,
    type: state.type,
    tier: state.tier,
    title: state.title,
    text_summary: state.textSummary,
    slots_json: parseCanonicalJson(state.slotsJson),
    raw_ref: state.rawRef,
    evidence_ref: state.evidenceRef,
    embedding_vector_json: state.embeddingVector === null
      ? null
      : parseCanonicalJson(state.embeddingVector),
    embedding_model: state.embeddingModel,
    memory_lane: state.memoryLane,
    producer_agent_id: state.producerAgentId,
    owner_agent_id: state.ownerAgentId,
    owner_team_id: state.ownerTeamId,
    embedding_status: state.embeddingStatus,
    embedding_last_error: state.embeddingLastError,
    salience: state.salience,
    importance: state.importance,
    confidence: state.confidence,
    redaction_version: state.redactionVersion,
    commit_id: state.commitId,
    created_at: state.createdAt,
  };
  return selfCommitId
    ? normalizeAppliedAuthorityRow("lite_memory_nodes", row, selfCommitId)
    : row;
}

function commitCount(database: LiteRuntimeDatabase): number {
  const row = database.db.prepare(
    "SELECT COUNT(*) AS count FROM lite_memory_commits WHERE scope = ?",
  ).get("default") as { count: number };
  return Number(row.count);
}

function durableNodeSideEffects(database: LiteRuntimeDatabase, nodeId: string): unknown {
  return {
    execution_native: database.db.prepare(
      "SELECT * FROM lite_memory_execution_native_index WHERE scope = ? AND node_id = ?",
    ).all("default", nodeId),
    keyword: database.db.prepare(
      "SELECT * FROM lite_memory_keyword_index WHERE scope = ? AND node_id = ?",
    ).all("default", nodeId),
    projection_jobs: database.db.prepare(
      "SELECT * FROM lite_memory_projection_jobs WHERE scope = ? AND node_id = ? ORDER BY job_kind",
    ).all("default", nodeId),
    outbox: database.db.prepare(
      "SELECT * FROM lite_memory_outbox WHERE scope = ? ORDER BY row_id",
    ).all("default"),
  };
}

async function assertAuthorityCommit(args: {
  database: LiteRuntimeDatabase;
  store: LiteWriteStore;
  commitId: string;
  authorityKind: string;
  before: WriteExistingNodeState;
  after: WriteExistingNodeState;
  parentCommitId: string;
  parentRevision: number;
}): Promise<AuthorityMutation> {
  const commit = args.database.db.prepare(
    `SELECT id, parent_commit_id, diff_json, commit_hash, digest_version,
            revision, mutation_digest
     FROM lite_memory_commits
     WHERE scope = ? AND id = ?`,
  ).get("default", args.commitId) as CommitRow | undefined;
  assert.ok(commit);
  assert.equal(commit.parent_commit_id, args.parentCommitId);
  assert.equal(commit.digest_version, 2);
  assert.equal(commit.revision, args.parentRevision + 1);
  assert.equal(typeof commit.mutation_digest, "string");

  const diff = JSON.parse(commit.diff_json) as AuthorityDiff;
  assert.equal(diff.contract, "aionis_applied_authority_mutation_v2");
  assert.equal(diff.digest_version, 2);
  assert.equal(diff.authority_kind, args.authorityKind);
  assert.equal(diff.mutations.length, 1);
  const mutation = diff.mutations[0]!;
  assert.equal(mutation.table, "lite_memory_nodes");
  assert.deepEqual(mutation.identity, { id: args.before.id, scope: "default" });
  assert.equal(mutation.operation, "update");
  const persistedKeys = [...APPLIED_AUTHORITY_TABLE_CONTRACTS.lite_memory_nodes.rowKeys].sort();
  assert.deepEqual(Object.keys(mutation.before).sort(), persistedKeys);
  assert.deepEqual(Object.keys(mutation.after).sort(), persistedKeys);
  assert.deepEqual(mutation.before, authorityNodeState(args.before));
  assert.deepEqual(mutation.after, authorityNodeState(args.after, commit.id));
  assert.equal(mutation.after.commit_id, SELF_COMMIT_REFERENCE);
  assert.deepEqual(mutation.requested.side_effects, [
    "refresh_execution_native_index",
    "refresh_keyword_index",
    "refresh_embedding_projection",
    "enqueue_ann_projection_when_enabled",
  ]);

  const head = await args.store.readScopeHead("default");
  assert.equal(head?.commitId, commit.id);
  assert.equal(head?.commitHash, commit.commit_hash);
  assert.equal(head?.revision, commit.revision);
  return mutation;
}

test("archive rehydrate persists through the v2 authority coordinator", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("rehydrate-v2"));
  const store = createLiteWriteStoreFromDatabase(database);
  const nodeId = randomUUID();
  try {
    await seedNodes(store, [{
      id: nodeId,
      tier: "archive",
      title: "Archived workflow candidate",
      textSummary: "Rehydrate this workflow when the task returns",
      slots: { lifecycle_state: "archived", nested: { z: 2, a: 1 } },
      embedding: Array.from({ length: 1_536 }, (_, index) => index / 10_000),
      embeddingModel: "lifecycle-authority-fixture-v1",
      rawRef: "raw://lifecycle/rehydrate",
      evidenceRef: "evidence://lifecycle/rehydrate",
      salience: 0.42,
      importance: 0.61,
      confidence: 0.73,
    }]);
    const before = await nodeState(store, nodeId);
    const parent = await store.readScopeHead("default");
    assert.ok(parent);

    const result = await rehydrateArchiveNodesLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      node_ids: [nodeId],
      target_tier: "hot",
      reason: "task returned",
      input_text: "restore the archived workflow",
    }, "default", "default", lifecycleOptions);

    assert.equal(result.rehydrated.moved_nodes, 1);
    assert.equal(typeof result.commit_id, "string");
    const after = await nodeState(store, nodeId);
    const mutation = await assertAuthorityCommit({
      database,
      store,
      commitId: result.commit_id!,
      authorityKind: "archive_rehydrate",
      before,
      after,
      parentCommitId: parent.commitId,
      parentRevision: parent.revision,
    });
    assert.equal(after.tier, "hot");
    assert.ok(Array.isArray(mutation.before.embedding_vector_json));
    assert.equal((mutation.before.embedding_vector_json as unknown[]).length, 1_536);
    assert.deepEqual(mutation.after.embedding_vector_json, mutation.before.embedding_vector_json);
    for (const unchangedKey of [
      "id", "scope", "client_id", "type", "title", "text_summary", "raw_ref",
      "evidence_ref", "embedding_vector_json", "embedding_model", "memory_lane",
      "producer_agent_id", "owner_agent_id", "owner_team_id", "embedding_status",
      "embedding_last_error", "redaction_version", "created_at",
    ]) {
      assert.deepEqual(mutation.after[unchangedKey], mutation.before[unchangedKey]);
    }
  } finally {
    await store.close();
    await database.close();
  }
});

test("node activation records a full-row v2 authority mutation", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("activate-v2"));
  const store = createLiteWriteStoreFromDatabase(database);
  const nodeId = randomUUID();
  try {
    await seedNodes(store, [{
      id: nodeId,
      tier: "warm",
      title: "Reusable recovery workflow",
      textSummary: "Use this workflow when the export route fails",
      slots: {
        continuity_marker_v1: {
          workflow_signature: "workflow:authority-activation",
          source: "lifecycle-authority-fixture",
        },
      },
      salience: 0.51,
      importance: 0.62,
      confidence: 0.74,
    }]);
    const before = await nodeState(store, nodeId);
    const parent = await store.readScopeHead("default");
    assert.ok(parent);

    const result = await activateMemoryNodesLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      node_ids: [nodeId],
      run_id: "run-authority-activate-1",
      feedback_recorded_at: "2026-07-18T01:02:03.000Z",
      outcome: "positive",
      used_surface: "use_now",
      verifier_status: "passed",
      tool_status: "succeeded",
      activate: true,
      reason: "verified host reuse succeeded",
      input_text: "record a verified positive activation",
    }, "default", "default", lifecycleOptions);

    assert.equal(typeof result.commit_id, "string");
    const after = await nodeState(store, nodeId);
    await assertAuthorityCommit({
      database,
      store,
      commitId: result.commit_id!,
      authorityKind: "nodes_activate",
      before,
      after,
      parentCommitId: parent.commitId,
      parentRevision: parent.revision,
    });
    const slots = parseCanonicalJson(after.slotsJson) as Record<string, unknown>;
    assert.equal(slots.feedback_positive, 1);
    assert.equal(slots.last_feedback_run_id, "run-authority-activate-1");
    assert.equal(slots.last_activated_at, "2026-07-18T01:02:03.000Z");
  } finally {
    await store.close();
    await database.close();
  }
});

test("unused-exposure learning control records a full-row v2 authority mutation", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("learning-control-v2"));
  const store = createLiteWriteStoreFromDatabase(database);
  const nodeId = randomUUID();
  try {
    await seedNodes(store, [{
      id: nodeId,
      tier: "warm",
      title: "Repeatedly exposed workflow",
      textSummary: "Inspect this workflow before another use",
      slots: { exposure_count: 3, positive_attributed_use_count: 0 },
    }]);
    const before = await nodeState(store, nodeId);
    const parent = await store.readScopeHead("default");
    assert.ok(parent);

    const result = await applyUnusedExposureLearningControlLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      run_id: "run-learning-control-1",
      guide_trace_id: "guide-learning-control-1",
      recorded_at: "2026-07-18T02:03:04.000Z",
      reason: "repeated exposure remained unattributed",
      memory_stats: [{
        memory_id: nodeId,
        repeated_without_positive_attribution: true,
        exposure_count: 3,
        positive_attributed_use_count: 0,
      }],
    }, "default", "default", lifecycleOptions);

    assert.equal(result.changed_count, 1);
    const after = await nodeState(store, nodeId);
    await assertAuthorityCommit({
      database,
      store,
      commitId: result.commit_id,
      authorityKind: "feedback_learning_control_inspect_before_use",
      before,
      after,
      parentCommitId: parent.commitId,
      parentRevision: parent.revision,
    });
    const slots = parseCanonicalJson(after.slotsJson) as Record<string, unknown>;
    assert.equal(slots.feedback_learning_control_posture, "inspect_before_use");
    assert.equal(
      slots.feedback_learning_control_source,
      "repeated_unused_without_positive_attribution",
    );
  } finally {
    await store.close();
    await database.close();
  }
});

test("lifecycle no-ops return the current head without manufacturing a revision", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("no-op"));
  const store = createLiteWriteStoreFromDatabase(database);
  const nodeId = randomUUID();
  try {
    await seedNodes(store, [{
      id: nodeId,
      tier: "hot",
      title: "Positively attributed workflow",
      textSummary: "Do not demote a workflow with positive host attribution",
      slots: { feedback_positive: 1, positive_attributed_use_count: 1 },
    }]);
    const before = await nodeState(store, nodeId);
    const head = await store.readScopeHead("default");
    assert.ok(head);
    const beforeCommitCount = commitCount(database);

    const learningResult = await applyUnusedExposureLearningControlLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory_stats: [{
        memory_id: nodeId,
        repeated_without_positive_attribution: true,
        exposure_count: 5,
        positive_attributed_use_count: 0,
      }],
    }, "default", "default", lifecycleOptions);
    assert.equal(learningResult.changed_count, 0);
    assert.equal(learningResult.commit_id, head.commitId);

    const rehydrateResult = await rehydrateArchiveNodesLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      node_ids: [nodeId],
      target_tier: "hot",
      input_text: "already at the requested tier",
    }, "default", "default", lifecycleOptions);
    assert.equal(rehydrateResult.commit_id, null);
    assert.equal(rehydrateResult.rehydrated.moved_nodes, 0);
    assert.equal(commitCount(database), beforeCommitCount);
    assert.deepEqual(await store.readScopeHead("default"), head);
    assert.deepEqual(await nodeState(store, nodeId), before);
  } finally {
    await store.close();
    await database.close();
  }
});

test("default head fence rejects an intervening commit before stale lifecycle patches apply", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("stale-head"));
  const store = createLiteWriteStoreFromDatabase(database);
  const nodeId = randomUUID();
  const concurrentNodeId = randomUUID();
  try {
    await seedNodes(store, [{
      id: nodeId,
      tier: "archive",
      title: "Stale lifecycle target",
      textSummary: "This target must not be overwritten from a stale read",
      slots: { lifecycle_state: "archived" },
    }]);
    const before = await nodeState(store, nodeId);
    const originalHead = await store.readScopeHead("default");
    assert.ok(originalHead);
    const concurrentPrepared = await prepareMemoryWrite({
      tenant_id: "default",
      scope: "default",
      actor: "concurrent-writer",
      input_text: "intervening authoritative write",
      auto_embed: false,
      nodes: [{
        id: concurrentNodeId,
        type: "concept",
        tier: "warm",
        memory_lane: "shared",
        title: "Intervening authority node",
        text_summary: "Advance the scope head between lifecycle read and apply",
        slots: { source: "stale-head-test" },
      }],
      edges: [],
    }, "default", "default", writeOptions, null);
    let injected = false;
    const staleStore = {
      ...store,
      async findNodes(args: Parameters<LiteWriteStore["findNodes"]>[0]) {
        const result = await store.findNodes(args);
        if (!injected) {
          injected = true;
          await store.withTx(() => applyMemoryWrite(concurrentPrepared, {
            ...writeOptions,
            write_access: store,
          }));
        }
        return result;
      },
    } satisfies LiteWriteStore;

    await assert.rejects(
      () => rehydrateArchiveNodesLite(staleStore, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        node_ids: [nodeId],
        target_tier: "hot",
        input_text: "attempt stale archive rehydrate",
      }, "default", "default", lifecycleOptions),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "scope_head_conflict");
        return true;
      },
    );
    assert.equal(injected, true);
    assert.deepEqual(await nodeState(store, nodeId), before);
    const currentHead = await store.readScopeHead("default");
    assert.equal(currentHead?.revision, originalHead.revision + 1);
    assert.equal((await nodeState(store, concurrentNodeId)).commitId, currentHead?.commitId);
    assert.equal(commitCount(database), 2);
  } finally {
    await store.close();
    await database.close();
  }
});

test("full-row read-after verification rolls back an unplanned persisted-column mutation", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("read-after-rollback"));
  const store = createLiteWriteStoreFromDatabase(database);
  const nodeId = randomUUID();
  try {
    await seedNodes(store, [{
      id: nodeId,
      tier: "warm",
      title: "Immutable title under activation",
      textSummary: "Activation may update feedback fields but not the title",
      slots: { source: "read-after-rollback-test" },
    }]);
    const before = await nodeState(store, nodeId);
    const head = await store.readScopeHead("default");
    assert.ok(head);
    const beforeCommitCount = commitCount(database);
    const beforeSideEffects = durableNodeSideEffects(database, nodeId);
    const tamperingStore = {
      ...store,
      async updateNodeAnchorState(args: Parameters<LiteWriteStore["updateNodeAnchorState"]>[0]) {
        const updated = await store.updateNodeAnchorState(args);
        database.db.prepare(
          "UPDATE lite_memory_nodes SET title = ? WHERE scope = ? AND id = ?",
        ).run("unplanned title mutation", args.scope, args.id);
        return updated;
      },
    } satisfies LiteWriteStore;

    await assert.rejects(
      () => activateMemoryNodesLite(tamperingStore, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        node_ids: [nodeId],
        run_id: "run-read-after-tamper",
        feedback_recorded_at: "2026-07-18T03:04:05.000Z",
        outcome: "positive",
        activate: true,
        input_text: "verify exact full-row rollback",
      }, "default", "default", lifecycleOptions),
      /applied_authority_read_after_verification_mismatch/u,
    );
    assert.deepEqual(await nodeState(store, nodeId), before);
    assert.deepEqual(await store.readScopeHead("default"), head);
    assert.equal(commitCount(database), beforeCommitCount);
    assert.deepEqual(durableNodeSideEffects(database, nodeId), beforeSideEffects);
  } finally {
    await store.close();
    await database.close();
  }
});
