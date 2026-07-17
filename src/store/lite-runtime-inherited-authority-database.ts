import { createHash, randomBytes } from "node:crypto";
import {
  fstatSync,
  readSync,
  statSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute } from "node:path";

import {
  createSqliteImmutableReadOnlyDatabase,
  type SqliteDatabase,
} from "./sqlite.js";
import {
  createSqliteTransactionRunner,
  type SqliteTransactionRunner,
} from "./sqlite-transaction-runner.js";
import type { LiteRuntimeDatabase } from "./lite-runtime-database.js";

export const LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_FD = 3 as const;
export const LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_MIN_NODE_VERSION =
  "22.15.0" as const;

const HASH_CHUNK_BYTES = 1024 * 1024;
const EMPTY_WRITE_PROBE = Buffer.alloc(0);

export type LiteRuntimeInheritedAuthorityDatabaseErrorCode =
  | "lite_runtime_inherited_authority_database_platform_unsupported"
  | "lite_runtime_inherited_authority_database_descriptor_required"
  | "lite_runtime_inherited_authority_database_descriptor_untrusted"
  | "lite_runtime_inherited_authority_database_descriptor_not_read_only"
  | "lite_runtime_inherited_authority_database_descriptor_read_failed"
  | "lite_runtime_inherited_authority_database_identity_changed"
  | "lite_runtime_inherited_authority_database_already_adopted"
  | "lite_runtime_inherited_authority_database_capability_invalid"
  | "lite_runtime_inherited_authority_database_capability_closed"
  | "lite_runtime_inherited_authority_database_open_failed"
  | "lite_runtime_inherited_authority_database_already_open"
  | "lite_runtime_inherited_authority_database_binding_invalid"
  | "lite_runtime_inherited_authority_database_transaction_capability_invalid"
  | "lite_runtime_inherited_authority_database_transaction_required"
  | "lite_runtime_inherited_authority_database_transaction_active"
  | "lite_runtime_inherited_authority_database_transaction_already_consumed"
  | "lite_runtime_inherited_authority_database_close_failed";

export class LiteRuntimeInheritedAuthorityDatabaseError extends Error {
  readonly code: LiteRuntimeInheritedAuthorityDatabaseErrorCode;

  constructor(code: LiteRuntimeInheritedAuthorityDatabaseErrorCode, message: string) {
    super(message);
    this.name = "LiteRuntimeInheritedAuthorityDatabaseError";
    this.code = code;
  }
}

function boundaryError(
  code: LiteRuntimeInheritedAuthorityDatabaseErrorCode,
  message: string,
): never {
  throw new LiteRuntimeInheritedAuthorityDatabaseError(code, message);
}

const databaseCapabilityBrand: unique symbol = Symbol(
  "lite-runtime-inherited-authority-database-capability",
);

/**
 * One-shot, process-local authority over the database descriptor inherited in
 * the fixed fd 3 slot. The module-private WeakMap is the runtime brand; this
 * symbol only prevents accidental structural construction in TypeScript.
 *
 * This capability proves neither launcher provenance nor a launcher-held
 * writer fence and is therefore never signing authority by itself.
 */
export type LiteRuntimeInheritedAuthorityDatabaseCapability = Readonly<{
  [databaseCapabilityBrand]:
    "aionis_lite_runtime_inherited_authority_database_capability_v1";
}>;

const transactionCapabilityBrand: unique symbol = Symbol(
  "lite-runtime-inherited-authority-database-transaction-capability",
);

/** Opaque authority for one active read-only snapshot transaction. */
export type LiteRuntimeInheritedAuthorityDatabaseTransactionCapability = Readonly<{
  [transactionCapabilityBrand]:
    "aionis_lite_runtime_inherited_authority_database_transaction_capability_v1";
}>;

