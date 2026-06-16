import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RECALL_STORE_ACCESS_CAPABILITY_VERSION,
  assertRecallStoreAccessContract,
} from "../../src/store/recall-access.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-recall-source-trace-"));
  return path.join(dir, `${name}.sqlite`);
}

async function insertReadyConcept(args: {
  writeStore: ReturnType<typeof createLiteWriteStore>;
  scope: string;
  id: string;
  vector: number[];
  tier?: "hot" | "warm" | "cold";
}): Promise<void> {
  const commitId = await args.writeStore.insertCommit({
    scope: args.scope,
    parentCommitId: null,
    inputSha256: `source-trace-${args.id}`,
    diffJson: "{}",
    actor: "recall-source-trace-test",
    modelVersion: null,
    promptVersion: null,
    commitHash: `source-trace-${args.id}`,
  });
  await args.writeStore.insertNode({
    id: args.id,
    scope: args.scope,
    clientId: null,
    type: "concept",
    tier: args.tier ?? "hot",
    title: `source trace ${args.id}`,
    textSummary: `source trace memory ${args.id}`,
    slotsJson: "{}",
    rawRef: null,
    evidenceRef: null,
    embeddingVector: JSON.stringify(args.vector),
    embeddingModel: "test",
    memoryLane: "shared",
    producerAgentId: null,
    ownerAgentId: null,
    ownerTeamId: null,
    embeddingStatus: "ready",
    embeddingLastError: null,
    salience: 0.9,
    importance: 0.5,
    confidence: 0.9,
    redactionVersion: 0,
    commitId,
  });
}

test("RecallStoreAccess v3 exposes candidate source traces without changing candidate admission", async () => {
  const dbPath = tmpDbPath("v3-source-contract");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      await insertReadyConcept({
        writeStore,
        scope: "source-trace/default",
        id: "semantic-target",
        vector: [1, 0, 0],
      });
    });

    const access = recallStore.createRecallAccess();
    assertRecallStoreAccessContract(access);
    assert.equal(access.capability_version, RECALL_STORE_ACCESS_CAPABILITY_VERSION);
    assert.equal(access.capability_version, 3);

    const semantic = await access.stage1SemanticCandidates({
      queryEmbedding: [1, 0, 0],
      scope: "source-trace/default",
      oversample: 5,
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(semantic[0]?.id, "semantic-target");
    assert.equal(semantic[0]?.sources?.[0]?.kind, "semantic");
    assert.equal(semantic[0]?.sources?.[0]?.reason, "bounded_embedding_scan");
    assert.equal(semantic[0]?.sources?.[0]?.index_name, "lite_embedding_json_scan");
    assert.ok(typeof semantic[0]?.sources?.[0]?.score === "number");
    assert.deepEqual(semantic[0]?.sources?.[0]?.matched_fields, ["embedding_vector_json"]);

    const exact = await access.stage1CandidatesExactRecovery({
      queryEmbedding: [1, 0, 0],
      scope: "source-trace/default",
      oversample: 5,
      limit: 5,
      allowedTiers: ["hot", "warm", "cold"],
      scanLimit: null,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(exact[0]?.id, "semantic-target");
    assert.equal(exact[0]?.sources?.[0]?.kind, "exact_recovery");
    assert.equal(exact[0]?.sources?.[0]?.reason, "unbounded_exact_embedding_recovery");

    const hybrid = await access.stage1HybridCandidates({
      queryEmbedding: [1, 0, 0],
      scope: "source-trace/default",
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(hybrid[0]?.id, "semantic-target");
    assert.equal(hybrid[0]?.sources?.[0]?.kind, "semantic");

    assert.deepEqual(await access.stage1LexicalCandidates({
      queryText: "semantic-target",
      scope: "source-trace/default",
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    }), []);
    assert.deepEqual(await access.stage1StructuredCandidates({
      scope: "source-trace/default",
      limit: 5,
      workflowSignature: "none",
      consumerAgentId: null,
      consumerTeamId: null,
    }), []);
    assert.deepEqual(await access.stage1ExecutionNativeCandidates({
      scope: "source-trace/default",
      limit: 5,
      workflowSignature: "none",
      consumerAgentId: null,
      consumerTeamId: null,
    }), []);
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});
