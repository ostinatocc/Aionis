// Durable receipt publication belongs to the external authority package.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  assertLiteRuntimeProtectedFilesystemNoDelegatedAccessControlList,
  assertLiteRuntimeProtectedFilesystemTrustedDirectoryChain,
} from "../store/lite-runtime-protected-authority-database.js";

export type LearningExternalEvidenceReceiptPublishStatus =
  | "published"
  | "exact_replay";

export type LearningExternalEvidenceReceiptWriterPhase =
  | "temp_opened"
  | "temp_hardened"
  | "temp_written"
  | "temp_fsynced"
  | "before_publish"
  | "after_publish"
  | "publish_directory_fsynced"
  | "temp_unlinked"
  | "cleanup_directory_fsynced";

export interface LearningExternalEvidenceReceiptPublishResult {
  status: LearningExternalEvidenceReceiptPublishStatus;
  destination: string;
  byte_length: number;
  receipt_sha256: string;
}

/** @internal Test-only fault boundary. Production callers must omit this. */
export interface LearningExternalEvidenceReceiptWriterTestHooks {
  phaseHook?: (phase: LearningExternalEvidenceReceiptWriterPhase) => void;
}

export type LearningExternalEvidenceReceiptWriterErrorCode =
  | "learning_external_evidence_receipt_destination_invalid"
  | "learning_external_evidence_receipt_json_noncanonical"
  | "learning_external_evidence_receipt_parent_untrusted"
  | "learning_external_evidence_receipt_destination_unsafe"
  | "learning_external_evidence_receipt_conflict";

export class LearningExternalEvidenceReceiptWriterError extends Error {
  readonly code: LearningExternalEvidenceReceiptWriterErrorCode;

  constructor(code: LearningExternalEvidenceReceiptWriterErrorCode, message: string) {
    super(message);
    this.name = "LearningExternalEvidenceReceiptWriterError";
    this.code = code;
  }
}

interface PinnedDirectory {
  path: string;
  descriptor: number;
  device: bigint;
  inode: bigint;
  uid: bigint;
}

interface SafeReceiptFile {
  dev: bigint;
  ino: bigint;
  bytes: Buffer;
}

const RECEIPT_MODE = 0o600n;
const DIRECTORY_UNTRUSTED_WRITE_MASK = 0o022n;
const TEMP_MARKER = ".aionis-learning-evidence-receipt-";
const TEMP_NAME_PATTERN = /^\.aionis-learning-evidence-receipt-[1-9][0-9]*-[0-9a-f]{36}\.tmp$/u;

function writerError(
  code: LearningExternalEvidenceReceiptWriterErrorCode,
  message: string,
): never {
  throw new LearningExternalEvidenceReceiptWriterError(code, message);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function currentUid(): bigint {
  if (typeof process.getuid !== "function") {
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      "durable receipt publication requires a POSIX service uid",
    );
  }
  return BigInt(process.getuid());
}

function requiredFlag(name: "O_NOFOLLOW" | "O_DIRECTORY" | "O_NONBLOCK"): number {
  const value = fsConstants[name];
  if (typeof value !== "number") {
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      `durable receipt publication requires ${name}`,
    );
  }
  return value;
}

function assertTrustedReceiptDirectoryChain(
  destination: string,
  uid: bigint,
): void {
  try {
    assertLiteRuntimeProtectedFilesystemTrustedDirectoryChain(destination, uid);
  } catch {
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      "receipt destination requires a service-owned direct parent and a non-writable owner/root ancestor chain without delegated ACL authority",
    );
  }
}

function assertReceiptFileAccessControlList(
  path: string,
  object: "receipt" | "receipt_temp",
): void {
  try {
    assertLiteRuntimeProtectedFilesystemNoDelegatedAccessControlList(path, object);
  } catch {
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      `${object === "receipt" ? "receipt destination" : "receipt temporary file"} has delegated or unverifiable ACL authority`,
    );
  }
}

function canonicalReceiptBytes(receiptJson: string): Buffer {
  if (typeof receiptJson !== "string" || receiptJson.length === 0) {
    writerError(
      "learning_external_evidence_receipt_json_noncanonical",
      "receiptJson must be non-empty canonical JSON text",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptJson) as unknown;
  } catch {
    writerError(
      "learning_external_evidence_receipt_json_noncanonical",
      "receiptJson must be valid canonical JSON text",
    );
  }
  if (stableStringify(parsed) !== receiptJson) {
    writerError(
      "learning_external_evidence_receipt_json_noncanonical",
      "receiptJson must use the canonical JSON encoding",
    );
  }
  const bytes = Buffer.from(receiptJson, "utf8");
  if (bytes.toString("utf8") !== receiptJson) {
    writerError(
      "learning_external_evidence_receipt_json_noncanonical",
      "receiptJson must be lossless UTF-8 text",
    );
  }
  return bytes;
}