export type LiteRuntimeInheritedAuthorityDatabaseInspection = Readonly<{
  contract_version:
    "aionis_lite_runtime_inherited_authority_database_inspection_v1";
  inherited_descriptor: 3;
  descriptor_namespace_path: string;
  database_file_device: string;
  database_file_inode: string;
  database_file_uid: string;
  database_file_gid: string;
  database_file_mode: string;
  database_file_link_count: 1;
  database_main_file_byte_length: string;
  database_main_file_sha256: string;
  descriptor_read_only_verified: true;
  sqlite_snapshot_mode: "ro_immutable";
  launcher_provenance: "not_established";
  launcher_write_fence: "not_established";
  wal_checkpoint: "not_established";
  signing_eligible: false;
}>;

type DescriptorIdentity = Readonly<{
  device: bigint;
  inode: bigint;
  uid: bigint;
  gid: bigint;
  mode: bigint;
  linkCount: bigint;
  byteLength: bigint;
}>;

type InheritedDatabaseState = {
  readonly descriptor: typeof LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_FD;
  readonly descriptorPath: string;
  readonly serviceUid: bigint;
  readonly identity: DescriptorIdentity;
  readonly mainFileSha256: string;
  readonly inspection: LiteRuntimeInheritedAuthorityDatabaseInspection;
  database: LiteRuntimeDatabase | null;
  transactionActive: boolean;
  transactionConsumed: boolean;
  closed: boolean;
};

type InheritedTransactionState = Readonly<{
  database: LiteRuntimeDatabase;
  transaction: SqliteTransactionRunner;
  transactionIdentity: symbol;
  sqliteSavepoint: string;
  databaseState: InheritedDatabaseState;
}>;

const databaseCapabilityRegistry = new WeakMap<object, InheritedDatabaseState>();
const databaseRegistry = new WeakMap<LiteRuntimeDatabase, InheritedDatabaseState>();
const transactionCapabilityRegistry = new WeakMap<object, InheritedTransactionState>();

// The formal attestor is a one-shot process. Never let a closed/reused fd 3 mint
// a second authority object in the same process.
let inheritedDescriptorAdopted = false;

function isErrnoCode(error: unknown, code: string): boolean {
  return !!error
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}

function assertSupportedNodeVersion(): void {
  const [majorText, minorText, patchText] = process.versions.node.split(".", 3);
  const version = [majorText, minorText, patchText].map((part) => Number(part));
  if (version.length !== 3
    || version.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_platform_unsupported",
      "inherited Runtime authority snapshots cannot verify the Node.js version",
    );
  }
  const [major, minor] = version as [number, number, number];
  const supported = major > 22 || (major === 22 && minor >= 15);
  if (!supported) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_platform_unsupported",
      `inherited Runtime authority snapshots require Node.js ${LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_MIN_NODE_VERSION} or newer`,
    );
  }
}

function descriptorNamespacePath(): string {
  if (process.platform === "linux") {
    return `/proc/self/fd/${LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_FD}`;
  }
  if (process.platform === "darwin") {
    return `/dev/fd/${LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_FD}`;
  }
  return boundaryError(
    "lite_runtime_inherited_authority_database_platform_unsupported",
    "inherited Runtime authority snapshots require Linux /proc/self/fd or macOS /dev/fd",
  );
}

function currentServiceUid(): bigint {
  if (typeof process.getuid !== "function") {
    return boundaryError(
      "lite_runtime_inherited_authority_database_platform_unsupported",
      "inherited Runtime authority snapshots cannot verify the service UID",
    );
  }
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_platform_unsupported",
      "inherited Runtime authority snapshots received an unsafe service UID",
    );
  }
  return BigInt(uid);
}

function requiredDescriptorStat(): BigIntStats {
  try {
    return fstatSync(LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_FD, { bigint: true });
  } catch {
    return boundaryError(
      "lite_runtime_inherited_authority_database_descriptor_required",
      "the Runtime authority database must be inherited in fixed descriptor slot 3",
    );
  }
}

function identityFromStat(stat: BigIntStats): DescriptorIdentity {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    linkCount: stat.nlink,
    byteLength: stat.size,
  });
}

