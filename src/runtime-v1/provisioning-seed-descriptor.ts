import { fstatSync, type BigIntStats } from "node:fs";

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_provisioning_entry_${code}`);
}
export type PrivateAssignmentSeedDescriptorSnapshot = Readonly<BigIntStats>;
function snapshot(descriptor: number): PrivateAssignmentSeedDescriptorSnapshot {
  try { return Object.freeze(fstatSync(descriptor, { bigint: true })); }
  catch { return fail("assignment_seed_descriptor_unreadable"); }
}

/** A private regular seed or FIFO from an offline broker; no other fd type. */
export function assertPrivateAssignmentSeedDescriptor(
  descriptor: number,
): PrivateAssignmentSeedDescriptorSnapshot {
  const status = snapshot(descriptor);
  if (!status.isFile() && !status.isFIFO()) {
    fail("assignment_seed_descriptor_type_invalid");
  }
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (uid === null || (status.uid !== 0n && status.uid !== uid)) {
    fail("assignment_seed_owner_invalid");
  }
  if (status.nlink !== 1n) fail("assignment_seed_link_count_invalid");
  const permissions = status.mode & 0o777n;
  if (permissions !== 0o400n && permissions !== 0o600n) {
    fail("assignment_seed_permissions_invalid");
  }
  if (status.isFile() && status.size !== 32n) fail("assignment_seed_length_invalid");
  return status;
}

export function assertPrivateAssignmentSeedDescriptorStable(
  descriptor: number,
  before: PrivateAssignmentSeedDescriptorSnapshot,
): void {
  const after = snapshot(descriptor);
  const stable = after.dev === before.dev && after.ino === before.ino
    && after.mode === before.mode && after.nlink === before.nlink
    && after.uid === before.uid && after.gid === before.gid
    && after.rdev === before.rdev && after.isFile() === before.isFile()
    && after.isFIFO() === before.isFIFO() && (!before.isFile()
      || (after.size === before.size && after.mtimeNs === before.mtimeNs
        && after.ctimeNs === before.ctimeNs));
  if (!stable) fail("assignment_seed_changed_during_read");
}