function canonicalAbsoluteDestination(destination: string): string {
  if (typeof destination !== "string"
    || destination.length === 0
    || destination.includes("\0")
    || !isAbsolute(destination)
    || resolve(destination) !== destination
    || basename(destination).length === 0) {
    writerError(
      "learning_external_evidence_receipt_destination_invalid",
      "receipt destination must be a canonical absolute file path",
    );
  }
  return destination;
}

function pinTrustedParent(destination: string): PinnedDirectory {
  const path = dirname(destination);
  const uid = currentUid();
  let lexical;
  try {
    lexical = lstatSync(path, { bigint: true });
  } catch {
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      "receipt destination parent must already exist",
    );
  }
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      "receipt destination parent must be a real directory",
    );
  }
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(path);
  } catch {
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      "receipt destination parent cannot be resolved safely",
    );
  }
  if (canonicalPath !== path
    || lexical.uid !== uid
    || (lexical.mode & DIRECTORY_UNTRUSTED_WRITE_MASK) !== 0n) {
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      "receipt destination parent must be canonical, service-owned, and not group/other writable",
    );
  }
  assertTrustedReceiptDirectoryChain(destination, uid);

  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | requiredFlag("O_DIRECTORY") | requiredFlag("O_NOFOLLOW"),
  );
  const pinned = fstatSync(descriptor, { bigint: true });
  if (!pinned.isDirectory()
    || pinned.dev !== lexical.dev
    || pinned.ino !== lexical.ino
    || pinned.uid !== uid
    || (pinned.mode & DIRECTORY_UNTRUSTED_WRITE_MASK) !== 0n) {
    closeSync(descriptor);
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      "receipt destination parent changed while it was being pinned",
    );
  }
  return {
    path,
    descriptor,
    device: pinned.dev,
    inode: pinned.ino,
    uid,
  };
}

function assertPinnedParent(parent: PinnedDirectory): void {
  let lexical;
  let canonicalPath: string;
  try {
    lexical = lstatSync(parent.path, { bigint: true });
    canonicalPath = realpathSync.native(parent.path);
  } catch {
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      "receipt destination parent disappeared during publication",
    );
  }
  const pinned = fstatSync(parent.descriptor, { bigint: true });
  if (canonicalPath !== parent.path
    || !lexical.isDirectory()
    || lexical.isSymbolicLink()
    || lexical.dev !== parent.device
    || lexical.ino !== parent.inode
    || lexical.uid !== parent.uid
    || (lexical.mode & DIRECTORY_UNTRUSTED_WRITE_MASK) !== 0n
    || !pinned.isDirectory()
    || pinned.dev !== parent.device
    || pinned.ino !== parent.inode
    || pinned.uid !== parent.uid
    || (pinned.mode & DIRECTORY_UNTRUSTED_WRITE_MASK) !== 0n) {
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      "receipt destination parent identity or trust changed during publication",
    );
  }
  assertTrustedReceiptDirectoryChain(join(parent.path, ".receipt-chain-probe"), parent.uid);
}

function assertSafeReceiptStat(
  stat: BigIntStats,
  uid: bigint,
  expectedLinks = 1n,
): void {
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== uid
    || (stat.mode & 0o7777n) !== RECEIPT_MODE
    || stat.nlink !== expectedLinks) {
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      `receipt file must be a service-owned 0600 regular file with exactly ${String(expectedLinks)} link(s)`,
    );
  }
}

