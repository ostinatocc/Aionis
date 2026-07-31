import { readFileSync } from "node:fs";

import type { SqliteDatabase } from "./sqlite.js";
import {
  inspectSchemaObjects,
  parseIndexes,
  parseTableRequirements,
  parseTriggers,
  type RequiredSchemaObject,
} from "./lite-execution-episode-schema.js";

export const LITE_EXECUTION_VERIFIER_LAUNCH_V8_SCHEMA_SQL = readFileSync(
  new URL("./sql/lite-execution-verifier-launch-v8.sql", import.meta.url),
  "utf8",
).trim();

const PARSED_REQUIREMENTS = parseTableRequirements(
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_SCHEMA_SQL,
);

export const LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_COLUMNS =
  Object.freeze(PARSED_REQUIREMENTS.columns);

export const LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_CONSTRAINTS =
  Object.freeze(PARSED_REQUIREMENTS.constraints);

export const LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_INDEXES =
  Object.freeze(parseIndexes(LITE_EXECUTION_VERIFIER_LAUNCH_V8_SCHEMA_SQL));

export const LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TRIGGERS =
  Object.freeze(parseTriggers(LITE_EXECUTION_VERIFIER_LAUNCH_V8_SCHEMA_SQL));

export const LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TABLE_NAMES =
  Object.freeze(
    Object.keys(
      LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_COLUMNS,
    ).sort(),
  );

export const LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_INDEX_NAMES =
  Object.freeze(
    Object.keys(
      LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_INDEXES,
    ).sort(),
  );

export const LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TRIGGER_NAMES =
  Object.freeze(
    Object.keys(
      LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TRIGGERS,
    ).sort(),
  );

function requiredSchemaObjects(): RequiredSchemaObject[] {
  return [
    ...Object.entries(
      LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_CONSTRAINTS,
    ).map(([name, requirement]) => ({
      type: "table" as const,
      name,
      table: name,
      sql: requirement.sql,
    })),
    ...Object.entries(
      LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_INDEXES,
    ).map(([name, requirement]) => ({
      type: "index" as const,
      name,
      table: requirement.table,
      sql: requirement.sql,
    })),
    ...Object.entries(
      LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TRIGGERS,
    ).map(([name, requirement]) => ({
      type: "trigger" as const,
      name,
      table: requirement.table,
      sql: requirement.sql,
    })),
  ];
}

export function assertLiteExecutionVerifierLaunchV8SchemaIntegrity(
  db: SqliteDatabase,
): void {
  const inspected = inspectSchemaObjects(db, requiredSchemaObjects());
  if (inspected.problems.length > 0) {
    throw new Error(
      `lite_execution_verifier_launch_v8_schema_integrity_failed:${JSON.stringify(
        inspected.problems,
      )}`,
    );
  }
}

export function migrateLiteExecutionVerifierLaunchV8(
  db: SqliteDatabase,
): void {
  const requirements = requiredSchemaObjects();
  const before = inspectSchemaObjects(db, requirements);
  if (before.existing === requirements.length) {
    if (before.problems.length > 0) {
      throw new Error(
        `lite_execution_verifier_launch_v8_schema_conflict:${JSON.stringify(
          before.problems,
        )}`,
      );
    }
    return;
  }
  if (before.existing !== 0) {
    throw new Error(
      `lite_execution_verifier_launch_v8_schema_partial:${JSON.stringify(
        before.problems,
      )}`,
    );
  }

  db.exec("SAVEPOINT lite_execution_verifier_launch_v8_migration");
  try {
    db.exec(LITE_EXECUTION_VERIFIER_LAUNCH_V8_SCHEMA_SQL);
    assertLiteExecutionVerifierLaunchV8SchemaIntegrity(db);
    db.exec("RELEASE SAVEPOINT lite_execution_verifier_launch_v8_migration");
  } catch (error) {
    try {
      db.exec(
        "ROLLBACK TO SAVEPOINT lite_execution_verifier_launch_v8_migration",
      );
      db.exec("RELEASE SAVEPOINT lite_execution_verifier_launch_v8_migration");
    } catch {
      // Preserve the first migration failure.
    }
    throw error;
  }
}
