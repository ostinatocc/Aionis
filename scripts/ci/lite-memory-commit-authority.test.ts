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
  createLiteWriteStore,
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.ts";
import { writeEdgeIdentityKey } from "../../src/store/write-access.ts";
import { canonicalV2CommitHash } from "../../src/store/write-commit-authority.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tempDatabase(name: string): { directory: string; path: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-commit-authority-${name}-`));
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function downgradeCurrentFixtureToV4(db: SqliteDatabase): void {
  db.exec("BEGIN IMMEDIATE");
  try {
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

function v2CommitArgs(args: {
  scope: string;
  revision: number;
  parentCommitId: string | null;
  parentHash: string;
  legacyAnchorCommitId: string | null;
  label: string;
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
    slots_json: { test_label: args.label, test_revision: args.revision },
    raw_ref: null,
    evidence_ref: null,
    embedding_vector_json: null,
    embedding_model: null,
    memory_lane: "shared",
    producer_agent_id: null,
    owner_agent_id: null,
    owner_team_id: null,
    embedding_status: "failed",
    embedding_last_error: "fixture_without_embedding",
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
      assert.equal(LITE_RUNTIME_WRITE_SCHEMA_VERSION, 5);
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
    const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
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
      /lite_memory_scope_head_cas_requires_shared_transaction/,
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
    const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
    const firstCommit = await store.insertLegacyV1CommitForMigrationOrTestFixture({
      scope: "scope/states",
      parentCommitId: null,
      inputSha256: sha256("states-input-1"),
      diffJson: "{}",
      actor: "states-test",
      modelVersion: null,
      promptVersion: null,
      commitHash: sha256("states-commit-1"),
    });
    await store.insertNode({
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
    await store.upsertEdge({
      id: "state-edge",
      scope: "scope/states",
      type: "related_to",
      srcId: "state-node",
      dstId: "state-node-2",
      weight: 0.8,
      confidence: 0.4,
      decayRate: 0.1,
      metadataJson: { version: 1 },
      commitId: firstCommit,
      createdAt: "2026-07-18T01:00:01.000Z",
    });
    const secondCommit = await store.insertLegacyV1CommitForMigrationOrTestFixture({
      scope: "scope/states",
      parentCommitId: firstCommit,
      inputSha256: sha256("states-input-2"),
      diffJson: "{}",
      actor: "states-test",
      modelVersion: null,
      promptVersion: null,
      commitHash: sha256("states-commit-2"),
    });
    await store.upsertEdge({
      id: "ignored-conflict-id",
      scope: "scope/states",
      type: "related_to",
      srcId: "state-node",
      dstId: "state-node-2",
      weight: 0.2,
      confidence: 0.9,
      decayRate: 0.7,
      metadataJson: { version: 2 },
      commitId: secondCommit,
      createdAt: "2099-01-01T00:00:00.000Z",
    });

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
