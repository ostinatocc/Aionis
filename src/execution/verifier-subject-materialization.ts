import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  captureExactWorkspaceState,
  decodeWorkspaceStateCaptureArtifact,
  WORKSPACE_STATE_CAPTURE_ALGORITHM_ID,
  WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION,
  type WorkspaceStateCaptureManifestV1,
  type WorkspaceStateCaptureResultV1,
  type WorkspaceStateEntryV1,
  type WorkspaceSubjectStateSpecV2,
} from "./workspace-state-capture.js";

const MAX_SNAPSHOT_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 200_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODE_PATTERN = /^0[0-7]{3}$/u;

export class VerifierSubjectMaterializationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "VerifierSubjectMaterializationError";
    this.code = code;
  }
}

export type FileVerifierSubjectViewV1 = Readonly<{
  contract_version: "file_verifier_subject_view_v1";
  state_kind: "artifact" | "database";
  algorithm_id: string;
  algorithm_version: string;
  content_digest: string;
  environment_digest: string;
  subject_file_relative_path: string;
}>;

export type VerifierSubjectVerificationViewV1 =
  | WorkspaceStateCaptureResultV1
  | FileVerifierSubjectViewV1;

export type VerifierSubjectMaterializationV1 = Readonly<{
  contract_version: "verifier_subject_materialization_v1";
  materialization_id: string;
  source_content_digest: string;
  source_environment_digest: string;
  subject_state_spec: unknown;
  subject_root: string;
  scratch_root: string;
  verification_view: VerifierSubjectVerificationViewV1;
  cleanup(): void;
}>;

type AuthenticMaterialization = Readonly<{
  materializationId: string;
  sourceContentDigest: string;
  sourceEnvironmentDigest: string;
  subjectRoot: string;
  scratchRoot: string;
  verificationViewContentDigest: string;
  verificationViewEnvironmentDigest: string;
  verifyUnchanged(): VerifierSubjectVerificationViewV1;
}>;

const AUTHENTIC_MATERIALIZATIONS = new WeakMap<
  VerifierSubjectMaterializationV1,
  AuthenticMaterialization
>();

function fail(code: string): never {
  throw new VerifierSubjectMaterializationError(code);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort(compareUtf8);
  const canonicalExpected = [...expected].sort(compareUtf8);
  if (
    actual.length !== canonicalExpected.length
    || actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    fail(code);
  }
}

function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
    || Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return fail(code);
  }
  return value as Record<string, unknown>;
}

function strictUtf8(bytes: Uint8Array, code: string): string {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(decoded, "utf8").equals(Buffer.from(bytes))) fail(code);
    return decoded;
  } catch (error) {
    if (error instanceof VerifierSubjectMaterializationError) throw error;
    return fail(code);
  }
}

function canonicalBase64(
  value: unknown,
  expectedLength: unknown,
  expectedSha256: unknown,
  code: string,
): Buffer {
  if (
    typeof value !== "string"
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)
    || typeof expectedLength !== "number"
    || !Number.isSafeInteger(expectedLength)
    || expectedLength < 0
    || typeof expectedSha256 !== "string"
    || !SHA256_PATTERN.test(expectedSha256)
  ) {
    return fail(code);
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value
    || bytes.byteLength !== expectedLength
    || sha256(bytes) !== expectedSha256
  ) {
    return fail(code);
  }
  return bytes;
}

function canonicalMode(value: unknown): number {
  if (typeof value !== "string" || !MODE_PATTERN.test(value)) {
    return fail("verifier_subject_snapshot_mode_invalid");
  }
  return Number.parseInt(value, 8);
}

function canonicalRelativePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\u0000")
    || value.includes("\\")
    || Buffer.byteLength(value, "utf8") > 16 * 1024
  ) {
    return fail("verifier_subject_snapshot_path_invalid");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
  ) {
    return fail("verifier_subject_snapshot_path_invalid");
  }
  if (value === ".git" || value.startsWith(".git/")) {
    return fail("verifier_subject_snapshot_git_metadata_forbidden");
  }
  return value;
}

