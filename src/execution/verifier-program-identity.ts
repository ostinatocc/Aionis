import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import stableStringify from "fast-json-stable-stringify";

import { sha256Hex } from "../util/crypto.js";

const FILE_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_PATH_UTF8_BYTES = 16 * 1024;
const MAX_SYMLINK_TARGET_UTF8_BYTES = 16 * 1024;

export const VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS = 64;
export const VERIFIER_PROGRAM_MAX_ENTRIES = 32_768;
export const VERIFIER_PROGRAM_MAX_SINGLE_FILE_BYTES = 512 * 1024 * 1024;
export const VERIFIER_PROGRAM_MAX_TOTAL_FILE_BYTES = 1024 * 1024 * 1024;

export type VerifierProgramMaterialEntryV1 = Readonly<{
  path: string;
  relative_path: string;
  type: "regular_file" | "directory" | "symlink";
  mode: number;
  byte_length?: number;
  content_sha256?: string;
  symlink_target?: string;
}>;

export type VerifierProgramMaterialRootV1 = Readonly<{
  declared_path: string;
  resolved_path: string;
  root_type: "regular_file" | "directory";
  entries: readonly VerifierProgramMaterialEntryV1[];
}>;

export type VerifierProgramManifestV2 = Readonly<{
  contract_version: "verifier_program_manifest_v2";
  executable: Readonly<{
    declared_path: string;
    resolved_path: string;
    type: "regular_file";
    mode: number;
    byte_length: number;
    content_sha256: string;
  }>;
  material_roots: readonly VerifierProgramMaterialRootV1[];
  immutable_input_roots: readonly VerifierProgramMaterialRootV1[];
  entry_count: number;
  total_file_bytes: number;
}>;

export type VerifierProgramIdentityV2 = Readonly<{
  contract_version: "verifier_program_identity_v2";
  manifest: VerifierProgramManifestV2;
  verifier_program_digest: string;
}>;

type CaptureBudget = {
  entryCount: number;
  totalFileBytes: number;
};

type StableFileStat = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

export type VerifierProgramRunnerConfig = Readonly<{
  executable: string;
  argv: readonly string[];
  cwd: string;
  environment?:
    | Readonly<Record<string, string>>
    | readonly Readonly<{ key: string; value: string }>[];
}>;

function canonicalUtf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function assertBoundedAbsolutePath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\u0000")
    || !isAbsolute(value)
    || Buffer.byteLength(value, "utf8") > MAX_PATH_UTF8_BYTES
  ) {
    throw new TypeError(
      `${label} must be an exact absolute NUL-free path of at most ${MAX_PATH_UTF8_BYTES} UTF-8 bytes`,
    );
  }
}

function permissionMode(mode: bigint): number {
  return Number(mode & BigInt(0o7777));
}

function stableFileStat(path: string): StableFileStat {
  const stat = lstatSync(path, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameStableFileStat(left: StableFileStat, right: StableFileStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function consumeEntry(budget: CaptureBudget): void {
  budget.entryCount += 1;
  if (budget.entryCount > VERIFIER_PROGRAM_MAX_ENTRIES) {
    throw new RangeError(
      `Verifier program cannot exceed ${VERIFIER_PROGRAM_MAX_ENTRIES} material entries`,
    );
  }
}

function consumeFileBytes(budget: CaptureBudget, byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength)
    || byteLength < 0
    || byteLength > VERIFIER_PROGRAM_MAX_SINGLE_FILE_BYTES
  ) {
    throw new RangeError(
      `Verifier program file cannot exceed ${VERIFIER_PROGRAM_MAX_SINGLE_FILE_BYTES} bytes`,
    );
  }
  budget.totalFileBytes += byteLength;
  if (
    !Number.isSafeInteger(budget.totalFileBytes)
    || budget.totalFileBytes > VERIFIER_PROGRAM_MAX_TOTAL_FILE_BYTES
  ) {
    throw new RangeError(
      `Verifier program cannot exceed ${VERIFIER_PROGRAM_MAX_TOTAL_FILE_BYTES} total file bytes`,
    );
  }
}

function hashStableRegularFile(
  path: string,
  budget: CaptureBudget,
): Readonly<{
  mode: number;
  byte_length: number;
  content_sha256: string;
}> {
  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    throw new Error("runtime_verifier_program_file_unreadable");
  }

  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new Error("runtime_verifier_program_file_not_regular");
    }
    const byteLength = Number(before.size);
    consumeFileBytes(budget, byteLength);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(
      Math.min(FILE_READ_CHUNK_BYTES, Math.max(1, byteLength)),
    );
    let consumed = 0;
    while (consumed < byteLength) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, byteLength - consumed),
        null,
      );
      if (bytesRead <= 0) {
        throw new Error("runtime_verifier_program_file_short_read");
      }
      hash.update(buffer.subarray(0, bytesRead));
      consumed += bytesRead;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const beforeStable: StableFileStat = {
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    };
    const afterStable: StableFileStat = {
      dev: after.dev,
      ino: after.ino,
      mode: after.mode,
      size: after.size,
      mtimeNs: after.mtimeNs,
      ctimeNs: after.ctimeNs,
    };
    if (!sameStableFileStat(beforeStable, afterStable)) {
      throw new Error("runtime_verifier_program_file_changed_during_capture");
    }
    return {
      mode: permissionMode(before.mode),
      byte_length: byteLength,
      content_sha256: hash.digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}