function assertTrustedDescriptor(stat: BigIntStats, serviceUid: bigint): void {
  if (!stat.isFile()
    || stat.uid !== serviceUid
    || (stat.mode & 0o022n) !== 0n
    || stat.nlink !== 1n
    || stat.size < 0n) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_descriptor_untrusted",
      "inherited Runtime authority descriptor must be an owner-controlled, single-link regular file without group/other write authority",
    );
  }
}

function sameDescriptorIdentity(
  expected: DescriptorIdentity,
  actual: DescriptorIdentity,
): boolean {
  return expected.device === actual.device
    && expected.inode === actual.inode
    && expected.uid === actual.uid
    && expected.gid === actual.gid
    && expected.mode === actual.mode
    && expected.linkCount === actual.linkCount
    && expected.byteLength === actual.byteLength;
}

function assertReadOnlyDescriptor(): void {
  try {
    const bytesWritten = writeSync(
      LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_FD,
      EMPTY_WRITE_PROBE,
      0,
      0,
      0,
    );
    return boundaryError(
      "lite_runtime_inherited_authority_database_descriptor_not_read_only",
      `inherited Runtime authority descriptor accepted a write probe (${bytesWritten} bytes)`,
    );
  } catch (error) {
    if (error instanceof LiteRuntimeInheritedAuthorityDatabaseError) throw error;
    // POSIX write(2) reports EBADF when a valid regular descriptor was opened
    // without write access. The zero-byte probe cannot alter file contents.
    if (isErrnoCode(error, "EBADF")) return;
    return boundaryError(
      "lite_runtime_inherited_authority_database_descriptor_not_read_only",
      "inherited Runtime authority descriptor read-only access mode could not be verified",
    );
  }
}

function hashDescriptor(expectedByteLength: bigint): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let position = 0n;
  try {
    while (position < expectedByteLength) {
      const remaining = expectedByteLength - position;
      const requested = Number(
        remaining > BigInt(buffer.byteLength) ? BigInt(buffer.byteLength) : remaining,
      );
      const bytesRead = readSync(
        LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_FD,
        buffer,
        0,
        requested,
        position,
      );
      if (bytesRead <= 0 || bytesRead > requested) {
        return boundaryError(
          "lite_runtime_inherited_authority_database_descriptor_read_failed",
          "inherited Runtime authority descriptor ended before its declared byte length",
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += BigInt(bytesRead);
    }
  } catch (error) {
    if (error instanceof LiteRuntimeInheritedAuthorityDatabaseError) throw error;
    return boundaryError(
      "lite_runtime_inherited_authority_database_descriptor_read_failed",
      "inherited Runtime authority descriptor could not be hashed",
    );
  }
  if (position !== expectedByteLength) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_descriptor_read_failed",
      "inherited Runtime authority descriptor hash did not cover the complete main file",
    );
  }
  return hash.digest("hex");
}

function assertDescriptorSnapshot(state: InheritedDatabaseState): void {
  let before: BigIntStats;
  let after: BigIntStats;
  try {
    before = fstatSync(state.descriptor, { bigint: true });
  } catch {
    return boundaryError(
      "lite_runtime_inherited_authority_database_identity_changed",
      "inherited Runtime authority descriptor is no longer valid",
    );
  }
  if (!sameDescriptorIdentity(state.identity, identityFromStat(before))) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_identity_changed",
      "inherited Runtime authority descriptor identity or trust state changed",
    );
  }
  assertReadOnlyDescriptor();
  assertTrustedDescriptor(before, state.serviceUid);
  const mainFileSha256 = hashDescriptor(state.identity.byteLength);
  try {
    after = fstatSync(state.descriptor, { bigint: true });
  } catch {
    return boundaryError(
      "lite_runtime_inherited_authority_database_identity_changed",
      "inherited Runtime authority descriptor changed while its main file was hashed",
    );
  }
  if (!sameDescriptorIdentity(state.identity, identityFromStat(after))
    || mainFileSha256 !== state.mainFileSha256) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_identity_changed",
      "inherited Runtime authority main file changed after descriptor adoption",
    );
  }
  assertReadOnlyDescriptor();
}

