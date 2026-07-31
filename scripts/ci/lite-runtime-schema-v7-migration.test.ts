import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeExecutionEpisodeV7ObjectsForPreviousSchemaFixture } from
  "./schema-fixture-helpers.ts";

import {
  applyMemoryWrite,
  prepareMemoryWrite,
} from "../../src/memory/write.ts";
import {
  LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_COLUMNS,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEX_NAMES,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_TABLE_NAMES,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGER_NAMES,
} from "../../src/store/lite-execution-episode-schema.ts";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_COMPONENT,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../src/store/lite-runtime-schema.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import {
  createSqliteDatabase,
  type SqliteDatabase,
} from "../../src/store/sqlite.ts";

const FIXTURE_AT = "2026-07-27T00:00:00.000Z";
const MEMORY_SCOPE = "default";
const MEMORY_NODE_ID = "11111111-1111-4111-8111-111111111111";

type TempDatabase = Readonly<{
  directory: string;
  path: string;
}>;

function tempDatabase(name: string): TempDatabase {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "aionis-runtime-schema-v7-"),
  );
  return {
    directory,
    path: path.join(directory, `${name}.sqlite`),
  };
}

function requiredV7ObjectNames(): Set<string> {
  return new Set([
    ...LITE_EXECUTION_EPISODE_V7_REQUIRED_TABLE_NAMES,
    ...LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEX_NAMES,
    ...LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGER_NAMES,
  ]);
}

function requiredV7ObjectSnapshot(
  db: SqliteDatabase,
): Array<Readonly<{ type: string; name: string; table_name: string; sql: string }>> {
  const required = requiredV7ObjectNames();
  return (db.prepare(
    `SELECT type, name, tbl_name AS table_name, sql
     FROM sqlite_schema
     WHERE type IN ('table', 'index', 'trigger')
     ORDER BY type, name`,
  ).all() as Array<{
    type: string;
    name: string;
    table_name: string;
    sql: string | null;
  }>)
    .filter((row) => required.has(row.name))
    .map((row) => {
      assert.notEqual(row.sql, null, `${row.type} ${row.name} has no SQL`);
      return {
        type: row.type,
        name: row.name,
        table_name: row.table_name,
        sql: row.sql!,
      };
    });
}

function schemaMetadata(
  db: SqliteDatabase,
): Readonly<{ component: string; version: number; updated_at: string }> {
  const row = db.prepare(
    `SELECT component, version, updated_at
     FROM lite_runtime_schema_metadata
     WHERE component = ?`,
  ).get(LITE_RUNTIME_WRITE_SCHEMA_COMPONENT) as {
    component: string;
    version: number;
    updated_at: string;
  } | undefined;
  assert.ok(row, "write schema metadata is missing");
  return row;
}

function preservedMemoryRow(
  db: SqliteDatabase,
): Readonly<{
  id: string;
  scope: string;
  title: string | null;
  text_summary: string | null;
  commit_id: string;
}> {
  const row = db.prepare(
    `SELECT id, scope, title, text_summary, commit_id
     FROM lite_memory_nodes
     WHERE scope = ? AND id = ?`,
  ).get(MEMORY_SCOPE, MEMORY_NODE_ID) as {
    id: string;
    scope: string;
    title: string | null;
    text_summary: string | null;
    commit_id: string;
  } | undefined;
  assert.ok(row, "preexisting memory row was not preserved");
  return row;
}

async function createCurrentDatabase(
  dbPath: string,
  options: { seedMemory?: boolean } = {},
): Promise<void> {
  const store = createLiteWriteStore(dbPath, {
    annProjectionEnabled: false,
  });
  try {
    if (options.seedMemory) {
      const prepared = await prepareMemoryWrite({
        tenant_id: "default",
        scope: MEMORY_SCOPE,
        actor: "schema-v7-migration-test",
        producer_agent_id: "schema-v7-migration-test",
        owner_agent_id: "schema-v7-migration-test",
        input_text:
          "Preserve one real memory row while upgrading schema v6 to v7.",
        auto_embed: false,
        nodes: [{
          id: MEMORY_NODE_ID,
          type: "concept",
          tier: "hot",
          memory_lane: "private",
          title: "Preserved v6 memory",
          text_summary:
            "This real SQLite memory row must survive schema v7 migration.",
          slots: { fixture: "schema-v6-to-v7-preservation" },
          salience: 0.5,
          importance: 0.5,
          confidence: 0.5,
        }],
        edges: [],
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      }, null);
      await store.withTx(() => applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        write_access: store,
      }));
    }
  } finally {
    await store.close();
  }
}

