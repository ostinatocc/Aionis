import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";

import stableStringify from "fast-json-stable-stringify";

import {
  assertLiteRuntimeProtectedFilesystemNoDelegatedAccessControlList,
  assertLiteRuntimeProtectedFilesystemTrustedDirectoryChain,
} from "./lite-runtime-protected-authority-database.js";

const ROOT_MANIFEST_NAME = ".aionis-deployment-authority-root-v1.json";
const ROOT_MANIFEST_CONTRACT_VERSION =
  "aionis_lite_runtime_deployment_authority_root_manifest_v1" as const;
const PATH_LAYOUT = "sha256_sharded_v1" as const;
const SLOT_DIGEST_DOMAIN = Buffer.from(
  "aionis:lite-runtime:deployment-slot-path:v1\0",
  "utf8",
);
const MAX_SLOT_UTF8_BYTES = 256;
const MAX_MANIFEST_BYTES = 16 * 1024;

export type LiteRuntimeDeploymentSlotPathAuthorityErrorCode =
  | "lite_runtime_deployment_slot_path_authority_absolute_path_required"
  | "lite_runtime_deployment_slot_path_authority_platform_unsupported"
  | "lite_runtime_deployment_slot_path_authority_filesystem_untrusted"
  | "lite_runtime_deployment_slot_path_authority_recovery_required"
  | "lite_runtime_deployment_slot_path_authority_manifest_invalid"
  | "lite_runtime_deployment_slot_path_authority_manifest_digest_mismatch"
  | "lite_runtime_deployment_slot_path_authority_identity_changed"
  | "lite_runtime_deployment_slot_path_authority_root_capability_invalid"
  | "lite_runtime_deployment_slot_path_authority_root_capability_closed"
  | "lite_runtime_deployment_slot_path_authority_root_capability_in_use"
  | "lite_runtime_deployment_slot_path_authority_slot_invalid"
  | "lite_runtime_deployment_slot_path_authority_slot_capability_invalid"
  | "lite_runtime_deployment_slot_path_authority_retention_capability_invalid"
  | "lite_runtime_deployment_slot_path_authority_retention_capability_released";

export class LiteRuntimeDeploymentSlotPathAuthorityError extends Error {
  readonly code: LiteRuntimeDeploymentSlotPathAuthorityErrorCode;

  constructor(
    code: LiteRuntimeDeploymentSlotPathAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LiteRuntimeDeploymentSlotPathAuthorityError";
    this.code = code;
  }
}

function pathAuthorityError(
  code: LiteRuntimeDeploymentSlotPathAuthorityErrorCode,
  message: string,
): never {
  throw new LiteRuntimeDeploymentSlotPathAuthorityError(code, message);
}

const rootBrand: unique symbol = Symbol(
  "lite-runtime-deployment-slot-path-authority-root",
);
const slotPathBrand: unique symbol = Symbol(
  "lite-runtime-deployment-slot-path-capability",
);
const retentionBrand: unique symbol = Symbol(
  "lite-runtime-deployment-slot-path-retention-capability",
);

/** Opaque configured-root authority for one pinned deployment root. */
export type LiteRuntimeDeploymentSlotPathAuthorityRootCapability = Readonly<{
  [rootBrand]: "aionis_lite_runtime_deployment_slot_path_authority_root_v1";
}>;

/** Opaque deterministic path binding for one exact UTF-8 deployment slot. */
export type LiteRuntimeDeploymentSlotPathCapability = Readonly<{
  [slotPathBrand]: "aionis_lite_runtime_deployment_slot_path_capability_v1";
}>;

/** @internal Keeps the pinned root live for one authority lease lifecycle. */
export type LiteRuntimeDeploymentSlotPathRetentionCapability = Readonly<{
  [retentionBrand]:
    "aionis_lite_runtime_deployment_slot_path_retention_capability_v1";
}>;

type RootManifestV1 = Readonly<{
  contract_version: typeof ROOT_MANIFEST_CONTRACT_VERSION;
  root_instance_id: string;
  root_realpath: string;
  root_device: string;
  root_inode: string;
  path_layout: typeof PATH_LAYOUT;
  created_at: string;
}>;