function readSafeReceipt(
  destination: string,
  uid: bigint,
  expectedByteLength: number,
  expectedLinks = 1n,
  object: "receipt" | "receipt_temp" = "receipt",
): SafeReceiptFile {
  let lexical;
  try {
    lexical = lstatSync(destination, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw error;
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      "receipt destination could not be inspected safely",
    );
  }
  assertSafeReceiptStat(lexical, uid, expectedLinks);
  assertReceiptFileAccessControlList(destination, object);

  let descriptor: number;
  try {
    descriptor = openSync(
      destination,
      fsConstants.O_RDONLY
        | requiredFlag("O_NOFOLLOW")
        | requiredFlag("O_NONBLOCK"),
    );
  } catch {
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      "receipt destination could not be opened without following links",
    );
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assertSafeReceiptStat(before, uid, expectedLinks);
    if (before.dev !== lexical.dev || before.ino !== lexical.ino) {
      writerError(
        "learning_external_evidence_receipt_destination_unsafe",
        "receipt destination identity is unsafe",
      );
    }
    if (before.size !== BigInt(expectedByteLength)) {
      writerError(
        "learning_external_evidence_receipt_conflict",
        "receipt destination byte length differs from the requested canonical receipt",
      );
    }

    const bytes = Buffer.alloc(expectedByteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) {
        writerError(
          "learning_external_evidence_receipt_destination_unsafe",
          "receipt destination changed while it was being read",
        );
      }
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, bytes.length) !== 0) {
      writerError(
        "learning_external_evidence_receipt_destination_unsafe",
        "receipt destination grew while it was being read",
      );
    }
    const after = fstatSync(descriptor, { bigint: true });
    assertSafeReceiptStat(after, uid, expectedLinks);
    assertReceiptFileAccessControlList(destination, object);
    const finalLexical = lstatSync(destination, { bigint: true });
    assertSafeReceiptStat(finalLexical, uid, expectedLinks);
    if (after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mode !== before.mode
      || after.uid !== before.uid
      || after.nlink !== before.nlink
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || finalLexical.dev !== after.dev
      || finalLexical.ino !== after.ino
      || finalLexical.uid !== after.uid
      || finalLexical.mode !== after.mode
      || finalLexical.nlink !== after.nlink
      || finalLexical.size !== after.size
      || finalLexical.mtimeNs !== after.mtimeNs
      || finalLexical.ctimeNs !== after.ctimeNs) {
      writerError(
        "learning_external_evidence_receipt_destination_unsafe",
        "receipt destination changed while it was being verified",
      );
    }
    return { dev: after.dev, ino: after.ino, bytes };
  } finally {
    closeSync(descriptor);
  }
}

function existingReceiptStatus(
  destination: string,
  expected: Buffer,
  uid: bigint,
): "absent" | "exact_replay" {
  let existing: SafeReceiptFile;
  try {
    existing = readSafeReceipt(destination, uid, expected.length);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "absent";
    throw error;
  }
  if (!existing.bytes.equals(expected)) {
    writerError(
      "learning_external_evidence_receipt_conflict",
      "receipt destination already contains different canonical bytes",
    );
  }
  return "exact_replay";
}

function optionalBigIntLstat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      "receipt publication could not inspect a filesystem entry safely",
    );
  }
}

function assertSameReceiptIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">,
  message: string,
): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      message,
    );
  }
}

/**
 * A hard-link publish can be killed after destination creation but before the
 * temporary name is removed. Recover only the exact state this writer creates:
 * destination plus one uniquely named temp entry, both naming the same
 * service-owned 0600 inode with nlink=2 and byte-identical canonical content.
 */
