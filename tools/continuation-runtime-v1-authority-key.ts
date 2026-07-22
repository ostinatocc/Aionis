import { createPrivateKey, type KeyObject } from "node:crypto";
import { fstatSync, readSync } from "node:fs";

export const CONTINUATION_RUNTIME_V1_AUTHORITY_ROOT_KEY_FD = 3;

const MAX_PRIVATE_KEY_BYTES = 16_384;
const PKCS8_BEGIN = Buffer.from("-----BEGIN PRIVATE KEY-----\n", "ascii");
const PKCS8_END = Buffer.from("\n-----END PRIVATE KEY-----", "ascii");
const ENCRYPTED_PRIVATE_KEY = Buffer.from("ENCRYPTED PRIVATE KEY", "ascii");
const PUBLIC_KEY = Buffer.from("PUBLIC KEY", "ascii");

export type AuthorityRootKeyFailureCode =
  | "root_key_descriptor_unreadable"
  | "root_key_descriptor_type_invalid"
  | "root_key_permissions_invalid"
  | "root_key_owner_invalid"
  | "root_key_link_count_invalid"
  | "root_key_size_invalid"
  | "root_key_read_failed"
  | "root_key_changed_during_read"
  | "root_key_pkcs8_pem_required"
  | "root_key_invalid"
  | "root_key_must_be_ed25519";

export class AuthorityRootKeyError extends Error {
  readonly code: AuthorityRootKeyFailureCode;

  constructor(code: AuthorityRootKeyFailureCode) {
    super(`continuation_runtime_v1_authority_authoring_${code}`);
    this.name = "AuthorityRootKeyError";
    this.code = code;
  }
}

export type AuthorityRootDescriptorSnapshot = Readonly<{
  kind: "regular" | "fifo" | "other";
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
  gid: bigint;
  rdev: bigint;
  size: bigint;
  mtime_ns: bigint;
  ctime_ns: bigint;
}>;

function fail(code: AuthorityRootKeyFailureCode): never {
  throw new AuthorityRootKeyError(code);
}

function descriptorSnapshot(
  descriptor: number,
): AuthorityRootDescriptorSnapshot {
  let status: ReturnType<typeof fstatSync>;
  try {
    status = fstatSync(descriptor, { bigint: true });
  } catch {
    fail("root_key_descriptor_unreadable");
  }
  return Object.freeze({
    kind: status.isFile() ? "regular" : status.isFIFO() ? "fifo" : "other",
    dev: status.dev,
    ino: status.ino,
    mode: status.mode,
    nlink: status.nlink,
    uid: status.uid,
    gid: status.gid,
    rdev: status.rdev,
    size: status.size,
    mtime_ns: status.mtimeNs,
    ctime_ns: status.ctimeNs,
  });
}

/**
 * Validates the pre-read descriptor posture. Regular files are accepted only
 * as a single-link, owner-private inode. FIFO descriptors remain available to
 * an inherited secret broker and are bounded during the read.
 */
export function assertAuthorityRootDescriptorPosture(
  snapshot: AuthorityRootDescriptorSnapshot,
  currentUid: number | null = typeof process.getuid === "function"
    ? process.getuid()
    : null,
): void {
  if (snapshot.kind !== "regular" && snapshot.kind !== "fifo") {
    fail("root_key_descriptor_type_invalid");
  }
  if (currentUid === null
    || (snapshot.uid !== 0n && snapshot.uid !== BigInt(currentUid))) {
    fail("root_key_owner_invalid");
  }
  if (snapshot.nlink !== 1n) fail("root_key_link_count_invalid");
  const permissions = Number(snapshot.mode & 0o777n);
  if (permissions !== 0o400 && permissions !== 0o600) {
    fail("root_key_permissions_invalid");
  }
  if (snapshot.kind === "fifo") return;
  if (snapshot.size < 1n || snapshot.size > BigInt(MAX_PRIVATE_KEY_BYTES)) {
    fail("root_key_size_invalid");
  }
}