function requiredState(capability: unknown): InheritedDatabaseState {
  if ((typeof capability !== "object" && typeof capability !== "function")
    || capability === null) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_capability_invalid",
      "inherited Runtime authority database capability is invalid",
    );
  }
  const state = databaseCapabilityRegistry.get(capability);
  if (!state) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_capability_invalid",
      "inherited Runtime authority database capability is invalid",
    );
  }
  if (state.closed) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_capability_closed",
      "inherited Runtime authority database capability is closed",
    );
  }
  return state;
}

function inspectionFrom(
  descriptorPath: string,
  identity: DescriptorIdentity,
  mainFileSha256: string,
): LiteRuntimeInheritedAuthorityDatabaseInspection {
  return Object.freeze({
    contract_version:
      "aionis_lite_runtime_inherited_authority_database_inspection_v1",
    inherited_descriptor: LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_FD,
    descriptor_namespace_path: descriptorPath,
    database_file_device: identity.device.toString(10),
    database_file_inode: identity.inode.toString(10),
    database_file_uid: identity.uid.toString(10),
    database_file_gid: identity.gid.toString(10),
    database_file_mode: (identity.mode & 0o7777n).toString(10),
    database_file_link_count: 1,
    database_main_file_byte_length: identity.byteLength.toString(10),
    database_main_file_sha256: mainFileSha256,
    descriptor_read_only_verified: true,
    sqlite_snapshot_mode: "ro_immutable",
    launcher_provenance: "not_established",
    launcher_write_fence: "not_established",
    wal_checkpoint: "not_established",
    signing_eligible: false,
  });
}

/**
 * Adopts exactly one read-only database descriptor from fixed fd 3. There is no
 * fd or pathname argument: caller argv cannot select or reconstruct authority.
 */
export function adoptLiteRuntimeInheritedAuthorityDatabase(
): LiteRuntimeInheritedAuthorityDatabaseCapability {
  if (inheritedDescriptorAdopted) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_already_adopted",
      "the inherited Runtime authority descriptor is one-shot within this process",
    );
  }
  // Burn the one-shot adoption before inspecting fd 3. A failed or raced
  // descriptor must not be replaceable with another file inside this process.
  inheritedDescriptorAdopted = true;

  // node:sqlite did not accept URL inputs until Node.js 22.15.0. The immutable
  // read-only file: URI is part of this authority boundary, so older supported
  // Runtime releases must fail closed instead of falling back to a pathname.
  assertSupportedNodeVersion();
  const descriptorPath = descriptorNamespacePath();
  const serviceUid = currentServiceUid();
  const before = requiredDescriptorStat();
  assertTrustedDescriptor(before, serviceUid);
  assertReadOnlyDescriptor();
  const identity = identityFromStat(before);
  const mainFileSha256 = hashDescriptor(identity.byteLength);
  const after = requiredDescriptorStat();
  if (!sameDescriptorIdentity(identity, identityFromStat(after))) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_identity_changed",
      "inherited Runtime authority descriptor changed during adoption",
    );
  }

  const capability = Object.freeze(Object.create(null)) as
    LiteRuntimeInheritedAuthorityDatabaseCapability;
  const state: InheritedDatabaseState = {
    descriptor: LITE_RUNTIME_INHERITED_AUTHORITY_DATABASE_FD,
    descriptorPath,
    serviceUid,
    identity,
    mainFileSha256,
    inspection: inspectionFrom(descriptorPath, identity, mainFileSha256),
    database: null,
    transactionActive: false,
    transactionConsumed: false,
    closed: false,
  };
  databaseCapabilityRegistry.set(capability, state);
  try {
    assertDescriptorSnapshot(state);
    return capability;
  } catch (error) {
    state.closed = true;
    // fd 3 is inherited process state, not an owned descriptor. The one-shot
    // attestor process closes it on exit; this module must never close a reused
    // descriptor number while reporting the original integrity failure.
    throw error;
  }
}

export function inspectLiteRuntimeInheritedAuthorityDatabase(
  capability: LiteRuntimeInheritedAuthorityDatabaseCapability,
): LiteRuntimeInheritedAuthorityDatabaseInspection {
  return requiredState(capability).inspection;
}

