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
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-recall-store-access-"));
  return path.join(dir, `${name}.sqlite`);
}

function embedding(values: number[]): string {
  return JSON.stringify(values);
}

function deterministicUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

async function insertCommit(store: ReturnType<typeof createLiteWriteStore>, scope: string, suffix: string): Promise<string> {
  return store.insertCommit({
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
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "default", "stage1-exact-recovery");
      for (let i = 0; i < 2050; i += 1) {
        await insertReadyNode(writeStore, {
          id: `distractor-${String(i).padStart(4, "0")}`,
          vector: [0, 1, 0],
          salience: 1,
          confidence: 1,
          commitId,
        });
      }
      await insertReadyNode(writeStore, {
        id: "target-exact-match",
        vector: [1, 0, 0],
        salience: 0,
        confidence: 0,
        commitId,
      });
    });

    const access = recallStore.createRecallAccess();
    const ann = await access.stage1CandidatesAnn({
      queryEmbedding: [1, 0, 0],
      scope: "default",
      oversample: 1,
      limit: 1,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    const exact = await access.stage1CandidatesExactRecovery({
      queryEmbedding: [1, 0, 0],
      scope: "default",
      oversample: 1,
      limit: 1,
      consumerAgentId: null,
      consumerTeamId: null,
    });

    assert.notEqual(ann[0]?.id, "target-exact-match");
    assert.equal(exact[0]?.id, "target-exact-match");
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("stage1 tier budget keeps cold memories out of the default ANN path", async () => {
  const dbPath = tmpDbPath("stage1-tier-budget");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "default", "stage1-tier-budget");
      await insertReadyNode(writeStore, {
        id: "hot-distractor",
        vector: [0, 1, 0],
        tier: "hot",
        salience: 1,
        confidence: 1,
        commitId,
      });
      await insertReadyNode(writeStore, {
        id: "cold-exact-match",
        vector: [1, 0, 0],
        tier: "cold",
        salience: 1,
        confidence: 1,
        commitId,
      });
    });

    const access = recallStore.createRecallAccess();
    const ann = await access.stage1CandidatesAnn({
      queryEmbedding: [1, 0, 0],
      scope: "default",
      oversample: 5,
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    const exactWithCold = await access.stage1CandidatesExactRecovery({
      queryEmbedding: [1, 0, 0],
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
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  const queryEmbedding = [1, ...Array.from({ length: 1535 }, () => 0)];
  const coldOnlyTargetId = "00000000-0000-4000-8000-000000000111";
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "default", "stage1-cold-exact-recovery-debug");
      await insertReadyNode(writeStore, {
        id: coldOnlyTargetId,
        vector: queryEmbedding,
        tier: "cold",
        salience: 1,
        confidence: 1,
        commitId,
      });
    });

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

test("stage1 SQL visibility preserves shared owner-agent semantics", async () => {
  const dbPath = tmpDbPath("stage1-visibility");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "default", "stage1-visibility");
      await insertReadyNode(writeStore, {
        id: "shared-owner-agent-no-team",
        vector: [1, 0, 0],
        salience: 1,
        confidence: 1,
        ownerAgentId: "producer-agent",
        ownerTeamId: null,
        commitId,
      });
    });

    const candidates = await recallStore.createRecallAccess().stage1CandidatesAnn({
      queryEmbedding: [1, 0, 0],
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
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "default", "stage2-edges");
      for (const id of ["seed", "src-neighbor", "dst-neighbor", "unrelated-a", "unrelated-b"]) {
        await insertReadyNode(writeStore, { id, vector: [1, 0, 0], commitId });
      }
      await writeStore.upsertEdge({
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
      await writeStore.upsertEdge({
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
      await writeStore.upsertEdge({
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
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
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

    const access = recallStore.createRecallAccess();
    const ann = await access.stage1CandidatesAnn({
      queryEmbedding: [1, 0, 0],
      scope: "default",
      oversample: 50,
      limit: 25,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.ok(ann.length > 0);
    assert.ok(ann.every((candidate) => candidate.tier === "hot" || candidate.tier === "warm"));

    const exact = await access.stage1CandidatesExactRecovery({
      queryEmbedding: [1, 0, 0],
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
