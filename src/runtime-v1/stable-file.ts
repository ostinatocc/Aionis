import { closeSync, constants, fstatSync, lstatSync, openSync, readSync,
  type BigIntStats } from "node:fs";

type Failure = (code: string, cause?: unknown) => never;
function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid
    && left.gid === right.gid && left.nlink === right.nlink
    && left.rdev === right.rdev && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Stable, bounded regular-file read; bytes are wiped after synchronous use. */
export function withContinuationRuntimeV1StableFileBytes<T>(path: string,
  bounds: readonly [number, number], owner: "runtime" | "runtime-or-root", modePolicy: "private" | "public",
  fail: Failure, consume: (bytes: Buffer) => T): T {
  if (!constants.O_NOFOLLOW) fail("no_follow_unavailable");
  let pathBefore: BigIntStats;
  try { pathBefore = lstatSync(path, { bigint: true }); }
  catch (error) { return fail("open_failed", error); }
  if (!pathBefore.isFile()) fail("file_posture_invalid");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW
      | constants.O_NONBLOCK); }
  catch (error) { return fail("open_failed", error); }
  let bytes: Buffer | undefined;
  let probe: Buffer | undefined;
  const read = (target: Buffer, offset: number, length: number,
    position: number): number => {
    try { return readSync(fd, target, offset, length, position); }
    catch (error) { return fail("read_failed", error); }
  };
  try {
    probe = Buffer.alloc(1);
    const before = fstatSync(fd, { bigint: true });
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    const mode = before.mode & 0o7777n;
    const ownerValid = uid !== null && (before.uid === uid
      || (owner === "runtime-or-root" && before.uid === 0n));
    const modeValid = modePolicy === "private" ? mode === 0o400n || mode === 0o600n
      : (mode & 0o22n) === 0n;
    if (!before.isFile() || before.nlink !== 1n || !ownerValid || !modeValid
      || before.size < BigInt(bounds[0]) || before.size > BigInt(bounds[1])
      || !same(pathBefore, before)) fail("file_posture_invalid");
    bytes = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = read(bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail("read_failed");
      offset += count;
    }
    if (read(probe, 0, 1, bytes.length) !== 0) fail("file_changed_during_read");
    const after = fstatSync(fd, { bigint: true });
    let pathAfter: BigIntStats;
    try { pathAfter = lstatSync(path, { bigint: true }); }
    catch (error) { return fail("file_changed_during_read", error); }
    if (!same(before, after) || !same(after, pathAfter)) {
      fail("file_changed_during_read");
    }
    return consume(bytes);
  } finally {
    bytes?.fill(0); probe?.fill(0); closeSync(fd);
  }
}