export function assertLiteRuntimeInheritedAuthorityDatabase(
  capability: LiteRuntimeInheritedAuthorityDatabaseCapability,
): LiteRuntimeInheritedAuthorityDatabaseInspection {
  const state = requiredState(capability);
  assertDescriptorSnapshot(state);
  return state.inspection;
}

function assertSqliteMainBoundToDescriptor(
  db: SqliteDatabase,
  state: InheritedDatabaseState,
): void {
  let rows: unknown[];
  try {
    rows = db.prepare("PRAGMA database_list").all();
  } catch {
    return boundaryError(
      "lite_runtime_inherited_authority_database_binding_invalid",
      "inherited Runtime authority snapshot could not inspect SQLite main",
    );
  }
  const mainRows = rows.filter((row): row is Readonly<Record<string, unknown>> => (
    !!row
      && typeof row === "object"
      && !Array.isArray(row)
      && (row as Readonly<Record<string, unknown>>).name === "main"
  ));
  const auxiliaryRowsValid = rows.every((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const record = row as Readonly<Record<string, unknown>>;
    // SQLite may materialize its pathless private temp schema while executing
    // verification queries. Any file-backed or caller-attached schema remains
    // forbidden.
    return record.name === "main"
      || (record.name === "temp" && record.file === "");
  });
  if (!auxiliaryRowsValid
    || mainRows.length !== 1
    || typeof mainRows[0]!.file !== "string"
    || !isAbsolute(mainRows[0]!.file)) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_binding_invalid",
      "inherited Runtime authority snapshot has an invalid SQLite main binding",
    );
  }

  // macOS fdesc exposes the same vnode through /dev/fd but reports the fdesc
  // mount's device/mode through stat(2). An exact fixed descriptor path is the
  // stronger binding there. Linux may canonicalize /proc/self/fd to the source
  // pathname, so a different reported path must still name the frozen object.
  if (mainRows[0]!.file !== state.descriptorPath) {
    let mainStat: BigIntStats;
    try {
      mainStat = statSync(mainRows[0]!.file, { bigint: true });
    } catch {
      return boundaryError(
        "lite_runtime_inherited_authority_database_binding_invalid",
        "inherited Runtime authority SQLite main no longer names the inherited file",
      );
    }
    if (!sameDescriptorIdentity(state.identity, identityFromStat(mainStat))) {
      return boundaryError(
        "lite_runtime_inherited_authority_database_binding_invalid",
        "inherited Runtime authority SQLite main does not match descriptor identity",
      );
    }
  }
}

function assertSqliteSnapshotHealth(db: SqliteDatabase): void {
  const rows = db.prepare("PRAGMA quick_check(1)").all();
  const values = rows.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    return Object.values(row as Readonly<Record<string, unknown>>);
  });
  if (rows.length !== 1 || values.length !== 1 || values[0] !== "ok") {
    return boundaryError(
      "lite_runtime_inherited_authority_database_open_failed",
      "inherited Runtime authority SQLite main failed quick_check",
    );
  }
}