function removeAllV7ObjectsAndDeclareV6(dbPath: string): void {
  const db = createSqliteDatabase(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      removeExecutionEpisodeV7ObjectsForPreviousSchemaFixture(db);
      const changed = db.prepare(
        `UPDATE lite_runtime_schema_metadata
         SET version = ?, updated_at = ?
         WHERE component = ?`,
      ).run(6, FIXTURE_AT, LITE_RUNTIME_WRITE_SCHEMA_COMPONENT);
      assert.equal(Number(changed.changes), 1);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function assertExactV6(dbPath: string): void {
  const db = createSqliteDatabase(dbPath);
  try {
    const report = inspectLiteRuntimeSchema(db);
    assert.equal(report.classification, "supported_previous_v6", JSON.stringify(report));
    assert.equal(report.detected_version, 6);
    assert.equal(report.current_version, 9);
    assert.equal(report.upgrade_required, true);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(requiredV7ObjectSnapshot(db), []);
  } finally {
    db.close();
  }
}

test("fresh current Runtime includes the complete v7 contract and reopens idempotently", async () => {
  const temp = tempDatabase("fresh-current-v7");
  try {
    await createCurrentDatabase(temp.path);

    const firstDb = createSqliteDatabase(temp.path);
    let firstObjects:
      ReturnType<typeof requiredV7ObjectSnapshot>;
    let firstMetadata:
      ReturnType<typeof schemaMetadata>;
    try {
      const report = inspectLiteRuntimeSchema(firstDb);
      assert.equal(LITE_RUNTIME_WRITE_SCHEMA_VERSION, 9);
      assert.equal(report.classification, "current", JSON.stringify(report));
      assert.equal(report.detected_version, 9);
      assert.equal(report.current_version, 9);
      assert.equal(report.upgrade_required, false);
      assert.deepEqual(report.missing_tables, []);
      assert.deepEqual(report.missing_columns, {});
      assert.deepEqual(report.constraint_problems, []);
      assert.deepEqual(report.table_definition_problems, []);
      assert.deepEqual(report.index_problems, []);
      assert.deepEqual(report.trigger_problems, []);
      firstObjects = requiredV7ObjectSnapshot(firstDb);
      firstMetadata = schemaMetadata(firstDb);
      assert.equal(firstObjects.length, requiredV7ObjectNames().size);
      for (const table of [
        "lite_execution_verifier_invocations",
        "lite_execution_verifier_receipts",
      ]) {
        const columns =
          LITE_EXECUTION_EPISODE_V7_REQUIRED_COLUMNS[table] ?? [];
        assert.ok(columns.includes("verifier_program_digest"));
        assert.equal(columns.includes("verifier_executable_digest"), false);
      }
      const learningLinkColumns =
        LITE_EXECUTION_EPISODE_V7_REQUIRED_COLUMNS
          .lite_execution_learning_links ?? [];
      assert.ok(learningLinkColumns.includes("execution_scope"));
      assert.ok(learningLinkColumns.includes("learning_scope"));
      assert.equal(learningLinkColumns.includes("scope"), false);
      assert.deepEqual(
        LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS
          .lite_execution_learning_links?.primaryKey,
        ["tenant_id", "execution_scope", "link_id"],
      );
      assert.deepEqual(
        LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS
          .lite_execution_learning_links?.uniqueKeys,
        [["tenant_id", "learning_scope", "learning_event_id"]],
      );
    } finally {
      firstDb.close();
    }

    const reopened = createLiteWriteStore(temp.path, {
      annProjectionEnabled: false,
    });
    await reopened.close();

    const secondDb = createSqliteDatabase(temp.path);
    try {
      assert.deepEqual(requiredV7ObjectSnapshot(secondDb), firstObjects);
      assert.deepEqual(schemaMetadata(secondDb), firstMetadata);
      assert.equal(inspectLiteRuntimeSchema(secondDb).classification, "current");
    } finally {
      secondDb.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("an exact v6 database upgrades through v7 without changing preexisting memory", async () => {
  const temp = tempDatabase("exact-v6-to-v7");
  try {
    await createCurrentDatabase(temp.path, { seedMemory: true });
    const beforeDb = createSqliteDatabase(temp.path);
    let beforeMemory:
      ReturnType<typeof preservedMemoryRow>;
    try {
      beforeMemory = preservedMemoryRow(beforeDb);
    } finally {
      beforeDb.close();
    }

    removeAllV7ObjectsAndDeclareV6(temp.path);
    assertExactV6(temp.path);

    const migrated = createLiteWriteStore(temp.path, {
      annProjectionEnabled: false,
    });
    await migrated.close();

    const afterDb = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(afterDb);
      assert.equal(report.classification, "current", JSON.stringify(report));
      assert.equal(report.detected_version, 9);
      assert.equal(report.upgrade_required, false);
      assert.deepEqual(preservedMemoryRow(afterDb), beforeMemory);
      assert.equal(
        requiredV7ObjectSnapshot(afterDb).length,
        requiredV7ObjectNames().size,
      );
    } finally {
      afterDb.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v6 metadata with a partial v7 structure fails closed during preflight", async () => {
  const temp = tempDatabase("partial-v7");
  try {
    await createCurrentDatabase(temp.path);
    removeAllV7ObjectsAndDeclareV6(temp.path);

    const db = createSqliteDatabase(temp.path);
    try {
      const firstTable =
        LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS
          .lite_runtime_evidence_blobs;
      assert.ok(firstTable);
      db.exec(firstTable.sql);
      const report = inspectLiteRuntimeSchema(db);
      assert.equal(report.classification, "incompatible");
      assert.equal(report.detected_version, 6);
      assert.ok(
        report.problems.includes(
          "schema metadata is older than v7 but v7 execution-episode objects already exist",
        ),
        JSON.stringify(report),
      );
    } finally {
      db.close();
    }

    assert.throws(
      () => createLiteWriteStore(temp.path, { annProjectionEnabled: false }),
      /lite_runtime_schema_preflight_failed/,
    );
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("a v7 migration fault rolls DDL and metadata back to an exact v6 database", async () => {
  const temp = tempDatabase("v7-rollback");
  try {
    await createCurrentDatabase(temp.path, { seedMemory: true });
    removeAllV7ObjectsAndDeclareV6(temp.path);
    assertExactV6(temp.path);

    assert.throws(
      () => createLiteWriteStore(temp.path, {
        annProjectionEnabled: false,
        schemaMigrationFaultInjector: (phase) => {
          if (phase === "after_execution_episode_structures") {
            throw new Error("intentional_v7_migration_fault");
          }
        },
      }),
      /intentional_v7_migration_fault/,
    );

    const rolledBackDb = createSqliteDatabase(temp.path);
    try {
      const report = inspectLiteRuntimeSchema(rolledBackDb);
      assert.equal(report.classification, "supported_previous_v6", JSON.stringify(report));
      assert.equal(schemaMetadata(rolledBackDb).version, 6);
      assert.deepEqual(requiredV7ObjectSnapshot(rolledBackDb), []);
      assert.equal(preservedMemoryRow(rolledBackDb).id, MEMORY_NODE_ID);
    } finally {
      rolledBackDb.close();
    }

    const recovered = createLiteWriteStore(temp.path, {
      annProjectionEnabled: false,
    });
    await recovered.close();
    const recoveredDb = createSqliteDatabase(temp.path);
    try {
      assert.equal(inspectLiteRuntimeSchema(recoveredDb).classification, "current");
      assert.equal(schemaMetadata(recoveredDb).version, 9);
      assert.equal(preservedMemoryRow(recoveredDb).id, MEMORY_NODE_ID);
    } finally {
      recoveredDb.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});
