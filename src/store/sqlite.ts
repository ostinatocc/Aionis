import { createRequire } from "node:module";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type SqliteStatement = {
  run(...params: any[]): unknown;
  get<T = any>(...params: any[]): T;
  all<T = any>(...params: any[]): T[];
};

/**
 * The streaming surface implemented by node:sqlite's StatementSync. It is
 * intentionally separate from SqliteStatement so small, hand-written database
 * substitutes used by callers do not gain new structural requirements.
 */
export type SqliteStreamingStatement = SqliteStatement & {
  iterate<T = any>(...params: any[]): IterableIterator<T>;
  setReadBigInts(enabled: boolean): void;
};

/** Fail closed when a formal reader is not backed by node:sqlite streaming APIs. */
export function requireSqliteStreamingStatement(
  statement: SqliteStatement,
  label = "sqlite_statement",
): SqliteStreamingStatement {
  const candidate = statement as Partial<SqliteStreamingStatement>;
  if (typeof candidate.iterate !== "function"
    || typeof candidate.setReadBigInts !== "function") {
    throw new Error(`sqlite_streaming_statement_required:${label}`);
  }
  return candidate as SqliteStreamingStatement;
}

export type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare<T = any>(sql: string): SqliteStatement;
  close(): void;
};

type SqliteModule = {
  DatabaseSync: new (
    path: string | URL,
    options?: { readOnly?: boolean },
  ) => SqliteDatabase;
};

const require = createRequire(import.meta.url);

let cachedSqliteModule: SqliteModule | null | undefined;

export const NODE_SQLITE_URL_PATH_SUPPORTED_VERSION_RANGE =
  ">=22.15.0 <23 or >=23.10.0" as const;

export function hasNodeSqliteUrlPathSupport(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return false;
  return major === 22 ? minor >= 15 : major === 23 ? minor >= 10 : major > 23;
}

function loadSqliteModule(): SqliteModule | null {
  if (!hasNodeSqliteUrlPathSupport(process.versions.node)
    || cachedSqliteModule !== undefined) return cachedSqliteModule ?? null;
  try {
    const mod = require("node:sqlite") as Partial<SqliteModule>;
    cachedSqliteModule = typeof mod.DatabaseSync === "function" ? mod as SqliteModule : null;
  } catch {
    cachedSqliteModule = null;
  }
  return cachedSqliteModule;
}

export function hasNodeSqliteSupport(): boolean {
  return loadSqliteModule() !== null;
}

export function nodeSqliteSupportError(): Error {
  return new Error(
    `Lite SQLite requires Node.js ${NODE_SQLITE_URL_PATH_SUPPORTED_VERSION_RANGE} with node:sqlite URL-path support.`,
  );
}

export function createSqliteDatabase(path: string): SqliteDatabase {
  const mod = loadSqliteModule();
  if (!mod) throw nodeSqliteSupportError();
  const db = new mod.DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
  return db;
}

const PRIVATE_RUNTIME_DIRECTORY_MODE = 0o700;
const PRIVATE_RUNTIME_SQLITE_MODE = 0o600;