function createReadOnlySnapshotRuntimeDatabase(
  state: InheritedDatabaseState,
): LiteRuntimeDatabase {
  const db = createSqliteImmutableReadOnlyDatabase(state.descriptorPath);
  try {
    db.exec(`
      PRAGMA query_only = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA foreign_keys = ON;
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  const transaction = createSqliteTransactionRunner({
    // The deployment launcher write fence is a later capability. This local
    // BEGIN establishes a stable SQLite read snapshot and AsyncLocal owner; the
    // secret savepoint installed by the formal runner below binds capability
    // checks to that exact SQLite transaction. Neither is an external fence.
    begin: () => db.exec("BEGIN"),
    commit: () => db.exec("COMMIT"),
    rollback: () => db.exec("ROLLBACK"),
  });
  let closed = false;
  return {
    path: state.descriptorPath,
    db,
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

/** Opens SQLite from the inherited descriptor namespace, never an argv path. */
export function openLiteRuntimeInheritedAuthorityDatabaseSnapshot(
  capability: LiteRuntimeInheritedAuthorityDatabaseCapability,
): LiteRuntimeDatabase {
  const state = requiredState(capability);
  if (state.database !== null) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_already_open",
      "inherited Runtime authority snapshot can be opened only once",
    );
  }
  assertDescriptorSnapshot(state);
  let database: LiteRuntimeDatabase | null = null;
  try {
    database = createReadOnlySnapshotRuntimeDatabase(state);
    assertSqliteMainBoundToDescriptor(database.db, state);
    assertSqliteSnapshotHealth(database.db);
    assertDescriptorSnapshot(state);
    state.database = database;
    databaseRegistry.set(database, state);
    return database;
  } catch (error) {
    if (database) void database.close().catch(() => undefined);
    if (error instanceof LiteRuntimeInheritedAuthorityDatabaseError) throw error;
    return boundaryError(
      "lite_runtime_inherited_authority_database_open_failed",
      "inherited Runtime authority descriptor could not open a read-only immutable SQLite snapshot",
    );
  }
}

function assertDatabaseBoundToState(
  state: InheritedDatabaseState,
  database: LiteRuntimeDatabase,
): void {
  if (state.database !== database
    || databaseRegistry.get(database) !== state
    || database.path !== state.descriptorPath
    || database.readDb !== database.db) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_binding_invalid",
      "inherited Runtime authority transaction requires its exact snapshot database",
    );
  }
  assertSqliteMainBoundToDescriptor(database.db, state);
}

export function assertLiteRuntimeInheritedAuthorityDatabaseTransactionCapability(
  capability: LiteRuntimeInheritedAuthorityDatabaseTransactionCapability,
  database: LiteRuntimeDatabase,
): void {
  if ((typeof capability !== "object" && typeof capability !== "function")
    || capability === null) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_transaction_capability_invalid",
      "inherited Runtime authority transaction capability is invalid",
    );
  }
  const transactionState = transactionCapabilityRegistry.get(capability);
  if (!transactionState) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_transaction_capability_invalid",
      "inherited Runtime authority transaction capability is invalid or revoked",
    );
  }
  const databaseState = transactionState.databaseState;
  if (databaseState.closed
    || transactionState.database !== database
    || transactionState.transaction !== database.transaction
    || databaseRegistry.get(database) !== databaseState) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_transaction_capability_invalid",
      "inherited Runtime authority transaction capability belongs to another database",
    );
  }
  if (!databaseState.transactionActive
    || !database.transaction.inTransaction()
    || database.transaction.currentTransactionIdentity()
      !== transactionState.transactionIdentity) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_transaction_required",
      "inherited Runtime authority transaction capability is outside its snapshot scope",
    );
  }
  assertDatabaseBoundToState(databaseState, database);
  try {
    // AsyncLocal ownership alone cannot detect `ROLLBACK; BEGIN` issued through
    // the raw SQLite handle. This secret savepoint belongs to the exact BEGIN
    // established by the formal runner and disappears on any transaction
    // restart. ROLLBACK TO is read-only here and keeps the guard alive.
    database.db.exec(
      `ROLLBACK TO SAVEPOINT "${transactionState.sqliteSavepoint}"`,
    );
  } catch {
    return boundaryError(
      "lite_runtime_inherited_authority_database_transaction_capability_invalid",
      "inherited Runtime authority transaction was replaced or its snapshot guard was lost",
    );
  }
  assertDescriptorSnapshot(databaseState);
}

/**
 * Runs one read-only immutable SQLite snapshot. The transaction capability is
 * revoked before this function resolves and cannot be reused by another scope.
 */
export async function runLiteRuntimeInheritedAuthorityDatabaseSnapshotTransaction<T>(
  capability: LiteRuntimeInheritedAuthorityDatabaseCapability,
  database: LiteRuntimeDatabase,
  fn: (
    transactionCapability:
      LiteRuntimeInheritedAuthorityDatabaseTransactionCapability,
  ) => Promise<T>,
): Promise<T> {
  const state = requiredState(capability);
  assertDatabaseBoundToState(state, database);
  assertDescriptorSnapshot(state);
  if (state.transactionActive) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_transaction_active",
      "inherited Runtime authority snapshot already has an active transaction",
    );
  }
  if (database.transaction.inTransaction()
    || database.transaction.currentTransactionIdentity() !== null) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_transaction_active",
      "inherited Runtime authority snapshot must own its outermost transaction",
    );
  }
  if (state.transactionConsumed) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_transaction_already_consumed",
      "inherited Runtime authority snapshot transaction is one-shot and already consumed",
    );
  }

  // Burn the transaction authority before the queued SQLite BEGIN. A failed
  // BEGIN, callback, integrity check, or commit cannot be retried against a
  // different state, and close remains fenced for the complete queued scope.
  state.transactionConsumed = true;
  state.transactionActive = true;

  try {
    const result = await database.transaction.run(async () => {
      const transactionIdentity = database.transaction.currentTransactionIdentity();
      if (transactionIdentity === null || !database.transaction.inTransaction()) {
        return boundaryError(
          "lite_runtime_inherited_authority_database_transaction_required",
          "inherited Runtime authority snapshot did not enter a transaction",
        );
      }
      const sqliteSavepoint = `aionis_inherited_snapshot_${randomBytes(32).toString("hex")}`;
      try {
        database.db.exec(`SAVEPOINT "${sqliteSavepoint}"`);
      } catch {
        return boundaryError(
          "lite_runtime_inherited_authority_database_transaction_required",
          "inherited Runtime authority snapshot could not establish its SQLite transaction guard",
        );
      }
      const transactionCapability = Object.freeze(Object.create(null)) as
        LiteRuntimeInheritedAuthorityDatabaseTransactionCapability;
      transactionCapabilityRegistry.set(transactionCapability, {
        database,
        transaction: database.transaction,
        transactionIdentity,
        sqliteSavepoint,
        databaseState: state,
      });
      try {
        const output = await fn(transactionCapability);
        assertLiteRuntimeInheritedAuthorityDatabaseTransactionCapability(
          transactionCapability,
          database,
        );
        return output;
      } finally {
        transactionCapabilityRegistry.delete(transactionCapability);
      }
    });
    assertDescriptorSnapshot(state);
    return result;
  } finally {
    state.transactionActive = false;
    if (!state.closed) assertDescriptorSnapshot(state);
  }
}

/**
 * Revokes the one-shot capability and closes SQLite. Inherited fd 3 remains a
 * borrowed process-lifetime descriptor and is closed only when the one-shot
 * attestor process exits; closing its numeric slot here could close an
 * unrelated descriptor after caller misuse or reuse.
 */
export async function closeLiteRuntimeInheritedAuthorityDatabase(
  capability: LiteRuntimeInheritedAuthorityDatabaseCapability,
): Promise<void> {
  if ((typeof capability !== "object" && typeof capability !== "function")
    || capability === null) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_capability_invalid",
      "inherited Runtime authority database capability is invalid",
    );
  }
  const state = databaseCapabilityRegistry.get(capability);
  if (!state) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_capability_invalid",
      "inherited Runtime authority database capability is invalid",
    );
  }
  if (state.closed) return;
  if (state.transactionActive) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_transaction_active",
      "inherited Runtime authority database cannot close during its snapshot transaction",
    );
  }

  let integrityError: unknown = null;
  try {
    assertDescriptorSnapshot(state);
  } catch (error) {
    integrityError = error;
  }

  // Revoke before closing owned SQLite state. Even an ambiguous close failure
  // must never leave a live capability that can follow a reused fd number.
  state.closed = true;
  const database = state.database;
  state.database = null;
  if (database) databaseRegistry.delete(database);

  let closeError: unknown = null;
  if (database) {
    try {
      await database.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (integrityError) throw integrityError;
  if (closeError) {
    return boundaryError(
      "lite_runtime_inherited_authority_database_close_failed",
      "inherited Runtime authority database could not close all owned resources",
    );
  }
}
