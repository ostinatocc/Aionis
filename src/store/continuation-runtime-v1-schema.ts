import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { sha256Hex } from "../util/crypto.js";
import { stableJson } from "../util/stable-json.js";
import { normalizeSqliteSchemaSql } from "./sqlite-schema-sql.js";
import type { SqliteDatabase } from "./sqlite.js";

export const CONTINUATION_RUNTIME_V1_APPLICATION_ID = 0x41494f4e;
export const CONTINUATION_RUNTIME_V1_USER_VERSION = 1;
export const CONTINUATION_RUNTIME_V1_SCHEMA_MANIFEST_VERSION =
  "aionis_continuation_runtime_v1_schema_manifest_v1" as const;

export const CONTINUATION_RUNTIME_V1_TABLES = Object.freeze([
  "authority_artifacts",
  "authority_heads",
  "branch_capsule_bindings",
  "branch_revisions",
  "capsule_revisions",
  "durable_jobs",
  "effect_certificate_treatment_members",
  "effect_certificates",
  "episode_capsule_facts",
  "episode_events",
  "memory_commits",
  "memory_items",
  "memory_relations",
  "memory_scope_heads",
  "observation_snapshots",
  "operations",
  "runtime_meta",
] as const);

export const CONTINUATION_RUNTIME_V1_DDL_PATH = fileURLToPath(
  new URL("./sql/continuation-runtime-v1.sql", import.meta.url),
);
export const CONTINUATION_RUNTIME_V1_MANIFEST_PATH = fileURLToPath(
  new URL("./sql/continuation-runtime-v1.manifest.json", import.meta.url),
);

const safeIntegerSchema = z.number().int().safe();
const nonNegativeIntegerSchema = safeIntegerSchema.nonnegative();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const sqliteSchemaRowSchema = z.object({
  type: z.enum(["index", "table", "trigger", "view"]),
  name: z.string().min(1),
  table_name: z.string().min(1),
  sql_sha256: sha256Schema.nullable(),
}).strict();

const tableXinfoEntrySchema = z.object({
  table_name: z.string().min(1),
  row_count: nonNegativeIntegerSchema,
  rows_sha256: sha256Schema,
}).strict();

const indexXinfoEntrySchema = z.object({
  index_name: z.string().min(1),
  row_count: nonNegativeIntegerSchema,
  rows_sha256: sha256Schema,
}).strict();

const foreignKeyListEntrySchema = z.object({
  table_name: z.string().min(1),
  row_count: nonNegativeIntegerSchema,
  rows_sha256: sha256Schema,
}).strict();

const continuationRuntimeV1SchemaManifestSchema = z.object({
  manifest_version: z.literal(CONTINUATION_RUNTIME_V1_SCHEMA_MANIFEST_VERSION),
  application_id: safeIntegerSchema,
  user_version: safeIntegerSchema,
  tables: z.array(z.string().min(1)),
  sqlite_schema: z.array(sqliteSchemaRowSchema),
  table_xinfo: z.array(tableXinfoEntrySchema),
  index_xinfo: z.array(indexXinfoEntrySchema),
  foreign_key_list: z.array(foreignKeyListEntrySchema),
  ddl_sha256: sha256Schema,
  schema_sha256: sha256Schema,
}).strict();

export type ContinuationRuntimeV1SchemaManifest = z.infer<
  typeof continuationRuntimeV1SchemaManifestSchema
>;

type ContinuationRuntimeV1SchemaSnapshot = Omit<
  ContinuationRuntimeV1SchemaManifest,
  "ddl_sha256" | "schema_sha256"
>;

type RawSqliteSchemaRow = {
  type: "index" | "table" | "trigger" | "view";
  name: string;
  table_name: string;
  sql: string | null;
};

function rowsDigest(rows: readonly unknown[]): { row_count: number; rows_sha256: string } {
  return { row_count: rows.length, rows_sha256: sha256Hex(stableJson(rows)) };
}

type RawTableXinfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: number;
  hidden: number;
};

type RawIndexXinfoRow = {
  seqno: number;
  cid: number;
  name: string | null;
  desc: 0 | 1;
  coll: string | null;
  key: 0 | 1;
};

type RawForeignKeyRow = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertSameStrings(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (!sameStrings(actual, expected)) {
    throw new Error(
      `continuation_runtime_v1_schema_manifest_invalid:${label}:expected=${expected.join(",")}:actual=${actual.join(",")}`,
    );
  }
}

function assertStrictlySortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareStrings(values[index - 1]!, values[index]!) >= 0) {
      throw new Error(
        `continuation_runtime_v1_schema_manifest_invalid:${label}_not_strictly_sorted_unique`,
      );
    }
  }
}

function pragmaRows<T>(db: SqliteDatabase, pragma: string, objectName: string): T[] {
  const escaped = objectName.replaceAll("'", "''");
  return db.prepare(`PRAGMA ${pragma}('${escaped}')`).all() as T[];
}

function pragmaSafeInteger(db: SqliteDatabase, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`continuation_runtime_v1_schema_pragma_invalid:${pragma}`);
  }
  return value as number;
}

function schemaSnapshotSha256(snapshot: ContinuationRuntimeV1SchemaSnapshot): string {
  return sha256Hex(stableJson(snapshot));
}

function snapshotWithoutSha256(
  manifest: ContinuationRuntimeV1SchemaManifest,
): ContinuationRuntimeV1SchemaSnapshot {
  const { schema_sha256: _schemaSha256, ddl_sha256: _ddlSha256, ...snapshot } = manifest;
  return snapshot;
}

function validateManifestRelations(manifest: ContinuationRuntimeV1SchemaManifest): void {
  if (manifest.application_id !== CONTINUATION_RUNTIME_V1_APPLICATION_ID) {
    throw new Error("continuation_runtime_v1_schema_manifest_invalid:application_id");
  }
  if (manifest.user_version !== CONTINUATION_RUNTIME_V1_USER_VERSION) {
    throw new Error("continuation_runtime_v1_schema_manifest_invalid:user_version");
  }
  assertSameStrings(manifest.tables, CONTINUATION_RUNTIME_V1_TABLES, "tables");

  const schemaKeys = manifest.sqlite_schema.map((row) => `${row.type}\u0000${row.name}`);
  assertStrictlySortedUnique(schemaKeys, "sqlite_schema");
  for (const row of manifest.sqlite_schema) {
    const autoindex = row.type === "index" && row.name.startsWith("sqlite_autoindex_");
    if ((row.sql_sha256 === null) !== autoindex) {
      throw new Error(
        `continuation_runtime_v1_schema_manifest_invalid:sqlite_schema_sql_digest:${row.name}`,
      );
    }
  }
  const schemaTables = manifest.sqlite_schema
    .filter((row) => row.type === "table")
    .map((row) => row.name);
  assertSameStrings(schemaTables, CONTINUATION_RUNTIME_V1_TABLES, "sqlite_schema_tables");

  const tableXinfoNames = manifest.table_xinfo.map((entry) => entry.table_name);
  assertSameStrings(tableXinfoNames, CONTINUATION_RUNTIME_V1_TABLES, "table_xinfo_tables");

  const expectedIndexNames = manifest.sqlite_schema
    .filter((row) => row.type === "index")
    .map((row) => row.name)
    .sort(compareStrings);
  const indexXinfoNames = manifest.index_xinfo.map((entry) => entry.index_name);
  assertSameStrings(indexXinfoNames, expectedIndexNames, "index_xinfo_indexes");

  const foreignKeyTableNames = manifest.foreign_key_list.map((entry) => entry.table_name);
  assertSameStrings(
    foreignKeyTableNames,
    CONTINUATION_RUNTIME_V1_TABLES,
    "foreign_key_list_tables",
  );
  if (manifest.ddl_sha256 !== sha256Hex(loadContinuationRuntimeV1Ddl())) {
    throw new Error("continuation_runtime_v1_schema_manifest_invalid:ddl_sha256");
  }

  const expectedSha256 = schemaSnapshotSha256(snapshotWithoutSha256(manifest));
  if (manifest.schema_sha256 !== expectedSha256) {
    throw new Error("continuation_runtime_v1_schema_manifest_invalid:schema_sha256");
  }
}

