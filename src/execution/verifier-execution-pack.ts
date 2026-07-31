import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import stableStringify from "fast-json-stable-stringify";

import type {
  VerifierProgramIdentityV2,
  VerifierProgramManifestV2,
  VerifierProgramMaterialEntryV1,
  VerifierProgramMaterialRootV1,
  VerifierProgramRunnerConfig,
} from "./verifier-program-identity.js";

const MAX_ID_UTF8_BYTES = 256;
const MAX_PATH_UTF8_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class VerifierExecutionPackError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "VerifierExecutionPackError";
    this.code = code;
  }
}

export type VerifierExecutionPackReadonlyInputTypeV1 =
  | "dependency"
  | "oracle";

/**
 * Gives every immutable-input root a product meaning. The source root must
 * match one exact `manifest.immutable_input_roots[].resolved_path`; implicit
 * ambient files are never copied into the execution pack.
 */
export type VerifierExecutionPackReadonlyInputV1 = Readonly<{
  contract_version: "verifier_execution_pack_readonly_input_v1";
  input_id: string;
  input_type: VerifierExecutionPackReadonlyInputTypeV1;
  source_root_resolved_path: string;
  subject_path?: string;
}>;

/**
 * Declares one writable directory in the private pack. When `subject_path` is
 * present, the directory is attached to the materialized subject through a
 * temporary symlink and removed by `detach()`.
 */
export type VerifierExecutionPackScratchOverlayV1 = Readonly<{
  contract_version: "verifier_execution_pack_scratch_overlay_v1";
  overlay_id: string;
  subject_path?: string;
}>;

export type VerifierExecutionPackPathBindingLocationV1 =
  | Readonly<{ kind: "executable" }>
  | Readonly<{ kind: "argv"; index: number }>
  | Readonly<{ kind: "environment"; key: string; component_index: number }>;

export type VerifierExecutionPackPathBindingV1 = Readonly<{
  contract_version: "verifier_execution_pack_path_binding_v1";
  location: VerifierExecutionPackPathBindingLocationV1;
  source_kind: "executable" | "program_material" | "dependency" | "oracle";
  source_path: string;
  packed_path: string;
}>;

export type VerifierExecutionPackCopiedEntryV1 = Readonly<{
  relative_path: string;
  type: "regular_file" | "directory" | "symlink";
  source_mode: number;
  mode: number;
  byte_length?: number;
  content_sha256?: string;
  symlink_target?: string;
}>;

export type VerifierExecutionPackCopiedRootV1 = Readonly<{
  source_kind: "program_material" | "dependency" | "oracle";
  input_id: string | null;
  source_declared_path: string;
  source_resolved_path: string;
  packed_root_path: string;
  root_type: "regular_file" | "directory";
  subject_path: string | null;
  entries: readonly VerifierExecutionPackCopiedEntryV1[];
}>;

export type VerifierExecutionPackScratchOverlayResultV1 = Readonly<{
  overlay_id: string;
  scratch_path: string;
  subject_path: string | null;
  attached_subject_path: string | null;
}>;

export type VerifierExecutionPackManifestV1 = Readonly<{
  contract_version: "verifier_execution_pack_manifest_v1";
  pack_id: string;
  invocation_id: string;
  verifier_program_digest: string;
  executable: Readonly<{
    source_path: string;
    packed_path: string;
    source_mode: number;
    mode: number;
    byte_length: number;
    content_sha256: string;
  }>;
  copied_roots: readonly VerifierExecutionPackCopiedRootV1[];
  scratch_overlays: readonly VerifierExecutionPackScratchOverlayResultV1[];
  path_bindings: readonly VerifierExecutionPackPathBindingV1[];
  runner_resolution_sha256: string;
}>;

export type VerifierExecutionPackRunnerResolutionV1 = Readonly<{
  contract_version: "verifier_execution_pack_runner_resolution_v1";
  executable: string;
  argv: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  path_bindings: readonly VerifierExecutionPackPathBindingV1[];
}>;

/**
 * This is an integrity boundary for a trusted verifier, not an adversarial
 * process sandbox. It removes live program/input drift and makes accidental
 * mutation detectable, but it does not claim to contain malicious code.
 */
export type VerifierExecutionPackV1 = Readonly<{
  contract_version: "verifier_execution_pack_v1";
  pack_id: string;
  invocation_id: string;
  pack_root: string;
  subject_root: string;
  executable_path: string;
  copied_roots: readonly VerifierExecutionPackCopiedRootV1[];
  scratch_root: string;
  scratch_overlays: readonly VerifierExecutionPackScratchOverlayResultV1[];
  runner_resolution: VerifierExecutionPackRunnerResolutionV1;
  manifest: VerifierExecutionPackManifestV1;
  manifest_sha256: string;
  detach(): void;
  cleanup(): void;
}>;

export type MaterializeVerifierExecutionPackInput = Readonly<{
  invocation_id: string;
  program_identity: VerifierProgramIdentityV2;
  runner_config: VerifierProgramRunnerConfig;
  readonly_inputs: readonly VerifierExecutionPackReadonlyInputV1[];
  subject_root: string;
  scratch_overlays?: readonly VerifierExecutionPackScratchOverlayV1[];
  base_directory?: string;
}>;

export function verifierExecutionPackManifestDigest(
  manifest: VerifierExecutionPackManifestV1,
): string {
  return sha256(stableStringify({
    contract: "verifier_execution_pack_manifest_digest_v1",
    manifest,
  }));
}

export function verifierExecutionPackRunnerResolutionDigest(
  resolution: VerifierExecutionPackRunnerResolutionV1,
): string {
  return sha256(stableStringify({
    contract: "verifier_execution_pack_runner_resolution_digest_v1",
    resolution,
  }));
}

type SourceKind =
  | "executable"
  | "program_material"
  | "dependency"
  | "oracle";

type RootCopyPlan = Readonly<{
  sourceKind: Exclude<SourceKind, "executable">;
  inputId: string | null;
  sourceRoot: VerifierProgramMaterialRootV1;
  packedRootPath: string;
  subjectPath: string | null;
}>;

