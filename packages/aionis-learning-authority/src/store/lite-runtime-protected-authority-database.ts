import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

import {
  createLiteRuntimeProtectedWriteDatabase,
  type LiteRuntimeDatabase,
  type LiteRuntimeDatabaseFaultInjector,
} from "../../../../src/store/lite-runtime-database.js";
import type { SqliteTransactionRunOptions } from
  "../../../../src/store/sqlite-transaction-runner.js";

export type LiteRuntimeProtectedAuthorityDatabaseErrorCode =
  | "lite_runtime_protected_authority_database_absolute_path_required"
  | "lite_runtime_protected_authority_database_required"
  | "lite_runtime_protected_authority_database_platform_unsupported"
  | "lite_runtime_protected_authority_database_filesystem_untrusted"
  | "lite_runtime_protected_authority_database_recovery_required"
  | "lite_runtime_protected_authority_database_identity_changed"
  | "lite_runtime_protected_authority_database_open_failed"
  | "lite_runtime_protected_authority_database_pin_invalid"
  | "lite_runtime_protected_authority_database_pin_closed"
  | "lite_runtime_protected_authority_transaction_capability_invalid"
  | "lite_runtime_protected_authority_transaction_required";

export class LiteRuntimeProtectedAuthorityDatabaseError extends Error {
  readonly code: LiteRuntimeProtectedAuthorityDatabaseErrorCode;

  constructor(code: LiteRuntimeProtectedAuthorityDatabaseErrorCode, message: string) {
    super(message);
    this.name = "LiteRuntimeProtectedAuthorityDatabaseError";
    this.code = code;
  }
}

function boundaryError(
  code: LiteRuntimeProtectedAuthorityDatabaseErrorCode,
  message: string,
): never {
  throw new LiteRuntimeProtectedAuthorityDatabaseError(code, message);
}

const pinBrand: unique symbol = Symbol("lite-runtime-protected-authority-database-pin");

/**
 * Opaque read-only descriptor capability for one already-existing Runtime DB.
 * The private WeakMap registry below is the runtime authority; the symbol brand
 * only prevents accidental structural construction in TypeScript.
 */
export type LiteRuntimeProtectedAuthorityDatabasePin = Readonly<{
  [pinBrand]: "aionis_lite_runtime_protected_authority_database_pin_v1";
}>;

export type LiteRuntimeProtectedAuthorityDatabaseInspection = Readonly<{
  contract_version: "aionis_lite_runtime_protected_authority_database_inspection_v1";
  requested_path: string;
  database_realpath: string;
  database_device: number;
  database_inode: number;
  database_uid: number;
  database_gid: number;
  database_mode: number;
  database_link_count: 1;
  wal_present: boolean;
  shared_memory_present: boolean;
  rollback_journal_present: false;
}>;

type PinState = {
  readonly requestedPath: string;
  readonly realpath: string;
  readonly descriptor: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly serviceUid: bigint;
  closed: boolean;
  inspection: LiteRuntimeProtectedAuthorityDatabaseInspection;
};

const pinRegistry = new WeakMap<object, PinState>();
const protectedDatabaseRegistry = new WeakMap<LiteRuntimeDatabase, PinState>();

const protectedTransactionBrand: unique symbol = Symbol(
  "lite-runtime-protected-authority-transaction-capability",
);

/**
 * Opaque authority for one active BEGIN IMMEDIATE scope on one database opened
 * through this protected boundary. The private WeakMap is the runtime brand;
 * the symbol only prevents accidental structural construction in TypeScript.
 */
export type LiteRuntimeProtectedAuthorityTransactionCapability = Readonly<{
  [protectedTransactionBrand]:
    "aionis_lite_runtime_protected_authority_transaction_capability_v1";
}>;

type ProtectedTransactionState = Readonly<{
  database: LiteRuntimeDatabase;
  transaction: LiteRuntimeDatabase["transaction"];
  transactionIdentity: symbol;
  pinState: PinState;
}>;

const protectedTransactionRegistry = new WeakMap<object, ProtectedTransactionState>();
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

type SqliteSidecarState = Readonly<{
  walPresent: boolean;
  sharedMemoryPresent: boolean;
  rollbackJournalPresent: boolean;
}>;

type FilesystemAclInspectionContext = Readonly<{
  object:
    | "database"
    | "sidecar"
    | "direct_parent"
    | "ancestor"
    | "receipt"
    | "receipt_temp";
}>;

type LinuxAclEntryKind =
  | "default"
  | "duplicate_base"
  | "effective_comment"
  | "flags"
  | "incomplete_base"
  | "mask"
  | "mode_mismatch"
  | "named_group"
  | "named_user"
  | "unparseable"
  | "verifier_failure";