function materialEntry(
  absolutePath: string,
  relativePath: string,
  budget: CaptureBudget,
): VerifierProgramMaterialEntryV1 {
  const before = stableFileStat(absolutePath);
  consumeEntry(budget);
  const stat = lstatSync(absolutePath, { bigint: true });
  if (stat.isFile()) {
    const file = hashStableRegularFile(absolutePath, budget);
    const after = stableFileStat(absolutePath);
    if (!sameStableFileStat(before, after)) {
      throw new Error("runtime_verifier_program_entry_changed_during_capture");
    }
    return {
      path: absolutePath,
      relative_path: relativePath,
      type: "regular_file",
      ...file,
    };
  }
  if (stat.isDirectory()) {
    return {
      path: absolutePath,
      relative_path: relativePath,
      type: "directory",
      mode: permissionMode(stat.mode),
    };
  }
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(absolutePath, "utf8");
    if (
      target.includes("\u0000")
      || Buffer.byteLength(target, "utf8") > MAX_SYMLINK_TARGET_UTF8_BYTES
    ) {
      throw new RangeError(
        `Verifier program symlink target cannot exceed ${MAX_SYMLINK_TARGET_UTF8_BYTES} UTF-8 bytes`,
      );
    }
    const after = stableFileStat(absolutePath);
    if (!sameStableFileStat(before, after)) {
      throw new Error("runtime_verifier_program_symlink_changed_during_capture");
    }
    return {
      path: absolutePath,
      relative_path: relativePath,
      type: "symlink",
      mode: permissionMode(stat.mode),
      symlink_target: target,
    };
  }
  throw new Error("runtime_verifier_program_unsupported_material_type");
}

function captureDirectoryEntries(
  root: string,
  budget: CaptureBudget,
): readonly VerifierProgramMaterialEntryV1[] {
  const entries: VerifierProgramMaterialEntryV1[] = [];

  const visit = (absolutePath: string, relativePath: string): void => {
    const entry = materialEntry(absolutePath, relativePath, budget);
    entries.push(entry);
    if (entry.type !== "directory") return;

    const before = stableFileStat(absolutePath);
    const names = readdirSync(absolutePath)
      .sort(canonicalUtf8Compare);
    for (const name of names) {
      if (
        name.length === 0
        || name === "."
        || name === ".."
        || name.includes("\u0000")
      ) {
        throw new Error("runtime_verifier_program_invalid_directory_entry");
      }
      const child = join(absolutePath, name);
      if (Buffer.byteLength(child, "utf8") > MAX_PATH_UTF8_BYTES) {
        throw new RangeError(
          `Verifier program path cannot exceed ${MAX_PATH_UTF8_BYTES} UTF-8 bytes`,
        );
      }
      visit(child, relativePath === "." ? name : join(relativePath, name));
    }
    const afterNames = readdirSync(absolutePath).sort(canonicalUtf8Compare);
    const after = stableFileStat(absolutePath);
    if (
      stableStringify(names) !== stableStringify(afterNames)
      || !sameStableFileStat(before, after)
    ) {
      throw new Error("runtime_verifier_program_directory_changed_during_capture");
    }
  };

  visit(root, ".");
  return entries;
}

