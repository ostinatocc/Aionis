import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-recall-store-access-"));
  return path.join(dir, `${name}.sqlite`);
}

function embedding(values: number[]): string {
  return JSON.stringify(values);
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
    tier: "hot",
    title: args.title ?? args.id,
    textSummary: args.summary ?? args.id,
    slotsJson: "{}",
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
