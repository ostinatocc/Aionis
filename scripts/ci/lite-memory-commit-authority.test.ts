import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import stableStringify from "fast-json-stable-stringify";

import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../src/store/lite-runtime-schema.ts";
import { createSqliteDatabase, type SqliteDatabase } from "../../src/store/sqlite.ts";
import {
  inspectLiteMemoryCommitAuthority,
  LITE_MEMORY_COMMIT_AUTHORITY_V2_SCAN_SQL,
} from "../../src/store/lite-memory-commit-integrity.ts";
import {
  backupLiteRuntimeDatabase,
  verifyLiteRuntimeDatabase,
} from "../../src/store/lite-runtime-data-operations.ts";
import {
  createLiteWriteStore,
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.ts";
import { writeEdgeIdentityKey } from "../../src/store/write-access.ts";
import {
  buildCanonicalAppliedAuthorityMutationV2,
  canonicalV2CommitHash,
} from "../../src/store/write-commit-authority.ts";
import { stableUuid } from "../../src/util/uuid.ts";
import { buildLearningControlOperationOutcomeEvidenceV2 } from
  "../../src/memory/learning-episode-ledger.ts";
import { nodeAuthorityStateV2 } from "../../src/memory/node-authority-mutation.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tempDatabase(name: string): { directory: string; path: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-commit-authority-${name}-`));
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function createLegacyV1FixtureStore(databasePath: string): LiteWriteStore {
  return createLiteWriteStore(databasePath, {
    annProjectionEnabled: false,
    allowLegacyV1Fixtures: true,
  });
}

function downgradeCurrentFixtureToV4(db: SqliteDatabase): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TABLE lite_runtime_authority_adoption_bindings");
    db.exec("DROP TABLE lite_runtime_authority_adoption_manifests");
    db.exec("DROP INDEX idx_lite_memory_commits_scope_revision");
    db.exec("DROP TABLE lite_memory_scope_heads");
    for (const column of [
      "legacy_anchor_commit_id",
      "mutation_digest",
      "revision",
      "digest_version",
    ]) {
      db.exec(`ALTER TABLE lite_memory_commits DROP COLUMN ${column}`);
    }
    db.prepare(
      `UPDATE lite_runtime_schema_metadata
       SET version = 4, updated_at = ?
       WHERE component = 'write_projection'`,
    ).run("2026-07-18T00:00:00.000Z");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertLegacyCommitRow(db: SqliteDatabase, args: {
  id: string;
  scope: string;
  hash: string;
  createdAt: string;
}): void {
  db.prepare(
    `INSERT INTO lite_memory_commits
      (id, scope, parent_commit_id, input_sha256, diff_json, actor,
       model_version, prompt_version, commit_hash, created_at)
     VALUES (?, ?, NULL, ?, '{}', 'legacy-fixture', NULL, NULL, ?, ?)`,
  ).run(args.id, args.scope, sha256(`input:${args.id}`), args.hash, args.createdAt);
}

async function prepareLegacyV4Fixture(
  databasePath: string,
  seed: (db: SqliteDatabase) => void,
): Promise<void> {
  const initialized = createLiteWriteStore(databasePath, { annProjectionEnabled: false });
  await initialized.close();
  const db = createSqliteDatabase(databasePath);
  try {
    downgradeCurrentFixtureToV4(db);
    seed(db);
  } finally {
    db.close();
  }
}

function insertLegacyNodeRow(db: SqliteDatabase, args: {
  id: string;
  scope: string;
  commitId: string;
  createdAt: string;
  clientId?: string | null;
  title?: string;
  textSummary?: string | null;
  slotsJson?: Record<string, unknown>;
  evidenceRef?: string | null;
  producerAgentId?: string | null;
  ownerAgentId?: string | null;
  salience?: number;
  importance?: number;
  confidence?: number;
}): void {
  db.prepare(
    `INSERT INTO lite_memory_nodes
      (id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
       embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
       owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
       redaction_version, commit_id, created_at)
     VALUES (?, ?, ?, 'concept', 'hot', ?, ?, ?, NULL, ?, NULL, NULL, 'shared', ?, ?, NULL,
             'pending', NULL, ?, ?, ?, 1, ?, ?)`,
  ).run(
    args.id,
    args.scope,
    args.clientId ?? null,
    args.title ?? args.id,
    args.textSummary ?? null,
    stableStringify(args.slotsJson ?? {}),
    args.evidenceRef ?? null,
    args.producerAgentId ?? null,
    args.ownerAgentId ?? null,
    args.salience ?? 0.5,
    args.importance ?? 0.5,
    args.confidence ?? 0.5,
    args.commitId,
    args.createdAt,
  );
}

function insertLegacyEdgeRow(db: SqliteDatabase, args: {
  id: string;
  scope: string;
  type: string;
  srcId: string;
  dstId: string;
  weight: number;
  confidence: number;
  decayRate: number;
  metadataJson: Record<string, unknown>;
  commitId: string;
  createdAt: string;
}): void {
  db.prepare(
    `INSERT INTO lite_memory_edges
      (id, scope, type, src_id, dst_id, weight, confidence, decay_rate, metadata_json,
       commit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.scope,
    args.type,
    args.srcId,
    args.dstId,
    args.weight,
    args.confidence,
    args.decayRate,
    stableStringify(args.metadataJson),
    args.commitId,
    args.createdAt,
  );
}

function v2CommitArgs(args: {
  scope: string;
  revision: number;
  parentCommitId: string | null;
  parentHash: string;
  legacyAnchorCommitId: string | null;
  label: string;
  slotsJson?: Record<string, unknown>;
}) {
  const createdAt = new Date(Date.UTC(2026, 6, 18, 0, 0, 0, args.revision)).toISOString();
  const requestedNode = {
    id: `fixture-node-${args.revision}`,
    scope: args.scope,
    client_id: null,
    type: "concept",
    tier: "hot",
    title: args.label,
    text_summary: null,
    slots_json: args.slotsJson ?? { test_label: args.label, test_revision: args.revision },
    raw_ref: null,
    evidence_ref: null,
    embedding_vector_json: null,
    embedding_model: null,
    memory_lane: "shared",
    producer_agent_id: null,
    owner_agent_id: null,
    owner_team_id: null,
    embedding_status: "pending",
    embedding_last_error: null,
    salience: 0.5,
    importance: 0.5,
    confidence: 0.5,
    redaction_version: 1,
  };
  const diffJson = stableStringify({
    contract: "aionis_applied_write_mutation_v2",
    digest_version: 2,
    applied_at: createdAt,
    redaction: {},
    policy: {
      node_identity: "id",
      node_existing: "no_op_if_identical_otherwise_reject",
      node_commit_id: "self_on_insert",
      node_created_at: "allocate_on_insert",
      edge_identity: "scope_type_src_dst",
      edge_id: "preserve_existing",
      edge_weight: "monotonic_max",
      edge_confidence: "monotonic_max",
      edge_decay_rate: "replace",
      edge_metadata: "replace",
      edge_commit_id: "self_on_applied_mutation",
      edge_created_at: "allocate_on_insert_preserve_on_update",
      rule_def_identity: "scope_rule_node_id",
      rule_def_existing: "no_op_if_present_insert_if_missing",
      rule_def_commit_id: "self_on_insert",
      rule_def_created_at: "bind_applied_at",
      rule_def_updated_at: "bind_applied_at",
      rule_def_counters: "initialize_zero",
      unchanged_mutation: "no_op",
    },
    nodes: [{
      operation: "insert",
      requested: requestedNode,
      before: null,
      after: { ...requestedNode, commit_id: "$self", created_at: createdAt },
    }],
    edges: [],
    rule_defs: [],
  });
  const mutationDigest = sha256(diffJson);
  const inputSha256 = sha256(`input:${args.label}`);
  const commitHash = canonicalV2CommitHash({
    digestVersion: 2,
    revision: args.revision,
    parentHash: args.parentHash,
    inputSha256,
    mutationDigest,
    scope: args.scope,
    actor: "commit-authority-test",
    modelVersion: null,
    promptVersion: null,
  });
  return {
    scope: args.scope,
    parentCommitId: args.parentCommitId,
    inputSha256,
    diffJson,
    actor: "commit-authority-test",
    modelVersion: null,
    promptVersion: null,
    commitHash,
    digestVersion: 2 as const,
    revision: args.revision,
    mutationDigest,
    legacyAnchorCommitId: args.legacyAnchorCommitId,
    createdAt,
  };
}

async function insertV2AndAdvance(
  store: LiteWriteStore,
  args: ReturnType<typeof v2CommitArgs>,
  expectedCommitId: string | null,
) {
  return await store.withTx(async () => {
    const commitId = await store.insertCommit(args);
    await applyV2NodeMutations(store, args, commitId);
    const cas = await store.compareAndSwapScopeHead({
      scope: args.scope,
      commitId,
      expectedRevision: args.revision - 1,
      expectedCommitId,
    });
    assert.equal(cas.status, "advanced");
    return { commitId, head: cas.head };
  });
}

async function applyV2NodeMutations(
  store: LiteWriteStore,
  args: ReturnType<typeof v2CommitArgs>,
  commitId: string,
): Promise<void> {
  const mutation = JSON.parse(args.diffJson) as {
    nodes: Array<{ after: Record<string, any> }>;
  };
  for (const { after } of mutation.nodes) {
    await store.insertNode({
      id: after.id,
      scope: after.scope,
      clientId: after.client_id,
      type: after.type,
      tier: after.tier,
      title: after.title,
      textSummary: after.text_summary,
      slotsJson: stableStringify(after.slots_json),
      rawRef: after.raw_ref,
      evidenceRef: after.evidence_ref,
      embeddingVector: after.embedding_vector_json === null
        ? null
        : stableStringify(after.embedding_vector_json),
      embeddingModel: after.embedding_model,
      memoryLane: after.memory_lane,
      producerAgentId: after.producer_agent_id,
      ownerAgentId: after.owner_agent_id,
      ownerTeamId: after.owner_team_id,
      embeddingStatus: after.embedding_status,
      embeddingLastError: after.embedding_last_error,
      salience: after.salience,
      importance: after.importance,
      confidence: after.confidence,
      redactionVersion: after.redaction_version,
      commitId,
      createdAt: after.created_at,
    });
  }
}

test("v4-to-v5 migration preserves v1 hashes and exposes the highest-rowid legacy boundary", async () => {
  const temp = tempDatabase("v4-migration");
  try {
    const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await initialized.close();

    const v4 = createSqliteDatabase(temp.path);
    downgradeCurrentFixtureToV4(v4);
    insertLegacyCommitRow(v4, {
      id: "legacy-future-created-at",
      scope: "scope/migrated",
      hash: sha256("legacy-future-created-at"),
      createdAt: "2099-01-01T00:00:00.000Z",
    });
    insertLegacyCommitRow(v4, {
      id: "legacy-highest-rowid",
      scope: "scope/migrated",
      hash: sha256("legacy-highest-rowid"),
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    assert.equal(inspectLiteRuntimeSchema(v4).classification, "supported_previous_v4");
    v4.close();

    const migrated = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    const head = await migrated.readScopeHead("scope/migrated");
    assert.deepEqual(head, {
      scope: "scope/migrated",
      commitId: "legacy-highest-rowid",
      commitHash: sha256("legacy-highest-rowid"),
      revision: 0,
      digestVersion: 1,
      legacyAnchorCommitId: "legacy-highest-rowid",
      persisted: false,
      updatedAt: "2000-01-01T00:00:00.000Z",
    });
    await migrated.close();

    const verified = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteRuntimeSchema(verified).classification, "current");
      assert.equal(LITE_RUNTIME_WRITE_SCHEMA_VERSION, 6);
      const rows = verified.prepare(
        `SELECT id, commit_hash, digest_version, revision, mutation_digest,
                legacy_anchor_commit_id
         FROM lite_memory_commits
         ORDER BY rowid`,
      ).all() as Array<Record<string, unknown>>;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.commit_hash, sha256("legacy-future-created-at"));
      assert.equal(rows[1]?.commit_hash, sha256("legacy-highest-rowid"));
      for (const row of rows) {
        assert.equal(row.digest_version, 1);
        assert.equal(row.revision, null);
        assert.equal(row.mutation_digest, null);
        assert.equal(row.legacy_anchor_commit_id, null);
      }
      assert.equal(
        (verified.prepare("SELECT COUNT(*) AS count FROM lite_memory_scope_heads").get() as { count: number }).count,
        0,
      );
    } finally {
      verified.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v5 migration DDL and metadata roll back together without rewriting legacy commits", async () => {
  const temp = tempDatabase("v5-migration-rollback");
  try {
    const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await initialized.close();
    const v4 = createSqliteDatabase(temp.path);
    downgradeCurrentFixtureToV4(v4);
    insertLegacyCommitRow(v4, {
      id: "legacy-preserved",
      scope: "scope/rollback",
      hash: sha256("legacy-preserved"),
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    v4.close();

    const database = createLiteRuntimeDatabase(temp.path);
    try {
      assert.throws(
        () => createLiteWriteStoreFromDatabase(database, {
          annProjectionEnabled: false,
          schemaMigrationFaultInjector(phase) {
            if (phase === "after_commit_authority_structures") {
              throw new Error("injected-v5-migration-failure");
            }
          },
        }),
        /injected-v5-migration-failure/,
      );
    } finally {
      await database.close();
    }

    const rolledBack = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteRuntimeSchema(rolledBack).classification, "supported_previous_v4");
      const columns = (rolledBack.prepare("PRAGMA table_info(lite_memory_commits)").all() as Array<{ name: string }>)
        .map((row) => row.name);
      assert.equal(columns.includes("digest_version"), false);
      assert.equal(
        rolledBack.prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='lite_memory_scope_heads'",
        ).get(),
        undefined,
      );
      assert.equal(
        (rolledBack.prepare(
          "SELECT commit_hash FROM lite_memory_commits WHERE id='legacy-preserved'",
        ).get() as { commit_hash: string }).commit_hash,
        sha256("legacy-preserved"),
      );
    } finally {
      rolledBack.close();
    }

    const retry = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await retry.close();
    const current = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteRuntimeSchema(current).classification, "current");
    } finally {
      current.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("scope head binds the legacy rowid boundary, advances monotonically, and rejects later v1 writes", async () => {
  const temp = tempDatabase("head-cas");
  try {
    const store = createLegacyV1FixtureStore(temp.path);
    const legacyFirst = await store.insertLegacyV1CommitForMigrationOrTestFixture({
      scope: "scope/cas",
      parentCommitId: null,
      inputSha256: sha256("legacy-first-input"),
      diffJson: "{}",
      actor: "legacy-test",
      modelVersion: null,
      promptVersion: null,
      commitHash: sha256("legacy-first"),
      createdAt: "2099-01-01T00:00:00.000Z",
    });
    const legacyAnchor = await store.insertLegacyV1CommitForMigrationOrTestFixture({
      scope: "scope/cas",
      parentCommitId: null,
      inputSha256: sha256("legacy-anchor-input"),
      diffJson: "{}",
      actor: "legacy-test",
      modelVersion: null,
      promptVersion: null,
      commitHash: sha256("legacy-anchor"),
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    assert.notEqual(legacyFirst, legacyAnchor);
    const legacy = await store.readScopeHead("scope/cas");
    assert.equal(legacy?.commitId, legacyAnchor);
    assert.equal(legacy?.revision, 0);
    assert.equal(legacy?.persisted, false);

    const first = await insertV2AndAdvance(store, v2CommitArgs({
      scope: "scope/cas",
      revision: 1,
      parentCommitId: legacyAnchor,
      parentHash: sha256("legacy-anchor"),
      legacyAnchorCommitId: legacyAnchor,
      label: "first-v2",
    }), legacyAnchor);
    assert.equal(first.head.revision, 1);
    assert.equal(first.head.legacyAnchorCommitId, legacyAnchor);
    assert.equal(first.head.persisted, true);

    await assert.rejects(
      store.insertLegacyV1CommitForMigrationOrTestFixture({
        scope: "scope/cas",
        parentCommitId: first.commitId,
        inputSha256: sha256("late-v1-input"),
        diffJson: "{}",
        actor: "late-v1",
        modelVersion: null,
        promptVersion: null,
        commitHash: sha256("late-v1"),
      }),
      /lite_memory_commit_v1_after_v2_head_forbidden/,
    );

    const second = await insertV2AndAdvance(store, v2CommitArgs({
      scope: "scope/cas",
      revision: 2,
      parentCommitId: first.commitId,
      parentHash: first.head.commitHash,
      legacyAnchorCommitId: legacyAnchor,
      label: "second-v2",
    }), first.commitId);
    assert.equal(second.head.revision, 2);
    const latest = await store.latestCommit("scope/cas");
    assert.deepEqual(latest, {
      id: second.commitId,
      commit_hash: second.head.commitHash,
      revision: 2,
      digest_version: 2,
      persisted_head: true,
    });

    await assert.rejects(
      store.compareAndSwapScopeHead({
        scope: "scope/cas",
        commitId: second.commitId,
        expectedRevision: 1,
        expectedCommitId: first.commitId,
      }),
      /lite_runtime_authority_requires_shared_transaction/,
    );
    await store.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("low-level v2 insert rejects noncanonical JSON and tampered mutation or commit digests", async () => {
  const temp = tempDatabase("v2-tamper-fence");
  try {
    const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    const valid = v2CommitArgs({
      scope: "scope/tamper",
      revision: 1,
      parentCommitId: null,
      parentHash: "",
      legacyAnchorCommitId: null,
      label: "valid",
    });

    await store.withTx(async () => {
      await assert.rejects(
        store.insertCommit({ ...valid, mutationDigest: "0".repeat(64) }),
        /lite_memory_commit_v2_mutation_digest_mismatch/,
      );
    });

    const noncanonicalDiff = JSON.stringify(JSON.parse(valid.diffJson), null, 2);
    const noncanonicalDigest = sha256(noncanonicalDiff);
    await store.withTx(async () => {
      await assert.rejects(
        store.insertCommit({
          ...valid,
          diffJson: noncanonicalDiff,
          mutationDigest: noncanonicalDigest,
          commitHash: canonicalV2CommitHash({
            digestVersion: 2,
            revision: valid.revision,
            parentHash: "",
            inputSha256: valid.inputSha256,
            mutationDigest: noncanonicalDigest,
            scope: valid.scope,
            actor: valid.actor,
            modelVersion: valid.modelVersion,
            promptVersion: valid.promptVersion,
          }),
        }),
        /lite_memory_commit_v2_diff_json_noncanonical/,
      );
    });

    await store.withTx(async () => {
      await assert.rejects(
        store.insertCommit({ ...valid, commitHash: "f".repeat(64) }),
        /lite_memory_commit_v2_commit_hash_mismatch/,
      );
    });

    const db = createSqliteDatabase(temp.path);
    try {
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM lite_memory_commits WHERE scope='scope/tamper'").get() as { count: number }).count,
        0,
      );
    } finally {
      db.close();
    }
    await store.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("low-level v2 insert rejects incomplete, extra, and misordered node or edge authority rows", async () => {
  const temp = tempDatabase("v2-mutation-shape-fence");
  try {
    const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    const valid = v2CommitArgs({
      scope: "scope/mutation-shape",
      revision: 1,
      parentCommitId: null,
      parentHash: "",
      legacyAnchorCommitId: null,
      label: "mutation-shape",
    });
    const baseMutation = JSON.parse(valid.diffJson) as Record<string, any>;
    const edgeMutation = (suffix: string) => ({
      operation: "insert",
      requested: {
        id: `edge-${suffix}`,
        scope: valid.scope,
        type: "related_to",
        src_id: `src-${suffix}`,
        dst_id: `dst-${suffix}`,
        weight: 0.5,
        confidence: 0.5,
        decay_rate: 0.01,
        metadata_json: { suffix },
      },
      before: null,
      after: {
        id: `edge-${suffix}`,
        scope: valid.scope,
        type: "related_to",
        src_id: `src-${suffix}`,
        dst_id: `dst-${suffix}`,
        weight: 0.5,
        confidence: 0.5,
        decay_rate: 0.01,
        metadata_json: { suffix },
        commit_id: "$self",
        created_at: valid.createdAt,
      },
    });
    const commitArgsFor = (mutation: Record<string, unknown>) => {
      const diffJson = stableStringify(mutation);
      const mutationDigest = sha256(diffJson);
      return {
        ...valid,
        diffJson,
        mutationDigest,
        commitHash: canonicalV2CommitHash({
          digestVersion: 2,
          revision: valid.revision,
          parentHash: "",
          inputSha256: valid.inputSha256,
          mutationDigest,
          scope: valid.scope,
          actor: valid.actor,
          modelVersion: valid.modelVersion,
          promptVersion: valid.promptVersion,
        }),
      };
    };

    const incompleteNode = structuredClone(baseMutation);
    delete incompleteNode.nodes[0].after.confidence;
    const extraEdge = structuredClone(baseMutation);
    extraEdge.edges = [edgeMutation("extra")];
    extraEdge.edges[0].requested.unregistered_column = true;
    const misorderedEdges = structuredClone(baseMutation);
    misorderedEdges.edges = [edgeMutation("z"), edgeMutation("a")];
    const invalidNodeOperation = structuredClone(baseMutation);
    invalidNodeOperation.nodes[0].operation = "update";
    invalidNodeOperation.nodes[0].before = invalidNodeOperation.nodes[0].after;

    for (const [mutation, expected] of [
      [incompleteNode, /lite_memory_commit_v2_node_after_keys_invalid/],
      [extraEdge, /lite_memory_commit_v2_edge_requested_keys_invalid/],
      [misorderedEdges, /lite_memory_commit_v2_edge_mutation_order_invalid/],
      [invalidNodeOperation, /lite_memory_commit_v2_node_mutation_invalid/],
    ] as const) {
      await store.withTx(async () => {
        await assert.rejects(store.insertCommit(commitArgsFor(mutation)), expected);
      });
    }
    await store.close();
    const db = createSqliteDatabase(temp.path);
    try {
      assert.equal(Number((db.prepare(
        "SELECT COUNT(*) AS count FROM lite_memory_commits",
      ).get() as { count: number }).count), 0);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("one thousand dense v2 writes have a single monotonic head with no timestamp ordering dependency", async () => {
  const temp = tempDatabase("dense-head");
  try {
    const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    let parent: string | null = null;
    let parentHash = "";
    for (let revision = 1; revision <= 1_000; revision += 1) {
      const planned = v2CommitArgs({
        scope: "scope/dense",
        revision,
        parentCommitId: parent,
        parentHash,
        legacyAnchorCommitId: null,
        label: `dense-${revision}`,
      });
      const advanced = await insertV2AndAdvance(store, planned, parent);
      parent = advanced.commitId;
      parentHash = planned.commitHash;
    }
    const head = await store.readScopeHead("scope/dense");
    assert.equal(head?.revision, 1_000);
    assert.equal(head?.commitId, parent);
    assert.equal(head?.persisted, true);
    const latest = await store.latestCommit("scope/dense");
    assert.equal(latest?.id, parent);
    assert.equal(latest?.revision, 1_000);
    await store.close();

    const db = createSqliteDatabase(temp.path);
    try {
      const authority = inspectLiteMemoryCommitAuthority(db);
      assert.equal(authority.ok, true);
      assert.equal(authority.v2_commit_count, 1_000);
      assert.equal(
        (db.prepare(
          "SELECT COUNT(*) AS count FROM lite_memory_commits WHERE scope='scope/dense' AND digest_version=2",
        ).get() as { count: number }).count,
        1_000,
      );
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM lite_memory_scope_heads WHERE scope='scope/dense'").get() as { count: number }).count,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("independent SQLite writers produce one CAS winner and expose the committed current head to the loser", async () => {
  const temp = tempDatabase("concurrent-cas");
  try {
    const leftDatabase = createLiteRuntimeDatabase(temp.path);
    const left = createLiteWriteStoreFromDatabase(leftDatabase, { annProjectionEnabled: false });
    const rightDatabase = createLiteRuntimeDatabase(temp.path);
    const right = createLiteWriteStoreFromDatabase(rightDatabase, { annProjectionEnabled: false });
    // DatabaseSync busy_timeout blocks the JS thread. Use non-blocking BEGIN
    // retries here so the holder can commit while the contender yields.
    leftDatabase.db.exec("PRAGMA busy_timeout = 0");
    rightDatabase.db.exec("PRAGMA busy_timeout = 0");
    const planned = v2CommitArgs({
      scope: "scope/concurrent",
      revision: 1,
      parentCommitId: null,
      parentHash: "",
      legacyAnchorCommitId: null,
      label: "same-operation-replay",
    });

    const attempt = async (store: LiteWriteStore) => await store.withTx(async () => {
      const commitId = await store.insertCommit(planned);
      await applyV2NodeMutations(store, planned, commitId);
      return await store.compareAndSwapScopeHead({
        scope: planned.scope,
        commitId,
        expectedRevision: 0,
        expectedCommitId: null,
      });
    }, { beginBusyRetry: { maxAttempts: 12, delayMs: 10 } });
    const outcomes = await Promise.all([attempt(left), attempt(right)]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "advanced").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "conflict").length, 1);
    const conflict = outcomes.find((outcome) => outcome.status === "conflict");
    assert.equal(conflict?.current?.revision, 1);
    assert.equal(conflict?.current?.commitHash, planned.commitHash);
    assert.equal((await left.readScopeHead(planned.scope))?.revision, 1);
    assert.equal((await right.readScopeHead(planned.scope))?.revision, 1);
    await left.close();
    await right.close();
    await leftDatabase.close();
    await rightDatabase.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("canonical state readers return persisted node and resolved edge values including replaced decay", async () => {
  const temp = tempDatabase("state-readers");
  try {
    const firstCommit = "legacy-state-commit-1";
    const secondCommit = "legacy-state-commit-2";
    await prepareLegacyV4Fixture(temp.path, (db) => {
      insertLegacyCommitRow(db, {
        id: firstCommit,
        scope: "scope/states",
        hash: sha256("states-commit-1"),
        createdAt: "2026-07-18T01:00:00.000Z",
      });
      insertLegacyCommitRow(db, {
        id: secondCommit,
        scope: "scope/states",
        hash: sha256("states-commit-2"),
        createdAt: "2026-07-18T01:00:02.000Z",
      });
      insertLegacyNodeRow(db, {
        id: "state-node",
        scope: "scope/states",
        clientId: "client-state-node",
        title: "State node",
        textSummary: "Persisted state",
        slotsJson: { value: 1 },
        evidenceRef: "evidence://state",
        producerAgentId: "agent-a",
        ownerAgentId: "agent-a",
        salience: 0.4,
        importance: 0.5,
        confidence: 0.6,
        commitId: firstCommit,
        createdAt: "2026-07-18T01:00:00.000Z",
      });
      insertLegacyEdgeRow(db, {
        id: "state-edge",
        scope: "scope/states",
        type: "related_to",
        srcId: "state-node",
        dstId: "state-node-2",
        weight: 0.8,
        confidence: 0.9,
        decayRate: 0.7,
        metadataJson: { version: 2 },
        commitId: secondCommit,
        createdAt: "2026-07-18T01:00:01.000Z",
      });
    });
    const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });

    const nodes = await store.nodeStatesByIds("scope/states", ["state-node"]);
    assert.deepEqual(nodes.get("state-node"), {
      id: "state-node",
      scope: "scope/states",
      clientId: "client-state-node",
      type: "concept",
      tier: "hot",
      title: "State node",
      textSummary: "Persisted state",
      slotsJson: "{\"value\":1}",
      rawRef: null,
      evidenceRef: "evidence://state",
      embeddingVector: null,
      embeddingModel: null,
      memoryLane: "shared",
      producerAgentId: "agent-a",
      ownerAgentId: "agent-a",
      ownerTeamId: null,
      embeddingStatus: "pending",
      embeddingLastError: null,
      salience: 0.4,
      importance: 0.5,
      confidence: 0.6,
      redactionVersion: 1,
      commitId: firstCommit,
      createdAt: "2026-07-18T01:00:00.000Z",
    });
    const identity = { type: "related_to", srcId: "state-node", dstId: "state-node-2" };
    const edges = await store.resolveEdgeStatesByIdentity({
      scope: "scope/states",
      identities: [identity],
    });
    assert.deepEqual(edges.get(writeEdgeIdentityKey(identity)), {
      id: "state-edge",
      scope: "scope/states",
      ...identity,
      weight: 0.8,
      confidence: 0.9,
      decayRate: 0.7,
      metadataJson: { version: 2 },
      commitId: secondCommit,
      createdAt: "2026-07-18T01:00:01.000Z",
    });
    await store.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

async function twoCommitAuthorityFixture(name: string, withLegacy = true): Promise<{
  temp: { directory: string; path: string };
  store: LiteWriteStore;
  legacyId: string | null;
  firstId: string;
  secondId: string;
}> {
  const temp = tempDatabase(name);
  const store = createLegacyV1FixtureStore(temp.path);
  let legacyId: string | null = null;
  let parentHash = "";
  if (withLegacy) {
    legacyId = await store.insertLegacyV1CommitForMigrationOrTestFixture({
      scope: `scope/${name}`,
      parentCommitId: null,
      inputSha256: sha256(`legacy-input:${name}`),
      diffJson: "{}",
      actor: "legacy-authority-fixture",
      modelVersion: null,
      promptVersion: null,
      commitHash: `opaque-legacy-hash:${name}`,
      createdAt: "2099-01-01T00:00:00.000Z",
    });
    parentHash = `opaque-legacy-hash:${name}`;
  }
  const first = await insertV2AndAdvance(store, v2CommitArgs({
    scope: `scope/${name}`,
    revision: 1,
    parentCommitId: legacyId,
    parentHash,
    legacyAnchorCommitId: legacyId,
    label: `${name}-first`,
  }), legacyId);
  const second = await insertV2AndAdvance(store, v2CommitArgs({
    scope: `scope/${name}`,
    revision: 2,
    parentCommitId: first.commitId,
    parentHash: first.head.commitHash,
    legacyAnchorCommitId: legacyId,
    label: `${name}-second`,
  }), first.commitId);
  return {
    temp,
    store,
    legacyId,
    firstId: first.commitId,
    secondId: second.commitId,
  };
}

test("shared verifier preserves opaque root-heavy v1 history and uses rowid as its boundary", async () => {
  const temp = tempDatabase("opaque-root-heavy-v1");
  const store = createLegacyV1FixtureStore(temp.path);
  try {
    await store.insertLegacyV1CommitForMigrationOrTestFixture({
      scope: "scope/opaque-v1",
      parentCommitId: null,
      inputSha256: "legacy-input-is-opaque-too",
      diffJson: "{not-canonical-legacy-json",
      actor: "legacy-root-a",
      modelVersion: null,
      promptVersion: null,
      commitHash: "opaque-root-a",
      createdAt: "2099-01-01T00:00:00.000Z",
    });
    const boundaryId = await store.insertLegacyV1CommitForMigrationOrTestFixture({
      scope: "scope/opaque-v1",
      parentCommitId: null,
      inputSha256: "another-opaque-legacy-input",
      diffJson: "{}",
      actor: "legacy-root-b",
      modelVersion: "unknown-legacy-model",
      promptVersion: null,
      commitHash: "opaque-root-b",
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    const head = await store.readScopeHead("scope/opaque-v1");
    assert.equal(head?.commitId, boundaryId);
    assert.equal(head?.revision, 0);
    assert.equal(head?.persisted, false);
    await store.close();

    const db = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, true);
      assert.equal(report.legacy_commit_count, 2);
      assert.equal(report.v2_commit_count, 0);
      assert.equal(report.legacy_only_scope_count, 1);
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("generic v2 authority mutations cannot authenticate rows from another scope", async () => {
  const temp = tempDatabase("authority-scope-binding");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  try {
    const createdAt = "2026-07-18T02:00:00.000Z";
    const mutation = buildCanonicalAppliedAuthorityMutationV2({
      appliedAt: createdAt,
      authorityKind: "execution_decision",
      mutations: [{
        table: "lite_memory_execution_decisions",
        identity: { scope: "scope/other", id: "decision-cross-scope" },
        operation: "insert",
        before: null,
        after: {
          id: "decision-cross-scope",
          scope: "scope/other",
          decision_kind: "tool_selection",
          run_id: null,
          selected_tool: "safe-tool",
          candidates_json: ["safe-tool"],
          context_sha256: sha256("context"),
          policy_sha256: sha256("policy"),
          source_rule_ids_json: [],
          metadata_json: {},
          commit_id: "$self",
          created_at: createdAt,
        },
      }],
    });
    const diffJson = stableStringify(mutation);
    const mutationDigest = sha256(diffJson);
    const inputSha256 = sha256("cross-scope-authority-input");
    const commitHash = canonicalV2CommitHash({
      digestVersion: 2,
      revision: 1,
      parentHash: "",
      inputSha256,
      mutationDigest,
      scope: "scope/authority",
      actor: "authority-scope-test",
      modelVersion: null,
      promptVersion: null,
    });
    await assert.rejects(
      store.withTx(() => store.insertCommit({
        scope: "scope/authority",
        parentCommitId: null,
        inputSha256,
        diffJson,
        actor: "authority-scope-test",
        modelVersion: null,
        promptVersion: null,
        commitHash,
        digestVersion: 2,
        revision: 1,
        mutationDigest,
        legacyAnchorCommitId: null,
        createdAt,
      })),
      /lite_memory_commit_v2_authority_mutation_scope_mismatch/,
    );
  } finally {
    await store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("partial v5 commit authority shape fails closed instead of falling back to legacy", async () => {
  const temp = tempDatabase("partial-v5-shape");
  const store = createLegacyV1FixtureStore(temp.path);
  try {
    await store.insertLegacyV1CommitForMigrationOrTestFixture({
      scope: "scope/partial-v5",
      parentCommitId: null,
      inputSha256: sha256("partial-v5-input"),
      diffJson: "{}",
      actor: "partial-v5-test",
      modelVersion: null,
      promptVersion: null,
      commitHash: "opaque-partial-v5-hash",
    });
    const db = createSqliteDatabase(temp.path);
    try {
      db.exec("DROP TABLE lite_memory_scope_heads");
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, false);
      assert.equal(report.authority_mode, "incomplete");
      assert.equal(
        report.findings[0]?.code,
        "lite_memory_commit_authority_schema_incomplete",
      );
    } finally {
      db.close();
    }
    await assert.rejects(
      store.readScopeHead("scope/partial-v5"),
      /lite_memory_scope_head_corrupt:scope\/partial-v5:lite_memory_commit_authority_schema_incomplete/,
    );
  } finally {
    await assert.rejects(store.close(), /lite_memory_commit_authority_schema_incomplete/);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("shared verifier rejects every v2 lineage, digest, identity, and head tamper", async (t) => {
  const cases: Array<{
    name: string;
    expected: string;
    tamper(db: SqliteDatabase, fixture: Awaited<ReturnType<typeof twoCommitAuthorityFixture>>): void;
  }> = [
    {
      name: "diff",
      expected: "lite_memory_commit_authority_v2_diff_invalid",
      tamper: (db, fixture) => {
        db.prepare("UPDATE lite_memory_commits SET diff_json = '{}' WHERE id = ?")
          .run(fixture.secondId);
      },
    },
    {
      name: "mutation-digest",
      expected: "lite_memory_commit_authority_v2_digest_mismatch",
      tamper: (db, fixture) => {
        db.prepare("UPDATE lite_memory_commits SET mutation_digest = ? WHERE id = ?")
          .run("0".repeat(64), fixture.secondId);
      },
    },
    {
      name: "commit-hash",
      expected: "lite_memory_commit_authority_v2_hash_mismatch",
      tamper: (db, fixture) => {
        db.prepare("UPDATE lite_memory_commits SET commit_hash = ? WHERE id = ?")
          .run("f".repeat(64), fixture.secondId);
      },
    },
    {
      name: "commit-id",
      expected: "lite_memory_commit_authority_v2_id_mismatch",
      tamper: (db, fixture) => {
        db.prepare("UPDATE lite_memory_commits SET id = 'tampered-v2-id' WHERE id = ?")
          .run(fixture.secondId);
        db.prepare("UPDATE lite_memory_scope_heads SET commit_id = 'tampered-v2-id' WHERE commit_id = ?")
          .run(fixture.secondId);
      },
    },
    {
      name: "revision",
      expected: "lite_memory_commit_authority_v2_revision_discontinuity",
      tamper: (db, fixture) => {
        db.prepare("UPDATE lite_memory_commits SET revision = 3 WHERE id = ?")
          .run(fixture.secondId);
        db.prepare("UPDATE lite_memory_scope_heads SET revision = 3 WHERE commit_id = ?")
          .run(fixture.secondId);
      },
    },
    {
      name: "parent",
      expected: "lite_memory_commit_authority_v2_parent_mismatch",
      tamper: (db, fixture) => {
        db.prepare("UPDATE lite_memory_commits SET parent_commit_id = NULL WHERE id = ?")
          .run(fixture.secondId);
      },
    },
    {
      name: "legacy-anchor",
      expected: "lite_memory_commit_authority_v2_legacy_anchor_mismatch",
      tamper: (db, fixture) => {
        db.prepare("UPDATE lite_memory_commits SET legacy_anchor_commit_id = NULL WHERE id = ?")
          .run(fixture.secondId);
      },
    },
    {
      name: "terminal-head",
      expected: "lite_memory_commit_authority_head_not_terminal",
      tamper: (db, fixture) => {
        db.prepare(
          "UPDATE lite_memory_scope_heads SET commit_id = ?, revision = 1 WHERE commit_id = ?",
        ).run(fixture.firstId, fixture.secondId);
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = await twoCommitAuthorityFixture(`tamper-${entry.name}`);
      try {
        const db = createSqliteDatabase(fixture.temp.path);
        try {
          entry.tamper(db, fixture);
          const report = inspectLiteMemoryCommitAuthority(db);
          assert.equal(report.ok, false);
          assert.ok(
            report.findings.some((value) => value.code === entry.expected),
            JSON.stringify(report.findings),
          );
        } finally {
          db.close();
        }
      } finally {
        await assert.rejects(fixture.store.close(), new RegExp(entry.expected));
        fs.rmSync(fixture.temp.directory, { recursive: true, force: true });
      }
    });
  }
});

test("verify, backup, and ordinary head reads fail closed on a tampered v2 diff", async () => {
  const fixture = await twoCommitAuthorityFixture("consumer-fail-closed", false);
  try {
    const db = createSqliteDatabase(fixture.temp.path);
    try {
      db.prepare("UPDATE lite_memory_commits SET diff_json = '{}' WHERE id = ?")
        .run(fixture.secondId);
    } finally {
      db.close();
    }

    await assert.rejects(
      fixture.store.readScopeHead("scope/consumer-fail-closed"),
      /lite_memory_scope_head_corrupt:scope\/consumer-fail-closed:lite_memory_commit_authority_v2_diff_invalid/,
    );
    const verification = await verifyLiteRuntimeDatabase(fixture.temp.path);
    assert.equal(verification.ok, false);
    assert.ok(verification.integrity_findings.commit_authority_invalid > 0);
    assert.ok(verification.warnings.includes("memory_commit_authority_corrupt"));

    const backupPath = path.join(fixture.temp.directory, "must-not-exist.sqlite");
    await assert.rejects(
      backupLiteRuntimeDatabase({
        sourcePath: fixture.temp.path,
        destinationPath: backupPath,
      }),
      /source_database_verification_failed/,
    );
    assert.equal(fs.existsSync(backupPath), false);
  } finally {
    await assert.rejects(
      fixture.store.close(),
      /lite_memory_commit_authority_v2_diff_invalid/,
    );
    fs.rmSync(fixture.temp.directory, { recursive: true, force: true });
  }
});

test("current-schema startup scans old v2 revisions before mutating derived indexes", async () => {
  const fixture = await twoCommitAuthorityFixture("startup-old-revision", false);
  await fixture.store.close();
  try {
    const db = createSqliteDatabase(fixture.temp.path);
    let derivedBefore: string;
    try {
      db.prepare("UPDATE lite_memory_commits SET diff_json = '{}' WHERE id = ?")
        .run(fixture.firstId);
      derivedBefore = stableStringify({
        keyword: db.prepare(
          "SELECT * FROM lite_memory_keyword_index ORDER BY scope, node_id",
        ).all(),
        execution: db.prepare(
          "SELECT * FROM lite_memory_execution_native_index ORDER BY scope, node_id",
        ).all(),
      });
    } finally {
      db.close();
    }

    assert.throws(
      () => createLiteWriteStore(fixture.temp.path, { annProjectionEnabled: false }),
      /lite_memory_commit_authority_v2_diff_invalid/,
    );

    const after = createSqliteDatabase(fixture.temp.path);
    try {
      assert.equal(stableStringify({
        keyword: after.prepare(
          "SELECT * FROM lite_memory_keyword_index ORDER BY scope, node_id",
        ).all(),
        execution: after.prepare(
          "SELECT * FROM lite_memory_execution_native_index ORDER BY scope, node_id",
        ).all(),
      }), derivedBefore);
    } finally {
      after.close();
    }
  } finally {
    fs.rmSync(fixture.temp.directory, { recursive: true, force: true });
  }
});

async function insertUnappliedExecutionDecisionClaim(
  store: LiteWriteStore,
  scope: string,
): Promise<string> {
  const createdAt = "2026-07-18T03:00:00.000Z";
  const decisionId = "decision-claimed-but-unapplied";
  const mutation = buildCanonicalAppliedAuthorityMutationV2({
    appliedAt: createdAt,
    authorityKind: "execution_decision",
    mutations: [{
      table: "lite_memory_execution_decisions",
      identity: { scope, id: decisionId },
      operation: "insert",
      before: null,
      after: {
        id: decisionId,
        scope,
        decision_kind: "tool_selection",
        run_id: null,
        selected_tool: "safe-tool",
        candidates_json: ["safe-tool"],
        context_sha256: sha256("missing-row-context"),
        policy_sha256: sha256("missing-row-policy"),
        source_rule_ids_json: [],
        metadata_json: {},
        commit_id: "$self",
        created_at: createdAt,
      },
    }],
  });
  const diffJson = stableStringify(mutation);
  const mutationDigest = sha256(diffJson);
  const inputSha256 = sha256("missing-row-input");
  const commitHash = canonicalV2CommitHash({
    digestVersion: 2,
    revision: 1,
    parentHash: "",
    inputSha256,
    mutationDigest,
    scope,
    actor: "terminal-claim-test",
    modelVersion: null,
    promptVersion: null,
  });
  return await store.withTx(async () => {
    const commitId = await store.insertCommit({
      scope,
      parentCommitId: null,
      inputSha256,
      diffJson,
      actor: "terminal-claim-test",
      modelVersion: null,
      promptVersion: null,
      commitHash,
      digestVersion: 2,
      revision: 1,
      mutationDigest,
      legacyAnchorCommitId: null,
      createdAt,
    });
    const advanced = await store.compareAndSwapScopeHead({
      scope,
      commitId,
      expectedRevision: 0,
      expectedCommitId: null,
    });
    assert.equal(advanced.status, "advanced");
    return commitId;
  });
}

test("CAS rejects a v2 claim without its business row and rolls the pending commit back", async () => {
  const temp = tempDatabase("unapplied-generic-claim");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  try {
    await assert.rejects(
      insertUnappliedExecutionDecisionClaim(store, "scope/unapplied-generic-claim"),
      /lite_memory_commit_authority_terminal_row_missing/,
    );
    const db = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, true, JSON.stringify(report.findings));
      assert.equal(report.v2_commit_count, 0);
      assert.equal(report.terminal_claim_count, 0);
      assert.equal(report.terminal_verified_count, 0);
      assert.equal(
        (db.prepare(
          "SELECT COUNT(*) AS count FROM lite_memory_scope_heads WHERE scope = ?",
        ).get("scope/unapplied-generic-claim") as { count: number }).count,
        0,
      );
    } finally {
      db.close();
    }
    await store.close();
    const reopened = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await reopened.close();
  } finally {
    await store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("terminal authoritative row tamper fails inspect, reopen, and backup", async () => {
  const fixture = await twoCommitAuthorityFixture("terminal-row-tamper", false);
  await fixture.store.close();
  try {
    const db = createSqliteDatabase(fixture.temp.path);
    try {
      db.prepare(
        "UPDATE lite_memory_nodes SET title = 'tampered terminal title' WHERE scope = ? AND id = ?",
      ).run("scope/terminal-row-tamper", "fixture-node-2");
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, false);
      assert.ok(report.findings.some(
        (entry) => entry.code === "lite_memory_commit_authority_terminal_row_mismatch",
      ));
    } finally {
      db.close();
    }
    assert.throws(
      () => createLiteWriteStore(fixture.temp.path, { annProjectionEnabled: false }),
      /lite_memory_commit_authority_terminal_row_mismatch/,
    );
    await assert.rejects(
      backupLiteRuntimeDatabase({
        sourcePath: fixture.temp.path,
        destinationPath: path.join(fixture.temp.directory, "tampered-backup.sqlite"),
      }),
      /source_database_verification_failed/,
    );
  } finally {
    fs.rmSync(fixture.temp.directory, { recursive: true, force: true });
  }
});

test("terminal node proof permits only the four projection-owned embedding fields", async () => {
  const fixture = await twoCommitAuthorityFixture("embedding-projection-exception", false);
  await fixture.store.close();
  try {
    const db = createSqliteDatabase(fixture.temp.path);
    try {
      db.prepare(
        `UPDATE lite_memory_nodes
         SET embedding_vector_json = ?, embedding_model = ?,
             embedding_status = 'ready', embedding_last_error = NULL
         WHERE scope = ? AND id = ?`,
      ).run(
        JSON.stringify(Array.from({ length: 1_536 }, () => 0)),
        "projection-model",
        "scope/embedding-projection-exception",
        "fixture-node-2",
      );
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, true, JSON.stringify(report.findings));
      assert.equal(report.terminal_claim_count, 2);
      assert.equal(report.terminal_verified_count, 2);
      assert.equal(report.terminal_projection_tuple_exception_count, 1);
      assert.equal(
        report.terminal_projection_owned_state_assurance,
        "projection_owned_state_shape_validated_not_commit_exact",
      );
      assert.equal(
        report.terminal_authority_assurance,
        "latest_v2_claims_match_terminal_authoritative_rows",
      );
    } finally {
      db.close();
    }
    const reopened = createLiteWriteStore(fixture.temp.path, { annProjectionEnabled: false });
    await reopened.close();

    const inconsistent = createSqliteDatabase(fixture.temp.path);
    try {
      inconsistent.prepare(
        `UPDATE lite_memory_nodes
         SET embedding_vector_json = NULL
         WHERE scope = ? AND id = ?`,
      ).run("scope/embedding-projection-exception", "fixture-node-2");
      const report = inspectLiteMemoryCommitAuthority(inconsistent);
      assert.equal(report.ok, false);
      assert.ok(report.findings.some(
        (entry) => entry.code === "lite_memory_commit_authority_terminal_row_mismatch",
      ));
    } finally {
      inconsistent.close();
    }
    assert.throws(
      () => createLiteWriteStore(fixture.temp.path, { annProjectionEnabled: false }),
      /lite_memory_commit_authority_terminal_row_mismatch/,
    );
  } finally {
    fs.rmSync(fixture.temp.directory, { recursive: true, force: true });
  }
});

test("self-consistent exact node claims still reject invalid embedding tuples", async () => {
  const temp = tempDatabase("exact-invalid-node-projection");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  const base = v2CommitArgs({
    scope: "scope/exact-invalid-node-projection",
    revision: 1,
    parentCommitId: null,
    parentHash: "",
    legacyAnchorCommitId: null,
    label: "exact-invalid-node-projection",
  });
  const inserted = await insertV2AndAdvance(store, base, null);
  await store.close();
  try {
    const db = createSqliteDatabase(temp.path);
    try {
      const mutation = JSON.parse(base.diffJson) as Record<string, any>;
      for (const projection of [mutation.nodes[0].requested, mutation.nodes[0].after]) {
        projection.embedding_vector_json = null;
        projection.embedding_model = null;
        projection.embedding_status = "ready";
        projection.embedding_last_error = null;
      }
      const diffJson = stableStringify(mutation);
      const mutationDigest = sha256(diffJson);
      const commitHash = canonicalV2CommitHash({
        digestVersion: 2,
        revision: 1,
        parentHash: "",
        inputSha256: base.inputSha256,
        mutationDigest,
        scope: base.scope,
        actor: base.actor,
        modelVersion: base.modelVersion,
        promptVersion: base.promptVersion,
      });
      const commitId = stableUuid(`lite:commit:${commitHash}`);
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `UPDATE lite_memory_nodes
           SET embedding_vector_json = NULL, embedding_model = NULL,
               embedding_status = 'ready', embedding_last_error = NULL, commit_id = ?
           WHERE scope = ? AND id = ?`,
        ).run(commitId, base.scope, "fixture-node-1");
        db.prepare(
          `UPDATE lite_memory_scope_heads SET commit_id = ? WHERE scope = ?`,
        ).run(commitId, base.scope);
        db.prepare(
          `UPDATE lite_memory_commits
           SET id = ?, diff_json = ?, mutation_digest = ?, commit_hash = ?
           WHERE id = ?`,
        ).run(commitId, diffJson, mutationDigest, commitHash, inserted.commitId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, false);
      assert.ok(report.findings.some((entry) =>
        entry.code === "lite_memory_commit_authority_v2_diff_invalid"
        && entry.cause_code === "lite_memory_commit_v2_node_mutation_invalid",
      ), JSON.stringify(report.findings));
    } finally {
      db.close();
    }
    assert.throws(
      () => createLiteWriteStore(temp.path, { annProjectionEnabled: false }),
      /lite_memory_commit_authority_v2_diff_invalid/,
    );
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("a committed ready embedding tuple may refresh to another shape-valid ready tuple", async () => {
  const temp = tempDatabase("committed-ready-exact");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  const base = v2CommitArgs({
    scope: "scope/committed-ready-exact",
    revision: 1,
    parentCommitId: null,
    parentHash: "",
    legacyAnchorCommitId: null,
    label: "committed-ready-exact",
  });
  const mutation = JSON.parse(base.diffJson) as Record<string, any>;
  const vector = Array.from({ length: 1_536 }, () => 0);
  for (const projection of [mutation.nodes[0].requested, mutation.nodes[0].after]) {
    projection.embedding_vector_json = vector;
    projection.embedding_model = "committed-model";
    projection.embedding_status = "ready";
    projection.embedding_last_error = null;
  }
  const diffJson = stableStringify(mutation);
  const mutationDigest = sha256(diffJson);
  const planned = {
    ...base,
    diffJson,
    mutationDigest,
    commitHash: canonicalV2CommitHash({
      digestVersion: 2,
      revision: 1,
      parentHash: "",
      inputSha256: base.inputSha256,
      mutationDigest,
      scope: base.scope,
      actor: base.actor,
      modelVersion: base.modelVersion,
      promptVersion: base.promptVersion,
    }),
  };
  await insertV2AndAdvance(store, planned, null);
  await store.close();
  try {
    const db = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteMemoryCommitAuthority(db).ok, true);
      db.prepare(
        `UPDATE lite_memory_nodes
         SET embedding_vector_json = ?, embedding_model = ?,
             embedding_status = 'ready', embedding_last_error = NULL
         WHERE scope = ? AND id = ?`,
      ).run(JSON.stringify(Array.from({ length: 1_536 }, () => 1)),
        "refreshed-model", base.scope, "fixture-node-1");
      const refreshed = inspectLiteMemoryCommitAuthority(db);
      assert.equal(refreshed.ok, true, JSON.stringify(refreshed.findings));
      assert.equal(refreshed.terminal_projection_tuple_exception_count, 1);
      assert.equal(
        refreshed.terminal_projection_owned_state_assurance,
        "projection_owned_state_shape_validated_not_commit_exact",
      );
      db.prepare(
        `UPDATE lite_memory_nodes SET embedding_vector_json = NULL
         WHERE scope = ? AND id = ?`,
      ).run(base.scope, "fixture-node-1");
      const invalid = inspectLiteMemoryCommitAuthority(db);
      assert.equal(invalid.ok, false);
      assert.ok(invalid.findings.some(
        (entry) => entry.code === "lite_memory_commit_authority_terminal_row_mismatch",
      ));
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("a committed failed embedding tuple may become a shape-valid ready projection", async () => {
  const temp = tempDatabase("committed-failed-to-ready");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  const base = v2CommitArgs({
    scope: "scope/committed-failed-to-ready",
    revision: 1,
    parentCommitId: null,
    parentHash: "",
    legacyAnchorCommitId: null,
    label: "committed-failed-to-ready",
  });
  const mutation = JSON.parse(base.diffJson) as Record<string, any>;
  for (const projection of [mutation.nodes[0].requested, mutation.nodes[0].after]) {
    projection.embedding_status = "failed";
    projection.embedding_last_error = "provider_unavailable";
  }
  const diffJson = stableStringify(mutation);
  const mutationDigest = sha256(diffJson);
  await insertV2AndAdvance(store, {
    ...base,
    diffJson,
    mutationDigest,
    commitHash: canonicalV2CommitHash({
      digestVersion: 2,
      revision: 1,
      parentHash: "",
      inputSha256: base.inputSha256,
      mutationDigest,
      scope: base.scope,
      actor: base.actor,
      modelVersion: base.modelVersion,
      promptVersion: base.promptVersion,
    }),
  }, null);
  await store.close();
  try {
    const db = createSqliteDatabase(temp.path);
    try {
      db.prepare(
        `UPDATE lite_memory_nodes
         SET embedding_vector_json = ?, embedding_model = ?,
             embedding_status = 'ready', embedding_last_error = NULL
         WHERE scope = ? AND id = ?`,
      ).run(JSON.stringify(Array.from({ length: 1_536 }, () => 0.5)),
        "repaired-model", base.scope, "fixture-node-1");
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, true, JSON.stringify(report.findings));
      assert.equal(report.terminal_projection_tuple_exception_count, 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v2 authority scan uses the partial scope/revision index without a temp sort", async () => {
  const temp = tempDatabase("query-plan");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  await store.close();
  try {
    const db = createSqliteDatabase(temp.path);
    try {
      const details = (db.prepare(
        `EXPLAIN QUERY PLAN ${LITE_MEMORY_COMMIT_AUTHORITY_V2_SCAN_SQL}`,
      ).all() as Array<{ detail: string }>).map((row) => row.detail);
      assert.ok(details.some(
        (detail) => detail.includes("idx_lite_memory_commits_scope_revision"),
      ), JSON.stringify(details));
      assert.ok(details.every((detail) => !/USE TEMP B-TREE|FULLSCAN/u.test(detail)),
        JSON.stringify(details));
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("terminal authority verification streams every authoritative table once, never per claim", async () => {
  const fixture = await twoCommitAuthorityFixture("terminal-streaming", false);
  await fixture.store.close();
  try {
    const db = createSqliteDatabase(fixture.temp.path);
    try {
      const preparedSql: string[] = [];
      const prepare = db.prepare.bind(db);
      const observed: SqliteDatabase = {
        exec: db.exec.bind(db),
        prepare(sql) {
          preparedSql.push(sql);
          return prepare(sql);
        },
        close: db.close.bind(db),
      };
      const report = inspectLiteMemoryCommitAuthority(observed);
      assert.equal(report.ok, true, JSON.stringify(report.findings));
      const terminalScans = preparedSql.filter(
        (sql) => sql.startsWith("SELECT") && sql.includes('FROM "lite_memory_nodes"'),
      );
      assert.equal(terminalScans.length, 1,
        "two node claims must share one terminal row stream");
      assert.doesNotMatch(terminalScans[0]!, /ORDER BY/u,
        "terminal stream must not force a temp sort");
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${terminalScans[0]!}`).all() as Array<{
        detail: string;
      }>;
      assert.ok(plan.every((entry) => !/USE TEMP B-TREE/u.test(entry.detail)),
        JSON.stringify(plan));
      for (const unclaimedTable of [
        "lite_runtime_write_operations",
        "lite_memory_execution_decisions",
        "lite_memory_rule_defs",
        "lite_memory_rule_feedback",
        "lite_memory_edges",
      ]) {
        assert.equal(preparedSql.filter(
          (sql) => sql.startsWith("SELECT") && sql.includes(`FROM "${unclaimedTable}"`),
        ).length, 1, `authoritative table ${unclaimedTable} must be streamed once`);
      }
      assert.equal(preparedSql.filter(
        (sql) => /FROM "lite_[a-z_]+" WHERE .+ LIMIT 1/u.test(sql),
      ).length, 0, "terminal claims must not issue point lookups");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(fixture.temp.directory, { recursive: true, force: true });
  }
});