type SourcePathMapping = Readonly<{
  sourceKind: SourceKind;
  sourcePath: string;
  packedPath: string;
}>;

type Attachment = {
  subjectPath: string;
  targetPath: string;
  createdParentDirectories: string[];
  attached: boolean;
};

type AuthenticPack = {
  packRoot: string;
  scratchRoot: string;
  executable: VerifierExecutionPackManifestV1["executable"];
  copiedRoots: readonly VerifierExecutionPackCopiedRootV1[];
  attachments: Attachment[];
  detached: boolean;
  cleaned: boolean;
};

const AUTHENTIC_PACKS = new WeakMap<VerifierExecutionPackV1, AuthenticPack>();

function fail(code: string): never {
  throw new VerifierExecutionPackError(code);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path: string): string {
  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    return fail("verifier_execution_pack_file_unreadable");
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      return fail("verifier_execution_pack_file_not_regular");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let consumed = 0n;
    while (consumed < before.size) {
      const bytesRead = readSync(
        descriptor,
        chunk,
        0,
        Number(
          before.size - consumed > BigInt(chunk.byteLength)
            ? BigInt(chunk.byteLength)
            : before.size - consumed,
        ),
        null,
      );
      if (bytesRead <= 0) {
        return fail("verifier_execution_pack_file_short_read");
      }
      hash.update(chunk.subarray(0, bytesRead));
      consumed += BigInt(bytesRead);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.mode !== after.mode
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) {
      return fail("verifier_execution_pack_file_changed_during_verification");
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function permissionMode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function immutablePackedMode(sourceMode: number): number {
  return sourceMode & ~0o222;
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

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function exactId(value: unknown, code: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\u0000")
    || Buffer.byteLength(value, "utf8") > MAX_ID_UTF8_BYTES
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    return fail(code);
  }
  return value;
}

function exactAbsolutePath(value: unknown, code: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\u0000")
    || !isAbsolute(value)
    || Buffer.byteLength(value, "utf8") > MAX_PATH_UTF8_BYTES
  ) {
    return fail(code);
  }
  return normalize(value);
}

function subjectRelativePath(value: unknown, code: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\u0000")
    || value.includes("\\")
    || Buffer.byteLength(value, "utf8") > MAX_PATH_UTF8_BYTES
  ) {
    return fail(code);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
    || segments[0] === ".git"
  ) {
    return fail(code);
  }
  return value;
}

function pathWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ""
    || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function entryPackedPath(
  packedRoot: string,
  relativePath: string,
): string {
  if (relativePath === ".") return packedRoot;
  if (
    relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath.includes("\u0000")
  ) {
    return fail("verifier_execution_pack_manifest_relative_path_invalid");
  }
  const segments = relativePath.split(/[\\/]/u);
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
  ) {
    return fail("verifier_execution_pack_manifest_relative_path_invalid");
  }
  const output = resolve(packedRoot, ...segments);
  if (!pathWithin(packedRoot, output)) {
    return fail("verifier_execution_pack_manifest_relative_path_escape");
  }
  return output;
}

function expectedEntrySourcePath(
  root: VerifierProgramMaterialRootV1,
  entry: VerifierProgramMaterialEntryV1,
): string {
  const expected = entry.relative_path === "."
    ? root.resolved_path
    : resolve(root.resolved_path, entry.relative_path);
  if (normalize(entry.path) !== normalize(expected)) {
    return fail("verifier_execution_pack_manifest_entry_source_mismatch");
  }
  return expected;
}

function assertFileDescriptor(
  value: Pick<
    VerifierProgramMaterialEntryV1,
    "mode" | "byte_length" | "content_sha256"
  >,
): asserts value is Pick<
  VerifierProgramMaterialEntryV1,
  "mode" | "byte_length" | "content_sha256"
> & {
  mode: number;
  byte_length: number;
  content_sha256: string;
} {
  if (
    !Number.isInteger(value.mode)
    || value.mode < 0
    || value.mode > 0o7777
    || !Number.isSafeInteger(value.byte_length)
    || (value.byte_length ?? -1) < 0
    || typeof value.content_sha256 !== "string"
    || !SHA256_PATTERN.test(value.content_sha256)
  ) {
    fail("verifier_execution_pack_manifest_file_descriptor_invalid");
  }
}

function verifyRegularFile(
  path: string,
  expected: Readonly<{
    mode: number;
    byte_length: number;
    content_sha256: string;
  }>,
  code: string,
): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return fail(code);
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size !== expected.byte_length
    || (stat.mode & 0o7777) !== expected.mode
    || sha256File(path) !== expected.content_sha256
  ) {
    fail(code);
  }
}

function verifyDirectory(path: string, mode: number, code: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return fail(code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== mode) {
    fail(code);
  }
}

function copyRegularFile(
  source: string,
  destination: string,
  sourceExpected: Readonly<{
    mode: number;
    byte_length: number;
    content_sha256: string;
  }>,
  destinationMode: number,
): void {
  verifyRegularFile(
    source,
    sourceExpected,
    "verifier_execution_pack_source_file_drift",
  );
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    fail("verifier_execution_pack_source_file_type_drift");
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(
    source,
    destination,
    constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
  );
  chmodSync(destination, destinationMode);
  verifyRegularFile(
    destination,
    {
      ...sourceExpected,
      mode: destinationMode,
    },
    "verifier_execution_pack_copied_file_integrity_mismatch",
  );
  const copiedStat = lstatSync(destination);
  if (
    typeof sourceStat.ino === "number"
    && typeof copiedStat.ino === "number"
    && sourceStat.dev === copiedStat.dev
    && sourceStat.ino === copiedStat.ino
  ) {
    fail("verifier_execution_pack_hardlink_forbidden");
  }
}

