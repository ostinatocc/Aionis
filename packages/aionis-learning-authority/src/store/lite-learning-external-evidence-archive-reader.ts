// External operator authority; the focused Runtime never imports this module.
import { spawnSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  readLearningExternalEvidenceArchiveProofV1,
  verifyLearningExternalEvidenceArchiveV1,
  type LearningExternalEvidenceArchiveProofV1,
  type LearningExternalEvidenceArchiveValidationV1,
} from "../memory/learning-external-evidence-archive.js";
import {
  learningExternalPublicRunAuthorityDigest,
  parseCanonicalLearningExternalPublicRunAuthorityJson,
} from "../memory/learning-external-public-authority.js";

const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 128 * 1024;
const FILE_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_PUBLIC_RUN_AUTHORITY_BYTES = 32 * 1024 * 1024;
const MAX_TRUSTED_GIT_PATHS = 8_192;
const MAX_TRUSTED_GIT_TREE_DEPTH = 16;

const GIT_ENV = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});

type GitObjectFormat = "sha1" | "sha256";

type PinnedFileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type PathComponentIdentity = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
}>;

type TrustedGitPathIdentity = Readonly<{
  path: string;
  kind: "directory" | "file";
  directoryEntryStatePinned: boolean;
  dev: bigint;
  ino: bigint;
  size: bigint;
  uid: bigint;
  gid: bigint;
  mode: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type GitRepositoryLayout = Readonly<{
  repositoryRoot: string;
  gitEntryPath: string;
  gitDirectory: string;
  commonDirectory: string;
  headPath: string;
  refsPath: string;
  objectsPath: string;
}>;

type GitTrustSnapshot = Readonly<{
  layout: GitRepositoryLayout;
  identities: readonly TrustedGitPathIdentity[];
}>;

type PinnedInputFile = Readonly<{
  requestedPath: string;
  descriptor: number;
  identity: PinnedFileIdentity;
  pathComponents: readonly PathComponentIdentity[];
}>;

type GitTreeEntry = Readonly<{
  mode: "100644";
  type: "blob";
  objectId: string;
  path: string;
}>;

export type LiteLearningExternalEvidenceArchiveTrackingV1 = Readonly<{
  contract_version: "aionis_learning_external_evidence_archive_tracking_v1";
  object_format: GitObjectFormat;
  verified_head_commit_id: string;
  bundle_commit_id: string;
  archive_repo_relative_path: string;
  archive_blob_oid: string;
  public_run_authority_repo_relative_path: string;
  public_run_authority_blob_oid: string;
  raw_archive_sha256: string;
  raw_archive_byte_length: number;
  public_run_authority_sha256: string;
  public_run_authority_byte_length: number;
  run_bundle_manifest_sha256: string;
  evidence_binding_sha256: string;
}>;

const preparedBrand: unique symbol = Symbol(
  "prepared-lite-learning-external-evidence-archive",
);

export type PreparedLiteLearningExternalEvidenceArchive = Readonly<{
  [preparedBrand]: "prepared_lite_learning_external_evidence_archive_v1";
}>;

export type InspectedPreparedLiteLearningExternalEvidenceArchive = Readonly<{
  archiveValidation: LearningExternalEvidenceArchiveValidationV1;
  tracking: LiteLearningExternalEvidenceArchiveTrackingV1;
}>;

type PreparedState = {
  readonly archive: PinnedInputFile;
  readonly publicRunAuthority: PinnedInputFile;
  readonly repositoryRoot: string;
  readonly gitLayout: GitRepositoryLayout;
  readonly archiveProof: LearningExternalEvidenceArchiveProofV1;
  readonly inspected: InspectedPreparedLiteLearningExternalEvidenceArchive;
  closed: boolean;
};

const preparedRegistry = new WeakMap<object, PreparedState>();

function readerError(reason: string): Error {
  return new Error(`learning_external_evidence_archive_reader_invalid:${reason}`);
}

function currentUid(): bigint {
  if (typeof process.getuid !== "function") {
    throw readerError("current_uid_unavailable");
  }
  return BigInt(process.getuid());
}

function exactLine(bytes: Buffer, label: string): string {
  if (bytes.includes(0) || bytes.includes(0x0d)) {
    throw readerError(`git_${label}_malformed`);
  }
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0
    || !text.endsWith("\n")
    || text.slice(0, -1).includes("\n")) {
    throw readerError(`git_${label}_malformed`);
  }
  return text.slice(0, -1);
}

