import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { EmbeddingProvider } from "../../src/embeddings/types.ts";
import {
  applyReplayLearningProjection,
  type ReplayLearningProjectionResolvedConfig,
} from "../../src/memory/replay-learning.ts";
import { ensureStablePlaybookAnchorOnLatestNode } from "../../src/memory/replay-stable-anchor-helpers.ts";
import {
  applyReplayMemoryWrite,
  type ReplayMirrorNodeRecord,
  type ReplayWriteMirror,
} from "../../src/memory/replay-write.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { SELF_COMMIT_REFERENCE } from "../../src/memory/write-serialization.ts";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStoreFromDatabase,
  type LiteFindNodeRow,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.ts";
import type { WriteExistingNodeState } from "../../src/store/write-access.ts";
import { APPLIED_AUTHORITY_TABLE_CONTRACTS } from "../../src/store/write-commit-authority.ts";
import { HttpError } from "../../src/util/http.ts";
import { stableUuid } from "../../src/util/uuid.ts";

const writeOptions = {
  maxTextLen: 10_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
} as const;

const projectionConfig: ReplayLearningProjectionResolvedConfig = {
  enabled: true,
  mode: "rule_and_episode",
  delivery: "sync_inline",
  target_rule_state: "draft",
  min_total_steps: 1,
  min_success_ratio: 1,
  max_matcher_bytes: 16_384,
  max_tool_prefer: 8,
  episode_ttl_days: 30,
};

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-replay-node-authority-"));
  return path.join(dir, `${name}.sqlite`);
}

function commitCount(database: LiteRuntimeDatabase): number {
  const row = database.db.prepare(
    "SELECT COUNT(*) AS count FROM lite_memory_commits WHERE scope = ?",
  ).get("default") as { count: number };
  return Number(row.count);
}

async function nodeState(store: LiteWriteStore, id: string): Promise<WriteExistingNodeState> {
  const state = (await store.nodeStatesByIds("default", [id])).get(id);
  assert.ok(state);
  return state;
}

async function visibleNode(
  store: LiteWriteStore,
  id: string,
  consumerAgentId: string | null = "local-user",
): Promise<LiteFindNodeRow> {
  const { rows } = await store.findNodes({
    scope: "default",
    id,
    consumerAgentId,
    consumerTeamId: null,
    limit: 1,
    offset: 0,
  });
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function seedNode(args: {
  store: LiteWriteStore;
  id: string;
  type: "procedure" | "concept";
  title: string;
  textSummary: string;
  slots: Record<string, unknown>;
  memoryLane?: "private" | "shared";
  ownerAgentId?: string | null;
  actor?: string;
}) {
  const actor = args.actor ?? "local-user";
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor,
    input_text: `seed replay authority fixture ${args.id}`,
    auto_embed: false,
    nodes: [{
      id: args.id,
      type: args.type,
      tier: "warm",
      memory_lane: args.memoryLane ?? "private",
      producer_agent_id: actor,
      owner_agent_id: args.ownerAgentId === undefined ? actor : args.ownerAgentId,
      title: args.title,
      text_summary: args.textSummary,
      slots: args.slots,
      salience: 0.61,
      importance: 0.72,
      confidence: 0.83,
    }],
    edges: [],
  }, "default", "default", writeOptions, null);
  return await args.store.withTx(() => applyMemoryWrite(prepared, {
    ...writeOptions,
    write_access: args.store,
  }));
}

function stablePlaybookSlots(playbookId: string): Record<string, unknown> {
  return {
    replay_kind: "playbook",
    playbook_id: playbookId,
    version: 1,
    status: "active",
    name: "Recover the export workflow",
    matchers: { task_kind: "export_recovery" },
    steps_template: [{
      step_index: 1,
      tool_name: "edit",
      preconditions: [],
      postconditions: [],
      safety_level: "needs_confirm",
    }],
  };
}

function latestPlaybook(row: LiteFindNodeRow) {
  return {
    ...row,
    version_num: 1,
    playbook_status: "active",
  } as any;
}