function validateProgramIdentity(
  identity: VerifierProgramIdentityV2,
): VerifierProgramManifestV2 {
  if (
    !identity
    || identity.contract_version !== "verifier_program_identity_v2"
    || identity.manifest?.contract_version !== "verifier_program_manifest_v2"
    || !SHA256_PATTERN.test(identity.verifier_program_digest)
  ) {
    return fail("verifier_execution_pack_program_identity_invalid");
  }
  const actual = sha256(stableStringify({
    contract: "verifier_program_digest_v2",
    manifest: identity.manifest,
  }));
  if (actual !== identity.verifier_program_digest) {
    return fail("verifier_execution_pack_program_identity_digest_mismatch");
  }
  const manifest = identity.manifest;
  if (
    manifest.executable.type !== "regular_file"
    || !Number.isSafeInteger(manifest.entry_count)
    || manifest.entry_count < 1
    || !Number.isSafeInteger(manifest.total_file_bytes)
    || manifest.total_file_bytes < 0
    || !Array.isArray(manifest.material_roots)
    || !Array.isArray(manifest.immutable_input_roots)
  ) {
    return fail("verifier_execution_pack_program_manifest_invalid");
  }
  exactAbsolutePath(
    manifest.executable.declared_path,
    "verifier_execution_pack_executable_path_invalid",
  );
  exactAbsolutePath(
    manifest.executable.resolved_path,
    "verifier_execution_pack_executable_path_invalid",
  );
  assertFileDescriptor(manifest.executable);
  for (const root of [
    ...manifest.material_roots,
    ...manifest.immutable_input_roots,
  ]) {
    validateRootManifest(root);
  }
  const roots: readonly VerifierProgramMaterialRootV1[] = [
    ...manifest.material_roots,
    ...manifest.immutable_input_roots,
  ];
  const entryCount =
    1 + roots.reduce((sum, root) => sum + root.entries.length, 0);
  const totalFileBytes = manifest.executable.byte_length
    + roots.reduce((rootSum: number, root) =>
      rootSum + root.entries.reduce((
        entrySum: number,
        entry: VerifierProgramMaterialEntryV1,
      ) =>
        entrySum + (
          entry.type === "regular_file"
            ? entry.byte_length!
            : 0
        ), 0), 0);
  if (
    manifest.entry_count !== entryCount
    || manifest.total_file_bytes !== totalFileBytes
  ) {
    return fail("verifier_execution_pack_program_manifest_totals_mismatch");
  }
  return manifest;
}

function validateRootManifest(root: VerifierProgramMaterialRootV1): void {
  const resolvedRoot = exactAbsolutePath(
    root.resolved_path,
    "verifier_execution_pack_manifest_root_path_invalid",
  );
  exactAbsolutePath(
    root.declared_path,
    "verifier_execution_pack_manifest_root_path_invalid",
  );
  if (
    root.root_type !== "regular_file"
    && root.root_type !== "directory"
  ) {
    fail("verifier_execution_pack_manifest_root_type_invalid");
  }
  if (!Array.isArray(root.entries) || root.entries.length === 0) {
    fail("verifier_execution_pack_manifest_entries_invalid");
  }
  const relativePaths = new Set<string>();
  for (const entry of root.entries) {
    expectedEntrySourcePath(root, entry);
    if (relativePaths.has(entry.relative_path)) {
      fail("verifier_execution_pack_manifest_entry_duplicate");
    }
    relativePaths.add(entry.relative_path);
    if (
      !Number.isInteger(entry.mode)
      || entry.mode < 0
      || entry.mode > 0o7777
    ) {
      fail("verifier_execution_pack_manifest_entry_mode_invalid");
    }
    if (entry.type === "regular_file") {
      assertFileDescriptor(entry);
    } else if (entry.type === "directory") {
      if (
        entry.byte_length !== undefined
        || entry.content_sha256 !== undefined
        || entry.symlink_target !== undefined
      ) {
        fail("verifier_execution_pack_manifest_directory_descriptor_invalid");
      }
    } else if (entry.type === "symlink") {
      if (
        typeof entry.symlink_target !== "string"
        || entry.symlink_target.length === 0
        || entry.symlink_target.includes("\u0000")
        || entry.byte_length !== undefined
        || entry.content_sha256 !== undefined
      ) {
        fail("verifier_execution_pack_manifest_symlink_descriptor_invalid");
      }
    } else {
      fail("verifier_execution_pack_manifest_entry_type_invalid");
    }
  }
  const rootEntry = root.entries.find((entry) => entry.relative_path === ".");
  if (
    !rootEntry
    || (
      root.root_type === "regular_file"
        ? rootEntry.type !== "regular_file" || root.entries.length !== 1
        : rootEntry.type !== "directory"
    )
    || normalize(rootEntry.path) !== resolvedRoot
  ) {
    fail("verifier_execution_pack_manifest_root_entry_invalid");
  }
  for (const entry of root.entries) {
    if (entry.relative_path === ".") continue;
    const parentRelative = dirname(entry.relative_path);
    const parent = root.entries.find((candidate) =>
      candidate.relative_path === (parentRelative === "." ? "." : parentRelative));
    if (!parent || parent.type !== "directory") {
      fail("verifier_execution_pack_manifest_parent_directory_missing");
    }
  }
}

function readonlyInputDefinitions(
  manifest: VerifierProgramManifestV2,
  definitions: readonly VerifierExecutionPackReadonlyInputV1[],
): ReadonlyMap<string, VerifierExecutionPackReadonlyInputV1> {
  if (!Array.isArray(definitions)) {
    return fail("verifier_execution_pack_readonly_inputs_invalid");
  }
  const byRoot = new Map<string, VerifierExecutionPackReadonlyInputV1>();
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (
      !definition
      || definition.contract_version
        !== "verifier_execution_pack_readonly_input_v1"
      || (
        definition.input_type !== "dependency"
        && definition.input_type !== "oracle"
      )
    ) {
      fail("verifier_execution_pack_readonly_input_invalid");
    }
    const id = exactId(
      definition.input_id,
      "verifier_execution_pack_readonly_input_id_invalid",
    );
    if (ids.has(id)) {
      fail("verifier_execution_pack_readonly_input_id_duplicate");
    }
    ids.add(id);
    const sourceRoot = exactAbsolutePath(
      definition.source_root_resolved_path,
      "verifier_execution_pack_readonly_input_root_invalid",
    );
    if (byRoot.has(sourceRoot)) {
      fail("verifier_execution_pack_readonly_input_root_duplicate");
    }
    if (definition.subject_path !== undefined) {
      subjectRelativePath(
        definition.subject_path,
        "verifier_execution_pack_subject_path_invalid",
      );
    }
    byRoot.set(sourceRoot, definition);
  }
  const expected = new Set(
    manifest.immutable_input_roots.map((root) => normalize(root.resolved_path)),
  );
  if (
    expected.size !== manifest.immutable_input_roots.length
    || byRoot.size !== expected.size
    || [...byRoot.keys()].some((path) => !expected.has(path))
  ) {
    return fail("verifier_execution_pack_readonly_input_coverage_mismatch");
  }
  return byRoot;
}

