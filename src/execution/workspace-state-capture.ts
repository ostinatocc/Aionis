import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import stableStringify from "fast-json-stable-stringify";

export const WORKSPACE_STATE_CAPTURE_ALGORITHM_ID =
  "aionis_workspace_state_capture";
export const WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION = "3";
export const WORKSPACE_STATE_CAPTURE_MEDIA_TYPE =
  "application/vnd.aionis.workspace-state-snapshot.v1+json";

const MAX_EVIDENCE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_INLINE_EVIDENCE_ARTIFACT_BYTES = 256 * 1024;
const MAX_EXPANDED_EVIDENCE_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_GIT_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_GIT_CONTROL_FILE_BYTES = 1024 * 1024;
const MAX_WORKSPACE_ROOT_BYTES = 4 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 30_000;

export type WorkspaceStateCaptureLimitsV1 = {
  max_entries: number;
  max_path_bytes: number;
  max_total_path_bytes: number;
  max_file_bytes: number;
  max_total_content_bytes: number;
  max_artifact_bytes: number;
};

export type WorkspaceStateCaptureOptions = {
  workspace_root: string;
  limits?: Partial<WorkspaceStateCaptureLimitsV1>;
  subject_state_spec?: WorkspaceSubjectStateSpecV2;
};

export type WorkspaceSubjectStateSpecV2 = {
  contract_version: "workspace_subject_state_spec_v2";
  /**
   * Git state always includes HEAD/index paths plus ordinary non-ignored
   * untracked paths. Any ignored deliverable that a verifier may inspect must
   * be named explicitly here; no task-specific ignore heuristic is applied.
   */
  additional_state_roots: string[];
};

export type WorkspaceStateGitHeadEntryV1 = {
  mode: string;
  object_type: "blob";
  object_id: string;
};

export type WorkspaceStateGitIndexEntryV1 = {
  mode: string;
  object_id: string;
  stage: 0 | 1 | 2 | 3;
};

export type WorkspaceStateWorkingTreeEntryV1 =
  | {
      kind: "regular_file";
      mode_octal: string;
      byte_length: number;
      sha256: string;
      git_blob_oid: string | null;
      content_base64: string;
    }
  | {
      kind: "symbolic_link";
      mode_octal: string;
      byte_length: number;
      sha256: string;
      git_blob_oid: string | null;
      target_base64: string;
    }
  | {
      kind: "directory";
      mode_octal: string;
    }
  | {
      kind: "absent";
    };

export type WorkspaceStateEntryV1 = {
  path: string;
  git_head: WorkspaceStateGitHeadEntryV1 | null;
  git_index: WorkspaceStateGitIndexEntryV1[];
  working_tree: WorkspaceStateWorkingTreeEntryV1;
};

export type WorkspaceStateGitControlFileV1 =
  | {
      name: "info/exclude" | "info/sparse-checkout";
      state: "absent";
    }
  | {
      name: "info/exclude" | "info/sparse-checkout";
      state: "regular_file";
      byte_length: number;
      sha256: string;
      content_base64: string;
    };

export type WorkspaceStateCaptureManifestV1 = {
  contract_version: "workspace_state_capture_manifest_v1";
  algorithm_id: typeof WORKSPACE_STATE_CAPTURE_ALGORITHM_ID;
  algorithm_version: typeof WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION;
  workspace_kind: "git" | "filesystem";
  capture_policy: {
    path_encoding: "utf8_posix_relative_v1";
    ordering: "ascending_unsigned_utf8_bytes_v1";
    content: "regular_file_and_symlink_target_bytes_v1";
    metadata: "file_kind_and_permission_mode_v1";
    timestamps: "excluded_v1";
    symlinks: "record_target_without_following_v1";
    special_files: "reject_v1";
    stability: "two_consecutive_equal_captures_v1";
    git_untracked_ignore_policy:
      | "repository_standard_excludes_global_and_system_disabled_v1"
      | "not_applicable";
    non_git_ignore_policy:
      | "include_all_except_root_git_control_entry_v1"
      | "not_applicable";
    subject_state_spec: WorkspaceSubjectStateSpecV2;
    limits: WorkspaceStateCaptureLimitsV1;
  };
  repository: {
    object_format: "sha1" | "sha256";
    head_commit: string | null;
    head_tree: string | null;
    control_files: WorkspaceStateGitControlFileV1[];
  } | null;
  entries: WorkspaceStateEntryV1[];
  summary: {
    entry_count: number;
    regular_file_count: number;
    symbolic_link_count: number;
    directory_count: number;
    absent_count: number;
    git_head_path_count: number;
    git_index_path_count: number;
    working_tree_path_count: number;
    total_working_tree_bytes: number;
  };
};

export type WorkspaceStateCaptureArtifactV1 = {
  kind: "state_snapshot";
  bytes: Buffer;
  declared_sha256: string;
  declared_byte_length: number;
  media_type: typeof WORKSPACE_STATE_CAPTURE_MEDIA_TYPE;
  encoding: "utf-8" | "gzip";
  ingest_mode:
    | "bounded_inline_base64"
    | "finalized_runtime_upload_required";
};

export type WorkspaceStateCaptureResultV1 = {
  contract_version: "workspace_state_capture_result_v1";
  algorithm_id: typeof WORKSPACE_STATE_CAPTURE_ALGORITHM_ID;
  algorithm_version: typeof WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION;
  state_kind: "workspace";
  workspace_kind: "git" | "filesystem";
  workspace_root: string;
  repository_root: string | null;
  content_digest: string;
  environment_digest: string;
  manifest: WorkspaceStateCaptureManifestV1;
  artifact: WorkspaceStateCaptureArtifactV1;
  metadata: {
    git_version: string | null;
    object_format: "sha1" | "sha256" | null;
    entry_count: number;
    total_working_tree_bytes: number;
  };
};

export class WorkspaceStateCaptureError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = "WorkspaceStateCaptureError";
    this.code = code;
  }
}