function countingEmbedder() {
  const calls = { count: 0 };
  const embedder: EmbeddingProvider = {
    name: "replay-authority-test-v1",
    dim: 1_536,
    async embed(texts) {
      calls.count += 1;
      return texts.map(() => Array.from({ length: 1_536 }, (_, index) => (index + 1) / 10_000));
    },
  };
  return { calls, embedder };
}

function recordingMirror() {
  const writes: ReplayMirrorNodeRecord[][] = [];
  const mirror: ReplayWriteMirror = {
    async upsertReplayNodes(entries) {
      writes.push(entries);
    },
  };
  return { mirror, writes };
}

function replayWriteNodeId(runId: string): string {
  return stableUuid(`default:node:replay:run:${runId}:start`);
}

function replayWriteRequest(runId: string) {
  const nodeId = replayWriteNodeId(runId);
  return {
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    input_text: `record replay run ${runId}`,
    auto_embed: false,
    memory_lane: "shared" as const,
    nodes: [{
      id: nodeId,
      client_id: `replay:run:${runId}:start`,
      type: "event",
      title: "Replay run started",
      text_summary: "Record a replay run authority boundary",
      slots: {
        replay_kind: "run_start",
        run_id: runId,
      },
    }],
    edges: [],
  };
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

test("replay memory write commits one SQLite authority transaction before mirroring", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("write-transaction"));
  const store = createLiteWriteStoreFromDatabase(database);
  const runId = randomUUID();
  const nodeId = replayWriteNodeId(runId);
  const mirrorWrites: ReplayMirrorNodeRecord[][] = [];
  const mirror: ReplayWriteMirror = {
    async upsertReplayNodes(entries) {
      assert.equal(store.transactionRunner().inTransaction(), false);
      assert.equal(commitCount(database), 1);
      assert.ok((await store.nodeStatesByIds("default", [nodeId])).has(nodeId));
      mirrorWrites.push(entries);
    },
  };
  try {
    const result = await applyReplayMemoryWrite(replayWriteRequest(runId), {
      defaultScope: "default",
      defaultTenantId: "default",
      ...writeOptions,
      embedder: null,
      writeAccess: store,
      replayMirror: mirror,
    });

    const head = await store.readScopeHead("default");
    assert.ok(head);
    assert.equal(head.revision, 1);
    assert.equal(head.commitId, result.out.commit_id);
    assert.equal(mirrorWrites.length, 1);
    assert.equal(mirrorWrites[0]?.length, 1);
    assert.equal(mirrorWrites[0]?.[0]?.node_id, nodeId);
    assert.equal(mirrorWrites[0]?.[0]?.commit_id, result.out.commit_id);
  } finally {
    await store.close();
    await database.close();
  }
});

test("replay memory write rolls back commit and node when the shared transaction fails", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("write-rollback"));
  const store = createLiteWriteStoreFromDatabase(database);
  const runId = randomUUID();
  const nodeId = replayWriteNodeId(runId);
  let mirrorCalls = 0;
  const failingStore = {
    ...store,
    async insertNode(args: Parameters<LiteWriteStore["insertNode"]>[0]) {
      await store.insertNode(args);
      throw new Error("injected replay node failure");
    },
  } satisfies LiteWriteStore;
  try {
    await assert.rejects(
      () => applyReplayMemoryWrite(replayWriteRequest(runId), {
        defaultScope: "default",
        defaultTenantId: "default",
        ...writeOptions,
        embedder: null,
        writeAccess: failingStore,
        replayMirror: {
          async upsertReplayNodes() {
            mirrorCalls += 1;
          },
        },
      }),
      /injected replay node failure/u,
    );

    assert.equal(commitCount(database), 0);
    assert.equal((await store.nodeStatesByIds("default", [nodeId])).size, 0);
    assert.equal(await store.readScopeHead("default"), null);
    assert.equal(mirrorCalls, 0);
  } finally {
    await store.close();
    await database.close();
  }
});

