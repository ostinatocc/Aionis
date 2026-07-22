import { randomBytes } from "node:crypto";
import { assertContinuationRuntimeV1Host } from "../continuation/host-contract.js";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  CONTINUATION_RUNTIME_V1_USER_VERSION,
  assertContinuationRuntimeV1Schema,
  loadContinuationRuntimeV1Ddl,
  loadContinuationRuntimeV1SchemaManifest,
  type ContinuationRuntimeV1SchemaManifest,
} from "./continuation-runtime-v1-schema.js";
import {
  assertPrivateRuntimeSqliteArtifactIdentities,
  assertPrivateRuntimeSqliteArtifactModes,
  capturePrivateRuntimeSqliteArtifactIdentities,
  createSqliteImmutableReadOnlyDatabase,
  createSqliteReadWriteExistingDatabase,
  hardenPrivateRuntimeSqliteDirectoryOffline,
  type PrivateRuntimeSqliteArtifactIdentities,
  type PrivateRuntimeSqliteFileIdentity,
  type SqliteDatabase,
} from "./sqlite.js";
import { createSqliteTransactionRunner, type SqliteTransactionPhase,
  type SqliteTransactionRunner } from "./sqlite-transaction-runner.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_SQLITE_MODE = 0o600;
const SQLITE_ARTIFACT_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

declare const AUTHORITY_CLOCK_BRAND: unique symbol;
export type ContinuationRuntimeV1AuthorityClock = (() => string) & { readonly [AUTHORITY_CLOCK_BRAND]: true };
const AUTHORITY_CLOCKS = new WeakSet<object>();

