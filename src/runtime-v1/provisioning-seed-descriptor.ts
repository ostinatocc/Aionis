import { fstatSync } from "node:fs";

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_provisioning_entry_${code}`);
}

/**
 * Regular seed files are accepted only with an owner-private mode and a local
 * owner. A FIFO remains valid so an offline secret broker can pass the seed
 * without materializing it on disk; every other descriptor type is rejected.
 */
export type PrivateAssignmentSeedDescriptorSnapshot = Readonly<{
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

function snapshot(descriptor: number): PrivateAssignmentSeedDescriptorSnapshot {
  let status: ReturnType<typeof fstatSync>;
  try {
    status = fstatSync(descriptor, { bigint: true });
  } catch {
    fail("assignment_seed_descriptor_unreadable");
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

export function assertPrivateAssignmentSeedDescriptor(
  descriptor: number,
): PrivateAssignmentSeedDescriptorSnapshot {
  const status = snapshot(descriptor);
  if (status.kind !== "regular" && status.kind !== "fifo") {
    fail("assignment_seed_descriptor_type_invalid");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid === null
    || (status.uid !== 0n && status.uid !== BigInt(currentUid))) {
    fail("assignment_seed_owner_invalid");
  }
  if (status.nlink !== 1n) fail("assignment_seed_link_count_invalid");
  const permissions = Number(status.mode & 0o777n);
  if (permissions !== 0o400 && permissions !== 0o600) {
    fail("assignment_seed_permissions_invalid");
  }
  if (status.kind === "regular" && status.size !== 32n) {
    fail("assignment_seed_length_invalid");
  }
  return status;
}

export function assertPrivateAssignmentSeedDescriptorStable(
  descriptor: number,
  before: PrivateAssignmentSeedDescriptorSnapshot,
): void {
  const after = snapshot(descriptor);
  const stable = after.kind === before.kind
    && after.dev === before.dev
    && after.ino === before.ino
    && after.mode === before.mode
    && after.nlink === before.nlink
    && after.uid === before.uid
    && after.gid === before.gid
    && after.rdev === before.rdev
    && (before.kind !== "regular"
      || (after.size === before.size
        && after.mtime_ns === before.mtime_ns
        && after.ctime_ns === before.ctime_ns));
  if (!stable) fail("assignment_seed_changed_during_read");
}