function canonicalScratchOverlays(
  definitions: readonly VerifierExecutionPackScratchOverlayV1[],
): readonly VerifierExecutionPackScratchOverlayV1[] {
  if (!Array.isArray(definitions)) {
    return fail("verifier_execution_pack_scratch_overlays_invalid");
  }
  const ids = new Set<string>();
  return definitions.map((definition) => {
    if (
      !definition
      || definition.contract_version
        !== "verifier_execution_pack_scratch_overlay_v1"
    ) {
      return fail("verifier_execution_pack_scratch_overlay_invalid");
    }
    const overlayId = exactId(
      definition.overlay_id,
      "verifier_execution_pack_scratch_overlay_id_invalid",
    );
    if (ids.has(overlayId)) {
      return fail("verifier_execution_pack_scratch_overlay_id_duplicate");
    }
    ids.add(overlayId);
    if (definition.subject_path !== undefined) {
      subjectRelativePath(
        definition.subject_path,
        "verifier_execution_pack_subject_path_invalid",
      );
    }
    return definition;
  });
}

function rootPlans(
  packRoot: string,
  manifest: VerifierProgramManifestV2,
  readonlyDefinitions:
    ReadonlyMap<string, VerifierExecutionPackReadonlyInputV1>,
): readonly RootCopyPlan[] {
  const plans: RootCopyPlan[] = [];
  manifest.material_roots.forEach((root, index) => {
    validateRootManifest(root);
    plans.push({
      sourceKind: "program_material",
      inputId: null,
      sourceRoot: root,
      packedRootPath: join(
        packRoot,
        "program",
        index.toString().padStart(4, "0"),
        "root",
      ),
      subjectPath: null,
    });
  });
  const inputRoots = [...manifest.immutable_input_roots]
    .map((root) => {
      validateRootManifest(root);
      const definition = readonlyDefinitions.get(normalize(root.resolved_path));
      if (!definition) {
        return fail("verifier_execution_pack_readonly_input_coverage_mismatch");
      }
      return { root, definition };
    })
    .sort((left, right) =>
      compareUtf8(left.definition.input_id, right.definition.input_id));
  for (const { root, definition } of inputRoots) {
    plans.push({
      sourceKind: definition.input_type,
      inputId: definition.input_id,
      sourceRoot: root,
      packedRootPath: join(
        packRoot,
        "readonly",
        sha256(definition.input_id).slice(0, 24),
        "root",
      ),
      subjectPath: definition.subject_path ?? null,
    });
  }
  return plans;
}

function sourceMappings(
  manifest: VerifierProgramManifestV2,
  executablePath: string,
  plans: readonly RootCopyPlan[],
): readonly SourcePathMapping[] {
  const mappings: SourcePathMapping[] = [];
  for (const plan of plans) {
    const aliases = new Set([
      normalize(plan.sourceRoot.declared_path),
      normalize(plan.sourceRoot.resolved_path),
    ]);
    for (const entry of plan.sourceRoot.entries) {
      const packed = entryPackedPath(
        plan.packedRootPath,
        entry.relative_path,
      );
      for (const rootAlias of aliases) {
        const source = entry.relative_path === "."
          ? rootAlias
          : resolve(rootAlias, entry.relative_path);
        mappings.push({
          sourceKind: plan.sourceKind,
          sourcePath: normalize(source),
          packedPath: packed,
        });
      }
      mappings.push({
        sourceKind: plan.sourceKind,
        sourcePath: normalize(entry.path),
        packedPath: packed,
      });
    }
  }
  const unique = new Map<string, SourcePathMapping>();
  for (const mapping of mappings) {
    const prior = unique.get(mapping.sourcePath);
    if (
      prior
      && (
        prior.packedPath !== mapping.packedPath
        || prior.sourceKind !== mapping.sourceKind
      )
    ) {
      fail("verifier_execution_pack_source_mapping_ambiguous");
    }
    unique.set(mapping.sourcePath, mapping);
  }
  const executableSourcePath = normalize(manifest.executable.resolved_path);
  if (!unique.has(executableSourcePath)) {
    unique.set(executableSourcePath, {
      sourceKind: "executable",
      sourcePath: executableSourcePath,
      packedPath: executablePath,
    });
  }
  return [...unique.values()].sort((left, right) =>
    compareUtf8(left.sourcePath, right.sourcePath));
}

function resolveMappedPath(
  value: string,
  mappings: readonly SourcePathMapping[],
): SourcePathMapping | null {
  const normalized = normalize(value);
  const direct = mappings.find((mapping) => mapping.sourcePath === normalized);
  if (direct) return direct;
  return null;
}

function symlinkPackedTarget(
  plan: RootCopyPlan,
  entry: VerifierProgramMaterialEntryV1,
  destination: string,
  mappings: readonly SourcePathMapping[],
): string {
  if (entry.type !== "symlink" || entry.symlink_target === undefined) {
    return fail("verifier_execution_pack_symlink_descriptor_invalid");
  }
  const lexicalTarget = normalize(resolve(
    dirname(entry.path),
    entry.symlink_target,
  ));
  const mapped = resolveMappedPath(lexicalTarget, mappings);
  if (
    !mapped
    || mapped.sourceKind === "executable"
    || (
      plan.sourceKind === "program_material"
        ? mapped.sourceKind !== "program_material"
        : mapped.sourceKind === "program_material"
    )
  ) {
    return fail("verifier_execution_pack_symlink_target_not_lexically_declared");
  }
  const relation = relative(dirname(destination), mapped.packedPath);
  if (relation.length === 0) {
    return fail("verifier_execution_pack_symlink_target_invalid");
  }
  return relation;
}