function recoverInterruptedHardLinkPublication(
  destination: string,
  expected: Buffer,
  parent: PinnedDirectory,
): void {
  assertPinnedParent(parent);
  const destinationStat = optionalBigIntLstat(destination);
  if (destinationStat === null || destinationStat.nlink !== 2n) return;

  const destinationFile = readSafeReceipt(
    destination,
    parent.uid,
    expected.length,
    2n,
    "receipt",
  );
  if (!destinationFile.bytes.equals(expected)) {
    writerError(
      "learning_external_evidence_receipt_conflict",
      "interrupted receipt destination contains different canonical bytes",
    );
  }

  let names: string[];
  try {
    names = readdirSync(parent.path);
  } catch {
    writerError(
      "learning_external_evidence_receipt_parent_untrusted",
      "receipt destination parent could not be scanned for interrupted publication recovery",
    );
  }
  const matchingTemps: string[] = [];
  for (const name of names) {
    if (!TEMP_NAME_PATTERN.test(name)) continue;
    const candidate = join(parent.path, name);
    const candidateStat = optionalBigIntLstat(candidate);
    if (candidateStat !== null
      && candidateStat.dev === destinationFile.dev
      && candidateStat.ino === destinationFile.ino) {
      matchingTemps.push(candidate);
    }
  }
  if (matchingTemps.length !== 1) {
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      "two-link receipt destination lacks one unique matching interrupted-publication temp entry",
    );
  }

  const tempPath = matchingTemps[0]!;
  const tempFile = readSafeReceipt(
    tempPath,
    parent.uid,
    expected.length,
    2n,
    "receipt_temp",
  );
  assertSameReceiptIdentity(
    destinationFile,
    tempFile,
    "interrupted receipt temp no longer names the destination inode",
  );
  if (!tempFile.bytes.equals(expected)) {
    writerError(
      "learning_external_evidence_receipt_conflict",
      "interrupted receipt temp contains different canonical bytes",
    );
  }

  assertPinnedParent(parent);
  const destinationBeforeUnlink = readSafeReceipt(
    destination,
    parent.uid,
    expected.length,
    2n,
    "receipt",
  );
  const tempBeforeUnlink = readSafeReceipt(
    tempPath,
    parent.uid,
    expected.length,
    2n,
    "receipt_temp",
  );
  assertSameReceiptIdentity(
    destinationBeforeUnlink,
    tempBeforeUnlink,
    "interrupted receipt names changed before recovery",
  );
  try {
    unlinkSync(tempPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  fsyncSync(parent.descriptor);
  assertPinnedParent(parent);
  const recovered = readSafeReceipt(destination, parent.uid, expected.length);
  if (!recovered.bytes.equals(expected)) {
    writerError(
      "learning_external_evidence_receipt_conflict",
      "recovered receipt bytes differ from the requested canonical receipt",
    );
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (count === 0) throw new Error("receipt temp write made no progress");
    offset += count;
  }
}

function assertTempFile(descriptor: number, uid: bigint, expectedSize: number, expectedLinks: bigint): void {
  const stat = fstatSync(descriptor, { bigint: true });
  if (!stat.isFile()
    || stat.uid !== uid
    || (stat.mode & 0o7777n) !== RECEIPT_MODE
    || stat.size !== BigInt(expectedSize)
    || stat.nlink !== expectedLinks) {
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      "receipt temporary file failed its ownership, mode, size, or link-count check",
    );
  }
}

function assertTempPath(
  descriptor: number,
  tempPath: string,
  uid: bigint,
  expectedSize: number,
  expectedLinks: bigint,
): void {
  assertTempFile(descriptor, uid, expectedSize, expectedLinks);
  const descriptorBefore = fstatSync(descriptor, { bigint: true });
  const pathBefore = optionalBigIntLstat(tempPath);
  if (pathBefore === null) {
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      "receipt temporary path disappeared during verification",
    );
  }
  assertSafeReceiptStat(pathBefore, uid, expectedLinks);
  if (pathBefore.size !== BigInt(expectedSize)) {
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      "receipt temporary path has an unexpected byte length",
    );
  }
  assertSameReceiptIdentity(
    descriptorBefore,
    pathBefore,
    "receipt temporary path does not name its pinned descriptor",
  );
  assertReceiptFileAccessControlList(tempPath, "receipt_temp");
  const descriptorAfter = fstatSync(descriptor, { bigint: true });
  const pathAfter = optionalBigIntLstat(tempPath);
  if (pathAfter === null) {
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      "receipt temporary path disappeared during ACL verification",
    );
  }
  assertSafeReceiptStat(descriptorAfter, uid, expectedLinks);
  assertSafeReceiptStat(pathAfter, uid, expectedLinks);
  if (descriptorAfter.size !== BigInt(expectedSize)
    || pathAfter.size !== BigInt(expectedSize)
    || descriptorAfter.dev !== descriptorBefore.dev
    || descriptorAfter.ino !== descriptorBefore.ino
    || descriptorAfter.uid !== descriptorBefore.uid
    || descriptorAfter.mode !== descriptorBefore.mode
    || descriptorAfter.nlink !== descriptorBefore.nlink
    || pathAfter.dev !== descriptorAfter.dev
    || pathAfter.ino !== descriptorAfter.ino
    || pathAfter.uid !== descriptorAfter.uid
    || pathAfter.mode !== descriptorAfter.mode
    || pathAfter.nlink !== descriptorAfter.nlink
    || pathAfter.size !== descriptorAfter.size) {
    writerError(
      "learning_external_evidence_receipt_destination_unsafe",
      "receipt temporary file changed during path and ACL verification",
    );
  }
}

function callPhase(
  hooks: LearningExternalEvidenceReceiptWriterTestHooks | undefined,
  phase: LearningExternalEvidenceReceiptWriterPhase,
): void {
  hooks?.phaseHook?.(phase);
}

