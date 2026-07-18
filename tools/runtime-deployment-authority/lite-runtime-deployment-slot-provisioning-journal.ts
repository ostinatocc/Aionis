import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import stableStringify from "fast-json-stable-stringify";

import {
  assertLiteRuntimeProtectedFilesystemNoDelegatedAccessControlList,
  assertLiteRuntimeProtectedFilesystemTrustedDirectoryChain,
} from "../../src/store/lite-runtime-protected-authority-database.js";
import {
  createSqliteReadOnlyDatabase,
  createSqliteReadWriteExistingDatabase,
  type SqliteDatabase,
} from "../../src/store/sqlite.js";
import { normalizeSqliteSchemaSql } from "../../src/store/sqlite-schema-sql.js";

const JOURNAL_APPLICATION_ID = 0x4149504a;
const JOURNAL_SCHEMA_VERSION = 1;
const BOOTSTRAP_MUTEX_APPLICATION_ID = 0x4149504d;
const BOOTSTRAP_MUTEX_SCHEMA_VERSION = 1;
const BOOTSTRAP_MUTEX_CONTRACT =
  "aionis_lite_runtime_deployment_slot_provisioning_bootstrap_mutex_v1";
const JOURNAL_INTENT_CONTRACT =
  "aionis_lite_runtime_deployment_slot_provisioning_intent_v1" as const;
const PHASE_RECEIPT_CONTRACT =
  "aionis_lite_runtime_deployment_slot_provisioning_phase_receipt_v1" as const;
const MAX_INTENT_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = MAX_EVIDENCE_BYTES * 2 + 64 * 1024;
const MAX_DEPLOYMENT_SLOT_BYTES = 256;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export const PROVISIONING_PHASES = Object.freeze([
  "intent_durable",
  "pair_inodes_durable",
  "carrier_ready",
  "state_ready",
  "initial_witness_ready",
  "committed",
  "aborted",
] as const);

export type LiteRuntimeDeploymentSlotProvisioningPhase =
  (typeof PROVISIONING_PHASES)[number];

export type LiteRuntimeDeploymentSlotProvisioningJournalErrorCode =
  | "lite_runtime_deployment_slot_provisioning_journal_invalid"
  | "lite_runtime_deployment_slot_provisioning_journal_contended"
  | "lite_runtime_deployment_slot_provisioning_journal_conflict"
  | "lite_runtime_deployment_slot_provisioning_journal_io";

export class LiteRuntimeDeploymentSlotProvisioningJournalError extends Error {
  readonly code: LiteRuntimeDeploymentSlotProvisioningJournalErrorCode;

  constructor(
    code: LiteRuntimeDeploymentSlotProvisioningJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LiteRuntimeDeploymentSlotProvisioningJournalError";
    this.code = code;
  }
}

function journalError(
  code: LiteRuntimeDeploymentSlotProvisioningJournalErrorCode,
  message: string,
): never {
  throw new LiteRuntimeDeploymentSlotProvisioningJournalError(code, message);
}

export type LiteRuntimeDeploymentSlotProvisioningIntent = Readonly<{
  contract_version: typeof JOURNAL_INTENT_CONTRACT;
  deployment_slot: string;
  launcher_root_instance_id: string;
  launcher_root_manifest_sha256: string;
  slot_path_mapping_sha256: string;
  authority_state_path: string;
  lease_carrier_path: string;
  database_realpath: string;
  database_instance_id: string;
  database_file_device: string;
  database_file_inode: string;
  authority_instance_id: string;
  carrier_instance_id: string;
  first_binding_anchor_sha256: string;
  created_at: string;
  intent_sha256: string;
}>;

export type LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest =
  Omit<LiteRuntimeDeploymentSlotProvisioningIntent, "intent_sha256">;

export type LiteRuntimeDeploymentSlotProvisioningPhaseReceipt = Readonly<{
  contract_version: typeof PHASE_RECEIPT_CONTRACT;
  intent_sha256: string;
  phase: LiteRuntimeDeploymentSlotProvisioningPhase;
  evidence_json: string;
  evidence_sha256: string;
  previous_receipt_sha256: string | null;
  recorded_at: string;
  receipt_sha256: string;
}>;

const journalLockBrand: unique symbol = Symbol(
  "lite-runtime-deployment-slot-provisioning-journal-lock",
);

export type LiteRuntimeDeploymentSlotProvisioningJournalLock = Readonly<{
  [journalLockBrand]:
    "aionis_lite_runtime_deployment_slot_provisioning_journal_lock_v1";
}>;

type PinnedFile = Readonly<{
  path: string;
  descriptor: number;
  stat: BigIntStats;
}>;

type JournalLockState = {
  readonly journalPath: string;
  readonly database: SqliteDatabase;
  readonly pin: PinnedFile;
  readonly intent: LiteRuntimeDeploymentSlotProvisioningIntent;
  readonly livenessSavepoint: string;
  released: boolean;
};

type BootstrapMutexState = {
  readonly path: string;
  readonly database: SqliteDatabase;
  readonly pin: PinnedFile;
  released: boolean;
};

const journalLockRegistry = new WeakMap<object, JournalLockState>();
const activeJournalLocks = new Map<string, object>();
const activeBootstrapMutexes = new Map<string, BootstrapMutexState>();

export const PROVISIONING_JOURNAL_FAULT_POINTS = Object.freeze([
  "bootstrap_mutex_file_durable",
  "bootstrap_mutex_transaction_dirty",
  "bootstrap_mutex_schema_committed",
  "bootstrap_publication_inspected",
  "bootstrap_staging_created",
  "bootstrap_sqlite_opened",
  "bootstrap_transaction_dirty",
  "bootstrap_transaction_committed",
  "bootstrap_schema_committed",
  "bootstrap_scratch_cleanup_locked",
  "bootstrap_final_linked",
  "bootstrap_parent_synced",
  "bootstrap_staging_unlinked",
  "receipt_staging_created",
  "receipt_partial_written",
  "receipt_file_synced",
  "receipt_staging_synced",
  "receipt_final_linked",
  "receipt_parent_synced",
  "receipt_staging_unlinked",
] as const);

export type LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint =
  (typeof PROVISIONING_JOURNAL_FAULT_POINTS)[number];

let provisioningJournalFaultObserverForTesting:
  ((point: LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint) => void) | null = null;

/** @internal Installs deterministic crash points for the real subprocess tests. */
export function installLiteRuntimeDeploymentSlotProvisioningJournalFaultObserverForTesting(
  observer:
    ((point: LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint) => void) | null,
): () => void {
  const previous = provisioningJournalFaultObserverForTesting;
  provisioningJournalFaultObserverForTesting = observer;
  return () => {
    provisioningJournalFaultObserverForTesting = previous;
  };
}

function observeJournalFaultPointForTesting(
  point: LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint,
): void {
  provisioningJournalFaultObserverForTesting?.(point);
}

const INTENT_KEYS = Object.freeze([
  "authority_instance_id",
  "authority_state_path",
  "carrier_instance_id",
  "contract_version",
  "created_at",
  "database_file_device",
  "database_file_inode",
  "database_instance_id",
  "database_realpath",
  "deployment_slot",
  "first_binding_anchor_sha256",
  "intent_sha256",
  "launcher_root_instance_id",
  "launcher_root_manifest_sha256",
  "lease_carrier_path",
  "slot_path_mapping_sha256",
] as const);

const INTENT_WITHOUT_DIGEST_KEYS = Object.freeze(
  INTENT_KEYS.filter((key) => key !== "intent_sha256"),
);

const RECEIPT_KEYS = Object.freeze([
  "contract_version",
  "evidence_json",
  "evidence_sha256",
  "intent_sha256",
  "phase",
  "previous_receipt_sha256",
  "receipt_sha256",
  "recorded_at",
] as const);

const DIGEST_CHECK = String.raw`length(%COLUMN%) = 64
    AND %COLUMN% NOT GLOB '*[^0-9a-f]*'`;
const U64_CHECK = String.raw`(
    %COLUMN% = '0'
    OR (
      length(%COLUMN%) BETWEEN 1 AND 20
      AND substr(%COLUMN%, 1, 1) BETWEEN '1' AND '9'
      AND %COLUMN% NOT GLOB '*[^0-9]*'
      AND (
        length(%COLUMN%) < 20
        OR %COLUMN% <= '18446744073709551615'
      )
    )
  )`;

function digestCheck(column: string): string {
  return DIGEST_CHECK.replaceAll("%COLUMN%", column);
}

function u64Check(column: string): string {
  return U64_CHECK.replaceAll("%COLUMN%", column);
}

const JOURNAL_INTENT_TABLE_SQL = String.raw`
CREATE TABLE lite_runtime_deployment_slot_provisioning_intent (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  contract_version TEXT NOT NULL CHECK (
    contract_version = '${JOURNAL_INTENT_CONTRACT}'
  ),
  deployment_slot TEXT NOT NULL UNIQUE CHECK (
    length(CAST(deployment_slot AS BLOB)) BETWEEN 1 AND 256
    AND deployment_slot = trim(deployment_slot)
  ),
  launcher_root_instance_id TEXT NOT NULL CHECK (
    ${digestCheck("launcher_root_instance_id")}
  ),
  launcher_root_manifest_sha256 TEXT NOT NULL CHECK (
    ${digestCheck("launcher_root_manifest_sha256")}
  ),
  slot_path_mapping_sha256 TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("slot_path_mapping_sha256")}
  ),
  authority_state_path TEXT NOT NULL UNIQUE,
  lease_carrier_path TEXT NOT NULL UNIQUE,
  database_realpath TEXT NOT NULL UNIQUE,
  database_instance_id TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("database_instance_id")}
  ),
  database_file_device TEXT NOT NULL CHECK (
    ${u64Check("database_file_device")}
  ),
  database_file_inode TEXT NOT NULL CHECK (
    ${u64Check("database_file_inode")}
  ),
  authority_instance_id TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("authority_instance_id")}
  ),
  carrier_instance_id TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("carrier_instance_id")}
  ),
  first_binding_anchor_sha256 TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("first_binding_anchor_sha256")}
  ),
  created_at TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("intent_sha256")}
  )
) STRICT;`.trim();

const JOURNAL_INTENT_UPDATE_TRIGGER_SQL = String.raw`
CREATE TRIGGER lite_runtime_deployment_slot_provisioning_intent_no_update
BEFORE UPDATE ON lite_runtime_deployment_slot_provisioning_intent
BEGIN
  SELECT RAISE(ABORT, 'deployment_slot_provisioning_intent_is_immutable');
END;`.trim();

const JOURNAL_INTENT_DELETE_TRIGGER_SQL = String.raw`
CREATE TRIGGER lite_runtime_deployment_slot_provisioning_intent_no_delete
BEFORE DELETE ON lite_runtime_deployment_slot_provisioning_intent
BEGIN
  SELECT RAISE(ABORT, 'deployment_slot_provisioning_intent_is_immutable');
END;`.trim();

const JOURNAL_INTENT_SECOND_INSERT_TRIGGER_SQL = String.raw`
CREATE TRIGGER lite_runtime_deployment_slot_provisioning_intent_no_second_insert
BEFORE INSERT ON lite_runtime_deployment_slot_provisioning_intent
WHEN EXISTS (
  SELECT 1 FROM lite_runtime_deployment_slot_provisioning_intent
)
BEGIN
  SELECT RAISE(ABORT, 'deployment_slot_provisioning_intent_is_immutable');
END;`.trim();

