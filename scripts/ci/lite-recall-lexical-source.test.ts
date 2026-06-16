import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-recall-lexical-"));
  return path.join(dir, `${name}.sqlite`);
}

async function insertCommit(store: ReturnType<typeof createLiteWriteStore>, scope: string, suffix: string): Promise<string> {
  return store.insertCommit({
    scope,
    parentCommitId: null,
    inputSha256: `input-${suffix}`,
    diffJson: "{}",
    actor: "lexical-test",
    modelVersion: null,
    promptVersion: null,
    commitHash: `commit-hash-${suffix}`,
  });
}

async function insertNode(
  store: ReturnType<typeof createLiteWriteStore>,
  args: {
    id: string;
    scope: string;
    title: string;
    textSummary: string;
    slots?: Record<string, unknown>;
    embeddingVector?: number[] | null;
    embeddingStatus?: "pending" | "ready" | "failed";
    type?: string;
    commitId: string;
  },
): Promise<void> {
  await store.insertNode({
    id: args.id,
    scope: args.scope,
    clientId: null,
    type: args.type ?? "concept",
    tier: "hot",
    title: args.title,
    textSummary: args.textSummary,
    slotsJson: JSON.stringify(args.slots ?? {}),
    rawRef: null,
    evidenceRef: null,
    embeddingVector: args.embeddingVector ? JSON.stringify(args.embeddingVector) : null,
    embeddingModel: args.embeddingVector ? "test" : null,
    memoryLane: "shared",
    producerAgentId: null,
    ownerAgentId: null,
    ownerTeamId: null,
    embeddingStatus: args.embeddingStatus ?? (args.embeddingVector ? "ready" : "pending"),
    embeddingLastError: null,
    salience: 0.9,
    importance: 0.5,
    confidence: 0.9,
    redactionVersion: 0,
    commitId: args.commitId,
  });
}

test("lexical recall finds keyword matches even when semantic embedding is not ready", async () => {
  const dbPath = tmpDbPath("keyword-no-embedding");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "lexical/default", "keyword-no-embedding");
      await insertNode(writeStore, {
        id: "lexical-target",
        scope: "lexical/default",
        title: "Rare ZephyrConnector route",
        textSummary: "Continue the ZephyrConnector adapter route from the accepted plan.",
        slots: {
          target_files: ["src/integrations/zephyrConnector.ts"],
          task_signature: "zephyr-connector",
        },
        embeddingVector: null,
        embeddingStatus: "pending",
        commitId,
      });
      await insertNode(writeStore, {
        id: "semantic-distractor",
        scope: "lexical/default",
        title: "Unrelated billing route",
        textSummary: "Billing route with a ready embedding but no rare keyword.",
        embeddingVector: [1, 0, 0],
        commitId,
      });
    });

    const access = recallStore.createRecallAccess();
    const semantic = await access.stage1SemanticCandidates({
      queryEmbedding: [1, 0, 0],
      scope: "lexical/default",
      oversample: 5,
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.ok(!semantic.some((candidate) => candidate.id === "lexical-target"));

    const lexical = await access.stage1LexicalCandidates({
      queryText: "continue zephyrConnector adapter",
      scope: "lexical/default",
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(lexical[0]?.id, "lexical-target");
    assert.equal(lexical[0]?.sources?.[0]?.kind, "lexical");
    assert.equal(lexical[0]?.sources?.[0]?.reason, "keyword_index_match");
    assert.equal(lexical[0]?.sources?.[0]?.index_name, "lite_memory_keyword_index");
    assert.ok(lexical[0]?.sources?.[0]?.matched_fields?.includes("title")
      || lexical[0]?.sources?.[0]?.matched_fields?.includes("text_summary"));
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("lexical recall index follows anchor state updates", async () => {
  const dbPath = tmpDbPath("keyword-update");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "lexical/update", "keyword-update");
      await insertNode(writeStore, {
        id: "updatable-node",
        scope: "lexical/update",
        title: "Initial route",
        textSummary: "No rare marker yet.",
        slots: {},
        embeddingVector: null,
        embeddingStatus: "pending",
        commitId,
      });
      await writeStore.updateNodeAnchorState({
        scope: "lexical/update",
        id: "updatable-node",
        slots: {
          target_files: ["src/runtime/quartzRouter.ts"],
          workflow_signature: "quartz-router",
        },
        textSummary: "The accepted route now uses QuartzRouterBoundary.",
        salience: 0.9,
        importance: 0.5,
        confidence: 0.9,
        commitId,
      });
    });

    const lexical = await recallStore.createRecallAccess().stage1LexicalCandidates({
      queryText: "QuartzRouterBoundary",
      scope: "lexical/update",
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(lexical[0]?.id, "updatable-node");
    assert.equal(lexical[0]?.sources?.[0]?.kind, "lexical");
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});
