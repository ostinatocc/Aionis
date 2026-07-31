import { readFileSync } from "node:fs";

import type { SqliteDatabase } from "./sqlite.js";
import {
  LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEXES,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGERS,
  inspectSchemaObjects,
  parseTableRequirements,
  type RequiredSchemaObject,
} from "./lite-execution-episode-schema.js";
import { normalizeSqliteSchemaSql } from "./sqlite-schema-sql.js";

const EVENT_TABLE = "lite_execution_episode_events";
const BACKUP_EVENT_TABLE = "lite_execution_episode_events_v9_backup";

export const LITE_EXECUTION_SEMANTIC_EVENTS_V9_SCHEMA_SQL = readFileSync(
  new URL("./sql/lite-execution-semantic-events-v9.sql", import.meta.url),
  "utf8",
).trim();

const PARSED_REQUIREMENTS = parseTableRequirements(
  LITE_EXECUTION_SEMANTIC_EVENTS_V9_SCHEMA_SQL,
);

const EVENT_TABLE_COLUMNS = PARSED_REQUIREMENTS.columns[EVENT_TABLE];
const EVENT_TABLE_CONSTRAINT = PARSED_REQUIREMENTS.constraints[EVENT_TABLE];
if (!EVENT_TABLE_COLUMNS || !EVENT_TABLE_CONSTRAINT) {
  throw new Error("lite_execution_semantic_events_v9_contract_missing");
}

export const LITE_EXECUTION_SEMANTIC_EVENTS_V9_REQUIRED_COLUMNS =
  Object.freeze({
    [EVENT_TABLE]: EVENT_TABLE_COLUMNS,
  });

export const LITE_EXECUTION_SEMANTIC_EVENTS_V9_REQUIRED_CONSTRAINTS =
  Object.freeze({
    [EVENT_TABLE]: EVENT_TABLE_CONSTRAINT,
  });

const EVENT_INDEXES = Object.fromEntries(
  Object.entries(LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEXES).filter(
    ([, requirement]) => requirement.table === EVENT_TABLE,
  ),
);

const EVENT_TRIGGERS = Object.fromEntries(
  Object.entries(LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGERS).filter(
    ([, requirement]) => requirement.table === EVENT_TABLE,
  ),
);

function requiredSchemaObjects(): RequiredSchemaObject[] {
  return [
    {
      type: "table",
      name: EVENT_TABLE,
      table: EVENT_TABLE,
      sql: EVENT_TABLE_CONSTRAINT.sql,
    },
    ...Object.entries(EVENT_INDEXES).map(([name, requirement]) => ({
      type: "index" as const,
      name,
      table: requirement.table,
      sql: requirement.sql,
    })),
    ...Object.entries(EVENT_TRIGGERS).map(([name, requirement]) => ({
      type: "trigger" as const,
      name,
      table: requirement.table,
      sql: requirement.sql,
    })),
  ];
}

function existingEventTableSql(db: SqliteDatabase): string | null {
  const row = db.prepare(
    `SELECT sql
     FROM sqlite_schema
     WHERE type = 'table' AND name = ?`,
  ).get(EVENT_TABLE) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function eventDependentTriggers(
  db: SqliteDatabase,
): ReadonlyArray<Readonly<{ name: string; sql: string }>> {
  return (db.prepare(
    `SELECT name, sql
     FROM sqlite_schema
     WHERE type = 'trigger'
       AND instr(lower(sql), lower(?)) > 0
     ORDER BY name`,
  ).all(EVENT_TABLE) as Array<{ name: string; sql: string | null }>)
    .map((row) => {
      if (row.sql === null) {
        throw new Error(
          `lite_execution_semantic_events_v9_trigger_sql_missing:${row.name}`,
        );
      }
      return Object.freeze({ name: row.name, sql: row.sql });
    });
}

function assertForeignKeysValid(db: SqliteDatabase): void {
  const rows = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
  if (rows.length > 0) {
    throw new Error(
      `lite_execution_semantic_events_v9_foreign_key_failure:${JSON.stringify(
        rows,
      )}`,
    );
  }
}

export function assertLiteExecutionSemanticEventsV9SchemaIntegrity(
  db: SqliteDatabase,
): void {
  const inspected = inspectSchemaObjects(db, requiredSchemaObjects());
  if (inspected.problems.length > 0) {
    throw new Error(
      `lite_execution_semantic_events_v9_schema_integrity_failed:${JSON.stringify(
        inspected.problems,
      )}`,
    );
  }
  assertForeignKeysValid(db);
}

export function migrateLiteExecutionSemanticEventsV9(
  db: SqliteDatabase,
): void {
  const currentSql = existingEventTableSql(db);
  if (currentSql === null) {
    throw new Error("lite_execution_semantic_events_v9_source_missing");
  }
  if (
    normalizeSqliteSchemaSql(currentSql)
    === normalizeSqliteSchemaSql(EVENT_TABLE_CONSTRAINT.sql)
  ) {
    assertLiteExecutionSemanticEventsV9SchemaIntegrity(db);
    return;
  }

  const v7EventConstraint =
    LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS[EVENT_TABLE];
  if (
    !v7EventConstraint
    || normalizeSqliteSchemaSql(currentSql)
      !== normalizeSqliteSchemaSql(v7EventConstraint.sql)
  ) {
    throw new Error("lite_execution_semantic_events_v9_source_conflict");
  }

  const columns = EVENT_TABLE_COLUMNS.join(", ");
  const dependentTriggers = eventDependentTriggers(db);
  db.exec("SAVEPOINT lite_execution_semantic_events_v9_migration");
  try {
    db.exec("PRAGMA defer_foreign_keys = ON");
    db.exec(
      `CREATE TEMP TABLE ${BACKUP_EVENT_TABLE}
       AS SELECT ${columns}
       FROM ${EVENT_TABLE}
       ORDER BY row_id`,
    );
    for (const trigger of dependentTriggers) {
      db.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
    }
    db.exec(`DROP TABLE ${EVENT_TABLE}`);
    db.exec(EVENT_TABLE_CONSTRAINT.sql);
    db.exec(
      `INSERT INTO ${EVENT_TABLE} (${columns})
       SELECT ${columns}
       FROM ${BACKUP_EVENT_TABLE}
       ORDER BY row_id`,
    );
    db.exec(`DROP TABLE ${BACKUP_EVENT_TABLE}`);
    for (const requirement of Object.values(EVENT_INDEXES)) {
      db.exec(requirement.sql);
    }
    for (const trigger of dependentTriggers) {
      db.exec(trigger.sql);
    }
    assertLiteExecutionSemanticEventsV9SchemaIntegrity(db);
    db.exec("RELEASE SAVEPOINT lite_execution_semantic_events_v9_migration");
  } catch (error) {
    try {
      db.exec(
        "ROLLBACK TO SAVEPOINT lite_execution_semantic_events_v9_migration",
      );
      db.exec(
        "RELEASE SAVEPOINT lite_execution_semantic_events_v9_migration",
      );
    } catch {
      // Preserve the migration failure. The outer Runtime transaction owns
      // the final rollback if SQLite cannot restore the local savepoint.
    }
    throw error;
  }
}