const JOURNAL_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({
    type: "table" as const,
    name: "lite_runtime_deployment_slot_provisioning_intent",
    sql: JOURNAL_INTENT_TABLE_SQL,
  }),
  Object.freeze({
    type: "trigger" as const,
    name: "lite_runtime_deployment_slot_provisioning_intent_no_update",
    sql: JOURNAL_INTENT_UPDATE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "trigger" as const,
    name: "lite_runtime_deployment_slot_provisioning_intent_no_delete",
    sql: JOURNAL_INTENT_DELETE_TRIGGER_SQL,
  }),
  Object.freeze({
    type: "trigger" as const,
    name: "lite_runtime_deployment_slot_provisioning_intent_no_second_insert",
    sql: JOURNAL_INTENT_SECOND_INSERT_TRIGGER_SQL,
  }),
] as const);

const JOURNAL_SCHEMA_SQL = JOURNAL_SCHEMA_OBJECTS.map((entry) => entry.sql).join("\n");

const BOOTSTRAP_MUTEX_TABLE_SQL = String.raw`
CREATE TABLE lite_runtime_deployment_slot_provisioning_bootstrap_mutex (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  contract_version TEXT NOT NULL CHECK (
    contract_version = '${BOOTSTRAP_MUTEX_CONTRACT}'
  )
) STRICT;`.trim();

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning ${label} has an invalid shape`,
    );
  }
}

function assertDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning journal requires a canonical ${label}`,
    );
  }
  return value;
}

function assertCanonicalU64(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning journal requires a canonical ${label}`,
    );
  }
  if (BigInt(value) > MAX_U64) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning journal ${label} exceeds unsigned-64 range`,
    );
  }
  return value;
}

function assertCanonicalTime(value: unknown, label: string): string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning journal requires a canonical ${label}`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning journal received an invalid ${label}`,
    );
  }
  return value;
}

function canonicalRecordedAt(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning phase receipt requires a valid recordedAt",
    );
  }
  return assertCanonicalTime(value.toISOString(), "receipt time");
}

function assertDeploymentSlot(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /\p{Cc}/u.test(value)
    || Buffer.from(value, "utf8").toString("utf8") !== value
    || Buffer.byteLength(value, "utf8") > MAX_DEPLOYMENT_SLOT_BYTES) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning intent contains an invalid deployment slot",
    );
  }
  return value;
}

function assertCanonicalAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
    || value.includes("\0")
    || !isAbsolute(value)
    || resolve(value) !== value) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning ${label} must be a canonical absolute path`,
    );
  }
  return value;
}

function requiredFlag(name: "O_DIRECTORY" | "O_EXCL" | "O_NOFOLLOW"): number {
  const value = fsConstants[name];
  if (typeof value !== "number") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning journal requires ${name}`,
    );
  }
  return value;
}

function currentServiceUid(): bigint {
  if (typeof process.getuid !== "function") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal requires a verifiable service UID",
    );
  }
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal received an unsafe service UID",
    );
  }
  return BigInt(uid);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeDescriptorBestEffort(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the error that caused cleanup.
  }
}

function closeDatabaseBestEffort(database: SqliteDatabase | null): void {
  if (!database) return;
  try {
    database.close();
  } catch {
    // Preserve the error that caused cleanup.
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object"
      && (error as { code?: unknown }).code === "ENOENT") return false;
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning path could not be inspected",
    );
  }
}

function assertTrustedDirectory(path: string, label: string): BigIntStats {
  const canonicalPath = assertCanonicalAbsolutePath(path, label);
  const serviceUid = currentServiceUid();
  let before: BigIntStats;
  try {
    before = lstatSync(canonicalPath, { bigint: true });
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      `deployment-slot provisioning ${label} is unavailable`,
    );
  }
  if (!before.isDirectory()
    || before.uid !== serviceUid
    || (before.mode & 0o7777n) !== 0o700n) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning ${label} must be an owner-controlled mode 0700 directory`,
    );
  }
  try {
    if (realpathSync.native(canonicalPath) !== canonicalPath) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        `deployment-slot provisioning ${label} is not canonical`,
      );
    }
    assertLiteRuntimeProtectedFilesystemNoDelegatedAccessControlList(
      canonicalPath,
      "receipt",
    );
    assertLiteRuntimeProtectedFilesystemTrustedDirectoryChain(
      join(canonicalPath, ".aionis-provisioning-directory-probe"),
      serviceUid,
    );
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning ${label} ACL or ancestor chain is untrusted`,
    );
  }
  const after = lstatSync(canonicalPath, { bigint: true });
  if (!sameIdentity(before, after)
    || before.uid !== after.uid
    || before.mode !== after.mode) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      `deployment-slot provisioning ${label} changed during inspection`,
    );
  }
  return after;
}

function assertTrustedParent(path: string, label: string): BigIntStats {
  return assertTrustedDirectory(dirname(path), `${label} parent`);
}

function inspectPrivateFile(
  path: string,
  label: string,
  expectedLinkCount: bigint = 1n,
): BigIntStats {
  const canonicalPath = assertCanonicalAbsolutePath(path, label);
  const serviceUid = currentServiceUid();
  let before: BigIntStats;
  try {
    before = lstatSync(canonicalPath, { bigint: true });
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      `deployment-slot provisioning ${label} is unavailable`,
    );
  }
  if (!before.isFile()
    || before.uid !== serviceUid
    || before.nlink !== expectedLinkCount
    || (before.mode & 0o7777n) !== 0o600n) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning ${label} must be a mode 0600 owner file with the expected link count`,
    );
  }
  try {
    if (realpathSync.native(canonicalPath) !== canonicalPath) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        `deployment-slot provisioning ${label} is redirected`,
      );
    }
    assertLiteRuntimeProtectedFilesystemNoDelegatedAccessControlList(
      canonicalPath,
      "receipt",
    );
    assertLiteRuntimeProtectedFilesystemTrustedDirectoryChain(
      canonicalPath,
      serviceUid,
    );
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning ${label} ACL or ancestor chain is untrusted`,
    );
  }
  const after = lstatSync(canonicalPath, { bigint: true });
  if (!sameIdentity(before, after)
    || before.uid !== after.uid
    || before.mode !== after.mode
    || before.nlink !== after.nlink) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      `deployment-slot provisioning ${label} changed during inspection`,
    );
  }
  return after;
}

function openPinnedPrivateFile(
  path: string,
  label: string,
  expectedLinkCount: bigint = 1n,
): PinnedFile {
  const before = inspectPrivateFile(path, label, expectedLinkCount);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | requiredFlag("O_NOFOLLOW"),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, opened)
      || !opened.isFile()
      || opened.uid !== before.uid
      || opened.mode !== before.mode
      || opened.nlink !== before.nlink) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        `deployment-slot provisioning ${label} changed while opening`,
      );
    }
    const pin = Object.freeze({ path, descriptor, stat: opened });
    descriptor = null;
    return pin;
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      `deployment-slot provisioning ${label} could not be pinned`,
    );
  } finally {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
  }
}

function assertPinnedPrivateFile(pin: PinnedFile, label: string): void {
  let descriptorStat: BigIntStats;
  try {
    descriptorStat = fstatSync(pin.descriptor, { bigint: true });
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      `deployment-slot provisioning ${label} descriptor is no longer valid`,
    );
  }
  const pathStat = inspectPrivateFile(pin.path, label, pin.stat.nlink);
  if (!sameIdentity(pin.stat, descriptorStat)
    || !sameIdentity(descriptorStat, pathStat)
    || descriptorStat.uid !== pin.stat.uid
    || descriptorStat.mode !== pin.stat.mode
    || descriptorStat.nlink !== pin.stat.nlink) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      `deployment-slot provisioning ${label} physical identity changed`,
    );
  }
}

function syncPath(path: string, directory: boolean): void {
  const before = directory
    ? assertTrustedDirectory(path, "durability directory")
    : inspectPrivateFile(path, "durability file");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY
        | requiredFlag("O_NOFOLLOW")
        | (directory ? requiredFlag("O_DIRECTORY") : 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, opened)
      || before.uid !== opened.uid
      || before.gid !== opened.gid
      || before.mode !== opened.mode
      || before.nlink !== opened.nlink) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning durability target changed while opening",
      );
    }
    fsyncSync(descriptor);
    const synced = fstatSync(descriptor, { bigint: true });
    const after = directory
      ? assertTrustedDirectory(path, "durability directory")
      : inspectPrivateFile(path, "durability file");
    if (!sameIdentity(opened, synced)
      || !sameIdentity(synced, after)
      || opened.uid !== synced.uid
      || opened.gid !== synced.gid
      || opened.mode !== synced.mode
      || opened.nlink !== synced.nlink
      || synced.uid !== after.uid
      || synced.gid !== after.gid
      || synced.mode !== after.mode
      || synced.nlink !== after.nlink) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning durability target changed during sync",
      );
    }
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning durability sync failed",
    );
  } finally {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
  }
}

function syncFileAndParent(path: string): void {
  syncPath(path, false);
  syncPath(dirname(path), true);
}

function syncDirectoryAndParent(path: string): void {
  syncPath(path, true);
  syncPath(dirname(path), true);
}

function canonicalJson(value: unknown, label: string, maxBytes: number): string {
  let json: string;
  try {
    json = stableStringify(value);
    if (typeof json !== "string") throw new TypeError("not_json");
    const parsed = JSON.parse(json) as unknown;
    if (stableStringify(parsed) !== json) throw new TypeError("not_canonical_json");
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning ${label} is not canonical JSON`,
    );
  }
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning ${label} exceeds its size limit`,
    );
  }
  return json;
}

function decodeCanonicalJsonFile(
  path: string,
  label: string,
  maxBytes: number,
  expectedLinkCount: bigint = 1n,
): Record<string, unknown> {
  const pin = openPinnedPrivateFile(path, label, expectedLinkCount);
  try {
    if (pin.stat.size <= 0n || pin.stat.size > BigInt(maxBytes)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        `deployment-slot provisioning ${label} has an invalid size`,
      );
    }
    const raw = readFileSync(pin.descriptor);
    if (raw.byteLength !== Number(pin.stat.size)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        `deployment-slot provisioning ${label} changed while reading`,
      );
    }
    let json: string;
    let parsed: unknown;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      parsed = JSON.parse(json) as unknown;
    } catch {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        `deployment-slot provisioning ${label} is not strict UTF-8 JSON`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || stableStringify(parsed) !== json) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        `deployment-slot provisioning ${label} is not an exact canonical object`,
      );
    }
    assertPinnedPrivateFile(pin, label);
    return parsed as Record<string, unknown>;
  } finally {
    closeDescriptorBestEffort(pin.descriptor);
  }
}

function intentProjection(
  value: LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest,
): LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest {
  return Object.freeze({
    contract_version: value.contract_version,
    deployment_slot: value.deployment_slot,
    launcher_root_instance_id: value.launcher_root_instance_id,
    launcher_root_manifest_sha256: value.launcher_root_manifest_sha256,
    slot_path_mapping_sha256: value.slot_path_mapping_sha256,
    authority_state_path: value.authority_state_path,
    lease_carrier_path: value.lease_carrier_path,
    database_realpath: value.database_realpath,
    database_instance_id: value.database_instance_id,
    database_file_device: value.database_file_device,
    database_file_inode: value.database_file_inode,
    authority_instance_id: value.authority_instance_id,
    carrier_instance_id: value.carrier_instance_id,
    first_binding_anchor_sha256: value.first_binding_anchor_sha256,
    created_at: value.created_at,
  });
}

