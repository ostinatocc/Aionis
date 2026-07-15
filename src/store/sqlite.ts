import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type SqliteStatement = {
  run(...params: any[]): unknown;
  get<T = any>(...params: any[]): T;
  all<T = any>(...params: any[]): T[];
};

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

function loadSqliteModule(): SqliteModule | null {
  if (process.versions.node.localeCompare("22.13.0", undefined, { numeric: true }) < 0 || cachedSqliteModule !== undefined) return cachedSqliteModule ?? null;
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
  return new Error("Lite SQLite requires Node.js >=22.13.0 with node:sqlite support.");
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