function pathCoveredByDirectory(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ""
    || (!relation.startsWith("..") && !isAbsolute(relation));
}

function canonicalMaterialRoots(
  materialPaths: readonly string[],
  budget: CaptureBudget,
): readonly VerifierProgramMaterialRootV1[] {
  if (
    !Array.isArray(materialPaths)
    || materialPaths.length > VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS
  ) {
    throw new RangeError(
      `Verifier program cannot exceed ${VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS} material roots`,
    );
  }
  const roots = materialPaths.map((declaredPath, index) => {
    assertBoundedAbsolutePath(
      declaredPath,
      `Verifier material path[${index}]`,
    );
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(declaredPath);
    } catch {
      throw new Error("runtime_verifier_material_root_unavailable");
    }
    if (stat.isSymbolicLink()) {
      throw new Error("runtime_verifier_material_root_symlink_forbidden");
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error("runtime_verifier_material_root_must_be_file_or_directory");
    }
    const resolvedPath = realpathSync.native(declaredPath);
    assertBoundedAbsolutePath(
      resolvedPath,
      `Resolved verifier material path[${index}]`,
    );
    return {
      declared_path: normalize(declaredPath),
      resolved_path: resolvedPath,
      root_type: stat.isFile()
        ? "regular_file" as const
        : "directory" as const,
    };
  }).sort((left, right) =>
    canonicalUtf8Compare(left.resolved_path, right.resolved_path));

  for (let index = 0; index < roots.length; index += 1) {
    const current = roots[index]!;
    for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
      const prior = roots[priorIndex]!;
      if (
        prior.resolved_path === current.resolved_path
        || (
          prior.root_type === "directory"
          && pathCoveredByDirectory(
            prior.resolved_path,
            current.resolved_path,
          )
        )
        || (
          current.root_type === "directory"
          && pathCoveredByDirectory(
            current.resolved_path,
            prior.resolved_path,
          )
        )
      ) {
        throw new Error("runtime_verifier_material_roots_overlap");
      }
    }
  }

  const captured = roots.map((root) => ({
    ...root,
    entries: root.root_type === "regular_file"
      ? [materialEntry(root.resolved_path, ".", budget)]
      : captureDirectoryEntries(root.resolved_path, budget),
  }));
  for (const root of captured) {
    for (const entry of root.entries) {
      if (entry.type !== "symlink") continue;
      let resolvedTarget: string;
      try {
        if (readlinkSync(entry.path, "utf8") !== entry.symlink_target) {
          throw new Error("symlink target drift");
        }
        resolvedTarget = realpathSync.native(resolve(
          dirname(entry.path),
          entry.symlink_target,
        ));
      } catch {
        throw new Error(
          "runtime_verifier_material_symlink_target_unavailable",
        );
      }
      const targetCovered = captured.some((candidate) =>
        candidate.root_type === "regular_file"
          ? candidate.resolved_path === resolvedTarget
          : pathCoveredByDirectory(
              candidate.resolved_path,
              resolvedTarget,
            ));
      if (!targetCovered) {
        throw new Error(
          "runtime_verifier_material_symlink_target_not_declared",
        );
      }
    }
  }
  return captured;
}

function captureExecutable(
  executable: string,
  budget: CaptureBudget,
): VerifierProgramManifestV2["executable"] {
  assertBoundedAbsolutePath(executable, "Verifier executable");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(executable);
  } catch {
    throw new Error("runtime_verifier_executable_unavailable");
  }
  if (stat.isSymbolicLink()) {
    throw new Error("runtime_verifier_executable_symlink_forbidden");
  }
  if (!stat.isFile()) {
    throw new Error("runtime_verifier_executable_must_be_regular_file");
  }
  consumeEntry(budget);
  const resolvedPath = realpathSync.native(executable);
  const file = hashStableRegularFile(resolvedPath, budget);
  return {
    declared_path: normalize(executable),
    resolved_path: resolvedPath,
    type: "regular_file",
    ...file,
  };
}