function runGit(
  workingDirectory: string,
  args: readonly string[],
  options: Readonly<{ allowedStatuses?: readonly number[] }> = {},
): Readonly<{ status: number; stdout: Buffer }> {
  const result = spawnSync(
    GIT_EXECUTABLE,
    ["--literal-pathspecs", "-C", workingDirectory, ...args],
    {
      encoding: "buffer",
      env: GIT_ENV,
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const allowedStatuses = options.allowedStatuses ?? [0];
  if (result.error
    || result.signal !== null
    || result.status === null
    || !allowedStatuses.includes(result.status)
    || !(result.stdout instanceof Buffer)
    || !(result.stderr instanceof Buffer)
    || result.stderr.byteLength !== 0) {
    throw readerError("git_command_failed");
  }
  return Object.freeze({ status: result.status, stdout: result.stdout });
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (typeof value !== "string"
    || !isAbsolute(value)
    || value !== normalize(value)
    || value !== resolve(value)
    || value.includes("\0")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw readerError(`${label}_absolute_normalized_path_required`);
  }
  return value;
}

function gitTrustError(reason: string): Error {
  return readerError(`git_filesystem_untrusted:${reason}`);
}

function assertLinuxBasicAccessControlList(path: string): void {
  let inspected: ReturnType<typeof spawnSync> | null = null;
  for (const executable of ["/usr/bin/getfacl", "/bin/getfacl"] as const) {
    const candidate = spawnSync(executable, ["-c", "-E", "-p", "-n", "--", path], {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 64 * 1024,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
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
    || inspected.signal !== null
    || inspected.status !== 0
    || typeof inspected.stdout !== "string"
    || typeof inspected.stderr !== "string"
    || inspected.stderr.trim().length !== 0
    || inspected.stdout.includes("\ufffd")) {
    throw gitTrustError("linux_acl_verifier_failed");
  }
  const entries = inspected.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const baseAcl = new Map<"user" | "group" | "other", string>();
  for (const entry of entries) {
    const match = /^(user|group|other)::([r-][w-][x-])$/u.exec(entry);
    if (!match || baseAcl.has(match[1] as "user" | "group" | "other")) {
      throw gitTrustError("delegated_or_unverifiable_linux_acl");
    }
    baseAcl.set(match[1] as "user" | "group" | "other", match[2]!);
  }
  if (baseAcl.size !== 3) throw gitTrustError("incomplete_linux_acl");
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch {
    throw gitTrustError("acl_target_changed");
  }
  const permissionText = (read: bigint, write: bigint, execute: bigint): string => (
    `${(stat.mode & read) !== 0n ? "r" : "-"}${(stat.mode & write) !== 0n ? "w" : "-"}${(stat.mode & execute) !== 0n ? "x" : "-"}`
  );
  if (baseAcl.get("user") !== permissionText(0o400n, 0o200n, 0o100n)
    || baseAcl.get("group") !== permissionText(0o040n, 0o020n, 0o010n)
    || baseAcl.get("other") !== permissionText(0o004n, 0o002n, 0o001n)) {
    throw gitTrustError("linux_acl_mode_mismatch");
  }
}

function assertDarwinNoDelegatedAccessControlList(path: string): void {
  const inspected = spawnSync("/bin/ls", ["-lde", "--", path], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: 64 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
  if (inspected.error
    || inspected.signal !== null
    || inspected.status !== 0
    || typeof inspected.stdout !== "string") {
    throw gitTrustError("darwin_acl_verifier_failed");
  }
  const modeToken = inspected.stdout.trimStart().split(/\s+/u, 1)[0] ?? "";
  if (!/^[bcdlps-][rwxStTs-]{9}[@.+]?$/u.test(modeToken)) {
    throw gitTrustError("darwin_acl_result_unverifiable");
  }
  const aclLines = inspected.stdout.split(/\r?\n/u).slice(1).filter(
    (line) => /^\s*\d+:/u.test(line),
  );
  if ((modeToken.includes("+") && aclLines.length === 0)
    || aclLines.some((line) => !/\b(?:allow|deny)\b/u.test(line))
    || aclLines.some((line) => /\ballow\b/u.test(line))) {
    throw gitTrustError("delegated_or_unverifiable_darwin_acl");
  }
}

function assertNoDelegatedAccessControlList(path: string): void {
  if (process.platform === "linux") {
    assertLinuxBasicAccessControlList(path);
    return;
  }
  if (process.platform === "darwin") {
    assertDarwinNoDelegatedAccessControlList(path);
    return;
  }
  throw gitTrustError("acl_verifier_platform_unsupported");
}

function trustedGitPathIdentity(
  path: string,
  stat: BigIntStats,
  ignoreDirectoryEntryChurn = false,
): TrustedGitPathIdentity {
  return Object.freeze({
    path,
    kind: stat.isDirectory() ? "directory" : "file",
    directoryEntryStatePinned: !ignoreDirectoryEntryChurn,
    dev: stat.dev,
    ino: stat.ino,
    size: ignoreDirectoryEntryChurn ? 0n : stat.size,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    nlink: ignoreDirectoryEntryChurn ? 0n : stat.nlink,
    mtimeNs: ignoreDirectoryEntryChurn ? 0n : stat.mtimeNs,
    ctimeNs: ignoreDirectoryEntryChurn ? 0n : stat.ctimeNs,
  });
}

function sameTrustedGitPathIdentity(
  left: TrustedGitPathIdentity,
  right: TrustedGitPathIdentity,
): boolean {
  return left.path === right.path
    && left.kind === right.kind
    && left.directoryEntryStatePinned === right.directoryEntryStatePinned
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameTrustedGitPathSecurityIdentity(
  left: TrustedGitPathIdentity,
  right: TrustedGitPathIdentity,
): boolean {
  return left.path === right.path
    && left.kind === right.kind
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function captureTrustedGitPath(
  path: string,
  expectedKind: "directory" | "file",
  ownership: "service" | "service_or_root_ancestor",
  identities: Map<string, TrustedGitPathIdentity>,
): void {
  if (!identities.has(path) && identities.size >= MAX_TRUSTED_GIT_PATHS) {
    throw gitTrustError("metadata_entry_limit_exceeded");
  }
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    throw gitTrustError("required_path_unavailable");
  }
  if (before.isSymbolicLink()) throw gitTrustError("symlink_rejected");
  if ((expectedKind === "directory" && !before.isDirectory())
    || (expectedKind === "file" && !before.isFile())) {
    throw gitTrustError("path_kind_mismatch");
  }
  const uid = currentUid();
  if (ownership === "service" ? before.uid !== uid : before.uid !== uid && before.uid !== 0n) {
    throw gitTrustError("owner_not_trusted");
  }
  const isStickyAncestor = ownership === "service_or_root_ancestor"
    && before.isDirectory()
    && (before.mode & 0o1000n) !== 0n;
  if ((before.mode & 0o022n) !== 0n && !isStickyAncestor) {
    throw gitTrustError("group_or_other_writable");
  }
  if (expectedKind === "file"
    && ((before.mode & 0o111n) !== 0n || before.nlink !== 1n)) {
    throw gitTrustError("executable_or_hard_linked_metadata_file");
  }
  assertNoDelegatedAccessControlList(path);
  let after: BigIntStats;
  try {
    after = lstatSync(path, { bigint: true });
  } catch {
    throw gitTrustError("path_changed_during_inspection");
  }
  // Ancestors above the service-controlled boundary can legitimately gain
  // unrelated siblings while this process runs (including a per-user temp
  // directory). Their non-delegated permissions protect our controlled child;
  // pin the ancestor identity/ACL/mode but exclude unrelated entry churn. A
  // process with the same UID remains explicitly inside the local service TCB.
  const ignoreDirectoryEntryChurn = ownership === "service_or_root_ancestor";
  const identity = trustedGitPathIdentity(
    path,
    before,
    ignoreDirectoryEntryChurn,
  );
  if (!sameTrustedGitPathIdentity(
    identity,
    trustedGitPathIdentity(path, after, ignoreDirectoryEntryChurn),
  )) {
    throw gitTrustError("path_changed_during_inspection");
  }
  const existing = identities.get(path);
  if (existing) {
    if (!sameTrustedGitPathSecurityIdentity(existing, identity)) {
      throw gitTrustError(`path_changed_during_inspection:${path}`);
    }
    if (existing.directoryEntryStatePinned
      && !identity.directoryEntryStatePinned) {
      return;
    }
    if (existing.directoryEntryStatePinned === identity.directoryEntryStatePinned
      && !sameTrustedGitPathIdentity(existing, identity)) {
      throw gitTrustError(`path_changed_during_inspection:${path}`);
    }
  }
  identities.set(path, identity);
}

function captureTrustedAncestorChain(
  startingDirectory: string,
  identities: Map<string, TrustedGitPathIdentity>,
  controlledRoot?: string,
): void {
  let cursor = startingDirectory;
  for (;;) {
    const controlled = controlledRoot !== undefined
      && (cursor === controlledRoot
        || (!relative(controlledRoot, cursor).startsWith(`..${sep}`)
          && relative(controlledRoot, cursor) !== ".."
          && !isAbsolute(relative(controlledRoot, cursor))));
    captureTrustedGitPath(
      cursor,
      "directory",
      controlled ? "service" : "service_or_root_ancestor",
      identities,
    );
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function captureTrustedGitTree(
  root: string,
  identities: Map<string, TrustedGitPathIdentity>,
  depth = 0,
): void {
  if (depth > MAX_TRUSTED_GIT_TREE_DEPTH) {
    throw gitTrustError("metadata_tree_depth_limit_exceeded");
  }
  captureTrustedGitPath(root, "directory", "service", identities);
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name, "en"),
    );
  } catch {
    throw gitTrustError("metadata_tree_unreadable");
  }
  for (const entry of entries) {
    if (entry.name.includes("\0") || /[\u0000-\u001f\u007f]/u.test(entry.name)) {
      throw gitTrustError("metadata_name_invalid");
    }
    const path = join(root, entry.name);
    if (path.endsWith(`${sep}info${sep}alternates`)
      || path.endsWith(`${sep}info${sep}http-alternates`)) {
      throw gitTrustError("alternate_object_database_rejected");
    }
    if (entry.isDirectory()) {
      captureTrustedGitTree(path, identities, depth + 1);
    } else if (entry.isFile()) {
      captureTrustedGitPath(path, "file", "service", identities);
    } else {
      throw gitTrustError("special_or_symlink_metadata_entry_rejected");
    }
  }
  const expected = identities.get(root)!;
  let finalStat: BigIntStats;
  try {
    finalStat = lstatSync(root, { bigint: true });
  } catch {
    throw gitTrustError("metadata_tree_changed");
  }
  if (!sameTrustedGitPathIdentity(
    expected,
    trustedGitPathIdentity(root, finalStat),
  )) {
    throw gitTrustError("metadata_tree_changed");
  }
}

function captureTrustedGitDirectoryEntries(
  directory: string,
  identities: Map<string, TrustedGitPathIdentity>,
): void {
  captureTrustedGitPath(directory, "directory", "service", identities);
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name, "en"),
    );
  } catch {
    throw gitTrustError("git_directory_unreadable");
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile()) {
      captureTrustedGitPath(path, "file", "service", identities);
    } else if (entry.isDirectory()) {
      captureTrustedGitPath(path, "directory", "service", identities);
    } else {
      throw gitTrustError("special_or_symlink_git_directory_entry_rejected");
    }
  }
  const expected = identities.get(directory)!;
  const finalStat = lstatSync(directory, { bigint: true });
  if (!sameTrustedGitPathIdentity(
    expected,
    trustedGitPathIdentity(directory, finalStat),
  )) {
    throw gitTrustError("git_directory_changed");
  }
}

function canonicalGitPath(
  repositoryRoot: string,
  args: readonly string[],
  label: string,
): string {
  const path = normalizedAbsolutePath(
    exactLine(
      runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", ...args]).stdout,
      label,
    ),
    label,
  );
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    throw gitTrustError(`${label}_unavailable`);
  }
  if (canonical !== path) throw gitTrustError(`${label}_noncanonical`);
  return path;
}