test("terminal authority rejects every unclaimed current business-row family", async () => {
  const fixture = await twoCommitAuthorityFixture("terminal-unclaimed-closure", false);
  await fixture.store.close();
  try {
    const db = createSqliteDatabase(fixture.temp.path);
    try {
      const scope = "scope/terminal-unclaimed-closure";
      const createdAt = "2026-07-18T09:00:00.000Z";
      const sourceNode = db.prepare(
        "SELECT id FROM lite_memory_nodes WHERE scope = ? ORDER BY id LIMIT 1",
      ).get(scope) as { id: string } | undefined;
      assert.ok(sourceNode);
      db.prepare(
        `INSERT INTO lite_memory_nodes
         SELECT 'unclaimed-node', scope, client_id, type, tier, title, text_summary,
                slots_json, raw_ref, evidence_ref, embedding_vector_json,
                embedding_model, memory_lane, producer_agent_id, owner_agent_id,
                owner_team_id, embedding_status, embedding_last_error, salience,
                importance, confidence, redaction_version, ?, ?
         FROM lite_memory_nodes WHERE id = ?`,
      ).run(fixture.secondId, createdAt, sourceNode.id);
      db.prepare(
        `INSERT INTO lite_memory_edges
           (id, scope, type, src_id, dst_id, weight, confidence, decay_rate,
            metadata_json, commit_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "unclaimed-edge", scope, "unclaimed_relation", sourceNode.id, sourceNode.id,
        0.5, 0.5, 0.5, "{}", fixture.secondId, createdAt,
      );
      db.prepare(
        `INSERT INTO lite_memory_execution_decisions
           (id, scope, decision_kind, run_id, selected_tool, candidates_json,
            context_sha256, policy_sha256, source_rule_ids_json, metadata_json,
            commit_id, created_at)
         VALUES (?, ?, ?, NULL, NULL, '[]', ?, ?, '[]', '{}', ?, ?)`,
      ).run(
        "unclaimed-decision", scope, "tool_selection", sha256("unclaimed-context"),
        sha256("unclaimed-policy"), fixture.secondId, createdAt,
      );
      db.prepare(
        `INSERT INTO lite_memory_rule_defs
           (rule_node_id, scope, state, if_json, then_json, exceptions_json,
            rule_scope, target_agent_id, target_team_id, positive_count,
            negative_count, commit_id, created_at, updated_at)
         VALUES (?, ?, 'shadow', '{}', '{}', '[]', 'global', NULL, NULL,
                 0, 0, ?, ?, ?)`,
      ).run("unclaimed-rule", scope, fixture.secondId, createdAt, createdAt);
      db.prepare(
        `INSERT INTO lite_memory_rule_feedback
           (id, scope, rule_node_id, run_id, outcome, note, source,
            decision_id, commit_id, created_at)
         VALUES (?, ?, ?, NULL, 'positive', NULL, 'scanner-test', NULL, ?, ?)`,
      ).run("unclaimed-rule-feedback", scope, "unclaimed-rule", fixture.secondId, createdAt);
      db.prepare(
        `INSERT INTO lite_runtime_write_operations
           (tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at)
         VALUES ('default', ?, 'unknown_unclaimed_operation_v1', ?, ?, '{}', ?, ?)`,
      ).run(scope, "unclaimed-operation", sha256("unclaimed-operation"), fixture.secondId, createdAt);

      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, false);
      assert.equal(report.terminal_unclaimed_row_count, 6);
      assert.deepEqual(
        new Set(report.findings
          .filter((entry) => entry.code
            === "lite_memory_commit_authority_terminal_row_unclaimed")
          .map((entry) => entry.cause_code)),
        new Set([
          "lite_memory_nodes",
          "lite_memory_edges",
          "lite_memory_execution_decisions",
          "lite_memory_rule_defs",
          "lite_memory_rule_feedback",
          "lite_runtime_write_operations",
        ]),
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(fixture.temp.directory, { recursive: true, force: true });
  }
});

async function appendAuthorityNodeUpdate(args: {
  store: LiteWriteStore;
  scope: string;
  revision: number;
  parentCommitId: string | null;
  parentHash: string;
  legacyAnchorCommitId: string | null;
  before: Record<string, any>;
  after: Record<string, any>;
  label: string;
  insertActual?: boolean;
}): Promise<{ commitId: string; commitHash: string }> {
  const createdAt = new Date(Date.UTC(2026, 6, 18, 4, 0, 0, args.revision)).toISOString();
  const mutation = buildCanonicalAppliedAuthorityMutationV2({
    appliedAt: createdAt,
    authorityKind: "nodes_activate",
    mutations: [{
      table: "lite_memory_nodes",
      identity: { scope: args.scope, id: args.after.id },
      operation: "update",
      before: args.before,
      after: { ...args.after, commit_id: "$self" },
    }],
  });
  const diffJson = stableStringify(mutation);
  const mutationDigest = sha256(diffJson);
  const inputSha256 = sha256(`node-update:${args.label}`);
  const commitHash = canonicalV2CommitHash({
    digestVersion: 2,
    revision: args.revision,
    parentHash: args.parentHash,
    inputSha256,
    mutationDigest,
    scope: args.scope,
    actor: "revision-before-test",
    modelVersion: null,
    promptVersion: null,
  });
  return await args.store.withTx(async () => {
    const commitId = await args.store.insertCommit({
      scope: args.scope,
      parentCommitId: args.parentCommitId,
      inputSha256,
      diffJson,
      actor: "revision-before-test",
      modelVersion: null,
      promptVersion: null,
      commitHash,
      digestVersion: 2,
      revision: args.revision,
      mutationDigest,
      legacyAnchorCommitId: args.legacyAnchorCommitId,
      createdAt,
    });
    if (args.insertActual) {
      await args.store.insertNode({
        id: args.after.id,
        scope: args.scope,
        clientId: args.after.client_id,
        type: args.after.type,
        tier: args.after.tier,
        title: args.after.title,
        textSummary: args.after.text_summary,
        slotsJson: stableStringify(args.after.slots_json),
        rawRef: args.after.raw_ref,
        evidenceRef: args.after.evidence_ref,
        embeddingVector: args.after.embedding_vector_json === null
          ? null
          : stableStringify(args.after.embedding_vector_json),
        embeddingModel: args.after.embedding_model,
        memoryLane: args.after.memory_lane,
        producerAgentId: args.after.producer_agent_id,
        ownerAgentId: args.after.owner_agent_id,
        ownerTeamId: args.after.owner_team_id,
        embeddingStatus: args.after.embedding_status,
        embeddingLastError: args.after.embedding_last_error,
        salience: args.after.salience,
        importance: args.after.importance,
        confidence: args.after.confidence,
        redactionVersion: args.after.redaction_version,
        commitId,
        createdAt: args.after.created_at,
      });
    } else {
      const updated = await args.store.updateNodeAnchorState({
        scope: args.scope,
        id: args.after.id,
        slots: args.after.slots_json,
        textSummary: args.after.text_summary,
        salience: args.after.salience,
        importance: args.after.importance,
        confidence: args.after.confidence,
        tier: args.after.tier,
        commitId,
      });
      assert.ok(updated);
    }
    const advanced = await args.store.compareAndSwapScopeHead({
      scope: args.scope,
      commitId,
      expectedRevision: args.revision - 1,
      expectedCommitId: args.parentCommitId,
    });
    assert.equal(advanced.status, "advanced");
    return { commitId, commitHash };
  });
}

test("revision-before chain rejects a self-consistent forged before state", async () => {
  const temp = tempDatabase("forged-revision-before");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  try {
    const firstArgs = v2CommitArgs({
      scope: "scope/forged-revision-before",
      revision: 1,
      parentCommitId: null,
      parentHash: "",
      legacyAnchorCommitId: null,
      label: "forged-before-first",
    });
    const first = await insertV2AndAdvance(store, firstArgs, null);
    const priorAfter = (JSON.parse(firstArgs.diffJson) as any).nodes[0].after;
    const before = { ...priorAfter, commit_id: first.commitId, importance: 0.99 };
    const after = { ...priorAfter, importance: 0.7 };
    await appendAuthorityNodeUpdate({
      store,
      scope: firstArgs.scope,
      revision: 2,
      parentCommitId: first.commitId,
      parentHash: first.head.commitHash,
      legacyAnchorCommitId: null,
      before,
      after,
      label: "forged-before-second",
    });
    const db = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, false);
      assert.equal(report.revision_before_assurance, "invalid");
      assert.ok(report.findings.some((entry) =>
        entry.code === "lite_memory_commit_authority_revision_update_before_mismatch"));
    } finally {
      db.close();
    }
  } finally {
    await assert.rejects(
      store.close(),
      /lite_memory_commit_authority_revision_update_before_mismatch/,
    );
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("revision-before chain accepts one pending-to-ready projection before a v2 update", async () => {
  const temp = tempDatabase("revision-before-projection");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  try {
    const firstArgs = v2CommitArgs({
      scope: "scope/revision-before-projection",
      revision: 1,
      parentCommitId: null,
      parentHash: "",
      legacyAnchorCommitId: null,
      label: "projection-before-first",
    });
    const first = await insertV2AndAdvance(store, firstArgs, null);
    const vector = Array.from({ length: 1_536 }, () => 0);
    await store.setNodeEmbeddingReady({
      scope: firstArgs.scope,
      id: "fixture-node-1",
      embedding: vector,
      embeddingModel: "projection-before-model",
    });
    const priorAfter = (JSON.parse(firstArgs.diffJson) as any).nodes[0].after;
    const before = {
      ...priorAfter,
      commit_id: first.commitId,
      embedding_vector_json: vector,
      embedding_model: "projection-before-model",
      embedding_status: "ready",
      embedding_last_error: null,
    };
    const after = { ...before, commit_id: "$self", salience: 0.7 };
    await appendAuthorityNodeUpdate({
      store,
      scope: firstArgs.scope,
      revision: 2,
      parentCommitId: first.commitId,
      parentHash: first.head.commitHash,
      legacyAnchorCommitId: null,
      before,
      after,
      label: "projection-before-second",
    });
    const db = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, true, JSON.stringify(report.findings));
      assert.equal(report.revision_before_check_count, 1);
      assert.equal(report.revision_before_verified_count, 1);
      assert.equal(report.revision_before_projection_transition_count, 1);
      assert.equal(report.revision_before_assurance, "v2_chain_proved");
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("ready-to-failed embedding projection clears its tuple and survives v2 authority reopen", async () => {
  const temp = tempDatabase("projection-ready-to-failed");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  try {
    const firstArgs = v2CommitArgs({
      scope: "scope/projection-ready-to-failed",
      revision: 1,
      parentCommitId: null,
      parentHash: "",
      legacyAnchorCommitId: null,
      label: "projection-ready-to-failed",
    });
    await insertV2AndAdvance(store, firstArgs, null);
    await store.setNodeEmbeddingReady({
      scope: firstArgs.scope,
      id: "fixture-node-1",
      embedding: Array.from({ length: 1_536 }, () => 0.25),
      embeddingModel: "ready-before-failure-model",
    });
    await store.setNodeEmbeddingFailed({
      scope: firstArgs.scope,
      id: "fixture-node-1",
      error: "provider_unavailable",
    });
    await store.close();

    const db = createSqliteDatabase(temp.path);
    try {
      const row = db.prepare(
        `SELECT embedding_vector_json, embedding_model, embedding_status, embedding_last_error
         FROM lite_memory_nodes
         WHERE scope = ? AND id = ?`,
      ).get(firstArgs.scope, "fixture-node-1") as {
        embedding_vector_json: string | null;
        embedding_model: string | null;
        embedding_status: string;
        embedding_last_error: string | null;
      };
      assert.equal(row.embedding_vector_json, null);
      assert.equal(row.embedding_model, null);
      assert.equal(row.embedding_status, "failed");
      assert.equal(row.embedding_last_error, "provider_unavailable");
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, true, JSON.stringify(report.findings));
    } finally {
      db.close();
    }

    const verification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(verification.ok, true, JSON.stringify(verification));
    const reopened = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await reopened.close();
  } finally {
    await store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("generic authority scan materializes only declared commit-reference paths", async () => {
  const temp = tempDatabase("literal-self-authority-data");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  try {
    const scope = "scope/literal-self-authority-data";
    const literalData = {
      literal_self: "$self",
      nested: { literal_self: "$self" },
    };
    const firstArgs = v2CommitArgs({
      scope,
      revision: 1,
      parentCommitId: null,
      parentHash: "",
      legacyAnchorCommitId: null,
      label: "literal-self-first",
      slotsJson: literalData,
    });
    const first = await insertV2AndAdvance(store, firstArgs, null);
    const priorAfter = (JSON.parse(firstArgs.diffJson) as any).nodes[0].after;
    const second = await appendAuthorityNodeUpdate({
      store,
      scope,
      revision: 2,
      parentCommitId: first.commitId,
      parentHash: first.head.commitHash,
      legacyAnchorCommitId: null,
      before: { ...priorAfter, commit_id: first.commitId },
      after: { ...priorAfter, slots_json: literalData, salience: 0.7 },
      label: "literal-self-node-update",
    });

    const createdAt = "2026-07-18T06:00:00.003Z";
    const decisionId = "literal-self-decision";
    const decisionAfter = {
      id: decisionId,
      scope,
      decision_kind: "tools_select",
      run_id: null,
      selected_tool: "safe-tool",
      candidates_json: ["safe-tool"],
      context_sha256: sha256("literal-self-context"),
      policy_sha256: sha256("literal-self-policy"),
      source_rule_ids_json: [],
      metadata_json: literalData,
      commit_id: "$self",
      created_at: createdAt,
    };
    const mutation = buildCanonicalAppliedAuthorityMutationV2({
      appliedAt: createdAt,
      authorityKind: "execution_decision",
      mutations: [{
        table: "lite_memory_execution_decisions",
        identity: { scope, id: decisionId },
        operation: "insert",
        before: null,
        after: decisionAfter,
      }],
    });
    const diffJson = stableStringify(mutation);
    const mutationDigest = sha256(diffJson);
    const inputSha256 = sha256("literal-self-decision-input");
    const commitHash = canonicalV2CommitHash({
      digestVersion: 2,
      revision: 3,
      parentHash: second.commitHash,
      inputSha256,
      mutationDigest,
      scope,
      actor: "literal-self-test",
      modelVersion: null,
      promptVersion: null,
    });
    await store.withTx(async () => {
      const commitId = await store.insertCommit({
        scope,
        parentCommitId: second.commitId,
        inputSha256,
        diffJson,
        actor: "literal-self-test",
        modelVersion: null,
        promptVersion: null,
        commitHash,
        digestVersion: 2,
        revision: 3,
        mutationDigest,
        legacyAnchorCommitId: null,
        createdAt,
      });
      await store.insertExecutionDecision({
        id: decisionId,
        scope,
        decisionKind: "tools_select",
        runId: null,
        selectedTool: "safe-tool",
        candidatesJson: ["safe-tool"],
        contextSha256: decisionAfter.context_sha256,
        policySha256: decisionAfter.policy_sha256,
        sourceRuleIds: [],
        metadataJson: literalData,
        commitId,
        createdAt,
      });
      const advanced = await store.compareAndSwapScopeHead({
        scope,
        commitId,
        expectedRevision: 2,
        expectedCommitId: second.commitId,
      });
      assert.equal(advanced.status, "advanced");
    });
    const db = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, true, JSON.stringify(report.findings));
      const node = db.prepare(
        "SELECT slots_json FROM lite_memory_nodes WHERE scope = ? AND id = ?",
      ).get(scope, "fixture-node-1") as { slots_json: string };
      const decision = db.prepare(
        "SELECT metadata_json FROM lite_memory_execution_decisions WHERE scope = ? AND id = ?",
      ).get(scope, decisionId) as { metadata_json: string };
      assert.equal(node.slots_json, stableStringify(literalData));
      assert.equal(decision.metadata_json, stableStringify(literalData));
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("linear authority scan rejects a self-consistent forged learning-control observation", async () => {
  const temp = tempDatabase("forged-learning-control-observation");
  const database = createLiteRuntimeDatabase(temp.path);
  const store = createLiteWriteStoreFromDatabase(database, {
    annProjectionEnabled: false,
    allowLegacyV1Fixtures: true,
  });
  try {
    const scope = "scope/forged-learning-control-observation";
    const firstArgs = v2CommitArgs({
      scope,
      revision: 1,
      parentCommitId: null,
      parentHash: "",
      legacyAnchorCommitId: null,
      label: "forged-learning-control-prior",
    });
    const first = await insertV2AndAdvance(store, firstArgs, null);
    const nodeAfter = (JSON.parse(firstArgs.diffJson) as any).nodes[0].after;
    const observedState = {
      ...nodeAfter,
      commit_id: first.commitId,
      slots_json: { ...nodeAfter.slots_json, forged_positive_attribution: 1 },
    };
    const createdAt = "2026-07-18T07:00:00.002Z";
    const requestSha256 = sha256("forged-learning-control-outcome-input");
    const operationKind = "scanner_learning_control_fixture";
    const operationId = "scanner-learning-control-outcome";
    const receipt = { contract_version: "scanner_fixture_v1", result_commit_id: "$self" };
    const evidence = buildLearningControlOperationOutcomeEvidenceV2({
      tenant_id: "default",
      scope,
      job_id: "scanner-job",
      operation_id: operationId,
      source_episode_id: "scanner-episode",
      source_feedback_event_id: "scanner-feedback",
      source_commit_id: first.commitId,
      payload_sha256: sha256("scanner-payload"),
      domain_result_commit_id: first.commitId,
      domain_result_revision: 1,
      request_sha256: requestSha256,
      actor: "scanner-actor",
      consumer_agent_id: null,
      consumer_team_id: null,
      requested_node_ids: [nodeAfter.id],
      applied_node_ids: [nodeAfter.id],
      skipped_positive_attribution_memory_ids: [],
      missing_node_ids: [],
      observations: [{ memory_id: nodeAfter.id, state: observedState }],
    });
    const identity = {
      tenant_id: "default",
      scope,
      operation_kind: operationKind,
      operation_id: operationId,
    };
    const mutation = buildCanonicalAppliedAuthorityMutationV2({
      appliedAt: createdAt,
      authorityKind: "learning_control_operation_outcome",
      mutations: [{
        table: "lite_runtime_write_operations",
        identity,
        operation: "insert",
        before: null,
        requested: evidence,
        after: {
          ...identity,
          request_sha256: requestSha256,
          receipt_json: receipt,
          commit_id: "$self",
          created_at: createdAt,
        },
      }],
    });
    const diffJson = stableStringify(mutation);
    const mutationDigest = sha256(diffJson);
    const commitHash = canonicalV2CommitHash({
      digestVersion: 2,
      revision: 2,
      parentHash: first.head.commitHash,
      inputSha256: requestSha256,
      mutationDigest,
      scope,
      actor: "scanner-actor",
      modelVersion: null,
      promptVersion: null,
    });
    await store.withTx(async () => {
      const outcomeCommitId = await store.insertCommit({
        scope,
        parentCommitId: first.commitId,
        inputSha256: requestSha256,
        diffJson,
        actor: "scanner-actor",
        modelVersion: null,
        promptVersion: null,
        commitHash,
        digestVersion: 2,
        revision: 2,
        mutationDigest,
        legacyAnchorCommitId: null,
        createdAt,
      });
      await store.insertWriteOperationEnclosedByPendingCommit({
        tenantId: "default",
        scope,
        operationKind,
        operationId,
        requestSha256,
        receiptJson: stableStringify({ ...receipt, result_commit_id: outcomeCommitId }),
        commitId: outcomeCommitId,
        createdAt,
        authorityCommitId: outcomeCommitId,
      });
      const advanced = await store.compareAndSwapScopeHead({
        scope,
        commitId: outcomeCommitId,
        expectedRevision: 1,
        expectedCommitId: first.commitId,
      });
      assert.equal(advanced.status, "advanced");
    });
    const report = inspectLiteMemoryCommitAuthority(database.db);
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((entry) =>
      entry.code === "lite_memory_commit_authority_learning_control_outcome_observation_mismatch"));
  } finally {
    await database.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("learning-control observation admits and reopens a v6-authenticated adopted node baseline", async () => {
  const temp = tempDatabase("learning-control-legacy-observation");
  const scope = "scope/learning-control-legacy-observation";
  const legacyCreatedAt = "2026-07-18T07:30:00.000Z";
  const legacyCommitId = "legacy-learning-control-commit";
  const legacyCommitHash = sha256("legacy-learning-control-hash");
  const memoryId = "legacy-positive-memory";
  await prepareLegacyV4Fixture(temp.path, (db) => {
    insertLegacyCommitRow(db, {
      id: legacyCommitId,
      scope,
      hash: legacyCommitHash,
      createdAt: legacyCreatedAt,
    });
    insertLegacyNodeRow(db, {
      id: memoryId,
      scope,
      title: "Legacy positive memory",
      textSummary: "A legacy node with positive attribution.",
      slotsJson: { positive_attributed_use_count: 1 },
      commitId: legacyCommitId,
      createdAt: legacyCreatedAt,
    });
  });
  const database = createLiteRuntimeDatabase(temp.path);
  const store = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
  let storeClosed = false;
  try {
    const adoptionHead = await store.readScopeHead(scope);
    assert.ok(adoptionHead);
    assert.equal(adoptionHead.revision, 1);
    assert.equal(adoptionHead.legacyAnchorCommitId, legacyCommitId);
    const observed = nodeAuthorityStateV2(
      (await store.nodeStatesByIds(scope, [memoryId])).get(memoryId)!,
    );
    const createdAt = "2026-07-18T07:30:00.001Z";
    const requestSha256 = sha256("legacy-learning-control-outcome-input");
    const operationKind = "scanner_legacy_learning_control_fixture";
    const operationId = "scanner-legacy-learning-control-outcome";
    const receipt = { contract_version: "scanner_fixture_v1", result_commit_id: "$self" };
    const evidence = buildLearningControlOperationOutcomeEvidenceV2({
      tenant_id: "default",
      scope,
      job_id: "scanner-legacy-job",
      operation_id: operationId,
      source_episode_id: "scanner-legacy-episode",
      source_feedback_event_id: "scanner-legacy-feedback",
      source_commit_id: adoptionHead.commitId,
      payload_sha256: sha256("scanner-legacy-payload"),
      domain_result_commit_id: adoptionHead.commitId,
      domain_result_revision: 1,
      request_sha256: requestSha256,
      actor: "scanner-legacy-actor",
      consumer_agent_id: null,
      consumer_team_id: null,
      requested_node_ids: [memoryId],
      applied_node_ids: [],
      skipped_positive_attribution_memory_ids: [memoryId],
      missing_node_ids: [],
      observations: [{ memory_id: memoryId, state: observed }],
    });
    const identity = {
      tenant_id: "default",
      scope,
      operation_kind: operationKind,
      operation_id: operationId,
    };
    const mutation = buildCanonicalAppliedAuthorityMutationV2({
      appliedAt: createdAt,
      authorityKind: "learning_control_operation_outcome",
      mutations: [{
        table: "lite_runtime_write_operations",
        identity,
        operation: "insert",
        before: null,
        requested: evidence,
        after: {
          ...identity,
          request_sha256: requestSha256,
          receipt_json: receipt,
          commit_id: "$self",
          created_at: createdAt,
        },
      }],
    });
    const diffJson = stableStringify(mutation);
    const mutationDigest = sha256(diffJson);
    const commitHash = canonicalV2CommitHash({
      digestVersion: 2,
      revision: 2,
      parentHash: adoptionHead.commitHash,
      inputSha256: requestSha256,
      mutationDigest,
      scope,
      actor: "scanner-legacy-actor",
      modelVersion: null,
      promptVersion: null,
    });
    await store.withTx(async () => {
      const outcomeCommitId = await store.insertCommit({
        scope,
        parentCommitId: adoptionHead.commitId,
        inputSha256: requestSha256,
        diffJson,
        actor: "scanner-legacy-actor",
        modelVersion: null,
        promptVersion: null,
        commitHash,
        digestVersion: 2,
        revision: 2,
        mutationDigest,
        legacyAnchorCommitId: legacyCommitId,
        createdAt,
      });
      await store.insertWriteOperationEnclosedByPendingCommit({
        tenantId: "default",
        scope,
        operationKind,
        operationId,
        requestSha256,
        receiptJson: stableStringify({ ...receipt, result_commit_id: outcomeCommitId }),
        commitId: outcomeCommitId,
        createdAt,
        authorityCommitId: outcomeCommitId,
      });
      const advanced = await store.compareAndSwapScopeHead({
        scope,
        commitId: outcomeCommitId,
        expectedRevision: 1,
        expectedCommitId: adoptionHead.commitId,
      });
      assert.equal(advanced.status, "advanced");
    });
    const report = inspectLiteMemoryCommitAuthority(database.db);
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.adoption_binding_count, 1);
    assert.equal(report.adoption_binding_verified_count, 1);
    assert.equal(report.legacy_opaque_baseline_count, 1);
    await store.close();
    storeClosed = true;
    await database.close();
    const reopened = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    await reopened.close();
  } finally {
    if (!storeClosed) await database.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("first v2 update without a same-scope legacy baseline fails closed", async () => {
  const temp = tempDatabase("revision-before-no-baseline");
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  let closeAttempted = false;
  try {
    const base = (JSON.parse(v2CommitArgs({
      scope: "scope/revision-before-no-baseline",
      revision: 1,
      parentCommitId: null,
      parentHash: "",
      legacyAnchorCommitId: null,
      label: "no-baseline",
    }).diffJson) as any).nodes[0].after;
    await appendAuthorityNodeUpdate({
      store,
      scope: base.scope,
      revision: 1,
      parentCommitId: null,
      parentHash: "",
      legacyAnchorCommitId: null,
      before: { ...base, commit_id: "missing-v1" },
      after: { ...base, salience: 0.7 },
      label: "no-baseline",
      insertActual: true,
    });
    const db = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, false);
      assert.ok(report.findings.some((entry) =>
        entry.code === "lite_memory_commit_authority_revision_update_prior_missing"));
    } finally {
      db.close();
    }
    closeAttempted = true;
    await assert.rejects(
      store.close(),
      /lite_memory_commit_authority_revision_update_prior_missing/,
    );
    assert.throws(
      () => createLiteWriteStore(temp.path, { annProjectionEnabled: false }),
      /lite_memory_commit_authority_revision_update_prior_missing/,
    );
  } finally {
    if (!closeAttempted) {
      await assert.rejects(
        store.close(),
        /lite_memory_commit_authority_revision_update_prior_missing/,
      );
    }
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("first post-upgrade v2 update authenticates its legacy node through the v6 adoption binding", async () => {
  const temp = tempDatabase("revision-before-legacy-baseline");
  const scope = "scope/revision-before-legacy-baseline";
  const legacyId = "revision-before-legacy-commit";
  const legacyHash = sha256("revision-before-legacy-hash");
  const base = (JSON.parse(v2CommitArgs({
    scope,
    revision: 1,
    parentCommitId: legacyId,
    parentHash: legacyHash,
    legacyAnchorCommitId: legacyId,
    label: "legacy-baseline",
  }).diffJson) as any).nodes[0].after;
  await prepareLegacyV4Fixture(temp.path, (db) => {
    insertLegacyCommitRow(db, {
      id: legacyId,
      scope,
      hash: legacyHash,
      createdAt: "2026-07-18T08:00:00.000Z",
    });
    insertLegacyNodeRow(db, {
      id: base.id,
      scope,
      title: base.title,
      slotsJson: base.slots_json,
      salience: base.salience,
      importance: base.importance,
      confidence: base.confidence,
      commitId: legacyId,
      createdAt: base.created_at,
    });
  });
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  try {
    const adoptionHead = await store.readScopeHead(scope);
    assert.ok(adoptionHead);
    assert.equal(adoptionHead.revision, 1);
    assert.equal(adoptionHead.legacyAnchorCommitId, legacyId);
    await appendAuthorityNodeUpdate({
      store,
      scope,
      revision: 2,
      parentCommitId: adoptionHead.commitId,
      parentHash: adoptionHead.commitHash,
      legacyAnchorCommitId: legacyId,
      before: { ...base, commit_id: legacyId },
      after: { ...base, salience: 0.7 },
      label: "legacy-baseline",
    });
    const db = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteMemoryCommitAuthority(db);
      assert.equal(report.ok, true, JSON.stringify(report.findings));
      assert.equal(report.adoption_binding_count, 1);
      assert.equal(report.adoption_binding_verified_count, 1);
      assert.equal(report.legacy_opaque_baseline_count, 1);
      assert.equal(report.revision_before_assurance, "authenticated_adoption_baseline");
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});
