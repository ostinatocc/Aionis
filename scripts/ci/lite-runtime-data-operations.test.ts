import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import { createLiteExecutionStateStore } from "../../src/execution/state-store.ts";
import type { ExecutionStateTransitionV1 } from "../../src/execution/transitions.ts";
import type { ExecutionStateV1 } from "../../src/execution/types.ts";
import { createExecutionTreeV1, type ExecutionTreeOperationV1 } from "../../src/execution/tree.ts";
import { createLiteExecutionTreeStore } from "../../src/execution/tree-store.ts";
import { persistInitialExecutionDecisionAuthority } from
  "../../src/memory/execution-decision-authority.ts";
import {
  inspectLiteProjectionRepairState,
  repairLiteProjectionState,
} from "../../src/store/lite-projection-repair.ts";
import {
  backupLiteRuntimeDatabase,
  restoreLiteRuntimeDatabase,
  upgradeLiteRuntimeDatabase,
  verifyLiteRuntimeDatabase,
} from "../../src/store/lite-runtime-data-operations.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import { createLiteReplayStore } from "../../src/store/lite-replay-store.ts";
import { inspectLiteRuntimeSchema } from "../../src/store/lite-runtime-schema.ts";
import { LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES, LITE_LEARNING_LEDGER_REQUIRED_TRIGGER_NAMES } from "../../src/store/lite-learning-episode-ledger.ts";
import { createLiteWriteStore, createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.ts";
import { createSqliteDatabase, createSqliteReadOnlyDatabase, type SqliteDatabase } from "../../src/store/sqlite.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_OPS_CLI = path.join(ROOT, "scripts", "runtime-data-ops.ts");
const EXECUTION_AT = "2026-07-12T00:00:00.000Z";

function tempDatabase(name: string, t?: TestContext): { directory: string; path: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-data-ops-${name}-`));
  if (t) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function permissionMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

async function createV2WriteFixture(filePath: string): Promise<void> {
  const store = createLiteWriteStore(filePath, { annProjectionEnabled: false }); await store.close(); downgradeCurrentFixtureToV2(filePath);
}

async function createReplayFixture(filePath: string): Promise<void> {
  const store = createLiteReplayStore(filePath); await store.close();
}

async function assertInvalidReplayRejectedBeforeUpgrade(
  t: TestContext, name: string, mutate: (db: SqliteDatabase) => void, expected: RegExp,
): Promise<void> {
  const temp = tempDatabase(`invalid-replay-${name}`, t);
  const replayPath = path.join(temp.directory, "replay.sqlite");
  await createV2WriteFixture(temp.path);
  await createReplayFixture(replayPath);
  const db = createSqliteDatabase(replayPath);
  try { mutate(db); } finally { db.close(); }
  if (process.platform !== "win32") fs.chmodSync(replayPath, 0o644);
  await assert.rejects(upgradeLiteRuntimeDatabase(temp.path, { replayPath }), expected);
  if (process.platform !== "win32") assert.equal(permissionMode(replayPath), 0o644);
  const write = createSqliteDatabase(temp.path);
  try { assert.equal(inspectLiteRuntimeSchema(write).classification, "supported_previous_v2"); }
  finally { write.close(); }
}

function executionState(stateId: string): ExecutionStateV1 {
  return {
    version: 1,
    state_id: stateId,
    scope: "data-operations-integrity",
    task_brief: "Verify Runtime data before release backup",
    current_stage: "patch",
    active_role: "patch",
    owned_files: ["src/store/lite-runtime-data-operations.ts"],
    modified_files: [],
    pending_validations: ["npm run -s typecheck"],
    completed_validations: [],
    last_accepted_hypothesis: null,
    rejected_paths: [],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    reviewer_contract: null,
    resume_anchor: null,
    updated_at: EXECUTION_AT,
  };
}

function stateTransition(args: {
  state: ExecutionStateV1;
  id: string;
  revision: number;
}): ExecutionStateTransitionV1 {
  return {
    transition_id: args.id,
    state_id: args.state.state_id,
    scope: args.state.scope,
    actor_role: "patch",
    at: `2026-07-12T00:0${args.revision - 1}:00.000Z`,
    expected_revision: args.revision - 1,
    type: "validation_completed",
    validations: [`validation-${args.revision}`],
  };
}

function treeOperation(args: {
  treeId: string;
  id: string;
  revision: number;
}): ExecutionTreeOperationV1 {
  return {
    operation_id: args.id,
    tree_id: args.treeId,
    scope: "data-operations-integrity",
    actor_role: "patch",
    at: `2026-07-12T00:0${args.revision - 1}:00.000Z`,
    expected_revision: args.revision - 1,
    type: "grow",
    action: `advance execution tree revision ${args.revision}`,
    observation: `execution tree revision ${args.revision} completed`,
    title: null,
    tool_name: "runtime-data-ops-test",
    refs: [],
  };
}

async function seedExecutionHistory(dbPath: string, name: string): Promise<{
  state: ExecutionStateV1;
  tree: ReturnType<typeof createExecutionTreeV1>;
}> {
  const state = executionState(`state-${name}`);
  const stateStore = createLiteExecutionStateStore(dbPath);
  try {
    stateStore.initialize(state);
    stateStore.applyTransition(stateTransition({ state, id: `state-${name}-r2`, revision: 2 }));
    stateStore.applyTransition(stateTransition({ state, id: `state-${name}-r3`, revision: 3 }));
  } finally {
    await stateStore.close();
  }

  const tree = createExecutionTreeV1({
    tree_id: `tree-${name}`,
    scope: "data-operations-integrity",
    task_brief: "Verify execution tree continuity before release backup",
    at: EXECUTION_AT,
  });
  const treeStore = createLiteExecutionTreeStore(dbPath);
  try {
    treeStore.initialize(tree);
    treeStore.applyOperation(treeOperation({ treeId: tree.tree_id, id: `tree-${name}-r2`, revision: 2 }));
    treeStore.applyOperation(treeOperation({ treeId: tree.tree_id, id: `tree-${name}-r3`, revision: 3 }));
  } finally {
    await treeStore.close();
  }
  return { state, tree };
}

function violationKinds(
  verification: Awaited<ReturnType<typeof verifyLiteRuntimeDatabase>>,
  resource: "state" | "tree",
): string[] {
  return verification.execution_history[resource].violations.map((violation) => violation.kind);
}

function createV034Schema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE lite_memory_commits (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      parent_commit_id TEXT,
      input_sha256 TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      actor TEXT NOT NULL,
      model_version TEXT,
      prompt_version TEXT,
      commit_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE lite_memory_nodes (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      client_id TEXT,
      type TEXT NOT NULL,
      tier TEXT NOT NULL,
      title TEXT,
      text_summary TEXT,
      slots_json TEXT NOT NULL,
      raw_ref TEXT,
      evidence_ref TEXT,
      embedding_vector_json TEXT,
      embedding_model TEXT,
      memory_lane TEXT NOT NULL,
      producer_agent_id TEXT,
      owner_agent_id TEXT,
      owner_team_id TEXT,
      embedding_status TEXT NOT NULL,
      embedding_last_error TEXT,
      salience REAL NOT NULL,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      redaction_version INTEGER NOT NULL,
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE lite_memory_edges (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      weight REAL NOT NULL,
      confidence REAL NOT NULL,
      decay_rate REAL NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(scope, type, src_id, dst_id)
    );
  `);
}