function readGitDirectoryPointer(path: string, prefix: string): string {
  let stat: BigIntStats;
  let bytes: Buffer;
  try {
    stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.size < 1n || stat.size > 8_192n) {
      throw gitTrustError("git_pointer_file_malformed");
    }
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof Error
      && error.message.startsWith("learning_external_evidence_archive_reader_invalid:")) {
      throw error;
    }
    throw gitTrustError("git_pointer_file_unreadable");
  }
  if (bytes.includes(0) || bytes.includes(0x0d)) {
    throw gitTrustError("git_pointer_file_malformed");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)
    || !text.endsWith("\n")
    || text.slice(0, -1).includes("\n")
    || !text.startsWith(prefix)) {
    throw gitTrustError("git_pointer_file_malformed");
  }
  const value = text.slice(prefix.length, -1);
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw gitTrustError("git_pointer_file_malformed");
  }
  return value;
}

function discoverGitRepositoryLayout(repositoryRoot: string): GitRepositoryLayout {
  const gitEntryPath = join(repositoryRoot, ".git");
  let gitEntryStat: BigIntStats;
  try {
    gitEntryStat = lstatSync(gitEntryPath, { bigint: true });
  } catch {
    throw gitTrustError("worktree_git_entry_required");
  }
  if (gitEntryStat.isSymbolicLink()
    || (!gitEntryStat.isDirectory() && !gitEntryStat.isFile())) {
    throw gitTrustError("worktree_git_entry_invalid");
  }
  const gitDirectory = canonicalGitPath(
    repositoryRoot,
    ["--git-dir"],
    "git_directory",
  );
  const commonDirectory = canonicalGitPath(
    repositoryRoot,
    ["--git-common-dir"],
    "git_common_directory",
  );
  const headPath = canonicalGitPath(
    repositoryRoot,
    ["--git-path", "HEAD"],
    "git_head_path",
  );
  const refsPath = canonicalGitPath(
    repositoryRoot,
    ["--git-path", "refs"],
    "git_refs_path",
  );
  const objectsPath = canonicalGitPath(
    repositoryRoot,
    ["--git-path", "objects"],
    "git_objects_path",
  );
  if (headPath !== join(gitDirectory, "HEAD")
    || refsPath !== join(commonDirectory, "refs")
    || objectsPath !== join(commonDirectory, "objects")) {
    throw gitTrustError("git_control_path_redirected");
  }
  if (gitEntryStat.isDirectory()) {
    if (realpathSync.native(gitEntryPath) !== gitDirectory
      || commonDirectory !== gitDirectory) {
      throw gitTrustError("ordinary_worktree_layout_mismatch");
    }
  } else {
    const pointer = readGitDirectoryPointer(gitEntryPath, "gitdir: ");
    const pointerPath = resolve(repositoryRoot, pointer);
    let canonicalPointer: string;
    try {
      canonicalPointer = realpathSync.native(pointerPath);
    } catch {
      throw gitTrustError("linked_worktree_git_pointer_unavailable");
    }
    if (canonicalPointer !== gitDirectory) {
      throw gitTrustError("linked_worktree_git_pointer_mismatch");
    }
    const commonPointer = readGitDirectoryPointer(
      join(gitDirectory, "commondir"),
      "",
    );
    let canonicalCommonPointer: string;
    try {
      canonicalCommonPointer = realpathSync.native(resolve(gitDirectory, commonPointer));
    } catch {
      throw gitTrustError("linked_worktree_common_pointer_unavailable");
    }
    if (canonicalCommonPointer !== commonDirectory) {
      throw gitTrustError("linked_worktree_common_pointer_mismatch");
    }
  }
  return Object.freeze({
    repositoryRoot,
    gitEntryPath,
    gitDirectory,
    commonDirectory,
    headPath,
    refsPath,
    objectsPath,
  });
}