export type LiteRuntimeDeploymentSlotPathAuthorityRootInspection = Readonly<{
  contract_version:
    "aionis_lite_runtime_deployment_slot_path_authority_root_inspection_v1";
  authority_scope: "configured_deployment_authority_root_v1";
  signing_eligible: false;
  root_path: string;
  root_realpath: string;
  root_device: string;
  root_inode: string;
  root_instance_id: string;
  root_manifest_path: string;
  root_manifest_sha256: string;
  path_layout: typeof PATH_LAYOUT;
  trusted_launcher_root_selection: "required_not_established";
  filesystem_locking_verification: "required_not_established";
}>;

export type LiteRuntimeDeploymentSlotPathInspection = Readonly<{
  contract_version:
    "aionis_lite_runtime_deployment_slot_path_inspection_v1";
  authority_scope: "configured_root_deterministic_slot_path_v1";
  signing_eligible: false;
  deployment_slot: string;
  root_path: string;
  root_realpath: string;
  root_instance_id: string;
  root_manifest_sha256: string;
  path_layout: typeof PATH_LAYOUT;
  slot_sha256: string;
  slot_directory_path: string;
  authority_state_path: string;
  lease_carrier_path: string;
  authority_state_relative_path: string;
  lease_carrier_relative_path: string;
  slot_path_mapping_sha256: string;
  trusted_launcher_root_selection: "required_not_established";
  slot_provisioning_recovery: "required_not_established";
  filesystem_locking_verification: "required_not_established";
  isolated_carrier_lock_process: "required_not_established";
}>;

type RootState = {
  readonly rootPath: string;
  readonly rootRealpath: string;
  readonly rootDescriptor: number;
  readonly rootDevice: bigint;
  readonly rootInode: bigint;
  readonly serviceUid: bigint;
  readonly manifestPath: string;
  readonly manifestDevice: bigint;
  readonly manifestInode: bigint;
  readonly manifestSha256: string;
  readonly manifestJson: string;
  readonly manifest: RootManifestV1;
  readonly inspection: LiteRuntimeDeploymentSlotPathAuthorityRootInspection;
  activeRetentions: number;
  closed: boolean;
};

type SlotPathState = Readonly<{
  rootState: RootState;
  deploymentSlot: string;
  inspection: LiteRuntimeDeploymentSlotPathInspection;
}>;

type RetentionState = {
  readonly rootState: RootState;
  released: boolean;
};

const rootRegistry = new WeakMap<object, RootState>();
const slotPathRegistry = new WeakMap<object, SlotPathState>();
const retentionRegistry = new WeakMap<object, RetentionState>();

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeDescriptorBestEffort(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the path-authority error that caused cleanup.
  }
}

function requiredFlag(name: "O_DIRECTORY" | "O_NOFOLLOW" | "O_EXCL"): number {
  const value = fsConstants[name];
  if (typeof value !== "number") {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_platform_unsupported",
      `deployment-slot path authority requires ${name}`,
    );
  }
  return value;
}

function currentServiceUid(): bigint {
  if (typeof process.getuid !== "function") {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_platform_unsupported",
      "deployment-slot path authority requires a verifiable service UID",
    );
  }
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_platform_unsupported",
      "deployment-slot path authority received an unsafe service UID",
    );
  }
  return BigInt(uid);
}

function requireCanonicalAbsoluteRoot(rootPath: unknown): string {
  if (typeof rootPath !== "string" || rootPath.length === 0 || !isAbsolute(rootPath)) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_absolute_path_required",
      "deployment-slot authority root must be an absolute path",
    );
  }
  let rootRealpath: string;
  try {
    rootRealpath = realpathSync(rootPath);
  } catch {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
      "deployment-slot authority root must already exist",
    );
  }
  if (rootRealpath !== rootPath) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
      "deployment-slot authority root must be canonical and must not traverse a symbolic link",
    );
  }
  return rootRealpath;
}

function assertTrustedDirectoryStat(
  path: string,
  expectedUid: bigint,
  code:
    | "lite_runtime_deployment_slot_path_authority_filesystem_untrusted"
    | "lite_runtime_deployment_slot_path_authority_identity_changed",
): BigIntStats {
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch {
    return pathAuthorityError(code, "deployment-slot authority directory is unavailable");
  }
  if (!stat.isDirectory()
    || stat.uid !== expectedUid
    || (stat.mode & 0o7777n) !== 0o700n) {
    return pathAuthorityError(
      code,
      "deployment-slot authority directories must be owner-controlled mode 0700 directories",
    );
  }
  try {
    if (realpathSync(path) !== path) {
      return pathAuthorityError(
        code,
        "deployment-slot authority directory path is no longer canonical",
      );
    }
    assertLiteRuntimeProtectedFilesystemTrustedDirectoryChain(
      join(path, ".aionis-directory-chain-probe"),
      expectedUid,
    );
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotPathAuthorityError) throw error;
    return pathAuthorityError(
      code,
      "deployment-slot authority directory ACL or ancestor chain is untrusted",
    );
  }
  return stat;
}