function validateIntentWithoutDigest(
  value: unknown,
): LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning intent must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(record, INTENT_WITHOUT_DIGEST_KEYS, "intent projection");
  if (record.contract_version !== JOURNAL_INTENT_CONTRACT) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning intent contract is invalid",
    );
  }
  const authorityStatePath = assertCanonicalAbsolutePath(
    record.authority_state_path,
    "authority state path",
  );
  const leaseCarrierPath = assertCanonicalAbsolutePath(
    record.lease_carrier_path,
    "lease carrier path",
  );
  const databaseRealpath = assertCanonicalAbsolutePath(
    record.database_realpath,
    "Runtime database path",
  );
  if (leaseCarrierPath !== `${authorityStatePath}.lease`
    || authorityStatePath === databaseRealpath
    || leaseCarrierPath === databaseRealpath) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning intent contains conflicting authority paths",
    );
  }
  return intentProjection({
    contract_version: JOURNAL_INTENT_CONTRACT,
    deployment_slot: assertDeploymentSlot(record.deployment_slot),
    launcher_root_instance_id: assertDigest(
      record.launcher_root_instance_id,
      "launcher root instance ID",
    ),
    launcher_root_manifest_sha256: assertDigest(
      record.launcher_root_manifest_sha256,
      "launcher root manifest digest",
    ),
    slot_path_mapping_sha256: assertDigest(
      record.slot_path_mapping_sha256,
      "slot-path mapping digest",
    ),
    authority_state_path: authorityStatePath,
    lease_carrier_path: leaseCarrierPath,
    database_realpath: databaseRealpath,
    database_instance_id: assertDigest(
      record.database_instance_id,
      "Runtime database instance ID",
    ),
    database_file_device: assertCanonicalU64(
      record.database_file_device,
      "Runtime database device",
    ),
    database_file_inode: assertCanonicalU64(
      record.database_file_inode,
      "Runtime database inode",
    ),
    authority_instance_id: assertDigest(
      record.authority_instance_id,
      "authority instance ID",
    ),
    carrier_instance_id: assertDigest(
      record.carrier_instance_id,
      "carrier instance ID",
    ),
    first_binding_anchor_sha256: assertDigest(
      record.first_binding_anchor_sha256,
      "first-binding anchor digest",
    ),
    created_at: assertCanonicalTime(record.created_at, "intent creation time"),
  });
}

function intentFromProjection(
  value: LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest,
): LiteRuntimeDeploymentSlotProvisioningIntent {
  const projection = validateIntentWithoutDigest(value);
  const intent = Object.freeze({
    ...projection,
    intent_sha256: sha256(stableStringify(projection)),
  });
  canonicalJson(intent, "intent", MAX_INTENT_BYTES);
  return intent;
}

function validateIntent(value: unknown): LiteRuntimeDeploymentSlotProvisioningIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal intent must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(record, INTENT_KEYS, "intent");
  const { intent_sha256: rawDigest, ...withoutDigest } = record;
  const projection = validateIntentWithoutDigest(withoutDigest);
  const intentSha256 = assertDigest(rawDigest, "intent digest");
  if (sha256(stableStringify(projection)) !== intentSha256) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning intent digest is invalid",
    );
  }
  return Object.freeze({ ...projection, intent_sha256: intentSha256 });
}

function assertJournalPathDisjoint(
  journalPath: string,
  intent: LiteRuntimeDeploymentSlotProvisioningIntent,
): void {
  const authorityPaths = [
    intent.authority_state_path,
    intent.lease_carrier_path,
    intent.database_realpath,
  ];
  for (const authorityPath of authorityPaths) {
    for (const suffix of ["", "-wal", "-shm", "-journal"] as const) {
      if (journalPath === `${authorityPath}${suffix}`
        || `${journalPath}${suffix}` === authorityPath) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_invalid",
          "deployment-slot provisioning journal overlaps an authority SQLite namespace",
        );
      }
    }
  }
}

function pragmaScalar(db: SqliteDatabase, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  return Object.values(row as Record<string, unknown>)[0];
}

function configureJournalConnection(db: SqliteDatabase, readOnly: boolean): void {
  db.exec(`
    PRAGMA busy_timeout = 0;
    PRAGMA synchronous = EXTRA;
    PRAGMA fullfsync = ON;
    PRAGMA checkpoint_fullfsync = ON;
    PRAGMA foreign_keys = ON;
    PRAGMA recursive_triggers = ON;
    PRAGMA trusted_schema = OFF;
    ${readOnly ? "PRAGMA query_only = ON;" : ""}
  `);
}

function assertJournalPragmas(db: SqliteDatabase): void {
  if (pragmaScalar(db, "application_id") !== JOURNAL_APPLICATION_ID
    || pragmaScalar(db, "user_version") !== JOURNAL_SCHEMA_VERSION
    || pragmaScalar(db, "journal_mode") !== "delete"
    || pragmaScalar(db, "synchronous") !== 3
    || pragmaScalar(db, "fullfsync") !== 1
    || pragmaScalar(db, "checkpoint_fullfsync") !== 1
    || pragmaScalar(db, "foreign_keys") !== 1
    || pragmaScalar(db, "recursive_triggers") !== 1
    || pragmaScalar(db, "trusted_schema") !== 0
    || pragmaScalar(db, "busy_timeout") !== 0) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal SQLite pragmas are invalid",
    );
  }
}

function journalSchemaObjectCount(db: SqliteDatabase): number {
  const row = db.prepare(
    `SELECT count(*) AS object_count FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'`,
  ).get() as Record<string, unknown> | undefined;
  return typeof row?.object_count === "number" ? row.object_count : -1;
}

function assertExactJournalSchema(db: SqliteDatabase): void {
  const actual = db.prepare(
    `SELECT type, name, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  ).all() as Array<{ type: string; name: string; sql: string | null }>;
  const expected = [...JOURNAL_SCHEMA_OBJECTS].sort(
    (left, right) => left.type.localeCompare(right.type)
      || left.name.localeCompare(right.name),
  );
  if (actual.length !== expected.length) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal schema object count is invalid",
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actualEntry = actual[index];
    const expectedEntry = expected[index]!;
    if (!actualEntry
      || actualEntry.type !== expectedEntry.type
      || actualEntry.name !== expectedEntry.name
      || actualEntry.sql === null
      || normalizeSqliteSchemaSql(actualEntry.sql)
        !== normalizeSqliteSchemaSql(expectedEntry.sql)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        `deployment-slot provisioning journal schema object ${expectedEntry.name} is invalid`,
      );
    }
  }
  const integrity = db.prepare("PRAGMA integrity_check").all() as
    Array<Record<string, unknown>>;
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal integrity check failed",
    );
  }
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal foreign-key check failed",
    );
  }
}

function assertExactBootstrapMutex(db: SqliteDatabase): void {
  if (pragmaScalar(db, "application_id") !== BOOTSTRAP_MUTEX_APPLICATION_ID
    || pragmaScalar(db, "user_version") !== BOOTSTRAP_MUTEX_SCHEMA_VERSION
    || pragmaScalar(db, "journal_mode") !== "delete"
    || pragmaScalar(db, "synchronous") !== 3
    || pragmaScalar(db, "fullfsync") !== 1
    || pragmaScalar(db, "checkpoint_fullfsync") !== 1
    || pragmaScalar(db, "foreign_keys") !== 1
    || pragmaScalar(db, "recursive_triggers") !== 1
    || pragmaScalar(db, "trusted_schema") !== 0
    || pragmaScalar(db, "busy_timeout") !== 0) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning bootstrap mutex pragmas are invalid",
    );
  }
  const objects = db.prepare(
    `SELECT type, name, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  ).all() as Array<{ type: string; name: string; sql: string | null }>;
  if (objects.length !== 1
    || objects[0]?.type !== "table"
    || objects[0].name
      !== "lite_runtime_deployment_slot_provisioning_bootstrap_mutex"
    || objects[0].sql === null
    || normalizeSqliteSchemaSql(objects[0].sql)
      !== normalizeSqliteSchemaSql(BOOTSTRAP_MUTEX_TABLE_SQL)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning bootstrap mutex schema is invalid",
    );
  }
  const rows = db.prepare(
    `SELECT singleton, contract_version
     FROM lite_runtime_deployment_slot_provisioning_bootstrap_mutex`,
  ).all() as Array<Record<string, unknown>>;
  if (rows.length !== 1
    || rows[0]?.singleton !== 1
    || rows[0].contract_version !== BOOTSTRAP_MUTEX_CONTRACT) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning bootstrap mutex row is invalid",
    );
  }
  const integrity = db.prepare("PRAGMA integrity_check").all() as
    Array<Record<string, unknown>>;
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning bootstrap mutex integrity check failed",
    );
  }
}