function sameGitRepositoryLayout(
  left: GitRepositoryLayout,
  right: GitRepositoryLayout,
): boolean {
  return left.repositoryRoot === right.repositoryRoot
    && left.gitEntryPath === right.gitEntryPath
    && left.gitDirectory === right.gitDirectory
    && left.commonDirectory === right.commonDirectory
    && left.headPath === right.headPath
    && left.refsPath === right.refsPath
    && left.objectsPath === right.objectsPath;
}

function assertSafeLocalGitConfig(repositoryRoot: string): void {
  const inspected = runGit(
    repositoryRoot,
    [
      "config",
      "--local",
      "--no-includes",
      "--name-only",
      "--get-regexp",
      ".*",
    ],
    { allowedStatuses: [0, 1] },
  );
  if (inspected.status === 1) {
    if (inspected.stdout.byteLength !== 0) {
      throw gitTrustError("git_local_config_listing_malformed");
    }
    return;
  }
  if (inspected.stdout.includes(0) || inspected.stdout.includes(0x0d)) {
    throw gitTrustError("git_local_config_listing_malformed");
  }
  const text = inspected.stdout.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(inspected.stdout)
    || !text.endsWith("\n")) {
    throw gitTrustError("git_local_config_listing_malformed");
  }
  const names = text.slice(0, -1).split("\n");
  if (names.some((name) => name.length === 0)) {
    throw gitTrustError("git_local_config_listing_malformed");
  }
  if (names.some((name) => /^include(?:if)?\./iu.test(name))) {
    // Local include/includeIf directives can import configuration from outside
    // the pinned Git metadata tree. Reject them instead of trying to reproduce
    // Git's conditional-include resolver and filesystem trust semantics.
    throw gitTrustError("git_local_config_include_rejected");
  }
  const refStorage = runGit(
    repositoryRoot,
    [
      "config",
      "--local",
      "--no-includes",
      "--get",
      "extensions.refStorage",
    ],
    { allowedStatuses: [0, 1] },
  );
  if (refStorage.status === 1) {
    if (refStorage.stdout.byteLength !== 0) {
      throw gitTrustError("git_ref_storage_listing_malformed");
    }
  } else if (exactLine(refStorage.stdout, "ref_storage") !== "files") {
    // Reftable stores refs outside the refs/ + packed-refs file boundary below.
    // The formal evidence reader currently supports only the files backend.
    throw gitTrustError("git_ref_storage_unsupported");
  }
}