export type ContinuationRuntimeV1Database = Readonly<{
  path: string;
  databaseInstanceId: string;
  authorityNow: ContinuationRuntimeV1AuthorityClock;
  mintAuthorityTime(after: string | null): string;
  db: SqliteDatabase;
  transaction: SqliteTransactionRunner;
  withTx<T>(fn: () => Promise<T>): Promise<T>;
  read<T>(fn: () => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
}>;

export type ContinuationRuntimeV1DatabaseOptions = Readonly<{
  authorityNow?: () => string;
  databaseInstanceId?: string;
  faultInjector?: (phase: SqliteTransactionPhase) => void | Promise<void>;
  bootstrapFaultInjector?: (phase: ContinuationRuntimeV1BootstrapPhase) => void;
}>;

export function assertContinuationRuntimeV1AuthorityClock(
  value: unknown,
): asserts value is ContinuationRuntimeV1AuthorityClock {
  if (typeof value !== "function" || !AUTHORITY_CLOCKS.has(value))
    throw new Error("continuation_runtime_v1_authority_clock_capability_invalid");
}

export type ContinuationRuntimeV1BootstrapPhase = "after_claim" | "after_begin"
  | "after_schema" | "after_meta" | "before_commit" | "after_commit" | "after_wal";

type RuntimeMetaRow = {
  singleton: number; database_instance_id: string; schema_id: string;
  schema_version: number; schema_manifest_sha256: string;
  created_at: string; authority_clock_floor_at: string;
};

function sameFileIdentity(
  left: PrivateRuntimeSqliteFileIdentity,
  right: PrivateRuntimeSqliteFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissingPath(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function assertPlainDedicatedPath(path: string): string {
  if (path === ":memory:" || /^file:/iu.test(path)) {
    throw new Error("continuation_runtime_v1_requires_plain_file_path");
  }
  if (dirname(path) === ".") {
    throw new Error("continuation_runtime_v1_requires_dedicated_data_directory");
  }
  return resolve(path);
}

function assertBootstrapNamespaceMissing(path: string): void {
  for (const suffix of SQLITE_ARTIFACT_SUFFIXES) {
    const artifactPath = `${path}${suffix}`;
    if (!isMissingPath(artifactPath)) {
      throw new Error(
        `continuation_runtime_v1_bootstrap_requires_missing_namespace:${artifactPath}`,
      );
    }
  }
}

function assertBootstrapSidecarsMissing(path: string): void {
  for (const suffix of SQLITE_ARTIFACT_SUFFIXES.slice(1)) {
    const artifactPath = `${path}${suffix}`;
    if (!isMissingPath(artifactPath)) {
      throw new Error(
        `continuation_runtime_v1_bootstrap_requires_missing_namespace:${artifactPath}`,
      );
    }
  }
}

/** Claims a missing main pathname with O_EXCL; an existing empty file is never bootstrap input. */
function claimBootstrapPath(path: string): PrivateRuntimeSqliteFileIdentity {
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  hardenPrivateRuntimeSqliteDirectoryOffline(path);
  assertBootstrapNamespaceMissing(path);

  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_SQLITE_MODE,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new Error(`continuation_runtime_v1_bootstrap_artifact_invalid:${path}`);
    }
    if (process.platform !== "win32" && typeof process.getuid === "function"
      && opened.uid !== BigInt(process.getuid())) {
      throw new Error(`continuation_runtime_v1_bootstrap_owner_invalid:${path}`);
    }
    fchmodSync(descriptor, PRIVATE_SQLITE_MODE);
    return { dev: opened.dev, ino: opened.ino };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function assertCanonicalTimestamp(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error(`continuation_runtime_v1_${field}_invalid`);
  }
}

function assertDatabaseIntegrity(db: SqliteDatabase): void {
  const quickCheck = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (quickCheck.length !== 1 || Object.values(quickCheck[0] ?? {})[0] !== "ok") {
    throw new Error("continuation_runtime_v1_quick_check_failed");
  }
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("continuation_runtime_v1_foreign_key_check_failed");
  }
}

function pragmaScalar(db: SqliteDatabase, pragma: string): unknown {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

function assertRuntimeConnectionPragmas(db: SqliteDatabase): void {
  if (String(pragmaScalar(db, "journal_mode")).toLowerCase() !== "wal"
    || pragmaScalar(db, "synchronous") !== 2
    || pragmaScalar(db, "foreign_keys") !== 1
    || pragmaScalar(db, "trusted_schema") !== 0) {
    throw new Error("continuation_runtime_v1_connection_pragmas_invalid");
  }
}

function assertRuntimeMeta(
  db: SqliteDatabase,
  manifest: ContinuationRuntimeV1SchemaManifest,
): RuntimeMetaRow {
  const rows = db.prepare(
    `SELECT singleton, database_instance_id, schema_id, schema_version,
            schema_manifest_sha256, created_at, authority_clock_floor_at
       FROM runtime_meta`,
  ).all() as RuntimeMetaRow[];
  if (rows.length !== 1) {
    throw new Error("continuation_runtime_v1_runtime_meta_cardinality_invalid");
  }
  const row = rows[0]!;
  if (row.singleton !== 1
    || !/^[0-9a-f]{64}$/u.test(row.database_instance_id)
    || row.schema_id !== "continuation_runtime_v1"
    || row.schema_version !== CONTINUATION_RUNTIME_V1_USER_VERSION
    || row.schema_manifest_sha256 !== manifest.schema_sha256) {
    throw new Error("continuation_runtime_v1_runtime_meta_invalid");
  }
  assertCanonicalTimestamp(row.created_at, "runtime_meta_created_at");
  assertCanonicalTimestamp(row.authority_clock_floor_at, "authority_clock_floor_at");
  if (row.authority_clock_floor_at < row.created_at) {
    throw new Error("continuation_runtime_v1_authority_clock_floor_invalid");
  }
  return row;
}

function authorityClockFloor(db: SqliteDatabase): string {
  const value = (db.prepare(
    "SELECT authority_clock_floor_at FROM runtime_meta WHERE singleton = 1",
  ).get() as { authority_clock_floor_at?: unknown } | undefined)?.authority_clock_floor_at;
  if (typeof value !== "string") {
    throw new Error("continuation_runtime_v1_authority_clock_floor_invalid");
  }
  assertCanonicalTimestamp(value, "authority_clock_floor_at");
  return value;
}

function copyPreflightArtifact(source: string, destination: string): void {
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  const copied = lstatSync(destination);
  if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1) {
    throw new Error("continuation_runtime_v1_preflight_copy_invalid");
  }
  // Match authority-file mode even inside the private temporary directory.
  chmodSync(destination, PRIVATE_SQLITE_MODE);
  const hardened = lstatSync(destination);
  if (!hardened.isFile() || hardened.isSymbolicLink() || hardened.nlink !== 1
    || hardened.dev !== copied.dev || hardened.ino !== copied.ino
    || (process.platform !== "win32" && (hardened.mode & 0o7777) !== PRIVATE_SQLITE_MODE)
    || (process.platform !== "win32" && typeof process.getuid === "function"
      && hardened.uid !== process.getuid())) {
    throw new Error("continuation_runtime_v1_preflight_copy_invalid");
  }
}

function createPrivatePreflightDirectory(path: string): string {
  const directory = mkdtempSync(join(dirname(path), ".aionis-v1-preflight-"));
  try {
    chmodSync(directory, PRIVATE_DIRECTORY_MODE);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.platform !== "win32" && (stat.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE)
      || (process.platform !== "win32" && typeof process.getuid === "function"
        && stat.uid !== process.getuid())) {
      throw new Error("continuation_runtime_v1_preflight_directory_posture_invalid");
    }
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function preflightExistingDatabase(
  path: string,
  manifest: ContinuationRuntimeV1SchemaManifest,
  identities: PrivateRuntimeSqliteArtifactIdentities,
): RuntimeMetaRow {
  const needsRecoveryCopy = identities.wal !== null || identities.journal !== null;
  if (!needsRecoveryCopy) {
    const database = createSqliteImmutableReadOnlyDatabase(path);
    try {
      assertContinuationRuntimeV1Schema(database, manifest);
      assertDatabaseIntegrity(database);
      return assertRuntimeMeta(database, manifest);
    } finally {
      database.close();
    }
  }

  // Keep recovery beside the authority database; bounded global /tmp cannot block restart.
  const directory = createPrivatePreflightDirectory(path);
  const copyPath = join(directory, "runtime.sqlite");
  try {
    copyPreflightArtifact(path, copyPath);
    if (identities.wal) copyPreflightArtifact(`${path}-wal`, `${copyPath}-wal`);
    if (identities.journal) {
      copyPreflightArtifact(`${path}-journal`, `${copyPath}-journal`);
    }
    assertPrivateRuntimeSqliteArtifactIdentities(path, identities);

    const database = createSqliteReadWriteExistingDatabase(copyPath);
    try {
      database.exec("PRAGMA foreign_keys = ON;");
      assertContinuationRuntimeV1Schema(database, manifest);
      assertDatabaseIntegrity(database);
      return assertRuntimeMeta(database, manifest);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertRuntimeMeta(
  db: SqliteDatabase,
  manifest: ContinuationRuntimeV1SchemaManifest,
  databaseInstanceId: string,
  createdAt: string,
): void {
  if (!/^[0-9a-f]{64}$/u.test(databaseInstanceId)) {
    throw new Error("continuation_runtime_v1_database_instance_id_invalid");
  }
  assertCanonicalTimestamp(createdAt, "bootstrap_timestamp");
  db.prepare(
    `INSERT INTO runtime_meta(
       singleton, database_instance_id, schema_id, schema_version,
       schema_manifest_sha256, created_at, authority_clock_floor_at
     ) VALUES (1, ?, 'continuation_runtime_v1', ?, ?, ?, ?)`,
  ).run(
    databaseInstanceId,
    CONTINUATION_RUNTIME_V1_USER_VERSION,
    manifest.schema_sha256,
    createdAt,
    createdAt,
  );
}

function bootstrapDatabase(
  path: string,
  manifest: ContinuationRuntimeV1SchemaManifest,
  options: ContinuationRuntimeV1DatabaseOptions,
  createdAt: string,
): { db: SqliteDatabase; meta: RuntimeMetaRow } {
  const claimedIdentity = claimBootstrapPath(path);
  assertBootstrapSidecarsMissing(path);
  options.bootstrapFaultInjector?.("after_claim");
  let database: SqliteDatabase | null = null;
  let began = false;
  try {
    database = createSqliteReadWriteExistingDatabase(path);
    const openedIdentity = capturePrivateRuntimeSqliteArtifactIdentities(path).main;
    if (!sameFileIdentity(openedIdentity, claimedIdentity)) {
      throw new Error("continuation_runtime_v1_bootstrap_artifact_replaced");
    }
    database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    database.exec("BEGIN EXCLUSIVE");
    began = true;
    options.bootstrapFaultInjector?.("after_begin");
    database.exec(loadContinuationRuntimeV1Ddl());
    assertContinuationRuntimeV1Schema(database, manifest);
    options.bootstrapFaultInjector?.("after_schema");
    insertRuntimeMeta(
      database,
      manifest,
      options.databaseInstanceId ?? randomBytes(32).toString("hex"),
      createdAt,
    );
    assertDatabaseIntegrity(database);
    const meta = assertRuntimeMeta(database, manifest);
    options.bootstrapFaultInjector?.("after_meta");
    options.bootstrapFaultInjector?.("before_commit");
    database.exec("COMMIT");
    began = false;
    options.bootstrapFaultInjector?.("after_commit");
    database.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;",
    );
    assertRuntimeConnectionPragmas(database);
    options.bootstrapFaultInjector?.("after_wal");
    assertPrivateRuntimeSqliteArtifactModes(path);
    const current = capturePrivateRuntimeSqliteArtifactIdentities(path);
    if (!sameFileIdentity(current.main, claimedIdentity)) {
      throw new Error("continuation_runtime_v1_bootstrap_artifact_replaced");
    }
    return { db: database, meta };
  } catch (error) {
    if (database && began) {
      try { database.exec("ROLLBACK"); } catch { /* preserve bootstrap failure */ }
    }
    database?.close();
    // Retain the O_EXCL claim so a partial bootstrap can never masquerade as new.
    throw error;
  }
}

function openExistingDatabase(
  path: string,
  manifest: ContinuationRuntimeV1SchemaManifest,
): { db: SqliteDatabase; meta: RuntimeMetaRow } {
  assertPrivateRuntimeSqliteArtifactModes(path);
  const identities = capturePrivateRuntimeSqliteArtifactIdentities(path);
  const preflightMeta = preflightExistingDatabase(path, manifest, identities);
  assertPrivateRuntimeSqliteArtifactIdentities(path, identities);

  const database = createSqliteReadWriteExistingDatabase(path);
  let began = false;
  try {
    const openedIdentities = capturePrivateRuntimeSqliteArtifactIdentities(path);
    if (!sameFileIdentity(openedIdentities.main, identities.main)) {
      throw new Error("continuation_runtime_v1_database_replaced_after_preflight");
    }
    database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    database.exec("BEGIN IMMEDIATE");
    began = true;
    assertContinuationRuntimeV1Schema(database, manifest);
    assertDatabaseIntegrity(database);
    const meta = assertRuntimeMeta(database, manifest);
    if (meta.database_instance_id !== preflightMeta.database_instance_id
      || meta.schema_manifest_sha256 !== preflightMeta.schema_manifest_sha256) {
      throw new Error("continuation_runtime_v1_database_changed_after_preflight");
    }
    database.exec("COMMIT");
    began = false;
    database.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;",
    );
    assertRuntimeConnectionPragmas(database);
    assertPrivateRuntimeSqliteArtifactModes(path);
    return { db: database, meta };
  } catch (error) {
    if (began) {
      try { database.exec("ROLLBACK"); } catch { /* preserve open failure */ }
    }
    database.close();
    throw error;
  }
}

export function openContinuationRuntimeV1Database(
  path: string,
  options: ContinuationRuntimeV1DatabaseOptions = {},
): ContinuationRuntimeV1Database {
  assertContinuationRuntimeV1Host();
  if (options.authorityNow !== undefined && typeof options.authorityNow !== "function") {
    throw new Error("continuation_runtime_v1_authority_clock_invalid");
  }
  const sourceNow = options.authorityNow ?? (() => new Date().toISOString());
  const readSourceNow = (): string => {
    let value: unknown;
    try { value = sourceNow(); } catch {
      throw new Error("continuation_runtime_v1_authority_clock_invalid");
    }
    if (typeof value !== "string") throw new Error("continuation_runtime_v1_authority_clock_invalid");
    assertCanonicalTimestamp(value, "authority_clock");
    return value;
  };
  const openedAt = readSourceNow();
  const absolutePath = assertPlainDedicatedPath(path);
  // Authenticate the manifest before a packaging error could strand a new authority file.
  const manifest = loadContinuationRuntimeV1SchemaManifest();
  const opened = isMissingPath(absolutePath)
    ? bootstrapDatabase(absolutePath, manifest, options, openedAt)
    : openExistingDatabase(absolutePath, manifest);
  const transaction = createSqliteTransactionRunner({
    begin: () => opened.db.exec("BEGIN IMMEDIATE"),
    commit: () => opened.db.exec("COMMIT"),
    rollback: () => opened.db.exec("ROLLBACK"),
    onPhase: options.faultInjector,
  });
  let localFloor = opened.meta.authority_clock_floor_at;
  const authorityNow = Object.freeze(((): string => {
    const source = readSourceNow();
    if (source > localFloor) localFloor = source;
    if (!transaction.inTransaction()) return localFloor;
    const persisted = authorityClockFloor(opened.db);
    return persisted > localFloor ? persisted : localFloor;
  })) as ContinuationRuntimeV1AuthorityClock;
  AUTHORITY_CLOCKS.add(authorityNow);
  const mintAuthorityTime = (after: string | null): string => {
    if (!transaction.inTransaction())
      throw new Error("continuation_runtime_v1_authority_time_mint_requires_transaction");
    if (after !== null) assertCanonicalTimestamp(after, "authority_time_lower_bound");
    let value = authorityNow();
    if (after !== null && value <= after) {
      value = new Date(Date.parse(after) + 1).toISOString();
      assertCanonicalTimestamp(value, "authority_time");
    }
    opened.db.prepare(
      "UPDATE runtime_meta SET authority_clock_floor_at = ? WHERE singleton = 1",
    ).run(value);
    void transaction.afterCommit(async () => {
      if (value > localFloor) localFloor = value;
    });
    return value;
  };
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    path: absolutePath,
    databaseInstanceId: opened.meta.database_instance_id,
    authorityNow,
    mintAuthorityTime,
    db: opened.db,
    transaction,
    withTx: (fn) => transaction.run(async () => {
      const persisted = authorityClockFloor(opened.db);
      if (persisted > localFloor) localFloor = persisted;
      return await fn();
    }),
    read: (fn) => transaction.read(fn),
    close() {
      if (transaction.inTransaction()) {
        return Promise.reject(
          new Error("continuation_runtime_v1_cannot_close_inside_transaction"),
        );
      }
      if (closePromise) return closePromise;
      closePromise = (async () => {
        try {
          await transaction.sealAndRun(async () => undefined);
          opened.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          opened.db.close();
        }
        assertPrivateRuntimeSqliteArtifactModes(absolutePath);
      })();
      return closePromise;
    },
  });
}