function materializeRoot(
  plan: RootCopyPlan,
  mappings: readonly SourcePathMapping[],
): VerifierExecutionPackCopiedRootV1 {
  const entriesByDepth = [...plan.sourceRoot.entries]
    .sort((left, right) => {
      const leftDepth = left.relative_path === "."
        ? 0
        : left.relative_path.split(/[\\/]/u).length;
      const rightDepth = right.relative_path === "."
        ? 0
        : right.relative_path.split(/[\\/]/u).length;
      return leftDepth - rightDepth
        || compareUtf8(left.relative_path, right.relative_path);
    });

  for (const entry of entriesByDepth) {
    const destination = entryPackedPath(
      plan.packedRootPath,
      entry.relative_path,
    );
    expectedEntrySourcePath(plan.sourceRoot, entry);
    if (entry.type === "directory") {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      mkdirSync(destination, { recursive: false, mode: 0o700 });
    } else if (entry.type === "regular_file") {
      assertFileDescriptor(entry);
      copyRegularFile(entry.path, destination, {
        mode: entry.mode,
        byte_length: entry.byte_length,
        content_sha256: entry.content_sha256,
      }, immutablePackedMode(entry.mode));
    } else {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const target = symlinkPackedTarget(
        plan,
        entry,
        destination,
        mappings,
      );
      symlinkSync(target, destination);
      if (permissionMode(destination) !== entry.mode) {
        fail("verifier_execution_pack_copied_symlink_mode_mismatch");
      }
    }
  }
  for (const entry of [...entriesByDepth].reverse()) {
    if (entry.type !== "directory") continue;
    const destination = entryPackedPath(
      plan.packedRootPath,
      entry.relative_path,
    );
    chmodSync(destination, immutablePackedMode(entry.mode));
  }

  const copiedEntries = entriesByDepth.map((entry) => {
    const destination = entryPackedPath(
      plan.packedRootPath,
      entry.relative_path,
    );
    if (entry.type === "regular_file") {
      assertFileDescriptor(entry);
      return {
        relative_path: entry.relative_path,
        type: "regular_file" as const,
        source_mode: entry.mode,
        mode: immutablePackedMode(entry.mode),
        byte_length: entry.byte_length,
        content_sha256: entry.content_sha256,
      };
    }
    if (entry.type === "directory") {
      return {
        relative_path: entry.relative_path,
        type: "directory" as const,
        source_mode: entry.mode,
        mode: immutablePackedMode(entry.mode),
      };
    }
    return {
      relative_path: entry.relative_path,
      type: "symlink" as const,
      source_mode: entry.mode,
      mode: entry.mode,
      symlink_target: readlinkSync(destination, "utf8"),
    };
  });
  return {
    source_kind: plan.sourceKind,
    input_id: plan.inputId,
    source_declared_path: plan.sourceRoot.declared_path,
    source_resolved_path: plan.sourceRoot.resolved_path,
    packed_root_path: plan.packedRootPath,
    root_type: plan.sourceRoot.root_type,
    subject_path: plan.subjectPath,
    entries: copiedEntries,
  };
}

function environmentEntries(
  environment: VerifierProgramRunnerConfig["environment"],
): readonly Readonly<{ key: string; value: string }>[] {
  if (environment === undefined) return [];
  const entries = Array.isArray(environment)
    ? [...environment]
    : Object.entries(environment).map(([key, value]) => ({ key, value }));
  const seen = new Set<string>();
  for (const { key, value } of entries) {
    if (
      typeof key !== "string"
      || key.length === 0
      || key.includes("\u0000")
      || key.includes("=")
      || typeof value !== "string"
      || value.includes("\u0000")
      || seen.has(key)
    ) {
      fail("verifier_execution_pack_environment_invalid");
    }
    seen.add(key);
  }
  return entries.sort((left, right) => compareUtf8(left.key, right.key));
}

function bindPathLiteral(
  input: string,
  mappings: readonly SourcePathMapping[],
): Readonly<{
  value: string;
  mapping: SourcePathMapping | null;
}> {
  if (input.startsWith("file://")) {
    let sourcePath: string;
    try {
      sourcePath = fileURLToPath(input);
    } catch {
      return fail("verifier_execution_pack_file_url_invalid");
    }
    const mapping = resolveMappedPath(sourcePath, mappings);
    if (
      !mapping
      && mappings.some((candidate) =>
        pathWithin(candidate.sourcePath, normalize(sourcePath)))
    ) {
      return fail("verifier_execution_pack_source_path_not_in_manifest");
    }
    return mapping
      ? { value: pathToFileURL(mapping.packedPath).href, mapping }
      : { value: input, mapping: null };
  }
  if (!isAbsolute(input)) return { value: input, mapping: null };
  const mapping = resolveMappedPath(input, mappings);
  if (
    !mapping
    && mappings.some((candidate) =>
      pathWithin(candidate.sourcePath, normalize(input)))
  ) {
    return fail("verifier_execution_pack_source_path_not_in_manifest");
  }
  return mapping
    ? { value: mapping.packedPath, mapping }
    : { value: input, mapping: null };
}

function bindEnvironmentComponent(
  input: string,
  mappings: readonly SourcePathMapping[],
): Readonly<{
  value: string;
  mapping: SourcePathMapping | null;
}> {
  const direct = bindPathLiteral(input, mappings);
  if (direct.mapping) return direct;
  const equals = input.indexOf("=");
  if (equals < 0 || equals >= input.length - 1) return direct;
  const prefix = input.slice(0, equals + 1);
  const suffix = input.slice(equals + 1);
  const resolved = bindPathLiteral(suffix, mappings);
  return resolved.mapping
    ? { value: `${prefix}${resolved.value}`, mapping: resolved.mapping }
    : direct;
}

