import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import stableStringify from "fast-json-stable-stringify";

import type { LiteRuntimeDatabase } from "../../../../src/store/lite-runtime-database.js";
import {
  assertLiteRuntimeProtectedAuthorityDatabasePinned,
  inspectLiteRuntimeProtectedAuthorityDatabase,
  openLiteRuntimeProtectedAuthorityDatabase,
  type LiteRuntimeProtectedAuthorityDatabasePin,
} from "./lite-runtime-protected-authority-database.js";

export type LiteRuntimeAttestationWriterFenceErrorCode =
  | "lite_runtime_attestation_writer_fence_capability_invalid"
  | "lite_runtime_attestation_writer_fence_closed"
  | "lite_runtime_attestation_writer_fence_platform_unsupported"
  | "lite_runtime_attestation_writer_fence_acquire_failed"
  | "lite_runtime_attestation_writer_fence_wal_required"
  | "lite_runtime_attestation_writer_fence_checkpoint_incomplete"
  | "lite_runtime_attestation_writer_fence_identity_changed"
  | "lite_runtime_attestation_writer_fence_handoff_already_opened"
  | "lite_runtime_attestation_writer_fence_release_failed";

export class LiteRuntimeAttestationWriterFenceError extends Error {
  readonly code: LiteRuntimeAttestationWriterFenceErrorCode;

  constructor(code: LiteRuntimeAttestationWriterFenceErrorCode, message: string) {
    super(message);
    this.name = "LiteRuntimeAttestationWriterFenceError";
    this.code = code;
  }
}

function fenceError(
  code: LiteRuntimeAttestationWriterFenceErrorCode,
  message: string,
): never {
  throw new LiteRuntimeAttestationWriterFenceError(code, message);
}

const fenceBrand: unique symbol = Symbol("lite-runtime-attestation-writer-fence");

/**
 * Opaque launcher-side authority proving that one real Runtime SQLite main is
 * checkpointed while a BEGIN IMMEDIATE writer fence remains alive. This is
 * only the database-writer layer of D3. It does not prove the
 * deployment-slot lease, checkpoint generation, launcher provenance, or
 * signer-channel authority and is therefore never signing-eligible alone.
 */
export type LiteRuntimeAttestationWriterFenceCapability = Readonly<{
  [fenceBrand]: "aionis_lite_runtime_attestation_writer_fence_v1";
}>;

export type LiteRuntimeAttestationWriterFenceInspection = Readonly<{
  contract_version: "aionis_lite_runtime_attestation_writer_fence_inspection_v1";
  signing_eligible: false;
  database_realpath: string;
  database_file_device: string;
  database_file_inode: string;
  database_main_file_byte_length: string;
  database_main_file_sha256: string;
  wal_checkpoint_busy: 0;
  wal_checkpoint_log_frames: 0;
  wal_checkpointed_frames: 0;
  wal_file_byte_length: 0;
  wal_checkpointed_and_truncated: true;
  required_outer_capabilities: readonly [
    "deployment_slot_exclusive_lease",
    "durable_checkpoint_generation",
    "launcher_database_binding_receipt",
    "private_signer_channel",
  ];
}>;

type FenceState = {
  readonly pin: LiteRuntimeProtectedAuthorityDatabasePin;
  readonly database: LiteRuntimeDatabase;
  readonly descriptor: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly linkCount: bigint;
  readonly size: bigint;
  readonly inspection: LiteRuntimeAttestationWriterFenceInspection;
  handoffDescriptorOpened: boolean;
  closed: boolean;
};

const fenceRegistry = new WeakMap<object, FenceState>();
const HASH_CHUNK_BYTES = 1024 * 1024;
const OUTER_CAPABILITIES = Object.freeze([
  "deployment_slot_exclusive_lease",
  "durable_checkpoint_generation",
  "launcher_database_binding_receipt",
  "private_signer_channel",
] as const);