const DEFAULT_LIMITS: WorkspaceStateCaptureLimitsV1 = Object.freeze({
  max_entries: 50_000,
  max_path_bytes: 4 * 1024,
  max_total_path_bytes: 8 * 1024 * 1024,
  max_file_bytes: 16 * 1024 * 1024,
  max_total_content_bytes: 128 * 1024 * 1024,
  max_artifact_bytes: MAX_EVIDENCE_ARTIFACT_BYTES,
});

const HARD_LIMITS: WorkspaceStateCaptureLimitsV1 = Object.freeze({
  max_entries: 200_000,
  max_path_bytes: 16 * 1024,
  max_total_path_bytes: 32 * 1024 * 1024,
  max_file_bytes: 48 * 1024 * 1024,
  max_total_content_bytes: 128 * 1024 * 1024,
  max_artifact_bytes: MAX_EVIDENCE_ARTIFACT_BYTES,
});

type GitCommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  error: Error | undefined;
};

type GitCaptureContext = {
  root: string;
  gitVersion: string;
  objectFormat: "sha1" | "sha256";
};

type GitPassMaterial = {
  headCommit: string | null;
  headTree: string | null;
  headByPath: Map<string, WorkspaceStateGitHeadEntryV1>;
  indexByPath: Map<string, WorkspaceStateGitIndexEntryV1[]>;
  worktreePaths: Set<string>;
  controlFiles: WorkspaceStateGitControlFileV1[];
};

type WorkingTreeCapture = {
  entry: WorkspaceStateWorkingTreeEntryV1;
  bytes: number;
};

function fail(code: string, detail?: string): never {
  throw new WorkspaceStateCaptureError(code, detail);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return sha256Bytes(Buffer.from(stableStringify(value), "utf8"));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function strictUtf8(bytes: Buffer, label: string): string {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(decoded, "utf8").equals(bytes)) {
      fail("workspace_state_capture_noncanonical_utf8", label);
    }
    return decoded;
  } catch (error) {
    if (error instanceof WorkspaceStateCaptureError) throw error;
    fail("workspace_state_capture_invalid_utf8", label);
  }
}

function trimOneLine(bytes: Buffer, label: string): string {
  const value = strictUtf8(bytes, label).replace(/\r?\n$/u, "");
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
    fail("workspace_state_capture_invalid_git_text", label);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: keyof WorkspaceStateCaptureLimitsV1,
  hardMaximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > hardMaximum
  ) {
    fail(
      "workspace_state_capture_invalid_limit",
      `${label} must be a positive safe integer at most ${hardMaximum}`,
    );
  }
  return value;
}