function canonicalSubjectSpec(
  value: unknown,
): WorkspaceSubjectStateSpecV2 {
  const record = plainRecord(
    value,
    "verifier_subject_snapshot_subject_spec_invalid",
  );
  exactKeys(
    record,
    ["contract_version", "additional_state_roots"],
    "verifier_subject_snapshot_subject_spec_invalid",
  );
  if (
    record.contract_version !== "workspace_subject_state_spec_v2"
    || !Array.isArray(record.additional_state_roots)
    || record.additional_state_roots.length > 256
  ) {
    return fail("verifier_subject_snapshot_subject_spec_invalid");
  }
  const roots = record.additional_state_roots.map(canonicalRelativePath);
  if (
    roots.some((root, index) =>
      index > 0 && compareUtf8(roots[index - 1]!, root) >= 0)
  ) {
    return fail("verifier_subject_snapshot_subject_spec_invalid");
  }
  return {
    contract_version: "workspace_subject_state_spec_v2",
    additional_state_roots: roots,
  };
}

function canonicalEntry(value: unknown): WorkspaceStateEntryV1 {
  const record = plainRecord(
    value,
    "verifier_subject_snapshot_entry_invalid",
  );
  exactKeys(
    record,
    ["path", "git_head", "git_index", "working_tree"],
    "verifier_subject_snapshot_entry_invalid",
  );
  const path = canonicalRelativePath(record.path);
  if (
    record.git_head !== null
    && (typeof record.git_head !== "object" || Array.isArray(record.git_head))
  ) {
    return fail("verifier_subject_snapshot_entry_invalid");
  }
  if (!Array.isArray(record.git_index)) {
    return fail("verifier_subject_snapshot_entry_invalid");
  }
  const working = plainRecord(
    record.working_tree,
    "verifier_subject_snapshot_entry_invalid",
  );
  if (working.kind === "absent") {
    exactKeys(
      working,
      ["kind"],
      "verifier_subject_snapshot_entry_invalid",
    );
  } else if (working.kind === "directory") {
    exactKeys(
      working,
      ["kind", "mode_octal"],
      "verifier_subject_snapshot_entry_invalid",
    );
    canonicalMode(working.mode_octal);
  } else if (working.kind === "regular_file") {
    exactKeys(
      working,
      [
        "kind",
        "mode_octal",
        "byte_length",
        "sha256",
        "git_blob_oid",
        "content_base64",
      ],
      "verifier_subject_snapshot_entry_invalid",
    );
    canonicalMode(working.mode_octal);
    canonicalBase64(
      working.content_base64,
      working.byte_length,
      working.sha256,
      "verifier_subject_snapshot_file_bytes_invalid",
    );
  } else if (working.kind === "symbolic_link") {
    exactKeys(
      working,
      [
        "kind",
        "mode_octal",
        "byte_length",
        "sha256",
        "git_blob_oid",
        "target_base64",
      ],
      "verifier_subject_snapshot_entry_invalid",
    );
    canonicalMode(working.mode_octal);
    canonicalBase64(
      working.target_base64,
      working.byte_length,
      working.sha256,
      "verifier_subject_snapshot_symlink_bytes_invalid",
    );
  } else {
    return fail("verifier_subject_snapshot_entry_invalid");
  }
  return record as WorkspaceStateEntryV1;
}

