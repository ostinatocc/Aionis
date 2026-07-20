import { createRequire } from "node:module";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";
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
export type PrivateRuntimeSqliteFileIdentity = Readonly<{ dev: bigint; ino: bigint }>;
export type PrivateRuntimeSqliteArtifactIdentities = Readonly<{ main: PrivateRuntimeSqliteFileIdentity; wal: PrivateRuntimeSqliteFileIdentity | null; shm: PrivateRuntimeSqliteFileIdentity | null; journal: PrivateRuntimeSqliteFileIdentity | null }>;
const PRIVATE_RUNTIME_SQLITE_ARTIFACT_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const PRIVATE_RUNTIME_SQLITE_ARTIFACT_KEYS = ["main", "wal", "shm", "journal"] as const;

function privateRuntimeSqliteFileIdentity(path: string, required = true): PrivateRuntimeSqliteFileIdentity | null {
  try {
    const file = lstatSync(path, { bigint: true });
    if (file.isSymbolicLink() || !file.isFile()) throw new Error(`runtime_sqlite_artifact_must_be_regular_file:${path}`);
    if (process.platform !== "win32" && typeof process.getuid === "function"
      && file.uid !== BigInt(process.getuid())) throw new Error(`runtime_sqlite_artifact_owner_invalid:${path}`);
    if (file.nlink !== 1n) throw new Error(`runtime_sqlite_artifact_hardlink_invalid:${path}:${file.nlink}`);
    return { dev: file.dev, ino: file.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    if (required) throw new Error(`runtime_sqlite_artifact_missing:${path}`);
    return null;
  }
}

export function capturePrivateRuntimeSqliteArtifactIdentities(path: string): PrivateRuntimeSqliteArtifactIdentities {
  const identities = PRIVATE_RUNTIME_SQLITE_ARTIFACT_SUFFIXES.map((suffix) => privateRuntimeSqliteFileIdentity(`${path}${suffix}`, suffix === "")); return { main: identities[0]!, wal: identities[1], shm: identities[2], journal: identities[3] };
}
function canonicalPrivateRuntimeSqliteArtifactPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    const parent = dirname(absolute); if (parent === absolute) throw error;
    return resolve(canonicalPrivateRuntimeSqliteArtifactPath(parent), basename(absolute));
  }
}
export function assertPrivateRuntimeSqlitePathNamespacesDisjoint(leftPath: string, rightPath: string): void {
  const artifacts = (path: string) => PRIVATE_RUNTIME_SQLITE_ARTIFACT_SUFFIXES.map((suffix) => {
    const artifactPath = `${resolve(path)}${suffix}`;
    return { key: canonicalPrivateRuntimeSqliteArtifactPath(artifactPath).normalize("NFC").toLowerCase(),
      identity: privateRuntimeSqliteFileIdentity(artifactPath, false) };
  });
  const left = artifacts(leftPath); const right = artifacts(rightPath);
  for (const leftArtifact of left) for (const rightArtifact of right) {
    const sameIdentity = leftArtifact.identity && rightArtifact.identity
      && leftArtifact.identity.dev === rightArtifact.identity.dev
      && leftArtifact.identity.ino === rightArtifact.identity.ino;
    if (leftArtifact.key === rightArtifact.key || sameIdentity) throw new Error(`runtime_sqlite_artifact_namespace_overlap:${rightArtifact.key}`);
  }
}

export function assertPrivateRuntimeSqliteNamespacesDisjoint(leftPath: string, left: PrivateRuntimeSqliteArtifactIdentities,
  rightPath: string, right: PrivateRuntimeSqliteArtifactIdentities): void {
  assertPrivateRuntimeSqlitePathNamespacesDisjoint(leftPath, rightPath);
  for (const leftRole of PRIVATE_RUNTIME_SQLITE_ARTIFACT_KEYS) for (const rightRole of PRIVATE_RUNTIME_SQLITE_ARTIFACT_KEYS) {
    const leftIdentity = left[leftRole]; const rightIdentity = right[rightRole];
    if (leftIdentity && rightIdentity && leftIdentity.ino !== 0n && leftIdentity.dev === rightIdentity.dev
      && leftIdentity.ino === rightIdentity.ino) throw new Error(`runtime_sqlite_artifact_namespace_overlap:${leftRole}:${rightRole}`);
  }
}

export function assertPrivateRuntimeSqliteFileIdentity(path: string, expected: PrivateRuntimeSqliteFileIdentity): void {
  const actual = privateRuntimeSqliteFileIdentity(path);
  if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(`runtime_sqlite_artifact_changed_since_verification:${path}`);
}

export function assertPrivateRuntimeSqliteArtifactIdentities(path: string, expected: PrivateRuntimeSqliteArtifactIdentities,
  allowNew = false): PrivateRuntimeSqliteArtifactIdentities {
  const actual = capturePrivateRuntimeSqliteArtifactIdentities(path);
  for (const key of PRIVATE_RUNTIME_SQLITE_ARTIFACT_KEYS) {
    if (!expected[key]) {
      if (!allowNew && actual[key]) throw new Error(`runtime_sqlite_artifact_appeared_since_verification:${path}:${key}`);
    } else if (!actual[key] || actual[key]?.dev !== expected[key]?.dev || actual[key]?.ino !== expected[key]?.ino) {
      throw new Error(`runtime_sqlite_artifact_changed_since_verification:${path}:${key}`);
    }
  }
  return actual;
}