function insertV034Fixture(db: SqliteDatabase): void {
  const createdAt = "2026-07-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO lite_memory_commits
      (id, scope, parent_commit_id, input_sha256, diff_json, actor,
       model_version, prompt_version, commit_hash, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run("commit-v034", "default", "input-sha", "{}", "legacy-runtime", "commit-hash-v034", createdAt);
  const insertNode = db.prepare(
    `INSERT INTO lite_memory_nodes
      (id, scope, client_id, type, tier, title, text_summary, slots_json,
       raw_ref, evidence_ref, embedding_vector_json, embedding_model,
       memory_lane, producer_agent_id, owner_agent_id, owner_team_id,
       embedding_status, embedding_last_error, salience, importance,
       confidence, redaction_version, commit_id, created_at)
     VALUES (?, 'default', ?, ?, 'hot', ?, ?, '{}', NULL, NULL, NULL, NULL,
             'shared', 'legacy-agent', 'legacy-agent', NULL,
             'pending', NULL, 0.8, 0.8, 0.8, 1, 'commit-v034', ?)`,
  );
  insertNode.run(
    "node-recoverable",
    "legacy-recoverable",
    "concept",
    "Recoverable legacy memory",
    "The SQLite authority text can rebuild this embedding.",
    createdAt,
  );
  insertNode.run(
    "node-unrecoverable",
    "legacy-unrecoverable",
    "event",
    null,
    null,
    createdAt,
  );
  db.prepare(
    `INSERT INTO lite_memory_edges
      (id, scope, type, src_id, dst_id, weight, confidence, decay_rate,
       metadata_json, commit_id, created_at)
     VALUES ('edge-v034', 'default', 'related_to', 'node-recoverable',
             'node-unrecoverable', 0.7, 0.8, 0.1, '{}', 'commit-v034', ?)`,
  ).run(createdAt);
}

function seedV034(dbPath: string): void {
  const db = createSqliteDatabase(dbPath);
  try { createV034Schema(db); insertV034Fixture(db); }
  finally { db.close(); }
}

function insertCommittedNode(db: SqliteDatabase, args: {
  commitId: string;
  commitHash: string;
  nodeId: string;
  createdAt: string;
}): void {
  db.prepare(
    `INSERT INTO lite_memory_commits
      (id, scope, parent_commit_id, input_sha256, diff_json, actor,
       model_version, prompt_version, commit_hash, created_at)
     VALUES (?, 'default', 'commit-v034', ?, '{}', 'wal-writer', NULL, NULL, ?, ?)`,
  ).run(args.commitId, `input-${args.commitId}`, args.commitHash, args.createdAt);
  db.prepare(
    `INSERT INTO lite_memory_nodes
      (id, scope, client_id, type, tier, title, text_summary, slots_json,
       raw_ref, evidence_ref, embedding_vector_json, embedding_model,
       memory_lane, producer_agent_id, owner_agent_id, owner_team_id,
       embedding_status, embedding_last_error, salience, importance,
       confidence, redaction_version, commit_id, created_at)
     VALUES (?, 'default', ?, 'concept', 'hot', ?, ?, '{}', NULL, NULL,
             NULL, NULL, 'shared', 'wal-writer', 'wal-writer', NULL,
             'failed', 'embedding_not_requested', 0.8, 0.8, 0.8, 1, ?, ?)`,
  ).run(
    args.nodeId,
    `client-${args.nodeId}`,
    `Title ${args.nodeId}`,
    `Summary ${args.nodeId}`,
    args.commitId,
    args.createdAt,
  );
}

function tableNames(dbPath: string): string[] {
  const db = createSqliteDatabase(dbPath);
  try {
    return (db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
  } finally {
    db.close();
  }
}

function schemaSnapshot(dbPath: string): Array<{
  type: string;
  name: string;
  table_name: string;
  sql: string | null;
}> {
  const db = createSqliteDatabase(dbPath);
  try {
    return db.prepare(
      `SELECT type, name, tbl_name AS table_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    ).all() as Array<{
      type: string;
      name: string;
      table_name: string;
      sql: string | null;
    }>;
  } finally {
    db.close();
  }
}

function downgradeCurrentFixtureToV2(dbPath: string): void {
  const db = createSqliteDatabase(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("DROP TABLE lite_runtime_authority_adoption_bindings");
    db.exec("DROP TABLE lite_runtime_authority_adoption_manifests");
    for (const trigger of LITE_LEARNING_LEDGER_REQUIRED_TRIGGER_NAMES) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    for (const table of [...LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES].reverse()) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const column of ["record_sha256", "after_episode_id", "baseline_episode_id"]) {
      db.exec(`ALTER TABLE lite_product_measurements DROP COLUMN ${column}`);
    }
    db.prepare(
      `UPDATE lite_runtime_schema_metadata
       SET version = 2, updated_at = ?
       WHERE component = 'write_projection'`,
    ).run("2026-07-13T00:00:00.000Z");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

test("v0.3.4 SQLite upgrades without changing semantic rows and legacy pending is explicitly repairable", async (t) => {
  const temp = tempDatabase("v034-upgrade", t);
  seedV034(temp.path);
  fs.chmodSync(temp.path, 0o644);
  assert.equal(permissionMode(temp.path), 0o644);

  const before = await verifyLiteRuntimeDatabase(temp.path);
  assert.equal(before.schema.classification, "legacy_v0_3_4");
  assert.equal(before.counts.commits, 1); assert.equal(before.counts.nodes, 2);
  assert.equal(before.counts.edges, 1); assert.equal(before.counts.legacy_pending_without_job, 2);

  const upgraded = await upgradeLiteRuntimeDatabase(temp.path);
  assert.equal(upgraded.before.classification, "legacy_v0_3_4"); assert.equal(upgraded.after.classification, "current");
  const { commits: beforeCommits, ...beforeBusinessCounts } = upgraded.preserved_counts.before;
  const { commits: afterCommits, ...afterBusinessCounts } = upgraded.preserved_counts.after;
  assert.deepEqual(beforeBusinessCounts, afterBusinessCounts);
  assert.equal(afterCommits, beforeCommits + 1);
  assert.equal(permissionMode(temp.path), 0o600);

  const state = await inspectLiteProjectionRepairState({ path: temp.path });
  assert.equal(state.totals.legacy_pending, 2); assert.equal(state.totals.legacy_recoverable, 1);
  assert.equal(state.totals.legacy_unrecoverable, 1);
  assert.equal(
    state.legacy_pending.find((candidate) => candidate.node_id === "node-unrecoverable")?.reason,
    "missing_text_summary_and_title",
  );

  const repaired = await repairLiteProjectionState({ path: temp.path, providerName: "data-ops-test-provider", providerDim: 1536, defaultTenantId: "default" });
  assert.equal(repaired.repaired.legacy_embedding, 1); assert.equal(repaired.skipped.length, 1);
  assert.equal(repaired.skipped[0]?.node_id, "node-unrecoverable");
  const pending = repaired.after.jobs.find((job) => job.node_id === "node-recoverable");
  assert.equal(pending?.job_kind, "embedding_generate"); assert.equal(pending?.status, "pending");
  assert.equal(pending?.payload_valid, true); assert.equal(pending?.source_commit_matches, true);

  const cli = spawnSync(process.execPath,
    ["--import", "tsx", DATA_OPS_CLI, "projection-list", "--db", temp.path, "--status", "pending"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const cliBody = JSON.parse(cli.stdout) as { totals: { jobs: number } };
  assert.equal(cliBody.totals.jobs, 1);

  const explicitlyFailed = await repairLiteProjectionState({ path: temp.path, repairDeadLetters: false, markUnrecoverableFailed: true });
  assert.equal(explicitlyFailed.repaired.unrecoverable_marked_failed, 1);
  assert.equal(explicitlyFailed.after.totals.legacy_pending, 0);
});

test("upgrade CLI verifies and hardens the legacy replay SQLite companion", async (t) => {
  const temp = tempDatabase("upgrade-with-replay", t);
  const replayPath = path.join(temp.directory, "replay.sqlite");
  await createV2WriteFixture(temp.path);
  await createReplayFixture(replayPath);
  let replayRowCount = 0;
  if (process.platform !== "win32") {
    const crash = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(${JSON.stringify(replayPath)});
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO lite_replay_nodes(node_id,scope,replay_kind,node_type,slots_json,memory_lane,created_at,updated_at) VALUES('wal-node','scope','run','fact','{}','private','2026-07-20','2026-07-20')");
      process.kill(process.pid, "SIGKILL");
    `], { encoding: "utf8" });
    assert.equal(crash.signal, "SIGKILL", crash.stderr);
    replayRowCount = 1;
    for (const suffix of ["", "-wal", "-shm"]) fs.chmodSync(`${replayPath}${suffix}`, 0o644);
  }
  const cli = spawnSync(process.execPath,
    ["--import", "tsx", DATA_OPS_CLI, "upgrade", "--db", temp.path, "--replay-db", replayPath], { cwd: ROOT, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout) as Awaited<ReturnType<typeof upgradeLiteRuntimeDatabase>>;
  assert.deepEqual(report.replay_database, {
    contract_version: "aionis_lite_runtime_companion_sqlite_hardening_v1", path: replayPath, role: "replay",
    quick_check: ["ok"], foreign_key_violation_count: 0, row_count: replayRowCount,
    required_table_present: true, required_columns_present: true, node_id_primary_key: true,
    required_table_definition_present: true, required_indexes_present: true,
    mode_before: process.platform === "win32" ? null : "0644",
    mode_after: process.platform === "win32" ? null : "0600",
  });
  if (process.platform !== "win32") for (const suffix of ["", "-wal", "-shm"]) assert.equal(permissionMode(`${replayPath}${suffix}`), 0o600);
  const preservedReplay = createSqliteReadOnlyDatabase(replayPath);
  try {
    assert.deepEqual(preservedReplay.prepare("PRAGMA quick_check").all().map((row) => Object.values(row as object)[0]), ["ok"]);
    assert.equal((preservedReplay.prepare("SELECT COUNT(*) AS count FROM lite_replay_nodes WHERE node_id = 'wal-node'").get() as { count: number }).count, replayRowCount);
  } finally { preservedReplay.close(); }
  assert.equal((await verifyLiteRuntimeDatabase(temp.path)).schema.classification, "current");
  for (const replayArgs of [["--replay-db"], ["--replay-db", "   "]]) {
    const invalidReplayValue = spawnSync(process.execPath, ["--import", "tsx", DATA_OPS_CLI, "upgrade", "--db", temp.path, ...replayArgs], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(invalidReplayValue.status, 0);
    assert.match(invalidReplayValue.stderr, /missing required --replay-db/);
  }
});

test("replay companion validation fails before the write schema is upgraded", async (t) => {
  const cases: Array<[string, (db: SqliteDatabase) => void, RegExp]> = [
    ["missing-table", (db) => db.exec("DROP TABLE lite_replay_nodes"), /replay_companion_required_table_missing/],
    ["wrong-column-type", (db) => {
      const sql = (db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'lite_replay_nodes'").get() as { sql: string }).sql;
      db.exec("ALTER TABLE lite_replay_nodes RENAME TO old_replay_nodes");
      db.exec(sql.replace("step_index INTEGER", "step_index TEXT")); db.exec("DROP TABLE old_replay_nodes");
    }, /replay_companion_table_definition_mismatch/],
    ["wrong-index", (db) => db.exec(`
      DROP INDEX idx_lite_replay_nodes_scope_run; CREATE UNIQUE INDEX idx_lite_replay_nodes_scope_run
      ON lite_replay_nodes(scope) WHERE scope IS NOT NULL;
    `), /replay_companion_index_contract_mismatch/],
    ["global-index-name", (db) => db.exec(`
      DROP INDEX idx_lite_replay_nodes_scope_run; CREATE TABLE blocker (scope TEXT);
      CREATE INDEX idx_lite_replay_nodes_scope_run ON blocker(scope);
    `), /replay_companion_index_contract_mismatch/],
    ["same-name-trigger", (db) => db.exec(`
      CREATE TRIGGER idx_lite_replay_nodes_scope_run BEFORE INSERT ON lite_replay_nodes BEGIN SELECT RAISE(ABORT, 'blocked'); END;
    `), /replay_companion_unexpected_schema_object/],
    ["forged-internal-trigger", (db) => db.exec(`PRAGMA writable_schema=ON;
      INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql) VALUES('trigger','sqlite_evil','lite_replay_nodes',0,'CREATE TRIGGER sqlite_evil BEFORE INSERT ON lite_replay_nodes BEGIN SELECT RAISE(ABORT, ''blocked''); END'); PRAGMA writable_schema=OFF`), /replay_companion_unexpected_schema_object/],
    ["duplicate-autoindex", (db) => db.exec(`PRAGMA writable_schema=ON; INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)
      SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE name='sqlite_autoindex_lite_replay_nodes_1'; PRAGMA writable_schema=OFF`), /replay_companion_unexpected_schema_object/],
    ["unexpected-user-schema", (db) => db.exec("CREATE TABLE sqliteXextra (id INTEGER); CREATE TRIGGER extra_trigger AFTER INSERT ON sqliteXextra BEGIN SELECT 1; END"), /replay_companion_unexpected_schema_object/],
  ];
  for (const [name, mutate, expected] of cases) await t.test(name,
    (subtest) => assertInvalidReplayRejectedBeforeUpgrade(subtest, name, mutate, expected));
  await t.test("hard-link and symlink aliases", async (subtest) => {
    const temp = tempDatabase("replay-aliases", subtest);
    await createV2WriteFixture(temp.path);
    const hardlinkPath = path.join(temp.directory, "write-hardlink.sqlite"); fs.linkSync(temp.path, hardlinkPath);
    await assert.rejects(upgradeLiteRuntimeDatabase(temp.path, { replayPath: hardlinkPath }), /runtime_sqlite_artifact_hardlink_invalid|replay_companion_must_differ/);
    fs.rmSync(hardlinkPath);
    const replayPath = path.join(temp.directory, "replay.sqlite"); await createReplayFixture(replayPath);
    const symlinkPath = path.join(temp.directory, "replay-symlink.sqlite"); fs.symlinkSync(replayPath, symlinkPath);
    await assert.rejects(upgradeLiteRuntimeDatabase(temp.path, { replayPath: symlinkPath }), /runtime_sqlite_artifact_must_be_regular_file/);
    assert.equal(fs.existsSync(`${replayPath}-wal`), false);
    const db = createSqliteDatabase(temp.path);
    try { assert.equal(inspectLiteRuntimeSchema(db).classification, "supported_previous_v2"); }
    finally { db.close(); }
  });
  await t.test("non-final ancestor symlink aliases fail before offline hardening", {
    skip: process.platform === "win32" ? "symlink setup requires platform privileges" : false,
  }, async (subtest) => {
    const temp = tempDatabase("replay-ancestor-alias", subtest);
    const realDirectory = path.join(temp.directory, "real", "nested"); const aliasRoot = path.join(temp.directory, "alias");
    fs.mkdirSync(realDirectory, { recursive: true, mode: 0o700 }); fs.symlinkSync(path.dirname(realDirectory), aliasRoot, "dir");
    const canonicalPath = path.join(realDirectory, "runtime.sqlite");
    await createV2WriteFixture(canonicalPath); fs.chmodSync(realDirectory, 0o755);
    const aliasedPath = path.join(aliasRoot, "nested", "runtime.sqlite"); const authorityBefore = fs.readFileSync(canonicalPath);
    for (const reverse of [false, true]) {
      const [writePath, replayPath] = reverse ? [aliasedPath, canonicalPath] : [canonicalPath, aliasedPath];
      await assert.rejects(upgradeLiteRuntimeDatabase(writePath, { replayPath }), /runtime_sqlite_artifact_namespace_overlap/);
      assert.deepEqual(fs.readFileSync(canonicalPath), authorityBefore);
      assert.equal(fs.statSync(realDirectory).mode & 0o7777, 0o755);
    }
  });
  await t.test("write and replay reserved artifact namespaces", async (subtest) => {
    const temp = tempDatabase("replay-reserved-paths", subtest);
    const assertRejectedWithoutMutation = async (writePath: string, replayPath: string) => {
      const before = [fs.readFileSync(writePath), fs.readFileSync(replayPath)];
      await assert.rejects(upgradeLiteRuntimeDatabase(writePath, { replayPath }), /runtime_sqlite_artifact_namespace_overlap/);
      assert.deepEqual([fs.readFileSync(writePath), fs.readFileSync(replayPath)], before);
    };
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const writePath = path.join(temp.directory, `forward${suffix}.sqlite`); await createV2WriteFixture(writePath);
      const replayPath = `${writePath}${suffix}`; await createReplayFixture(replayPath);
      await assertRejectedWithoutMutation(writePath, replayPath);
      const reverseReplayPath = path.join(temp.directory, `reverse${suffix}.sqlite`); await createReplayFixture(reverseReplayPath);
      const reverseWritePath = `${reverseReplayPath}${suffix}`; await createV2WriteFixture(reverseWritePath);
      await assertRejectedWithoutMutation(reverseWritePath, reverseReplayPath);
    }
  });
});

test("upgrade rejects an uninitialized write database instead of blessing a wrong path", async (t) => {
  const temp = tempDatabase("uninitialized-upgrade", t);
  createSqliteDatabase(temp.path).close();
  await assert.rejects(upgradeLiteRuntimeDatabase(temp.path), /schema_upgrade_preflight_failed:.*uninitialized/);
  const db = createSqliteDatabase(temp.path);
  try { assert.equal(inspectLiteRuntimeSchema(db).classification, "uninitialized"); }
  finally { db.close(); }
});

test("current schema verification rejects invalid embedding tuples on legacy-v1 nodes", async (t) => {
  const numericVector = JSON.stringify(Array.from({ length: 1_536 }, () => 0.25));
  const cases = [
    {
      name: "ready tuple without a model",
      vector: numericVector,
      model: null,
    },
    {
      name: "ready tuple with string vector elements",
      vector: JSON.stringify(Array.from({ length: 1_536 }, () => "0.25")),
      model: "legacy-embedding-model",
    },
    {
      name: "ready tuple with non-finite vector elements",
      vector: `[${Array.from({ length: 1_536 }, () => "1e999").join(",")}]`,
      model: "legacy-embedding-model",
    },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const temp = tempDatabase("legacy-v1-invalid-embedding", subtest);
      seedV034(temp.path);
      await upgradeLiteRuntimeDatabase(temp.path);

      const baseline = await verifyLiteRuntimeDatabase(temp.path);
      assert.equal(baseline.schema.classification, "current");
      assert.equal(baseline.integrity_findings.ready_embedding_invalid, 0);
      assert.equal(baseline.ok, true);

      const db = createSqliteDatabase(temp.path);
      const legacyAuthority = db.prepare(
        `SELECT commit_row.digest_version
           FROM lite_memory_nodes AS node
           INNER JOIN lite_memory_commits AS commit_row
             ON commit_row.scope = node.scope AND commit_row.id = node.commit_id
           WHERE node.id = 'node-recoverable'`,
      ).get() as { digest_version: number };
      assert.equal(legacyAuthority.digest_version, 1);
      db.prepare(
        `UPDATE lite_memory_nodes
           SET embedding_status = 'ready',
               embedding_vector_json = ?,
               embedding_model = ?,
               embedding_last_error = NULL
           WHERE id = 'node-recoverable'`,
      ).run(fixture.vector, fixture.model);
      db.close();

      const report = await verifyLiteRuntimeDatabase(temp.path);
      assert.equal(report.schema.classification, "current");
      assert.equal(report.integrity_findings.ready_embedding_invalid, 1);
      assert.equal(report.ok, false);
    });
  }
});