function assertCanonicalTime(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      "deployment-slot root manifest requires a valid creation time",
    );
  }
  return value.toISOString();
}

function assertCanonicalManifestTime(value: unknown): string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      "deployment-slot root manifest creation time is not canonical",
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      "deployment-slot root manifest creation time is invalid",
    );
  }
  return value;
}

function assertLowerHexDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      `deployment-slot path authority requires a canonical ${label}`,
    );
  }
  return value;
}

function assertDecimalIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      `deployment-slot root manifest ${label} is invalid`,
    );
  }
  return value;
}

function decodeCanonicalManifest(raw: Buffer): Readonly<{
  json: string;
  manifest: RootManifestV1;
}> {
  if (raw.byteLength === 0 || raw.byteLength > MAX_MANIFEST_BYTES) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      "deployment-slot root manifest size is invalid",
    );
  }
  let json: string;
  let parsed: unknown;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    parsed = JSON.parse(json) as unknown;
  } catch {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      "deployment-slot root manifest is not strict UTF-8 JSON",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      "deployment-slot root manifest must be an object",
    );
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    "contract_version",
    "created_at",
    "path_layout",
    "root_device",
    "root_inode",
    "root_instance_id",
    "root_realpath",
  ];
  if (stableStringify(Object.keys(record).sort()) !== stableStringify(expectedKeys)
    || stableStringify(record) !== json
    || record.contract_version !== ROOT_MANIFEST_CONTRACT_VERSION
    || record.path_layout !== PATH_LAYOUT
    || typeof record.root_realpath !== "string"
    || !isAbsolute(record.root_realpath)
    || typeof record.created_at !== "string") {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      "deployment-slot root manifest is not the exact canonical v1 object",
    );
  }
  const manifest = Object.freeze({
    contract_version: ROOT_MANIFEST_CONTRACT_VERSION,
    root_instance_id: assertLowerHexDigest(record.root_instance_id, "root instance ID"),
    root_realpath: record.root_realpath,
    root_device: assertDecimalIdentity(record.root_device, "root device"),
    root_inode: assertDecimalIdentity(record.root_inode, "root inode"),
    path_layout: PATH_LAYOUT,
    created_at: assertCanonicalManifestTime(record.created_at),
  });
  return Object.freeze({ json, manifest });
}

function readAndVerifyManifestFile(args: Readonly<{
  manifestPath: string;
  serviceUid: bigint;
  expectedDevice?: bigint;
  expectedInode?: bigint;
  expectedSha256: string;
}>): Readonly<{
  stat: BigIntStats;
  sha256: string;
  json: string;
  manifest: RootManifestV1;
}> {
  let before: BigIntStats;
  try {
    before = lstatSync(args.manifestPath, { bigint: true });
  } catch {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_identity_changed",
      "deployment-slot root manifest is unavailable",
    );
  }
  if (!before.isFile()
    || before.uid !== args.serviceUid
    || before.nlink !== 1n
    || (before.mode & 0o7777n) !== 0o600n
    || (args.expectedDevice !== undefined && before.dev !== args.expectedDevice)
    || (args.expectedInode !== undefined && before.ino !== args.expectedInode)) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_identity_changed",
      "deployment-slot root manifest physical identity or mode changed",
    );
  }
  let descriptor: number | null = null;
  let raw: Buffer;
  try {
    descriptor = openSync(
      args.manifestPath,
      fsConstants.O_RDONLY | requiredFlag("O_NOFOLLOW"),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, opened)
      || opened.uid !== before.uid
      || opened.mode !== before.mode
      || opened.nlink !== before.nlink) {
      return pathAuthorityError(
        "lite_runtime_deployment_slot_path_authority_identity_changed",
        "deployment-slot root manifest changed while opening",
      );
    }
    raw = readFileSync(descriptor);
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotPathAuthorityError) throw error;
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_identity_changed",
      "deployment-slot root manifest could not be read safely",
    );
  } finally {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
  }
  try {
    assertLiteRuntimeProtectedFilesystemNoDelegatedAccessControlList(
      args.manifestPath,
      "receipt",
    );
  } catch {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
      "deployment-slot root manifest has delegated access control",
    );
  }
  const after = lstatSync(args.manifestPath, { bigint: true });
  if (!sameIdentity(before, after)
    || after.uid !== before.uid
    || after.mode !== before.mode
    || after.nlink !== before.nlink) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_identity_changed",
      "deployment-slot root manifest changed during inspection",
    );
  }
  const actualSha256 = sha256(raw);
  if (actualSha256 !== args.expectedSha256) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_digest_mismatch",
      "deployment-slot root manifest digest does not match the pinned digest",
    );
  }
  const decoded = decodeCanonicalManifest(raw);
  return Object.freeze({
    stat: after,
    sha256: actualSha256,
    json: decoded.json,
    manifest: decoded.manifest,
  });
}

