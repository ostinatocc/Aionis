import { readFileSync } from "node:fs";

import type { SqliteDatabase } from "./sqlite.js";
import {
  inspectSchemaObjects,
  parseIndexes,
  parseTableRequirements,
  parseTriggers,
  type RequiredSchemaObject,
} from "./lite-execution-episode-schema.js";

export const LITE_EXECUTION_SESSION_V10_SCHEMA_SQL = readFileSync(
  new URL("./sql/lite-execution-session-v10.sql", import.meta.url),
  "utf8",
).trim();

const PARSED_REQUIREMENTS = parseTableRequirements(
  LITE_EXECUTION_SESSION_V10_SCHEMA_SQL,
);

export const LITE_EXECUTION_SESSION_V10_REQUIRED_COLUMNS = Object.freeze(
  PARSED_REQUIREMENTS.columns,
);

export const LITE_EXECUTION_SESSION_V10_REQUIRED_CONSTRAINTS = Object.freeze(
  PARSED_REQUIREMENTS.constraints,
);

export const LITE_EXECUTION_SESSION_V10_REQUIRED_INDEXES = Object.freeze(
  parseIndexes(LITE_EXECUTION_SESSION_V10_SCHEMA_SQL),
);

export const LITE_EXECUTION_SESSION_V10_REQUIRED_TRIGGERS = Object.freeze(
  parseTriggers(LITE_EXECUTION_SESSION_V10_SCHEMA_SQL),
);

function requiredSchemaObjects(): RequiredSchemaObject[] {
  return [
    ...Object.entries(
      LITE_EXECUTION_SESSION_V10_REQUIRED_CONSTRAINTS,
    ).map(([name, requirement]) => ({
      type: "table" as const,
      name,
      table: name,
      sql: requirement.sql,
    })),
    ...Object.entries(
      LITE_EXECUTION_SESSION_V10_REQUIRED_INDEXES,
    ).map(([name, requirement]) => ({
      type: "index" as const,
      name,
      table: requirement.table,
      sql: requirement.sql,
    })),
    ...Object.entries(
      LITE_EXECUTION_SESSION_V10_REQUIRED_TRIGGERS,
    ).map(([name, requirement]) => ({
      type: "trigger" as const,
      name,
      table: requirement.table,
      sql: requirement.sql,
    })),
  ];
}

export function assertLiteExecutionSessionV10SchemaIntegrity(
  db: SqliteDatabase,
): void {
  const inspected = inspectSchemaObjects(db, requiredSchemaObjects());
  if (inspected.problems.length > 0) {
    throw new Error(
      `lite_execution_session_v10_schema_integrity_failed:${JSON.stringify(
        inspected.problems,
      )}`,
    );
  }
  const foreignKeyFailures = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length > 0) {
    throw new Error(
      `lite_execution_session_v10_foreign_key_failure:${JSON.stringify(
        foreignKeyFailures,
      )}`,
    );
  }
}

export function migrateLiteExecutionSessionV10(
  db: SqliteDatabase,
): void {
  const requirements = requiredSchemaObjects();
  const before = inspectSchemaObjects(db, requirements);
  if (before.existing === requirements.length) {
    if (before.problems.length > 0) {
      throw new Error(
        `lite_execution_session_v10_schema_conflict:${JSON.stringify(
          before.problems,
        )}`,
      );
    }
    assertLiteExecutionSessionV10SchemaIntegrity(db);
    return;
  }
  if (before.existing !== 0) {
    throw new Error(
      `lite_execution_session_v10_schema_partial:${JSON.stringify(
        before.problems,
      )}`,
    );
  }

  db.exec("SAVEPOINT lite_execution_session_v10_migration");
  try {
    db.exec(LITE_EXECUTION_SESSION_V10_SCHEMA_SQL);
    assertLiteExecutionSessionV10SchemaIntegrity(db);
    db.exec("RELEASE SAVEPOINT lite_execution_session_v10_migration");
  } catch (error) {
    try {
      db.exec("ROLLBACK TO SAVEPOINT lite_execution_session_v10_migration");
      db.exec("RELEASE SAVEPOINT lite_execution_session_v10_migration");
    } catch {
      // Preserve the migration failure. The owning Runtime transaction is
      // responsible for final rollback when SQLite cannot restore a savepoint.
    }
    throw error;
  }
}
