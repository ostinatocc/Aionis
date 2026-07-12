import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { drainLiteProjectionJobs } from "../../src/jobs/lite-projection-worker.ts";
import { createHandoffRouteService } from "../../src/routes/handoff.ts";
import {
  persistLitePreparedWrite,
} from "../../src/memory/lite-projected-write-commit.ts";
import { prepareMemoryWrite, type PreparedWrite, type WriteResult } from "../../src/memory/write.ts";
import { createLocalAnnIndex } from "../../src/store/ann/local-ann-index.ts";
import type { AionisLocalAnnIndex } from "../../src/store/ann/ann-index.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import {
  type LiteAnnProjectionJobClaim,
  type LiteEmbeddingProjectionJobClaim,
  parseEmbeddingProjectionPayload,
} from "../../src/store/lite-projection-outbox.ts";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.ts";
import {
  DeterministicEmbeddingProvider,
  deterministicEmbed,
} from "./support/deterministic-embedding.ts";

const WRITE_OPTIONS = {
  maxTextLen: 20_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
} as const;

type TempDatabase = {
  directory: string;
  path: string;
};

type OpenWriteRuntime = {
  database: LiteRuntimeDatabase;
  store: LiteWriteStore;
};

function createTempDatabase(name: string): TempDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-projection-${name}-`));
  return {
    directory,
    path: path.join(directory, "runtime.sqlite"),
  };
}

function openWriteRuntime(dbPath: string, annProjectionEnabled: boolean): OpenWriteRuntime {
  const database = createLiteRuntimeDatabase(dbPath);
  const store = createLiteWriteStoreFromDatabase(database, {
    closeDatabaseOnClose: true,
    annProjectionEnabled,
  });
  return { database, store };
}

function createLocalRecallRuntime(dbPath: string, index: AionisLocalAnnIndex) {
  return createLiteRecallStore(dbPath, {
    ann: {
      index,
      rebuildOnStart: false,
      maxCandidates: 32,
      sourceReason: "durable_projection_test",
      indexName: "durable_projection_test_ann",
    },
  });
}

async function findNode(store: LiteWriteStore, nodeId: string) {
  const { rows } = await store.findNodes({
    scope: "default",
    id: nodeId,
    operatorView: true,
    limit: 1,
    offset: 0,
  });
  return rows[0] ?? null;
}

async function writePendingAutoEmbedding(args: {
  store: LiteWriteStore;
  clientId: string;
  title: string;
  summary: string;
}): Promise<{
  prepared: PreparedWrite;
  result: WriteResult;
  nodeId: string;
  embedText: string;
}> {
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "projection-test",
      input_text: args.summary,
      auto_embed: true,
      nodes: [{
        client_id: args.clientId,
        type: "concept",
        title: args.title,
        text_summary: args.summary,
        memory_lane: "shared",
      }],
    },
    "default",
    "default",
    WRITE_OPTIONS,
    DeterministicEmbeddingProvider,
  );
  const result = await persistLitePreparedWrite({
    prepared,
    liteWriteStore: args.store,
    writeOptions: WRITE_OPTIONS,
  });
  const nodeId = result.nodes[0]?.id;
  const embedText = prepared.nodes[0]?.embed_text;
  assert.ok(nodeId);
  assert.ok(embedText);
  return { prepared, result, nodeId, embedText };
}

async function writeReadyEmbedding(args: {
  store: LiteWriteStore;
  clientId: string;
  title: string;
  summary: string;
  vector: number[];
}): Promise<{ result: WriteResult; nodeId: string }> {
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "projection-test",
      input_text: args.summary,
      auto_embed: false,
      nodes: [{
        client_id: args.clientId,
        type: "concept",
        title: args.title,
        text_summary: args.summary,
        embedding: args.vector,
        embedding_model: DeterministicEmbeddingProvider.name,
        memory_lane: "shared",
      }],
    },
    "default",
    "default",
    WRITE_OPTIONS,
    null,
  );
  const result = await persistLitePreparedWrite({
    prepared,
    liteWriteStore: args.store,
    writeOptions: WRITE_OPTIONS,
  });
  const nodeId = result.nodes[0]?.id;
  assert.ok(nodeId);
  return { result, nodeId };
}

async function searchLocalAnn(args: {
  index: AionisLocalAnnIndex;
  vector: number[];
  nodeId: string;
}): Promise<boolean> {
  const rows = await args.index.search({
    scope: "default",
    embeddingModel: DeterministicEmbeddingProvider.name,
    vector: args.vector,
    limit: 10,
  });
  return rows.some((row) => row.node_id === args.nodeId);
}

test("durable projection resumes embedding and ANN after commit-time process loss", async () => {
  const temp = createTempDatabase("restart");
  let second: OpenWriteRuntime | null = null;
  let recallStore: ReturnType<typeof createLiteRecallStore> | null = null;
  try {
    const childPath = fileURLToPath(new URL("./support/projection-commit-crash-child.ts", import.meta.url));
    const crashed = spawnSync(process.execPath, ["--import", "tsx", childPath, temp.path], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(crashed.status, 73, `crash child stderr: ${crashed.stderr}`);

    second = openWriteRuntime(temp.path, true);
    const { rows: committedRows } = await second.store.findNodes({
      scope: "default",
      clientId: "projection:real-process-crash",
      limit: 1,
      offset: 0,
    });
    const committedNode = committedRows[0];
    assert.ok(committedNode);
    assert.equal(committedNode.embedding_status, "pending");
    const jobsBeforeRestart = await second.store.listProjectionJobs({ limit: 10 });
    assert.equal(
      jobsBeforeRestart.find((job) => job.node_id === committedNode.id && job.job_kind === "embedding_generate")?.status,
      "pending",
    );
    const annIndex = createLocalAnnIndex();
    recallStore = createLocalRecallRuntime(temp.path, annIndex);
    const drained = await drainLiteProjectionJobs({
      store: second.store,
      embedder: DeterministicEmbeddingProvider,
      ann: {
        reconcileNode: (scope, nodeId) => recallStore!.syncAnnNode(scope, nodeId),
      },
      annEnabled: true,
      limit: 10,
      leaseOwner: "restart-worker",
      leaseMs: 5_000,
      timeoutMs: 2_000,
    });

    assert.equal(drained.embedding_completed, 1);
    assert.ok(drained.ann_completed >= 1);
    const nodeAfterRestart = await findNode(second.store, committedNode.id);
    assert.equal(nodeAfterRestart?.embedding_status, "ready");
    assert.equal(nodeAfterRestart?.embedding_model, DeterministicEmbeddingProvider.name);

    const completedJobs = await second.store.listProjectionJobs({ limit: 10 });
    const embeddingJob = completedJobs.find((job) => (
      job.node_id === committedNode.id && job.job_kind === "embedding_generate"
    ));
    const annJob = completedJobs.find((job) => (
      job.node_id === committedNode.id && job.job_kind === "ann_reconcile"
    ));
    assert.equal(embeddingJob?.status, "succeeded");
    assert.equal(embeddingJob?.payload_json, null);
    assert.equal(annJob?.status, "succeeded");
    assert.equal(annJob?.payload_json, null);
    assert.equal(
      await searchLocalAnn({
        index: annIndex,
        vector: deterministicEmbed("Real process crash projection"),
        nodeId: committedNode.id,
      }),
      true,
    );
  } finally {
    if (recallStore) await recallStore.close();
    if (second) await second.store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("ANN side effect before acknowledgement is replayed after lease expiry", async () => {
  const temp = createTempDatabase("ann-lease-replay");
  const runtime = openWriteRuntime(temp.path, true);
  const annIndex = createLocalAnnIndex();
  const recallStore = createLocalRecallRuntime(temp.path, annIndex);
  try {
    const vector = deterministicEmbed("lease replay vector");
    const written = await writeReadyEmbedding({
      store: runtime.store,
      clientId: "projection:ann-lease-replay",
      title: "ANN lease replay",
      summary: "Reconcile may finish immediately before the worker process disappears.",
      vector,
    });
    const claimAt = new Date(Date.now() + 100);
    const firstClaims = await runtime.store.claimProjectionJobs({
      leaseOwner: "ann-worker-before-crash",
      leaseMs: 1_000,
      limit: 1,
      jobKinds: ["ann_reconcile"],
      nodeIds: [written.nodeId],
      now: claimAt,
    });
    assert.equal(firstClaims.length, 1);
    assert.equal(firstClaims[0]?.job_kind, "ann_reconcile");
    const firstClaim = firstClaims[0] as LiteAnnProjectionJobClaim;

    // The side effect succeeds, then the process disappears before completeAnnProjection.
    const firstSync = await recallStore.syncAnnNode(firstClaim.scope, firstClaim.node_id);
    assert.equal(firstSync.action, "upserted");
    assert.equal(await searchLocalAnn({ index: annIndex, vector, nodeId: written.nodeId }), true);

    const beforeExpiry = await runtime.store.claimProjectionJobs({
      leaseOwner: "ann-worker-too-early",
      leaseMs: 1_000,
      limit: 1,
      jobKinds: ["ann_reconcile"],
      nodeIds: [written.nodeId],
      now: new Date(new Date(firstClaim.lease_expires_at).getTime() - 1),
    });
    assert.equal(beforeExpiry.length, 0);

    const replayClaims = await runtime.store.claimProjectionJobs({
      leaseOwner: "ann-worker-after-restart",
      leaseMs: 1_000,
      limit: 1,
      jobKinds: ["ann_reconcile"],
      nodeIds: [written.nodeId],
      now: new Date(new Date(firstClaim.lease_expires_at).getTime() + 1),
    });
    assert.equal(replayClaims.length, 1);
    const replayClaim = replayClaims[0] as LiteAnnProjectionJobClaim;
    assert.notEqual(replayClaim.lease_token, firstClaim.lease_token);
    assert.equal(await runtime.store.completeAnnProjection({ claim: firstClaim }), false);

    const replaySync = await recallStore.syncAnnNode(replayClaim.scope, replayClaim.node_id);
    assert.equal(replaySync.action, "upserted");
    assert.equal(await runtime.store.completeAnnProjection({ claim: replayClaim }), true);
    const [completed] = await runtime.store.listProjectionJobs({
      jobKinds: ["ann_reconcile"],
      limit: 1,
    });
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.attempt_count, 2);
  } finally {
    await recallStore.close();
    await runtime.store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("a stale ANN side effect creates a fresh reconcile intent after CAS rejection", async () => {
  const temp = createTempDatabase("ann-stale-side-effect");
  const runtime = openWriteRuntime(temp.path, true);
  try {
    const written = await writeReadyEmbedding({
      store: runtime.store,
      clientId: "projection:ann-stale-side-effect",
      title: "ANN stale side effect",
      summary: "A newer generation must always receive a final reconcile.",
      vector: deterministicEmbed("ANN stale side effect"),
    });
    const first = await drainLiteProjectionJobs({
      store: runtime.store,
      embedder: null,
      annEnabled: true,
      ann: {
        reconcileNode: async (scope, nodeId) => {
          await runtime.store.withTx(async () => {
            await runtime.store.enqueueAnnProjection({
              scope,
              nodeId,
              sourceCommitId: written.result.commit_id,
            });
          });
        },
      },
      limit: 1,
      leaseOwner: "stale-ann-worker",
      jobKinds: ["ann_reconcile"],
      nodeIds: [written.nodeId],
    });
    assert.equal(first.stale_claims, 1);
    const [repair] = await runtime.store.listProjectionJobs({
      jobKinds: ["ann_reconcile"],
      limit: 1,
    });
    assert.equal(repair?.status, "pending");
    assert.ok((repair?.generation ?? 0) >= 3);

    const second = await drainLiteProjectionJobs({
      store: runtime.store,
      embedder: null,
      annEnabled: true,
      ann: { reconcileNode: async () => undefined },
      limit: 1,
      leaseOwner: "repair-ann-worker",
      jobKinds: ["ann_reconcile"],
      nodeIds: [written.nodeId],
    });
    assert.equal(second.ann_completed, 1);
  } finally {
    await runtime.store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("handoff receipt and embedding intent survive the same immediate post-commit crash", async () => {
  const temp = createTempDatabase("handoff-crash");
  const childPath = fileURLToPath(new URL("./support/handoff-projection-crash-child.ts", import.meta.url));
  const crashed = spawnSync(process.execPath, ["--import", "tsx", childPath, temp.path], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(crashed.status, 74, `handoff crash child stderr: ${crashed.stderr}`);

  const runtime = openWriteRuntime(temp.path, false);
  try {
    const stored = runtime.database.readDb.prepare(
      `SELECT receipt_json FROM lite_runtime_write_operations
       WHERE operation_kind = 'handoff_store_v1' AND operation_id = 'handoff-crash-op'`,
    ).get() as { receipt_json: string } | undefined;
    assert.ok(stored);
    const service = createHandoffRouteService({
      env: {
        AIONIS_EDITION: "lite",
        APP_ENV: "test",
        MEMORY_TENANT_ID: "default",
        MEMORY_SCOPE: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 20_000,
        PII_REDACTION: false,
        ALLOW_CROSS_SCOPE_EDGES: false,
        MEMORY_LIFECYCLE_RELATION_HTTP_MODEL_PROVIDER_ENABLED: false,
        WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
        EXECUTION_TREE_DEFAULT_ENABLED: false,
        LITE_INLINE_EMBEDDING_TIMEOUT_MS: 1_000,
      } as any,
      embedder: DeterministicEmbeddingProvider,
      liteWriteStore: runtime.store,
      executionStateStore: null,
      executionTreeStore: null,
    });
    const payload = {
      operation_id: "handoff-crash-op",
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      producer_agent_id: "local-user",
      owner_agent_id: "local-user",
      memory_lane: "private" as const,
      anchor: "handoff-projection-crash",
      handoff_kind: "task_handoff" as const,
      title: "Handoff projection crash",
      summary: "Commit the handoff receipt and durable embedding intent together.",
      handoff_text: "Resume after the process restarts.",
      target_files: ["src/routes/handoff.ts"],
      next_action: "Replay the receipt and recover the queued embedding.",
    };
    const replayed = await service.store(payload);
    assert.deepEqual(replayed, JSON.parse(stored.receipt_json));
    const [embeddingJob] = await runtime.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      statuses: ["pending"],
      limit: 10,
    });
    assert.ok(embeddingJob);
    const drained = await drainLiteProjectionJobs({
      store: runtime.store,
      embedder: DeterministicEmbeddingProvider,
      ann: null,
      annEnabled: false,
      limit: 10,
      leaseOwner: "handoff-restart-worker",
      timeoutMs: 2_000,
    });
    assert.ok(drained.embedding_completed >= 1);
    assert.equal((await findNode(runtime.store, embeddingJob.node_id))?.embedding_status, "ready");
  } finally {
    await runtime.store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("generation bump prevents an old embedding lease from completing", async () => {
  const temp = createTempDatabase("generation-cas");
  const runtime = openWriteRuntime(temp.path, true);
  try {
    const written = await writePendingAutoEmbedding({
      store: runtime.store,
      clientId: "projection:generation-cas",
      title: "Projection generation CAS",
      summary: "A superseded projection worker must not publish its old vector.",
    });
    const [claimed] = await runtime.store.claimProjectionJobs({
      leaseOwner: "old-embedding-worker",
      leaseMs: 5_000,
      limit: 1,
      jobKinds: ["embedding_generate"],
      nodeIds: [written.nodeId],
    });
    assert.equal(claimed?.job_kind, "embedding_generate");
    const oldClaim = claimed as LiteEmbeddingProjectionJobClaim;
    const payload = parseEmbeddingProjectionPayload(oldClaim);
    assert.ok(payload);

    await runtime.store.withTx(async () => {
      await runtime.store.enqueueEmbeddingProjection({
        scope: oldClaim.scope,
        nodeId: oldClaim.node_id,
        sourceCommitId: oldClaim.source_commit_id!,
        payload,
      });
    });

    const completion = await runtime.store.completeEmbeddingProjection({
      claim: oldClaim,
      embedding: deterministicEmbed(payload.embed_text),
      embeddingModel: payload.provider_name,
      enqueueAnn: true,
    });
    assert.equal(completion, "stale_claim");
    assert.equal((await findNode(runtime.store, written.nodeId))?.embedding_status, "pending");

    const [current] = await runtime.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      limit: 1,
    });
    assert.equal(current?.generation, oldClaim.generation + 1);
    assert.equal(current?.status, "pending");
    assert.equal(current?.lease_token, null);
  } finally {
    await runtime.store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("projection enqueue failure rolls back the semantic commit", async () => {
  const temp = createTempDatabase("enqueue-rollback");
  const runtime = openWriteRuntime(temp.path, false);
  try {
    runtime.database.db.exec(`
      CREATE TRIGGER fail_embedding_projection_enqueue
      BEFORE INSERT ON lite_memory_projection_jobs
      WHEN NEW.job_kind = 'embedding_generate'
      BEGIN
        SELECT RAISE(ABORT, 'injected projection enqueue failure');
      END;
    `);
    await assert.rejects(
      writePendingAutoEmbedding({
        store: runtime.store,
        clientId: "projection:enqueue-rollback",
        title: "Projection enqueue rollback",
        summary: "The memory row cannot commit without its durable embedding intent.",
      }),
      /injected projection enqueue failure/,
    );
    const counts = runtime.database.readDb.prepare(
      `SELECT
         (SELECT COUNT(*) FROM lite_memory_commits) AS commits,
         (SELECT COUNT(*) FROM lite_memory_nodes) AS nodes,
         (SELECT COUNT(*) FROM lite_memory_projection_jobs) AS projection_jobs`,
    ).get() as { commits: number; nodes: number; projection_jobs: number };
    assert.equal(counts.commits, 0);
    assert.equal(counts.nodes, 0);
    assert.equal(counts.projection_jobs, 0);
  } finally {
    await runtime.store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("corrupt embedding payload hash is retained as a dead letter", async () => {
  const temp = createTempDatabase("payload-corruption");
  const runtime = openWriteRuntime(temp.path, false);
  try {
    const written = await writePendingAutoEmbedding({
      store: runtime.store,
      clientId: "projection:payload-corruption",
      title: "Projection payload corruption",
      summary: "A corrupt durable payload must fail closed without disappearing.",
    });
    await runtime.database.withTx(async () => {
      runtime.database.db.prepare(
        `UPDATE lite_memory_projection_jobs
         SET payload_sha256 = ?
         WHERE scope = ? AND node_id = ? AND job_kind = 'embedding_generate'`,
      ).run("corrupt-payload-sha256", "default", written.nodeId);
    });

    const drained = await drainLiteProjectionJobs({
      store: runtime.store,
      embedder: DeterministicEmbeddingProvider,
      ann: null,
      annEnabled: false,
      limit: 1,
      leaseOwner: "corruption-worker",
      leaseMs: 5_000,
      timeoutMs: 2_000,
      jobKinds: ["embedding_generate"],
      nodeIds: [written.nodeId],
    });
    assert.equal(drained.dead_lettered, 1);
    assert.equal(drained.embedding_completed, 0);
    const [deadLetter] = await runtime.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      limit: 1,
    });
    assert.equal(deadLetter?.status, "dead_letter");
    assert.equal(deadLetter?.last_error, "invalid_embedding_projection_payload");
    assert.ok(deadLetter?.payload_json);
    assert.equal((await findNode(runtime.store, written.nodeId))?.embedding_status, "failed");
  } finally {
    await runtime.store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("local ANN rebuild restores every ready SQLite vector after restart", async () => {
  const temp = createTempDatabase("local-ann-rebuild");
  const runtime = openWriteRuntime(temp.path, false);
  let firstRecall: ReturnType<typeof createLiteRecallStore> | null = null;
  let secondRecall: ReturnType<typeof createLiteRecallStore> | null = null;
  try {
    const vector = deterministicEmbed("local ANN rebuild vector");
    const written = await writeReadyEmbedding({
      store: runtime.store,
      clientId: "projection:local-ann-rebuild",
      title: "Local ANN rebuild",
      summary: "The in-memory index must be reconstructed from committed SQLite vectors.",
      vector,
    });

    const firstIndex = createLocalAnnIndex();
    firstRecall = createLocalRecallRuntime(temp.path, firstIndex);
    assert.equal((await firstRecall.syncAnnNode("default", written.nodeId)).action, "upserted");
    assert.equal(await searchLocalAnn({ index: firstIndex, vector, nodeId: written.nodeId }), true);
    await firstRecall.close();
    firstRecall = null;
    await runtime.store.close();

    const secondIndex = createLocalAnnIndex();
    secondRecall = createLocalRecallRuntime(temp.path, secondIndex);
    assert.equal(await searchLocalAnn({ index: secondIndex, vector, nodeId: written.nodeId }), false);
    const rebuilt = await secondRecall.rebuildAnnIndex();
    assert.equal(rebuilt.indexed, 1);
    assert.equal(rebuilt.skipped, 0);
    assert.equal(await searchLocalAnn({ index: secondIndex, vector, nodeId: written.nodeId }), true);
  } finally {
    if (secondRecall) await secondRecall.close();
    if (firstRecall) await firstRecall.close();
    await runtime.store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});