function requiredFenceState(
  capability: LiteRuntimeAttestationWriterFenceCapability,
): FenceState {
  if ((typeof capability !== "object" && typeof capability !== "function")
    || capability === null) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_capability_invalid",
      "Runtime attestation writer-fence capability is invalid",
    );
  }
  const state = fenceRegistry.get(capability);
  if (!state) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_capability_invalid",
      "Runtime attestation writer-fence capability is invalid",
    );
  }
  if (state.closed) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_closed",
      "Runtime attestation writer-fence capability is closed",
    );
  }
  return state;
}

function closeDescriptorBestEffort(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Cleanup must preserve the acquisition or release error that came first.
  }
}

function closeDatabaseBestEffort(database: LiteRuntimeDatabase): void {
  try {
    void database.close().catch(() => undefined);
  } catch {
    // Cleanup must preserve the acquisition or release error that came first.
  }
}

function sameFrozenIdentity(state: FenceState, stat: BigIntStats): boolean {
  return stat.isFile()
    && stat.dev === state.device
    && stat.ino === state.inode
    && stat.uid === state.uid
    && stat.gid === state.gid
    && stat.mode === state.mode
    && stat.nlink === state.linkCount
    && stat.size === state.size;
}

function sha256Descriptor(
  descriptor: number,
  expectedStat?: BigIntStats,
): Readonly<{ stat: BigIntStats; sha256: string }> {
  let before: BigIntStats;
  try {
    before = fstatSync(descriptor, { bigint: true });
  } catch {
    return fenceError(
      "lite_runtime_attestation_writer_fence_identity_changed",
      "Runtime attestation database descriptor is no longer readable",
    );
  }
  if (!before.isFile() || before.size < 0n) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_identity_changed",
      "Runtime attestation database descriptor no longer names a regular file",
    );
  }
  if (expectedStat
    && (before.dev !== expectedStat.dev
      || before.ino !== expectedStat.ino
      || before.uid !== expectedStat.uid
      || before.gid !== expectedStat.gid
      || before.mode !== expectedStat.mode
      || before.nlink !== expectedStat.nlink
      || before.size !== expectedStat.size)) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_identity_changed",
      "Runtime attestation database descriptor identity changed before hashing",
    );
  }

  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let position = 0n;
  while (position < before.size) {
    const remaining = before.size - position;
    const requested = remaining > BigInt(chunk.length)
      ? chunk.length
      : Number(remaining);
    let bytesRead: number;
    try {
      bytesRead = readSync(descriptor, chunk, 0, requested, position);
    } catch {
      return fenceError(
        "lite_runtime_attestation_writer_fence_identity_changed",
        "Runtime attestation database descriptor failed during hashing",
      );
    }
    if (bytesRead <= 0) {
      return fenceError(
        "lite_runtime_attestation_writer_fence_identity_changed",
        "Runtime attestation database descriptor ended before its frozen byte length",
      );
    }
    digest.update(chunk.subarray(0, bytesRead));
    position += BigInt(bytesRead);
  }

  let after: BigIntStats;
  try {
    after = fstatSync(descriptor, { bigint: true });
  } catch {
    return fenceError(
      "lite_runtime_attestation_writer_fence_identity_changed",
      "Runtime attestation database descriptor changed after hashing",
    );
  }
  if (before.dev !== after.dev
    || before.ino !== after.ino
    || before.uid !== after.uid
    || before.gid !== after.gid
    || before.mode !== after.mode
    || before.nlink !== after.nlink
    || before.size !== after.size) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_identity_changed",
      "Runtime attestation database descriptor changed while hashing",
    );
  }
  return Object.freeze({ stat: after, sha256: digest.digest("hex") });
}

function pragmaScalar(
  database: LiteRuntimeDatabase,
  sql: string,
  key: string,
): unknown {
  const row = database.db.prepare(sql).get();
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  return (row as Readonly<Record<string, unknown>>)[key];
}

function acquireImmediateWriterFence(database: LiteRuntimeDatabase): void {
  try {
    database.db.exec("BEGIN IMMEDIATE");
  } catch {
    return fenceError(
      "lite_runtime_attestation_writer_fence_acquire_failed",
      "Runtime attestation writer fence could not exclude existing SQLite writers",
    );
  }
}