function captureGitTrustSnapshot(
  layout: GitRepositoryLayout,
  archivePath: string,
  publicRunAuthorityPath: string,
): GitTrustSnapshot {
  const identities = new Map<string, TrustedGitPathIdentity>();
  captureTrustedAncestorChain(layout.repositoryRoot, identities, layout.repositoryRoot);
  captureTrustedAncestorChain(
    dirname(archivePath),
    identities,
    layout.repositoryRoot,
  );
  captureTrustedAncestorChain(
    dirname(publicRunAuthorityPath),
    identities,
    layout.repositoryRoot,
  );
  captureTrustedGitPath(archivePath, "file", "service", identities);
  captureTrustedGitPath(publicRunAuthorityPath, "file", "service", identities);
  captureTrustedAncestorChain(layout.gitDirectory, identities);
  captureTrustedAncestorChain(layout.commonDirectory, identities);
  captureTrustedGitPath(
    layout.gitEntryPath,
    lstatSync(layout.gitEntryPath, { bigint: true }).isDirectory()
      ? "directory"
      : "file",
    "service",
    identities,
  );
  captureTrustedGitDirectoryEntries(layout.gitDirectory, identities);
  if (layout.commonDirectory !== layout.gitDirectory) {
    captureTrustedGitDirectoryEntries(layout.commonDirectory, identities);
  }
  try {
    lstatSync(join(layout.commonDirectory, "info", "grafts"), { bigint: true });
    throw gitTrustError("legacy_grafts_rejected");
  } catch (error) {
    if (error instanceof Error
      && error.message.startsWith("learning_external_evidence_archive_reader_invalid:")) {
      throw error;
    }
    if (!error
      || typeof error !== "object"
      || !("code" in error)
      || error.code !== "ENOENT") {
      throw gitTrustError("legacy_grafts_state_unverifiable");
    }
  }
  captureTrustedGitPath(layout.headPath, "file", "service", identities);
  captureTrustedGitTree(layout.refsPath, identities);
  const perWorktreeRefs = join(layout.gitDirectory, "refs");
  if (perWorktreeRefs !== layout.refsPath) {
    try {
      const perWorktreeRefsStat = lstatSync(perWorktreeRefs, { bigint: true });
      if (!perWorktreeRefsStat.isDirectory()) {
        throw gitTrustError("per_worktree_refs_not_directory");
      }
      captureTrustedGitTree(perWorktreeRefs, identities);
    } catch (error) {
      if (error instanceof Error
        && error.message.startsWith("learning_external_evidence_archive_reader_invalid:")) {
        throw error;
      }
      if (!error
        || typeof error !== "object"
        || !("code" in error)
        || error.code !== "ENOENT") {
        throw gitTrustError("per_worktree_refs_state_unverifiable");
      }
    }
  }
  captureTrustedGitTree(layout.objectsPath, identities);
  return Object.freeze({
    layout,
    identities: Object.freeze([...identities.values()].sort(
      (left, right) => left.path.localeCompare(right.path, "en"),
    )),
  });
}

function assertGitTrustSnapshotStable(
  expected: GitTrustSnapshot,
  actual: GitTrustSnapshot,
): void {
  if (!sameGitRepositoryLayout(expected.layout, actual.layout)
    || expected.identities.length !== actual.identities.length) {
    throw gitTrustError("git_metadata_changed");
  }
  for (let index = 0; index < expected.identities.length; index += 1) {
    if (!sameTrustedGitPathIdentity(
      expected.identities[index]!,
      actual.identities[index]!,
    )) {
      throw gitTrustError(
        `git_metadata_changed:${expected.identities[index]!.path}`,
      );
    }
  }
}

function fileIdentity(stat: BigIntStats): PinnedFileIdentity {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function sameFileIdentity(
  left: PinnedFileIdentity,
  right: PinnedFileIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertTrustedDataFileStat(stat: BigIntStats, label: string): void {
  if (!stat.isFile()) throw readerError(`${label}_regular_file_required`);
  if (stat.uid !== currentUid()) throw readerError(`${label}_current_uid_required`);
  if ((stat.mode & 0o022n) !== 0n) {
    throw readerError(`${label}_group_or_other_writable`);
  }
  if ((stat.mode & 0o111n) !== 0n) {
    throw readerError(`${label}_executable_data_file`);
  }
  if (stat.nlink !== 1n) throw readerError(`${label}_hard_link_rejected`);
}

function inspectNoSymlinkPath(
  path: string,
  label: string,
): readonly PathComponentIdentity[] {
  const root = parsePath(path).root;
  const suffix = path.slice(root.length);
  const parts = suffix.length === 0 ? [] : suffix.split(sep);
  const identities: PathComponentIdentity[] = [];
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]!);
    let stat: BigIntStats;
    try {
      stat = lstatSync(cursor, { bigint: true });
    } catch {
      throw readerError(`${label}_path_unavailable`);
    }
    if (stat.isSymbolicLink()) throw readerError(`${label}_symlink_rejected`);
    const isLast = index === parts.length - 1;
    if (!isLast && !stat.isDirectory()) {
      throw readerError(`${label}_ancestor_directory_required`);
    }
    identities.push(Object.freeze({
      path: cursor,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode,
    }));
  }
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(path);
  } catch {
    throw readerError(`${label}_path_unavailable`);
  }
  if (canonicalPath !== path) throw readerError(`${label}_noncanonical_path`);
  return Object.freeze(identities);
}

function assertPathComponentsPinned(
  expected: readonly PathComponentIdentity[],
  label: string,
): void {
  for (let index = 0; index < expected.length; index += 1) {
    const component = expected[index]!;
    let stat: BigIntStats;
    try {
      stat = lstatSync(component.path, { bigint: true });
    } catch {
      throw readerError(`${label}_path_changed`);
    }
    if (stat.isSymbolicLink()
      || stat.dev !== component.dev
      || stat.ino !== component.ino
      || stat.uid !== component.uid
      || stat.mode !== component.mode) {
      throw readerError(`${label}_path_changed`);
    }
    if (index < expected.length - 1 && !stat.isDirectory()) {
      throw readerError(`${label}_path_changed`);
    }
  }
}