function chmodExisting(path: string, mode: number, expectedIdentity?: PrivateRuntimeSqliteFileIdentity | null): void {
  let fd: number | null = null;
  try {
    const pathStat = lstatSync(path, { bigint: true });
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error(`runtime_sqlite_artifact_must_be_regular_file:${path}`);
    }
    if (pathStat.nlink !== 1n) {
      throw new Error(`runtime_sqlite_artifact_hardlink_invalid:${path}:${pathStat.nlink}`);
    }
    if (expectedIdentity === null) {
      throw new Error(`runtime_sqlite_artifact_appeared_since_verification:${path}`);
    }
    if (expectedIdentity && (pathStat.dev !== expectedIdentity.dev
      || pathStat.ino !== expectedIdentity.ino)) {
      throw new Error(`runtime_sqlite_artifact_changed_since_verification:${path}`);
    }
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const openedStat = fstatSync(fd, { bigint: true });
    if (!openedStat.isFile()
      || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error(`runtime_sqlite_artifact_changed_during_mode_hardening:${path}`);
    }
    if (process.platform !== "win32" && typeof process.getuid === "function"
      && openedStat.uid !== BigInt(process.getuid())) {
      throw new Error(`runtime_sqlite_artifact_owner_invalid:${path}`);
    }
    fchmodSync(fd, mode);
    const after = lstatSync(path, { bigint: true });
    if (after.isSymbolicLink() || !after.isFile()
      || after.dev !== pathStat.dev || after.ino !== pathStat.ino) {
      throw new Error(`runtime_sqlite_artifact_changed_during_mode_hardening:${path}`);
    }
    if (process.platform !== "win32" && (after.mode & 0o7777n) !== BigInt(mode)) {
      throw new Error(`runtime_sqlite_artifact_mode_invalid:${path}:${(after.mode & 0o7777n).toString(8)}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    if (expectedIdentity) throw new Error(`runtime_sqlite_artifact_missing_since_verification:${path}`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function assertPrivateRuntimeSqliteArtifactPath(path: string): void {
  try {
    const artifact = lstatSync(path);
    if (artifact.isSymbolicLink() || !artifact.isFile()) throw new Error(`runtime_sqlite_artifact_must_be_regular_file:${path}`);
    if (artifact.nlink !== 1) throw new Error(`runtime_sqlite_artifact_hardlink_invalid:${path}:${artifact.nlink}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

function hardenPrivateRuntimeSqliteDirectory(path: string): void {
  const directory = resolve(dirname(path));
  if (directory === parse(directory).root || directory === resolve(".")) {
    throw new Error("runtime_sqlite_requires_dedicated_data_directory");
  }
  const before = lstatSync(directory);
  if (!before.isDirectory() || (before.mode & 0o1000) !== 0) {
    throw new Error("runtime_sqlite_requires_dedicated_data_directory");
  }
  if (process.platform !== "win32" && typeof process.getuid === "function"
    && before.uid !== process.getuid()) {
    throw new Error(`runtime_sqlite_directory_owner_invalid:${directory}`);
  }

  const fd = openSync(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`runtime_sqlite_directory_changed_during_mode_hardening:${directory}`);
    }
    if (process.platform !== "win32" && typeof process.getuid === "function"
      && opened.uid !== process.getuid()) {
      throw new Error(`runtime_sqlite_directory_owner_invalid:${directory}`);
    }
    fchmodSync(fd, PRIVATE_RUNTIME_DIRECTORY_MODE);
  } finally {
    closeSync(fd);
  }

  const after = lstatSync(directory);
  if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error(`runtime_sqlite_directory_changed_during_mode_hardening:${directory}`);
  }
  if (process.platform !== "win32"
    && (after.mode & 0o7777) !== PRIVATE_RUNTIME_DIRECTORY_MODE) {
    throw new Error(
      `runtime_sqlite_directory_mode_invalid:${directory}:${(after.mode & 0o7777).toString(8)}`,
    );
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
  mkdirSync(directory, { recursive: true, mode: PRIVATE_RUNTIME_DIRECTORY_MODE });
  // A directory descriptor is safe to close while SQLite owns locks on files
  // inside that directory. This repairs a conventional 0755 data directory
  // without opening or closing the database, WAL, SHM, or journal files.
  hardenPrivateRuntimeSqliteDirectory(path);

  for (const artifact of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    assertPrivateRuntimeSqliteArtifactPath(artifact);
  }

  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_RUNTIME_SQLITE_MODE,
    );
    if (!fstatSync(fd).isFile()) {
      throw new Error(`runtime_sqlite_artifact_must_be_regular_file:${path}`);
    }
    fchmodSync(fd, PRIVATE_RUNTIME_SQLITE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    // Existing artifacts are never repaired during Runtime startup. A live
    // SQLite connection may already own POSIX locks, while pathname chmod has
    // an unavoidable lstat-to-syscall symlink race in Node's portable API.
    // Incorrect modes therefore require explicit quiescent/offline repair.
    assertPrivateRuntimeSqliteArtifactMode(path, PRIVATE_RUNTIME_SQLITE_MODE, true);
  } finally {
    if (fd !== null) closeSync(fd);
  }

  for (const artifact of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    assertPrivateRuntimeSqliteArtifactMode(artifact, PRIVATE_RUNTIME_SQLITE_MODE);
  }
}