function insertIntent(
  db: SqliteDatabase,
  intent: LiteRuntimeDeploymentSlotProvisioningIntent,
): void {
  db.prepare(
    `INSERT INTO lite_runtime_deployment_slot_provisioning_intent
       (singleton, contract_version, deployment_slot,
        launcher_root_instance_id, launcher_root_manifest_sha256,
        slot_path_mapping_sha256, authority_state_path, lease_carrier_path,
        database_realpath, database_instance_id, database_file_device,
        database_file_inode, authority_instance_id, carrier_instance_id,
        first_binding_anchor_sha256, created_at, intent_sha256)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    intent.contract_version,
    intent.deployment_slot,
    intent.launcher_root_instance_id,
    intent.launcher_root_manifest_sha256,
    intent.slot_path_mapping_sha256,
    intent.authority_state_path,
    intent.lease_carrier_path,
    intent.database_realpath,
    intent.database_instance_id,
    intent.database_file_device,
    intent.database_file_inode,
    intent.authority_instance_id,
    intent.carrier_instance_id,
    intent.first_binding_anchor_sha256,
    intent.created_at,
    intent.intent_sha256,
  );
}

function readIntentRow(db: SqliteDatabase): LiteRuntimeDeploymentSlotProvisioningIntent {
  const rows = db.prepare(
    "SELECT * FROM lite_runtime_deployment_slot_provisioning_intent ORDER BY singleton",
  ).all() as Array<Record<string, unknown>>;
  if (rows.length !== 1 || rows[0]?.singleton !== 1) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal must contain exactly one intent",
    );
  }
  const { singleton: _singleton, ...intent } = rows[0];
  return validateIntent(intent);
}

function assertNoJournalSidecars(path: string, allowRollbackJournal: boolean): void {
  for (const suffix of ["-wal", "-shm"] as const) {
    if (pathExists(`${path}${suffix}`)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        "deployment-slot provisioning journal must use DELETE mode without WAL sidecars",
      );
    }
  }
  const rollbackJournal = `${path}-journal`;
  if (!pathExists(rollbackJournal)) return;
  if (!allowRollbackJournal) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal has an unresolved rollback journal",
    );
  }
  inspectPrivateFile(rollbackJournal, "SQLite rollback journal");
}

function createPrivateEmptyFile(path: string): boolean {
  assertTrustedParent(path, "journal");
  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_CREAT
        | requiredFlag("O_EXCL")
        | fsConstants.O_RDWR
        | requiredFlag("O_NOFOLLOW"),
      0o600,
    );
    created = true;
    fchmodSync(descriptor, 0o600);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()
      || stat.uid !== currentServiceUid()
      || stat.nlink !== 1n
      || (stat.mode & 0o7777n) !== 0o600n) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        "deployment-slot provisioning journal was not created as a private file",
      );
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    if (error && typeof error === "object"
      && (error as { code?: unknown }).code === "EEXIST") return false;
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning journal file creation failed",
    );
  } finally {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
  }
  if (created) syncPath(dirname(path), true);
  return created;
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /busy|locked/iu.test(message);
}

export type LiteRuntimeDeploymentSlotProvisioningJournalPublicationState =
  | "absent"
  | "published"
  | "published_with_recoverable_staging"
  | "recoverable_staging"
  | "recoverable_linked";

export function liteRuntimeDeploymentSlotProvisioningJournalBootstrapPath(
  journalPathValue: string,
): string {
  const journalPath = assertCanonicalAbsolutePath(journalPathValue, "journal path");
  return `${journalPath}.bootstrap`;
}

export function liteRuntimeDeploymentSlotProvisioningJournalBootstrapMutexPath(
  journalPathValue: string,
): string {
  const journalPath = assertCanonicalAbsolutePath(journalPathValue, "journal path");
  return `${journalPath}.bootstrap-lock`;
}

function acquireBootstrapMutex(journalPathValue: string): BootstrapMutexState {
  const journalPath = assertCanonicalAbsolutePath(journalPathValue, "journal path");
  const mutexPath =
    liteRuntimeDeploymentSlotProvisioningJournalBootstrapMutexPath(journalPath);
  if (activeBootstrapMutexes.has(mutexPath)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_contended",
      "deployment-slot provisioning bootstrap mutex is already held by this process",
    );
  }
  const mutexCreated = createPrivateEmptyFile(mutexPath);
  if (mutexCreated) {
    observeJournalFaultPointForTesting("bootstrap_mutex_file_durable");
  }
  const pin = openPinnedPrivateFile(mutexPath, "bootstrap mutex");
  let database: SqliteDatabase | null = null;
  let transactionOpen = false;
  let retained = false;
  try {
    assertNoJournalSidecars(mutexPath, true);
    database = createSqliteReadWriteExistingDatabase(mutexPath);
    configureJournalConnection(database, false);
    if (pragmaScalar(database, "journal_mode=DELETE") !== "delete") {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        "deployment-slot provisioning bootstrap mutex requires SQLite DELETE mode",
      );
    }
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const objectCount = journalSchemaObjectCount(database);
    if (objectCount === 0) {
      if (pragmaScalar(database, "application_id") !== 0
        || pragmaScalar(database, "user_version") !== 0) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_invalid",
          "deployment-slot provisioning empty bootstrap mutex has foreign pragmas",
        );
      }
      database.exec(BOOTSTRAP_MUTEX_TABLE_SQL);
      database.exec(`
        PRAGMA application_id = ${BOOTSTRAP_MUTEX_APPLICATION_ID};
        PRAGMA user_version = ${BOOTSTRAP_MUTEX_SCHEMA_VERSION};
        INSERT INTO lite_runtime_deployment_slot_provisioning_bootstrap_mutex
          (singleton, contract_version)
        VALUES (1, '${BOOTSTRAP_MUTEX_CONTRACT}');
      `);
      assertExactBootstrapMutex(database);
      observeJournalFaultPointForTesting("bootstrap_mutex_transaction_dirty");
      database.exec("COMMIT");
      transactionOpen = false;
      observeJournalFaultPointForTesting("bootstrap_mutex_schema_committed");
      assertPinnedPrivateFile(pin, "initialized bootstrap mutex");
      assertNoJournalSidecars(mutexPath, false);
      syncFileAndParent(mutexPath);
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
    }
    assertExactBootstrapMutex(database);
    assertPinnedPrivateFile(pin, "retained bootstrap mutex");
    assertNoJournalSidecars(mutexPath, false);
    const state: BootstrapMutexState = {
      path: mutexPath,
      database,
      pin,
      released: false,
    };
    activeBootstrapMutexes.set(mutexPath, state);
    retained = true;
    database = null;
    transactionOpen = false;
    return state;
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    if (isBusyError(error)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_contended",
        "deployment-slot provisioning bootstrap mutex is held by another process",
      );
    }
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning bootstrap mutex could not be initialized or retained",
    );
  } finally {
    if (transactionOpen && database) {
      try { database.exec("ROLLBACK"); } catch { /* preserve first error */ }
    }
    if (database) {
      closeDatabaseBestEffort(database);
    }
    if (!retained) {
      closeDescriptorBestEffort(pin.descriptor);
    }
  }
}

function assertBootstrapMutexLive(state: BootstrapMutexState): void {
  if (state.released || activeBootstrapMutexes.get(state.path) !== state) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_contended",
      "deployment-slot provisioning bootstrap mutex is no longer retained",
    );
  }
  try {
    assertPinnedPrivateFile(state.pin, "bootstrap mutex");
    assertNoJournalSidecars(state.path, false);
    assertExactBootstrapMutex(state.database);
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_contended",
      "deployment-slot provisioning bootstrap mutex transaction is no longer live",
    );
  }
}

function releaseBootstrapMutex(state: BootstrapMutexState): void {
  if (state.released || activeBootstrapMutexes.get(state.path) !== state) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning bootstrap mutex release is invalid",
    );
  }
  let firstError: unknown = null;
  try { state.database.exec("ROLLBACK"); } catch (error) { firstError = error; }
  try { state.database.close(); } catch (error) { firstError ??= error; }
  try { closeSync(state.pin.descriptor); } catch (error) { firstError ??= error; }
  state.released = true;
  activeBootstrapMutexes.delete(state.path);
  if (firstError) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning bootstrap mutex could not be released cleanly",
    );
  }
}

/**
 * Read-only physical inspection of the no-replace journal publication state.
 * Staging is explicitly non-authoritative until linked to the final name.
 */
export function inspectLiteRuntimeDeploymentSlotProvisioningJournalPublication(
  journalPathValue: string,
): LiteRuntimeDeploymentSlotProvisioningJournalPublicationState {
  const journalPath = assertCanonicalAbsolutePath(journalPathValue, "journal path");
  const stagingPath = liteRuntimeDeploymentSlotProvisioningJournalBootstrapPath(
    journalPath,
  );
  const finalExists = pathExists(journalPath);
  const stagingExists = pathExists(stagingPath);
  if (!stagingExists) {
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      if (pathExists(`${stagingPath}${suffix}`)) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_invalid",
          "deployment-slot provisioning journal has an orphan bootstrap sidecar",
        );
      }
    }
  }
  if (!finalExists && !stagingExists) return "absent";
  if (finalExists && !stagingExists) {
    inspectPrivateFile(journalPath, "journal");
    assertNoJournalSidecars(journalPath, false);
    return "published";
  }
  if (!finalExists && stagingExists) {
    inspectPrivateFile(stagingPath, "journal bootstrap staging");
    assertNoJournalSidecars(stagingPath, true);
    return "recoverable_staging";
  }
  let finalLinkCount: bigint;
  let stagingLinkCount: bigint;
  try {
    finalLinkCount = lstatSync(journalPath, { bigint: true }).nlink;
    stagingLinkCount = lstatSync(stagingPath, { bigint: true }).nlink;
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning journal publication changed during inspection",
    );
  }
  if (finalLinkCount === 1n && stagingLinkCount === 1n) {
    const finalStat = inspectPrivateFile(journalPath, "published journal");
    const stagingStat = inspectPrivateFile(
      stagingPath,
      "unpublished journal bootstrap staging",
    );
    if (sameIdentity(finalStat, stagingStat)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning journal independent names unexpectedly share an inode",
      );
    }
    assertNoJournalSidecars(journalPath, false);
    assertNoJournalSidecars(stagingPath, true);
    return "published_with_recoverable_staging";
  }
  const finalStat = inspectPrivateFile(journalPath, "linked journal", 2n);
  const stagingStat = inspectPrivateFile(
    stagingPath,
    "linked journal bootstrap staging",
    2n,
  );
  if (!sameIdentity(finalStat, stagingStat)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning journal final and staging names bind different inodes",
    );
  }
  assertNoJournalSidecars(journalPath, false);
  assertNoJournalSidecars(stagingPath, false);
  return "recoverable_linked";
}

function finishLinkedJournalPublication(journalPath: string): void {
  const stagingPath = liteRuntimeDeploymentSlotProvisioningJournalBootstrapPath(
    journalPath,
  );
  const state = inspectLiteRuntimeDeploymentSlotProvisioningJournalPublication(
    journalPath,
  );
  if (state === "published") {
    syncFileAndParent(journalPath);
    return;
  }
  if (state !== "recoverable_linked") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning journal is not in a linked publication state",
    );
  }
  syncPath(dirname(journalPath), true);
  if (inspectLiteRuntimeDeploymentSlotProvisioningJournalPublication(journalPath)
    !== "recoverable_linked") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning journal links changed before staging cleanup",
    );
  }
  try {
    unlinkSync(stagingPath);
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning journal staging link could not be removed",
    );
  }
  observeJournalFaultPointForTesting("bootstrap_staging_unlinked");
  syncPath(dirname(journalPath), true);
  inspectPrivateFile(journalPath, "published journal");
  syncFileAndParent(journalPath);
}

function discardUnpublishedJournalStaging(
  journalPath: string,
  bootstrapMutex: BootstrapMutexState,
): void {
  assertBootstrapMutexLive(bootstrapMutex);
  const stagingPath = liteRuntimeDeploymentSlotProvisioningJournalBootstrapPath(
    journalPath,
  );
  const publication = inspectLiteRuntimeDeploymentSlotProvisioningJournalPublication(
    journalPath,
  );
  if (publication === "published") {
    syncFileAndParent(journalPath);
    return;
  }
  if (publication !== "published_with_recoverable_staging") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning journal has no discardable unpublished staging",
    );
  }
  const stagingPin = openPinnedPrivateFile(
    stagingPath,
    "unpublished journal bootstrap staging",
  );
  let database: SqliteDatabase | null = null;
  let transactionOpen = false;
  try {
    database = createSqliteReadWriteExistingDatabase(stagingPath);
    configureJournalConnection(database, false);
    if (pragmaScalar(database, "journal_mode=DELETE") !== "delete") {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        "deployment-slot provisioning scratch cleanup requires SQLite DELETE mode",
      );
    }
    database.exec("BEGIN EXCLUSIVE");
    transactionOpen = true;
    database.exec("COMMIT");
    transactionOpen = false;
    assertPinnedPrivateFile(
      stagingPin,
      "recovered unpublished journal bootstrap staging",
    );
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    if (isBusyError(error)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_contended",
        "deployment-slot provisioning unpublished staging is still active",
      );
    }
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning unpublished staging could not be locked for cleanup",
    );
  } finally {
    if (transactionOpen && database) {
      try { database.exec("ROLLBACK"); } catch { /* preserve first error */ }
    }
    closeDatabaseBestEffort(database);
    closeDescriptorBestEffort(stagingPin.descriptor);
  }
  assertNoJournalSidecars(stagingPath, false);
  assertBootstrapMutexLive(bootstrapMutex);
  observeJournalFaultPointForTesting("bootstrap_scratch_cleanup_locked");
  if (inspectLiteRuntimeDeploymentSlotProvisioningJournalPublication(journalPath)
      !== "published_with_recoverable_staging") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning unpublished staging changed before cleanup",
    );
  }
  const stagingRecheck = inspectPrivateFile(
    stagingPath,
    "unpublished journal bootstrap staging cleanup target",
  );
  if (!sameIdentity(stagingPin.stat, stagingRecheck)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning unpublished staging changed before unlink",
    );
  }
  try {
    unlinkSync(stagingPath);
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning unpublished journal staging could not be removed",
    );
  }
  observeJournalFaultPointForTesting("bootstrap_staging_unlinked");
  syncPath(dirname(journalPath), true);
  assertBootstrapMutexLive(bootstrapMutex);
  if (inspectLiteRuntimeDeploymentSlotProvisioningJournalPublication(journalPath)
      !== "published") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning final journal changed during staging cleanup",
    );
  }
  syncFileAndParent(journalPath);
}

function publishJournalStaging(
  journalPath: string,
  stagingPath: string,
): "published" | "concurrent_winner" {
  try {
    linkSync(stagingPath, journalPath);
  } catch (error) {
    if (!(error && typeof error === "object"
      && (error as { code?: unknown }).code === "EEXIST")) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_io",
        "deployment-slot provisioning journal could not publish its final name",
      );
    }
    if (inspectLiteRuntimeDeploymentSlotProvisioningJournalPublication(journalPath)
        === "published_with_recoverable_staging") {
      return "concurrent_winner";
    }
  }
  if (inspectLiteRuntimeDeploymentSlotProvisioningJournalPublication(journalPath)
    !== "recoverable_linked") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning journal no-replace publication was won by another inode",
    );
  }
  observeJournalFaultPointForTesting("bootstrap_final_linked");
  syncPath(dirname(journalPath), true);
  observeJournalFaultPointForTesting("bootstrap_parent_synced");
  finishLinkedJournalPublication(journalPath);
  return "published";
}

function readJournalIntentAtPath(
  path: string,
  label: string,
  expectedLinkCount: bigint,
): LiteRuntimeDeploymentSlotProvisioningIntent {
  assertNoJournalSidecars(path, false);
  const pin = openPinnedPrivateFile(path, label, expectedLinkCount);
  let database: SqliteDatabase | null = null;
  try {
    database = createSqliteReadOnlyDatabase(path);
    configureJournalConnection(database, true);
    assertJournalPragmas(database);
    assertExactJournalSchema(database);
    const intent = readIntentRow(database);
    assertPinnedPrivateFile(pin, label);
    return intent;
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      `deployment-slot provisioning ${label} could not be read strictly`,
    );
  } finally {
    closeDatabaseBestEffort(database);
    closeDescriptorBestEffort(pin.descriptor);
  }
}

type CreateOrRecoverJournalArgs = Readonly<{
  journalPath: string;
  intentWithoutDigest?: LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest;
  intentWithoutDigestFactory?:
    () => LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest;
  validateSelectedIntent?:
    (intent: LiteRuntimeDeploymentSlotProvisioningIntent) => void;
  acceptExistingIntent: boolean;
}>;

function createOrRecoverJournalUnderMutex(
  args: CreateOrRecoverJournalArgs,
  bootstrapMutex: BootstrapMutexState,
): LiteRuntimeDeploymentSlotProvisioningIntent {
  const journalPath = assertCanonicalAbsolutePath(args.journalPath, "journal path");
  assertBootstrapMutexLive(bootstrapMutex);
  const stagingPath = liteRuntimeDeploymentSlotProvisioningJournalBootstrapPath(
    journalPath,
  );
  let selectedIntentValidationError: unknown = null;
  const validateSelectedIntent = (
    intent: LiteRuntimeDeploymentSlotProvisioningIntent,
  ): void => {
    try {
      assertJournalPathDisjoint(journalPath, intent);
      assertJournalPathDisjoint(stagingPath, intent);
      assertJournalPathDisjoint(bootstrapMutex.path, intent);
      args.validateSelectedIntent?.(intent);
    } catch (error) {
      selectedIntentValidationError = error;
      throw error;
    }
  };
  let candidateIntent: LiteRuntimeDeploymentSlotProvisioningIntent | null = null;
  const requireCandidateIntent = (): LiteRuntimeDeploymentSlotProvisioningIntent => {
    if (candidateIntent) return candidateIntent;
    const projection = args.intentWithoutDigest
      ?? args.intentWithoutDigestFactory?.();
    if (!projection) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        "deployment-slot provisioning journal requires an intent candidate for an empty bootstrap",
      );
    }
    candidateIntent = intentFromProjection(projection);
    assertJournalPathDisjoint(journalPath, candidateIntent);
    assertJournalPathDisjoint(stagingPath, candidateIntent);
    return candidateIntent;
  };
  const recoverPublishedWinnerWithScratch = (
    existing: LiteRuntimeDeploymentSlotProvisioningIntent,
    concurrentWinner: boolean,
  ): LiteRuntimeDeploymentSlotProvisioningIntent => {
    assertJournalPathDisjoint(journalPath, existing);
    validateSelectedIntent(existing);
    const conflictsWithCandidate = !args.acceptExistingIntent
      && stableStringify(existing) !== stableStringify(requireCandidateIntent());
    discardUnpublishedJournalStaging(journalPath, bootstrapMutex);
    const replayed = readLiteRuntimeDeploymentSlotProvisioningJournal(journalPath);
    if (stableStringify(replayed) !== stableStringify(existing)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning winning journal changed during scratch cleanup",
      );
    }
    if (conflictsWithCandidate) {
      return journalError(
        concurrentWinner
          ? "lite_runtime_deployment_slot_provisioning_journal_contended"
          : "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning concurrent journal winner binds a different intent",
      );
    }
    return replayed;
  };
  if (activeJournalLocks.has(journalPath)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_contended",
      "deployment-slot provisioning journal is retained by this process",
    );
  }
  const publication = inspectLiteRuntimeDeploymentSlotProvisioningJournalPublication(
    journalPath,
  );
  observeJournalFaultPointForTesting("bootstrap_publication_inspected");
  if (publication === "published") {
    const existing = readLiteRuntimeDeploymentSlotProvisioningJournal(journalPath);
    assertJournalPathDisjoint(journalPath, existing);
    validateSelectedIntent(existing);
    if (!args.acceptExistingIntent
      && stableStringify(existing) !== stableStringify(requireCandidateIntent())) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning journal already binds a different intent",
      );
    }
    syncFileAndParent(journalPath);
    return existing;
  }
  if (publication === "published_with_recoverable_staging") {
    return recoverPublishedWinnerWithScratch(
      readJournalIntentAtPath(journalPath, "published journal", 1n),
      true,
    );
  }
  if (publication === "recoverable_linked") {
    const existing = readJournalIntentAtPath(
      journalPath,
      "linked journal",
      2n,
    );
    assertJournalPathDisjoint(journalPath, existing);
    validateSelectedIntent(existing);
    if (!args.acceptExistingIntent
      && stableStringify(existing) !== stableStringify(requireCandidateIntent())) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning journal linked replay binds a different intent",
      );
    }
    finishLinkedJournalPublication(journalPath);
    const replayed = readLiteRuntimeDeploymentSlotProvisioningJournal(journalPath);
    if (stableStringify(replayed) !== stableStringify(existing)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning journal linked intent changed during publication",
      );
    }
    return replayed;
  }
  assertBootstrapMutexLive(bootstrapMutex);
  const created = createPrivateEmptyFile(stagingPath);
  if (created) {
    observeJournalFaultPointForTesting("bootstrap_staging_created");
    if (inspectLiteRuntimeDeploymentSlotProvisioningJournalPublication(journalPath)
        === "published_with_recoverable_staging") {
      return recoverPublishedWinnerWithScratch(
        readJournalIntentAtPath(journalPath, "published journal", 1n),
        true,
      );
    }
  }
  const pin = openPinnedPrivateFile(stagingPath, "journal bootstrap staging");
  let database: SqliteDatabase | null = null;
  let transactionOpen = false;
  let selectedIntent: LiteRuntimeDeploymentSlotProvisioningIntent | null = null;
  try {
    assertNoJournalSidecars(stagingPath, true);
    database = createSqliteReadWriteExistingDatabase(stagingPath);
    configureJournalConnection(database, false);
    const selectedJournalMode = pragmaScalar(database, "journal_mode=DELETE");
    if (selectedJournalMode !== "delete") {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        "deployment-slot provisioning journal requires SQLite DELETE mode",
      );
    }
    observeJournalFaultPointForTesting("bootstrap_sqlite_opened");
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const objectCount = journalSchemaObjectCount(database);
    if (objectCount === 0) {
      selectedIntent = requireCandidateIntent();
      validateSelectedIntent(selectedIntent);
      database.exec(JOURNAL_SCHEMA_SQL);
      database.exec(`
        PRAGMA application_id = ${JOURNAL_APPLICATION_ID};
        PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION};
      `);
      insertIntent(database, selectedIntent);
      observeJournalFaultPointForTesting("bootstrap_transaction_dirty");
      assertJournalPragmas(database);
      assertExactJournalSchema(database);
      database.exec("COMMIT");
      transactionOpen = false;
      observeJournalFaultPointForTesting("bootstrap_transaction_committed");
    } else {
      assertJournalPragmas(database);
      assertExactJournalSchema(database);
      selectedIntent = readIntentRow(database);
      assertJournalPathDisjoint(journalPath, selectedIntent);
      validateSelectedIntent(selectedIntent);
      if (!args.acceptExistingIntent
        && stableStringify(selectedIntent) !== stableStringify(requireCandidateIntent())) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_conflict",
          "deployment-slot provisioning journal already binds a different intent",
        );
      }
      database.exec("ROLLBACK");
      transactionOpen = false;
    }
    assertPinnedPrivateFile(pin, "journal bootstrap staging");
  } catch (error) {
    if (error === selectedIntentValidationError) throw error;
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    if (isBusyError(error)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_contended",
        "deployment-slot provisioning journal is held by another process",
      );
    }
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning journal could not be initialized",
    );
  } finally {
    if (transactionOpen && database) {
      try { database.exec("ROLLBACK"); } catch { /* preserve first error */ }
    }
    closeDatabaseBestEffort(database);
    closeDescriptorBestEffort(pin.descriptor);
  }
  if (!selectedIntent) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal lost its selected intent",
    );
  }
  syncFileAndParent(stagingPath);
  assertNoJournalSidecars(stagingPath, false);
  observeJournalFaultPointForTesting("bootstrap_schema_committed");
  assertBootstrapMutexLive(bootstrapMutex);
  if (publishJournalStaging(journalPath, stagingPath) === "concurrent_winner") {
    return recoverPublishedWinnerWithScratch(
      readJournalIntentAtPath(journalPath, "published journal", 1n),
      true,
    );
  }
  const replayed = readLiteRuntimeDeploymentSlotProvisioningJournal(journalPath);
  if (stableStringify(replayed) !== stableStringify(selectedIntent)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning journal exact replay changed after commit",
    );
  }
  return replayed;
}

function createOrRecoverJournal(
  args: CreateOrRecoverJournalArgs,
): LiteRuntimeDeploymentSlotProvisioningIntent {
  if (args.intentWithoutDigest) {
    const journalPath = assertCanonicalAbsolutePath(args.journalPath, "journal path");
    const candidate = intentFromProjection(args.intentWithoutDigest);
    assertJournalPathDisjoint(journalPath, candidate);
    assertJournalPathDisjoint(
      liteRuntimeDeploymentSlotProvisioningJournalBootstrapPath(journalPath),
      candidate,
    );
    assertJournalPathDisjoint(
      liteRuntimeDeploymentSlotProvisioningJournalBootstrapMutexPath(journalPath),
      candidate,
    );
  }
  const bootstrapMutex = acquireBootstrapMutex(args.journalPath);
  try {
    return createOrRecoverJournalUnderMutex(args, bootstrapMutex);
  } finally {
    releaseBootstrapMutex(bootstrapMutex);
  }
}

/**
 * Creates the immutable intent through failure-atomic staging. Existing
 * publication is an exact replay only for the same candidate intent.
 */
export function createLiteRuntimeDeploymentSlotProvisioningJournal(args: Readonly<{
  journalPath: string;
  intentWithoutDigest: LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest;
}>): LiteRuntimeDeploymentSlotProvisioningIntent {
  return createOrRecoverJournal({ ...args, acceptExistingIntent: false });
}

/**
 * Recovers a private bootstrap prefix. If its transaction committed, the
 * durable intent wins; if it rolled back to empty, the supplied candidate is
 * inserted before atomic publication.
 */
export function recoverOrCreateLiteRuntimeDeploymentSlotProvisioningJournal(
  args: Readonly<{
    journalPath: string;
    intentWithoutDigestFactory:
      () => LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest;
    validateSelectedIntent:
      (intent: LiteRuntimeDeploymentSlotProvisioningIntent) => void;
  }>,
): LiteRuntimeDeploymentSlotProvisioningIntent {
  return createOrRecoverJournal({ ...args, acceptExistingIntent: true });
}

/** Strictly reads the immutable intent without opening a write-capable SQLite connection. */
export function readLiteRuntimeDeploymentSlotProvisioningJournal(
  journalPathValue: string,
): LiteRuntimeDeploymentSlotProvisioningIntent {
  const journalPath = assertCanonicalAbsolutePath(journalPathValue, "journal path");
  if (activeJournalLocks.has(journalPath)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_contended",
      "deployment-slot provisioning journal cannot be reopened while its lock is retained",
    );
  }
  return readJournalIntentAtPath(journalPath, "journal", 1n);
}

/**
 * Retains one DELETE-mode BEGIN IMMEDIATE for the complete recovery operation.
 * The caller must hold this opaque capability until all phase writes finish.
 */
export function acquireLiteRuntimeDeploymentSlotProvisioningJournalLock(
  args: Readonly<{
    journalPath: string;
    expectedIntentSha256: string;
  }>,
): LiteRuntimeDeploymentSlotProvisioningJournalLock {
  const journalPath = assertCanonicalAbsolutePath(args.journalPath, "journal path");
  const expectedIntentSha256 = assertDigest(
    args.expectedIntentSha256,
    "expected intent digest",
  );
  if (activeJournalLocks.has(journalPath)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_contended",
      "deployment-slot provisioning journal lock is already held by this process",
    );
  }
  // The published intent is immutable and the lock transaction never writes
  // it, so a rollback sidecar is never a legitimate lock-acquire prefix.
  assertNoJournalSidecars(journalPath, false);
  const pin = openPinnedPrivateFile(journalPath, "journal");
  let database: SqliteDatabase | null = null;
  let transactionOpen = false;
  let retained = false;
  try {
    database = createSqliteReadWriteExistingDatabase(journalPath);
    configureJournalConnection(database, false);
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const livenessSavepoint = `provisioning_lock_${randomBytes(32).toString("hex")}`;
    database.exec(`SAVEPOINT ${livenessSavepoint}`);
    assertJournalPragmas(database);
    assertExactJournalSchema(database);
    const intent = readIntentRow(database);
    if (intent.intent_sha256 !== expectedIntentSha256) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning journal lock binds a different intent",
      );
    }
    assertPinnedPrivateFile(pin, "journal");
    assertNoJournalSidecars(journalPath, false);
    const capability = Object.freeze(Object.create(null)) as
      LiteRuntimeDeploymentSlotProvisioningJournalLock;
    journalLockRegistry.set(capability, {
      journalPath,
      database,
      pin,
      intent,
      livenessSavepoint,
      released: false,
    });
    activeJournalLocks.set(journalPath, capability);
    retained = true;
    database = null;
    transactionOpen = false;
    return capability;
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    if (isBusyError(error)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_contended",
        "deployment-slot provisioning journal lock is held by another process",
      );
    }
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal lock could not validate its journal",
    );
  } finally {
    if (transactionOpen && database) {
      try { database.exec("ROLLBACK"); } catch { /* preserve first error */ }
    }
    if (database) {
      closeDatabaseBestEffort(database);
    }
    if (!retained) {
      closeDescriptorBestEffort(pin.descriptor);
    }
  }
}

function requiredLiveJournalLockState(
  capability: LiteRuntimeDeploymentSlotProvisioningJournalLock,
): JournalLockState {
  if (!capability || typeof capability !== "object") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal append requires a live lock capability",
    );
  }
  const state = journalLockRegistry.get(capability);
  if (!state || state.released || activeJournalLocks.get(state.journalPath) !== capability) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal lock capability is forged, released, or detached",
    );
  }
  try {
    state.database.exec(`ROLLBACK TO SAVEPOINT ${state.livenessSavepoint}`);
    assertPinnedPrivateFile(state.pin, "journal");
    assertNoJournalSidecars(state.journalPath, false);
    const currentIntent = readIntentRow(state.database);
    if (stableStringify(currentIntent) !== stableStringify(state.intent)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning journal intent changed while its lock was retained",
      );
    }
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_contended",
      "deployment-slot provisioning journal lock transaction is no longer live",
    );
  }
  return state;
}

/** Revalidates the live lock immediately around an external authority mutation. */
export function assertLiteRuntimeDeploymentSlotProvisioningJournalLockLive(
  args: Readonly<{
    lock: LiteRuntimeDeploymentSlotProvisioningJournalLock;
    expectedIntentSha256: string;
    phaseDirectoryPath: string;
  }>,
): void {
  const state = requiredLiveJournalLockState(args.lock);
  const expectedIntentSha256 = assertDigest(
    args.expectedIntentSha256,
    "expected intent digest",
  );
  const phaseDirectoryPath = assertCanonicalAbsolutePath(
    args.phaseDirectoryPath,
    "phase directory path",
  );
  if (state.intent.intent_sha256 !== expectedIntentSha256) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning lock intent differs from the recovery intent",
    );
  }
  if (join(dirname(state.journalPath), "provisioning-phases")
      !== phaseDirectoryPath) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning lock is detached from its phase directory",
    );
  }
}

/** @internal Invalidates only the retained savepoint for deterministic tests. */
export function invalidateLiteRuntimeDeploymentSlotProvisioningJournalLockForTesting(
  capability: LiteRuntimeDeploymentSlotProvisioningJournalLock,
): void {
  if (!capability || typeof capability !== "object") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning test lock capability is invalid",
    );
  }
  const state = journalLockRegistry.get(capability);
  if (!state || state.released
    || activeJournalLocks.get(state.journalPath) !== capability) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning test lock capability is not live",
    );
  }
  state.database.exec(`RELEASE SAVEPOINT ${state.livenessSavepoint}`);
}

export function releaseLiteRuntimeDeploymentSlotProvisioningJournalLock(
  capability: LiteRuntimeDeploymentSlotProvisioningJournalLock,
): void {
  if (!capability || typeof capability !== "object") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal lock capability is invalid",
    );
  }
  const state = journalLockRegistry.get(capability);
  if (!state || state.released) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning journal lock capability is forged or released",
    );
  }
  let firstError: unknown = null;
  try {
    assertPinnedPrivateFile(state.pin, "journal");
  } catch (error) {
    firstError = error;
  }
  try {
    state.database.exec("ROLLBACK");
  } catch (error) {
    firstError ??= error;
  }
  try {
    state.database.close();
  } catch (error) {
    firstError ??= error;
  }
  try {
    closeSync(state.pin.descriptor);
  } catch (error) {
    firstError ??= error;
  }
  state.released = true;
  activeJournalLocks.delete(state.journalPath);
  if (firstError) {
    if (firstError instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) {
      throw firstError;
    }
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning journal lock could not be released cleanly",
    );
  }
}

function ensurePhaseDirectory(path: string): void {
  const phaseDirectoryPath = assertCanonicalAbsolutePath(path, "phase directory path");
  let created = false;
  if (!pathExists(phaseDirectoryPath)) {
    assertTrustedParent(phaseDirectoryPath, "phase directory");
    try {
      mkdirSync(phaseDirectoryPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
      if (!(error && typeof error === "object"
        && (error as { code?: unknown }).code === "EEXIST")) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_io",
          "deployment-slot provisioning phase directory creation failed",
        );
      }
    }
  }
  if (created) {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        phaseDirectoryPath,
        fsConstants.O_RDONLY
          | requiredFlag("O_DIRECTORY")
          | requiredFlag("O_NOFOLLOW"),
      );
      fchmodSync(descriptor, 0o700);
      const opened = fstatSync(descriptor, { bigint: true });
      const named = lstatSync(phaseDirectoryPath, { bigint: true });
      if (!sameIdentity(opened, named)
        || !opened.isDirectory()
        || opened.uid !== currentServiceUid()
        || (opened.mode & 0o7777n) !== 0o700n) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_conflict",
          "deployment-slot provisioning phase directory changed while being created",
        );
      }
      fsyncSync(descriptor);
    } catch (error) {
      if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_io",
        "deployment-slot provisioning phase directory could not be secured",
      );
    } finally {
      if (descriptor !== null) closeDescriptorBestEffort(descriptor);
    }
  }
  assertTrustedDirectory(phaseDirectoryPath, "phase directory");
  // Existing directories can be the durable result of a crash before the
  // original parent fsync. Every replay therefore repairs both sync edges.
  syncDirectoryAndParent(phaseDirectoryPath);
}

function phaseFrom(value: unknown): LiteRuntimeDeploymentSlotProvisioningPhase {
  if (typeof value !== "string"
    || !(PROVISIONING_PHASES as readonly string[]).includes(value)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning receipt phase is invalid",
    );
  }
  return value as LiteRuntimeDeploymentSlotProvisioningPhase;
}

function receiptProjection(
  value: Omit<LiteRuntimeDeploymentSlotProvisioningPhaseReceipt, "receipt_sha256">,
): Omit<LiteRuntimeDeploymentSlotProvisioningPhaseReceipt, "receipt_sha256"> {
  return Object.freeze({
    contract_version: value.contract_version,
    intent_sha256: value.intent_sha256,
    phase: value.phase,
    evidence_json: value.evidence_json,
    evidence_sha256: value.evidence_sha256,
    previous_receipt_sha256: value.previous_receipt_sha256,
    recorded_at: value.recorded_at,
  });
}

function buildReceipt(args: Readonly<{
  intentSha256: string;
  phase: LiteRuntimeDeploymentSlotProvisioningPhase;
  evidenceJson: string;
  previousReceiptSha256: string | null;
  recordedAt: string;
}>): LiteRuntimeDeploymentSlotProvisioningPhaseReceipt {
  const projection = receiptProjection({
    contract_version: PHASE_RECEIPT_CONTRACT,
    intent_sha256: assertDigest(args.intentSha256, "intent digest"),
    phase: args.phase,
    evidence_json: args.evidenceJson,
    evidence_sha256: sha256(args.evidenceJson),
    previous_receipt_sha256: args.previousReceiptSha256,
    recorded_at: args.recordedAt,
  });
  return Object.freeze({
    ...projection,
    receipt_sha256: sha256(stableStringify(projection)),
  });
}

function validateReceipt(value: unknown): LiteRuntimeDeploymentSlotProvisioningPhaseReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning phase receipt must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(record, RECEIPT_KEYS, "phase receipt");
  if (record.contract_version !== PHASE_RECEIPT_CONTRACT
    || typeof record.evidence_json !== "string") {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning phase receipt contract is invalid",
    );
  }
  let parsedEvidence: unknown;
  try {
    parsedEvidence = JSON.parse(record.evidence_json) as unknown;
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning phase evidence is not valid JSON",
    );
  }
  const evidenceJson = canonicalJson(
    parsedEvidence,
    "phase evidence",
    MAX_EVIDENCE_BYTES,
  );
  if (evidenceJson !== record.evidence_json
    || sha256(evidenceJson) !== record.evidence_sha256) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning phase evidence digest is invalid",
    );
  }
  const previousReceiptSha256 = record.previous_receipt_sha256 === null
    ? null
    : assertDigest(record.previous_receipt_sha256, "previous receipt digest");
  const projection = receiptProjection({
    contract_version: PHASE_RECEIPT_CONTRACT,
    intent_sha256: assertDigest(record.intent_sha256, "intent digest"),
    phase: phaseFrom(record.phase),
    evidence_json: evidenceJson,
    evidence_sha256: assertDigest(record.evidence_sha256, "evidence digest"),
    previous_receipt_sha256: previousReceiptSha256,
    recorded_at: assertCanonicalTime(record.recorded_at, "receipt time"),
  });
  const receiptSha256 = assertDigest(record.receipt_sha256, "receipt digest");
  if (sha256(stableStringify(projection)) !== receiptSha256) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning phase receipt digest is invalid",
    );
  }
  return Object.freeze({ ...projection, receipt_sha256: receiptSha256 });
}

function assertPhaseTransition(
  previous: LiteRuntimeDeploymentSlotProvisioningPhase | null,
  next: LiteRuntimeDeploymentSlotProvisioningPhase,
): void {
  if (previous === null) {
    if (next === "intent_durable") return;
  } else if (previous !== "committed" && previous !== "aborted") {
    if (next === "aborted") return;
    const previousIndex = PROVISIONING_PHASES.indexOf(previous);
    if (previousIndex >= 0 && next === PROVISIONING_PHASES[previousIndex + 1]) return;
  }
  return journalError(
    "lite_runtime_deployment_slot_provisioning_journal_conflict",
    `deployment-slot provisioning phase ${next} is not the next append-only transition`,
  );
}

function receiptFileName(index: number): string {
  return `${String(index + 1).padStart(4, "0")}.json`;
}

function receiptStagingFileName(index: number, receiptSha256: string): string {
  return `.${receiptFileName(index)}.${receiptSha256}.pending`;
}

const RECEIPT_STAGING_NAME = /^\.(\d{4}\.json)\.([0-9a-f]{64})\.pending$/u;

type PendingReceiptPublication = Readonly<{
  path: string;
  finalPath: string;
  index: number;
  linked: boolean;
  receipt: LiteRuntimeDeploymentSlotProvisioningPhaseReceipt | null;
}>;

type ReceiptPrefixInspection = Readonly<{
  receipts: readonly LiteRuntimeDeploymentSlotProvisioningPhaseReceipt[];
  pending: PendingReceiptPublication | null;
}>;

function assertReceiptChainEntry(
  receipt: LiteRuntimeDeploymentSlotProvisioningPhaseReceipt,
  previous: LiteRuntimeDeploymentSlotProvisioningPhaseReceipt | null,
  intent: LiteRuntimeDeploymentSlotProvisioningIntent,
): void {
  if (receipt.intent_sha256 !== intent.intent_sha256
    || receipt.previous_receipt_sha256 !== (previous?.receipt_sha256 ?? null)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning receipt chain is detached from its intent",
    );
  }
  assertPhaseTransition(previous?.phase ?? null, receipt.phase);
  const timeFloor = previous?.recorded_at ?? intent.created_at;
  if (receipt.recorded_at < timeFloor) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning receipt time moved behind its durable lineage",
    );
  }
}

function readProvisioningReceiptPrefix(
  args: Readonly<{
    phaseDirectoryPath: string;
    intent: LiteRuntimeDeploymentSlotProvisioningIntent;
  }>,
): ReceiptPrefixInspection {
  const phaseDirectoryPath = assertCanonicalAbsolutePath(
    args.phaseDirectoryPath,
    "phase directory path",
  );
  const intent = validateIntent(args.intent);
  if (!pathExists(phaseDirectoryPath)) {
    assertTrustedParent(phaseDirectoryPath, "phase directory");
    return Object.freeze({ receipts: Object.freeze([]), pending: null });
  }
  const before = assertTrustedDirectory(phaseDirectoryPath, "phase directory");
  let names: string[];
  try {
    names = readdirSync(phaseDirectoryPath).sort();
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning phase directory could not be enumerated",
    );
  }
  if (names.length > PROVISIONING_PHASES.length + 1) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning phase directory contains too many receipts",
    );
  }
  const finalNames = names.filter((name) => /^\d{4}\.json$/u.test(name)).sort();
  const pendingNames = names.filter((name) => RECEIPT_STAGING_NAME.test(name));
  if (finalNames.length + pendingNames.length !== names.length
    || pendingNames.length > 1
    || finalNames.length > PROVISIONING_PHASES.length) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning phase directory contains a non-canonical artifact",
    );
  }
  for (let index = 0; index < finalNames.length; index += 1) {
    if (finalNames[index] !== receiptFileName(index)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        "deployment-slot provisioning phase directory is not a complete canonical prefix",
      );
    }
  }

  let pendingIndex: number | null = null;
  let pendingDigest: string | null = null;
  let pendingPath: string | null = null;
  let pendingLinked = false;
  if (pendingNames.length === 1) {
    const pendingName = pendingNames[0]!;
    const match = RECEIPT_STAGING_NAME.exec(pendingName)!;
    const finalName = match[1]!;
    pendingDigest = match[2]!;
    pendingIndex = Number.parseInt(finalName.slice(0, 4), 10) - 1;
    if (!Number.isSafeInteger(pendingIndex)
      || pendingIndex < 0
      || pendingIndex > PROVISIONING_PHASES.length - 1
      || (pendingIndex !== finalNames.length
        && pendingIndex !== finalNames.length - 1)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        "deployment-slot provisioning receipt staging is not at the append head",
      );
    }
    pendingPath = join(phaseDirectoryPath, pendingName);
    pendingLinked = pendingIndex === finalNames.length - 1;
    const pendingStat = inspectPrivateFile(
      pendingPath,
      "phase receipt staging",
      pendingLinked ? 2n : 1n,
    );
    if (pendingStat.size > BigInt(MAX_RECEIPT_BYTES)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        "deployment-slot provisioning receipt staging exceeds its size limit",
      );
    }
    if (pendingLinked) {
      const finalStat = inspectPrivateFile(
        join(phaseDirectoryPath, finalName),
        "linked phase receipt",
        2n,
      );
      if (!sameIdentity(pendingStat, finalStat)) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_conflict",
          "deployment-slot provisioning receipt final and staging names bind different inodes",
        );
      }
    }
  }

  const receipts: LiteRuntimeDeploymentSlotProvisioningPhaseReceipt[] = [];
  let linkedFinalReceipt: LiteRuntimeDeploymentSlotProvisioningPhaseReceipt | null = null;
  for (let index = 0; index < finalNames.length; index += 1) {
    const expectedName = receiptFileName(index);
    const value = decodeCanonicalJsonFile(
      join(phaseDirectoryPath, expectedName),
      "phase receipt",
      MAX_RECEIPT_BYTES,
      pendingLinked && pendingIndex === index ? 2n : 1n,
    );
    const receipt = validateReceipt(value);
    const previous = receipts.at(-1) ?? null;
    assertReceiptChainEntry(receipt, previous, intent);
    if (pendingLinked && pendingIndex === index) {
      // A visible final hard link is not yet a durable phase: the directory
      // fsync may not have happened. Keep it as the publication head until a
      // live lock repairs the sync edge and removes staging.
      linkedFinalReceipt = receipt;
    } else {
      receipts.push(receipt);
    }
  }

  let pending: PendingReceiptPublication | null = null;
  if (pendingPath !== null && pendingIndex !== null && pendingDigest !== null) {
    let pendingReceipt: LiteRuntimeDeploymentSlotProvisioningPhaseReceipt | null = null;
    let pendingValue: Record<string, unknown> | null = null;
    try {
      pendingValue = decodeCanonicalJsonFile(
        pendingPath,
        "phase receipt staging",
        MAX_RECEIPT_BYTES,
        pendingLinked ? 2n : 1n,
      );
    } catch (error) {
      if (pendingLinked) throw error;
      if (!(error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError)) throw error;
      if (error.code
        !== "lite_runtime_deployment_slot_provisioning_journal_invalid") throw error;
      // An unpublished private staging file is scratch. A kill can leave it
      // empty or partially written, so its bytes are intentionally recoverable.
      pendingValue = null;
    }
    if (pendingValue !== null) pendingReceipt = validateReceipt(pendingValue);
    if (pendingReceipt !== null) {
      if (pendingReceipt.receipt_sha256 !== pendingDigest) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_invalid",
          "deployment-slot provisioning receipt staging name has the wrong digest",
        );
      }
      if (pendingLinked) {
        if (!linkedFinalReceipt
          || stableStringify(linkedFinalReceipt)
            !== stableStringify(pendingReceipt)) {
          return journalError(
            "lite_runtime_deployment_slot_provisioning_journal_conflict",
            "deployment-slot provisioning linked receipt changed during publication",
          );
        }
      } else {
        assertReceiptChainEntry(pendingReceipt, receipts.at(-1) ?? null, intent);
      }
    }
    pending = Object.freeze({
      path: pendingPath,
      finalPath: join(phaseDirectoryPath, receiptFileName(pendingIndex)),
      index: pendingIndex,
      linked: pendingLinked,
      receipt: pendingReceipt,
    });
  }

  let afterNames: string[];
  let after: BigIntStats;
  try {
    afterNames = readdirSync(phaseDirectoryPath).sort();
    after = assertTrustedDirectory(phaseDirectoryPath, "phase directory");
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning phase directory changed during inspection",
    );
  }
  if (!sameIdentity(before, after)
    || before.uid !== after.uid
    || before.gid !== after.gid
    || before.mode !== after.mode
    || before.nlink !== after.nlink
    || stableStringify(afterNames) !== stableStringify(names)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning phase directory changed during inspection",
    );
  }
  return Object.freeze({ receipts: Object.freeze(receipts), pending });
}

/** Strictly verifies committed receipts and any recoverable publication head. */
export function readLiteRuntimeDeploymentSlotProvisioningPhaseReceipts(
  args: Readonly<{
    phaseDirectoryPath: string;
    intent: LiteRuntimeDeploymentSlotProvisioningIntent;
  }>,
): readonly LiteRuntimeDeploymentSlotProvisioningPhaseReceipt[] {
  return readProvisioningReceiptPrefix(args).receipts;
}

function writeReceiptStaging(
  stagingPath: string,
  receipt: LiteRuntimeDeploymentSlotProvisioningPhaseReceipt,
  lock: LiteRuntimeDeploymentSlotProvisioningJournalLock,
): void {
  const bytes = Buffer.from(stableStringify(receipt), "utf8");
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_RECEIPT_BYTES) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning phase receipt exceeds its size limit",
    );
  }
  let descriptor: number | null = null;
  try {
    requiredLiveJournalLockState(lock);
    descriptor = openSync(
      stagingPath,
      fsConstants.O_CREAT
        | requiredFlag("O_EXCL")
        | fsConstants.O_WRONLY
        | requiredFlag("O_NOFOLLOW"),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    observeJournalFaultPointForTesting("receipt_staging_created");
    requiredLiveJournalLockState(lock);
    let offset = 0;
    const firstWriteBoundary = Math.max(1, Math.floor(bytes.byteLength / 2));
    let partialWriteObserved = false;
    while (offset < bytes.byteLength) {
      const writeBoundary = partialWriteObserved
        ? bytes.byteLength
        : firstWriteBoundary;
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        writeBoundary - offset,
        offset,
      );
      if (written <= 0) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_io",
          "deployment-slot provisioning phase receipt write made no progress",
        );
      }
      offset += written;
      if (!partialWriteObserved && offset === firstWriteBoundary) {
        partialWriteObserved = true;
        observeJournalFaultPointForTesting("receipt_partial_written");
        requiredLiveJournalLockState(lock);
      }
    }
    requiredLiveJournalLockState(lock);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()
      || stat.uid !== currentServiceUid()
      || stat.nlink !== 1n
      || (stat.mode & 0o7777n) !== 0o600n
      || stat.size !== BigInt(bytes.byteLength)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_invalid",
        "deployment-slot provisioning phase receipt physical identity is invalid",
      );
    }
    observeJournalFaultPointForTesting("receipt_file_synced");
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError) throw error;
    if (error && typeof error === "object"
      && (error as { code?: unknown }).code === "EEXIST") {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning phase receipt sequence was won concurrently",
      );
    }
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning phase receipt could not be created",
    );
  } finally {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
  }
  requiredLiveJournalLockState(lock);
  inspectPrivateFile(stagingPath, "phase receipt staging");
  syncFileAndParent(stagingPath);
  observeJournalFaultPointForTesting("receipt_staging_synced");
  requiredLiveJournalLockState(lock);
}

function removeUnpublishedReceiptStaging(
  pending: PendingReceiptPublication,
  lock: LiteRuntimeDeploymentSlotProvisioningJournalLock,
): void {
  if (pending.linked) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning cannot discard an already-linked receipt",
    );
  }
  requiredLiveJournalLockState(lock);
  inspectPrivateFile(pending.path, "unpublished phase receipt staging");
  requiredLiveJournalLockState(lock);
  try {
    unlinkSync(pending.path);
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning incomplete receipt staging could not be reset",
    );
  }
  syncPath(dirname(pending.path), true);
  requiredLiveJournalLockState(lock);
}

function finishPendingReceiptPublication(
  pending: PendingReceiptPublication,
  lock: LiteRuntimeDeploymentSlotProvisioningJournalLock,
): LiteRuntimeDeploymentSlotProvisioningPhaseReceipt {
  const receipt = pending.receipt;
  if (!receipt) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning cannot publish incomplete receipt staging bytes",
    );
  }
  requiredLiveJournalLockState(lock);
  if (!pending.linked) {
    requiredLiveJournalLockState(lock);
    try {
      linkSync(pending.path, pending.finalPath);
    } catch (error) {
      if (!(error && typeof error === "object"
        && (error as { code?: unknown }).code === "EEXIST")) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_io",
          "deployment-slot provisioning receipt final name could not be published",
        );
      }
    }
    const stagingStat = inspectPrivateFile(
      pending.path,
      "linked phase receipt staging",
      2n,
    );
    const finalStat = inspectPrivateFile(
      pending.finalPath,
      "linked phase receipt",
      2n,
    );
    if (!sameIdentity(stagingStat, finalStat)) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        "deployment-slot provisioning receipt no-replace publish was won by another inode",
      );
    }
    observeJournalFaultPointForTesting("receipt_final_linked");
    requiredLiveJournalLockState(lock);
  }
  requiredLiveJournalLockState(lock);
  syncPath(dirname(pending.finalPath), true);
  observeJournalFaultPointForTesting("receipt_parent_synced");
  requiredLiveJournalLockState(lock);
  const cleanupStagingStat = inspectPrivateFile(
    pending.path,
    "linked phase receipt staging before cleanup",
    2n,
  );
  const cleanupFinalStat = inspectPrivateFile(
    pending.finalPath,
    "linked phase receipt before cleanup",
    2n,
  );
  if (!sameIdentity(cleanupStagingStat, cleanupFinalStat)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning receipt links changed before staging cleanup",
    );
  }
  requiredLiveJournalLockState(lock);
  try {
    unlinkSync(pending.path);
  } catch {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_io",
      "deployment-slot provisioning receipt staging link could not be removed",
    );
  }
  observeJournalFaultPointForTesting("receipt_staging_unlinked");
  requiredLiveJournalLockState(lock);
  syncPath(dirname(pending.finalPath), true);
  inspectPrivateFile(pending.finalPath, "published phase receipt");
  syncFileAndParent(pending.finalPath);
  requiredLiveJournalLockState(lock);
  return receipt;
}

function receiptMatchesOperation(
  receipt: LiteRuntimeDeploymentSlotProvisioningPhaseReceipt,
  args: Readonly<{
    intentSha256: string;
    phase: LiteRuntimeDeploymentSlotProvisioningPhase;
    evidenceJson: string;
    previousReceiptSha256: string | null;
  }>,
): boolean {
  return receipt.intent_sha256 === args.intentSha256
    && receipt.phase === args.phase
    && receipt.evidence_json === args.evidenceJson
    && receipt.previous_receipt_sha256 === args.previousReceiptSha256;
}

/**
 * Appends exactly one immutable phase receipt. Callers must retain the journal
 * lock for the whole classify/resume operation; this function never deletes or
 * rewrites an existing receipt.
 */
export function appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt(
  args: Readonly<{
    lock: LiteRuntimeDeploymentSlotProvisioningJournalLock;
    phaseDirectoryPath: string;
    phase: LiteRuntimeDeploymentSlotProvisioningPhase;
    evidence: unknown;
    recordedAt: Date;
  }>,
): LiteRuntimeDeploymentSlotProvisioningPhaseReceipt {
  const phaseDirectoryPath = assertCanonicalAbsolutePath(
    args.phaseDirectoryPath,
    "phase directory path",
  );
  const lockState = requiredLiveJournalLockState(args.lock);
  const expectedPhaseDirectoryPath = join(
    dirname(lockState.journalPath),
    "provisioning-phases",
  );
  if (phaseDirectoryPath !== expectedPhaseDirectoryPath) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
      "deployment-slot provisioning lock is not bound to this phase directory",
    );
  }
  const intent = lockState.intent;
  const intentSha256 = intent.intent_sha256;
  const phase = phaseFrom(args.phase);
  const evidenceJson = canonicalJson(args.evidence, "phase evidence", MAX_EVIDENCE_BYTES);
  const requestedRecordedAt = canonicalRecordedAt(args.recordedAt);
  requiredLiveJournalLockState(args.lock);
  ensurePhaseDirectory(phaseDirectoryPath);
  requiredLiveJournalLockState(args.lock);
  let prefix = readProvisioningReceiptPrefix({
    phaseDirectoryPath,
    intent,
  });
  if (prefix.pending?.linked) {
    finishPendingReceiptPublication(prefix.pending, args.lock);
    prefix = readProvisioningReceiptPrefix({ phaseDirectoryPath, intent });
  }
  if (prefix.pending) {
    const previous = prefix.receipts.at(prefix.pending.index - 1) ?? null;
    if (prefix.pending.receipt === null) {
      removeUnpublishedReceiptStaging(prefix.pending, args.lock);
    } else if (!receiptMatchesOperation(prefix.pending.receipt, {
      intentSha256,
      phase,
      evidenceJson,
      previousReceiptSha256: previous?.receipt_sha256 ?? null,
    })) {
      if (phase !== "aborted" || prefix.pending.linked) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_conflict",
          "deployment-slot provisioning pending receipt belongs to a different transition",
        );
      }
      // A valid but unpublished next-phase staging file is still scratch. An
      // explicit abort may discard it and tombstone the last published prefix.
      removeUnpublishedReceiptStaging(prefix.pending, args.lock);
    } else {
      const recovered = finishPendingReceiptPublication(prefix.pending, args.lock);
      const replayed = readProvisioningReceiptPrefix({
        phaseDirectoryPath,
        intent,
      });
      const committed = replayed.receipts[prefix.pending.index];
      if (!committed
        || stableStringify(committed) !== stableStringify(recovered)) {
        return journalError(
          "lite_runtime_deployment_slot_provisioning_journal_conflict",
          "deployment-slot provisioning recovered receipt changed after publication",
        );
      }
      return committed;
    }
    prefix = readProvisioningReceiptPrefix({ phaseDirectoryPath, intent });
  }
  const existing = prefix.receipts;
  const existingReceipt = existing.find((receipt) => receipt.phase === phase);
  if (existingReceipt) {
    const index = existing.indexOf(existingReceipt);
    const previousReceiptSha256 = index === 0
      ? null
      : existing[index - 1]!.receipt_sha256;
    if (!receiptMatchesOperation(existingReceipt, {
      intentSha256,
      phase,
      evidenceJson,
      previousReceiptSha256,
    })) {
      return journalError(
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
        `deployment-slot provisioning phase ${phase} exact replay conflicts with its receipt`,
      );
    }
    requiredLiveJournalLockState(args.lock);
    syncFileAndParent(join(phaseDirectoryPath, receiptFileName(index)));
    requiredLiveJournalLockState(args.lock);
    return existingReceipt;
  }
  const previous = existing.at(-1) ?? null;
  assertPhaseTransition(previous?.phase ?? null, phase);
  const recordedAt = canonicalRecordedAt(new Date(Math.max(
    Date.parse(requestedRecordedAt),
    Date.parse(intent.created_at),
    Date.parse(previous?.recorded_at ?? intent.created_at),
  )));
  const receipt = buildReceipt({
    intentSha256,
    phase,
    evidenceJson,
    previousReceiptSha256: previous?.receipt_sha256 ?? null,
    recordedAt,
  });
  const stagingPath = join(
    phaseDirectoryPath,
    receiptStagingFileName(existing.length, receipt.receipt_sha256),
  );
  requiredLiveJournalLockState(args.lock);
  writeReceiptStaging(stagingPath, receipt, args.lock);
  const pending = readProvisioningReceiptPrefix({
    phaseDirectoryPath,
    intent,
  }).pending;
  if (!pending || pending.receipt === null
    || stableStringify(pending.receipt) !== stableStringify(receipt)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning receipt staging changed before publication",
    );
  }
  finishPendingReceiptPublication(pending, args.lock);
  const replayed = readProvisioningReceiptPrefix({ phaseDirectoryPath, intent });
  const committed = replayed.receipts.at(-1);
  if (!committed || stableStringify(committed) !== stableStringify(receipt)) {
    return journalError(
      "lite_runtime_deployment_slot_provisioning_journal_conflict",
      "deployment-slot provisioning phase receipt changed after durable append",
    );
  }
  return committed;
}