function createRootManifest(
  rootRealpath: string,
  rootStat: BigIntStats,
  serviceUid: bigint,
  createdAt: Date,
  randomBytesFactory: (size: number) => Uint8Array,
): Readonly<{ manifestPath: string; json: string; sha256: string }> {
  const manifestPath = join(rootRealpath, ROOT_MANIFEST_NAME);
  const rootInstanceBytes = randomBytesFactory(32);
  if (!(rootInstanceBytes instanceof Uint8Array)
    || rootInstanceBytes.byteLength !== 32) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      "deployment-slot root instance ID requires exactly 32 random bytes",
    );
  }
  const manifest: RootManifestV1 = Object.freeze({
    contract_version: ROOT_MANIFEST_CONTRACT_VERSION,
    root_instance_id: Buffer.from(rootInstanceBytes).toString("hex"),
    root_realpath: rootRealpath,
    root_device: rootStat.dev.toString(10),
    root_inode: rootStat.ino.toString(10),
    path_layout: PATH_LAYOUT,
    created_at: assertCanonicalTime(createdAt),
  });
  const json = stableStringify(manifest);
  const bytes = Buffer.from(json, "utf8");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      manifestPath,
      fsConstants.O_CREAT
        | requiredFlag("O_EXCL")
        | fsConstants.O_WRONLY
        | requiredFlag("O_NOFOLLOW"),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    const written = writeSync(descriptor, bytes, 0, bytes.byteLength, 0);
    if (written !== bytes.byteLength) {
      return pathAuthorityError(
        "lite_runtime_deployment_slot_path_authority_recovery_required",
        "deployment-slot root manifest write was incomplete",
      );
    }
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()
      || stat.uid !== serviceUid
      || stat.nlink !== 1n
      || (stat.mode & 0o7777n) !== 0o600n) {
      return pathAuthorityError(
        "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
        "deployment-slot root manifest was not created as an owner-controlled mode 0600 file",
      );
    }
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotPathAuthorityError) throw error;
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot root manifest creation failed; explicit recovery is required",
    );
  } finally {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
  }
  syncDirectory(rootRealpath);
  return Object.freeze({ manifestPath, json, sha256: sha256(bytes) });
}