function chmodExisting(path: string, mode: number): void {
  let fd: number | null = null;
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error(`runtime_sqlite_artifact_must_be_regular_file:${path}`);
    }
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const openedStat = fstatSync(fd);
    if (!openedStat.isFile()) {
      throw new Error(`runtime_sqlite_artifact_must_be_regular_file:${path}`);
    }
    fchmodSync(fd, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function assertPrivateRuntimeSqliteArtifactPath(path: string): void {
  try {
    const artifact = lstatSync(path);
    if (artifact.isSymbolicLink() || !artifact.isFile()) {
      throw new Error(`runtime_sqlite_artifact_must_be_regular_file:${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

/**
 * Prepares a file-backed SQLite authority path before SQLite can create it.
 *
 * The immediate parent is Runtime's data directory and is deliberately made
 * owner-only. Pre-creating the main file closes the usual umask window where a
 * newly opened database can briefly be group/world-readable.
 */
export function preparePrivateRuntimeSqlitePath(path: string): void {
  if (path === ":memory:" || /^file:/iu.test(path)) {
    throw new Error("runtime_sqlite_requires_plain_file_path");
  }
  if (dirname(path) === ".") {
    throw new Error("runtime_sqlite_requires_dedicated_data_directory");
  }

  const directory = resolve(dirname(path));
  if (directory === parse(directory).root || directory === resolve(".")) {
    throw new Error("runtime_sqlite_requires_dedicated_data_directory");
  }
  mkdirSync(directory, { recursive: true, mode: PRIVATE_RUNTIME_DIRECTORY_MODE });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o1000) !== 0) {
    throw new Error("runtime_sqlite_requires_dedicated_data_directory");
  }
  chmodSync(directory, PRIVATE_RUNTIME_DIRECTORY_MODE);

  for (const artifact of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    assertPrivateRuntimeSqliteArtifactPath(artifact);
  }

  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    PRIVATE_RUNTIME_SQLITE_MODE,
  );
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`runtime_sqlite_artifact_must_be_regular_file:${path}`);
    }
    fchmodSync(fd, PRIVATE_RUNTIME_SQLITE_MODE);
  } finally {
    closeSync(fd);
  }
}

/** Re-applies owner-only modes after SQLite has materialized WAL/SHM files. */
export function hardenPrivateRuntimeSqliteArtifacts(path: string): void {
  chmodExisting(path, PRIVATE_RUNTIME_SQLITE_MODE);
  chmodExisting(`${path}-wal`, PRIVATE_RUNTIME_SQLITE_MODE);
  chmodExisting(`${path}-shm`, PRIVATE_RUNTIME_SQLITE_MODE);
  chmodExisting(`${path}-journal`, PRIVATE_RUNTIME_SQLITE_MODE);
}

/** Opens a Runtime authority database with an owner-only creation contract. */
export function createPrivateRuntimeSqliteDatabase(path: string): SqliteDatabase {
  const mod = loadSqliteModule();
  if (!mod) throw nodeSqliteSupportError();
  preparePrivateRuntimeSqlitePath(path);
  const db = new mod.DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
    hardenPrivateRuntimeSqliteArtifacts(path);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Opens an existing SQLite database without granting the connection any write
 * authority. Protected operator workflows use this before opening Runtime's
 * WAL-backed write connection so a rejected request cannot migrate, initialize,
 * or otherwise alter the target database as a side effect of validation.
 */
export function createSqliteReadOnlyDatabase(path: string): SqliteDatabase {
  const mod = loadSqliteModule();
  if (!mod) throw nodeSqliteSupportError();
  const db = new mod.DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA query_only = ON;
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Opens an existing database read-only while allowing `VACUUM INTO` to create
 * a separate snapshot. `query_only` cannot be enabled here because SQLite
 * classifies the destination creation as a write even though the source
 * connection itself has no write authority.
 */
export function createSqliteSnapshotSourceDatabase(path: string): SqliteDatabase {
  const mod = loadSqliteModule();
  if (!mod) throw nodeSqliteSupportError();
  const db = new mod.DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Opens a side-effect-free snapshot of a quiescent SQLite main file. */
export function createSqliteImmutableReadOnlyDatabase(path: string): SqliteDatabase {
  const mod = loadSqliteModule();
  if (!mod) throw nodeSqliteSupportError();
  const location = pathToFileURL(path);
  location.searchParams.set("mode", "ro");
  location.searchParams.set("immutable", "1");
  const db = new mod.DatabaseSync(location, { readOnly: true });
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA query_only = ON;
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Opens an existing database read-write without SQLite's CREATE authority. */
export function createSqliteReadWriteExistingDatabase(path: string): SqliteDatabase {
  const mod = loadSqliteModule();
  if (!mod) throw nodeSqliteSupportError();
  const location = pathToFileURL(path);
  location.searchParams.set("mode", "rw");
  const db = new mod.DatabaseSync(location);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function isSqliteDuplicateColumnError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate column name/i.test(message);
}

export function ignoreSqliteDuplicateColumnError(err: unknown): void {
  if (!isSqliteDuplicateColumnError(err)) throw err;
}