type CheckpointRow = Readonly<{
  busy?: unknown;
  log?: unknown;
  checkpointed?: unknown;
}>;

function checkpointAndRequireEmptyWal(
  database: LiteRuntimeDatabase,
  databaseRealpath: string,
): void {
  const journalMode = pragmaScalar(database, "PRAGMA journal_mode", "journal_mode");
  if (journalMode !== "wal") {
    return fenceError(
      "lite_runtime_attestation_writer_fence_wal_required",
      "Runtime attestation writer fence requires the Runtime database to remain in WAL mode",
    );
  }
  let row: CheckpointRow | undefined;
  try {
    row = database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      CheckpointRow | undefined;
  } catch {
    return fenceError(
      "lite_runtime_attestation_writer_fence_checkpoint_incomplete",
      "Runtime attestation WAL checkpoint failed",
    );
  }
  if (!row || row.busy !== 0 || row.log !== 0 || row.checkpointed !== 0) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_checkpoint_incomplete",
      "Runtime attestation WAL checkpoint did not return the canonical empty result",
    );
  }
  const walPath = `${databaseRealpath}-wal`;
  try {
    const walStat = lstatSync(walPath, { bigint: true });
    if (!walStat.isFile() || walStat.size !== 0n) {
      return fenceError(
        "lite_runtime_attestation_writer_fence_checkpoint_incomplete",
        "Runtime attestation WAL remains non-empty after checkpoint truncation",
      );
    }
  } catch (error) {
    const code = error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    if (code !== "ENOENT") {
      if (error instanceof LiteRuntimeAttestationWriterFenceError) throw error;
      return fenceError(
        "lite_runtime_attestation_writer_fence_checkpoint_incomplete",
        "Runtime attestation WAL could not be inspected after checkpoint truncation",
      );
    }
  }
}

function requireWalStillEmpty(databaseRealpath: string): void {
  const walPath = `${databaseRealpath}-wal`;
  try {
    const walStat = lstatSync(walPath, { bigint: true });
    if (!walStat.isFile() || walStat.size !== 0n) {
      return fenceError(
        "lite_runtime_attestation_writer_fence_identity_changed",
        "Runtime attestation WAL changed after the writer fence was acquired",
      );
    }
  } catch (error) {
    const code = error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    if (code !== "ENOENT") {
      if (error instanceof LiteRuntimeAttestationWriterFenceError) throw error;
      return fenceError(
        "lite_runtime_attestation_writer_fence_identity_changed",
        "Runtime attestation WAL could not be revalidated",
      );
    }
  }
}

function assertFenceState(state: FenceState): LiteRuntimeAttestationWriterFenceInspection {
  assertLiteRuntimeProtectedAuthorityDatabasePinned(state.pin);
  requireWalStillEmpty(state.inspection.database_realpath);
  try {
    state.database.db.prepare("SELECT 1 AS writer_fence_liveness").get();
  } catch {
    return fenceError(
      "lite_runtime_attestation_writer_fence_identity_changed",
      "Runtime attestation writer-fence connection is no longer live",
    );
  }
  const hashed = sha256Descriptor(state.descriptor);
  if (!sameFrozenIdentity(state, hashed.stat)
    || hashed.sha256 !== state.inspection.database_main_file_sha256) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_identity_changed",
      "Runtime attestation checkpointed database identity or bytes changed",
    );
  }
  return state.inspection;
}

/**
 * Acquires the SQLite portion of the launcher-held D3 writer fence. The caller
 * must already own the deployment slot and have quiesced its managed Runtime
 * writers. This function rejects busy or partial checkpoints, immediately
 * acquires BEGIN IMMEDIATE before exposing the checkpointed main, opens the
 * exact pinned main as O_RDONLY, and keeps that transaction alive until
 * release. The outer deployment-slot lease closes the checkpoint-to-BEGIN
 * race against managed Runtime restarts.
 */