test("replay mirror failure happens after authority commit and cannot roll it back", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("write-mirror-failure"));
  const store = createLiteWriteStoreFromDatabase(database);
  const runId = randomUUID();
  const nodeId = replayWriteNodeId(runId);
  try {
    await assert.rejects(
      () => applyReplayMemoryWrite(replayWriteRequest(runId), {
        defaultScope: "default",
        defaultTenantId: "default",
        ...writeOptions,
        embedder: null,
        writeAccess: store,
        replayMirror: {
          async upsertReplayNodes() {
            assert.equal(store.transactionRunner().inTransaction(), false);
            throw new Error("injected replay mirror failure");
          },
        },
      }),
      /injected replay mirror failure/u,
    );

    const head = await store.readScopeHead("default");
    assert.ok(head);
    assert.equal(head.revision, 1);
    assert.equal(commitCount(database), 1);
    const persisted = (await store.nodeStatesByIds("default", [nodeId])).get(nodeId);
    assert.ok(persisted);
    assert.equal(persisted.commitId, head.commitId);
  } finally {
    await store.close();
    await database.close();
  }
});

test("replay memory write joins an ambient transaction and defers mirror until outer commit", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("write-ambient-transaction"));
  const store = createLiteWriteStoreFromDatabase(database);
  const runId = randomUUID();
  const nodeId = replayWriteNodeId(runId);
  let mirrorCalls = 0;
  try {
    let commitId: string | null = null;
    await store.withTx(async () => {
      const result = await applyReplayMemoryWrite(replayWriteRequest(runId), {
        defaultScope: "default",
        defaultTenantId: "default",
        ...writeOptions,
        embedder: null,
        writeAccess: store,
        replayMirror: {
          async upsertReplayNodes() {
            assert.equal(store.transactionRunner().inTransaction(), false);
            mirrorCalls += 1;
          },
        },
      });
      commitId = result.out.commit_id;
      assert.equal(store.transactionRunner().inTransaction(), true);
      assert.equal(mirrorCalls, 0);
      assert.ok((await store.nodeStatesByIds("default", [nodeId])).has(nodeId));
    });

    assert.equal(commitCount(database), 1);
    assert.ok((await store.nodeStatesByIds("default", [nodeId])).has(nodeId));
    assert.equal((await store.readScopeHead("default"))?.commitId, commitId);
    assert.equal(mirrorCalls, 1);
  } finally {
    await store.close();
    await database.close();
  }
});