function binding(
  location: VerifierExecutionPackPathBindingLocationV1,
  mapping: SourcePathMapping,
): VerifierExecutionPackPathBindingV1 {
  return {
    contract_version: "verifier_execution_pack_path_binding_v1",
    location,
    source_kind: mapping.sourceKind,
    source_path: mapping.sourcePath,
    packed_path: mapping.packedPath,
  };
}

function resolveRunner(
  runner: VerifierProgramRunnerConfig,
  subjectRoot: string,
  manifest: VerifierProgramManifestV2,
  executablePath: string,
  mappings: readonly SourcePathMapping[],
): VerifierExecutionPackRunnerResolutionV1 {
  const executableSource = realpathSync.native(
    exactAbsolutePath(
      runner.executable,
      "verifier_execution_pack_runner_executable_invalid",
    ),
  );
  if (executableSource !== manifest.executable.resolved_path) {
    return fail("verifier_execution_pack_runner_executable_identity_mismatch");
  }
  const pathBindings: VerifierExecutionPackPathBindingV1[] = [
    binding(
      { kind: "executable" },
      {
        sourceKind: "executable",
        sourcePath: manifest.executable.resolved_path,
        packedPath: executablePath,
      },
    ),
  ];
  const argv = runner.argv.map((argument, index) => {
    if (typeof argument !== "string" || argument.includes("\u0000")) {
      return fail("verifier_execution_pack_runner_argv_invalid");
    }
    const equals = argument.startsWith("-") ? argument.indexOf("=") : -1;
    const prefix = equals >= 0 ? argument.slice(0, equals + 1) : "";
    const literal = equals >= 0 ? argument.slice(equals + 1) : argument;
    let resolved = bindPathLiteral(literal, mappings);
    if (!resolved.mapping && !isAbsolute(literal) && !literal.startsWith("file://")) {
      const candidate = resolve(runner.cwd, literal);
      const candidateMapping = resolveMappedPath(candidate, mappings);
      if (candidateMapping) {
        resolved = {
          value: candidateMapping.packedPath,
          mapping: candidateMapping,
        };
      }
    }
    if (resolved.mapping) {
      pathBindings.push(binding(
        { kind: "argv", index },
        resolved.mapping,
      ));
    }
    return `${prefix}${resolved.value}`;
  });

  const environment: Record<string, string> = {};
  for (const { key, value } of environmentEntries(runner.environment)) {
    let components: string[];
    let joinWithDelimiter = false;
    if (
      value.includes(delimiter)
      && !value.startsWith("file://")
    ) {
      components = value.split(delimiter);
      joinWithDelimiter = true;
    } else {
      components = [value];
    }
    const resolvedComponents = components.map((component, componentIndex) => {
      const resolved = bindEnvironmentComponent(component, mappings);
      if (resolved.mapping) {
        pathBindings.push(binding(
          { kind: "environment", key, component_index: componentIndex },
          resolved.mapping,
        ));
      }
      return resolved.value;
    });
    environment[key] = joinWithDelimiter
      ? resolvedComponents.join(delimiter)
      : resolvedComponents[0]!;
  }
  return {
    contract_version: "verifier_execution_pack_runner_resolution_v1",
    executable: executablePath,
    argv,
    cwd: subjectRoot,
    environment,
    path_bindings: pathBindings,
  };
}

function assertAttachmentPathsDoNotOverlap(paths: readonly string[]): void {
  const sorted = [...paths].sort(compareUtf8);
  if (new Set(sorted).size !== sorted.length) {
    fail("verifier_execution_pack_subject_attachment_path_duplicate");
  }
  for (let index = 0; index < sorted.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < sorted.length; otherIndex += 1) {
      const left = sorted[index]!;
      const right = sorted[otherIndex]!;
      if (right.startsWith(`${left}/`) || left.startsWith(`${right}/`)) {
        fail("verifier_execution_pack_subject_attachment_path_overlap");
      }
    }
  }
}

function attachToSubject(
  subjectRoot: string,
  subjectPath: string,
  targetPath: string,
): Attachment {
  const segments = subjectPath.split("/");
  let parent = subjectRoot;
  const createdParentDirectories: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    if (pathEntryExists(parent)) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return fail("verifier_execution_pack_subject_attachment_parent_invalid");
      }
    } else {
      mkdirSync(parent, { mode: 0o700 });
      createdParentDirectories.push(parent);
    }
  }
  const attachmentPath = join(subjectRoot, ...segments);
  if (pathEntryExists(attachmentPath)) {
    return fail("verifier_execution_pack_subject_attachment_would_overwrite");
  }
  symlinkSync(targetPath, attachmentPath);
  return {
    subjectPath: attachmentPath,
    targetPath,
    createdParentDirectories,
    attached: true,
  };
}

function detachAuthenticPack(record: AuthenticPack): void {
  if (record.detached) return;
  for (const attachment of [...record.attachments].reverse()) {
    if (attachment.attached) {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(attachment.subjectPath);
      } catch {
        return fail("verifier_execution_pack_subject_attachment_missing");
      }
      if (
        !stat.isSymbolicLink()
        || readlinkSync(attachment.subjectPath, "utf8") !== attachment.targetPath
      ) {
        return fail("verifier_execution_pack_subject_attachment_modified");
      }
      unlinkSync(attachment.subjectPath);
      attachment.attached = false;
    }
    for (const parent of [...attachment.createdParentDirectories].reverse()) {
      if (!pathEntryExists(parent)) continue;
      if (readdirSync(parent).length !== 0) {
        return fail("verifier_execution_pack_subject_parent_not_restorable");
      }
      rmdirSync(parent);
    }
  }
  record.detached = true;
}

