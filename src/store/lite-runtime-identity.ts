import { randomBytes } from "node:crypto";

import type { SqliteDatabase } from "./sqlite.js";

export const LITE_RUNTIME_AUTHORITY_IDENTITY_TABLE_SQL =
  `CREATE TABLE lite_runtime_authority_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    database_instance_id TEXT NOT NULL UNIQUE CHECK (
      length(database_instance_id) = 64
      AND database_instance_id = lower(database_instance_id)
      AND database_instance_id NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL
  )`;

export const LITE_RUNTIME_AUTHORITY_IDENTITY_COLUMNS = [
  "singleton",
  "database_instance_id",
  "created_at",
] as const;

export const LITE_TENANT_SCOPE_ENCODING_ANCHOR_TABLE_SQL =
  `CREATE TABLE lite_tenant_scope_encoding_anchor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    default_tenant_id TEXT NOT NULL,
    config_sha256 TEXT NOT NULL CHECK (
      length(config_sha256) = 64
      AND config_sha256 = lower(config_sha256)
      AND config_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    config_json TEXT NOT NULL,
    implementation_sha256 TEXT NOT NULL CHECK (
      length(implementation_sha256) = 64
      AND implementation_sha256 = lower(implementation_sha256)
      AND implementation_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL
  )`;

export const LITE_TENANT_SCOPE_ENCODING_ANCHOR_COLUMNS = [
  "singleton",
  "default_tenant_id",
  "config_sha256",
  "config_json",
  "implementation_sha256",
  "created_at",
] as const;

export function migrateLiteRuntimeIdentitySchema(
  db: SqliteDatabase,
  options: {
    now?: Date;
    randomBytesFactory?: (size: number) => Uint8Array;
  } = {},
): string {
  db.exec(`${
    LITE_RUNTIME_AUTHORITY_IDENTITY_TABLE_SQL.replace(
      /^CREATE TABLE /u,
      "CREATE TABLE IF NOT EXISTS ",
    )
  };`);
  db.exec(`${
    LITE_TENANT_SCOPE_ENCODING_ANCHOR_TABLE_SQL.replace(
      /^CREATE TABLE /u,
      "CREATE TABLE IF NOT EXISTS ",
    )
  };`);
  const existing = db.prepare(
    "SELECT singleton, database_instance_id FROM lite_runtime_authority_identity",
  ).all() as Array<{ singleton: number; database_instance_id: string }>;
  if (existing.length === 0) {
    const bytes = options.randomBytesFactory?.(32) ?? randomBytes(32);
    if (bytes.byteLength !== 32) {
      throw new Error("Runtime authority identity requires exactly 32 random bytes");
    }
    db.prepare(
      `INSERT INTO lite_runtime_authority_identity
         (singleton, database_instance_id, created_at)
       VALUES (1, ?, ?)`,
    ).run(
      Buffer.from(bytes).toString("hex"),
      (options.now ?? new Date()).toISOString(),
    );
  }
  return assertLiteRuntimeAuthorityIdentity(db);
}

export function assertLiteRuntimeAuthorityIdentity(db: SqliteDatabase): string {
  const rows = db.prepare(
    "SELECT singleton, database_instance_id FROM lite_runtime_authority_identity ORDER BY singleton",
  ).all() as Array<{ singleton: number; database_instance_id: string }>;
  if (
    rows.length !== 1
    || rows[0]?.singleton !== 1
    || !/^[0-9a-f]{64}$/u.test(rows[0]?.database_instance_id ?? "")
  ) {
    throw new Error("lite_runtime_identity_invalid");
  }
  return rows[0].database_instance_id;
}