function openPinnedRoot(
  rootPath: string,
  expectedRootManifestSha256: string,
): LiteRuntimeDeploymentSlotPathAuthorityRootCapability {
  const rootRealpath = requireCanonicalAbsoluteRoot(rootPath);
  const serviceUid = currentServiceUid();
  const before = assertTrustedDirectoryStat(
    rootRealpath,
    serviceUid,
    "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      rootRealpath,
      fsConstants.O_RDONLY
        | requiredFlag("O_DIRECTORY")
        | requiredFlag("O_NOFOLLOW"),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, opened)
      || !opened.isDirectory()
      || opened.uid !== serviceUid
      || (opened.mode & 0o7777n) !== 0o700n) {
      return pathAuthorityError(
        "lite_runtime_deployment_slot_path_authority_identity_changed",
        "deployment-slot authority root changed while opening",
      );
    }
    const manifestPath = join(rootRealpath, ROOT_MANIFEST_NAME);
    const verified = readAndVerifyManifestFile({
      manifestPath,
      serviceUid,
      expectedSha256: expectedRootManifestSha256,
    });
    if (verified.manifest.root_realpath !== rootRealpath
      || verified.manifest.root_device !== opened.dev.toString(10)
      || verified.manifest.root_inode !== opened.ino.toString(10)) {
      return pathAuthorityError(
        "lite_runtime_deployment_slot_path_authority_manifest_invalid",
        "deployment-slot root manifest does not bind the opened root identity",
      );
    }
    const inspection = Object.freeze({
      contract_version:
        "aionis_lite_runtime_deployment_slot_path_authority_root_inspection_v1" as const,
      authority_scope: "configured_deployment_authority_root_v1" as const,
      signing_eligible: false as const,
      root_path: rootPath,
      root_realpath: rootRealpath,
      root_device: opened.dev.toString(10),
      root_inode: opened.ino.toString(10),
      root_instance_id: verified.manifest.root_instance_id,
      root_manifest_path: manifestPath,
      root_manifest_sha256: verified.sha256,
      path_layout: PATH_LAYOUT,
      trusted_launcher_root_selection: "required_not_established" as const,
      filesystem_locking_verification: "required_not_established" as const,
    });
    const capability = Object.freeze({}) as LiteRuntimeDeploymentSlotPathAuthorityRootCapability;
    rootRegistry.set(capability, {
      rootPath,
      rootRealpath,
      rootDescriptor: descriptor,
      rootDevice: opened.dev,
      rootInode: opened.ino,
      serviceUid,
      manifestPath,
      manifestDevice: verified.stat.dev,
      manifestInode: verified.stat.ino,
      manifestSha256: verified.sha256,
      manifestJson: verified.json,
      manifest: verified.manifest,
      inspection,
      activeRetentions: 0,
      closed: false,
    });
    descriptor = null;
    return capability;
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotPathAuthorityError) throw error;
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
      "deployment-slot authority root could not be opened safely",
    );
  } finally {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
  }
}

function rootStateFromCapability(
  capability: LiteRuntimeDeploymentSlotPathAuthorityRootCapability,
): RootState {
  if (!capability || typeof capability !== "object") {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_root_capability_invalid",
      "deployment-slot path authority root capability is invalid",
    );
  }
  const state = rootRegistry.get(capability);
  if (!state) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_root_capability_invalid",
      "deployment-slot path authority root capability is forged or foreign",
    );
  }
  if (state.closed) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_root_capability_closed",
      "deployment-slot path authority root capability is closed",
    );
  }
  return state;
}

function reverifyRootState(state: RootState): void {
  if (state.closed) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_root_capability_closed",
      "deployment-slot path authority root capability is closed",
    );
  }
  let opened: BigIntStats;
  try {
    opened = fstatSync(state.rootDescriptor, { bigint: true });
  } catch {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_identity_changed",
      "deployment-slot authority root descriptor is no longer valid",
    );
  }
  const pathStat = assertTrustedDirectoryStat(
    state.rootRealpath,
    state.serviceUid,
    "lite_runtime_deployment_slot_path_authority_identity_changed",
  );
  if (opened.dev !== state.rootDevice
    || opened.ino !== state.rootInode
    || !sameIdentity(opened, pathStat)
    || opened.uid !== state.serviceUid
    || (opened.mode & 0o7777n) !== 0o700n) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_identity_changed",
      "deployment-slot authority root physical identity changed",
    );
  }
  const verified = readAndVerifyManifestFile({
    manifestPath: state.manifestPath,
    serviceUid: state.serviceUid,
    expectedDevice: state.manifestDevice,
    expectedInode: state.manifestInode,
    expectedSha256: state.manifestSha256,
  });
  if (verified.json !== state.manifestJson
    || stableStringify(verified.manifest) !== stableStringify(state.manifest)
    || verified.manifest.root_realpath !== state.rootRealpath
    || verified.manifest.root_device !== state.rootDevice.toString(10)
    || verified.manifest.root_inode !== state.rootInode.toString(10)) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_manifest_invalid",
      "deployment-slot root manifest no longer matches the pinned root contract",
    );
  }
}

function assertDeploymentSlot(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /\p{Cc}/u.test(value)
    || Buffer.from(value, "utf8").toString("utf8") !== value) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_slot_invalid",
      "deployment slot must be exact, trimmed, valid UTF-8 without control characters",
    );
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_SLOT_UTF8_BYTES) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_slot_invalid",
      "deployment slot must contain 1..256 UTF-8 bytes",
    );
  }
  return value;
}