type ReferencedPathCandidate = Readonly<{
  path: string;
  path_like: boolean;
}>;

function pathLikeArgumentValue(value: string): boolean {
  if (
    isAbsolute(value)
    || value.startsWith("file://")
    || value.startsWith("./")
    || value.startsWith("../")
    || value.includes("/")
    || value.includes("\\")
  ) {
    return true;
  }
  return (
    value.startsWith(".")
    || /^[^./\\\s][^/\\\s]*\.[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(value)
  );
}

function argvPathCandidates(
  argument: string,
  cwd: string,
): readonly ReferencedPathCandidate[] {
  if (argument.length === 0) return [];
  const values: string[] = [];
  const equals = argument.indexOf("=");
  if (argument.startsWith("-")) {
    if (equals < 0 || equals >= argument.length - 1) return [];
    values.push(argument.slice(equals + 1));
  } else {
    values.push(argument);
  }
  const expanded: string[] = [];
  for (const value of values) {
    if (value.startsWith("file://")) {
      try {
        expanded.push(fileURLToPath(value));
      } catch {
        // The invalid literal remains path-like and fails closed below.
        expanded.push(value);
      }
    } else {
      expanded.push(value);
    }
  }
  const candidates = new Map<string, ReferencedPathCandidate>();
  for (const value of expanded) {
    const path = isAbsolute(value) ? normalize(value) : resolve(cwd, value);
    const prior = candidates.get(path);
    candidates.set(path, {
      path,
      path_like: prior?.path_like === true || pathLikeArgumentValue(value),
    });
  }
  return [...candidates.values()];
}

function existingReferencedPath(
  path: string,
  errorPrefix: "argv" | "environment",
): {
  path: string;
  type: "regular_file" | "directory";
} | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw new Error(`runtime_verifier_${errorPrefix}_path_unavailable`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `runtime_primary_verifier_${errorPrefix}_symlink_forbidden`,
    );
  }
  if (!stat.isFile() && !stat.isDirectory()) return null;
  return {
    path: realpathSync.native(path),
    type: stat.isFile() ? "regular_file" : "directory",
  };
}

function pathCoveredByMaterialRoots(
  path: string,
  roots: readonly VerifierProgramMaterialRootV1[],
): boolean {
  return roots.some((root) =>
    root.root_type === "regular_file"
      ? root.resolved_path === path
      : pathCoveredByDirectory(root.resolved_path, path));
}

export function assertPrimaryVerifierArgvMaterialCoverage(args: {
  runnerConfig: VerifierProgramRunnerConfig;
  materialRoots: readonly VerifierProgramMaterialRootV1[];
}): void {
  for (const argument of args.runnerConfig.argv) {
    for (const candidate of argvPathCandidates(
      argument,
      args.runnerConfig.cwd,
    )) {
      const existing = existingReferencedPath(candidate.path, "argv");
      if (!existing) {
        if (candidate.path_like) {
          throw new Error(
            "runtime_primary_verifier_argv_path_unavailable_at_registration",
          );
        }
        continue;
      }
      if (!pathCoveredByMaterialRoots(existing.path, args.materialRoots)) {
        throw new Error(
          "runtime_primary_verifier_argv_material_not_declared",
        );
      }
    }
  }
}

function runnerEnvironmentEntries(
  environment: VerifierProgramRunnerConfig["environment"],
): readonly Readonly<{ key: string; value: string }>[] {
  if (environment === undefined) return [];
  return Array.isArray(environment)
    ? environment
    : Object.entries(environment).map(([key, value]) => ({ key, value }));
}

