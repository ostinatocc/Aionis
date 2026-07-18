import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { drainLiteProjectionJobs } from "../../src/jobs/lite-projection-worker.ts";
import {
  applyNodeAuthorityPatchesV2,
  buildNodeAuthorityMutationV2,
  verifyNodeAuthorityPatchesV2,
  type NodeAuthorityPatchV2,
} from "../../src/memory/node-authority-mutation.ts";
import { EMBEDDING_SOURCE_TEXT_CHANGED_PENDING_REASON } from
  "../../src/memory/node-embedding-freshness.ts";
import { runAppliedAuthorityMutationV2 } from "../../src/memory/applied-authority-mutation.ts";
import { persistLitePreparedWrite } from "../../src/memory/lite-projected-write-commit.ts";
import { prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLocalAnnIndex } from "../../src/store/ann/local-ann-index.ts";
import type { AionisLocalAnnIndex } from "../../src/store/ann/ann-index.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import {
  inspectLiteProjectionRepairState,
  repairLiteProjectionState,
} from "../../src/store/lite-projection-repair.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.ts";
import { parseEmbeddingProjectionPayload } from "../../src/store/lite-projection-outbox.ts";
import type { WriteExistingNodeState } from "../../src/store/write-access.ts";
import { sha256Hex } from "../../src/util/crypto.ts";
import {
  DeterministicEmbeddingProvider,
  deterministicEmbed,
} from "./support/deterministic-embedding.ts";

const WRITE_OPTIONS = {
  maxTextLen: 20_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
} as const;

type Fixture = {
  directory: string;
  path: string;
  database: ReturnType<typeof createLiteRuntimeDatabase>;
  store: LiteWriteStore;
  index: AionisLocalAnnIndex;
  recall: ReturnType<typeof createLiteRecallStore>;
};

