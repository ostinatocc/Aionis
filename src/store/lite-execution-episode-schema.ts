import { readFileSync } from "node:fs";

import type { SqliteDatabase } from "./sqlite.js";
import { normalizeSqliteSchemaSql } from "./sqlite-schema-sql.js";

export const LITE_EXECUTION_EPISODE_V7_SCHEMA_SQL = readFileSync(
  new URL("./sql/lite-execution-episode-v7.sql", import.meta.url),
  "utf8",
).trim();

type ParsedTable = Readonly<{
  name: string;
  body: string;
  statement: string;
}>;

function findClosingParenthesis(sql: string, openingOffset: number): number {
  let depth = 0;
  let inString = false;
  for (let index = openingOffset; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'") {
      if (inString && sql[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unterminated CREATE TABLE statement in execution-episode v7 DDL");
}

function parseTables(sql: string): ParsedTable[] {
  const out: ParsedTable[] = [];
  const matcher = /CREATE TABLE\s+([a-z0-9_]+)\s*\(/giu;
  for (let match = matcher.exec(sql); match; match = matcher.exec(sql)) {
    const name = match[1];
    if (!name) continue;
    const openingOffset = matcher.lastIndex - 1;
    const closingOffset = findClosingParenthesis(sql, openingOffset);
    const semicolonOffset = sql.indexOf(";", closingOffset);
    if (semicolonOffset < 0) {
      throw new Error(`Missing semicolon after CREATE TABLE ${name}`);
    }
    out.push(Object.freeze({
      name,
      body: sql.slice(openingOffset + 1, closingOffset),
      statement: sql.slice(match.index, semicolonOffset + 1),
    }));
    matcher.lastIndex = semicolonOffset + 1;
  }
  return out;
}

function splitTopLevelSqlList(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'") {
      if (inString && value[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      out.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function parseIdentifierList(value: string): string[] {
  const match = value.match(/\(([\s\S]*)\)/u);
  if (!match?.[1]) return [];
  return splitTopLevelSqlList(match[1]).map((entry) => {
    const identifier = entry.trim().match(/^([a-z_][a-z0-9_]*)/iu)?.[1];
    if (!identifier) {
      throw new Error(`Unsupported SQL identifier in v7 constraint: ${entry}`);
    }
    return identifier;
  });
}

export type LiteExecutionEpisodeRequiredTableConstraint = Readonly<{
  primaryKey: readonly string[];
  uniqueKeys: ReadonlyArray<readonly string[]>;
  sql: string;
}>;

export function parseTableRequirements(sql: string): Readonly<{
  columns: Record<string, readonly string[]>;
  constraints: Record<string, LiteExecutionEpisodeRequiredTableConstraint>;
}> {
  const columns: Record<string, readonly string[]> = {};
  const constraints: Record<string, LiteExecutionEpisodeRequiredTableConstraint> = {};
  for (const table of parseTables(sql)) {
    const tableColumns: string[] = [];
    let primaryKey: string[] = [];
    const uniqueKeys: string[][] = [];
    for (const entry of splitTopLevelSqlList(table.body)) {
      const normalized = entry.trim();
      const upper = normalized.toUpperCase();
      if (upper.startsWith("PRIMARY KEY")) {
        primaryKey = parseIdentifierList(normalized);
        continue;
      }
      if (upper.startsWith("UNIQUE")) {
        uniqueKeys.push(parseIdentifierList(normalized));
        continue;
      }
      if (
        upper.startsWith("CHECK")
        || upper.startsWith("FOREIGN KEY")
        || upper.startsWith("CONSTRAINT")
      ) {
        continue;
      }
      const column = normalized.match(/^([a-z_][a-z0-9_]*)\b/iu)?.[1];
      if (!column) {
        throw new Error(`Unsupported v7 column definition in ${table.name}: ${entry}`);
      }
      tableColumns.push(column);
      if (/\bPRIMARY\s+KEY\b/iu.test(normalized)) primaryKey = [column];
      if (/\bUNIQUE\b/iu.test(normalized)) uniqueKeys.push([column]);
    }
    columns[table.name] = Object.freeze(tableColumns);
    constraints[table.name] = Object.freeze({
      primaryKey: Object.freeze(primaryKey),
      uniqueKeys: Object.freeze(uniqueKeys.map((key) => Object.freeze(key))),
      sql: table.statement,
    });
  }
  return Object.freeze({ columns, constraints });
}

export type LiteExecutionEpisodeRequiredIndex = Readonly<{
  table: string;
  columns: ReadonlyArray<Readonly<{ name: string; descending?: boolean }>>;
  unique: boolean;
  partial: boolean;
  predicate?: string;
  sql: string;
}>;

export function parseIndexes(
  sql: string,
): Record<string, LiteExecutionEpisodeRequiredIndex> {
  const out: Record<string, LiteExecutionEpisodeRequiredIndex> = {};
  const matcher =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+([a-z0-9_]+)\s+ON\s+([a-z0-9_]+)\s*\(([^)]*)\)\s*(?:WHERE\s+([\s\S]*?))?;/giu;
  for (let match = matcher.exec(sql); match; match = matcher.exec(sql)) {
    const [, uniqueKeyword, name, table, rawColumns, rawPredicate] = match;
    if (!name || !table || rawColumns === undefined) continue;
    const columns = splitTopLevelSqlList(rawColumns).map((entry) => {
      const parsed = entry.trim().match(
        /^([a-z_][a-z0-9_]*)(?:\s+(ASC|DESC))?$/iu,
      );
      if (!parsed?.[1]) throw new Error(`Unsupported v7 index column: ${entry}`);
      return Object.freeze({
        name: parsed[1],
        ...(parsed[2]?.toUpperCase() === "DESC" ? { descending: true } : {}),
      });
    });
    const predicate = rawPredicate
      ? normalizeSqliteSchemaSql(rawPredicate)
      : undefined;
    out[name] = Object.freeze({
      table,
      columns: Object.freeze(columns),
      unique: uniqueKeyword !== undefined,
      partial: predicate !== undefined,
      ...(predicate ? { predicate } : {}),
      sql: match[0],
    });
  }
  return out;
}

export type LiteExecutionEpisodeRequiredTrigger = Readonly<{
  table: string;
  sql: string;
}>;

export function parseTriggers(
  sql: string,
): Record<string, LiteExecutionEpisodeRequiredTrigger> {
  const out: Record<string, LiteExecutionEpisodeRequiredTrigger> = {};
  const matcher =
    /CREATE TRIGGER\s+([a-z0-9_]+)[\s\S]*?\bON\s+([a-z0-9_]+)[\s\S]*?END;/giu;
  for (let match = matcher.exec(sql); match; match = matcher.exec(sql)) {
    const [, name, table] = match;
    if (name && table) {
      out[name] = Object.freeze({ table, sql: match[0] });
    }
  }
  return out;
}

const PARSED_REQUIREMENTS = parseTableRequirements(
  LITE_EXECUTION_EPISODE_V7_SCHEMA_SQL,
);

export const LITE_EXECUTION_EPISODE_V7_REQUIRED_COLUMNS = Object.freeze(
  PARSED_REQUIREMENTS.columns,
);

export const LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS = Object.freeze(
  PARSED_REQUIREMENTS.constraints,
);

export const LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEXES = Object.freeze(
  parseIndexes(LITE_EXECUTION_EPISODE_V7_SCHEMA_SQL),
);

export const LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGERS = Object.freeze(
  parseTriggers(LITE_EXECUTION_EPISODE_V7_SCHEMA_SQL),
);

export const LITE_EXECUTION_EPISODE_V7_REQUIRED_TABLE_NAMES = Object.freeze(
  Object.keys(LITE_EXECUTION_EPISODE_V7_REQUIRED_COLUMNS).sort(),
);

export const LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEX_NAMES = Object.freeze(
  Object.keys(LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEXES).sort(),
);

export const LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGER_NAMES = Object.freeze(
  Object.keys(LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGERS).sort(),
);

export type RequiredSchemaObject = Readonly<{
  type: "table" | "index" | "trigger";
  name: string;
  table: string;
  sql: string;
}>;

function requiredSchemaObjects(): RequiredSchemaObject[] {
  return [
    ...Object.entries(LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS).map(
      ([name, requirement]) => ({
        type: "table" as const,
        name,
        table: name,
        sql: requirement.sql,
      }),
    ),
    ...Object.entries(LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEXES).map(
      ([name, requirement]) => ({
        type: "index" as const,
        name,
        table: requirement.table,
        sql: requirement.sql,
      }),
    ),
    ...Object.entries(LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGERS).map(
      ([name, requirement]) => ({
        type: "trigger" as const,
        name,
        table: requirement.table,
        sql: requirement.sql,
      }),
    ),
  ];
}

export function inspectSchemaObjects(
  db: SqliteDatabase,
  requirements: readonly RequiredSchemaObject[],
): Readonly<{ existing: number; problems: readonly string[] }> {
  const statement = db.prepare(
    `SELECT type, tbl_name AS table_name, sql
     FROM sqlite_schema
     WHERE name = ?`,
  );
  let existing = 0;
  const problems: string[] = [];
  for (const requirement of requirements) {
    const row = statement.get(requirement.name) as {
      type: string;
      table_name: string;
      sql: string | null;
    } | undefined;
    if (!row) {
      problems.push(`missing ${requirement.type} ${requirement.name}`);
      continue;
    }
    existing += 1;
    if (
      row.type !== requirement.type
      || row.table_name !== requirement.table
    ) {
      problems.push(
        `${requirement.type} ${requirement.name} is bound to the wrong object`,
      );
      continue;
    }
    if (
      row.sql === null
      || normalizeSqliteSchemaSql(row.sql)
        !== normalizeSqliteSchemaSql(requirement.sql)
    ) {
      problems.push(`${requirement.type} ${requirement.name} definition mismatch`);
    }
  }
  return Object.freeze({ existing, problems: Object.freeze(problems) });
}

export function assertLiteExecutionEpisodeV7SchemaIntegrity(
  db: SqliteDatabase,
): void {
  const inspected = inspectSchemaObjects(db, requiredSchemaObjects());
  if (inspected.problems.length > 0) {
    throw new Error(
      `lite_execution_episode_v7_schema_integrity_failed:${JSON.stringify(
        inspected.problems,
      )}`,
    );
  }
}

export function migrateLiteExecutionEpisodeV7(db: SqliteDatabase): void {
  const requirements = requiredSchemaObjects();
  const before = inspectSchemaObjects(db, requirements);
  if (before.existing === requirements.length) {
    if (before.problems.length > 0) {
      throw new Error(
        `lite_execution_episode_v7_schema_conflict:${JSON.stringify(
          before.problems,
        )}`,
      );
    }
    return;
  }
  if (before.existing !== 0) {
    throw new Error(
      `lite_execution_episode_v7_schema_partial:${JSON.stringify(
        before.problems,
      )}`,
    );
  }

  db.exec("SAVEPOINT lite_execution_episode_v7_migration");
  try {
    db.exec(LITE_EXECUTION_EPISODE_V7_SCHEMA_SQL);
    assertLiteExecutionEpisodeV7SchemaIntegrity(db);
    db.exec("RELEASE SAVEPOINT lite_execution_episode_v7_migration");
  } catch (error) {
    try {
      db.exec("ROLLBACK TO SAVEPOINT lite_execution_episode_v7_migration");
      db.exec("RELEASE SAVEPOINT lite_execution_episode_v7_migration");
    } catch {
      // Preserve the migration failure; the outer Runtime transaction remains
      // responsible for final rollback if the connection itself has failed.
    }
    throw error;
  }
}