type ParsedLinuxDefaultAclEntry = Readonly<{
  tag: "user" | "group" | "mask" | "other";
  qualifier: string | null;
}>;

const LINUX_ACL_DIAGNOSTIC_PRIORITY: readonly LinuxAclEntryKind[] = [
  "default",
  "named_user",
  "named_group",
  "mask",
  "flags",
  "duplicate_base",
  "effective_comment",
  "unparseable",
] as const;

const ACL_INSPECTION_ENV = {
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
} as const;

function filesystemTrustError(message: string): never {
  return boundaryError(
    "lite_runtime_protected_authority_database_filesystem_untrusted",
    message,
  );
}

function identityChangedError(message: string): never {
  return boundaryError(
    "lite_runtime_protected_authority_database_identity_changed",
    message,
  );
}

function closeDescriptorBestEffort(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Cleanup must preserve the boundary error that caused the descriptor to close.
  }
}

function currentServiceUid(): bigint {
  if (typeof process.getuid !== "function") {
    return boundaryError(
      "lite_runtime_protected_authority_database_platform_unsupported",
      "protected Runtime authority database cannot verify the service UID on this platform",
    );
  }
  const serviceUid = process.getuid();
  if (!Number.isSafeInteger(serviceUid) || serviceUid < 0) {
    return boundaryError(
      "lite_runtime_protected_authority_database_platform_unsupported",
      "protected Runtime authority database received an unsafe service UID",
    );
  }
  return BigInt(serviceUid);
}

function linuxAclTrustError(
  context: FilesystemAclInspectionContext,
  entryKind: LinuxAclEntryKind,
  message: string,
): never {
  return filesystemTrustError(
    `${message} [object=${context.object} entry_kind=${entryKind}]`,
  );
}