function openPinnedInputFile(path: string, label: string): PinnedInputFile {
  const requestedPath = normalizedAbsolutePath(path, label);
  const pathComponents = inspectNoSymlinkPath(requestedPath, label);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  if (noFollow === 0) throw readerError("o_nofollow_unavailable");
  const nonBlocking = typeof fsConstants.O_NONBLOCK === "number"
    ? fsConstants.O_NONBLOCK
    : 0;
  if (nonBlocking === 0) throw readerError("o_nonblock_unavailable");
  let descriptor: number;
  try {
    descriptor = openSync(
      requestedPath,
      fsConstants.O_RDONLY | noFollow | nonBlocking,
    );
  } catch {
    throw readerError(`${label}_open_failed`);
  }
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    assertTrustedDataFileStat(stat, label);
    assertPathComponentsPinned(pathComponents, label);
    const pathStat = lstatSync(requestedPath, { bigint: true });
    const identity = fileIdentity(stat);
    if (!sameFileIdentity(identity, fileIdentity(pathStat))) {
      throw readerError(`${label}_path_descriptor_mismatch`);
    }
    return Object.freeze({ requestedPath, descriptor, identity, pathComponents });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertPinnedFile(file: PinnedInputFile, label: string): void {
  let descriptorStat: BigIntStats;
  let pathStat: BigIntStats;
  try {
    descriptorStat = fstatSync(file.descriptor, { bigint: true });
    pathStat = lstatSync(file.requestedPath, { bigint: true });
  } catch {
    throw readerError(`${label}_file_changed`);
  }
  assertTrustedDataFileStat(descriptorStat, label);
  assertTrustedDataFileStat(pathStat, label);
  const descriptorIdentity = fileIdentity(descriptorStat);
  if (!sameFileIdentity(file.identity, descriptorIdentity)
    || !sameFileIdentity(file.identity, fileIdentity(pathStat))) {
    throw readerError(`${label}_file_changed`);
  }
  assertPathComponentsPinned(file.pathComponents, label);
  if (realpathSync.native(file.requestedPath) !== file.requestedPath) {
    throw readerError(`${label}_path_changed`);
  }
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw readerError(`${label}_byte_length_not_safe_integer`);
  }
  return Number(value);
}

function readExactly(
  descriptor: number,
  offset: number,
  length: number,
): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    let count: number;
    try {
      count = readSync(
        descriptor,
        bytes,
        read,
        length - read,
        offset + read,
      );
    } catch {
      throw readerError("pinned_file_read_failed");
    }
    if (count <= 0) throw readerError("pinned_file_truncated");
    read += count;
  }
  return bytes;
}

function gitBlobHash(objectFormat: GitObjectFormat, byteLength: number): Hash {
  const algorithm = objectFormat === "sha1" ? "sha1" : "sha256";
  return createHash(algorithm).update(`blob ${byteLength}\0`, "utf8");
}

function streamArchive(
  archive: PinnedInputFile,
  objectFormat: GitObjectFormat,
): Readonly<{
  validation: LearningExternalEvidenceArchiveValidationV1;
  blobObjectId: string;
}> {
  const byteLength = safeNumber(archive.identity.size, "archive");
  const blobHash = gitBlobHash(objectFormat, byteLength);
  let expectedOffset = 0;
  const validation = verifyLearningExternalEvidenceArchiveV1({
    byteLength,
    readExactly(offset, length) {
      if (offset !== expectedOffset) throw readerError("archive_nonsequential_read");
      const bytes = readExactly(archive.descriptor, offset, length);
      blobHash.update(bytes);
      expectedOffset += length;
      return bytes;
    },
  });
  if (expectedOffset !== byteLength) throw readerError("archive_incomplete_read");
  return Object.freeze({ validation, blobObjectId: blobHash.digest("hex") });
}

function streamPublicRunAuthority(
  file: PinnedInputFile,
  objectFormat: GitObjectFormat,
): Readonly<{
  bytes: Buffer;
  sha256: string;
  blobObjectId: string;
}> {
  const byteLength = safeNumber(file.identity.size, "public_run_authority");
  if (byteLength > MAX_PUBLIC_RUN_AUTHORITY_BYTES) {
    throw readerError("public_run_authority_byte_limit");
  }
  const bytes = Buffer.allocUnsafe(byteLength);
  const sha256 = createHash("sha256");
  const blobHash = gitBlobHash(objectFormat, byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const chunkLength = Math.min(FILE_READ_CHUNK_BYTES, byteLength - offset);
    const chunk = readExactly(file.descriptor, offset, chunkLength);
    chunk.copy(bytes, offset);
    sha256.update(chunk);
    blobHash.update(chunk);
    offset += chunkLength;
  }
  return Object.freeze({
    bytes,
    sha256: sha256.digest("hex"),
    blobObjectId: blobHash.digest("hex"),
  });
}

function repositoryRootFor(path: string, label: string): string {
  const root = exactLine(
    runGit(dirname(path), ["rev-parse", "--show-toplevel"]).stdout,
    `${label}_repository_root`,
  );
  const normalized = normalizedAbsolutePath(root, `${label}_repository_root`);
  inspectNoSymlinkPath(normalized, `${label}_repository_root`);
  return normalized;
}

function repositoryRelativePath(repositoryRoot: string, path: string): string {
  const result = relative(repositoryRoot, path);
  if (result.length === 0
    || result === ".."
    || result.startsWith(`..${sep}`)
    || isAbsolute(result)
    || result.includes("\\")) {
    throw readerError("input_outside_repository");
  }
  return result;
}

function objectFormat(repositoryRoot: string): GitObjectFormat {
  const format = exactLine(
    runGit(repositoryRoot, ["rev-parse", "--show-object-format"]).stdout,
    "object_format",
  );
  if (format !== "sha1" && format !== "sha256") {
    throw readerError("git_object_format_unsupported");
  }
  return format;
}

function assertObjectId(
  value: string,
  format: GitObjectFormat,
  label: string,
): string {
  const expectedLength = format === "sha1" ? 40 : 64;
  if (value.length !== expectedLength || !/^[0-9a-f]+$/u.test(value)) {
    throw readerError(`git_${label}_object_id_malformed`);
  }
  return value;
}

function headCommit(repositoryRoot: string, format: GitObjectFormat): string {
  return assertObjectId(
    exactLine(
      runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout,
      "head_commit",
    ),
    format,
    "head_commit",
  );
}