export function acquireLiteRuntimeAttestationWriterFence(
  pin: LiteRuntimeProtectedAuthorityDatabasePin,
): LiteRuntimeAttestationWriterFenceCapability {
  const pinned = assertLiteRuntimeProtectedAuthorityDatabasePinned(pin);
  let database: LiteRuntimeDatabase | null = null;
  let descriptor: number | null = null;
  try {
    database = openLiteRuntimeProtectedAuthorityDatabase(pin);
    checkpointAndRequireEmptyWal(database, pinned.database_realpath);
    acquireImmediateWriterFence(database);
    requireWalStillEmpty(pinned.database_realpath);
    const afterCheckpoint = assertLiteRuntimeProtectedAuthorityDatabasePinned(pin);
    if (afterCheckpoint.database_realpath !== pinned.database_realpath
      || afterCheckpoint.database_device !== pinned.database_device
      || afterCheckpoint.database_inode !== pinned.database_inode) {
      return fenceError(
        "lite_runtime_attestation_writer_fence_identity_changed",
        "Runtime attestation database identity changed during checkpoint",
      );
    }
    if (typeof fsConstants.O_NOFOLLOW !== "number"
      || typeof fsConstants.O_NONBLOCK !== "number") {
      return fenceError(
        "lite_runtime_attestation_writer_fence_platform_unsupported",
        "Runtime attestation writer fence requires O_NOFOLLOW and O_NONBLOCK",
      );
    }
    const optionalConstants = fsConstants as typeof fsConstants & {
      readonly O_CLOEXEC?: number;
    };
    descriptor = openSync(
      afterCheckpoint.database_realpath,
      fsConstants.O_RDONLY
        | fsConstants.O_NOFOLLOW
        | fsConstants.O_NONBLOCK
        | (optionalConstants.O_CLOEXEC ?? 0),
    );
    const hashed = sha256Descriptor(descriptor);
    let pathStat: BigIntStats;
    try {
      pathStat = lstatSync(afterCheckpoint.database_realpath, { bigint: true });
    } catch {
      return fenceError(
        "lite_runtime_attestation_writer_fence_identity_changed",
        "Runtime attestation database path changed after descriptor hashing",
      );
    }
    assertLiteRuntimeProtectedAuthorityDatabasePinned(pin);
    if (!pathStat.isFile()
      || hashed.stat.dev !== pathStat.dev
      || hashed.stat.ino !== pathStat.ino
      || hashed.stat.uid !== pathStat.uid
      || hashed.stat.gid !== pathStat.gid
      || hashed.stat.mode !== pathStat.mode
      || hashed.stat.nlink !== pathStat.nlink
      || hashed.stat.size !== pathStat.size
      || hashed.stat.nlink !== 1n) {
      return fenceError(
        "lite_runtime_attestation_writer_fence_identity_changed",
        "Runtime attestation read-only descriptor does not match the pinned database",
      );
    }

    const inspection = Object.freeze({
      contract_version:
        "aionis_lite_runtime_attestation_writer_fence_inspection_v1" as const,
      signing_eligible: false as const,
      database_realpath: afterCheckpoint.database_realpath,
      database_file_device: hashed.stat.dev.toString(10),
      database_file_inode: hashed.stat.ino.toString(10),
      database_main_file_byte_length: hashed.stat.size.toString(10),
      database_main_file_sha256: hashed.sha256,
      wal_checkpoint_busy: 0 as const,
      wal_checkpoint_log_frames: 0 as const,
      wal_checkpointed_frames: 0 as const,
      wal_file_byte_length: 0 as const,
      wal_checkpointed_and_truncated: true as const,
      required_outer_capabilities: OUTER_CAPABILITIES,
    });
    const capability = Object.freeze(Object.create(null)) as
      LiteRuntimeAttestationWriterFenceCapability;
    const state: FenceState = {
      pin,
      database,
      descriptor,
      device: hashed.stat.dev,
      inode: hashed.stat.ino,
      uid: hashed.stat.uid,
      gid: hashed.stat.gid,
      mode: hashed.stat.mode,
      linkCount: hashed.stat.nlink,
      size: hashed.stat.size,
      inspection,
      handoffDescriptorOpened: false,
      closed: false,
    };
    fenceRegistry.set(capability, state);
    assertFenceState(state);
    return capability;
  } catch (error) {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
    if (database !== null) closeDatabaseBestEffort(database);
    throw error;
  }
}

