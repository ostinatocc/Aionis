import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryRecallParsed } from "../../src/memory/recall.ts";
import { MemoryRecallRequest } from "../../src/memory/schemas.ts";
import {
  EXACT_RECOVERY_RECALL_STAGE1_ALLOWED_TIERS,
} from "../../src/store/recall-access.ts";
import { createLocalAnnIndex } from "../../src/store/ann/local-ann-index.ts";
import { createZvecAnnIndex } from "../../src/store/ann/zvec-ann-index.ts";
import { inspectLiteMemoryCommitAuthority } from
  "../../src/store/lite-memory-commit-integrity.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStore,
  createLiteWriteStoreFromDatabase,
} from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-recall-store-access-"));
  return path.join(dir, `${name}.sqlite`);
}

const EMBEDDING_DIMENSIONS = 1_536;

function embeddingValues(values: number[]): number[] {
  assert.ok(values.length > 0 && values.length <= EMBEDDING_DIMENSIONS);
  return values.length === EMBEDDING_DIMENSIONS
    ? [...values]
    : [...values, ...Array.from({ length: EMBEDDING_DIMENSIONS - values.length }, () => 0)];
}

function embedding(values: number[]): string {
  return JSON.stringify(embeddingValues(values));
}

function deterministicUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

async function insertCommit(store: ReturnType<typeof createLiteWriteStore>, scope: string, suffix: string): Promise<string> {
  return store.insertLegacyV1CommitForMigrationOrTestFixture({
    scope,
    parentCommitId: null,
    inputSha256: `input-${suffix}`,
    diffJson: "{}",
    actor: "test",
    modelVersion: null,
    promptVersion: null,
    commitHash: `commit-hash-${suffix}`,
  });
}

async function prepareMigratedRecallFixture(
  dbPath: string,
  seed: (store: ReturnType<typeof createLiteWriteStore>) => Promise<void>,
): Promise<void> {
  const legacyDatabase = createLiteRuntimeDatabase(dbPath);
  const legacyStore = createLiteWriteStoreFromDatabase(legacyDatabase, {
    annProjectionEnabled: false,
    allowLegacyV1Fixtures: true,
    closeDatabaseOnClose: false,
  });
  let legacyStoreClosed = false;
  try {
    legacyDatabase.db.exec("BEGIN IMMEDIATE");
    try {
      legacyDatabase.db.exec("DROP TABLE lite_runtime_authority_adoption_bindings");
      legacyDatabase.db.exec("DROP TABLE lite_runtime_authority_adoption_manifests");
      legacyDatabase.db.prepare(
        `UPDATE lite_runtime_schema_metadata
         SET version = 5, updated_at = ?
         WHERE component = 'write_projection'`,
      ).run("2026-07-19T00:00:00.000Z");
      legacyDatabase.db.exec("COMMIT");
    } catch (error) {
      legacyDatabase.db.exec("ROLLBACK");
      throw error;
    }

    await seed(legacyStore);
    const legacyAuthority = inspectLiteMemoryCommitAuthority(legacyDatabase.db);
    assert.equal(legacyAuthority.ok, true, JSON.stringify(legacyAuthority.findings));
    assert.ok(legacyAuthority.legacy_commit_count > 0);
    assert.equal(legacyAuthority.v2_commit_count, 0);
    await legacyStore.close();
    legacyStoreClosed = true;
  } finally {
    if (!legacyStoreClosed) await legacyStore.close().catch(() => undefined);
    await legacyDatabase.close();
  }

  const migratedDatabase = createLiteRuntimeDatabase(dbPath);
  const migratedStore = createLiteWriteStoreFromDatabase(migratedDatabase, {
    annProjectionEnabled: false,
    closeDatabaseOnClose: false,
  });
  try {
    const schema = migratedDatabase.readDb.prepare<{ version: number }>(
      `SELECT version FROM lite_runtime_schema_metadata
       WHERE component = 'write_projection'`,
    ).get();
    assert.equal(schema?.version, 6);
    const migratedAuthority = inspectLiteMemoryCommitAuthority(migratedDatabase.db);
    assert.equal(migratedAuthority.ok, true, JSON.stringify(migratedAuthority.findings));
    assert.ok(migratedAuthority.adoption_manifest_count > 0);
    assert.ok(migratedAuthority.adoption_binding_count > 0);
    assert.equal(
      migratedAuthority.adoption_binding_verified_count,
      migratedAuthority.adoption_binding_count,
    );
    assert.equal(
      migratedAuthority.adoption_assurance,
      "immutable_v5_authority_field_bindings_authenticated_by_v2_manifest",
    );
  } finally {
    try {
      await migratedStore.close();
    } finally {
      await migratedDatabase.close();
    }
  }
}