test("stable replay normalization records full authority state, preserves privacy, and repeats as a true no-op", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("stable-authority"));
  const store = createLiteWriteStoreFromDatabase(database);
  const playbookId = randomUUID();
  const nodeId = randomUUID();
  const { calls, embedder } = countingEmbedder();
  const { mirror, writes } = recordingMirror();
  try {
    await seedNode({
      store,
      id: nodeId,
      type: "procedure",
      title: "Recover the export workflow",
      textSummary: "Use the verified edit step to recover exports",
      slots: stablePlaybookSlots(playbookId),
    });
    const before = await nodeState(store, nodeId);
    const initial = await visibleNode(store, nodeId);
    const parent = await store.readScopeHead("default");
    assert.ok(parent);

    const normalized = await ensureStablePlaybookAnchorOnLatestNode({
      embedder,
      writeAccess: store,
      replayMirror: mirror,
      tenancy: { tenant_id: "default", scope: "default", scope_key: "default" },
      visibility: { consumerAgentId: "local-user", consumerTeamId: null },
      playbookId,
      latest: latestPlaybook(initial),
    });
    assert.equal(normalized?.mutated, true);
    assert.equal(calls.count, 1);
    assert.equal(writes.length, 1);

    const head = await store.readScopeHead("default");
    assert.ok(head);
    assert.equal(head.revision, parent.revision + 1);
    assert.equal(normalized?.node.commit_id, head.commitId);
    assert.equal(normalized?.node.embedding_status, "ready");
    assert.equal(normalized?.node.embedding_model, embedder.name);
    assert.equal(writes[0]?.[0]?.commit_id, head.commitId);

    const commit = database.db.prepare(
      `SELECT parent_commit_id, diff_json, revision
       FROM lite_memory_commits
       WHERE scope = ? AND id = ?`,
    ).get("default", head.commitId) as {
      parent_commit_id: string | null;
      diff_json: string;
      revision: number;
    } | undefined;
    assert.ok(commit);
    assert.equal(commit.parent_commit_id, parent.commitId);
    const diff = JSON.parse(commit.diff_json) as any;
    assert.equal(diff.contract, "aionis_applied_authority_mutation_v2");
    assert.equal(diff.authority_kind, "replay_stable_anchor_normalization");
    assert.equal(diff.mutations.length, 1);
    const mutation = diff.mutations[0];
    const rowKeys = [...APPLIED_AUTHORITY_TABLE_CONTRACTS.lite_memory_nodes.rowKeys].sort();
    assert.deepEqual(Object.keys(mutation.before).sort(), rowKeys);
    assert.deepEqual(Object.keys(mutation.after).sort(), rowKeys);
    assert.equal(mutation.after.commit_id, SELF_COMMIT_REFERENCE);
    assert.equal(mutation.before.commit_id, before.commitId);
    assert.deepEqual(mutation.before.embedding_vector_json, null);
    assert.deepEqual(mutation.after.embedding_vector_json, null);
    assert.equal(mutation.after.embedding_status, mutation.before.embedding_status);
    assert.equal(mutation.after.embedding_last_error, mutation.before.embedding_last_error);
    assert.equal(mutation.after.slots_json.anchor_v1.workflow_promotion.promotion_origin, "replay_stable_normalization");

    const commitsBeforeRepeat = commitCount(database);
    const repeated = await ensureStablePlaybookAnchorOnLatestNode({
      embedder,
      writeAccess: store,
      replayMirror: mirror,
      tenancy: { tenant_id: "default", scope: "default", scope_key: "default" },
      visibility: { consumerAgentId: "local-user", consumerTeamId: null },
      playbookId,
      latest: latestPlaybook(normalized!.node),
    });
    assert.equal(repeated?.mutated, false);
    assert.equal(calls.count, 2);
    assert.equal(writes.length, 1);
    assert.equal(commitCount(database), commitsBeforeRepeat);
    assert.deepEqual(await store.readScopeHead("default"), head);

    const embedCallsBeforePrivateDenial = calls.count;
    await assert.rejects(
      () => ensureStablePlaybookAnchorOnLatestNode({
        embedder,
        writeAccess: store,
        replayMirror: mirror,
        tenancy: { tenant_id: "default", scope: "default", scope_key: "default" },
        visibility: { consumerAgentId: null, consumerTeamId: null },
        playbookId,
        latest: latestPlaybook(normalized!.node),
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 404);
        return true;
      },
    );
    assert.equal(calls.count, embedCallsBeforePrivateDenial);
    assert.equal(writes.length, 1);
    assert.deepEqual(await store.readScopeHead("default"), head);
  } finally {
    await store.close();
    await database.close();
  }
});