/** Returns immutable evidence captured at acquisition without re-reading bytes. */
export function inspectLiteRuntimeAttestationWriterFence(
  capability: LiteRuntimeAttestationWriterFenceCapability,
): LiteRuntimeAttestationWriterFenceInspection {
  return requiredFenceState(capability).inspection;
}

/** Rechecks the pin, retained SQLite fence, zero WAL, full identity, and hash. */
export function assertLiteRuntimeAttestationWriterFence(
  capability: LiteRuntimeAttestationWriterFenceCapability,
): LiteRuntimeAttestationWriterFenceInspection {
  return assertFenceState(requiredFenceState(capability));
}

/** Canonical digest consumed later by the launcher DB-binding receipt. */
export function liteRuntimeAttestationWriterFenceInspectionDigest(
  capability: LiteRuntimeAttestationWriterFenceCapability,
): string {
  return createHash("sha256")
    .update(stableStringify(assertLiteRuntimeAttestationWriterFence(capability)))
    .digest("hex");
}

/**
 * Opens one caller-owned O_RDONLY handoff descriptor for explicit child-process
 * stdio inheritance. It must be mapped to D3's fixed attestor FD slot; the
 * numeric parent descriptor is never serialized or placed in argv. The caller
 * must close this descriptor immediately after spawn has duplicated it. The
 * writer-fence capability retains a separate private descriptor for its own
 * integrity checks, so release never risks closing a reused handoff fd number.
 */
export function openLiteRuntimeAttestationDatabaseHandoffDescriptor(
  capability: LiteRuntimeAttestationWriterFenceCapability,
): number {
  const state = requiredFenceState(capability);
  if (state.handoffDescriptorOpened) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_handoff_already_opened",
      "Runtime attestation database handoff descriptor is one-shot",
    );
  }
  state.handoffDescriptorOpened = true;
  assertFenceState(state);
  const optionalConstants = fsConstants as typeof fsConstants & {
    readonly O_CLOEXEC?: number;
  };
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      state.inspection.database_realpath,
      fsConstants.O_RDONLY
        | fsConstants.O_NOFOLLOW
        | fsConstants.O_NONBLOCK
        | (optionalConstants.O_CLOEXEC ?? 0),
    );
    const hashed = sha256Descriptor(descriptor);
    if (!sameFrozenIdentity(state, hashed.stat)
      || hashed.sha256 !== state.inspection.database_main_file_sha256) {
      return fenceError(
        "lite_runtime_attestation_writer_fence_identity_changed",
        "Runtime attestation handoff descriptor does not match the frozen database",
      );
    }
    assertFenceState(state);
    return descriptor;
  } catch (error) {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
    throw error;
  }
}

/** Revokes the capability before closing either OS resource. */
export async function releaseLiteRuntimeAttestationWriterFence(
  capability: LiteRuntimeAttestationWriterFenceCapability,
): Promise<void> {
  if ((typeof capability !== "object" && typeof capability !== "function")
    || capability === null) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_capability_invalid",
      "Runtime attestation writer-fence capability is invalid",
    );
  }
  const state = fenceRegistry.get(capability);
  if (!state) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_capability_invalid",
      "Runtime attestation writer-fence capability is invalid",
    );
  }
  if (state.closed) return;
  state.closed = true;
  let releaseError: unknown = null;
  try {
    closeSync(state.descriptor);
  } catch (error) {
    releaseError = error;
  }
  try {
    state.database.db.exec("ROLLBACK");
  } catch (error) {
    releaseError ??= error;
    // Revocation already happened; closing the connection releases any lock.
  }
  try {
    await state.database.close();
  } catch (error) {
    releaseError ??= error;
  }
  if (releaseError) {
    return fenceError(
      "lite_runtime_attestation_writer_fence_release_failed",
      "Runtime attestation writer fence could not close all owned resources",
    );
  }
}