test("projection dead-letter repair validates provider contract before atomically rebuilding intents", async (t) => {
  const temp = tempDatabase("dead-letter-repair", t);
  seedV034(temp.path);
  await upgradeLiteRuntimeDatabase(temp.path);
  await repairLiteProjectionState({
    path: temp.path,
    providerName: "data-ops-test-provider",
    providerDim: 1536,
  });

  const database = createLiteRuntimeDatabase(temp.path);
  const store = createLiteWriteStoreFromDatabase(database, {
    closeDatabaseOnClose: true,
    annProjectionEnabled: false,
  });
  const embeddingClaim = (await store.claimProjectionJobs({
    leaseOwner: "data-ops-test",
    leaseMs: 10_000,
    limit: 1,
    jobKinds: ["embedding_generate"],
  }))[0];
  assert.ok(embeddingClaim);
  assert.equal(await store.deadLetterProjectionJob({
    claim: embeddingClaim,
    error: "provider outage exhausted retries",
  }), true);
  database.db.prepare(
    `UPDATE lite_memory_projection_jobs
       SET payload_json = '{corrupt', payload_sha256 = 'invalid'
       WHERE scope = 'default'
         AND node_id = 'node-recoverable'
         AND job_kind = 'embedding_generate'`,
  ).run();
  await store.withTx(async () => {
    await store.enqueueAnnProjection({
      scope: "default",
      nodeId: "node-recoverable",
      sourceCommitId: "commit-v034",
    });
  });
  const annClaim = (await store.claimProjectionJobs({
    leaseOwner: "data-ops-test",
    leaseMs: 10_000,
    limit: 1,
    jobKinds: ["ann_reconcile"],
  }))[0];
  assert.ok(annClaim);
  assert.equal(await store.deadLetterProjectionJob({
    claim: annClaim,
    error: "ann sidecar unavailable",
  }), true);
  await store.close();

  await assert.rejects(
    repairLiteProjectionState({ path: temp.path }),
    /requires --provider-name and --provider-dim 1536/,
  );
  const unchanged = await inspectLiteProjectionRepairState({
    path: temp.path,
    statuses: ["dead_letter"],
  });
  assert.equal(unchanged.totals.dead_letters, 2);
  assert.equal(
    unchanged.jobs.find((job) => job.job_kind === "embedding_generate")?.payload_valid,
    false,
  );
  const invalidProjectionVerification = await verifyLiteRuntimeDatabase(temp.path);
  assert.equal(invalidProjectionVerification.ok, false);
  assert.equal(invalidProjectionVerification.integrity_findings.projection_payload_invalid, 1);
  assert.ok(invalidProjectionVerification.warnings.includes("projection_payload_repair_required"));

  const repaired = await repairLiteProjectionState({
    path: temp.path,
    providerName: "data-ops-test-provider",
    providerDim: 1536,
    repairLegacy: false,
  });
  assert.deepEqual(repaired.repaired, {
    legacy_embedding: 0,
    dead_letter_embedding: 1,
    dead_letter_ann: 1,
    unrecoverable_marked_failed: 0,
  });
  assert.equal(repaired.after.totals.dead_letters, 0);
  assert.equal(repaired.after.jobs.filter((job) => job.status === "pending").length, 2);
});

