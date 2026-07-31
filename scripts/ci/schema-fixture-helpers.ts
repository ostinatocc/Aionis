import {
  LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEXES,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEX_NAMES,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_TABLE_NAMES,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGER_NAMES,
} from "../../src/store/lite-execution-episode-schema.ts";
import {
  LITE_EXECUTION_SEMANTIC_EVENTS_V9_REQUIRED_CONSTRAINTS,
} from "../../src/store/lite-execution-semantic-event-schema.ts";
import { normalizeSqliteSchemaSql } from
  "../../src/store/sqlite-schema-sql.ts";
import {
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_INDEX_NAMES,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TABLE_NAMES,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TRIGGER_NAMES,
} from "../../src/store/lite-execution-verifier-launch-schema.ts";
import type { SqliteDatabase } from "../../src/store/sqlite.ts";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const EXECUTION_EVENT_TABLE = "lite_execution_episode_events";
const EXECUTION_EVENT_BACKUP =
  "lite_execution_episode_events_previous_schema_fixture";

/**
 * Reconstructs the exact pre-v9 event-table definition while preserving all
 * existing pre-v9 rows and every trigger that references the table. Fixtures
 * fail rather than silently discarding a semantic event.
 */
export function restoreExecutionSemanticEventsV8ForPreviousSchemaFixture(
  db: SqliteDatabase,
): void {
  const current = db.prepare(
    `SELECT sql
     FROM sqlite_schema
     WHERE type = 'table' AND name = ?`,
  ).get(EXECUTION_EVENT_TABLE) as { sql: string | null } | undefined;
  const v7 =
    LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS[EXECUTION_EVENT_TABLE];
  const v9 =
    LITE_EXECUTION_SEMANTIC_EVENTS_V9_REQUIRED_CONSTRAINTS[
      EXECUTION_EVENT_TABLE
    ];
  if (!current?.sql || !v7 || !v9) {
    throw new Error("execution_event_previous_schema_fixture_missing");
  }
  if (
    normalizeSqliteSchemaSql(current.sql)
    === normalizeSqliteSchemaSql(v7.sql)
  ) {
    return;
  }
  if (
    normalizeSqliteSchemaSql(current.sql)
    !== normalizeSqliteSchemaSql(v9.sql)
  ) {
    throw new Error("execution_event_previous_schema_fixture_conflict");
  }
  const semanticCount = (
    db.prepare(
      `SELECT count(*) AS count
       FROM lite_execution_episode_events
       WHERE event_kind IN (
         'semantic_observation_recorded', 'agent_decision_recorded',
         'progress_state_recorded', 'planned_action_recorded'
       )`,
    ).get() as { count: number }
  ).count;
  if (semanticCount !== 0) {
    throw new Error(
      "execution_event_previous_schema_fixture_semantic_rows_present",
    );
  }
  const eventColumns = (
    db.prepare(
      `SELECT name
       FROM pragma_table_info(?)
       ORDER BY cid`,
    ).all(EXECUTION_EVENT_TABLE) as Array<{ name: string }>
  ).map((row) => row.name);
  if (eventColumns.length === 0) {
    throw new Error("execution_event_previous_schema_fixture_columns_missing");
  }
  const columnSql = eventColumns.map(quoteIdentifier).join(", ");
  const triggers = (
    db.prepare(
      `SELECT name, sql
       FROM sqlite_schema
       WHERE type = 'trigger'
         AND instr(lower(sql), lower(?)) > 0
       ORDER BY name`,
    ).all(EXECUTION_EVENT_TABLE) as Array<{
      name: string;
      sql: string | null;
    }>
  ).map((row) => {
    if (row.sql === null) {
      throw new Error(
        `execution_event_previous_schema_fixture_trigger_missing:${row.name}`,
      );
    }
    return { name: row.name, sql: row.sql };
  });

  db.exec(
    `CREATE TEMP TABLE ${EXECUTION_EVENT_BACKUP}
     AS SELECT ${columnSql}
     FROM ${EXECUTION_EVENT_TABLE}
     ORDER BY row_id`,
  );
  for (const trigger of triggers) {
    db.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
  }
  db.exec(`DROP TABLE ${EXECUTION_EVENT_TABLE}`);
  db.exec(v7.sql);
  db.exec(
    `INSERT INTO ${EXECUTION_EVENT_TABLE} (${columnSql})
     SELECT ${columnSql}
     FROM ${EXECUTION_EVENT_BACKUP}
     ORDER BY row_id`,
  );
  db.exec(`DROP TABLE ${EXECUTION_EVENT_BACKUP}`);
  for (
    const requirement of Object.values(
      LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEXES,
    ).filter((value) => value.table === EXECUTION_EVENT_TABLE)
  ) {
    db.exec(requirement.sql);
  }
  for (const trigger of triggers) db.exec(trigger.sql);
}

/**
 * Reconstructs the exact v7 boundary from a freshly initialized v8 Runtime.
 * The v8 triggers are removed first because one of them is attached to the
 * v7 evidence-artifact table.
 */
export function removeExecutionVerifierLaunchV8ObjectsForPreviousSchemaFixture(
  db: SqliteDatabase,
): void {
  restoreExecutionSemanticEventsV8ForPreviousSchemaFixture(db);
  for (
    const trigger of
      [...LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TRIGGER_NAMES].reverse()
  ) {
    db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger)}`);
  }
  for (
    const index of
      [...LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_INDEX_NAMES].reverse()
  ) {
    db.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(index)}`);
  }
  for (
    const table of
      [...LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TABLE_NAMES].reverse()
  ) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
  }
}

/**
 * Tests that reconstruct a pre-v7 database from a freshly initialized
 * Runtime must remove the complete v7 contract before lowering metadata.
 * Leaving even one v7 object behind is intentionally rejected by preflight.
 *
 * Call this inside the fixture's existing migration transaction.
 */
export function removeExecutionEpisodeV7ObjectsForPreviousSchemaFixture(
  db: SqliteDatabase,
): void {
  removeExecutionVerifierLaunchV8ObjectsForPreviousSchemaFixture(db);
  for (
    const trigger of [...LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGER_NAMES]
      .reverse()
  ) {
    db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger)}`);
  }
  for (
    const index of [...LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEX_NAMES]
      .reverse()
  ) {
    db.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(index)}`);
  }
  for (
    const table of [...LITE_EXECUTION_EPISODE_V7_REQUIRED_TABLE_NAMES]
      .reverse()
  ) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
  }
}