function buildSlotInspection(
  rootState: RootState,
  deploymentSlot: string,
): LiteRuntimeDeploymentSlotPathInspection {
  const slotSha256 = sha256(Buffer.concat([
    SLOT_DIGEST_DOMAIN,
    Buffer.from(deploymentSlot, "utf8"),
  ]));
  const slotDirectoryRelativePath = `slots/v1/${slotSha256.slice(0, 2)}/${slotSha256}`;
  const authorityStateRelativePath = `${slotDirectoryRelativePath}/state.sqlite`;
  const leaseCarrierRelativePath = `${authorityStateRelativePath}.lease`;
  const mappingProjection = Object.freeze({
    contract_version:
      "aionis_lite_runtime_deployment_slot_path_mapping_v1" as const,
    root_instance_id: rootState.manifest.root_instance_id,
    root_manifest_sha256: rootState.manifestSha256,
    slot_sha256: slotSha256,
    path_layout: PATH_LAYOUT,
    authority_state_relative_path: authorityStateRelativePath,
    lease_carrier_relative_path: leaseCarrierRelativePath,
  });
  return Object.freeze({
    contract_version:
      "aionis_lite_runtime_deployment_slot_path_inspection_v1" as const,
    authority_scope: "configured_root_deterministic_slot_path_v1" as const,
    signing_eligible: false as const,
    deployment_slot: deploymentSlot,
    root_path: rootState.rootPath,
    root_realpath: rootState.rootRealpath,
    root_instance_id: rootState.manifest.root_instance_id,
    root_manifest_sha256: rootState.manifestSha256,
    path_layout: PATH_LAYOUT,
    slot_sha256: slotSha256,
    slot_directory_path: join(rootState.rootRealpath, slotDirectoryRelativePath),
    authority_state_path: join(rootState.rootRealpath, authorityStateRelativePath),
    lease_carrier_path: join(rootState.rootRealpath, leaseCarrierRelativePath),
    authority_state_relative_path: authorityStateRelativePath,
    lease_carrier_relative_path: leaseCarrierRelativePath,
    slot_path_mapping_sha256: sha256(stableStringify(mappingProjection)),
    trusted_launcher_root_selection: "required_not_established" as const,
    slot_provisioning_recovery: "required_not_established" as const,
    filesystem_locking_verification: "required_not_established" as const,
    isolated_carrier_lock_process: "required_not_established" as const,
  });
}

function slotStateFromCapability(
  capability: LiteRuntimeDeploymentSlotPathCapability,
): SlotPathState {
  if (!capability || typeof capability !== "object") {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_slot_capability_invalid",
      "deployment-slot path capability is invalid",
    );
  }
  const state = slotPathRegistry.get(capability);
  if (!state) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_slot_capability_invalid",
      "deployment-slot path capability is forged or foreign",
    );
  }
  reverifyRootState(state.rootState);
  const expected = buildSlotInspection(state.rootState, state.deploymentSlot);
  if (stableStringify(expected) !== stableStringify(state.inspection)) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_slot_capability_invalid",
      "deployment-slot path capability no longer matches its deterministic projection",
    );
  }
  return state;
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | requiredFlag("O_DIRECTORY") | requiredFlag("O_NOFOLLOW"),
    );
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotPathAuthorityError) throw error;
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot authority directory durability sync failed",
    );
  } finally {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object"
      && (error as { code?: unknown }).code === "ENOENT") return false;
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot authority path could not be inspected safely",
    );
  }
}

function ensureSharedDirectory(
  path: string,
  parentPath: string,
  rootState: RootState,
): void {
  if (!pathExists(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
      syncDirectory(path);
      syncDirectory(parentPath);
    } catch (error) {
      if (error instanceof LiteRuntimeDeploymentSlotPathAuthorityError) throw error;
      if (!pathExists(path)) {
        return pathAuthorityError(
          "lite_runtime_deployment_slot_path_authority_recovery_required",
          "deployment-slot authority shared path creation failed",
        );
      }
    }
  }
  assertTrustedDirectoryStat(
    path,
    rootState.serviceUid,
    "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
  );
  reverifyRootState(rootState);
}

function assertOptionalCanonicalAuthorityFile(
  path: string,
  serviceUid: bigint,
): void {
  if (!pathExists(path)) return;
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile()
    || stat.uid !== serviceUid
    || stat.nlink !== 1n
    || (stat.mode & 0o077n) !== 0n) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot authority artifact path is non-canonical or untrusted",
    );
  }
  let realpath: string;
  try {
    realpath = realpathSync(path);
  } catch {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot authority artifact path cannot be resolved canonically",
    );
  }
  if (realpath !== path) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot authority artifact path is redirected",
    );
  }
}