function classifyRejectedLinuxAclEntry(entry: string): LinuxAclEntryKind {
  if (/^#\s*flags:/u.test(entry)) return "flags";
  if (/^mask::/u.test(entry)) return "mask";
  if (/^user:[^:]+:/u.test(entry)) return "named_user";
  if (/^group:[^:]+:/u.test(entry)) return "named_group";
  if (/\s+#effective:/u.test(entry)) return "effective_comment";
  return "unparseable";
}

function parseLinuxDefaultAclEntry(entry: string): ParsedLinuxDefaultAclEntry | null {
  const match = /^default:(user|group|mask|other):([^:]*):([r-][w-][x-])$/u
    .exec(entry);
  if (!match) return null;
  const tag = match[1] as ParsedLinuxDefaultAclEntry["tag"];
  const rawQualifier = match[2]!;
  if (tag === "mask" || tag === "other") {
    return rawQualifier.length === 0 ? { tag, qualifier: null } : null;
  }
  if (rawQualifier.length === 0) return { tag, qualifier: null };
  if (!/^(?:0|[1-9][0-9]*)$/u.test(rawQualifier)) return null;
  return { tag, qualifier: rawQualifier };
}

function isCompleteLinuxDefaultAcl(entries: readonly string[]): boolean {
  const parsed = entries.map(parseLinuxDefaultAclEntry);
  if (parsed.some((entry) => entry === null)) return false;
  const complete = parsed as ParsedLinuxDefaultAclEntry[];
  const keys = new Set<string>();
  for (const entry of complete) {
    const key = `${entry.tag}:${entry.qualifier ?? ""}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  const namedEntryCount = complete.filter((entry) => entry.qualifier !== null).length;
  return keys.has("user:")
    && keys.has("group:")
    && keys.has("other:")
    && (namedEntryCount === 0 || keys.has("mask:"));
}

function assertLinuxBasicAccessControlList(
  path: string,
  context: FilesystemAclInspectionContext,
): void {
  let inspected: ReturnType<typeof spawnSync> | null = null;
  for (const executable of ["/usr/bin/getfacl", "/bin/getfacl"] as const) {
    const candidate = spawnSync(executable, ["-c", "-E", "-p", "-n", "--", path], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: ACL_INSPECTION_ENV,
    });
    if (candidate.error
      && "code" in candidate.error
      && candidate.error.code === "ENOENT") {
      continue;
    }
    inspected = candidate;
    break;
  }
  if (!inspected
    || inspected.error
    || inspected.status !== 0
    || inspected.signal !== null
    || typeof inspected.stdout !== "string"
    || typeof inspected.stderr !== "string"
    || inspected.stderr.trim().length !== 0
    || inspected.stdout.includes("\ufffd")) {
    return linuxAclTrustError(
      context,
      "verifier_failure",
      "protected Runtime authority database requires a working Linux getfacl verifier",
    );
  }

  const entries = inspected.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const baseAcl = new Map<"user" | "group" | "other", string>();
  const defaultAclEntries: string[] = [];
  const rejectedKinds = new Set<LinuxAclEntryKind>();
  for (const entry of entries) {
    if (entry.startsWith("default:")) {
      defaultAclEntries.push(entry);
      continue;
    }
    const match = /^(user|group|other)::([r-][w-][x-])$/u.exec(entry);
    if (!match) {
      rejectedKinds.add(classifyRejectedLinuxAclEntry(entry));
      continue;
    }
    const baseKind = match[1] as "user" | "group" | "other";
    if (baseAcl.has(baseKind)) {
      rejectedKinds.add("duplicate_base");
      continue;
    }
    baseAcl.set(baseKind, match[2]!);
  }
  if (defaultAclEntries.length > 0
    && (context.object !== "ancestor"
      || !isCompleteLinuxDefaultAcl(defaultAclEntries))) {
    rejectedKinds.add("default");
  }
  if (rejectedKinds.size > 0) {
    const entryKind = LINUX_ACL_DIAGNOSTIC_PRIORITY.find(
      (candidate) => rejectedKinds.has(candidate),
    ) ?? "unparseable";
    return linuxAclTrustError(
      context,
      entryKind,
      "protected Runtime authority database rejects non-basic Linux ACLs",
    );
  }
  if (baseAcl.size !== 3) {
    return linuxAclTrustError(
      context,
      "incomplete_base",
      "protected Runtime authority database received an incomplete Linux ACL",
    );
  }
  let mode: bigint;
  try {
    mode = lstatSync(path, { bigint: true }).mode;
  } catch {
    return filesystemTrustError(
      `protected Runtime authority database ${context.object} changed during ACL inspection`,
    );
  }
  const permissionText = (read: bigint, write: bigint, execute: bigint): string => (
    `${(mode & read) !== 0n ? "r" : "-"}${(mode & write) !== 0n ? "w" : "-"}${(mode & execute) !== 0n ? "x" : "-"}`
  );
  if (baseAcl.get("user") !== permissionText(0o400n, 0o200n, 0o100n)
    || baseAcl.get("group") !== permissionText(0o040n, 0o020n, 0o010n)
    || baseAcl.get("other") !== permissionText(0o004n, 0o002n, 0o001n)) {
    return linuxAclTrustError(
      context,
      "mode_mismatch",
      "protected Runtime authority database ACL contradicts filesystem mode",
    );
  }
}

function assertDarwinNoDelegatedAccessControlList(path: string): void {
  const inspected = spawnSync("/bin/ls", ["-lde", "--", path], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: ACL_INSPECTION_ENV,
  });
  if (inspected.error
    || inspected.status !== 0
    || inspected.signal !== null
    || typeof inspected.stdout !== "string") {
    return filesystemTrustError(
      "protected Runtime authority database could not verify macOS filesystem ACLs",
    );
  }
  const modeToken = inspected.stdout.trimStart().split(/\s+/u, 1)[0] ?? "";
  if (!/^[bcdlps-][rwxStTs-]{9}[@.+]?$/u.test(modeToken)) {
    return filesystemTrustError(
      "protected Runtime authority database received an unverifiable macOS ACL result",
    );
  }
  const aclLines = inspected.stdout.split(/\r?\n/u).slice(1).filter(
    (line) => /^\s*\d+:/u.test(line),
  );
  const aclUnverifiable = aclLines.some((line) => !/\b(?:allow|deny)\b/u.test(line));
  const delegatesAuthority = aclLines.some((line) => /\ballow\b/u.test(line));
  if ((modeToken.includes("+") && aclLines.length === 0)
    || aclUnverifiable
    || delegatesAuthority) {
    return filesystemTrustError(
      "protected Runtime authority database rejects ACLs that delegate additional authority",
    );
  }
}

function assertNoDelegatedAccessControlList(
  path: string,
  context: FilesystemAclInspectionContext,
): void {
  if (process.platform === "linux") {
    assertLinuxBasicAccessControlList(path, context);
    return;
  }
  if (process.platform === "darwin") {
    assertDarwinNoDelegatedAccessControlList(path);
    return;
  }
  return boundaryError(
    "lite_runtime_protected_authority_database_platform_unsupported",
    "protected Runtime authority database cannot verify filesystem ACLs on this platform",
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertStablePathStat(
  path: string,
  before: BigIntStats,
  context: FilesystemAclInspectionContext,
): BigIntStats {
  let after: BigIntStats;
  try {
    after = lstatSync(path, { bigint: true });
  } catch {
    return filesystemTrustError(
      `protected Runtime authority database ${context.object} changed during inspection`,
    );
  }
  const directoryContext = context.object === "direct_parent"
    || context.object === "ancestor";
  if (!sameFileIdentity(before, after)
    || before.uid !== after.uid
    || before.gid !== after.gid
    || before.mode !== after.mode
    // A directory's link count legitimately changes when a concurrent process
    // creates or removes an unrelated child directory. It is not part of the
    // directory's authority identity; regular protected files still require a
    // stable link count.
    || (!directoryContext && before.nlink !== after.nlink)) {
    return filesystemTrustError(
      `protected Runtime authority database ${context.object} changed during inspection`,
    );
  }
  return after;
}

function assertTrustedDirectoryChain(databaseRealpath: string, serviceUid: bigint): void {
  let directory = dirname(databaseRealpath);
  let directParent = true;
  for (;;) {
    let before: BigIntStats;
    try {
      before = lstatSync(directory, { bigint: true });
    } catch {
      return filesystemTrustError(
        "protected Runtime authority database directory chain is unavailable",
      );
    }
    if (!before.isDirectory()
      || (before.mode & 0o022n) !== 0n
      || (before.uid !== serviceUid && before.uid !== 0n)
      || (directParent && before.uid !== serviceUid)) {
      return filesystemTrustError(
        "protected Runtime authority database requires an owner-controlled parent and non-writable owner/root ancestors",
      );
    }
    assertNoDelegatedAccessControlList(
      directory,
      { object: directParent ? "direct_parent" : "ancestor" },
    );
    assertStablePathStat(
      directory,
      before,
      { object: directParent ? "direct_parent" : "ancestor" },
    );
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
    directParent = false;
  }
}

/**
 * Internal shared filesystem boundary for protected operator artifacts. The
 * receipt publisher maps this module's fail-closed error into its own stable
 * operator error code; keeping the verifier here avoids a weaker second ACL
 * implementation.
 *
 * @internal
 */
export function assertLiteRuntimeProtectedFilesystemNoDelegatedAccessControlList(
  path: string,
  object: "receipt" | "receipt_temp",
): void {
  assertNoDelegatedAccessControlList(path, { object });
}

/** @internal Verifies the direct parent and every owner/root ancestor. */
export function assertLiteRuntimeProtectedFilesystemTrustedDirectoryChain(
  artifactPath: string,
  serviceUid: bigint,
): void {
  assertTrustedDirectoryChain(artifactPath, serviceUid);
}

function assertTrustedOwnedRegularFile(
  path: string,
  serviceUid: bigint,
  kind: "database" | "sidecar",
): BigIntStats {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    return filesystemTrustError(
      `protected Runtime authority database ${kind} is unavailable`,
    );
  }
  if (!before.isFile()
    || before.uid !== serviceUid
    || (before.mode & 0o022n) !== 0n
    || before.nlink !== 1n) {
    return filesystemTrustError(
      `protected Runtime authority database requires every ${kind} to be an owner-controlled, single-link regular file without group/other write authority`,
    );
  }
  assertNoDelegatedAccessControlList(path, { object: kind });
  return assertStablePathStat(path, before, { object: kind });
}

function optionalLstat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error
      && error.code === "ENOENT") return null;
    return filesystemTrustError(
      "protected Runtime authority database could not inspect a SQLite sidecar",
    );
  }
}

function inspectTrustedSqliteSidecars(
  databaseRealpath: string,
  serviceUid: bigint,
): SqliteSidecarState {
  const present = new Map<string, boolean>();
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${databaseRealpath}${suffix}`;
    const sidecar = optionalLstat(sidecarPath);
    present.set(suffix, sidecar !== null);
    if (sidecar !== null) {
      assertTrustedOwnedRegularFile(sidecarPath, serviceUid, "sidecar");
    }
  }
  const state = {
    walPresent: present.get("-wal") === true,
    sharedMemoryPresent: present.get("-shm") === true,
    rollbackJournalPresent: present.get("-journal") === true,
  };
  if (state.rollbackJournalPresent
    || state.walPresent !== state.sharedMemoryPresent) {
    return boundaryError(
      "lite_runtime_protected_authority_database_recovery_required",
      "protected Runtime authority database requires no rollback journal and either both or neither WAL/SHM sidecars",
    );
  }
  return state;
}

function requiredPinState(pin: unknown): PinState {
  if ((typeof pin !== "object" && typeof pin !== "function") || pin === null) {
    return boundaryError(
      "lite_runtime_protected_authority_database_pin_invalid",
      "protected Runtime authority database pin is invalid",
    );
  }
  const state = pinRegistry.get(pin);
  if (!state) {
    return boundaryError(
      "lite_runtime_protected_authority_database_pin_invalid",
      "protected Runtime authority database pin is invalid",
    );
  }
  if (state.closed) {
    return boundaryError(
      "lite_runtime_protected_authority_database_pin_closed",
      "protected Runtime authority database pin is closed",
    );
  }
  return state;
}

function resolveDatabaseRealpath(requestedPath: string): string {
  try {
    return realpathSync.native(requestedPath);
  } catch {
    return boundaryError(
      "lite_runtime_protected_authority_database_required",
      "protected Runtime authority database requires an existing filesystem entry",
    );
  }
}

function safeInspectionNumber(value: bigint, field: string): number {
  const numberValue = Number(value);
  if (value < 0n
    || !Number.isSafeInteger(numberValue)
    || BigInt(numberValue) !== value) {
    return filesystemTrustError(
      `protected Runtime authority database cannot safely represent ${field}`,
    );
  }
  return numberValue;
}

function inspectionFrom(
  state: Pick<PinState, "requestedPath" | "realpath" | "device" | "inode">,
  databaseStat: BigIntStats,
  sidecars: SqliteSidecarState,
): LiteRuntimeProtectedAuthorityDatabaseInspection {
  return Object.freeze({
    contract_version: "aionis_lite_runtime_protected_authority_database_inspection_v1",
    requested_path: state.requestedPath,
    database_realpath: state.realpath,
    database_device: safeInspectionNumber(state.device, "database device identity"),
    database_inode: safeInspectionNumber(state.inode, "database inode identity"),
    database_uid: safeInspectionNumber(databaseStat.uid, "database owner UID"),
    database_gid: safeInspectionNumber(databaseStat.gid, "database owner GID"),
    database_mode: safeInspectionNumber(
      databaseStat.mode & 0o7777n,
      "database mode",
    ),
    database_link_count: 1,
    wal_present: sidecars.walPresent,
    shared_memory_present: sidecars.sharedMemoryPresent,
    rollback_journal_present: false,
  });
}

function assertProtectedDatabaseMainPath(
  database: LiteRuntimeDatabase,
  expectedRealpath: string,
): void {
  let rows: unknown[];
  try {
    rows = database.db.prepare("PRAGMA database_list").all();
  } catch {
    return boundaryError(
      "lite_runtime_protected_authority_database_open_failed",
      "protected Runtime authority database could not inspect the opened SQLite connection",
    );
  }
  const mainRows = rows.filter((row): row is Record<string, unknown> => (
    typeof row === "object"
      && row !== null
      && "name" in row
      && row.name === "main"
  ));
  if (mainRows.length !== 1
    || typeof mainRows[0]!.file !== "string"
    || mainRows[0]!.file.length === 0
    || !isAbsolute(mainRows[0]!.file)) {
    return identityChangedError(
      "protected Runtime authority database received an invalid SQLite main path",
    );
  }
  let mainRealpath: string;
  try {
    mainRealpath = realpathSync.native(mainRows[0]!.file);
  } catch {
    return identityChangedError(
      "protected Runtime authority database SQLite main path is no longer available",
    );
  }
  if (mainRealpath !== expectedRealpath) {
    return identityChangedError(
      "protected Runtime authority database SQLite main path does not match the pin",
    );
  }
}

function closeProtectedDatabaseBestEffort(database: LiteRuntimeDatabase): void {
  try {
    // The protected Runtime implementation closes its single SQLite handle
    // synchronously before returning this Promise. Preserve the boundary error
    // if a future implementation reports a close failure asynchronously.
    void database.close().catch(() => undefined);
  } catch {
    // Cleanup must not replace the stable boundary failure.
  }
}

function assertPinnedState(state: PinState): LiteRuntimeProtectedAuthorityDatabaseInspection {
  let descriptorStat: BigIntStats;
  try {
    descriptorStat = fstatSync(state.descriptor, { bigint: true });
  } catch {
    return identityChangedError(
      "protected Runtime authority database descriptor is no longer valid",
    );
  }
  if (!descriptorStat.isFile()
    || descriptorStat.dev !== state.device
    || descriptorStat.ino !== state.inode
    || descriptorStat.uid !== state.serviceUid
    || (descriptorStat.mode & 0o022n) !== 0n
    || descriptorStat.nlink !== 1n) {
    return identityChangedError(
      "protected Runtime authority database descriptor identity or trust state changed",
    );
  }

  let currentRealpath: string;
  try {
    currentRealpath = realpathSync.native(state.requestedPath);
  } catch {
    return identityChangedError(
      "protected Runtime authority database path no longer resolves to the pinned file",
    );
  }
  if (currentRealpath !== state.realpath) {
    return identityChangedError(
      "protected Runtime authority database realpath changed after pinning",
    );
  }
  const pathStat = assertTrustedOwnedRegularFile(
    state.realpath,
    state.serviceUid,
    "database",
  );
  if (!sameFileIdentity(descriptorStat, pathStat)) {
    return identityChangedError(
      "protected Runtime authority database path no longer names the pinned file",
    );
  }
  assertTrustedDirectoryChain(state.realpath, state.serviceUid);
  const sidecars = inspectTrustedSqliteSidecars(state.realpath, state.serviceUid);
  const revalidatedPathStat = assertTrustedOwnedRegularFile(
    state.realpath,
    state.serviceUid,
    "database",
  );

  let finalDescriptorStat: BigIntStats;
  let finalPathStat: BigIntStats;
  let finalRealpath: string;
  try {
    finalDescriptorStat = fstatSync(state.descriptor, { bigint: true });
    finalRealpath = realpathSync.native(state.requestedPath);
    finalPathStat = lstatSync(finalRealpath, { bigint: true });
  } catch {
    return identityChangedError(
      "protected Runtime authority database changed during pinned-boundary verification",
    );
  }
  if (!sameFileIdentity(descriptorStat, finalDescriptorStat)
    || descriptorStat.uid !== finalDescriptorStat.uid
    || descriptorStat.gid !== finalDescriptorStat.gid
    || descriptorStat.mode !== finalDescriptorStat.mode
    || descriptorStat.nlink !== finalDescriptorStat.nlink
    || finalRealpath !== state.realpath
    || !finalPathStat.isFile()
    || !sameFileIdentity(finalDescriptorStat, finalPathStat)
    || !sameFileIdentity(revalidatedPathStat, finalPathStat)
    || revalidatedPathStat.uid !== finalPathStat.uid
    || revalidatedPathStat.gid !== finalPathStat.gid
    || revalidatedPathStat.mode !== finalPathStat.mode
    || revalidatedPathStat.nlink !== finalPathStat.nlink) {
    return identityChangedError(
      "protected Runtime authority database changed during pinned-boundary verification",
    );
  }
  const inspection = inspectionFrom(state, finalDescriptorStat, sidecars);
  state.inspection = inspection;
  return inspection;
}

export function pinLiteRuntimeProtectedAuthorityDatabase(
  requestedPath: string,
): LiteRuntimeProtectedAuthorityDatabasePin {
  if (typeof requestedPath !== "string"
    || requestedPath.length === 0
    || !isAbsolute(requestedPath)) {
    return boundaryError(
      "lite_runtime_protected_authority_database_absolute_path_required",
      "protected Runtime authority database path must be absolute",
    );
  }
  const serviceUid = currentServiceUid();
  const realpath = resolveDatabaseRealpath(requestedPath);
  const databaseStat = assertTrustedOwnedRegularFile(realpath, serviceUid, "database");
  assertTrustedDirectoryChain(realpath, serviceUid);
  const sidecars = inspectTrustedSqliteSidecars(realpath, serviceUid);
  if (typeof fsConstants.O_NOFOLLOW !== "number"
    || typeof fsConstants.O_NONBLOCK !== "number") {
    return boundaryError(
      "lite_runtime_protected_authority_database_platform_unsupported",
      "protected Runtime authority database requires O_NOFOLLOW and O_NONBLOCK descriptor support",
    );
  }
  const optionalConstants = fsConstants as typeof fsConstants & {
    readonly O_CLOEXEC?: number;
  };
  const closeOnExec = typeof optionalConstants.O_CLOEXEC === "number"
    ? optionalConstants.O_CLOEXEC
    : 0;
  let descriptor: number;
  try {
    descriptor = openSync(
      realpath,
      fsConstants.O_RDONLY
        | fsConstants.O_NOFOLLOW
        | fsConstants.O_NONBLOCK
        | closeOnExec,
    );
  } catch {
    return identityChangedError(
      "protected Runtime authority database changed while acquiring its descriptor",
    );
  }
  let descriptorStat: BigIntStats;
  try {
    descriptorStat = fstatSync(descriptor, { bigint: true });
  } catch {
    closeDescriptorBestEffort(descriptor);
    return identityChangedError(
      "protected Runtime authority database changed while acquiring its descriptor",
    );
  }
  if (!descriptorStat.isFile()
    || !sameFileIdentity(databaseStat, descriptorStat)
    || descriptorStat.uid !== serviceUid
    || (descriptorStat.mode & 0o022n) !== 0n
    || descriptorStat.nlink !== 1n) {
    closeDescriptorBestEffort(descriptor);
    return identityChangedError(
      "protected Runtime authority database changed while acquiring its descriptor",
    );
  }

  let initialInspection: LiteRuntimeProtectedAuthorityDatabaseInspection;
  try {
    initialInspection = inspectionFrom(
      {
        requestedPath,
        realpath,
        device: descriptorStat.dev,
        inode: descriptorStat.ino,
      },
      descriptorStat,
      sidecars,
    );
  } catch (error) {
    closeDescriptorBestEffort(descriptor);
    throw error;
  }
  const capability = Object.freeze(Object.create(null)) as
    LiteRuntimeProtectedAuthorityDatabasePin;
  const state: PinState = {
    requestedPath,
    realpath,
    descriptor,
    device: descriptorStat.dev,
    inode: descriptorStat.ino,
    serviceUid,
    closed: false,
    inspection: initialInspection,
  };
  pinRegistry.set(capability, state);
  try {
    assertPinnedState(state);
    return capability;
  } catch (error) {
    state.closed = true;
    closeDescriptorBestEffort(descriptor);
    throw error;
  }
}

/** Returns the most recent immutable inspection without touching the filesystem. */
export function inspectLiteRuntimeProtectedAuthorityDatabase(
  pin: LiteRuntimeProtectedAuthorityDatabasePin,
): LiteRuntimeProtectedAuthorityDatabaseInspection {
  return requiredPinState(pin).inspection;
}

/** Revalidates descriptor, requested path, ownership, ACLs, directories and sidecars. */
export function assertLiteRuntimeProtectedAuthorityDatabasePinned(
  pin: LiteRuntimeProtectedAuthorityDatabasePin,
): LiteRuntimeProtectedAuthorityDatabaseInspection {
  return assertPinnedState(requiredPinState(pin));
}

/**
 * Opens the pinned existing Runtime database inside the protected boundary.
 *
 * Node SQLite cannot accept an already-open file descriptor. The attainable
 * guarantee is therefore: validate the descriptor/path identity, open the
 * canonical path, validate the identity again, and confirm SQLite's own main
 * path resolves to the pin. Processes with the same owner UID are part of the
 * trusted computing base; excluding a hostile same-UID ABA swap requires OS
 * process isolation rather than additional pathname checks.
 */
export function openLiteRuntimeProtectedAuthorityDatabase(
  pin: LiteRuntimeProtectedAuthorityDatabasePin,
  options: { faultInjector?: LiteRuntimeDatabaseFaultInjector } = {},
): LiteRuntimeDatabase {
  const state = requiredPinState(pin);
  assertPinnedState(state);
  let database: LiteRuntimeDatabase | null = null;
  try {
    database = createLiteRuntimeProtectedWriteDatabase(state.realpath, options);
    assertPinnedState(state);
    assertProtectedDatabaseMainPath(database, state.realpath);
    protectedDatabaseRegistry.set(database, state);
    return database;
  } catch (error) {
    if (database) closeProtectedDatabaseBestEffort(database);
    if (error instanceof LiteRuntimeProtectedAuthorityDatabaseError) throw error;
    return boundaryError(
      "lite_runtime_protected_authority_database_open_failed",
      "protected Runtime authority database could not open the pinned SQLite database",
    );
  }
}

/**
 * Issues the mutation authority consumed by the formal external-evidence
 * ingestion boundary. This succeeds only for the exact database instance
 * returned by `openLiteRuntimeProtectedAuthorityDatabase`, its still-live pin,
 * and the AsyncLocalStorage owner of an active BEGIN IMMEDIATE transaction.
 *
 * @internal The formal protected evidence service is the sole production
 * composition site. Keeping issuance here binds the capability to the same
 * module-private registry that branded the protected database open.
 */
function issueLiteRuntimeProtectedAuthorityTransactionCapability(
  pin: LiteRuntimeProtectedAuthorityDatabasePin,
  database: LiteRuntimeDatabase,
): LiteRuntimeProtectedAuthorityTransactionCapability {
  const state = requiredPinState(pin);
  assertPinnedState(state);
  if (protectedDatabaseRegistry.get(database) !== state) {
    return boundaryError(
      "lite_runtime_protected_authority_transaction_capability_invalid",
      "protected Runtime authority transaction requires the database instance opened by its pin",
    );
  }
  if (!database.transaction.inTransaction()) {
    return boundaryError(
      "lite_runtime_protected_authority_transaction_required",
      "protected Runtime authority transaction capability can only be issued inside BEGIN IMMEDIATE",
    );
  }
  const transactionIdentity = database.transaction.currentTransactionIdentity();
  if (transactionIdentity === null) {
    return boundaryError(
      "lite_runtime_protected_authority_transaction_required",
      "protected Runtime authority transaction capability requires an active transaction owner",
    );
  }
  assertProtectedDatabaseMainPath(database, state.realpath);
  const capability = Object.freeze(Object.create(null)) as
    LiteRuntimeProtectedAuthorityTransactionCapability;
  protectedTransactionRegistry.set(capability, {
    database,
    transaction: database.transaction,
    transactionIdentity,
    pinState: state,
  });
  return capability;
}

/**
 * Runs one protected mutation transaction and yields its unforgeable authority
 * only to the callback executing under that exact AsyncLocal transaction owner.
 * The issuer remains module-private, so a general Runtime database or ledger
 * surface cannot mint this authority.
 */
export async function runLiteRuntimeProtectedAuthorityTransaction<T>(
  pin: LiteRuntimeProtectedAuthorityDatabasePin,
  database: LiteRuntimeDatabase,
  fn: (capability: LiteRuntimeProtectedAuthorityTransactionCapability) => Promise<T>,
  options: SqliteTransactionRunOptions = {},
): Promise<T> {
  const state = requiredPinState(pin);
  assertPinnedState(state);
  if (protectedDatabaseRegistry.get(database) !== state) {
    return boundaryError(
      "lite_runtime_protected_authority_transaction_capability_invalid",
      "protected Runtime authority transaction requires the database instance opened by its pin",
    );
  }
  return await database.transaction.run(async () => {
    const capability = issueLiteRuntimeProtectedAuthorityTransactionCapability(
      pin,
      database,
    );
    const result = await fn(capability);
    assertLiteRuntimeProtectedAuthorityTransactionCapability(capability, database);
    return result;
  }, options);
}

/** Revalidates an opaque transaction capability against its exact DB/runner. */
export function assertLiteRuntimeProtectedAuthorityTransactionCapability(
  capability: LiteRuntimeProtectedAuthorityTransactionCapability,
  database: LiteRuntimeDatabase,
): void {
  if ((typeof capability !== "object" && typeof capability !== "function")
    || capability === null) {
    return boundaryError(
      "lite_runtime_protected_authority_transaction_capability_invalid",
      "protected Runtime authority transaction capability is invalid",
    );
  }
  const state = protectedTransactionRegistry.get(capability);
  if (!state
    || state.database !== database
    || state.transaction !== database.transaction
    || protectedDatabaseRegistry.get(database) !== state.pinState) {
    return boundaryError(
      "lite_runtime_protected_authority_transaction_capability_invalid",
      "protected Runtime authority transaction capability is invalid or bound to another database",
    );
  }
  assertPinnedState(state.pinState);
  if (!database.transaction.inTransaction()) {
    return boundaryError(
      "lite_runtime_protected_authority_transaction_required",
      "protected Runtime authority transaction capability is outside its BEGIN IMMEDIATE scope",
    );
  }
  if (database.transaction.currentTransactionIdentity()
    !== state.transactionIdentity) {
    return boundaryError(
      "lite_runtime_protected_authority_transaction_capability_invalid",
      "protected Runtime authority transaction capability belongs to another transaction scope",
    );
  }
  assertProtectedDatabaseMainPath(database, state.pinState.realpath);
}

/** Idempotently closes the read-only descriptor capability. */
export function closeLiteRuntimeProtectedAuthorityDatabasePin(
  pin: LiteRuntimeProtectedAuthorityDatabasePin,
): void {
  if ((typeof pin !== "object" && typeof pin !== "function") || pin === null) {
    return boundaryError(
      "lite_runtime_protected_authority_database_pin_invalid",
      "protected Runtime authority database pin is invalid",
    );
  }
  const state = pinRegistry.get(pin);
  if (!state) {
    return boundaryError(
      "lite_runtime_protected_authority_database_pin_invalid",
      "protected Runtime authority database pin is invalid",
    );
  }
  if (state.closed) return;
  try {
    closeSync(state.descriptor);
  } catch {
    return identityChangedError(
      "protected Runtime authority database descriptor could not be closed",
    );
  }
  state.closed = true;
}