function canonicalLimits(
  input: Partial<WorkspaceStateCaptureLimitsV1> | undefined,
): WorkspaceStateCaptureLimitsV1 {
  const merged = {
    ...DEFAULT_LIMITS,
    ...(input ?? {}),
  };
  const limits: WorkspaceStateCaptureLimitsV1 = {
    max_entries: boundedInteger(
      merged.max_entries,
      "max_entries",
      HARD_LIMITS.max_entries,
    ),
    max_path_bytes: boundedInteger(
      merged.max_path_bytes,
      "max_path_bytes",
      HARD_LIMITS.max_path_bytes,
    ),
    max_total_path_bytes: boundedInteger(
      merged.max_total_path_bytes,
      "max_total_path_bytes",
      HARD_LIMITS.max_total_path_bytes,
    ),
    max_file_bytes: boundedInteger(
      merged.max_file_bytes,
      "max_file_bytes",
      HARD_LIMITS.max_file_bytes,
    ),
    max_total_content_bytes: boundedInteger(
      merged.max_total_content_bytes,
      "max_total_content_bytes",
      HARD_LIMITS.max_total_content_bytes,
    ),
    max_artifact_bytes: boundedInteger(
      merged.max_artifact_bytes,
      "max_artifact_bytes",
      HARD_LIMITS.max_artifact_bytes,
    ),
  };
  if (limits.max_file_bytes > limits.max_total_content_bytes) {
    fail(
      "workspace_state_capture_invalid_limit",
      "max_file_bytes cannot exceed max_total_content_bytes",
    );
  }
  return limits;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const key of ["PATH", "SystemRoot", "ComSpec", "PATHEXT"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function rawGit(
  cwd: string,
  args: readonly string[],
  maxOutputBytes = MAX_GIT_COMMAND_OUTPUT_BYTES,
): GitCommandResult {
  const result = spawnSync(
    "git",
    [
      "--literal-pathspecs",
      "-c",
      "core.excludesFile=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "buffer",
      env: gitEnvironment(),
      maxBuffer: maxOutputBytes,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_COMMAND_TIMEOUT_MS,
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: Buffer.from(result.stdout ?? []),
    stderr: Buffer.from(result.stderr ?? []),
    error: result.error,
  };
}

function gitFailureDetail(result: GitCommandResult): string {
  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    return `${error.code ?? error.name}:${error.message}`;
  }
  if (result.signal !== null) return `signal=${result.signal}`;
  return strictUtf8(
    result.stderr.subarray(0, 8 * 1024),
    "git stderr",
  ).trim();
}

function git(
  context: Pick<GitCaptureContext, "root">,
  args: readonly string[],
  options: {
    acceptedStatuses?: readonly number[];
    maxOutputBytes?: number;
  } = {},
): GitCommandResult {
  const result = rawGit(
    context.root,
    args,
    options.maxOutputBytes ?? MAX_GIT_COMMAND_OUTPUT_BYTES,
  );
  const acceptedStatuses = options.acceptedStatuses ?? [0];
  if (
    result.error !== undefined
    || result.signal !== null
    || result.status === null
    || !acceptedStatuses.includes(result.status)
  ) {
    fail(
      "workspace_state_capture_git_command_failed",
      `${args.join(" ")}:${gitFailureDetail(result)}`,
    );
  }
  return result;
}

function inspectGitContext(workspaceRoot: string): GitCaptureContext | null {
  const discovery = rawGit(
    workspaceRoot,
    ["rev-parse", "--show-toplevel"],
    1024 * 1024,
  );
  if (discovery.error !== undefined) {
    const error = discovery.error as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      try {
        lstatSync(join(workspaceRoot, ".git"));
        fail("workspace_state_capture_git_unavailable_for_repository");
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw statError;
        }
        return null;
      }
    }
    fail(
      "workspace_state_capture_git_discovery_failed",
      gitFailureDetail(discovery),
    );
  }
  if (discovery.signal !== null || discovery.status === null) {
    fail(
      "workspace_state_capture_git_discovery_failed",
      gitFailureDetail(discovery),
    );
  }
  if (discovery.status !== 0) {
    const stderr = strictUtf8(discovery.stderr, "git discovery stderr");
    if (/not a git repository/iu.test(stderr)) return null;
    fail("workspace_state_capture_git_discovery_failed", stderr.trim());
  }

  const discoveredRoot = trimOneLine(discovery.stdout, "git top-level");
  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync.native(discoveredRoot);
  } catch (error) {
    fail(
      "workspace_state_capture_git_root_unresolvable",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (repositoryRoot !== workspaceRoot) {
    fail(
      "workspace_state_capture_requires_git_toplevel",
      `${workspaceRoot}!=${repositoryRoot}`,
    );
  }
  const base = { root: repositoryRoot };
  const objectFormatText = trimOneLine(
    git(base, ["rev-parse", "--show-object-format"], {
      maxOutputBytes: 1024,
    }).stdout,
    "git object format",
  );
  if (objectFormatText !== "sha1" && objectFormatText !== "sha256") {
    fail("workspace_state_capture_unsupported_git_object_format", objectFormatText);
  }
  const gitVersion = trimOneLine(
    git(base, ["--version"], { maxOutputBytes: 1024 }).stdout,
    "git version",
  );
  return {
    root: repositoryRoot,
    gitVersion,
    objectFormat: objectFormatText,
  };
}

function splitNullRecords(bytes: Buffer, label: string): Buffer[] {
  if (bytes.byteLength === 0) return [];
  if (bytes.at(-1) !== 0) {
    fail("workspace_state_capture_invalid_git_nul_stream", label);
  }
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) {
      fail("workspace_state_capture_empty_git_record", label);
    }
    records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function canonicalRelativePath(
  rawPath: Buffer | string,
  limits: WorkspaceStateCaptureLimitsV1,
): string {
  const value = typeof rawPath === "string"
    ? rawPath
    : strictUtf8(rawPath, "workspace relative path");
  const bytes = Buffer.from(value, "utf8");
  if (
    value.length === 0
    || value.includes("\u0000")
    || value.startsWith("/")
    || value.endsWith("/")
    || bytes.byteLength > limits.max_path_bytes
  ) {
    fail("workspace_state_capture_invalid_relative_path", value);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("workspace_state_capture_invalid_relative_path", value);
  }
  if (process.platform === "win32" && value.includes("\\")) {
    fail("workspace_state_capture_unsupported_windows_path", value);
  }
  return value;
}

function canonicalSubjectStateSpec(
  input: WorkspaceSubjectStateSpecV2 | undefined,
  limits: WorkspaceStateCaptureLimitsV1,
): WorkspaceSubjectStateSpecV2 {
  const candidate = input ?? {
    contract_version: "workspace_subject_state_spec_v2",
    additional_state_roots: [],
  };
  if (
    candidate === null
    || typeof candidate !== "object"
    || Array.isArray(candidate)
    || Object.getPrototypeOf(candidate) !== Object.prototype
    || Object.getOwnPropertySymbols(candidate).length !== 0
  ) {
    fail("workspace_state_capture_subject_state_spec_invalid");
  }
  const keys = Object.keys(candidate);
  if (
    keys.some((key) =>
      key !== "contract_version" && key !== "additional_state_roots")
    || candidate.contract_version !== "workspace_subject_state_spec_v2"
    || !Array.isArray(candidate.additional_state_roots)
    || candidate.additional_state_roots.length > 256
  ) {
    fail("workspace_state_capture_subject_state_spec_invalid");
  }
  const roots = candidate.additional_state_roots.map((root) =>
    canonicalRelativePath(root, limits));
  if (
    roots.some((root) => root === ".git" || root.startsWith(".git/"))
  ) {
    fail("workspace_state_capture_subject_state_root_git_forbidden");
  }
  roots.sort(compareUtf8);
  if (roots.some((root, index) => index > 0 && roots[index - 1] === root)) {
    fail("workspace_state_capture_subject_state_root_duplicate");
  }
  return {
    contract_version: "workspace_subject_state_spec_v2",
    additional_state_roots: roots,
  };
}

function assertObjectId(
  value: string,
  objectFormat: "sha1" | "sha256",
  options: { allowZero?: boolean } = {},
): void {
  const expectedLength = objectFormat === "sha1" ? 40 : 64;
  if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`, "u").test(value)) {
    fail("workspace_state_capture_invalid_git_object_id", value);
  }
  if (!options.allowZero && /^0+$/u.test(value)) {
    fail("workspace_state_capture_zero_git_object_id", value);
  }
}

function parseHeadEntries(
  bytes: Buffer,
  objectFormat: "sha1" | "sha256",
  limits: WorkspaceStateCaptureLimitsV1,
): Map<string, WorkspaceStateGitHeadEntryV1> {
  const entries = new Map<string, WorkspaceStateGitHeadEntryV1>();
  for (const record of splitNullRecords(bytes, "git ls-tree")) {
    const separator = record.indexOf(0x09);
    if (separator <= 0) {
      fail("workspace_state_capture_invalid_git_tree_record");
    }
    const metadata = strictUtf8(
      record.subarray(0, separator),
      "git tree metadata",
    ).split(" ");
    if (metadata.length !== 3) {
      fail("workspace_state_capture_invalid_git_tree_record");
    }
    const [mode, objectType, objectId] = metadata;
    if (mode === undefined || objectType === undefined || objectId === undefined) {
      fail("workspace_state_capture_invalid_git_tree_record");
    }
    if (objectType === "commit" || mode === "160000") {
      fail(
        "workspace_state_capture_gitlink_unsupported",
        strictUtf8(record.subarray(separator + 1), "gitlink path"),
      );
    }
    if (
      objectType !== "blob"
      || !/^(?:100644|100755|120000)$/u.test(mode)
    ) {
      fail(
        "workspace_state_capture_unsupported_git_tree_entry",
        `${mode}:${objectType}`,
      );
    }
    assertObjectId(objectId, objectFormat);
    const path = canonicalRelativePath(
      record.subarray(separator + 1),
      limits,
    );
    if (entries.has(path)) {
      fail("workspace_state_capture_duplicate_git_tree_path", path);
    }
    entries.set(path, {
      mode,
      object_type: "blob",
      object_id: objectId,
    });
  }
  return entries;
}

function parseIndexEntries(
  bytes: Buffer,
  objectFormat: "sha1" | "sha256",
  limits: WorkspaceStateCaptureLimitsV1,
): Map<string, WorkspaceStateGitIndexEntryV1[]> {
  const entries = new Map<string, WorkspaceStateGitIndexEntryV1[]>();
  for (const record of splitNullRecords(bytes, "git ls-files --stage")) {
    const separator = record.indexOf(0x09);
    if (separator <= 0) {
      fail("workspace_state_capture_invalid_git_index_record");
    }
    const metadata = strictUtf8(
      record.subarray(0, separator),
      "git index metadata",
    ).split(" ");
    if (metadata.length !== 3) {
      fail("workspace_state_capture_invalid_git_index_record");
    }
    const [mode, objectId, rawStage] = metadata;
    if (mode === undefined || objectId === undefined || rawStage === undefined) {
      fail("workspace_state_capture_invalid_git_index_record");
    }
    if (mode === "160000") {
      fail(
        "workspace_state_capture_gitlink_unsupported",
        strictUtf8(record.subarray(separator + 1), "gitlink path"),
      );
    }
    if (!/^(?:100644|100755|120000)$/u.test(mode)) {
      fail("workspace_state_capture_unsupported_git_index_mode", mode);
    }
    assertObjectId(objectId, objectFormat, { allowZero: true });
    const stage = Number.parseInt(rawStage, 10);
    if (stage !== 0 && stage !== 1 && stage !== 2 && stage !== 3) {
      fail("workspace_state_capture_invalid_git_index_stage", rawStage);
    }
    const path = canonicalRelativePath(
      record.subarray(separator + 1),
      limits,
    );
    const existing = entries.get(path) ?? [];
    if (existing.some((entry) => entry.stage === stage)) {
      fail(
        "workspace_state_capture_duplicate_git_index_stage",
        `${path}:${stage}`,
      );
    }
    existing.push({
      mode,
      object_id: objectId,
      stage,
    });
    existing.sort((left, right) => left.stage - right.stage);
    entries.set(path, existing);
  }
  return entries;
}

function parseWorktreePaths(
  bytes: Buffer,
  limits: WorkspaceStateCaptureLimitsV1,
): Set<string> {
  const paths = new Set<string>();
  for (const record of splitNullRecords(bytes, "git ls-files worktree")) {
    const path = canonicalRelativePath(record, limits);
    if (paths.has(path)) {
      fail("workspace_state_capture_duplicate_git_worktree_path", path);
    }
    paths.add(path);
  }
  return paths;
}

function tryLstat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameFileState(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function permissionMode(stats: BigIntStats): string {
  return (stats.mode & 0o7777n).toString(8).padStart(4, "0");
}

function gitBlobOid(
  bytes: Uint8Array,
  objectFormat: "sha1" | "sha256" | null,
): string | null {
  if (objectFormat === null) return null;
  const header = Buffer.from(`blob ${bytes.byteLength}\u0000`, "utf8");
  return createHash(objectFormat).update(header).update(bytes).digest("hex");
}

function readStableRegularFile(
  absolutePath: string,
  relativePath: string,
  before: BigIntStats,
  limits: WorkspaceStateCaptureLimitsV1,
  objectFormat: "sha1" | "sha256" | null,
): WorkingTreeCapture {
  if (before.size > BigInt(limits.max_file_bytes)) {
    fail(
      "workspace_state_capture_file_limit_exceeded",
      `${relativePath}:${before.size}`,
    );
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileState(before, opened)) {
      fail("workspace_state_capture_file_changed_during_open", relativePath);
    }
    const bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(absolutePath, { bigint: true });
    if (
      bytes.byteLength !== Number(opened.size)
      || !sameFileState(opened, afterRead)
      || !sameFileState(opened, afterPath)
    ) {
      fail("workspace_state_capture_file_changed_during_read", relativePath);
    }
    return {
      bytes: bytes.byteLength,
      entry: {
        kind: "regular_file",
        mode_octal: permissionMode(opened),
        byte_length: bytes.byteLength,
        sha256: sha256Bytes(bytes),
        git_blob_oid: gitBlobOid(bytes, objectFormat),
        content_base64: bytes.toString("base64"),
      },
    };
  } catch (error) {
    if (error instanceof WorkspaceStateCaptureError) throw error;
    fail(
      "workspace_state_capture_file_read_failed",
      `${relativePath}:${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  fail("workspace_state_capture_file_read_failed", relativePath);
}

function readStableSymbolicLink(
  absolutePath: string,
  relativePath: string,
  before: BigIntStats,
  limits: WorkspaceStateCaptureLimitsV1,
  objectFormat: "sha1" | "sha256" | null,
): WorkingTreeCapture {
  let target: Buffer;
  try {
    target = readlinkSync(absolutePath, { encoding: "buffer" });
  } catch (error) {
    fail(
      "workspace_state_capture_symlink_read_failed",
      `${relativePath}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (target.byteLength > limits.max_file_bytes) {
    fail(
      "workspace_state_capture_file_limit_exceeded",
      `${relativePath}:${target.byteLength}`,
    );
  }
  let after: BigIntStats;
  try {
    after = lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    fail(
      "workspace_state_capture_symlink_changed_during_read",
      `${relativePath}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!after.isSymbolicLink() || !sameFileState(before, after)) {
    fail("workspace_state_capture_symlink_changed_during_read", relativePath);
  }
  return {
    bytes: target.byteLength,
    entry: {
      kind: "symbolic_link",
      mode_octal: permissionMode(after),
      byte_length: target.byteLength,
      sha256: sha256Bytes(target),
      git_blob_oid: gitBlobOid(target, objectFormat),
      target_base64: target.toString("base64"),
    },
  };
}

type WorkspacePathAncestor = {
  path: string;
  stats: BigIntStats;
};

function captureWorkspacePathAncestors(
  root: string,
  relativePath: string,
): WorkspacePathAncestor[] | null {
  const segments = relativePath.split("/");
  const ancestors: WorkspacePathAncestor[] = [];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stats = tryLstat(current);
    if (stats === null) return null;
    if (stats.isSymbolicLink()) {
      fail(
        "workspace_state_capture_symlink_ancestor_rejected",
        relativePath,
      );
    }
    if (!stats.isDirectory()) {
      fail(
        "workspace_state_capture_non_directory_ancestor_rejected",
        relativePath,
      );
    }
    ancestors.push({ path: current, stats });
  }
  return ancestors;
}

function assertWorkspacePathAncestorsUnchanged(
  relativePath: string,
  ancestors: readonly WorkspacePathAncestor[],
): void {
  for (const ancestor of ancestors) {
    const after = tryLstat(ancestor.path);
    if (
      after === null
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !sameFileState(ancestor.stats, after)
    ) {
      fail(
        "workspace_state_capture_ancestor_changed_during_read",
        relativePath,
      );
    }
  }
}

function readWorkingTreeEntry(
  root: string,
  relativePath: string,
  limits: WorkspaceStateCaptureLimitsV1,
  objectFormat: "sha1" | "sha256" | null,
): WorkingTreeCapture {
  const absolutePath = join(root, ...relativePath.split("/"));
  const ancestors = captureWorkspacePathAncestors(root, relativePath);
  if (ancestors === null) {
    return {
      bytes: 0,
      entry: { kind: "absent" },
    };
  }
  const before = (() => {
    try {
      return tryLstat(absolutePath);
    } catch (error) {
      fail(
        "workspace_state_capture_lstat_failed",
        `${relativePath}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  if (before === null) {
    return {
      bytes: 0,
      entry: { kind: "absent" },
    };
  }
  if (before.isFile()) {
    const capture = readStableRegularFile(
      absolutePath,
      relativePath,
      before,
      limits,
      objectFormat,
    );
    assertWorkspacePathAncestorsUnchanged(relativePath, ancestors);
    return capture;
  }
  if (before.isSymbolicLink()) {
    const capture = readStableSymbolicLink(
      absolutePath,
      relativePath,
      before,
      limits,
      objectFormat,
    );
    assertWorkspacePathAncestorsUnchanged(relativePath, ancestors);
    return capture;
  }
  if (before.isDirectory()) {
    const after = lstatSync(absolutePath, { bigint: true });
    if (
      !after.isDirectory()
      || after.isSymbolicLink()
      || !sameFileState(before, after)
    ) {
      fail(
        "workspace_state_capture_directory_changed_during_read",
        relativePath,
      );
    }
    assertWorkspacePathAncestorsUnchanged(relativePath, ancestors);
    return {
      bytes: 0,
      entry: {
        kind: "directory",
        mode_octal: permissionMode(after),
      },
    };
  }
  fail(
    "workspace_state_capture_special_file_rejected",
    `${relativePath}:${before.mode.toString(8)}`,
  );
}

function readGitControlFile(
  context: GitCaptureContext,
  name: WorkspaceStateGitControlFileV1["name"],
): WorkspaceStateGitControlFileV1 {
  const gitPath = trimOneLine(
    git(context, ["rev-parse", "--git-path", name], {
      maxOutputBytes: MAX_WORKSPACE_ROOT_BYTES,
    }).stdout,
    `git path ${name}`,
  );
  const absolutePath = isAbsolute(gitPath)
    ? gitPath
    : resolve(context.root, gitPath);
  const before = tryLstat(absolutePath);
  if (before === null) return { name, state: "absent" };
  if (!before.isFile() || before.isSymbolicLink()) {
    fail("workspace_state_capture_git_control_file_invalid", name);
  }
  if (before.size > BigInt(MAX_GIT_CONTROL_FILE_BYTES)) {
    fail("workspace_state_capture_git_control_file_too_large", name);
  }
  const capture = readStableRegularFile(
    absolutePath,
    name,
    before,
    {
      ...DEFAULT_LIMITS,
      max_file_bytes: MAX_GIT_CONTROL_FILE_BYTES,
      max_total_content_bytes: MAX_GIT_CONTROL_FILE_BYTES,
    },
    null,
  );
  if (capture.entry.kind !== "regular_file") {
    fail("workspace_state_capture_git_control_file_invalid", name);
  }
  return {
    name,
    state: "regular_file",
    byte_length: capture.entry.byte_length,
    sha256: capture.entry.sha256,
    content_base64: capture.entry.content_base64,
  };
}

function optionalGitObject(
  context: GitCaptureContext,
  revision: string,
): string | null {
  const result = git(context, ["rev-parse", "--verify", "--quiet", revision], {
    acceptedStatuses: [0, 1],
    maxOutputBytes: 1024,
  });
  if (result.status !== 0) return null;
  const objectId = trimOneLine(result.stdout, revision);
  assertObjectId(objectId, context.objectFormat);
  return objectId;
}

function captureGitPassMaterial(
  context: GitCaptureContext,
  limits: WorkspaceStateCaptureLimitsV1,
): GitPassMaterial {
  const headCommit = optionalGitObject(context, "HEAD^{commit}");
  const headTree = headCommit === null
    ? null
    : optionalGitObject(context, "HEAD^{tree}");
  if ((headCommit === null) !== (headTree === null)) {
    fail("workspace_state_capture_git_head_tree_mismatch");
  }
  const headByPath = headCommit === null
    ? new Map<string, WorkspaceStateGitHeadEntryV1>()
    : parseHeadEntries(
        git(context, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]).stdout,
        context.objectFormat,
        limits,
      );
  const indexByPath = parseIndexEntries(
    git(context, ["ls-files", "--stage", "-z"]).stdout,
    context.objectFormat,
    limits,
  );
  const worktreePaths = parseWorktreePaths(
    git(context, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]).stdout,
    limits,
  );
  return {
    headCommit,
    headTree,
    headByPath,
    indexByPath,
    worktreePaths,
    controlFiles: [
      readGitControlFile(context, "info/exclude"),
      readGitControlFile(context, "info/sparse-checkout"),
    ],
  };
}

function assertPathBounds(
  paths: readonly string[],
  limits: WorkspaceStateCaptureLimitsV1,
): void {
  if (paths.length > limits.max_entries) {
    fail(
      "workspace_state_capture_entry_limit_exceeded",
      `${paths.length}>${limits.max_entries}`,
    );
  }
  let totalPathBytes = 0;
  for (const path of paths) {
    canonicalRelativePath(path, limits);
    totalPathBytes += Buffer.byteLength(path, "utf8");
    if (totalPathBytes > limits.max_total_path_bytes) {
      fail(
        "workspace_state_capture_path_bytes_limit_exceeded",
        `${totalPathBytes}>${limits.max_total_path_bytes}`,
      );
    }
  }
}

function captureEntries(
  root: string,
  paths: readonly string[],
  limits: WorkspaceStateCaptureLimitsV1,
  objectFormat: "sha1" | "sha256" | null,
  headByPath: ReadonlyMap<string, WorkspaceStateGitHeadEntryV1>,
  indexByPath: ReadonlyMap<string, WorkspaceStateGitIndexEntryV1[]>,
): {
  entries: WorkspaceStateEntryV1[];
  totalBytes: number;
} {
  assertPathBounds(paths, limits);
  const entries: WorkspaceStateEntryV1[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const workingTree = readWorkingTreeEntry(
      root,
      path,
      limits,
      objectFormat,
    );
    totalBytes += workingTree.bytes;
    if (totalBytes > limits.max_total_content_bytes) {
      fail(
        "workspace_state_capture_content_limit_exceeded",
        `${totalBytes}>${limits.max_total_content_bytes}`,
      );
    }
    entries.push({
      path,
      git_head: headByPath.get(path) ?? null,
      git_index: [...(indexByPath.get(path) ?? [])],
      working_tree: workingTree.entry,
    });
  }
  return { entries, totalBytes };
}

function summarizeEntries(
  entries: readonly WorkspaceStateEntryV1[],
  totalBytes: number,
): WorkspaceStateCaptureManifestV1["summary"] {
  let regularFileCount = 0;
  let symbolicLinkCount = 0;
  let directoryCount = 0;
  let absentCount = 0;
  let gitHeadPathCount = 0;
  let gitIndexPathCount = 0;
  let workingTreePathCount = 0;
  for (const entry of entries) {
    if (entry.git_head !== null) gitHeadPathCount += 1;
    if (entry.git_index.length > 0) gitIndexPathCount += 1;
    if (entry.working_tree.kind === "regular_file") regularFileCount += 1;
    if (entry.working_tree.kind === "symbolic_link") symbolicLinkCount += 1;
    if (entry.working_tree.kind === "directory") directoryCount += 1;
    if (entry.working_tree.kind === "absent") absentCount += 1;
    else workingTreePathCount += 1;
  }
  return {
    entry_count: entries.length,
    regular_file_count: regularFileCount,
    symbolic_link_count: symbolicLinkCount,
    directory_count: directoryCount,
    absent_count: absentCount,
    git_head_path_count: gitHeadPathCount,
    git_index_path_count: gitIndexPathCount,
    working_tree_path_count: workingTreePathCount,
    total_working_tree_bytes: totalBytes,
  };
}

function capturePolicy(
  workspaceKind: "git" | "filesystem",
  limits: WorkspaceStateCaptureLimitsV1,
  subjectStateSpec: WorkspaceSubjectStateSpecV2,
): WorkspaceStateCaptureManifestV1["capture_policy"] {
  return {
    path_encoding: "utf8_posix_relative_v1",
    ordering: "ascending_unsigned_utf8_bytes_v1",
    content: "regular_file_and_symlink_target_bytes_v1",
    metadata: "file_kind_and_permission_mode_v1",
    timestamps: "excluded_v1",
    symlinks: "record_target_without_following_v1",
    special_files: "reject_v1",
    stability: "two_consecutive_equal_captures_v1",
    git_untracked_ignore_policy: workspaceKind === "git"
      ? "repository_standard_excludes_global_and_system_disabled_v1"
      : "not_applicable",
    non_git_ignore_policy: workspaceKind === "filesystem"
      ? "include_all_except_root_git_control_entry_v1"
      : "not_applicable",
    subject_state_spec: subjectStateSpec,
    limits,
  };
}

function captureGitManifest(
  context: GitCaptureContext,
  limits: WorkspaceStateCaptureLimitsV1,
  subjectStateSpec: WorkspaceSubjectStateSpecV2,
): WorkspaceStateCaptureManifestV1 {
  const material = captureGitPassMaterial(context, limits);
  const additionalStatePaths = enumerateAdditionalStatePaths(
    context.root,
    subjectStateSpec,
    limits,
  );
  const paths = new Set<string>([
    ...material.headByPath.keys(),
    ...material.indexByPath.keys(),
    ...material.worktreePaths,
    ...additionalStatePaths,
  ]);
  for (const path of [...paths]) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      paths.add(segments.slice(0, index).join("/"));
    }
  }
  const sortedPaths = [...paths].sort(compareUtf8);
  const captured = captureEntries(
    context.root,
    sortedPaths,
    limits,
    context.objectFormat,
    material.headByPath,
    material.indexByPath,
  );
  return {
    contract_version: "workspace_state_capture_manifest_v1",
    algorithm_id: WORKSPACE_STATE_CAPTURE_ALGORITHM_ID,
    algorithm_version: WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION,
    workspace_kind: "git",
    capture_policy: capturePolicy("git", limits, subjectStateSpec),
    repository: {
      object_format: context.objectFormat,
      head_commit: material.headCommit,
      head_tree: material.headTree,
      control_files: material.controlFiles,
    },
    entries: captured.entries,
    summary: summarizeEntries(captured.entries, captured.totalBytes),
  };
}

function normalizedFilesystemRelativePath(root: string, path: string): string {
  const value = relative(root, path);
  return sep === "/" ? value : value.split(sep).join("/");
}

function enumerateAdditionalStatePaths(
  root: string,
  spec: WorkspaceSubjectStateSpecV2,
  limits: WorkspaceStateCaptureLimitsV1,
): string[] {
  const paths = new Set<string>();
  for (const declaredRoot of spec.additional_state_roots) {
    const ancestors = captureWorkspacePathAncestors(root, declaredRoot);
    if (ancestors === null) {
      paths.add(declaredRoot);
      continue;
    }
    const absoluteRoot = join(root, ...declaredRoot.split("/"));
    const rootStats = tryLstat(absoluteRoot);
    if (rootStats === null) {
      paths.add(declaredRoot);
      continue;
    }
    if (rootStats.isFile() || rootStats.isSymbolicLink()) {
      paths.add(declaredRoot);
      continue;
    }
    if (!rootStats.isDirectory()) {
      fail(
        "workspace_state_capture_special_file_rejected",
        `${declaredRoot}:${rootStats.mode.toString(8)}`,
      );
    }
    const directories = [absoluteRoot];
    paths.add(declaredRoot);
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory === undefined) break;
      const children = (() => {
        try {
          return readdirSync(directory, {
            encoding: "utf8",
            withFileTypes: true,
          });
        } catch (error) {
          fail(
            "workspace_state_capture_directory_read_failed",
            `${normalizedFilesystemRelativePath(root, directory)}:${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      })();
      children.sort((left, right) => compareUtf8(left.name, right.name));
      for (const child of children) {
        const absolutePath = join(directory, child.name);
        const relativePath = canonicalRelativePath(
          normalizedFilesystemRelativePath(root, absolutePath),
          limits,
        );
        const stats = (() => {
          try {
            return lstatSync(absolutePath, { bigint: true });
          } catch (error) {
            fail(
              "workspace_state_capture_lstat_failed",
              `${relativePath}:${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        })();
        if (
          !stats.isDirectory()
          && !stats.isFile()
          && !stats.isSymbolicLink()
        ) {
          fail(
            "workspace_state_capture_special_file_rejected",
            `${relativePath}:${stats.mode.toString(8)}`,
          );
        }
        paths.add(relativePath);
        if (paths.size > limits.max_entries) {
          fail(
            "workspace_state_capture_entry_limit_exceeded",
            `${paths.size}>${limits.max_entries}`,
          );
        }
        if (stats.isDirectory()) directories.push(absolutePath);
      }
    }
  }
  const sorted = [...paths].sort(compareUtf8);
  assertPathBounds(sorted, limits);
  return sorted;
}

function enumerateFilesystemPaths(
  root: string,
  limits: WorkspaceStateCaptureLimitsV1,
): string[] {
  const paths: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) break;
    const children = (() => {
      try {
        return readdirSync(directory, {
          encoding: "utf8",
          withFileTypes: true,
        });
      } catch (error) {
        fail(
          "workspace_state_capture_directory_read_failed",
          `${directory}:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    children.sort((left, right) => compareUtf8(left.name, right.name));
    for (const child of children) {
      if (directory === root && child.name === ".git") continue;
      const absolutePath = join(directory, child.name);
      const stats = (() => {
        try {
          return lstatSync(absolutePath, { bigint: true });
        } catch (error) {
          fail(
            "workspace_state_capture_lstat_failed",
            `${absolutePath}:${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
      const relativePath = canonicalRelativePath(
        normalizedFilesystemRelativePath(root, absolutePath),
        limits,
      );
      if (stats.isDirectory()) {
        paths.push(relativePath);
        if (paths.length > limits.max_entries) {
          fail(
            "workspace_state_capture_entry_limit_exceeded",
            `${paths.length}>${limits.max_entries}`,
          );
        }
        directories.push(absolutePath);
        continue;
      }
      if (!stats.isFile() && !stats.isSymbolicLink()) {
        fail(
          "workspace_state_capture_special_file_rejected",
          `${relativePath}:${stats.mode.toString(8)}`,
        );
      }
      paths.push(relativePath);
      if (paths.length > limits.max_entries) {
        fail(
          "workspace_state_capture_entry_limit_exceeded",
          `${paths.length}>${limits.max_entries}`,
        );
      }
    }
  }
  paths.sort(compareUtf8);
  assertPathBounds(paths, limits);
  return paths;
}

function captureFilesystemManifest(
  root: string,
  limits: WorkspaceStateCaptureLimitsV1,
  subjectStateSpec: WorkspaceSubjectStateSpecV2,
): WorkspaceStateCaptureManifestV1 {
  const paths = enumerateFilesystemPaths(root, limits);
  const captured = captureEntries(
    root,
    paths,
    limits,
    null,
    new Map(),
    new Map(),
  );
  return {
    contract_version: "workspace_state_capture_manifest_v1",
    algorithm_id: WORKSPACE_STATE_CAPTURE_ALGORITHM_ID,
    algorithm_version: WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION,
    workspace_kind: "filesystem",
    capture_policy: capturePolicy("filesystem", limits, subjectStateSpec),
    repository: null,
    entries: captured.entries,
    summary: summarizeEntries(captured.entries, captured.totalBytes),
  };
}

function canonicalManifestBytes(
  manifest: WorkspaceStateCaptureManifestV1,
): Buffer {
  const bytes = Buffer.from(stableStringify(manifest), "utf8");
  if (bytes.byteLength > MAX_EXPANDED_EVIDENCE_ARTIFACT_BYTES) {
    fail(
      "workspace_state_capture_expanded_artifact_limit_exceeded",
      `${bytes.byteLength}>${MAX_EXPANDED_EVIDENCE_ARTIFACT_BYTES}`,
    );
  }
  return bytes;
}

function encodeManifestArtifact(
  bytes: Buffer,
  limits: WorkspaceStateCaptureLimitsV1,
): Readonly<{ bytes: Buffer; encoding: "utf-8" | "gzip" }> {
  if (bytes.byteLength <= MAX_INLINE_EVIDENCE_ARTIFACT_BYTES) {
    return { bytes, encoding: "utf-8" };
  }
  const compressed = gzipSync(bytes, { level: 9 });
  const artifact = compressed.byteLength < bytes.byteLength
    ? { bytes: compressed, encoding: "gzip" as const }
    : { bytes, encoding: "utf-8" as const };
  if (artifact.bytes.byteLength > limits.max_artifact_bytes) {
    fail(
      "workspace_state_capture_artifact_limit_exceeded",
      `${artifact.bytes.byteLength}>${limits.max_artifact_bytes}`,
    );
  }
  return artifact;
}

export function decodeWorkspaceStateCaptureArtifact(
  input: Uint8Array,
): Buffer {
  const bytes = Buffer.from(input);
  if (bytes.byteLength > MAX_EVIDENCE_ARTIFACT_BYTES) {
    fail(
      "workspace_state_capture_artifact_limit_exceeded",
      `${bytes.byteLength}>${MAX_EVIDENCE_ARTIFACT_BYTES}`,
    );
  }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    if (bytes.byteLength > MAX_EXPANDED_EVIDENCE_ARTIFACT_BYTES) {
      fail("workspace_state_capture_expanded_artifact_limit_exceeded");
    }
    return bytes;
  }
  try {
    return gunzipSync(bytes, {
      maxOutputLength: MAX_EXPANDED_EVIDENCE_ARTIFACT_BYTES,
    });
  } catch {
    return fail("workspace_state_capture_gzip_invalid");
  }
}

function assertWorkspaceRoot(input: string): string {
  if (
    typeof input !== "string"
    || input.length === 0
    || !isAbsolute(input)
    || input.includes("\u0000")
    || input.includes("\n")
    || input.includes("\r")
    || Buffer.byteLength(input, "utf8") > MAX_WORKSPACE_ROOT_BYTES
  ) {
    fail("workspace_state_capture_invalid_workspace_root");
  }
  let root: string;
  try {
    root = realpathSync.native(input);
  } catch (error) {
    fail(
      "workspace_state_capture_workspace_root_unresolvable",
      error instanceof Error ? error.message : String(error),
    );
  }
  const stats = lstatSync(root, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail("workspace_state_capture_workspace_root_not_directory", root);
  }
  return root;
}

/**
 * Captures Runtime-observed workspace bytes. The canonical artifact excludes
 * timestamps and absolute paths, runs twice, and fails closed if the two
 * observations differ. Callers must still stop mutation before capture and
 * recapture at episode close because ordinary filesystems do not provide an
 * atomic multi-file snapshot.
 */
export function captureExactWorkspaceState(
  options: WorkspaceStateCaptureOptions,
): WorkspaceStateCaptureResultV1 {
  const limits = canonicalLimits(options.limits);
  const subjectStateSpec = canonicalSubjectStateSpec(
    options.subject_state_spec,
    limits,
  );
  const workspaceRoot = assertWorkspaceRoot(options.workspace_root);
  const gitContext = inspectGitContext(workspaceRoot);
  const capture = gitContext === null
    ? () => captureFilesystemManifest(
        workspaceRoot,
        limits,
        subjectStateSpec,
      )
    : () => captureGitManifest(gitContext, limits, subjectStateSpec);

  const firstManifest = capture();
  const firstBytes = canonicalManifestBytes(firstManifest);
  const secondManifest = capture();
  const secondBytes = canonicalManifestBytes(secondManifest);
  if (!firstBytes.equals(secondBytes)) {
    fail("workspace_state_capture_unstable_between_passes");
  }

  const artifact = encodeManifestArtifact(secondBytes, limits);
  const contentDigest = sha256Bytes(artifact.bytes);
  const environmentDigest = sha256Canonical({
    contract_version: "workspace_state_capture_environment_v1",
    algorithm_id: WORKSPACE_STATE_CAPTURE_ALGORITHM_ID,
    algorithm_version: WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION,
    platform: process.platform,
    workspace_root_sha256: sha256Bytes(Buffer.from(workspaceRoot, "utf8")),
    workspace_kind: secondManifest.workspace_kind,
    git_version: gitContext?.gitVersion ?? null,
    object_format: gitContext?.objectFormat ?? null,
    head_commit: secondManifest.repository?.head_commit ?? null,
  });
  return {
    contract_version: "workspace_state_capture_result_v1",
    algorithm_id: WORKSPACE_STATE_CAPTURE_ALGORITHM_ID,
    algorithm_version: WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION,
    state_kind: "workspace",
    workspace_kind: secondManifest.workspace_kind,
    workspace_root: workspaceRoot,
    repository_root: gitContext?.root ?? null,
    content_digest: contentDigest,
    environment_digest: environmentDigest,
    manifest: secondManifest,
    artifact: {
      kind: "state_snapshot",
      bytes: Buffer.from(artifact.bytes),
      declared_sha256: contentDigest,
      declared_byte_length: artifact.bytes.byteLength,
      media_type: WORKSPACE_STATE_CAPTURE_MEDIA_TYPE,
      encoding: artifact.encoding,
      ingest_mode:
        artifact.bytes.byteLength <= MAX_INLINE_EVIDENCE_ARTIFACT_BYTES
        ? "bounded_inline_base64"
        : "finalized_runtime_upload_required",
    },
    metadata: {
      git_version: gitContext?.gitVersion ?? null,
      object_format: gitContext?.objectFormat ?? null,
      entry_count: secondManifest.summary.entry_count,
      total_working_tree_bytes:
        secondManifest.summary.total_working_tree_bytes,
    },
  };
}