/** Exported so the adversarial test can prove every identity field is fenced. */
export function assertAuthorityRootDescriptorStable(
  before: AuthorityRootDescriptorSnapshot,
  after: AuthorityRootDescriptorSnapshot,
): void {
  const commonStable = after.kind === before.kind
    && after.dev === before.dev
    && after.ino === before.ino
    && after.mode === before.mode
    && after.nlink === before.nlink
    && after.uid === before.uid
    && after.gid === before.gid
    && after.rdev === before.rdev;
  if (!commonStable) fail("root_key_changed_during_read");
  if (before.kind === "regular"
    && (after.size !== before.size
      || after.mtime_ns !== before.mtime_ns
      || after.ctime_ns !== before.ctime_ns)) {
    fail("root_key_changed_during_read");
  }
}

function readBoundedDescriptor(descriptor: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const capacity = Math.min(8_192, MAX_PRIVATE_KEY_BYTES + 1 - total);
      const chunk = Buffer.alloc(capacity);
      let count: number;
      try {
        count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      } catch {
        chunk.fill(0);
        fail("root_key_read_failed");
      }
      if (count === 0) {
        chunk.fill(0);
        break;
      }
      total += count;
      if (total > MAX_PRIVATE_KEY_BYTES) {
        chunk.fill(0);
        fail("root_key_size_invalid");
      }
      chunks.push(chunk.subarray(0, count));
    }
    if (total < 1) fail("root_key_size_invalid");
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function countOccurrences(bytes: Buffer, needle: Buffer): number {
  let count = 0;
  let offset = 0;
  while (offset <= bytes.byteLength - needle.byteLength) {
    const index = bytes.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.byteLength;
  }
  return count;
}

function hasPrefix(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.byteLength >= prefix.byteLength
    && bytes.subarray(0, prefix.byteLength).compare(prefix) === 0;
}

function hasSuffix(bytes: Buffer, suffix: Buffer): boolean {
  return bytes.byteLength >= suffix.byteLength
    && bytes.subarray(bytes.byteLength - suffix.byteLength).compare(suffix) === 0;
}

function parsePkcs8Ed25519PrivateKey(bytes: Buffer): KeyObject {
  // Validate the ASCII PEM envelope directly on the caller-owned buffer. Do
  // not create a JS string copy of root private-key material: unlike Buffer,
  // such a string cannot be explicitly zeroized.
  const invalidAscii = bytes.some((byte) => byte > 0x7f
    || byte === 0x00
    || byte === 0x0d
    || (byte < 0x20 && byte !== 0x0a));
  if (invalidAscii
    || !hasPrefix(bytes, PKCS8_BEGIN)
    || !(hasSuffix(bytes, PKCS8_END)
      || hasSuffix(bytes, Buffer.concat([PKCS8_END, Buffer.from("\n", "ascii")])))
    || countOccurrences(bytes, PKCS8_BEGIN) !== 1
    || countOccurrences(bytes, PKCS8_END) !== 1
    || bytes.includes(ENCRYPTED_PRIVATE_KEY)
    || bytes.includes(PUBLIC_KEY)) {
    fail("root_key_pkcs8_pem_required");
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: bytes, format: "pem" });
  } catch {
    fail("root_key_invalid");
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    fail("root_key_must_be_ed25519");
  }
  return key;
}

/**
 * Loads the offline authority root from inherited FD 3 only. There is no path,
 * argv, environment, daemon, worker, or provisioner private-key interface.
 */
export function readAuthorityRootPrivateKeyFromInheritedFd(
  descriptor = CONTINUATION_RUNTIME_V1_AUTHORITY_ROOT_KEY_FD,
): KeyObject {
  const before = descriptorSnapshot(descriptor);
  assertAuthorityRootDescriptorPosture(before);
  const bytes = readBoundedDescriptor(descriptor);
  try {
    const after = descriptorSnapshot(descriptor);
    assertAuthorityRootDescriptorStable(before, after);
    if (before.kind === "regular" && BigInt(bytes.byteLength) !== before.size) {
      fail("root_key_changed_during_read");
    }
    return parsePkcs8Ed25519PrivateKey(bytes);
  } finally {
    bytes.fill(0);
  }
}