function makePackTreeOwnerRemovable(path: string): void {
  if (!pathEntryExists(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) {
    makePackTreeOwnerRemovable(join(path, name));
  }
}

function removePackRoot(packRoot: string): void {
  makePackTreeOwnerRemovable(packRoot);
  rmSync(packRoot, { recursive: true, force: true });
}

function verifyCopiedRoot(root: VerifierExecutionPackCopiedRootV1): void {
  const expectedPaths = new Set(
    root.entries.map((entry) => entry.relative_path),
  );
  const actualPaths = new Set<string>();
  const visit = (absolutePath: string, relativePath: string): void => {
    actualPaths.add(relativePath);
    const stat = lstatSync(absolutePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const name of readdirSync(absolutePath).sort(compareUtf8)) {
      visit(
        join(absolutePath, name),
        relativePath === "." ? name : join(relativePath, name),
      );
    }
  };
  try {
    visit(root.packed_root_path, ".");
  } catch {
    return fail("verifier_execution_pack_root_missing_or_unreadable");
  }
  if (
    actualPaths.size !== expectedPaths.size
    || [...actualPaths].some((path) => !expectedPaths.has(path))
  ) {
    fail("verifier_execution_pack_root_manifest_mismatch");
  }
  for (const entry of root.entries) {
    const path = entryPackedPath(root.packed_root_path, entry.relative_path);
    if (entry.type === "regular_file") {
      verifyRegularFile(path, {
        mode: entry.mode,
        byte_length: entry.byte_length!,
        content_sha256: entry.content_sha256!,
      }, "verifier_execution_pack_modified");
    } else if (entry.type === "directory") {
      verifyDirectory(path, entry.mode, "verifier_execution_pack_modified");
    } else {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(path);
      } catch {
        return fail("verifier_execution_pack_modified");
      }
      if (
        !stat.isSymbolicLink()
        || (stat.mode & 0o7777) !== entry.mode
        || readlinkSync(path, "utf8") !== entry.symlink_target
      ) {
        fail("verifier_execution_pack_modified");
      }
      let target: string;
      try {
        target = realpathSync.native(path);
      } catch {
        return fail("verifier_execution_pack_modified");
      }
      if (!pathWithin(dirname(dirname(root.packed_root_path)), target)) {
        fail("verifier_execution_pack_symlink_escaped_pack");
      }
    }
  }
}

function verifyPackNamespace(record: AuthenticPack): void {
  const expected = new Set<string>([
    record.packRoot,
    record.scratchRoot,
  ]);
  for (const root of record.copiedRoots) {
    let cursor = root.packed_root_path;
    while (pathWithin(record.packRoot, cursor)) {
      expected.add(cursor);
      if (cursor === record.packRoot) break;
      cursor = dirname(cursor);
    }
    for (const entry of root.entries) {
      expected.add(entryPackedPath(
        root.packed_root_path,
        entry.relative_path,
      ));
    }
  }
  const actual = new Set<string>();
  const visit = (path: string): void => {
    actual.add(path);
    if (path === record.scratchRoot) return;
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const name of readdirSync(path)) visit(join(path, name));
  };
  try {
    visit(record.packRoot);
  } catch {
    return fail("verifier_execution_pack_namespace_unreadable");
  }
  if (
    actual.size !== expected.size
    || [...actual].some((path) => !expected.has(path))
  ) {
    fail("verifier_execution_pack_namespace_modified");
  }
}

export function assertVerifierExecutionPackUnchanged(
  pack: VerifierExecutionPackV1,
): void {
  const record = AUTHENTIC_PACKS.get(pack);
  if (!record || record.cleaned) {
    fail("verifier_execution_pack_not_authentic_or_cleaned");
  }
  verifyRegularFile(
    record.executable.packed_path,
    record.executable,
    "verifier_execution_pack_modified",
  );
  verifyPackNamespace(record);
  for (const root of record.copiedRoots) verifyCopiedRoot(root);
  for (const attachment of record.attachments) {
    if (!attachment.attached) continue;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(attachment.subjectPath);
    } catch {
      return fail("verifier_execution_pack_subject_attachment_missing");
    }
    if (
      !stat.isSymbolicLink()
      || readlinkSync(attachment.subjectPath, "utf8") !== attachment.targetPath
    ) {
      fail("verifier_execution_pack_subject_attachment_modified");
    }
  }
}

export function detachVerifierExecutionPack(
  pack: VerifierExecutionPackV1,
): void {
  const record = AUTHENTIC_PACKS.get(pack);
  if (!record || record.cleaned) {
    fail("verifier_execution_pack_not_authentic_or_cleaned");
  }
  detachAuthenticPack(record);
}

export function cleanupVerifierExecutionPack(
  pack: VerifierExecutionPackV1,
): void {
  const record = AUTHENTIC_PACKS.get(pack);
  if (!record) {
    fail("verifier_execution_pack_not_authentic_or_cleaned");
  }
  if (record.cleaned) return;
  detachAuthenticPack(record);
  removePackRoot(record.packRoot);
  record.cleaned = true;
}