async function insertReadyNode(
  store: ReturnType<typeof createLiteWriteStore>,
  args: {
    id: string;
    scope?: string;
    type?: string;
    title?: string;
    summary?: string;
    vector?: number[];
    tier?: "hot" | "warm" | "cold" | "archive";
    slots?: Record<string, unknown>;
    salience?: number;
    confidence?: number;
    ownerAgentId?: string | null;
    ownerTeamId?: string | null;
    commitId: string;
  },
): Promise<void> {
  await store.insertNode({
    id: args.id,
    scope: args.scope ?? "default",
    clientId: null,
    type: args.type ?? "concept",
    tier: args.tier ?? "hot",
    title: args.title ?? args.id,
    textSummary: args.summary ?? args.id,
    slotsJson: JSON.stringify(args.slots ?? {}),
    rawRef: null,
    evidenceRef: null,
    embeddingVector: embedding(args.vector ?? [0, 1, 0]),
    embeddingModel: "test",
    memoryLane: "shared",
    producerAgentId: null,
    ownerAgentId: args.ownerAgentId ?? null,
    ownerTeamId: args.ownerTeamId ?? null,
    embeddingStatus: "ready",
    embeddingLastError: null,
    salience: args.salience ?? 0.8,
    importance: 0.5,
    confidence: args.confidence ?? 0.8,
    redactionVersion: 0,
    commitId: args.commitId,
  });
}

