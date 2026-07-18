import {
  createPrivateRuntimeSqliteDatabase,
  createSqliteReadWriteExistingDatabase,
  hardenPrivateRuntimeSqliteArtifacts,
  type SqliteDatabase,
} from "./sqlite.js";
import {
  createSqliteTransactionRunner,
  type SqliteTransactionPhase,
  type SqliteTransactionRunner,
} from "./sqlite-transaction-runner.js";

export type LiteRuntimeDatabaseFaultInjector = (phase: SqliteTransactionPhase) => void | Promise<void>;

export type LiteRuntimeDatabase = {
  readonly path: string;
  readonly db: SqliteDatabase;
  readonly readDb: SqliteDatabase;
  readonly transaction: SqliteTransactionRunner;
  withTx<T>(fn: () => Promise<T>): Promise<T>;
  afterCommit(fn: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
};

function assertCommittedReadPath(path: string): void {
  if (path === ":memory:") {
    throw new Error(
      "Lite Runtime SQLite requires a file-backed path; ':memory:' cannot share committed state across read/write connections",
    );
  }
}

export function createLiteRuntimeReadDatabase(path: string): SqliteDatabase {
  assertCommittedReadPath(path);
  const readDb = createPrivateRuntimeSqliteDatabase(path);
  try {
    readDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA query_only = ON;
    `);
    return readDb;
  } catch (error) {
    readDb.close();
    throw error;
  }
}

export function createLiteRuntimeDatabase(
  path: string,
  options: { faultInjector?: LiteRuntimeDatabaseFaultInjector } = {},
): LiteRuntimeDatabase {
  assertCommittedReadPath(path);
  const db = createPrivateRuntimeSqliteDatabase(path);
  let readDb: SqliteDatabase;
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
    `);
    readDb = createLiteRuntimeReadDatabase(path);
    hardenPrivateRuntimeSqliteArtifacts(path);
  } catch (error) {
    db.close();
    throw error;
  }
  const transaction = createSqliteTransactionRunner({
    begin: () => db.exec("BEGIN IMMEDIATE"),
    commit: () => db.exec("COMMIT"),
    rollback: () => db.exec("ROLLBACK"),
    onPhase: options.faultInjector,
  });
  let closed = false;

  return {
    path,
    db,
    readDb,
    transaction,
    withTx: (fn) => transaction.run(fn),
    afterCommit: (fn) => transaction.afterCommit(fn),
    async close() {
      if (closed) return;
      closed = true;
      try {
        readDb.close();
      } finally {
        db.close();
      }
    },
  };
}

/**
 * Opens an existing Runtime database for one protected, already-preflighted
 * authority mutation. Unlike the general Runtime opener, this never creates a
 * directory, switches journal mode, or opens a second connection before the
 * caller has revalidated the pinned database. The shared connection must not
 * be used for ordinary Runtime read/write composition.
 */
export function createLiteRuntimeProtectedWriteDatabase(
  path: string,
  options: { faultInjector?: LiteRuntimeDatabaseFaultInjector } = {},
): LiteRuntimeDatabase {
  assertCommittedReadPath(path);
  const db = createSqliteReadWriteExistingDatabase(path);
  try {
    db.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  const transaction = createSqliteTransactionRunner({
    begin: () => db.exec("BEGIN IMMEDIATE"),
    commit: () => db.exec("COMMIT"),
    rollback: () => db.exec("ROLLBACK"),
    onPhase: options.faultInjector,
  });
  let closed = false;
  return {
    path,
    db,
    // Protected close never composes a concurrent read path. Keeping the same
    // handle satisfies the Runtime database capability without reopening an
    // attacker-swappable pathname.
    readDb: db,
    transaction,
    withTx: (fn) => transaction.run(fn),
    afterCommit: (fn) => transaction.afterCommit(fn),
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