function parseSnapshotManifest(
  bytes: Buffer,
  expectedContentDigest: string,
): WorkspaceStateCaptureManifestV1 {
  if (
    bytes.byteLength === 0
    || bytes.byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES
    || !SHA256_PATTERN.test(expectedContentDigest)
    || sha256(bytes) !== expectedContentDigest
  ) {
    return fail("verifier_subject_snapshot_digest_mismatch");
  }
  let manifestBytes: Buffer;
  try {
    manifestBytes = decodeWorkspaceStateCaptureArtifact(bytes);
  } catch {
    return fail("verifier_subject_snapshot_encoding_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      strictUtf8(manifestBytes, "verifier_subject_snapshot_utf8"),
    );
  } catch (error) {
    if (error instanceof VerifierSubjectMaterializationError) throw error;
    return fail("verifier_subject_snapshot_json_invalid");
  }
  if (
    Buffer.from(stableStringify(parsed), "utf8").compare(manifestBytes) !== 0
  ) {
    return fail("verifier_subject_snapshot_json_not_canonical");
  }
  const manifest = plainRecord(
    parsed,
    "verifier_subject_snapshot_manifest_invalid",
  );
  exactKeys(
    manifest,
    [
      "contract_version",
      "algorithm_id",
      "algorithm_version",
      "workspace_kind",
      "capture_policy",
      "repository",
      "entries",
      "summary",
    ],
    "verifier_subject_snapshot_manifest_invalid",
  );
  if (
    manifest.contract_version !== "workspace_state_capture_manifest_v1"
    || manifest.algorithm_id !== WORKSPACE_STATE_CAPTURE_ALGORITHM_ID
    || manifest.algorithm_version !== WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION
    || (manifest.workspace_kind !== "git"
      && manifest.workspace_kind !== "filesystem")
    || !Array.isArray(manifest.entries)
    || manifest.entries.length > MAX_SNAPSHOT_ENTRIES
  ) {
    return fail("verifier_subject_snapshot_manifest_invalid");
  }
  const policy = plainRecord(
    manifest.capture_policy,
    "verifier_subject_snapshot_manifest_invalid",
  );
  const subjectSpec = canonicalSubjectSpec(policy.subject_state_spec);
  const entries = manifest.entries.map(canonicalEntry);
  for (let index = 1; index < entries.length; index += 1) {
    if (compareUtf8(entries[index - 1]!.path, entries[index]!.path) >= 0) {
      return fail("verifier_subject_snapshot_entry_order_invalid");
    }
  }
  return {
    ...(manifest as WorkspaceStateCaptureManifestV1),
    capture_policy: {
      ...(policy as WorkspaceStateCaptureManifestV1["capture_policy"]),
      subject_state_spec: subjectSpec,
    },
    entries,
  };
}

function absoluteSubjectPath(root: string, relativePath: string): string {
  const path = join(root, ...relativePath.split("/"));
  const fromRoot = relative(root, path);
  if (
    fromRoot.length === 0
    || fromRoot === ".."
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    return fail("verifier_subject_snapshot_path_escape");
  }
  return path;
}