function treeEntry(
  repositoryRoot: string,
  commitId: string,
  path: string,
  format: GitObjectFormat,
): GitTreeEntry {
  const output = runGit(
    repositoryRoot,
    ["ls-tree", "-z", commitId, "--", path],
  ).stdout;
  if (output.byteLength < 2 || output[output.byteLength - 1] !== 0) {
    throw readerError("git_tree_entry_missing");
  }
  const records = output.subarray(0, -1).toString("binary").split("\0");
  if (records.length !== 1) throw readerError("git_tree_entry_ambiguous");
  const record = Buffer.from(records[0]!, "binary");
  const separator = record.indexOf(0x09);
  if (separator <= 0) throw readerError("git_tree_entry_malformed");
  const header = record.subarray(0, separator).toString("ascii");
  const match = /^(\d{6}) ([a-z]+) ([0-9a-f]+)$/u.exec(header);
  const pathBytes = record.subarray(separator + 1);
  if (!match
    || !pathBytes.equals(Buffer.from(path, "utf8"))
    || match[1] !== "100644"
    || match[2] !== "blob") {
    throw readerError("git_tree_entry_not_regular_data_blob");
  }
  return Object.freeze({
    mode: "100644",
    type: "blob",
    objectId: assertObjectId(match[3]!, format, "tree_blob"),
    path,
  });
}

function bundleCommit(
  repositoryRoot: string,
  fixedHead: string,
  archivePath: string,
  publicRunAuthorityPath: string,
  format: GitObjectFormat,
): string {
  const commit = assertObjectId(
    exactLine(
      runGit(repositoryRoot, [
        "rev-list",
        "-1",
        fixedHead,
        "--",
        archivePath,
        publicRunAuthorityPath,
      ]).stdout,
      "bundle_commit",
    ),
    format,
    "bundle_commit",
  );
  const ancestor = runGit(
    repositoryRoot,
    ["merge-base", "--is-ancestor", commit, fixedHead],
    { allowedStatuses: [0, 1] },
  );
  if (ancestor.status !== 0 || ancestor.stdout.byteLength !== 0) {
    throw readerError("git_bundle_commit_not_head_ancestor");
  }
  return commit;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function preparedState(value: unknown): PreparedState {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw readerError("unrecognized_prepared_capability");
  }
  const state = preparedRegistry.get(value);
  if (!state) throw readerError("unrecognized_prepared_capability");
  if (state.closed) throw readerError("prepared_capability_closed");
  return state;
}

function assertArchiveProofBinding(state: PreparedState): void {
  if (state.inspected.archiveValidation.proof !== state.archiveProof) {
    throw readerError("archive_proof_identity_changed");
  }
  const projection = readLearningExternalEvidenceArchiveProofV1(state.archiveProof);
  const tracking = state.inspected.tracking;
  if (projection.raw_archive_sha256 !== tracking.raw_archive_sha256
    || projection.raw_archive_byte_length !== tracking.raw_archive_byte_length
    || projection.run_bundle_manifest_sha256 !== tracking.run_bundle_manifest_sha256
    || projection.public_run_authority_sha256 !== tracking.public_run_authority_sha256
    || projection.evidence_binding_sha256 !== tracking.evidence_binding_sha256) {
    throw readerError("archive_proof_projection_mismatch");
  }
}