test("stable replay normalization rejects a stale head before authority or derived projections apply", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("stable-stale"));
  const store = createLiteWriteStoreFromDatabase(database);
  const playbookId = randomUUID();
  const nodeId = randomUUID();
  const concurrentNodeId = randomUUID();
  const { calls, embedder } = countingEmbedder();
  const { mirror, writes } = recordingMirror();
  try {
    await seedNode({
      store,
      id: nodeId,
      type: "procedure",
      title: "Stale stable playbook",
      textSummary: "Do not normalize from a stale scope head",
      slots: stablePlaybookSlots(playbookId),
    });
    const initial = await visibleNode(store, nodeId);
    const before = await nodeState(store, nodeId);
    const initialHead = await store.readScopeHead("default");
    assert.ok(initialHead);
    const concurrentPrepared = await prepareMemoryWrite({
      tenant_id: "default",
      scope: "default",
      actor: "concurrent-writer",
      input_text: "advance replay authority head",
      auto_embed: false,
      nodes: [{
        id: concurrentNodeId,
        type: "concept",
        memory_lane: "shared",
        title: "Concurrent authority write",
        text_summary: "Advance the head after stable anchor preparation begins",
        slots: { source: "stable-stale-test" },
      }],
      edges: [],
    }, "default", "default", writeOptions, null);
    let injected = false;
    let derivedEmbeddingWrites = 0;
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
      async setNodeEmbeddingReady(args: Parameters<LiteWriteStore["setNodeEmbeddingReady"]>[0]) {
        derivedEmbeddingWrites += 1;
        await store.setNodeEmbeddingReady(args);
      },
    } satisfies LiteWriteStore;

    await assert.rejects(
      () => ensureStablePlaybookAnchorOnLatestNode({
        embedder,
        writeAccess: staleStore,
        replayMirror: mirror,
        tenancy: { tenant_id: "default", scope: "default", scope_key: "default" },
        visibility: { consumerAgentId: "local-user", consumerTeamId: null },
        playbookId,
        latest: latestPlaybook(initial),
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "scope_head_conflict");
        return true;
      },
    );
    assert.equal(injected, true);
    assert.equal(calls.count, 1);
    assert.equal(derivedEmbeddingWrites, 0);
    assert.equal(writes.length, 0);
    assert.deepEqual(await nodeState(store, nodeId), before);
    const head = await store.readScopeHead("default");
    assert.equal(head?.revision, initialHead.revision + 1);
    assert.equal(commitCount(database), 2);
  } finally {
    await store.close();
    await database.close();
  }
});

test("stable replay full-row verification rolls back authority and leaks no derived projection", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("stable-rollback"));
  const store = createLiteWriteStoreFromDatabase(database);
  const playbookId = randomUUID();
  const nodeId = randomUUID();
  const { calls, embedder } = countingEmbedder();
  const { mirror, writes } = recordingMirror();
  try {
    await seedNode({
      store,
      id: nodeId,
      type: "procedure",
      title: "Rollback stable playbook",
      textSummary: "Reject unplanned persisted-column changes",
      slots: stablePlaybookSlots(playbookId),
    });
    const initial = await visibleNode(store, nodeId);
    const before = await nodeState(store, nodeId);
    const head = await store.readScopeHead("default");
    assert.ok(head);
    const commitsBefore = commitCount(database);
    const sideEffectsBefore = durableNodeSideEffects(database, nodeId);
    let derivedEmbeddingWrites = 0;
    const tamperingStore = {
      ...store,
      async updateNodeAnchorState(args: Parameters<LiteWriteStore["updateNodeAnchorState"]>[0]) {
        const updated = await store.updateNodeAnchorState(args);
        database.db.prepare(
          "UPDATE lite_memory_nodes SET title = ? WHERE scope = ? AND id = ?",
        ).run("unplanned replay title mutation", args.scope, args.id);
        return updated;
      },
      async setNodeEmbeddingReady(args: Parameters<LiteWriteStore["setNodeEmbeddingReady"]>[0]) {
        derivedEmbeddingWrites += 1;
        await store.setNodeEmbeddingReady(args);
      },
    } satisfies LiteWriteStore;

    await assert.rejects(
      () => ensureStablePlaybookAnchorOnLatestNode({
        embedder,
        writeAccess: tamperingStore,
        replayMirror: mirror,
        tenancy: { tenant_id: "default", scope: "default", scope_key: "default" },
        visibility: { consumerAgentId: "local-user", consumerTeamId: null },
        playbookId,
        latest: latestPlaybook(initial),
      }),
      /applied_authority_read_after_verification_mismatch/u,
    );
    assert.equal(calls.count, 1);
    assert.equal(derivedEmbeddingWrites, 0);
    assert.equal(writes.length, 0);
    assert.equal(commitCount(database), commitsBefore);
    assert.deepEqual(await store.readScopeHead("default"), head);
    assert.deepEqual(await nodeState(store, nodeId), before);
    assert.deepEqual(durableNodeSideEffects(database, nodeId), sideEffectsBefore);
  } finally {
    await store.close();
    await database.close();
  }
});