function ensureParent(root: string, path: string): void {
  const parent = dirname(path);
  const fromRoot = relative(root, parent);
  if (
    fromRoot === ".."
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    fail("verifier_subject_snapshot_parent_escape");
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
}

function materializeEntries(
  root: string,
  entries: readonly WorkspaceStateEntryV1[],
): void {
  const directories = entries
    .filter((entry) => entry.working_tree.kind === "directory")
    .sort((left, right) => {
      const depth = left.path.split("/").length - right.path.split("/").length;
      return depth !== 0 ? depth : compareUtf8(left.path, right.path);
    });
  for (const entry of directories) {
    if (entry.working_tree.kind !== "directory") {
      return fail("verifier_subject_snapshot_entry_invalid");
    }
    const path = absoluteSubjectPath(root, entry.path);
    mkdirSync(path, {
      recursive: false,
      mode: canonicalMode(entry.working_tree.mode_octal),
    });
    chmodSync(path, canonicalMode(entry.working_tree.mode_octal));
  }

  for (const entry of entries) {
    if (entry.working_tree.kind !== "regular_file") continue;
    const path = absoluteSubjectPath(root, entry.path);
    ensureParent(root, path);
    const bytes = canonicalBase64(
      entry.working_tree.content_base64,
      entry.working_tree.byte_length,
      entry.working_tree.sha256,
      "verifier_subject_snapshot_file_bytes_invalid",
    );
    const mode = canonicalMode(entry.working_tree.mode_octal);
    writeFileSync(path, bytes, { flag: "wx", mode });
    chmodSync(path, mode);
  }

  for (const entry of entries) {
    if (entry.working_tree.kind !== "symbolic_link") continue;
    const path = absoluteSubjectPath(root, entry.path);
    ensureParent(root, path);
    const targetBytes = canonicalBase64(
      entry.working_tree.target_base64,
      entry.working_tree.byte_length,
      entry.working_tree.sha256,
      "verifier_subject_snapshot_symlink_bytes_invalid",
    );
    const target = strictUtf8(
      targetBytes,
      "verifier_subject_snapshot_symlink_target_invalid",
    );
    if (
      target.length === 0
      || target.includes("\u0000")
      || isAbsolute(target)
    ) {
      fail("verifier_subject_snapshot_symlink_escape");
    }
    const resolvedTarget = resolve(dirname(path), target);
    const fromRoot = relative(root, resolvedTarget);
    if (
      fromRoot === ".."
      || fromRoot.startsWith(`..${sep}`)
      || isAbsolute(fromRoot)
    ) {
      fail("verifier_subject_snapshot_symlink_escape");
    }
    symlinkSync(target, path);
  }
}

export function materializeVerifierSubjectFromSnapshot(
  input: Readonly<{
    snapshotArtifactBytes: Uint8Array;
    sourceContentDigest: string;
    sourceEnvironmentDigest: string;
  }>,
): VerifierSubjectMaterializationV1 {
  if (
    typeof input.sourceEnvironmentDigest !== "string"
    || !SHA256_PATTERN.test(input.sourceEnvironmentDigest)
  ) {
    return fail("verifier_subject_snapshot_environment_digest_invalid");
  }
  const bytes = Buffer.from(input.snapshotArtifactBytes);
  const manifest = parseSnapshotManifest(bytes, input.sourceContentDigest);
  const parent = mkdtempSync(
    join(tmpdir(), "aionis-verifier-subject-"),
    { encoding: "utf8" },
  );
  chmodSync(parent, 0o700);
  const subjectRoot = join(parent, "subject");
  const scratchRoot = join(parent, "scratch");
  mkdirSync(subjectRoot, { mode: 0o700 });
  mkdirSync(scratchRoot, { mode: 0o700 });
  try {
    const canonicalSubjectRoot = realpathSync(subjectRoot);
    const canonicalScratchRoot = realpathSync(scratchRoot);
    materializeEntries(canonicalSubjectRoot, manifest.entries);
    const verificationView = captureExactWorkspaceState({
      workspace_root: canonicalSubjectRoot,
    });
    const materializationId = `vsm_${sha256(Buffer.from(stableStringify({
      contract: "verifier_subject_materialization_identity_v1",
      source_content_digest: input.sourceContentDigest,
      source_environment_digest: input.sourceEnvironmentDigest,
      verification_view_content_digest: verificationView.content_digest,
      nonce: randomUUID(),
    }), "utf8"))}`;
    let cleaned = false;
    const result: VerifierSubjectMaterializationV1 = Object.freeze({
      contract_version: "verifier_subject_materialization_v1",
      materialization_id: materializationId,
      source_content_digest: input.sourceContentDigest,
      source_environment_digest: input.sourceEnvironmentDigest,
      subject_state_spec:
        manifest.capture_policy.subject_state_spec,
      subject_root: canonicalSubjectRoot,
      scratch_root: canonicalScratchRoot,
      verification_view: verificationView,
      cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        rmSync(parent, { recursive: true, force: true });
      },
    });
    AUTHENTIC_MATERIALIZATIONS.set(result, {
      materializationId,
      sourceContentDigest: input.sourceContentDigest,
      sourceEnvironmentDigest: input.sourceEnvironmentDigest,
      subjectRoot: canonicalSubjectRoot,
      scratchRoot: canonicalScratchRoot,
      verificationViewContentDigest: verificationView.content_digest,
      verificationViewEnvironmentDigest: verificationView.environment_digest,
      verifyUnchanged() {
        return captureExactWorkspaceState({
          workspace_root: canonicalSubjectRoot,
        });
      },
    });
    return result;
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

export function assertAuthenticVerifierSubjectMaterialization(
  value: VerifierSubjectMaterializationV1,
): AuthenticMaterialization {
  const record = AUTHENTIC_MATERIALIZATIONS.get(value);
  if (
    !record
    || value.materialization_id !== record.materializationId
    || value.source_content_digest !== record.sourceContentDigest
    || value.source_environment_digest !== record.sourceEnvironmentDigest
    || value.subject_root !== record.subjectRoot
    || value.scratch_root !== record.scratchRoot
    || value.verification_view.content_digest
      !== record.verificationViewContentDigest
    || value.verification_view.environment_digest
      !== record.verificationViewEnvironmentDigest
  ) {
    return fail("verifier_subject_materialization_not_authentic");
  }
  let actualSubjectRoot: string;
  let actualScratchRoot: string;
  try {
    actualSubjectRoot = realpathSync(value.subject_root);
    actualScratchRoot = realpathSync(value.scratch_root);
  } catch {
    return fail("verifier_subject_materialization_missing");
  }
  if (
    actualSubjectRoot !== record.subjectRoot
    || actualScratchRoot !== record.scratchRoot
    || !lstatSync(actualSubjectRoot).isDirectory()
    || !lstatSync(actualScratchRoot).isDirectory()
  ) {
    return fail("verifier_subject_materialization_identity_drift");
  }
  return record;
}

export function materializeVerifierFileSubjectFromSnapshot(
  input: Readonly<{
    snapshotArtifactBytes: Uint8Array;
    sourceContentDigest: string;
    sourceEnvironmentDigest: string;
    subjectStateSpec: unknown;
    stateKind: "artifact" | "database";
    algorithmId: string;
    algorithmVersion: string;
    subjectFileName: "artifact.json" | "database.sqlite";
  }>,
): VerifierSubjectMaterializationV1 {
  if (
    !SHA256_PATTERN.test(input.sourceContentDigest)
    || !SHA256_PATTERN.test(input.sourceEnvironmentDigest)
    || typeof input.algorithmId !== "string"
    || input.algorithmId.length === 0
    || typeof input.algorithmVersion !== "string"
    || input.algorithmVersion.length === 0
  ) {
    return fail("verifier_file_subject_identity_invalid");
  }
  const bytes = Buffer.from(input.snapshotArtifactBytes);
  if (
    bytes.byteLength > MAX_SNAPSHOT_ARTIFACT_BYTES
    || sha256(bytes) !== input.sourceContentDigest
  ) {
    return fail("verifier_file_subject_snapshot_invalid");
  }
  const parent = mkdtempSync(
    join(tmpdir(), "aionis-verifier-subject-"),
    { encoding: "utf8" },
  );
  chmodSync(parent, 0o700);
  const subjectRoot = join(parent, "subject");
  const scratchRoot = join(parent, "scratch");
  mkdirSync(subjectRoot, { mode: 0o700 });
  mkdirSync(scratchRoot, { mode: 0o700 });
  try {
    const canonicalSubjectRoot = realpathSync(subjectRoot);
    const canonicalScratchRoot = realpathSync(scratchRoot);
    const subjectFile = join(canonicalSubjectRoot, input.subjectFileName);
    writeFileSync(subjectFile, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(subjectFile, 0o600);
    const verificationView: FileVerifierSubjectViewV1 = Object.freeze({
      contract_version: "file_verifier_subject_view_v1",
      state_kind: input.stateKind,
      algorithm_id: input.algorithmId,
      algorithm_version: input.algorithmVersion,
      content_digest: input.sourceContentDigest,
      environment_digest: input.sourceEnvironmentDigest,
      subject_file_relative_path: input.subjectFileName,
    });
    const materializationId = `vsm_${sha256(Buffer.from(stableStringify({
      contract: "verifier_file_subject_materialization_identity_v1",
      state_kind: input.stateKind,
      source_content_digest: input.sourceContentDigest,
      source_environment_digest: input.sourceEnvironmentDigest,
      subject_file_name: input.subjectFileName,
      nonce: randomUUID(),
    }), "utf8"))}`;
    let cleaned = false;
    const result: VerifierSubjectMaterializationV1 = Object.freeze({
      contract_version: "verifier_subject_materialization_v1",
      materialization_id: materializationId,
      source_content_digest: input.sourceContentDigest,
      source_environment_digest: input.sourceEnvironmentDigest,
      subject_state_spec: input.subjectStateSpec,
      subject_root: canonicalSubjectRoot,
      scratch_root: canonicalScratchRoot,
      verification_view: verificationView,
      cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        rmSync(parent, { recursive: true, force: true });
      },
    });
    AUTHENTIC_MATERIALIZATIONS.set(result, {
      materializationId,
      sourceContentDigest: input.sourceContentDigest,
      sourceEnvironmentDigest: input.sourceEnvironmentDigest,
      subjectRoot: canonicalSubjectRoot,
      scratchRoot: canonicalScratchRoot,
      verificationViewContentDigest: verificationView.content_digest,
      verificationViewEnvironmentDigest: verificationView.environment_digest,
      verifyUnchanged() {
        const entries = readdirSync(canonicalSubjectRoot);
        if (
          entries.length !== 1
          || entries[0] !== input.subjectFileName
          || sha256(readFileSync(subjectFile)) !== input.sourceContentDigest
        ) {
          return fail("verifier_subject_modified_during_verification");
        }
        return verificationView;
      },
    });
    return result;
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

export function assertVerifierSubjectUnchanged(
  value: VerifierSubjectMaterializationV1,
): VerifierSubjectVerificationViewV1 {
  const record = assertAuthenticVerifierSubjectMaterialization(value);
  const after = record.verifyUnchanged();
  if (
    after.content_digest !== record.verificationViewContentDigest
    || after.environment_digest !== record.verificationViewEnvironmentDigest
  ) {
    return fail("verifier_subject_modified_during_verification");
  }
  return after;
}

export function verifierSubjectFileBytes(
  value: VerifierSubjectMaterializationV1,
  relativePath: string,
): Buffer {
  const record = assertAuthenticVerifierSubjectMaterialization(value);
  const canonicalPath = canonicalRelativePath(relativePath);
  const path = absoluteSubjectPath(record.subjectRoot, canonicalPath);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return fail("verifier_subject_file_unavailable");
  }
  return readFileSync(path);
}

/**
 * Removes a materialization left behind by a process that died before its
 * in-memory cleanup capability could run. Only the exact Runtime-owned
 * tmpdir/direct-child layout is accepted; persisted arbitrary paths can never
 * turn recovery into a recursive delete primitive.
 */
export function cleanupInterruptedVerifierSubjectMaterialization(
  input: Readonly<{
    materializedSubjectRoot: string;
    materializedScratchRoot: string;
  }>,
): void {
  const subjectRoot = resolve(input.materializedSubjectRoot);
  const scratchRoot = resolve(input.materializedScratchRoot);
  const parent = dirname(subjectRoot);
  if (
    subjectRoot !== join(parent, "subject")
    || scratchRoot !== join(parent, "scratch")
    || dirname(scratchRoot) !== parent
    || !basename(parent).startsWith("aionis-verifier-subject-")
  ) {
    fail("verifier_subject_interrupted_cleanup_path_invalid");
  }
  if (!existsSync(parent)) return;
  const canonicalTmp = realpathSync(tmpdir());
  const canonicalParent = realpathSync(parent);
  if (
    dirname(canonicalParent) !== canonicalTmp
    || canonicalParent !== parent
    || lstatSync(canonicalParent).isSymbolicLink()
    || !lstatSync(canonicalParent).isDirectory()
  ) {
    fail("verifier_subject_interrupted_cleanup_path_invalid");
  }
  for (const root of [subjectRoot, scratchRoot]) {
    if (!existsSync(root)) continue;
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("verifier_subject_interrupted_cleanup_path_invalid");
    }
  }
  rmSync(canonicalParent, { recursive: true, force: true });
}
