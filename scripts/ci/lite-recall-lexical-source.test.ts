import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeExecutionEpisodeV7ObjectsForPreviousSchemaFixture } from
  "./schema-fixture-helpers.ts";
import { runAppliedAuthorityMutationV2 } from
  "../../src/memory/applied-authority-mutation.ts";
import {
  applyNodeAuthorityPatchesV2,
  buildNodeAuthorityMutationV2,
  verifyNodeAuthorityPatchesV2,
  type NodeAuthorityPatchV2,
} from "../../src/memory/node-authority-mutation.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { inspectLiteMemoryCommitAuthority } from
  "../../src/store/lite-memory-commit-integrity.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStore,
  createLiteWriteStoreFromDatabase,
} from "../../src/store/lite-write-store.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { sha256Hex } from "../../src/util/crypto.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-recall-lexical-"));
  return path.join(dir, `${name}.sqlite`);
}

const EMBEDDING_DIMENSIONS = 1_536;

function embedding(values: number[]): number[] {
  assert.ok(values.length > 0 && values.length <= EMBEDDING_DIMENSIONS);
  return values.length === EMBEDDING_DIMENSIONS
    ? [...values]
    : [...values, ...Array.from({ length: EMBEDDING_DIMENSIONS - values.length }, () => 0)];
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

async function prepareMigratedLexicalFixture(
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
      removeExecutionEpisodeV7ObjectsForPreviousSchemaFixture(
        legacyDatabase.db,
      );
      legacyDatabase.db.exec("DROP TABLE lite_runtime_authority_adoption_bindings");
      legacyDatabase.db.exec("DROP TABLE lite_runtime_authority_adoption_manifests");
      const metadataUpdate = legacyDatabase.db.prepare(
        `UPDATE lite_runtime_schema_metadata
         SET version = 5, updated_at = ?
         WHERE component = 'write_projection'`,
      ).run("2026-07-19T00:00:00.000Z");
      assert.equal(Number(metadataUpdate.changes ?? 0), 1);
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
    if (!legacyStoreClosed) await legacyStore.close();
    await legacyDatabase.close();
  }

  const migratedStore = createLiteWriteStore(dbPath, { annProjectionEnabled: false });
  await migratedStore.close();
  const migrated = createSqliteDatabase(dbPath);
  try {
    const metadata = migrated.prepare(
      `SELECT version FROM lite_runtime_schema_metadata
       WHERE component = 'write_projection'`,
    ).get() as { version: number } | undefined;
    assert.equal(metadata?.version, 8);
    const authority = inspectLiteMemoryCommitAuthority(migrated);
    assert.equal(authority.ok, true, JSON.stringify(authority.findings));
    assert.ok(authority.adoption_manifest_count > 0);
    assert.ok(authority.adoption_binding_count > 0);
    assert.equal(authority.adoption_binding_verified_count, authority.adoption_binding_count);
  } finally {
    migrated.close();
  }
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
  await prepareMigratedLexicalFixture(dbPath, async (writeStore) => {
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
        embeddingVector: embedding([1, 0, 0]),
        commitId,
      });
    });
  });

  const recallStore = createLiteRecallStore(dbPath);
  try {
    const access = recallStore.createRecallAccess();
    const semantic = await access.stage1SemanticCandidates({
      queryEmbedding: embedding([1, 0, 0]),
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
  }
});

test("lexical recall index follows anchor state updates", async () => {
  const dbPath = tmpDbPath("keyword-update");
  const scope = "lexical/update";
  const nodeId = "updatable-node";
  await prepareMigratedLexicalFixture(dbPath, async (writeStore) => {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, scope, "keyword-update");
      await insertNode(writeStore, {
        id: nodeId,
        scope,
        title: "Initial route",
        textSummary: "No rare marker yet.",
        slots: {},
        embeddingVector: null,
        embeddingStatus: "pending",
        commitId,
      });
    });
  });

  const writeStore = createLiteWriteStore(dbPath, { annProjectionEnabled: false });
  const recallStore = createLiteRecallStore(dbPath);
  try {
    const beforeStates = await writeStore.nodeStatesByIds(scope, [nodeId]);
    const before = beforeStates.get(nodeId);
    assert.ok(before);
    const patch: NodeAuthorityPatchV2 = {
      id: nodeId,
      slots: {
        target_files: ["src/runtime/quartzRouter.ts"],
        workflow_signature: "quartz-router",
      },
      textSummary: "The accepted route now uses QuartzRouterBoundary.",
      salience: 0.9,
      importance: 0.5,
      confidence: 0.9,
    };
    const updated = await runAppliedAuthorityMutationV2({
      store: writeStore,
      scope,
      actor: "lexical-test",
      inputSha256: sha256Hex(`lexical-anchor-update:${nodeId}`),
      plan: async () => ({
        status: "mutate" as const,
        authorityKind: "lexical_anchor_update_test",
        mutations: [buildNodeAuthorityMutationV2({ before, patch })],
        async apply({ commitId }) {
          await applyNodeAuthorityPatchesV2({
            store: writeStore,
            scope,
            patches: [patch],
            commitId,
          });
          return true;
        },
        async verify({ commitId }) {
          return await verifyNodeAuthorityPatchesV2({
            store: writeStore,
            scope,
            patches: [patch],
            commitId,
            errorLabel: "lexical_anchor_update_test",
          });
        },
      }),
    });
    assert.equal(updated.status, "applied");

    const lexical = await recallStore.createRecallAccess().stage1LexicalCandidates({
      queryText: "QuartzRouterBoundary",
      scope,
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

  await prepareMigratedLexicalFixture(dbPath, async (writeStore) => {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "ordinary/qa", "ordinary-memory-relation-qa-distractors");
      for (let index = 0; index < 4; index += 1) {
        await insertNode(writeStore, {
          id: `semantic-distractor-${index}`,
          scope: "ordinary/qa",
          title: `Unrelated memory ${index}`,
          textSummary: `A different personal fact about office location and meeting notes ${index}.`,
          slots: { source_ids: [`distractor-${index}`] },
          embeddingVector: embedding([1, 0, 0]),
          embeddingStatus: "ready",
          commitId,
        });
      }
    });
  });

  const writeStore = createLiteWriteStore(dbPath, { annProjectionEnabled: false });
  const recallStore = createLiteRecallStore(dbPath);
  try {
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
      queryEmbedding: embedding([1, 0, 0]),
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