test("replay learning source-rule attachment owns the returned revision and repeats without a commit", async () => {
  const database = createLiteRuntimeDatabase(tmpDbPath("learning-attachment"));
  const store = createLiteWriteStoreFromDatabase(database);
  const playbookId = randomUUID();
  const playbookNodeId = randomUUID();
  const playbookSlots = stablePlaybookSlots(playbookId);
  try {
    const sourceWrite = await seedNode({
      store,
      id: playbookNodeId,
      type: "procedure",
      title: "Replay learning source",
      textSummary: "Project a reusable rule and learning episode",
      slots: playbookSlots,
    });
    const sourceHead = await store.readScopeHead("default");
    assert.ok(sourceHead);
    const source = {
      tenant_id: "default",
      scope: "default",
      scope_key: "default",
      actor: "local-user",
      playbook_id: playbookId,
      playbook_version: 1,
      playbook_node_id: playbookNodeId,
      playbook_title: "Replay learning source",
      playbook_summary: "Project a reusable rule and learning episode",
      playbook_slots: playbookSlots,
      source_commit_id: sourceWrite.commit_id,
      metrics: { total_steps: 1, success_ratio: 1 },
    };

    const applied = await applyReplayLearningProjection(source, projectionConfig, {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: null,
      writeAccess: store,
    });
    assert.equal(applied.status, "applied");
    assert.ok(applied.generated_rule_node_id);
    assert.ok(applied.generated_episode_node_id);
    assert.ok(applied.commit_id);
    const head = await store.readScopeHead("default");
    assert.ok(head);
    assert.equal(applied.commit_id, head.commitId);
    assert.equal(head.revision, sourceHead.revision + 2);

    const episode = await nodeState(store, applied.generated_episode_node_id!);
    assert.equal(episode.commitId, applied.commit_id);
    const episodeSlots = JSON.parse(episode.slotsJson) as Record<string, any>;
    assert.equal(episodeSlots.source_rule_node_id, applied.generated_rule_node_id);
    assert.equal(episodeSlots.replay_learning.source_rule_node_id, applied.generated_rule_node_id);
    const commit = database.db.prepare(
      "SELECT parent_commit_id, diff_json FROM lite_memory_commits WHERE scope = ? AND id = ?",
    ).get("default", applied.commit_id) as { parent_commit_id: string | null; diff_json: string } | undefined;
    assert.ok(commit);
    const diff = JSON.parse(commit.diff_json) as any;
    assert.equal(diff.authority_kind, "replay_learning_source_rule_attachment");
    assert.equal(diff.mutations.length, 1);
    const mutation = diff.mutations[0];
    const rowKeys = [...APPLIED_AUTHORITY_TABLE_CONTRACTS.lite_memory_nodes.rowKeys].sort();
    assert.deepEqual(Object.keys(mutation.before).sort(), rowKeys);
    assert.deepEqual(Object.keys(mutation.after).sort(), rowKeys);
    assert.equal(mutation.after.commit_id, SELF_COMMIT_REFERENCE);
    assert.equal(mutation.after.slots_json.source_rule_node_id, applied.generated_rule_node_id);

    const anonymousEpisode = await store.findNodes({
      scope: "default",
      id: applied.generated_episode_node_id,
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(anonymousEpisode.rows.length, 0);

    const commitsBeforeRepeat = commitCount(database);
    const repeated = await applyReplayLearningProjection(source, projectionConfig, {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: null,
      writeAccess: store,
    });
    assert.equal(repeated.commit_id, applied.commit_id);
    assert.equal(commitCount(database), commitsBeforeRepeat);
    assert.deepEqual(await store.readScopeHead("default"), head);
  } finally {
    await store.close();
    await database.close();
  }
});
