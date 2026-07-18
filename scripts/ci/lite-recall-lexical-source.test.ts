import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-recall-lexical-"));
  return path.join(dir, `${name}.sqlite`);
}

async function insertCommit(store: ReturnType<typeof createLiteWriteStore>, scope: string, suffix: string): Promise<string> {
  return store.insertLegacyV1CommitForMigrationOrTestFixture({
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

test("ordinary memory write construction feeds alias and fact fields into lexical recall", async () => {
  const dbPath = tmpDbPath("ordinary-memory-construction");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "ordinary/default",
        actor: "qa-test",
        producer_agent_id: "qa-test",
        owner_agent_id: "qa-test",
        input_text: "Aionis Runtime local setup note.",
        auto_embed: false,
        nodes: [{
          client_id: "ordinary:runtime-port",
          type: "concept",
          title: "Runtime port fact",
          text_summary: "The local Aionis Runtime listens on port 3101.",
          slots: {
            aliases: ["local memory service"],
            entities: ["Aionis Runtime"],
            topic_keys: ["deployment", "ports"],
          },
          confidence: 0.92,
        }],
      },
      "default",
      "default",
      {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );
    assert.equal(prepared.nodes.length, 1);
    const ordinary = prepared.nodes[0]?.slots.ordinary_memory_v1 as Record<string, unknown> | undefined;
    assert.equal(ordinary?.schema_version, "ordinary_memory_v1");
    assert.deepEqual(ordinary?.aliases, ["local memory service"]);
    assert.ok(Array.isArray(ordinary?.answerable_facts));
    assert.ok((ordinary?.answerable_facts as string[]).includes("The local Aionis Runtime listens on port 3101."));

    await writeStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        write_access: writeStore,
      }),
    );

    const lexical = await recallStore.createRecallAccess().stage1LexicalCandidates({
      queryText: "local memory service",
      scope: "ordinary/default",
      limit: 5,
      consumerAgentId: "qa-test",
      consumerTeamId: null,
    });
    assert.equal(lexical[0]?.id, prepared.nodes[0]?.id);
    assert.equal(lexical[0]?.sources?.[0]?.kind, "lexical");
    assert.ok(lexical[0]?.sources?.[0]?.matched_fields?.includes("slots_text"));
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("ordinary memory relation facts protect QA evidence in hybrid recall", async () => {
  const dbPath = tmpDbPath("ordinary-memory-relation-qa");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "ordinary/qa",
        actor: "qa-test",
        producer_agent_id: "qa-test",
        owner_agent_id: "qa-test",
        input_text: "MemoryData relation fact.",
        auto_embed: false,
        nodes: [{
          client_id: "ordinary:memorydata:sister-hobby",
          type: "concept",
          title: "MemoryData source 17",
          text_summary: "Session 1 - Turn 18. User: My sister enjoys Camping on quiet weekends.",
          confidence: 0.86,
          evidence_ref: "17,17|0",
          slots: {
            source_ids: ["17", "17|0"],
            sample_id: "qa_relation_fact",
          },
        }],
      },
      "default",
      "default",
      {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );

    const ordinary = prepared.nodes[0]?.slots.ordinary_memory_v1 as Record<string, unknown> | undefined;
    assert.ok(Array.isArray(ordinary?.relation_facts));
    assert.deepEqual(ordinary?.source_ids, ["17", "17|0"]);
    assert.ok(JSON.stringify(ordinary?.relation_facts).includes("sister"));
    assert.ok(JSON.stringify(ordinary?.relation_facts).includes("Camping"));

    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "ordinary/qa", "ordinary-memory-relation-qa-distractors");
      for (let index = 0; index < 4; index += 1) {
        await insertNode(writeStore, {
          id: `semantic-distractor-${index}`,
          scope: "ordinary/qa",
          title: `Unrelated memory ${index}`,
          textSummary: `A different personal fact about office location and meeting notes ${index}.`,
          slots: { source_ids: [`distractor-${index}`] },
          embeddingVector: [1, 0, 0],
          embeddingStatus: "ready",
          commitId,
        });
      }
    });

    await writeStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        write_access: writeStore,
      }),
    );

    const hybrid = await recallStore.createRecallAccess().stage1HybridCandidates({
      queryText: "What hobby does my sister enjoy?",
      queryEmbedding: [1, 0, 0],
      scope: "ordinary/qa",
      limit: 3,
      oversample: 3,
      consumerAgentId: "qa-test",
      consumerTeamId: null,
    });

    assert.equal(hybrid[0]?.id, prepared.nodes[0]?.id);
    assert.ok(hybrid[0]?.sources?.some((source) => source.kind === "lexical"));
    assert.ok(
      hybrid[0]?.sources?.some((source) =>
        source.matched_fields?.some((field) =>
          field === "ordinary_memory_v1.relation_facts" || field === "ordinary_memory_v1.question_keys")),
    );
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("ordinary memory write construction does not attach to execution-native procedure memories", async () => {
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "ordinary/default",
      actor: "qa-test",
      producer_agent_id: "qa-test",
      owner_agent_id: "qa-test",
      input_text: "Execution route note.",
      auto_embed: false,
      nodes: [{
        client_id: "execution:route",
        type: "procedure",
        title: "Execution route",
        text_summary: "Continue the verified execution route.",
        slots: {
          task_signature: "runtime-route",
          target_files: ["src/runtime.ts"],
        },
      }],
    },
    "default",
    "default",
    {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );

  assert.equal(prepared.nodes[0]?.slots.ordinary_memory_v1, undefined);
  assert.equal(prepared.nodes[0]?.slots.task_signature, "runtime-route");
});