test("VACUUM INTO backup and restore-to-new-path preserve a verified SQLite snapshot", async (t) => {
  const temp = tempDatabase("backup-restore", t);
  seedV034(temp.path);
  await upgradeLiteRuntimeDatabase(temp.path);
  await repairLiteProjectionState({
    path: temp.path,
    providerName: "data-ops-test-provider",
    providerDim: 1536,
  });

  const walWriter = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  await persistInitialExecutionDecisionAuthority({
    store: walWriter,
    actor: "data-operations-wal-writer",
    decision: {
      id: "decision-in-active-wal",
      scope: "default",
      decisionKind: "tools_select",
      runId: null,
      selectedTool: "read",
      candidatesJson: [{ tool: "read" }],
      contextSha256: "c".repeat(64),
      policySha256: "d".repeat(64),
      sourceRuleIds: [],
      metadataJson: {},
      commitId: null,
      createdAt: "2026-07-02T00:00:00.000Z",
    },
  });
  assert.equal(fs.existsSync(`${temp.path}-wal`), true);
  assert.ok(fs.statSync(`${temp.path}-wal`).size > 32);

  const backupPath = path.join(temp.directory, "backups", "runtime.backup.sqlite");
  const backup = await backupLiteRuntimeDatabase({ sourcePath: temp.path, destinationPath: backupPath });
  await walWriter.close();
  assert.equal(backup.verification.ok, true);
  assert.equal(
    backup.verification.contract_version,
    "aionis_lite_runtime_data_verification_v2",
  );
  assert.equal(backup.verification.live_path, path.resolve(backupPath));
  assert.deepEqual(
    {
      source: backup.verification.snapshot_fingerprint.source,
      retained_path: backup.verification.snapshot_fingerprint.retained_path,
    },
    {
      source: "transactionally_consistent_vacuum_snapshot",
      retained_path: null,
    },
  );
  assert.equal("path" in backup.verification, false);
  assert.equal("byte_size" in backup.verification, false);
  assert.equal("sha256" in backup.verification, false);
  assert.equal(backup.verification.counts.nodes, 2);
  assert.equal(fs.existsSync(`${backupPath}.manifest.json`), true);
  assert.equal(permissionMode(backupPath), 0o600);
  assert.equal(permissionMode(`${backupPath}.manifest.json`), 0o600);
  assert.deepEqual(
    fs.readdirSync(path.dirname(backupPath))
      .filter((entry) => entry.startsWith(".aionis-runtime-backup-")),
    [],
  );
  assert.equal(backup.manifest.sha256, backup.verification.snapshot_fingerprint.sha256);
  assert.equal(backup.manifest.contract_version, "aionis_lite_runtime_backup_manifest_v2");
  assert.match(backup.manifest.database_instance_id ?? "", /^[0-9a-f]{64}$/);

  const restoredPath = path.join(temp.directory, "restored", "runtime.sqlite");
  const restored = await restoreLiteRuntimeDatabase({
    backupPath,
    destinationPath: restoredPath,
  });
  assert.equal(restored.verification.ok, true);
  assert.equal(restored.verification.live_path, path.resolve(restoredPath));
  assert.equal(restored.verification.snapshot_fingerprint.byte_size, backup.manifest.byte_size);
  assert.equal(restored.verification.snapshot_fingerprint.sha256, backup.manifest.sha256);
  assert.deepEqual(restored.verification.counts, backup.verification.counts);
  assert.deepEqual(
    restored.verification.learning.replay?.table_counts,
    backup.manifest.learning_table_counts,
  );
  assert.equal(restored.verification.database_instance_id, backup.manifest.database_instance_id);
  assert.equal(restored.verification.schema.classification, "current");
  assert.equal(permissionMode(restoredPath), 0o600);
  await assert.rejects(
    restoreLiteRuntimeDatabase({ backupPath, destinationPath: restoredPath }),
    /restore destination already exists/,
  );

  const manifestPath = `${backupPath}.manifest.json`;
  const currentManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const legacyManifest = structuredClone(currentManifest) as Record<string, unknown>;
  legacyManifest.contract_version = "aionis_lite_runtime_backup_manifest_v1";
  delete legacyManifest.learning_table_counts;
  const legacyCounts = legacyManifest.counts as Record<string, unknown>;
  for (const field of [
    "learning_episode_events",
    "learning_protected_events",
    "learning_legacy_events",
    "learning_promotion_eligible_exposures",
    "learning_control_jobs",
    "learning_control_dead_letters",
  ]) delete legacyCounts[field];
  fs.writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
  const legacyDestination = path.join(temp.directory, "restored", "legacy-manifest.sqlite");
  const legacyRestored = await restoreLiteRuntimeDatabase({
    backupPath,
    destinationPath: legacyDestination,
  });
  assert.equal(legacyRestored.verification.ok, true);

  const countDriftManifest = structuredClone(currentManifest) as Record<string, unknown>;
  const countDriftCounts = countDriftManifest.counts as Record<string, number>;
  countDriftCounts.nodes = Number(countDriftCounts.nodes) + 1;
  fs.writeFileSync(manifestPath, `${JSON.stringify(countDriftManifest, null, 2)}\n`);
  const countDriftDestination = path.join(temp.directory, "restored", "count-drift.sqlite");
  await assert.rejects(
    restoreLiteRuntimeDatabase({ backupPath, destinationPath: countDriftDestination }),
    /backup_manifest_semantic_mismatch:counts/,
  );
  assert.equal(fs.existsSync(countDriftDestination), false);

  const learningCountDriftManifest = structuredClone(currentManifest) as Record<string, unknown>;
  const learningCountDrift = learningCountDriftManifest.learning_table_counts as Record<string, number>;
  learningCountDrift.lite_learning_episode_events =
    Number(learningCountDrift.lite_learning_episode_events) + 1;
  fs.writeFileSync(manifestPath, `${JSON.stringify(learningCountDriftManifest, null, 2)}\n`);
  const learningCountDriftDestination = path.join(
    temp.directory,
    "restored",
    "learning-count-drift.sqlite",
  );
  await assert.rejects(
    restoreLiteRuntimeDatabase({ backupPath, destinationPath: learningCountDriftDestination }),
    /backup_manifest_semantic_mismatch:learning_table_counts/,
  );
  assert.equal(fs.existsSync(learningCountDriftDestination), false);

  const tamperedManifest = structuredClone(currentManifest) as Record<string, unknown>;
  tamperedManifest.schema_version = 2;
  fs.writeFileSync(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
  const tamperedDestination = path.join(temp.directory, "restored", "tampered.sqlite");
  await assert.rejects(
    restoreLiteRuntimeDatabase({ backupPath, destinationPath: tamperedDestination }),
    /backup_manifest_semantic_mismatch:schema_version/,
  );
  assert.equal(fs.existsSync(tamperedDestination), false);
  assert.deepEqual(
    fs.readdirSync(path.join(temp.directory, "restored"))
      .filter((entry) => entry.startsWith(".aionis-runtime-restore-")),
    [],
  );
});

test("restore pins one manifest-bound file handle before the source path drifts", async (t) => {
  const temp = tempDatabase("restore-manifest-snapshot-race", t);
  seedV034(temp.path);
  await upgradeLiteRuntimeDatabase(temp.path);
  await repairLiteProjectionState({
    path: temp.path,
    providerName: "data-ops-test-provider",
    providerDim: 1536,
  });
  const padding = createSqliteDatabase(temp.path);
  padding.exec(
    "CREATE TABLE restore_test_padding (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)",
  );
  padding.prepare("INSERT INTO restore_test_padding (id, payload) VALUES (1, zeroblob(?))")
    .run(16 * 1024 * 1024);
  padding.close();

  const backupPath = path.join(temp.directory, "backups", "runtime.backup.sqlite");
  const backup = await backupLiteRuntimeDatabase({ sourcePath: temp.path, destinationPath: backupPath });
  const driftPath = path.join(temp.directory, "backups", "runtime.drift.sqlite");
  fs.copyFileSync(backupPath, driftPath);
  const drift = createSqliteDatabase(driftPath);
  drift.prepare("INSERT INTO restore_test_padding (id, payload) VALUES (2, zeroblob(?))")
    .run(1024 * 1024);
  drift.close();

  const destinationDirectory = path.join(temp.directory, "restored-race");
  const destinationPath = path.join(destinationDirectory, "runtime.sqlite");
  const restore = restoreLiteRuntimeDatabase({ backupPath, destinationPath });
  const deadline = Date.now() + 10_000;
  let stagedSnapshotObserved = false;
  while (Date.now() < deadline) {
    const stagingDirectory = fs.existsSync(destinationDirectory)
      ? fs.readdirSync(destinationDirectory)
        .find((entry) => entry.startsWith(".aionis-runtime-restore-"))
      : undefined;
    const stagedSnapshot = stagingDirectory
      ? path.join(destinationDirectory, stagingDirectory, "runtime.sqlite")
      : null;
    if (stagedSnapshot && fs.existsSync(stagedSnapshot)
      && fs.statSync(stagedSnapshot).size >= backup.manifest.byte_size) {
      stagedSnapshotObserved = true;
      break;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2));
  }
  assert.equal(stagedSnapshotObserved, true, "restore did not expose a complete private snapshot");

  const originalBackupPath = path.join(temp.directory, "backups", "runtime.original.sqlite");
  fs.renameSync(backupPath, originalBackupPath);
  fs.renameSync(driftPath, backupPath);

  const restored = await restore;
  assert.equal(restored.verification.snapshot_fingerprint.sha256, backup.manifest.sha256);
  assert.deepEqual(restored.verification.counts, backup.manifest.counts);
  assert.deepEqual(
    restored.verification.learning.replay?.table_counts,
    backup.manifest.learning_table_counts,
  );
  const driftVerification = await verifyLiteRuntimeDatabase(backupPath);
  assert.equal(driftVerification.counts.nodes, backup.manifest.counts.nodes);
  assert.notEqual(
    driftVerification.snapshot_fingerprint.sha256,
    backup.manifest.sha256,
    "the path drift fixture must differ from the manifest-bound snapshot",
  );
});