export function parseContinuationRuntimeV1SchemaManifest(
  value: unknown,
): ContinuationRuntimeV1SchemaManifest {
  const manifest = continuationRuntimeV1SchemaManifestSchema.parse(value);
  validateManifestRelations(manifest);
  return manifest;
}

export function serializeContinuationRuntimeV1SchemaManifest(
  manifest: ContinuationRuntimeV1SchemaManifest,
): string {
  return `${JSON.stringify(parseContinuationRuntimeV1SchemaManifest(manifest), null, 2)}\n`;
}

export function loadContinuationRuntimeV1Ddl(): string {
  return readFileSync(CONTINUATION_RUNTIME_V1_DDL_PATH, "utf8");
}

export function loadContinuationRuntimeV1SchemaManifest(): ContinuationRuntimeV1SchemaManifest {
  return parseContinuationRuntimeV1SchemaManifest(
    JSON.parse(readFileSync(CONTINUATION_RUNTIME_V1_MANIFEST_PATH, "utf8")) as unknown,
  );
}

/**
 * Captures the logical main-database schema. sqlite_schema deliberately keeps
 * SQLite autoindexes (whose SQL is null); PRAGMA groups are present even when
 * a table has no foreign keys.
 */
export function captureContinuationRuntimeV1SchemaManifest(
  db: SqliteDatabase,
): ContinuationRuntimeV1SchemaManifest {
  const sqliteSchema = (db.prepare(
    `SELECT type, name, tbl_name AS table_name, sql
     FROM sqlite_schema
     ORDER BY type, name, tbl_name`,
  ).all() as RawSqliteSchemaRow[]).map((row) => ({
    type: row.type,
    name: row.name,
    table_name: row.table_name,
    sql_sha256: row.sql === null ? null : sha256Hex(normalizeSqliteSchemaSql(row.sql)),
  }));
  const tables = sqliteSchema
    .filter((row) => row.type === "table")
    .map((row) => row.name)
    .sort(compareStrings);
  const indexes = sqliteSchema
    .filter((row) => row.type === "index")
    .map((row) => row.name)
    .sort(compareStrings);

  const snapshot: ContinuationRuntimeV1SchemaSnapshot = {
    manifest_version: CONTINUATION_RUNTIME_V1_SCHEMA_MANIFEST_VERSION,
    application_id: pragmaSafeInteger(db, "application_id"),
    user_version: pragmaSafeInteger(db, "user_version"),
    tables,
    sqlite_schema: sqliteSchema,
    table_xinfo: tables.map((tableName) => ({
      table_name: tableName,
      ...rowsDigest(pragmaRows<RawTableXinfoRow>(db, "table_xinfo", tableName)
        .sort((left, right) => left.cid - right.cid)
        .map((row) => ({
          cid: row.cid,
          name: row.name,
          type: row.type,
          not_null: row.notnull,
          default_value: row.dflt_value,
          primary_key_position: row.pk,
          hidden: row.hidden,
        }))),
    })),
    index_xinfo: indexes.map((indexName) => ({
      index_name: indexName,
      ...rowsDigest(pragmaRows<RawIndexXinfoRow>(db, "index_xinfo", indexName)
        .sort((left, right) => left.seqno - right.seqno)
        .map((row) => ({
          sequence: row.seqno,
          column_id: row.cid,
          name: row.name,
          descending: row.desc,
          collation: row.coll,
          key: row.key,
        }))),
    })),
    foreign_key_list: tables.map((tableName) => ({
      table_name: tableName,
      ...rowsDigest(pragmaRows<RawForeignKeyRow>(db, "foreign_key_list", tableName)
        .sort((left, right) => left.id - right.id || left.seq - right.seq)
        .map((row) => ({
          id: row.id,
          sequence: row.seq,
          target_table: row.table,
          from_column: row.from,
          to_column: row.to,
          on_update: row.on_update,
          on_delete: row.on_delete,
          match: row.match,
        }))),
    })),
  };
  return {
    ...snapshot,
    ddl_sha256: sha256Hex(loadContinuationRuntimeV1Ddl()),
    schema_sha256: schemaSnapshotSha256(snapshot),
  };
}