function environmentAbsolutePathCandidates(
  value: string,
): readonly string[] {
  const candidates: string[] = [];
  const uriScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.exec(value)?.[0];
  if (uriScheme !== undefined && uriScheme !== "file://") return [];
  if (value.startsWith("file://")) {
    try {
      candidates.push(fileURLToPath(value));
    } catch {
      throw new Error(
        "runtime_primary_verifier_environment_file_url_invalid",
      );
    }
  } else if (value.includes(delimiter)) {
    candidates.push(...value.split(delimiter));
  } else {
    candidates.push(value);
  }
  const equals = value.indexOf("=");
  if (equals >= 0 && equals < value.length - 1) {
    candidates.push(value.slice(equals + 1));
  }
  return [...new Set(
    candidates
      .filter((candidate) => isAbsolute(candidate))
      .map((candidate) => normalize(candidate)),
  )];
}

export function assertPrimaryVerifierEnvironmentImmutableInputCoverage(args: {
  runnerConfig: VerifierProgramRunnerConfig;
  immutableInputRoots: readonly VerifierProgramMaterialRootV1[];
}): void {
  for (const { value } of runnerEnvironmentEntries(
    args.runnerConfig.environment,
  )) {
    for (const candidate of environmentAbsolutePathCandidates(value)) {
      const existing = existingReferencedPath(candidate, "environment");
      if (!existing) {
        throw new Error(
          "runtime_primary_verifier_environment_path_unavailable_at_registration",
        );
      }
      if (
        !pathCoveredByMaterialRoots(
          existing.path,
          args.immutableInputRoots,
        )
      ) {
        throw new Error(
          "runtime_primary_verifier_environment_immutable_input_not_declared",
        );
      }
    }
  }
}

export function captureVerifierProgramIdentity(args: {
  runnerConfig: VerifierProgramRunnerConfig;
  verifierMaterialPaths: readonly string[];
  immutableInputPaths?: readonly string[];
}): VerifierProgramIdentityV2 {
  const immutableInputPaths = args.immutableInputPaths ?? [];
  if (
    args.verifierMaterialPaths.length + immutableInputPaths.length
      > VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS
  ) {
    throw new RangeError(
      `Verifier program and immutable inputs cannot exceed ${VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS} total roots`,
    );
  }
  const budget: CaptureBudget = {
    entryCount: 0,
    totalFileBytes: 0,
  };
  const executable = captureExecutable(args.runnerConfig.executable, budget);
  const materialRoots = canonicalMaterialRoots(
    args.verifierMaterialPaths,
    budget,
  );
  const immutableInputRoots = canonicalMaterialRoots(
    immutableInputPaths,
    budget,
  );
  const allRoots = [...materialRoots, ...immutableInputRoots];
  for (let index = 0; index < allRoots.length; index += 1) {
    const current = allRoots[index]!;
    for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
      const prior = allRoots[priorIndex]!;
      if (
        prior.resolved_path === current.resolved_path
        || (
          prior.root_type === "directory"
          && pathCoveredByDirectory(
            prior.resolved_path,
            current.resolved_path,
          )
        )
        || (
          current.root_type === "directory"
          && pathCoveredByDirectory(
            current.resolved_path,
            prior.resolved_path,
          )
        )
      ) {
        throw new Error(
          "runtime_verifier_program_and_immutable_input_roots_overlap",
        );
      }
    }
  }
  if (allRoots.some((root) =>
    root.resolved_path === executable.resolved_path)) {
    throw new Error("runtime_verifier_executable_material_redundant");
  }
  const manifest: VerifierProgramManifestV2 = {
    contract_version: "verifier_program_manifest_v2",
    executable,
    material_roots: materialRoots,
    immutable_input_roots: immutableInputRoots,
    entry_count: budget.entryCount,
    total_file_bytes: budget.totalFileBytes,
  };
  const verifierProgramDigest = sha256Hex(stableStringify({
    contract: "verifier_program_digest_v2",
    manifest,
  }));
  return deepFreeze({
    contract_version: "verifier_program_identity_v2",
    manifest,
    verifier_program_digest: verifierProgramDigest,
  });
}

export function verifierProgramDigest(args: {
  runnerConfig: VerifierProgramRunnerConfig;
  verifierMaterialPaths: readonly string[];
  immutableInputPaths?: readonly string[];
}): string {
  return captureVerifierProgramIdentity(args).verifier_program_digest;
}