/**
 * Creates the immutable v1 root manifest and returns only its bootstrap
 * inspection. Operational use must separately reopen the configured root with
 * the exact manifest digest; provisioning does not mint a live root authority.
 */
export function provisionLiteRuntimeDeploymentSlotPathAuthorityRoot(args: Readonly<{
  rootPath: string;
  now?: Date;
  randomBytesFactory?: (size: number) => Uint8Array;
}>): LiteRuntimeDeploymentSlotPathAuthorityRootInspection {
  const rootRealpath = requireCanonicalAbsoluteRoot(args.rootPath);
  const serviceUid = currentServiceUid();
  const rootStat = assertTrustedDirectoryStat(
    rootRealpath,
    serviceUid,
    "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
  );
  let initialEntries: string[];
  try {
    initialEntries = readdirSync(rootRealpath);
  } catch {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
      "deployment-slot authority root could not be enumerated safely",
    );
  }
  if (initialEntries.length !== 0) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot authority root must be empty before manifest provisioning",
    );
  }
  const created = createRootManifest(
    rootRealpath,
    rootStat,
    serviceUid,
    args.now ?? new Date(),
    args.randomBytesFactory ?? randomBytes,
  );
  let provisionedEntries: string[];
  try {
    provisionedEntries = readdirSync(rootRealpath);
  } catch {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot authority root changed after manifest provisioning",
    );
  }
  if (provisionedEntries.length !== 1
    || provisionedEntries[0] !== ROOT_MANIFEST_NAME) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot authority root gained an unexpected object during provisioning",
    );
  }
  const capability = openPinnedRoot(rootRealpath, created.sha256);
  try {
    return inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(capability);
  } finally {
    closeLiteRuntimeDeploymentSlotPathAuthorityRoot(capability);
  }
}

/** Reopens a configured root only with its expected manifest digest. */
export function openLiteRuntimeDeploymentSlotPathAuthorityRoot(args: Readonly<{
  rootPath: string;
  expectedRootManifestSha256: string;
}>): LiteRuntimeDeploymentSlotPathAuthorityRootCapability {
  const expected = assertLowerHexDigest(
    args.expectedRootManifestSha256,
    "root manifest SHA-256",
  );
  return openPinnedRoot(args.rootPath, expected);
}

export function closeLiteRuntimeDeploymentSlotPathAuthorityRoot(
  capability: LiteRuntimeDeploymentSlotPathAuthorityRootCapability,
): void {
  const state = rootStateFromCapability(capability);
  if (state.activeRetentions !== 0) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_root_capability_in_use",
      "deployment-slot authority root cannot close while an authority lease retains it",
    );
  }
  state.closed = true;
  try {
    closeSync(state.rootDescriptor);
  } catch {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_identity_changed",
      "deployment-slot authority root descriptor could not be closed",
    );
  }
}

/** @internal Retains the root descriptor until the authority lease is closed. */
export function retainLiteRuntimeDeploymentSlotPathCapability(
  capability: LiteRuntimeDeploymentSlotPathCapability,
): LiteRuntimeDeploymentSlotPathRetentionCapability {
  const state = slotStateFromCapability(capability);
  if (!Number.isSafeInteger(state.rootState.activeRetentions)
    || state.rootState.activeRetentions >= Number.MAX_SAFE_INTEGER) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_root_capability_in_use",
      "deployment-slot authority root retention count is exhausted",
    );
  }
  state.rootState.activeRetentions += 1;
  const retention = Object.freeze({}) as
    LiteRuntimeDeploymentSlotPathRetentionCapability;
  retentionRegistry.set(retention, {
    rootState: state.rootState,
    released: false,
  });
  return retention;
}

/** @internal Releases exactly one authority-lease root retention. */
export function releaseLiteRuntimeDeploymentSlotPathRetention(
  capability: LiteRuntimeDeploymentSlotPathRetentionCapability,
): void {
  if (!capability || typeof capability !== "object") {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_retention_capability_invalid",
      "deployment-slot path retention capability is invalid",
    );
  }
  const state = retentionRegistry.get(capability);
  if (!state) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_retention_capability_invalid",
      "deployment-slot path retention capability is forged or foreign",
    );
  }
  if (state.released) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_retention_capability_released",
      "deployment-slot path retention capability is already released",
    );
  }
  if (!Number.isSafeInteger(state.rootState.activeRetentions)
    || state.rootState.activeRetentions <= 0) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_retention_capability_invalid",
      "deployment-slot authority root retention state is invalid",
    );
  }
  state.rootState.activeRetentions -= 1;
  state.released = true;
}