test("stage1 bounded ANN keeps exact recovery unbounded", async () => {
  const dbPath = tmpDbPath("stage1-exact-recovery");
  await prepareMigratedRecallFixture(dbPath, async (legacyStore) => {
    await legacyStore.withTx(async () => {
      const commitId = await insertCommit(legacyStore, "default", "stage1-exact-recovery");
      for (let i = 0; i < 2050; i += 1) {
        await insertReadyNode(legacyStore, {
          id: `distractor-${String(i).padStart(4, "0")}`,
          vector: [0, 1, 0],
          salience: 1,
          confidence: 1,
          commitId,
        });
      }
      await insertReadyNode(legacyStore, {
        id: "target-exact-match",
        vector: [1, 0, 0],
        salience: 0,
        confidence: 0,
        commitId,
      });
    });
  });
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    const access = recallStore.createRecallAccess();
    const ann = await access.stage1CandidatesAnn({
      queryEmbedding: embeddingValues([1, 0, 0]),
      scope: "default",
      oversample: 1,
      limit: 1,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    const exact = await access.stage1CandidatesExactRecovery({
      queryEmbedding: embeddingValues([1, 0, 0]),
      scope: "default",
      oversample: 1,
      limit: 1,
      consumerAgentId: null,
      consumerTeamId: null,
    });

    assert.notEqual(ann[0]?.id, "target-exact-match");
    assert.equal(ann[0]?.sources?.[0]?.kind, "semantic");
    assert.equal(ann[0]?.sources?.[0]?.reason, "bounded_embedding_scan");
    assert.equal(exact[0]?.id, "target-exact-match");
    assert.equal(exact[0]?.sources?.[0]?.kind, "exact_recovery");
    assert.equal(exact[0]?.sources?.[0]?.reason, "unbounded_exact_embedding_recovery");
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("stage1 local ANN sidecar is opt-in and still verifies candidates through SQLite facts", async () => {
  const dbPath = tmpDbPath("stage1-local-ann-sidecar");
  await prepareMigratedRecallFixture(dbPath, async (legacyStore) => {
    await legacyStore.withTx(async () => {
      const commitId = await insertCommit(legacyStore, "default", "stage1-local-ann-sidecar");
      for (let i = 0; i < 2050; i += 1) {
        await insertReadyNode(legacyStore, {
          id: `ann-distractor-${String(i).padStart(4, "0")}`,
          vector: [0, 1, 0],
          salience: 1,
          confidence: 1,
          commitId,
        });
      }
      await insertReadyNode(legacyStore, {
        id: "ann-private-exact-match",
        vector: [1, 0, 0],
        salience: 0,
        confidence: 1,
        ownerTeamId: "other-team",
        commitId,
      });
      await insertReadyNode(legacyStore, {
        id: "ann-visible-exact-match",
        vector: [1, 0, 0],
        salience: 0,
        confidence: 0.5,
        commitId,
      });
    });
  });
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath, {
    ann: {
      index: createLocalAnnIndex(),
      rebuildOnStart: true,
      maxCandidates: 16,
    },
  });
  try {
    const access = recallStore.createRecallAccess();
    const candidates = await access.stage1CandidatesAnn({
      queryEmbedding: embeddingValues([1, 0, 0]),
      scope: "default",
      oversample: 1,
      limit: 2,
      consumerAgentId: null,
      consumerTeamId: null,
    });

    assert.equal(candidates[0]?.id, "ann-visible-exact-match");
    assert.ok(!candidates.some((candidate) => candidate.id === "ann-private-exact-match"));
    assert.equal(candidates[0]?.sources?.[0]?.kind, "ann");
    assert.equal(candidates[0]?.sources?.[0]?.reason, "local_ann_index");
    assert.equal(candidates[0]?.sources?.[0]?.index_name, "aionis_local_ann");

    const hybrid = await access.stage1HybridCandidates({
      queryEmbedding: embeddingValues([1, 0, 0]),
      scope: "default",
      limit: 2,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(hybrid[0]?.id, "ann-visible-exact-match");
    assert.ok(hybrid[0]?.sources?.some((source) => source.kind === "ann"));
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("stage1 Substrate sidecar contributes only SQLite-verified Runtime candidates", async () => {
  const dbPath = tmpDbPath("stage1-substrate-sidecar");
  await prepareMigratedRecallFixture(dbPath, async (legacyStore) => {
    await legacyStore.withTx(async () => {
      const commitId = await insertCommit(legacyStore, "default", "stage1-substrate-sidecar");
      for (let i = 0; i < 80; i += 1) {
        await insertReadyNode(legacyStore, {
          id: `sidecar-distractor-${String(i).padStart(3, "0")}`,
          vector: [1, 0, 0],
          title: `semantic distractor ${i}`,
          summary: `semantic distractor ${i}`,
          salience: 1,
          confidence: 1,
          commitId,
        });
      }
      await insertReadyNode(legacyStore, {
        id: "private-sidecar-target",
        vector: [0, 1, 0],
        title: "private alpha bridge evidence",
        summary: "private target returned by sidecar must not be exposed",
        ownerTeamId: "other-team",
        commitId,
      });
      await insertReadyNode(legacyStore, {
        id: "visible-sidecar-target",
        vector: [0, 1, 0],
        title: "visible alpha bridge evidence",
        summary: "visible target returned by sidecar should be merged as a candidate",
        salience: 0.1,
        confidence: 0.9,
        commitId,
      });
    });
  });
  const writeStore = createLiteWriteStore(dbPath);
  let providerClosed = false;
  const recallStore = createLiteRecallStore(dbPath, {
    substrateSidecar: {
      maxCandidates: 16,
      indexName: "test_substrate_sidecar",
      sourceReason: "test_substrate_search",
      failOpen: false,
      provider: {
        async searchCandidates(params) {
          assert.equal(params.scope, "default");
          assert.equal(params.queryText, "question asks for alpha bridge evidence");
          return [
            {
              id: "private-sidecar-target",
              score: 0.99,
              reason: "sidecar_private_candidate",
              matchedFields: ["summary"],
            },
            {
              id: "missing-sidecar-target",
              score: 0.98,
              reason: "sidecar_missing_candidate",
              matchedFields: ["summary"],
            },
            {
              id: "visible-sidecar-target",
              score: 0.97,
              reason: "sidecar_visible_candidate",
              matchedFields: ["summary"],
            },
          ];
        },
        async close() {
          providerClosed = true;
        },
      },
    },
  });
  try {
    const access = recallStore.createRecallAccess();
    const hybrid = await access.stage1HybridCandidates({
      queryEmbedding: embeddingValues([1, 0, 0]),
      queryText: "question asks for alpha bridge evidence",
      scope: "default",
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });

    const target = hybrid.find((candidate) => candidate.id === "visible-sidecar-target");
    assert.ok(target);
    assert.ok(!hybrid.some((candidate) => candidate.id === "private-sidecar-target"));
    assert.ok(!hybrid.some((candidate) => candidate.id === "missing-sidecar-target"));
    assert.ok(target.sources?.some((source) =>
      source.kind === "substrate"
      && source.reason === "test_substrate_search"
      && source.index_name === "test_substrate_sidecar",
    ));
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
  assert.equal(providerClosed, true);
});

test("local ANN sidecar syncs ready embedding mutations after SQLite commit", async () => {
  const dbPath = tmpDbPath("stage1-local-ann-post-commit-sync");
  const queryEmbedding = [1, ...Array.from({ length: 1535 }, () => 0)];
  const weakEmbedding = [0, 1, ...Array.from({ length: 1534 }, () => 0)];
  await prepareMigratedRecallFixture(dbPath, async (legacyStore) => {
    await legacyStore.withTx(async () => {
      const commitId = await insertCommit(
        legacyStore,
        "default",
        "stage1-local-ann-post-commit-sync",
      );
      await legacyStore.insertNode({
        id: "fresh-pending-target",
        scope: "default",
        clientId: null,
        type: "concept",
        tier: "hot",
        title: "fresh pending target",
        textSummary: "fresh memory should appear after embedding ready",
        slotsJson: JSON.stringify({ lifecycle_state: "active" }),
        rawRef: null,
        evidenceRef: null,
        embeddingVector: null,
        embeddingModel: null,
        memoryLane: "shared",
        producerAgentId: null,
        ownerAgentId: null,
        ownerTeamId: null,
        embeddingStatus: "pending",
        embeddingLastError: null,
        salience: 0.9,
        importance: 0.5,
        confidence: 0.9,
        redactionVersion: 0,
        commitId,
      });
      await insertReadyNode(legacyStore, {
        id: "weak-ready-distractor",
        vector: weakEmbedding,
        title: "weak ready distractor",
        summary: "this row proves the ANN path is already populated before the target becomes ready",
        commitId,
      });
    });
  });
  let recallStore: ReturnType<typeof createLiteRecallStore> | null = null;
  const writeStore = createLiteWriteStore(dbPath, {
    annSync: {
      syncNode: async (scope, nodeId) => {
        await recallStore?.syncAnnNode(scope, nodeId);
      },
      deleteNode: async (nodeId) => {
        await recallStore?.deleteAnnNode(nodeId);
      },
    },
  });
  recallStore = createLiteRecallStore(dbPath, {
    ann: {
      index: createLocalAnnIndex(),
      rebuildOnStart: false,
      maxCandidates: 16,
      sourceReason: "local_ann_index",
      indexName: "aionis_local_ann",
    },
  });
  try {
    await recallStore.syncAnnNode("default", "weak-ready-distractor");
    const access = recallStore.createRecallAccess();
    const beforeReady = await access.stage1CandidatesAnn({
      queryEmbedding,
      scope: "default",
      oversample: 1,
      limit: 2,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.ok(!beforeReady.some((candidate) => candidate.id === "fresh-pending-target"));
    assert.ok(beforeReady.some((candidate) => candidate.id === "weak-ready-distractor"));
    assert.equal(beforeReady[0]?.sources?.[0]?.reason, "local_ann_index");

    await writeStore.withTx(async () => {
      await writeStore.setNodeEmbeddingReady({
        scope: "default",
        id: "fresh-pending-target",
        embedding: queryEmbedding,
        embeddingModel: "test",
      });
    });

    const afterReady = await access.stage1CandidatesAnn({
      queryEmbedding,
      scope: "default",
      oversample: 1,
      limit: 2,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(afterReady[0]?.id, "fresh-pending-target");
    assert.equal(afterReady[0]?.sources?.[0]?.kind, "ann");
    assert.equal(afterReady[0]?.sources?.[0]?.reason, "local_ann_index");

    await writeStore.withTx(async () => {
      await writeStore.setNodeEmbeddingFailed({
        scope: "default",
        id: "fresh-pending-target",
        error: "test failure",
      });
    });

    const afterFailed = await access.stage1CandidatesAnn({
      queryEmbedding,
      scope: "default",
      oversample: 1,
      limit: 2,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.ok(!afterFailed.some((candidate) => candidate.id === "fresh-pending-target"));
  } finally {
    await recallStore?.close();
    await writeStore.close();
  }
});

test("stage1 Zvec ANN sidecar is optional and still verifies candidates through SQLite facts", async (t) => {
  try {
    await import("@zvec/zvec");
  } catch {
    t.skip("@zvec/zvec optional dependency is not available on this platform");
    return;
  }

  const dbPath = tmpDbPath("stage1-zvec-ann-sidecar");
  const zvecPath = `${dbPath}.zvec-ann`;
  await prepareMigratedRecallFixture(dbPath, async (legacyStore) => {
    await legacyStore.withTx(async () => {
      const commitId = await insertCommit(legacyStore, "default", "stage1-zvec-ann-sidecar");
      for (let i = 0; i < 128; i += 1) {
        await insertReadyNode(legacyStore, {
          id: `zvec-distractor-${String(i).padStart(4, "0")}`,
          vector: [0, 1, 0],
          salience: 1,
          confidence: 1,
          commitId,
        });
      }
      await insertReadyNode(legacyStore, {
        id: "zvec-private-exact-match",
        vector: [1, 0, 0],
        salience: 0,
        confidence: 1,
        ownerTeamId: "other-team",
        commitId,
      });
      await insertReadyNode(legacyStore, {
        id: "zvec-visible-exact-match",
        vector: [1, 0, 0],
        salience: 0,
        confidence: 0.5,
        commitId,
      });
    });
  });
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath, {
    ann: {
      index: createZvecAnnIndex({ path: zvecPath }),
      rebuildOnStart: true,
      maxCandidates: 16,
      sourceReason: "zvec_ann_index",
      indexName: "aionis_zvec_ann",
    },
  });
  try {
    const candidates = await recallStore.createRecallAccess().stage1CandidatesAnn({
      queryEmbedding: embeddingValues([1, 0, 0]),
      scope: "default",
      oversample: 1,
      limit: 2,
      consumerAgentId: null,
      consumerTeamId: null,
    });

    assert.equal(candidates[0]?.id, "zvec-visible-exact-match");
    assert.ok(!candidates.some((candidate) => candidate.id === "zvec-private-exact-match"));
    assert.equal(candidates[0]?.sources?.[0]?.kind, "ann");
    assert.equal(candidates[0]?.sources?.[0]?.reason, "zvec_ann_index");
    assert.equal(candidates[0]?.sources?.[0]?.index_name, "aionis_zvec_ann");
  } finally {
    await recallStore.close();
    await writeStore.close();
    fs.rmSync(zvecPath, { recursive: true, force: true });
  }
});

test("stage1 tier budget keeps cold memories out of the default ANN path", async () => {
  const dbPath = tmpDbPath("stage1-tier-budget");
  await prepareMigratedRecallFixture(dbPath, async (legacyStore) => {
    await legacyStore.withTx(async () => {
      const commitId = await insertCommit(legacyStore, "default", "stage1-tier-budget");
      await insertReadyNode(legacyStore, {
        id: "hot-distractor",
        vector: [0, 1, 0],
        tier: "hot",
        salience: 1,
        confidence: 1,
        commitId,
      });
      await insertReadyNode(legacyStore, {
        id: "cold-exact-match",
        vector: [1, 0, 0],
        tier: "cold",
        salience: 1,
        confidence: 1,
        commitId,
      });
    });
  });
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    const access = recallStore.createRecallAccess();
    const ann = await access.stage1CandidatesAnn({
      queryEmbedding: embeddingValues([1, 0, 0]),
      scope: "default",
      oversample: 5,
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    const exactWithCold = await access.stage1CandidatesExactRecovery({
      queryEmbedding: embeddingValues([1, 0, 0]),
      scope: "default",
      oversample: 5,
      limit: 5,
      allowedTiers: [...EXACT_RECOVERY_RECALL_STAGE1_ALLOWED_TIERS],
      scanLimit: null,
      consumerAgentId: null,
      consumerTeamId: null,
    });

    assert.ok(ann.some((candidate) => candidate.id === "hot-distractor"));
    assert.ok(!ann.some((candidate) => candidate.id === "cold-exact-match"));
    assert.equal(exactWithCold[0]?.id, "cold-exact-match");
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("memory recall expands to cold only through exact recovery and reports tier budget debug", async () => {
  const dbPath = tmpDbPath("stage1-cold-exact-recovery-debug");
  const queryEmbedding = [1, ...Array.from({ length: 1535 }, () => 0)];
  const coldOnlyTargetId = "00000000-0000-4000-8000-000000000111";
  await prepareMigratedRecallFixture(dbPath, async (legacyStore) => {
    await legacyStore.withTx(async () => {
      const commitId = await insertCommit(
        legacyStore,
        "default",
        "stage1-cold-exact-recovery-debug",
      );
      await insertReadyNode(legacyStore, {
        id: coldOnlyTargetId,
        vector: queryEmbedding,
        tier: "cold",
        salience: 1,
        confidence: 1,
        commitId,
      });
    });
  });
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    const recall = await memoryRecallParsed(
      MemoryRecallRequest.parse({
        tenant_id: "default",
        scope: "default",
        query_embedding: queryEmbedding,
        limit: 5,
        neighborhood_hops: 1,
        max_nodes: 10,
        max_edges: 10,
        ranked_limit: 10,
        return_debug: true,
      }),
      "default",
      "default",
      { allow_debug_embeddings: false },
      undefined,
      "recall",
      { recall_access: recallStore.createRecallAccess() },
    );

    assert.equal(recall.seeds[0]?.id, coldOnlyTargetId);
    assert.equal((recall as any).debug.stage1.mode, "exact_recovery");
    assert.deepEqual((recall as any).debug.stage1.tier_budget.ann_allowed_tiers, ["hot", "warm"]);
    assert.deepEqual((recall as any).debug.stage1.tier_budget.exact_recovery_allowed_tiers, ["hot", "warm", "cold"]);
    assert.equal((recall as any).debug.stage1.tier_budget.ann_seed_tier_counts.cold, 0);
    assert.equal((recall as any).debug.stage1.tier_budget.final_seed_tier_counts.cold, 1);
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("memory recall uses route-level hybrid mode only when requested", async () => {
  const dbPath = tmpDbPath("route-level-hybrid-mode");
  const queryEmbedding = [1, ...Array.from({ length: 1535 }, () => 0)];
  const weakEmbedding = [0, 1, ...Array.from({ length: 1534 }, () => 0)];
  const marker = "ROUTE_LEVEL_HYBRID_MARKER";
  const semanticOnlyId = deterministicUuid(900);
  const lexicalTargetId = deterministicUuid(901);
  await prepareMigratedRecallFixture(dbPath, async (legacyStore) => {
    await legacyStore.withTx(async () => {
      const commitId = await insertCommit(legacyStore, "default", "route-level-hybrid-mode");
      await insertReadyNode(legacyStore, {
        id: semanticOnlyId,
        vector: queryEmbedding,
        title: "semantic-only route memory",
        summary: "Semantically close but missing the route-level hybrid marker.",
        commitId,
      });
      await insertReadyNode(legacyStore, {
        id: lexicalTargetId,
        vector: weakEmbedding,
        title: `${marker} lexical target`,
        summary: `${marker}: this target should be recovered by route-level hybrid recall.`,
        slots: {
          target_files: ["src/route-level-hybrid.ts"],
          failure_mode: "route-level-hybrid-regression",
        },
        commitId,
      });
    });
  });
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    const semanticOnly = await memoryRecallParsed(
      MemoryRecallRequest.parse({
        tenant_id: "default",
        scope: "default",
        query_text: marker,
        query_embedding: queryEmbedding,
        structured_recall_context: {
          target_files: ["src/route-level-hybrid.ts"],
          failure_mode: "route-level-hybrid-regression",
        },
        limit: 2,
        neighborhood_hops: 1,
        max_nodes: 5,
        max_edges: 5,
        ranked_limit: 5,
        return_debug: true,
      }),
      "default",
      "default",
      { allow_debug_embeddings: false },
      undefined,
      "recall",
      {
        recall_access: recallStore.createRecallAccess(),
        recall_engine_mode: "semantic_scan",
      },
    );
    assert.equal(semanticOnly.seeds[0]?.id, semanticOnlyId);
    assert.equal((semanticOnly as any).debug.stage1.mode, "ann");
    assert.equal((semanticOnly as any).debug.stage1.recall_engine_mode, "semantic_scan");

    const hybrid = await memoryRecallParsed(
      MemoryRecallRequest.parse({
        tenant_id: "default",
        scope: "default",
        query_text: marker,
        query_embedding: queryEmbedding,
        structured_recall_context: {
          target_files: ["src/route-level-hybrid.ts"],
          failure_mode: "route-level-hybrid-regression",
        },
        limit: 2,
        neighborhood_hops: 1,
        max_nodes: 5,
        max_edges: 5,
        ranked_limit: 5,
        return_debug: true,
      }),
      "default",
      "default",
      { allow_debug_embeddings: false },
      undefined,
      "recall",
      {
        recall_access: recallStore.createRecallAccess(),
        recall_engine_mode: "hybrid",
      },
    );

    assert.equal(hybrid.seeds[0]?.id, lexicalTargetId);
    assert.equal((hybrid as any).debug.stage1.mode, "hybrid");
    assert.equal((hybrid as any).debug.stage1.recall_engine_mode, "hybrid");
    assert.ok((hybrid as any).debug.stage1.hybrid_seed_count > 0);
    assert.ok(hybrid.seeds[0]?.sources?.some((source) => source.kind === "lexical"));
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("stage1 SQL visibility preserves shared owner-agent semantics", async () => {
  const dbPath = tmpDbPath("stage1-visibility");
  await prepareMigratedRecallFixture(dbPath, async (legacyStore) => {
    await legacyStore.withTx(async () => {
      const commitId = await insertCommit(legacyStore, "default", "stage1-visibility");
      await insertReadyNode(legacyStore, {
        id: "shared-owner-agent-no-team",
        vector: [1, 0, 0],
        salience: 1,
        confidence: 1,
        ownerAgentId: "producer-agent",
        ownerTeamId: null,
        commitId,
      });
    });
  });
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    const candidates = await recallStore.createRecallAccess().stage1CandidatesAnn({
      queryEmbedding: embeddingValues([1, 0, 0]),
      scope: "default",
      oversample: 5,
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });

    assert.ok(candidates.some((candidate) => candidate.id === "shared-owner-agent-no-team"));
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("stage2 edges fetches only seed neighborhoods in both directions", async () => {
  const dbPath = tmpDbPath("stage2-edges");
  await prepareMigratedRecallFixture(dbPath, async (legacyStore) => {
    await legacyStore.withTx(async () => {
      const commitId = await insertCommit(legacyStore, "default", "stage2-edges");
      for (const id of ["seed", "src-neighbor", "dst-neighbor", "unrelated-a", "unrelated-b"]) {
        await insertReadyNode(legacyStore, { id, vector: [1, 0, 0], commitId });
      }
      await legacyStore.upsertEdge({
        id: "edge-from-seed",
        scope: "default",
        type: "related_to",
        srcId: "seed",
        dstId: "dst-neighbor",
        weight: 0.7,
        confidence: 0.7,
        decayRate: 0,
        metadataJson: {},
        commitId,
      });
      await legacyStore.upsertEdge({
        id: "edge-to-seed",
        scope: "default",
        type: "related_to",
        srcId: "src-neighbor",
        dstId: "seed",
        weight: 0.8,
        confidence: 0.8,
        decayRate: 0,
        metadataJson: {},
        commitId,
      });
      await legacyStore.upsertEdge({
        id: "edge-unrelated",
        scope: "default",
        type: "related_to",
        srcId: "unrelated-a",
        dstId: "unrelated-b",
        weight: 1,
        confidence: 1,
        decayRate: 0,
        metadataJson: {},
        commitId,
      });
    });
  });
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    const edges = await recallStore.createRecallAccess().stage2Edges({
      seedIds: ["seed"],
      scope: "default",
      neighborhoodHops: 1,
      minEdgeWeight: 0,
      minEdgeConfidence: 0,
      hop1Budget: 10,
      hop2Budget: 10,
      edgeFetchBudget: 10,
    });

    assert.deepEqual(edges.map((edge) => edge.id).sort(), ["edge-from-seed", "edge-to-seed"]);
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("large Lite recall smoke keeps tier budget and edge neighborhood bounded", async () => {
  const dbPath = tmpDbPath("large-recall-smoke");
  await prepareMigratedRecallFixture(dbPath, async (writeStore) => {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "default", "large-recall-smoke");
      for (let i = 0; i < 2200; i += 1) {
        await insertReadyNode(writeStore, {
          id: deterministicUuid(10_000 + i),
          type: "concept",
          title: `ordinary memory ${i}`,
          vector: i % 2 === 0 ? [0, 1, 0] : [0, 0.9, 0.1],
          tier: i % 3 === 0 ? "hot" : "warm",
          salience: 0.9,
          confidence: 0.9,
          commitId,
        });
      }
      for (let i = 0; i < 420; i += 1) {
        await insertReadyNode(writeStore, {
          id: deterministicUuid(20_000 + i),
          type: "procedure",
          title: `execution workflow ${i}`,
          vector: [0, 0.8, 0.2],
          tier: i % 2 === 0 ? "hot" : "warm",
          slots: {
            execution_native_v1: {
              execution_kind: "workflow_anchor",
              anchor_kind: "workflow",
              workflow_signature: `large-smoke-workflow-${i}`,
              task_family: "large_recall_smoke",
              selected_tool: "edit",
              contract_trust: "authoritative",
            },
          },
          salience: 0.85,
          confidence: 0.85,
          commitId,
        });
      }
      await insertReadyNode(writeStore, {
        id: deterministicUuid(30_001),
        type: "concept",
        title: "cold exact target",
        vector: [1, 0, 0],
        tier: "cold",
        salience: 1,
        confidence: 1,
        commitId,
      });
      await insertReadyNode(writeStore, {
        id: deterministicUuid(30_002),
        type: "concept",
        title: "archive exact target",
        vector: [1, 0, 0],
        tier: "archive",
        salience: 1,
        confidence: 1,
        commitId,
      });

      const seedId = deterministicUuid(40_000);
      const srcNeighborId = deterministicUuid(40_001);
      const dstNeighborId = deterministicUuid(40_002);
      for (const id of [seedId, srcNeighborId, dstNeighborId]) {
        await insertReadyNode(writeStore, { id, type: "concept", vector: [0, 1, 0], commitId });
      }
      await writeStore.upsertEdge({
        id: "large-smoke-edge-from-seed",
        scope: "default",
        type: "related_to",
        srcId: seedId,
        dstId: dstNeighborId,
        weight: 0.74,
        confidence: 0.74,
        decayRate: 0,
        metadataJson: {},
        commitId,
      });
      await writeStore.upsertEdge({
        id: "large-smoke-edge-to-seed",
        scope: "default",
        type: "related_to",
        srcId: srcNeighborId,
        dstId: seedId,
        weight: 0.83,
        confidence: 0.83,
        decayRate: 0,
        metadataJson: {},
        commitId,
      });
      for (let i = 0; i < 1500; i += 1) {
        await writeStore.upsertEdge({
          id: `large-smoke-unrelated-edge-${i}`,
          scope: "default",
          type: "related_to",
          srcId: deterministicUuid(10_000 + (i % 2200)),
          dstId: deterministicUuid(10_000 + ((i + 1) % 2200)),
          weight: 1,
          confidence: 1,
          decayRate: 0,
          metadataJson: {},
          commitId,
        });
      }
    });
  });
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {

    const access = recallStore.createRecallAccess();
    const ann = await access.stage1CandidatesAnn({
      queryEmbedding: embeddingValues([1, 0, 0]),
      scope: "default",
      oversample: 50,
      limit: 25,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.ok(ann.length > 0);
    assert.ok(ann.every((candidate) => candidate.tier === "hot" || candidate.tier === "warm"));

    const exact = await access.stage1CandidatesExactRecovery({
      queryEmbedding: embeddingValues([1, 0, 0]),
      scope: "default",
      oversample: 50,
      limit: 5,
      allowedTiers: [...EXACT_RECOVERY_RECALL_STAGE1_ALLOWED_TIERS],
      scanLimit: null,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(exact[0]?.id, deterministicUuid(30_001));
    assert.ok(!exact.some((candidate) => candidate.tier === "archive"));

    const edges = await access.stage2Edges({
      seedIds: [deterministicUuid(40_000)],
      scope: "default",
      neighborhoodHops: 1,
      minEdgeWeight: 0,
      minEdgeConfidence: 0,
      hop1Budget: 10,
      hop2Budget: 10,
      edgeFetchBudget: 10,
    });
    assert.deepEqual(edges.map((edge) => edge.id).sort(), ["large-smoke-edge-from-seed", "large-smoke-edge-to-seed"]);
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});