function unlinkTempAndSync(parent: PinnedDirectory, tempPath: string): void {
  assertPinnedParent(parent);
  try {
    unlinkSync(tempPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  fsyncSync(parent.descriptor);
}

/**
 * Durably publishes canonical evidence-receipt bytes without ever replacing an
 * existing destination. This module is intentionally not part of the public SDK.
 */
export function publishLearningExternalEvidenceReceipt(
  args: { destination: string; receiptJson: string },
  /** @internal */ testHooks?: LearningExternalEvidenceReceiptWriterTestHooks,
): LearningExternalEvidenceReceiptPublishResult {
  const destination = canonicalAbsoluteDestination(args.destination);
  const bytes = canonicalReceiptBytes(args.receiptJson);
  const parent = pinTrustedParent(destination);
  const resultBase = {
    destination,
    byte_length: bytes.length,
    receipt_sha256: createHash("sha256").update(bytes).digest("hex"),
  };

  let tempPath: string | null = null;
  let tempDescriptor: number | null = null;
  let tempLinked = false;
  let publicationStatus: LearningExternalEvidenceReceiptPublishStatus | null = null;
  let primaryFailure: unknown;
  try {
    assertPinnedParent(parent);
    recoverInterruptedHardLinkPublication(destination, bytes, parent);
    if (existingReceiptStatus(destination, bytes, parent.uid) === "exact_replay") {
      publicationStatus = "exact_replay";
    } else {
      tempPath = join(
        parent.path,
        `${TEMP_MARKER}${process.pid}-${randomBytes(18).toString("hex")}.tmp`,
      );
      tempDescriptor = openSync(
        tempPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | requiredFlag("O_NOFOLLOW"),
        0o600,
      );
      callPhase(testHooks, "temp_opened");
      fchmodSync(tempDescriptor, 0o600);
      assertTempPath(tempDescriptor, tempPath, parent.uid, 0, 1n);
      callPhase(testHooks, "temp_hardened");
      writeAll(tempDescriptor, bytes);
      callPhase(testHooks, "temp_written");
      fsyncSync(tempDescriptor);
      assertTempPath(tempDescriptor, tempPath, parent.uid, bytes.length, 1n);
      callPhase(testHooks, "temp_fsynced");

      assertPinnedParent(parent);
      callPhase(testHooks, "before_publish");
      try {
        linkSync(tempPath, destination);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        recoverInterruptedHardLinkPublication(destination, bytes, parent);
        if (existingReceiptStatus(destination, bytes, parent.uid) !== "exact_replay") {
          throw error;
        }
        publicationStatus = "exact_replay";
      }
      if (publicationStatus === null) {
        tempLinked = true;
        publicationStatus = "published";
        assertTempPath(tempDescriptor, tempPath, parent.uid, bytes.length, 2n);
        const linkedDestination = readSafeReceipt(
          destination,
          parent.uid,
          bytes.length,
          2n,
          "receipt",
        );
        const linkedTemp = fstatSync(tempDescriptor, { bigint: true });
        assertSameReceiptIdentity(
          linkedDestination,
          linkedTemp,
          "published receipt destination does not name the temporary-file inode",
        );
        if (!linkedDestination.bytes.equals(bytes)) {
          writerError(
            "learning_external_evidence_receipt_conflict",
            "published receipt destination contains unexpected bytes",
          );
        }
        callPhase(testHooks, "after_publish");
      }

      if (tempLinked) {
        fsyncSync(parent.descriptor);
        callPhase(testHooks, "publish_directory_fsynced");
      }
      assertPinnedParent(parent);
      try {
        unlinkSync(tempPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      tempPath = null;
      if (tempLinked) assertTempFile(tempDescriptor, parent.uid, bytes.length, 1n);
      callPhase(testHooks, "temp_unlinked");
      fsyncSync(parent.descriptor);
      callPhase(testHooks, "cleanup_directory_fsynced");
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (tempDescriptor !== null) closeSync(tempDescriptor);
    if (tempPath !== null) {
      try {
        unlinkTempAndSync(parent, tempPath);
      } catch (cleanupError) {
        primaryFailure = primaryFailure === undefined
          ? cleanupError
          : new AggregateError(
            [primaryFailure, cleanupError],
            "receipt publication and temporary-file cleanup both failed",
          );
      }
    }
  }

  try {
    if (primaryFailure !== undefined) throw primaryFailure;
    assertPinnedParent(parent);
    const final = readSafeReceipt(destination, parent.uid, bytes.length);
    if (!final.bytes.equals(bytes)) {
      writerError(
        "learning_external_evidence_receipt_conflict",
        "published receipt bytes do not match the requested canonical receipt",
      );
    }
    if (publicationStatus === null) {
      throw new Error("receipt publication completed without a status");
    }
    return { status: publicationStatus, ...resultBase };
  } finally {
    closeSync(parent.descriptor);
  }
}