export function materializeVerifierExecutionPack(
  input: MaterializeVerifierExecutionPackInput,
): VerifierExecutionPackV1 {
  const invocationId = exactId(
    input.invocation_id,
    "verifier_execution_pack_invocation_id_invalid",
  );
  const manifest = validateProgramIdentity(input.program_identity);
  const subjectRootInput = exactAbsolutePath(
    input.subject_root,
    "verifier_execution_pack_subject_root_invalid",
  );
  let subjectRoot: string;
  try {
    const stat = lstatSync(subjectRootInput);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return fail("verifier_execution_pack_subject_root_invalid");
    }
    subjectRoot = realpathSync.native(subjectRootInput);
  } catch (error) {
    if (error instanceof VerifierExecutionPackError) throw error;
    return fail("verifier_execution_pack_subject_root_invalid");
  }
  const readonlyDefinitions = readonlyInputDefinitions(
    manifest,
    input.readonly_inputs,
  );
  const scratchDefinitions = canonicalScratchOverlays(
    input.scratch_overlays ?? [],
  );
  const baseDirectoryInput = input.base_directory === undefined
    ? tmpdir()
    : exactAbsolutePath(
        input.base_directory,
        "verifier_execution_pack_base_directory_invalid",
      );
  let baseDirectory: string;
  try {
    const stat = lstatSync(baseDirectoryInput);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return fail("verifier_execution_pack_base_directory_invalid");
    }
    baseDirectory = realpathSync.native(baseDirectoryInput);
  } catch (error) {
    if (error instanceof VerifierExecutionPackError) throw error;
    return fail("verifier_execution_pack_base_directory_invalid");
  }

  const packId = `vep_${sha256(stableStringify({
    contract: "verifier_execution_pack_id_v1",
    invocation_id: invocationId,
    verifier_program_digest: input.program_identity.verifier_program_digest,
    nonce: randomUUID(),
  }))}`;
  const packRoot = mkdtempSync(join(baseDirectory, "aionis-verifier-pack-"));
  chmodSync(packRoot, 0o700);
  const attachments: Attachment[] = [];
  let publicPack: VerifierExecutionPackV1 | undefined;
  try {
    for (const protectedRoot of [
      subjectRoot,
      manifest.executable.resolved_path,
      ...manifest.material_roots.map((root) => root.resolved_path),
      ...manifest.immutable_input_roots.map((root) => root.resolved_path),
    ]) {
      if (
        pathWithin(protectedRoot, packRoot)
        || pathWithin(packRoot, protectedRoot)
      ) {
        return fail("verifier_execution_pack_root_overlap");
      }
    }
    // The executable is identity-pinned but intentionally not relocated.
    // System runtimes such as Python and signed platform binaries are commonly
    // non-relocatable; copying them can hang or change their runtime closure.
    // Program material and declared inputs remain invocation-private.
    const executablePath = manifest.executable.resolved_path;
    assertFileDescriptor(manifest.executable);
    verifyRegularFile(
      executablePath,
      manifest.executable,
      "verifier_execution_pack_executable_identity_drift",
    );
    const plans = rootPlans(packRoot, manifest, readonlyDefinitions);
    const mappings = sourceMappings(manifest, executablePath, plans);
    const copiedRoots = deepFreeze(plans.map((plan) =>
      materializeRoot(plan, mappings)));

    const scratchRoot = join(packRoot, "scratch");
    mkdirSync(scratchRoot, { mode: 0o700 });
    const scratchOverlays = deepFreeze(scratchDefinitions
      .map((definition) => {
        const scratchPath = join(
          scratchRoot,
          "overlays",
          sha256(definition.overlay_id).slice(0, 24),
        );
        mkdirSync(scratchPath, { recursive: true, mode: 0o700 });
        return {
          overlay_id: definition.overlay_id,
          scratch_path: scratchPath,
          subject_path: definition.subject_path ?? null,
          attached_subject_path: definition.subject_path === undefined
            ? null
            : join(subjectRoot, ...definition.subject_path.split("/")),
        } satisfies VerifierExecutionPackScratchOverlayResultV1;
      }));

    const attachmentPlans = [
      ...copiedRoots
        .filter((root) => root.subject_path !== null)
        .map((root) => ({
          subjectPath: root.subject_path!,
          targetPath: root.packed_root_path,
        })),
      ...scratchOverlays
        .filter((overlay) => overlay.subject_path !== null)
        .map((overlay) => ({
          subjectPath: overlay.subject_path!,
          targetPath: overlay.scratch_path,
        })),
    ];
    assertAttachmentPathsDoNotOverlap(
      attachmentPlans.map((plan) => plan.subjectPath),
    );
    for (const plan of attachmentPlans) {
      attachments.push(attachToSubject(
        subjectRoot,
        plan.subjectPath,
        plan.targetPath,
      ));
    }

    const runnerResolution = deepFreeze(resolveRunner(
      input.runner_config,
      subjectRoot,
      manifest,
      executablePath,
      mappings,
    ));
    const executable = {
      source_path: manifest.executable.resolved_path,
      packed_path: executablePath,
      source_mode: manifest.executable.mode,
      mode: manifest.executable.mode,
      byte_length: manifest.executable.byte_length,
      content_sha256: manifest.executable.content_sha256,
    } as const;
    const packManifest = deepFreeze<VerifierExecutionPackManifestV1>({
      contract_version: "verifier_execution_pack_manifest_v1",
      pack_id: packId,
      invocation_id: invocationId,
      verifier_program_digest: input.program_identity.verifier_program_digest,
      executable,
      copied_roots: copiedRoots,
      scratch_overlays: scratchOverlays,
      path_bindings: runnerResolution.path_bindings,
      runner_resolution_sha256:
        verifierExecutionPackRunnerResolutionDigest(runnerResolution),
    });
    const manifestSha256 = verifierExecutionPackManifestDigest(packManifest);
    const record: AuthenticPack = {
      packRoot,
      scratchRoot,
      executable,
      copiedRoots,
      attachments,
      detached: false,
      cleaned: false,
    };
    publicPack = Object.freeze({
      contract_version: "verifier_execution_pack_v1",
      pack_id: packId,
      invocation_id: invocationId,
      pack_root: packRoot,
      subject_root: subjectRoot,
      executable_path: executablePath,
      copied_roots: copiedRoots,
      scratch_root: scratchRoot,
      scratch_overlays: scratchOverlays,
      runner_resolution: runnerResolution,
      manifest: packManifest,
      manifest_sha256: manifestSha256,
      detach(): void {
        detachVerifierExecutionPack(publicPack!);
      },
      cleanup(): void {
        cleanupVerifierExecutionPack(publicPack!);
      },
    });
    AUTHENTIC_PACKS.set(publicPack, record);
    assertVerifierExecutionPackUnchanged(publicPack);
    return publicPack;
  } catch (error) {
    if (publicPack) {
      AUTHENTIC_PACKS.delete(publicPack);
    }
    for (const attachment of [...attachments].reverse()) {
      if (!attachment.attached) continue;
      try {
        if (
          lstatSync(attachment.subjectPath).isSymbolicLink()
          && readlinkSync(attachment.subjectPath, "utf8")
            === attachment.targetPath
        ) {
          unlinkSync(attachment.subjectPath);
          attachment.attached = false;
        }
        for (const parent of [...attachment.createdParentDirectories].reverse()) {
          if (pathEntryExists(parent) && readdirSync(parent).length === 0) {
            rmdirSync(parent);
          }
        }
      } catch {
        // Preserve the original failure. Best-effort rollback never deletes an
        // unknown replacement at an attachment path.
      }
    }
    try {
      removePackRoot(packRoot);
    } catch {
      // Preserve the original materialization failure.
    }
    throw error;
  }
}