export function inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(
  capability: LiteRuntimeDeploymentSlotPathAuthorityRootCapability,
): LiteRuntimeDeploymentSlotPathAuthorityRootInspection {
  const state = rootStateFromCapability(capability);
  reverifyRootState(state);
  return state.inspection;
}

export function deriveLiteRuntimeDeploymentSlotPathCapability(
  rootCapability: LiteRuntimeDeploymentSlotPathAuthorityRootCapability,
  deploymentSlot: string,
): LiteRuntimeDeploymentSlotPathCapability {
  const rootState = rootStateFromCapability(rootCapability);
  reverifyRootState(rootState);
  const exactSlot = assertDeploymentSlot(deploymentSlot);
  const inspection = buildSlotInspection(rootState, exactSlot);
  const capability = Object.freeze({}) as LiteRuntimeDeploymentSlotPathCapability;
  slotPathRegistry.set(capability, Object.freeze({
    rootState,
    deploymentSlot: exactSlot,
    inspection,
  }));
  return capability;
}

export function assertLiteRuntimeDeploymentSlotPathCapability(
  capability: LiteRuntimeDeploymentSlotPathCapability,
): LiteRuntimeDeploymentSlotPathInspection {
  return slotStateFromCapability(capability).inspection;
}

export function inspectLiteRuntimeDeploymentSlotPathCapability(
  capability: LiteRuntimeDeploymentSlotPathCapability,
): LiteRuntimeDeploymentSlotPathInspection {
  return slotStateFromCapability(capability).inspection;
}

/**
 * Exclusively creates the one digest-named slot directory. Any pre-existing
 * object at that exact name is ambiguous and therefore requires recovery.
 */
export function prepareLiteRuntimeDeploymentSlotPathForProvisioning(
  capability: LiteRuntimeDeploymentSlotPathCapability,
): LiteRuntimeDeploymentSlotPathInspection {
  const state = slotStateFromCapability(capability);
  const root = state.rootState.rootRealpath;
  const slots = join(root, "slots");
  const version = join(slots, "v1");
  const shard = join(version, state.inspection.slot_sha256.slice(0, 2));
  ensureSharedDirectory(slots, root, state.rootState);
  ensureSharedDirectory(version, slots, state.rootState);
  ensureSharedDirectory(shard, version, state.rootState);
  try {
    mkdirSync(state.inspection.slot_directory_path, { mode: 0o700 });
    chmodSync(state.inspection.slot_directory_path, 0o700);
  } catch {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot directory already exists or could not be created exclusively; explicit recovery is required",
    );
  }
  assertTrustedDirectoryStat(
    state.inspection.slot_directory_path,
    state.rootState.serviceUid,
    "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
  );
  syncDirectory(state.inspection.slot_directory_path);
  syncDirectory(shard);
  return assertLiteRuntimeDeploymentSlotPathProvisioned(capability);
}

/** Revalidates the pinned root, exact slot directory, and canonical file paths. */
export function assertLiteRuntimeDeploymentSlotPathProvisioned(
  capability: LiteRuntimeDeploymentSlotPathCapability,
): LiteRuntimeDeploymentSlotPathInspection {
  const state = slotStateFromCapability(capability);
  const slotStat = assertTrustedDirectoryStat(
    state.inspection.slot_directory_path,
    state.rootState.serviceUid,
    "lite_runtime_deployment_slot_path_authority_filesystem_untrusted",
  );
  if (dirname(state.inspection.authority_state_path)
      !== state.inspection.slot_directory_path
    || state.inspection.lease_carrier_path
      !== `${state.inspection.authority_state_path}.lease`
    || slotStat.dev !== state.rootState.rootDevice) {
    return pathAuthorityError(
      "lite_runtime_deployment_slot_path_authority_recovery_required",
      "deployment-slot authority paths are no longer rooted in the pinned slot directory",
    );
  }
  assertOptionalCanonicalAuthorityFile(
    state.inspection.authority_state_path,
    state.rootState.serviceUid,
  );
  assertOptionalCanonicalAuthorityFile(
    state.inspection.lease_carrier_path,
    state.rootState.serviceUid,
  );
  reverifyRootState(state.rootState);
  return state.inspection;
}