/**
 * Re-applies owner-only modes to a quiescent SQLite snapshot.
 *
 * This descriptor-based helper must never run while any SQLite connection to
 * the database is alive. POSIX close(2) can cancel locks held by SQLite on a
 * different descriptor in the same process. Live stores use the stat-only
 * assertion below instead.
 */
export function hardenPrivateRuntimeSqliteArtifacts(
  path: string,
  expected?: PrivateRuntimeSqliteArtifactIdentities,
): void {
  chmodExisting(path, PRIVATE_RUNTIME_SQLITE_MODE, expected?.main);
  chmodExisting(`${path}-wal`, PRIVATE_RUNTIME_SQLITE_MODE, expected?.wal);
  chmodExisting(`${path}-shm`, PRIVATE_RUNTIME_SQLITE_MODE, expected?.shm);
  chmodExisting(`${path}-journal`, PRIVATE_RUNTIME_SQLITE_MODE, expected?.journal);
}

/** Restricts the dedicated parent before an offline verifier opens SQLite by path. */
export function hardenPrivateRuntimeSqliteDirectoryOffline(path: string): void {
  hardenPrivateRuntimeSqliteDirectory(path);
}

/** Repairs a Runtime path only while every SQLite connection to it is closed. */
export function hardenPrivateRuntimeSqlitePathOffline(
  path: string,
  expected?: PrivateRuntimeSqliteArtifactIdentities,
): void {
  hardenPrivateRuntimeSqliteDirectory(path);
  hardenPrivateRuntimeSqliteArtifacts(path, expected);
  assertPrivateRuntimeSqliteArtifactModes(path);
}

function assertPrivateRuntimeSqliteArtifactMode(
  path: string,
  expectedMode: number,
  required = false,
): void {
  try {
    const artifact = lstatSync(path);
    if (artifact.isSymbolicLink() || !artifact.isFile()) throw new Error(`runtime_sqlite_artifact_must_be_regular_file:${path}`);
    if (artifact.nlink !== 1) throw new Error(`runtime_sqlite_artifact_hardlink_invalid:${path}:${artifact.nlink}`);
    if (process.platform !== "win32" && typeof process.getuid === "function"
      && artifact.uid !== process.getuid()) {
      throw new Error(`runtime_sqlite_artifact_owner_invalid:${path}`);
    }
    if (process.platform !== "win32" && (artifact.mode & 0o7777) !== expectedMode) {
      throw new Error(
        `runtime_sqlite_artifact_mode_invalid:${path}:${(artifact.mode & 0o7777).toString(8)}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    if (required) throw new Error(`runtime_sqlite_artifact_missing:${path}`);
  }
}

/** Verifies live SQLite artifacts without opening or closing another file descriptor. */
export function assertPrivateRuntimeSqliteArtifactModes(path: string): void {
  const directory = resolve(dirname(path));
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory()) {
    throw new Error("runtime_sqlite_requires_dedicated_data_directory");
  }
  if (process.platform !== "win32" && typeof process.getuid === "function"
    && directoryStat.uid !== process.getuid()) {
    throw new Error(`runtime_sqlite_directory_owner_invalid:${directory}`);
  }
  if (process.platform !== "win32"
    && (directoryStat.mode & 0o7777) !== PRIVATE_RUNTIME_DIRECTORY_MODE) {
    throw new Error(
      `runtime_sqlite_directory_mode_invalid:${directory}:${(directoryStat.mode & 0o7777).toString(8)}`,
    );
  }
  assertPrivateRuntimeSqliteArtifactMode(path, PRIVATE_RUNTIME_SQLITE_MODE, true);
  for (const artifact of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    assertPrivateRuntimeSqliteArtifactMode(artifact, PRIVATE_RUNTIME_SQLITE_MODE);
  }
}

/** Opens a Runtime authority database with an owner-only creation contract. */
export function createPrivateRuntimeSqliteDatabase(path: string): SqliteDatabase {
  const mod = loadSqliteModule();
  if (!mod) throw nodeSqliteSupportError();
  preparePrivateRuntimeSqlitePath(path);
  const db = new mod.DatabaseSync(path);
  try {
    // Revalidate immediately after SQLite opens the pathname and before the
    // first SQL statement. This narrows the remaining same-UID swap window
    // without opening another descriptor or disturbing SQLite's locks.
    assertPrivateRuntimeSqliteArtifactModes(path);
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
    assertPrivateRuntimeSqliteArtifactModes(path);
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