test("verify and backup fail closed on execution projection and event-history corruption", async (t) => {
  await t.test("current state projection contradicts the latest event and blocks backup", async (subtest) => {
    const temp = tempDatabase("state-projection-corrupt", subtest);
    const fixture = await seedExecutionHistory(temp.path, "state-projection-corrupt");
    assert.equal((await verifyLiteRuntimeDatabase(temp.path)).ok, true);

    const db = createSqliteDatabase(temp.path);
    try {
      db.prepare(
        `UPDATE lite_execution_states
           SET state_json = ?
           WHERE scope = ? AND state_id = ?`,
      ).run(JSON.stringify(fixture.state), fixture.state.scope, fixture.state.state_id);
    } finally {
      db.close();
    }

    const verification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(verification.ok, false);
    assert.equal(verification.integrity_findings.execution_state_history_invalid, 1);
    assert.equal(verification.execution_history.tree.ok, true);
    assert.ok(violationKinds(verification, "state").includes("projection_after_state_mismatch"));
    assert.ok(verification.warnings.includes("execution_state_history_corrupt"));

    const backupPath = path.join(temp.directory, "must-not-exist.sqlite");
    await assert.rejects(
      backupLiteRuntimeDatabase({ sourcePath: temp.path, destinationPath: backupPath }),
      /source_database_verification_failed/,
    );
    assert.equal(fs.existsSync(backupPath), false);
  });

  await t.test("tampered historical after-tree breaks the event chain", async (subtest) => {
    const temp = tempDatabase("tree-chain-corrupt", subtest);
    const fixture = await seedExecutionHistory(temp.path, "tree-chain-corrupt");
    const db = createSqliteDatabase(temp.path);
    try {
      const row = db.prepare(
        `SELECT tree_after_json
           FROM lite_execution_tree_operations
           WHERE scope = ? AND tree_id = ? AND revision = 2`,
      ).get(fixture.tree.scope, fixture.tree.tree_id) as { tree_after_json: string };
      const afterTree = JSON.parse(row.tree_after_json) as Record<string, unknown>;
      afterTree.task_brief = "tampered historical tree after-state";
      db.prepare(
        `UPDATE lite_execution_tree_operations
           SET tree_after_json = ?
           WHERE scope = ? AND tree_id = ? AND revision = 2`,
      ).run(JSON.stringify(afterTree), fixture.tree.scope, fixture.tree.tree_id);
    } finally {
      db.close();
    }

    const verification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(verification.ok, false);
    assert.ok(violationKinds(verification, "tree").includes("event_chain_mismatch"));
  });

  await t.test("event expected revision mismatch is rejected", async (subtest) => {
    const temp = tempDatabase("state-revision-corrupt", subtest);
    const fixture = await seedExecutionHistory(temp.path, "state-revision-corrupt");
    const db = createSqliteDatabase(temp.path);
    try {
      const row = db.prepare(
        `SELECT transition_json
           FROM lite_execution_state_transitions
           WHERE scope = ? AND state_id = ? AND revision = 3`,
      ).get(fixture.state.scope, fixture.state.state_id) as { transition_json: string };
      const transitionJson = JSON.parse(row.transition_json) as Record<string, unknown>;
      transitionJson.expected_revision = 1;
      db.prepare(
        `UPDATE lite_execution_state_transitions
           SET expected_revision = 1, transition_json = ?
           WHERE scope = ? AND state_id = ? AND revision = 3`,
      ).run(JSON.stringify(transitionJson), fixture.state.scope, fixture.state.state_id);
    } finally {
      db.close();
    }

    const verification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(verification.ok, false);
    assert.ok(violationKinds(verification, "state").includes("event_revision_mismatch"));
  });

  await t.test("missing middle event creates a revision gap", async (subtest) => {
    const temp = tempDatabase("state-gap-corrupt", subtest);
    const fixture = await seedExecutionHistory(temp.path, "state-gap-corrupt");
    const db = createSqliteDatabase(temp.path);
    try {
      db.prepare(
        `DELETE FROM lite_execution_state_transitions
           WHERE scope = ? AND state_id = ? AND revision = 2`,
      ).run(fixture.state.scope, fixture.state.state_id);
    } finally {
      db.close();
    }

    const verification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(verification.ok, false);
    assert.ok(violationKinds(verification, "state").includes("revision_gap"));
  });

  await t.test("event rows without their current tree projection are orphaned", async (subtest) => {
    const temp = tempDatabase("tree-orphan-corrupt", subtest);
    const fixture = await seedExecutionHistory(temp.path, "tree-orphan-corrupt");
    const db = createSqliteDatabase(temp.path);
    try {
      db.prepare(
        `DELETE FROM lite_execution_trees
           WHERE scope = ? AND tree_id = ?`,
      ).run(fixture.tree.scope, fixture.tree.tree_id);
    } finally {
      db.close();
    }

    const verification = await verifyLiteRuntimeDatabase(temp.path);
    assert.equal(verification.ok, false);
    assert.equal(verification.integrity_findings.execution_tree_history_invalid, 1);
    assert.ok(violationKinds(verification, "tree").includes("orphan_event"));
  });
});