function openFixture(name: string): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-embedding-freshness-${name}-`));
  const dbPath = path.join(directory, "runtime.sqlite");
  const database = createLiteRuntimeDatabase(dbPath);
  const store = createLiteWriteStoreFromDatabase(database, {
    annProjectionEnabled: true,
  });
  const index = createLocalAnnIndex();
  const recall = createLiteRecallStore(dbPath, {
    ann: {
      index,
      rebuildOnStart: false,
      maxCandidates: 32,
      sourceReason: "embedding_freshness_test",
      indexName: "embedding_freshness_test_ann",
    },
  });
  return { directory, path: dbPath, database, store, index, recall };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.recall.close();
  await fixture.store.close();
  await fixture.database.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

async function nodeState(fixture: Fixture, nodeId: string): Promise<WriteExistingNodeState> {
  const row = (await fixture.store.nodeStatesByIds("default", [nodeId])).get(nodeId);
  assert.ok(row);
  return row;
}

async function seedReadyProjectedNode(fixture: Fixture, clientId: string): Promise<{
  nodeId: string;
  originalEmbedText: string;
}> {
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor: "embedding-freshness-test",
    input_text: "Seed a projected node for authority freshness verification.",
    auto_embed: true,
    nodes: [{
      client_id: clientId,
      type: "concept",
      title: "Original projected title",
      text_summary: "Original projected summary",
      memory_lane: "shared",
    }],
    edges: [],
  }, "default", "default", WRITE_OPTIONS, DeterministicEmbeddingProvider);
  const result = await persistLitePreparedWrite({
    prepared,
    liteWriteStore: fixture.store,
    writeOptions: WRITE_OPTIONS,
  });
  const nodeId = result.nodes[0]?.id;
  const originalEmbedText = prepared.nodes[0]?.embed_text;
  assert.ok(nodeId);
  assert.ok(originalEmbedText);

  const embeddingDrain = await drainLiteProjectionJobs({
    store: fixture.store,
    embedder: DeterministicEmbeddingProvider,
    ann: null,
    annEnabled: true,
    limit: 1,
    leaseOwner: `embedding-freshness-seed:${clientId}`,
    jobKinds: ["embedding_generate"],
    nodeIds: [nodeId],
  });
  assert.equal(embeddingDrain.embedding_completed, 1);
  const annDrain = await drainLiteProjectionJobs({
    store: fixture.store,
    embedder: null,
    ann: { reconcileNode: (scope, id) => fixture.recall.syncAnnNode(scope, id) },
    annEnabled: true,
    limit: 1,
    leaseOwner: `embedding-freshness-ann-seed:${clientId}`,
    jobKinds: ["ann_reconcile"],
    nodeIds: [nodeId],
  });
  assert.equal(annDrain.ann_completed, 1);
  assert.equal((await nodeState(fixture, nodeId)).embeddingStatus, "ready");
  return { nodeId, originalEmbedText };
}

async function rawAnnContains(
  fixture: Fixture,
  nodeId: string,
  embedding: number[],
): Promise<boolean> {
  const rows = await fixture.index.search({
    scope: "default",
    embeddingModel: DeterministicEmbeddingProvider.name,
    vector: embedding,
    limit: 10,
  });
  return rows.some((row) => row.node_id === nodeId);
}

async function recallAnnContains(
  fixture: Fixture,
  nodeId: string,
  embedding: number[],
): Promise<boolean> {
  const rows = await fixture.recall.createRecallAccess().stage1CandidatesAnn({
    scope: "default",
    queryEmbedding: embedding,
    oversample: 10,
    limit: 10,
    consumerAgentId: null,
    consumerTeamId: null,
  });
  return rows.some((row) => row.id === nodeId);
}

async function updateNodeAuthority(args: {
  fixture: Fixture;
  nodeId: string;
  textSummary: string | null;
  confidenceDelta?: number;
}) {
  const before = await nodeState(args.fixture, args.nodeId);
  const head = await args.fixture.store.readScopeHead("default");
  assert.ok(head);
  const patch: NodeAuthorityPatchV2 = {
    id: args.nodeId,
    tier: before.tier,
    slots: JSON.parse(before.slotsJson) as Record<string, unknown>,
    textSummary: args.textSummary,
    salience: before.salience,
    importance: before.importance,
    confidence: before.confidence + (args.confidenceDelta ?? 0),
  };
  return await runAppliedAuthorityMutationV2({
    store: args.fixture.store,
    scope: "default",
    actor: "embedding-freshness-test",
    inputSha256: sha256Hex(JSON.stringify({
      node_id: args.nodeId,
      text_summary: args.textSummary,
      confidence: patch.confidence,
    })),
    expectedHeadRevision: head.revision,
    expectedHeadCommitId: head.commitId,
    plan: async () => ({
      status: "mutate" as const,
      authorityKind: "embedding_freshness_test",
      mutations: [buildNodeAuthorityMutationV2({ before, patch })],
      async apply({ commitId }) {
        await applyNodeAuthorityPatchesV2({
          store: args.fixture.store,
          scope: "default",
          patches: [patch],
          commitId,
        });
        return undefined;
      },
      async verify({ commitId }) {
        return await verifyNodeAuthorityPatchesV2({
          store: args.fixture.store,
          scope: "default",
          patches: [patch],
          commitId,
          errorLabel: "embedding_freshness_test",
        });
      },
    }),
  });
}

function authorityCommitDiff(fixture: Fixture, commitId: string): Record<string, any> {
  const row = fixture.database.db.prepare(
    "SELECT diff_json FROM lite_memory_commits WHERE id = ?",
  ).get(commitId) as { diff_json: string } | undefined;
  assert.ok(row);
  return JSON.parse(row.diff_json) as Record<string, any>;
}

test("ready embedding is invalidated in exact v2 authority and regenerated from retained succeeded payload", async () => {
  const fixture = openFixture("retained-payload");
  try {
    const seeded = await seedReadyProjectedNode(fixture, "embedding-freshness:retained-payload");
    const oldVector = deterministicEmbed(seeded.originalEmbedText);
    assert.equal(await rawAnnContains(fixture, seeded.nodeId, oldVector), true);
    assert.equal(await recallAnnContains(fixture, seeded.nodeId, oldVector), true);

    const [succeededBefore] = await fixture.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      limit: 1,
    });
    assert.equal(succeededBefore?.status, "succeeded");
    assert.ok(succeededBefore?.payload_json);
    const retainedPayload = succeededBefore && parseEmbeddingProjectionPayload(succeededBefore);
    assert.ok(retainedPayload);

    const nextText = "Authority summary changed and requires a new semantic projection.";
    const applied = await updateNodeAuthority({
      fixture,
      nodeId: seeded.nodeId,
      textSummary: nextText,
    });
    const pending = await nodeState(fixture, seeded.nodeId);
    assert.equal(pending.embeddingStatus, "pending");
    assert.equal(pending.embeddingVector, null);
    assert.equal(pending.embeddingModel, null);
    assert.equal(pending.embeddingLastError, EMBEDDING_SOURCE_TEXT_CHANGED_PENDING_REASON);

    const diff = authorityCommitDiff(fixture, applied.commitId);
    const after = diff.mutations[0]?.after;
    assert.equal(after.embedding_status, "pending");
    assert.equal(after.embedding_vector_json, null);
    assert.equal(after.embedding_model, null);
    assert.equal(after.embedding_last_error, EMBEDDING_SOURCE_TEXT_CHANGED_PENDING_REASON);

    const [refreshed] = await fixture.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      limit: 1,
    });
    assert.equal(refreshed?.status, "pending");
    assert.equal(refreshed?.generation, succeededBefore!.generation + 1);
    assert.equal(refreshed?.source_commit_id, applied.commitId);
    const refreshedPayload = refreshed && parseEmbeddingProjectionPayload(refreshed);
    assert.ok(refreshedPayload);
    assert.equal(refreshedPayload.commit_id, applied.commitId);
    assert.equal(refreshedPayload.embed_text, nextText);
    assert.equal(refreshedPayload.embed_text_sha256, sha256Hex(nextText));
    assert.equal(refreshedPayload.provider_name, retainedPayload.provider_name);

    const rebound = await updateNodeAuthority({
      fixture,
      nodeId: seeded.nodeId,
      textSummary: nextText,
      confidenceDelta: -0.01,
    });
    const [reboundJob] = await fixture.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      limit: 1,
    });
    assert.equal(reboundJob?.status, "pending");
    assert.equal(reboundJob?.generation, refreshed!.generation + 1);
    assert.equal(reboundJob?.source_commit_id, rebound.commitId);
    const reboundPayload = parseEmbeddingProjectionPayload(reboundJob!);
    assert.equal(reboundPayload?.embed_text, nextText);
    assert.equal(reboundPayload?.embed_text_sha256, refreshedPayload.embed_text_sha256);

    // A stale ANN document may exist until its durable reconcile runs, but
    // recall immediately rejects it against pending SQLite authority.
    assert.equal(await rawAnnContains(fixture, seeded.nodeId, oldVector), true);
    assert.equal(await recallAnnContains(fixture, seeded.nodeId, oldVector), false);
    const deletion = await drainLiteProjectionJobs({
      store: fixture.store,
      embedder: null,
      ann: { reconcileNode: (scope, id) => fixture.recall.syncAnnNode(scope, id) },
      annEnabled: true,
      limit: 1,
      leaseOwner: "embedding-freshness-delete-stale-ann",
      jobKinds: ["ann_reconcile"],
      nodeIds: [seeded.nodeId],
    });
    assert.equal(deletion.ann_completed, 1);
    assert.equal(await rawAnnContains(fixture, seeded.nodeId, oldVector), false);

    const regenerated = await drainLiteProjectionJobs({
      store: fixture.store,
      embedder: DeterministicEmbeddingProvider,
      ann: null,
      annEnabled: true,
      limit: 1,
      leaseOwner: "embedding-freshness-regenerate",
      jobKinds: ["embedding_generate"],
      nodeIds: [seeded.nodeId],
    });
    assert.equal(regenerated.embedding_completed, 1);
    const ready = await nodeState(fixture, seeded.nodeId);
    assert.equal(ready.embeddingStatus, "ready");
    assert.equal(ready.embeddingLastError, null);
    assert.deepEqual(JSON.parse(ready.embeddingVector!), deterministicEmbed(nextText));

    const [succeededAfter] = await fixture.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      limit: 1,
    });
    assert.equal(succeededAfter?.status, "succeeded");
    assert.ok(succeededAfter?.payload_json);
    assert.equal(parseEmbeddingProjectionPayload(succeededAfter!)?.commit_id, rebound.commitId);

    const finalAnn = await drainLiteProjectionJobs({
      store: fixture.store,
      embedder: null,
      ann: { reconcileNode: (scope, id) => fixture.recall.syncAnnNode(scope, id) },
      annEnabled: true,
      limit: 1,
      leaseOwner: "embedding-freshness-publish-new-ann",
      jobKinds: ["ann_reconcile"],
      nodeIds: [seeded.nodeId],
    });
    assert.equal(finalAnn.ann_completed, 1);
    assert.equal(await rawAnnContains(fixture, seeded.nodeId, deterministicEmbed(nextText)), true);
    assert.equal(await recallAnnContains(fixture, seeded.nodeId, deterministicEmbed(nextText)), true);

    const generationBeforeNonTextUpdate = succeededAfter!.generation;
    await updateNodeAuthority({
      fixture,
      nodeId: seeded.nodeId,
      textSummary: nextText,
      confidenceDelta: -0.01,
    });
    const afterNonTextUpdate = await nodeState(fixture, seeded.nodeId);
    assert.equal(afterNonTextUpdate.embeddingStatus, "ready");
    assert.ok(afterNonTextUpdate.embeddingVector);
    const [jobAfterNonTextUpdate] = await fixture.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      limit: 1,
    });
    assert.equal(jobAfterNonTextUpdate?.generation, generationBeforeNonTextUpdate);
    assert.equal(jobAfterNonTextUpdate?.status, "succeeded");
  } finally {
    await closeFixture(fixture);
  }
});

test("legacy succeeded job without payload still fails closed on authority text change", async () => {
  const fixture = openFixture("legacy-null-payload");
  try {
    const seeded = await seedReadyProjectedNode(fixture, "embedding-freshness:legacy-null-payload");
    const oldVector = deterministicEmbed(seeded.originalEmbedText);
    const [succeeded] = await fixture.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      limit: 1,
    });
    assert.equal(succeeded?.status, "succeeded");
    assert.equal(await rawAnnContains(fixture, seeded.nodeId, oldVector), true);

    await fixture.database.withTx(async () => {
      fixture.database.db.prepare(
        `UPDATE lite_memory_projection_jobs
         SET payload_json = NULL
         WHERE scope = 'default' AND node_id = ? AND job_kind = 'embedding_generate'`,
      ).run(seeded.nodeId);
    });

    const applied = await updateNodeAuthority({
      fixture,
      nodeId: seeded.nodeId,
      textSummary: "Legacy payload is absent, so this projection needs explicit repair.",
    });
    const pending = await nodeState(fixture, seeded.nodeId);
    assert.equal(pending.commitId, applied.commitId);
    assert.equal(pending.embeddingStatus, "pending");
    assert.equal(pending.embeddingVector, null);
    assert.equal(pending.embeddingModel, null);
    assert.equal(pending.embeddingLastError, EMBEDDING_SOURCE_TEXT_CHANGED_PENDING_REASON);

    const [legacyJob] = await fixture.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      limit: 1,
    });
    assert.equal(legacyJob?.generation, succeeded!.generation);
    assert.equal(legacyJob?.status, "succeeded");
    assert.equal(legacyJob?.payload_json, null);
    assert.notEqual(legacyJob?.source_commit_id, applied.commitId);
    const repairState = await inspectLiteProjectionRepairState({
      path: fixture.path,
      scope: "default",
      nodeId: seeded.nodeId,
      limit: 10,
    });
    assert.equal(repairState.jobs[0]?.payload_valid, false);
    assert.equal(repairState.jobs[0]?.source_commit_matches, false);
    assert.equal(repairState.legacy_pending[0]?.node_id, seeded.nodeId);
    assert.equal(repairState.legacy_pending[0]?.recoverable, true);

    assert.equal(await recallAnnContains(fixture, seeded.nodeId, oldVector), false);
    const deletion = await drainLiteProjectionJobs({
      store: fixture.store,
      embedder: null,
      ann: { reconcileNode: (scope, id) => fixture.recall.syncAnnNode(scope, id) },
      annEnabled: true,
      limit: 1,
      leaseOwner: "embedding-freshness-legacy-delete-ann",
      jobKinds: ["ann_reconcile"],
      nodeIds: [seeded.nodeId],
    });
    assert.equal(deletion.ann_completed, 1);
    assert.equal(await rawAnnContains(fixture, seeded.nodeId, oldVector), false);
    const unclaimable = await fixture.store.claimProjectionJobs({
      leaseOwner: "embedding-freshness-legacy-no-claim",
      leaseMs: 5_000,
      limit: 1,
      jobKinds: ["embedding_generate"],
      nodeIds: [seeded.nodeId],
    });
    assert.equal(unclaimable.length, 0);
    const repaired = await repairLiteProjectionState({
      path: fixture.path,
      scope: "default",
      nodeId: seeded.nodeId,
      providerName: DeterministicEmbeddingProvider.name,
      providerDim: DeterministicEmbeddingProvider.dim,
      repairLegacy: true,
      repairDeadLetters: false,
      repairEmbedding: true,
      repairAnn: false,
    });
    assert.equal(repaired.repaired.legacy_embedding, 1);
    const [repairedJob] = await fixture.store.listProjectionJobs({
      jobKinds: ["embedding_generate"],
      limit: 1,
    });
    assert.equal(repairedJob?.status, "pending");
    assert.equal(repairedJob?.generation, succeeded!.generation + 1);
    assert.equal(repairedJob?.source_commit_id, applied.commitId);
    assert.equal(parseEmbeddingProjectionPayload(repairedJob!)?.commit_id, applied.commitId);
  } finally {
    await closeFixture(fixture);
  }
});