export function prepareLiteLearningExternalEvidenceArchive(args: Readonly<{
  archivePath: string;
  publicRunAuthorityPath: string;
}>): PreparedLiteLearningExternalEvidenceArchive {
  let archive: PinnedInputFile | null = null;
  let publicRunAuthority: PinnedInputFile | null = null;
  try {
    archive = openPinnedInputFile(args.archivePath, "archive");
    publicRunAuthority = openPinnedInputFile(
      args.publicRunAuthorityPath,
      "public_run_authority",
    );
    if (archive.identity.dev === publicRunAuthority.identity.dev
      && archive.identity.ino === publicRunAuthority.identity.ino) {
      throw readerError("archive_and_public_authority_must_be_distinct_files");
    }

    const archiveRepositoryRoot = repositoryRootFor(archive.requestedPath, "archive");
    const publicRepositoryRoot = repositoryRootFor(
      publicRunAuthority.requestedPath,
      "public_run_authority",
    );
    if (archiveRepositoryRoot !== publicRepositoryRoot) {
      throw readerError("inputs_must_share_repository");
    }
    const initialGitLayout = discoverGitRepositoryLayout(archiveRepositoryRoot);
    const initialGitTrust = captureGitTrustSnapshot(
      initialGitLayout,
      archive.requestedPath,
      publicRunAuthority.requestedPath,
    );
    assertSafeLocalGitConfig(archiveRepositoryRoot);
    const gitLayout = discoverGitRepositoryLayout(archiveRepositoryRoot);
    if (!sameGitRepositoryLayout(initialGitLayout, gitLayout)) {
      throw gitTrustError("git_layout_changed_during_inspection");
    }
    const format = objectFormat(archiveRepositoryRoot);
    const fixedHead = headCommit(archiveRepositoryRoot, format);
    const archivePath = repositoryRelativePath(
      archiveRepositoryRoot,
      archive.requestedPath,
    );
    const publicPath = repositoryRelativePath(
      archiveRepositoryRoot,
      publicRunAuthority.requestedPath,
    );

    const archiveAtHead = treeEntry(
      archiveRepositoryRoot,
      fixedHead,
      archivePath,
      format,
    );
    const publicAtHead = treeEntry(
      archiveRepositoryRoot,
      fixedHead,
      publicPath,
      format,
    );
    const stableBundleCommit = bundleCommit(
      archiveRepositoryRoot,
      fixedHead,
      archivePath,
      publicPath,
      format,
    );
    const archiveAtBundle = treeEntry(
      archiveRepositoryRoot,
      stableBundleCommit,
      archivePath,
      format,
    );
    const publicAtBundle = treeEntry(
      archiveRepositoryRoot,
      stableBundleCommit,
      publicPath,
      format,
    );
    if (archiveAtBundle.objectId !== archiveAtHead.objectId
      || publicAtBundle.objectId !== publicAtHead.objectId) {
      throw readerError("bundle_files_changed_after_bundle_commit");
    }

    const streamedArchive = streamArchive(archive, format);
    const streamedPublic = streamPublicRunAuthority(publicRunAuthority, format);
    if (streamedArchive.blobObjectId !== archiveAtHead.objectId
      || streamedPublic.blobObjectId !== publicAtHead.objectId) {
      throw readerError("worktree_bytes_do_not_match_head");
    }

    const parsedPublic = parseCanonicalLearningExternalPublicRunAuthorityJson(
      streamedPublic.bytes,
    );
    const archiveValidation = deepFreeze(streamedArchive.validation);
    const archiveProof = archiveValidation.proof;
    const archiveProofProjection = readLearningExternalEvidenceArchiveProofV1(
      archiveProof,
    );
    const publicMember = archiveValidation.contracts.runBundle.members.find(
      (member) => member.role === "public_run_authority",
    );
    const archivePublicBytes = Buffer.from(
      stableStringify(archiveValidation.publicRunAuthority),
      "utf8",
    );
    if (!publicMember
      || publicMember.byte_length !== streamedPublic.bytes.byteLength
      || publicMember.sha256 !== streamedPublic.sha256
      || archiveProofProjection.public_run_authority_sha256 !== streamedPublic.sha256
      || learningExternalPublicRunAuthorityDigest(parsedPublic) !== streamedPublic.sha256
      || !archivePublicBytes.equals(streamedPublic.bytes)
      || stableStringify(parsedPublic)
        !== stableStringify(archiveValidation.publicRunAuthority)) {
      throw readerError("public_run_authority_archive_mismatch");
    }

    const tracking = deepFreeze<LiteLearningExternalEvidenceArchiveTrackingV1>({
      contract_version: "aionis_learning_external_evidence_archive_tracking_v1",
      object_format: format,
      verified_head_commit_id: fixedHead,
      bundle_commit_id: stableBundleCommit,
      archive_repo_relative_path: archivePath,
      archive_blob_oid: archiveAtHead.objectId,
      public_run_authority_repo_relative_path: publicPath,
      public_run_authority_blob_oid: publicAtHead.objectId,
      raw_archive_sha256: archiveValidation.rawArchiveSha256,
      raw_archive_byte_length: archiveValidation.rawArchiveByteLength,
      public_run_authority_sha256: streamedPublic.sha256,
      public_run_authority_byte_length: streamedPublic.bytes.byteLength,
      run_bundle_manifest_sha256: archiveValidation.runBundleManifestSha256,
      evidence_binding_sha256:
        archiveValidation.contracts.runBundle.evidence_binding_sha256,
    });
    const inspected = deepFreeze<InspectedPreparedLiteLearningExternalEvidenceArchive>({
      archiveValidation,
      tracking,
    });
    assertGitTrustSnapshotStable(
      initialGitTrust,
      captureGitTrustSnapshot(
        gitLayout,
        archive.requestedPath,
        publicRunAuthority.requestedPath,
      ),
    );
    const capability = Object.freeze(Object.create(null)) as
      PreparedLiteLearningExternalEvidenceArchive;
    const state: PreparedState = {
      archive,
      publicRunAuthority,
      repositoryRoot: archiveRepositoryRoot,
      gitLayout,
      archiveProof,
      inspected,
      closed: false,
    };
    preparedRegistry.set(capability, state);
    assertArchiveProofBinding(state);
    assertPreparedLiteLearningExternalEvidenceArchivePinned(capability);
    return capability;
  } catch (error) {
    if (publicRunAuthority) closeSync(publicRunAuthority.descriptor);
    if (archive) closeSync(archive.descriptor);
    throw error;
  }
}

export function inspectPreparedLiteLearningExternalEvidenceArchive(
  prepared: PreparedLiteLearningExternalEvidenceArchive,
): InspectedPreparedLiteLearningExternalEvidenceArchive {
  const state = preparedState(prepared);
  assertArchiveProofBinding(state);
  return state.inspected;
}

export function assertPreparedLiteLearningExternalEvidenceArchivePinned(
  prepared: PreparedLiteLearningExternalEvidenceArchive,
  options: Readonly<{ verifyHead?: boolean }> = {},
): void {
  const state = preparedState(prepared);
  assertArchiveProofBinding(state);
  assertPinnedFile(state.archive, "archive");
  assertPinnedFile(state.publicRunAuthority, "public_run_authority");
  // Files owned by the service UID can still be changed by another same-UID
  // process; that process is explicitly part of this local service TCB. The
  // boundary below excludes delegated group/other/ACL writers and pins every
  // inspected Git control/object path across the Git query itself.
  const before = captureGitTrustSnapshot(
    state.gitLayout,
    state.archive.requestedPath,
    state.publicRunAuthority.requestedPath,
  );
  assertSafeLocalGitConfig(state.repositoryRoot);
  const currentLayout = discoverGitRepositoryLayout(state.repositoryRoot);
  if (!sameGitRepositoryLayout(state.gitLayout, currentLayout)) {
    throw gitTrustError("git_layout_changed");
  }
  if (options.verifyHead !== false) {
    const format = state.inspected.tracking.object_format;
    const currentHead = headCommit(state.repositoryRoot, format);
    if (currentHead !== state.inspected.tracking.verified_head_commit_id) {
      throw readerError("git_head_changed");
    }
  }
  assertGitTrustSnapshotStable(
    before,
    captureGitTrustSnapshot(
      currentLayout,
      state.archive.requestedPath,
      state.publicRunAuthority.requestedPath,
    ),
  );
}

export function closePreparedLiteLearningExternalEvidenceArchive(
  prepared: PreparedLiteLearningExternalEvidenceArchive,
): void {
  if ((typeof prepared !== "object" && typeof prepared !== "function")
    || prepared === null) {
    throw readerError("unrecognized_prepared_capability");
  }
  const state = preparedRegistry.get(prepared);
  if (!state) throw readerError("unrecognized_prepared_capability");
  if (state.closed) return;
  state.closed = true;
  let firstError: unknown = null;
  try {
    closeSync(state.publicRunAuthority.descriptor);
  } catch (error) {
    firstError = error;
  }
  try {
    closeSync(state.archive.descriptor);
  } catch (error) {
    if (firstError === null) firstError = error;
  }
  if (firstError !== null) throw firstError;
}