test("commit corruption is reported once as commit authority, not duplicated as ledger corruption", async (t) => {
  const temp = tempDatabase("commit-authority-reporting", t);
  const store = createLiteWriteStore(temp.path);
  const decision = await persistInitialExecutionDecisionAuthority({
    store,
    actor: "data-operations-test",
    decision: {
      id: "data-operations-commit-authority-reporting",
      scope: "default",
      decisionKind: "tools_select",
      runId: null,
      selectedTool: "read",
      candidatesJson: [{ tool: "read" }],
      contextSha256: "a".repeat(64),
      policySha256: "b".repeat(64),
      sourceRuleIds: [],
      metadataJson: {},
      commitId: null,
      createdAt: "2026-07-19T00:00:00.000Z",
    },
  });
  await store.close();

  const db = createSqliteDatabase(temp.path);
  try {
    db.prepare(
      "UPDATE lite_memory_commits SET mutation_digest = ? WHERE id = ?",
    ).run("0".repeat(64), decision.authority_commit.commit_id);
  } finally {
    db.close();
  }

  const verification = await verifyLiteRuntimeDatabase(temp.path);
  assert.equal(verification.ok, false);
  assert.ok(verification.integrity_findings.commit_authority_invalid > 0);
  assert.equal(verification.integrity_findings.learning_episode_ledger_invalid, 0);
  assert.ok(verification.warnings.includes("memory_commit_authority_corrupt"));
  assert.equal(verification.warnings.includes("learning_episode_ledger_corrupt"), false);
  assert.equal(verification.learning.integrity_error, null);
  assert.equal(verification.learning.replay, null);
});