function manifestEntryMap<T extends { [key: string]: unknown }>(
  entries: readonly T[],
  key: (entry: T) => string,
): Map<string, T> {
  return new Map(entries.map((entry) => [key(entry), entry]));
}

function firstManifestDifference(
  actual: ContinuationRuntimeV1SchemaManifest,
  expected: ContinuationRuntimeV1SchemaManifest,
): string {
  if (actual.application_id !== expected.application_id) return "changed_application_id";
  if (actual.user_version !== expected.user_version) return "changed_user_version";

  const actualSchema = manifestEntryMap(actual.sqlite_schema, (row) => `${row.type}:${row.name}`);
  const expectedSchema = manifestEntryMap(expected.sqlite_schema, (row) => `${row.type}:${row.name}`);
  for (const key of expectedSchema.keys()) {
    if (!actualSchema.has(key)) return `missing_schema_object:${key}`;
  }
  for (const key of actualSchema.keys()) {
    if (!expectedSchema.has(key)) return `extra_schema_object:${key}`;
  }
  for (const [key, expectedRow] of expectedSchema) {
    if (stableJson(actualSchema.get(key)) !== stableJson(expectedRow)) {
      return `changed_schema_object:${key}`;
    }
  }

  const groups: ReadonlyArray<{
    label: string;
    actual: readonly Record<string, unknown>[];
    expected: readonly Record<string, unknown>[];
    key: (entry: Record<string, unknown>) => string;
  }> = [
    {
      label: "table_xinfo",
      actual: actual.table_xinfo,
      expected: expected.table_xinfo,
      key: (entry) => String(entry.table_name),
    },
    {
      label: "index_xinfo",
      actual: actual.index_xinfo,
      expected: expected.index_xinfo,
      key: (entry) => String(entry.index_name),
    },
    {
      label: "foreign_key_list",
      actual: actual.foreign_key_list,
      expected: expected.foreign_key_list,
      key: (entry) => String(entry.table_name),
    },
  ];
  for (const group of groups) {
    const actualEntries = manifestEntryMap(group.actual, group.key);
    const expectedEntries = manifestEntryMap(group.expected, group.key);
    for (const key of expectedEntries.keys()) {
      if (!actualEntries.has(key)) return `missing_${group.label}:${key}`;
    }
    for (const key of actualEntries.keys()) {
      if (!expectedEntries.has(key)) return `extra_${group.label}:${key}`;
    }
    for (const [key, expectedEntry] of expectedEntries) {
      if (stableJson(actualEntries.get(key)) !== stableJson(expectedEntry)) {
        return `changed_${group.label}:${key}`;
      }
    }
  }
  if (!sameStrings(actual.tables, expected.tables)) return "changed_table_set";
  return "changed_schema_sha256";
}

/** Rejects every missing, extra, or changed SQLite schema object and PRAGMA shape. */
export function assertContinuationRuntimeV1Schema(
  db: SqliteDatabase,
  manifest: ContinuationRuntimeV1SchemaManifest = loadContinuationRuntimeV1SchemaManifest(),
): void {
  const expected = parseContinuationRuntimeV1SchemaManifest(manifest);
  const actual = captureContinuationRuntimeV1SchemaManifest(db);
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(
      `continuation_runtime_v1_schema_mismatch:${firstManifestDifference(actual, expected)}`,
    );
  }
}