test("an unversioned database with v3-only authority tables fails closed as a hybrid", async (t) => {
  const temp = tempDatabase("unversioned-current", t);
  seedV034(temp.path);
  await upgradeLiteRuntimeDatabase(temp.path);

  const unversioned = createSqliteDatabase(temp.path);
  unversioned.exec("DROP TABLE lite_runtime_schema_metadata");
  unversioned.close();
  const before = await verifyLiteRuntimeDatabase(temp.path);
  assert.equal(before.schema.classification, "incompatible");
  assert.match(before.schema.problems.join("\n"), /v3-only authority tables already exist/);
  assert.equal(before.counts.projection_jobs, 0);

  const snapshot = schemaSnapshot(temp.path);
  await assert.rejects(
    upgradeLiteRuntimeDatabase(temp.path),
    /schema_upgrade_preflight_failed/,
  );
  assert.deepEqual(schemaSnapshot(temp.path), snapshot);
});

test("projection repair waits for an active SQLite writer and then commits one new generation", async (t) => {
  const temp = tempDatabase("repair-concurrency", t);
  let blocker: SqliteDatabase | null = null;
  try {
    seedV034(temp.path);
    await upgradeLiteRuntimeDatabase(temp.path);
    await repairLiteProjectionState({
      path: temp.path,
      providerName: "data-ops-test-provider",
      providerDim: 1536,
      nodeId: "node-recoverable",
    });
    const runtimeDatabase = createLiteRuntimeDatabase(temp.path);
    const store = createLiteWriteStoreFromDatabase(runtimeDatabase, {
      closeDatabaseOnClose: true,
      annProjectionEnabled: false,
    });
    const claim = (await store.claimProjectionJobs({
      leaseOwner: "concurrency-fixture",
      leaseMs: 10_000,
      limit: 1,
      jobKinds: ["embedding_generate"],
    }))[0];
    assert.ok(claim);
    assert.equal(await store.deadLetterProjectionJob({ claim, error: "repair-concurrency-fixture" }), true);
    await store.close();

    blocker = createSqliteDatabase(temp.path);
    blocker.exec("BEGIN IMMEDIATE");
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        DATA_OPS_CLI,
        "projection-repair",
        "--db",
        temp.path,
        "--dead-letter-only",
        "--embedding-only",
        "--node",
        "node-recoverable",
        "--provider-name",
        "data-ops-test-provider",
        "--provider-dim",
        "1536",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const childExit = new Promise<number | null>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("projection repair child did not exit")), 10_000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolvePromise(code);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
    assert.equal(child.exitCode, null, `repair exited while another writer held BEGIN IMMEDIATE: ${stderr}`);
    const heldRow = blocker.prepare(
      `SELECT status, generation
       FROM lite_memory_projection_jobs
       WHERE scope = 'default'
         AND node_id = 'node-recoverable'
         AND job_kind = 'embedding_generate'`,
    ).get() as { status: string; generation: number };
    assert.equal(heldRow.status, "dead_letter");
    blocker.exec("COMMIT");
    blocker.close();
    blocker = null;

    const exitCode = await childExit;
    assert.equal(exitCode, 0, stderr);
    const result = JSON.parse(stdout) as { repaired: { dead_letter_embedding: number } };
    assert.equal(result.repaired.dead_letter_embedding, 1);
    const after = await inspectLiteProjectionRepairState({
      path: temp.path,
      nodeId: "node-recoverable",
    });
    const job = after.jobs.find((candidate) => candidate.job_kind === "embedding_generate");
    assert.equal(job?.status, "pending");
    assert.equal(job?.generation, heldRow.generation + 1);
  } finally {
    if (blocker) {
      try {
        blocker.exec("ROLLBACK");
      } catch {
        // The transaction may already have been released by the successful path.
      }
      blocker.close();
    }
  }
});

test("complete v6 is current after authority-adoption migration", async (t) => {
  const temp = tempDatabase("complete-v5-current", t);
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  await store.close();

  const db = createSqliteDatabase(temp.path);
  try {
    const report = inspectLiteRuntimeSchema(db);
    assert.equal(report.detected_version, 6);
    assert.equal(report.current_version, 6);
    assert.equal(report.classification, "current");
    assert.equal(report.upgrade_required, false);
  } finally {
    db.close();
  }
});

test("external-head projection flags stay fail-closed until Task 8 signed ingestion exists", async (t) => {
  const temp = tempDatabase("external-heads-task8-fence", t);
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  await store.close();
  const paired = spawnSync(
    process.execPath,
    [
      "--import", "tsx", DATA_OPS_CLI, "verify", "--db", temp.path,
      "--learning-external-heads-from-coverage", path.join(temp.directory, "coverage.json"),
      "--learning-external-heads-out", path.join(temp.directory, "heads.json"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(paired.status, 1);
  assert.match(paired.stderr, /learning_external_heads_requires_task8_signed_ingestion/);
  assert.equal(fs.existsSync(path.join(temp.directory, "heads.json")), false);

  const unpaired = spawnSync(
    process.execPath,
    [
      "--import", "tsx", DATA_OPS_CLI, "verify", "--db", temp.path,
      "--learning-external-heads-out", path.join(temp.directory, "heads.json"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(unpaired.status, 1);
  assert.match(unpaired.stderr, /must be supplied together/);
});

test("damaged v2 authority table is incompatible before migration", async (t) => {
  const temp = tempDatabase("damaged-v2-authority", t);
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  await store.close();
  downgradeCurrentFixtureToV2(temp.path);

  const db = createSqliteDatabase(temp.path);
  try {
    db.exec("DROP INDEX idx_lite_product_guide_receipts_run_created");
    const beforeInspection = schemaSnapshot(temp.path);
    const report = inspectLiteRuntimeSchema(db);
    assert.equal(report.detected_version, 2);
    assert.equal(report.current_version, 6);
    assert.equal(report.classification, "incompatible");
    assert.match(
      report.index_problems.join("\n"),
      /missing required index idx_lite_product_guide_receipts_run_created/,
    );
    assert.deepEqual(schemaSnapshot(temp.path), beforeInspection);
  } finally {
    db.close();
  }
});

test("future schema remains incompatible", (t) => {
  const temp = tempDatabase("future-schema-report", t);
  const db = createSqliteDatabase(temp.path);
  try {
    createV034Schema(db);
    db.exec(`
        CREATE TABLE lite_runtime_schema_metadata (
          component TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    db.prepare(
      "INSERT INTO lite_runtime_schema_metadata (component, version, updated_at) VALUES (?, ?, ?)",
    ).run("write_projection", 99, "2026-07-01T00:00:00.000Z");

    const report = inspectLiteRuntimeSchema(db);
    assert.equal(report.detected_version, 99);
    assert.equal(report.current_version, 6);
    assert.equal(report.classification, "incompatible");
    assert.match(report.problems.join("\n"), /newer than supported version 6/);
  } finally {
    db.close();
  }
});

test("complete v2 is supported_previous_v2 against the active v6 target", async (t) => {
  const temp = tempDatabase("complete-v2-against-active-v5", t);
  const store = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
  await store.close();
  downgradeCurrentFixtureToV2(temp.path);

  const db = createSqliteDatabase(temp.path);
  try {
    const beforeInspection = schemaSnapshot(temp.path);
    const report = inspectLiteRuntimeSchema(db);
    assert.equal(report.detected_version, 2);
    assert.equal(report.current_version, 6);
    assert.equal(report.classification, "supported_previous_v2");
    assert.equal(report.upgrade_required, true);
    assert.deepEqual(report.missing_tables, []);
    assert.deepEqual(report.missing_columns, {});
    assert.deepEqual(report.constraint_problems, []);
    assert.deepEqual(report.index_problems, []);
    assert.deepEqual(schemaSnapshot(temp.path), beforeInspection);
  } finally {
    db.close();
  }
});

test("future schema version fails closed before current tables are created", async (t) => {
  const temp = tempDatabase("future-schema", t);
  const db = createSqliteDatabase(temp.path);
  createV034Schema(db);
  db.exec(`
      CREATE TABLE lite_runtime_schema_metadata (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  db.prepare(
    "INSERT INTO lite_runtime_schema_metadata (component, version, updated_at) VALUES (?, ?, ?)",
  ).run("write_projection", 99, "2026-07-01T00:00:00.000Z");
  db.close();
  fs.chmodSync(temp.path, 0o600);
  const before = tableNames(temp.path);

  assert.throws(
    () => createLiteWriteStore(temp.path),
    /lite_runtime_schema_preflight_failed/,
  );
  assert.deepEqual(tableNames(temp.path), before);
  assert.equal(before.includes("lite_memory_projection_jobs"), false);
  assert.equal(before.includes("lite_runtime_write_operations"), false);
});

test("damaged current schemas fail closed before startup can silently recreate or use them", async (t) => {
  const corruptionCases: Array<[string, (db: SqliteDatabase) => void, RegExp]> = [
    ["write operation receipt loses commit_id",
      (db) => db.exec("ALTER TABLE lite_runtime_write_operations DROP COLUMN commit_id"),
      /lite_runtime_write_operations.*commit_id/],
    ["guide receipt loses run and consumer identity columns", (db) => db.exec(`
          DROP TABLE lite_product_guide_receipts;
          CREATE TABLE lite_product_guide_receipts (
            tenant_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            guide_trace_id TEXT NOT NULL,
            query_sha256 TEXT NOT NULL,
            context_sha256 TEXT NOT NULL,
            ledger_sha256 TEXT NOT NULL,
            ledger_json TEXT NOT NULL,
            commit_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, scope, guide_trace_id)
          );
          CREATE INDEX idx_lite_product_guide_receipts_scope_created
            ON lite_product_guide_receipts(tenant_id, scope, created_at DESC, guide_trace_id DESC);
        `), /lite_product_guide_receipts.*run_id.*consumer_agent_id.*consumer_team_id/],
    ["projection job loses a lease field used by claim completion",
      (db) => db.exec("ALTER TABLE lite_memory_projection_jobs DROP COLUMN lease_token"),
      /lite_memory_projection_jobs.*lease_token/],
    ["operation receipt primary key is removed by a table rebuild", (db) => db.exec(`
          DROP TABLE lite_runtime_write_operations;
          CREATE TABLE lite_runtime_write_operations (
            tenant_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            operation_kind TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            request_sha256 TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            commit_id TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX idx_lite_runtime_write_operations_created
            ON lite_runtime_write_operations(created_at DESC);
        `), /lite_runtime_write_operations primary key mismatch/],
    ["commit hash unique constraint is removed by a table rebuild", (db) => db.exec(`
          DROP TABLE lite_memory_commits;
          CREATE TABLE lite_memory_commits (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            parent_commit_id TEXT,
            input_sha256 TEXT NOT NULL,
            diff_json TEXT NOT NULL,
            actor TEXT NOT NULL,
            model_version TEXT,
            prompt_version TEXT,
            commit_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX idx_lite_memory_commits_scope_created
            ON lite_memory_commits(scope, created_at DESC, id DESC);
        `), /lite_memory_commits is missing unique constraint \(commit_hash\)/],
    ["current authority table is dropped",
      (db) => db.exec("DROP TABLE lite_product_guide_receipts"), /lite_product_guide_receipts/],
    ["projection scheduler index is dropped",
      (db) => db.exec("DROP INDEX idx_lite_memory_projection_jobs_available"),
      /missing required index idx_lite_memory_projection_jobs_available/],
    ["projection lease index keeps its name but changes predicate", (db) => db.exec(`
          DROP INDEX idx_lite_memory_projection_jobs_lease;
          CREATE INDEX idx_lite_memory_projection_jobs_lease
            ON lite_memory_projection_jobs(lease_expires_at)
            WHERE status = 'pending';
        `), /idx_lite_memory_projection_jobs_lease predicate mismatch/],
  ];

  for (const [name, corrupt, expectedDetail] of corruptionCases) {
    await t.test(name, async (subtest) => {
      const temp = tempDatabase("current-corruption", subtest);
      const initialized = createLiteWriteStore(temp.path, { annProjectionEnabled: false });
      await initialized.close();

      const corruptingDb = createSqliteDatabase(temp.path);
      corrupt(corruptingDb);
      const report = inspectLiteRuntimeSchema(corruptingDb);
      corruptingDb.close();
      assert.equal(report.classification, "incompatible");
      assert.match(JSON.stringify(report), expectedDetail);

      const beforeStartup = schemaSnapshot(temp.path);
      const runtimeDatabase = createLiteRuntimeDatabase(temp.path);
      try {
        assert.throws(
          () => createLiteWriteStoreFromDatabase(runtimeDatabase),
          /lite_runtime_schema_preflight_failed/,
        );
      } finally {
        await runtimeDatabase.close();
      }
      assert.deepEqual(schemaSnapshot(temp.path), beforeStartup);
    });
  }
});
