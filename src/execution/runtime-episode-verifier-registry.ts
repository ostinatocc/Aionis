import stableStringify from "fast-json-stable-stringify";
import { realpathSync } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  VerifierKindV1Schema,
  type VerifierInvocationV1,
} from "../memory/execution-episode.js";
import { sha256Hex } from "../util/crypto.js";
import {
  assertAuthenticEpisodeVerifierExecution,
  canonicalEpisodeVerifierRunnerConfig,
  episodeVerifierRunnerConfigDigest,
  runEpisodeVerifier,
  type CanonicalEpisodeVerifierRunnerConfigV1,
  type EpisodeVerifierRunnerConfig,
  type EpisodeVerifierRunnerResultV1,
} from "./episode-verifier-runner.js";
import {
  assertAuthenticRuntimeEpisodeVerifierInvocationAuthority,
  consumeRuntimeEpisodeVerifierInvocationAuthority,
  type RuntimeEpisodeVerifierInvocationAuthorityV1,
  type RuntimeEpisodeVerifierInvocationAuthorityVerifier,
} from "./runtime-episode-verifier-launch-authority.js";
import {
  assertAuthenticVerifierSubjectMaterialization,
  assertVerifierSubjectUnchanged,
  type VerifierSubjectMaterializationV1,
} from "./verifier-subject-materialization.js";
import {
  assertVerifierExecutionPackUnchanged,
  materializeVerifierExecutionPack,
  verifierExecutionPackManifestDigest,
  type VerifierExecutionPackManifestV1,
  type VerifierExecutionPackReadonlyInputV1,
  type VerifierExecutionPackReadonlyInputTypeV1,
  type VerifierExecutionPackRunnerResolutionV1,
  type VerifierExecutionPackScratchOverlayV1,
  type VerifierExecutionPackV1,
} from "./verifier-execution-pack.js";
import {
  assertPrimaryVerifierArgvMaterialCoverage,
  assertPrimaryVerifierEnvironmentImmutableInputCoverage,
  captureVerifierProgramIdentity,
  VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS,
  type VerifierProgramIdentityV2,
} from "./verifier-program-identity.js";

const MAX_VERIFIER_ID_BYTES = 256;
const MAX_VERIFIER_VERSION_BYTES = 120;
const MAX_VERIFIER_ISSUER_ID_BYTES = 256;
const MAX_VERIFIER_MATERIAL_PATH_BYTES = 16 * 1024;

export const RUNTIME_EPISODE_VERIFIER_DEFINITIONS_MAX_JSON_BYTES =
  512 * 1024;
export const RUNTIME_EPISODE_VERIFIER_DEFINITIONS_MAX_ENTRIES = 64;

export const RUNTIME_EPISODE_VERIFIER_SUBJECT_ROOT_ENV =
  "AIONIS_VERIFIER_SUBJECT_ROOT";
export const RUNTIME_EPISODE_VERIFIER_SCRATCH_ROOT_ENV =
  "AIONIS_VERIFIER_SCRATCH_ROOT";

const RUNTIME_OWNED_VERIFIER_ENVIRONMENT_KEYS = new Set([
  RUNTIME_EPISODE_VERIFIER_SUBJECT_ROOT_ENV,
  RUNTIME_EPISODE_VERIFIER_SCRATCH_ROOT_ENV,
  "AIONIS_VERIFIER_EPISODE_ID",
  "AIONIS_VERIFIER_INVOCATION_ID",
  "AIONIS_VERIFIER_INVOCATION_DIGEST",
  "AIONIS_VERIFIER_LAUNCH_ATTEMPT_ID",
  "AIONIS_VERIFIER_MATERIALIZATION_ID",
  "AIONIS_VERIFIER_SOURCE_CONTENT_DIGEST",
  "AIONIS_VERIFIER_SOURCE_ENVIRONMENT_DIGEST",
  "AIONIS_VERIFIER_SUBJECT_IDENTITY_DIGEST",
  "HOME",
  "PWD",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

const DEFINITION_INPUT_KEYS = new Set([
  "verifier_id",
  "verifier_kind",
  "verifier_version",
  "verifier_issuer_id",
  "reward_role",
  "verifier_material_paths",
  "readonly_inputs",
  "scratch_overlays",
  "runner_config",
]);

const READONLY_INPUT_KEYS = new Set([
  "contract_version",
  "input_id",
  "input_type",
  "source_path",
  "subject_path",
]);

const SCRATCH_OVERLAY_KEYS = new Set([
  "contract_version",
  "overlay_id",
  "subject_path",
]);

const RUNNER_CONFIG_INPUT_KEYS = new Set([
  "executable",
  "argv",
  "cwd",
  "environment",
  "infrastructure_exit_codes",
  "timeout_ms",
  "terminate_grace_ms",
  "max_stdout_bytes",
  "max_stderr_bytes",
]);

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type RuntimeEpisodeVerifierKindV1 =
  VerifierInvocationV1["verifier_kind"];

export type RuntimeEpisodeVerifierRewardRoleV1 =
  | "primary"
  | "diagnostic";

export type RuntimeEpisodeVerifierReadonlyInputV1 = Readonly<{
  contract_version: "runtime_episode_verifier_readonly_input_v1";
  input_id: string;
  input_type: VerifierExecutionPackReadonlyInputTypeV1;
  source_path: string;
  subject_path?: string;
}>;

export type RuntimeEpisodeVerifierScratchOverlayV1 = Readonly<{
  contract_version: "runtime_episode_verifier_scratch_overlay_v1";
  overlay_id: string;
  subject_path?: string;
}>;

export type RuntimeEpisodeVerifierDefinitionInput = Readonly<{
  verifier_id: string;
  verifier_kind: RuntimeEpisodeVerifierKindV1;
  verifier_version: string;
  verifier_issuer_id: string;
  reward_role: RuntimeEpisodeVerifierRewardRoleV1;
  verifier_material_paths: readonly string[];
  readonly_inputs?: readonly RuntimeEpisodeVerifierReadonlyInputV1[];
  scratch_overlays?: readonly RuntimeEpisodeVerifierScratchOverlayV1[];
  runner_config: EpisodeVerifierRunnerConfig;
}>;

export type RuntimeEpisodeVerifierDefinitionV1 = Readonly<{
  contract_version: "runtime_episode_verifier_definition_v1";
  verifier_id: string;
  verifier_kind: RuntimeEpisodeVerifierKindV1;
  verifier_version: string;
  verifier_issuer_id: string;
  reward_role: RuntimeEpisodeVerifierRewardRoleV1;
  verifier_material_paths: readonly string[];
  readonly_inputs: readonly RuntimeEpisodeVerifierReadonlyInputV1[];
  scratch_overlays: readonly RuntimeEpisodeVerifierScratchOverlayV1[];
  runner_config: DeepReadonly<CanonicalEpisodeVerifierRunnerConfigV1>;
}>;

export type RuntimeEpisodeVerifierDefinitionIdentityV1 = Readonly<{
  contract_version: "runtime_episode_verifier_definition_identity_v1";
  verifier_id: string;
  verifier_kind: RuntimeEpisodeVerifierKindV1;
  verifier_version: string;
  verifier_issuer_id: string;
  reward_role: RuntimeEpisodeVerifierRewardRoleV1;
  verifier_config_digest: string;
  verifier_program_digest: string;
  definition_sha256: string;
}>;

export type RuntimeEpisodeVerifierRegistryEntryV1 = Readonly<{
  definition: DeepReadonly<RuntimeEpisodeVerifierDefinitionV1>;
  identity: DeepReadonly<RuntimeEpisodeVerifierDefinitionIdentityV1>;
  program_identity: DeepReadonly<VerifierProgramIdentityV2>;
}>;

export type RuntimeEpisodeVerifierLaunchIdentityV1 = Readonly<{
  contract_version: "runtime_episode_verifier_launch_identity_v1";
  launch_attempt_id: string;
  episode_id: string;
  verifier_invocation_id: string;
  verifier_invocation_digest: string;
  invocation_authority_sha256: string;
  invocation_authority_channel_id: string;
  materialization_id: string;
  source_content_digest: string;
  source_environment_digest: string;
  subject_identity_sha256: string;
  subject_view_content_digest: string;
  subject_view_environment_digest: string;
  verifier_id: string;
  verifier_definition_sha256: string;
  verifier_program_digest: string;
  verifier_config_digest: string;
  execution_pack_manifest_sha256: string;
  verifier_environment_digest: string;
  resolved_config_digest: string;
  resolved_environment_digest: string;
  result_sha256: string;
  effective_status: EpisodeVerifierRunnerResultV1["status"];
  infrastructure_failure_reasons: readonly string[];
  launch_sha256: string;
}>;

export type RuntimeEpisodeVerifierLaunchV1 = Readonly<{
  contract_version: "runtime_episode_verifier_launch_v1";
  definition_identity: DeepReadonly<RuntimeEpisodeVerifierDefinitionIdentityV1>;
  execution_pack_manifest: DeepReadonly<VerifierExecutionPackManifestV1>;
  launch_identity: DeepReadonly<RuntimeEpisodeVerifierLaunchIdentityV1>;
  /**
   * The Runtime-owned semantic result. Post-launch verifier-program or
   * materialized-subject drift always reclassifies this to infrastructure
   * error, even when the child process exited zero.
   */
  effective_status: EpisodeVerifierRunnerResultV1["status"];
  infrastructure_failure_reasons: readonly string[];
  /**
   * This is the original object minted by runEpisodeVerifier. It is
   * deliberately not cloned so downstream authority checks retain the
   * process-local authenticity capability.
   */
  result: EpisodeVerifierRunnerResultV1;
}>;

/**
 * Fully resolved, secret-free launch material that must be made durable
 * before the registry consumes the invocation authority or starts a process.
 */
export type RuntimeEpisodeVerifierPreparedLaunchV1 = Readonly<{
  contract_version: "runtime_episode_verifier_prepared_launch_v1";
  launch_attempt_id: string;
  episode_id: string;
  verifier_invocation_id: string;
  verifier_invocation_digest: string;
  invocation_authority_sha256: string;
  invocation_authority_channel_id: string;
  materialization_id: string;
  materialized_subject_root: string;
  materialized_scratch_root: string;
  source_content_digest: string;
  source_environment_digest: string;
  subject_identity_sha256: string;
  subject_view_content_digest: string;
  subject_view_environment_digest: string;
  verifier_id: string;
  verifier_definition_sha256: string;
  verifier_program_digest: string;
  verifier_config_digest: string;
  verifier_environment_digest: string;
  execution_pack_manifest_sha256: string;
  resolved_config_digest: string;
  resolved_environment_digest: string;
}>;

export type RuntimeEpisodeVerifierSpawnObservationV1 = Readonly<{
  contract_version: "runtime_episode_verifier_spawn_observation_v1";
  launch_attempt_id: string;
  process_id: number;
  observed_at: string;
}>;

export type RuntimeEpisodeVerifierLaunchLifecycleV1 = Readonly<{
  launch_attempt_id: string;
  /**
   * This callback is the durable pre-spawn barrier. The process is never
   * started unless it resolves successfully.
   */
  persist_prepared_launch(
    prepared: RuntimeEpisodeVerifierPreparedLaunchV1,
  ): Promise<void>;
  /**
   * This callback records the real child-process `spawn` observation. A
   * persistence failure is reflected in the final launch as infrastructure
   * failure; it cannot turn a child result into success.
   */
  persist_spawn_observation(
    observation: RuntimeEpisodeVerifierSpawnObservationV1,
  ): Promise<void>;
}>;

export type RuntimeEpisodeVerifierRegistry = Readonly<{
  registry_status: "unregistered" | "registered";
  identities: readonly DeepReadonly<RuntimeEpisodeVerifierDefinitionIdentityV1>[];
  resolve(verifierId: string): RuntimeEpisodeVerifierRegistryEntryV1 | null;
  launch(
    authority: RuntimeEpisodeVerifierInvocationAuthorityV1,
    materialization: VerifierSubjectMaterializationV1,
    lifecycle: RuntimeEpisodeVerifierLaunchLifecycleV1,
  ): Promise<RuntimeEpisodeVerifierLaunchV1>;
  /**
   * Transitional compile-only overload for callers that have not yet wired
   * persisted invocation authority. It always rejects before process launch.
   */
  launch(verifierId: string): Promise<RuntimeEpisodeVerifierLaunchV1>;
}>;

const AUTHENTIC_RUNTIME_EPISODE_VERIFIER_LAUNCHES = new WeakMap<
  RuntimeEpisodeVerifierLaunchV1,
  Readonly<{
    identity: DeepReadonly<RuntimeEpisodeVerifierDefinitionIdentityV1>;
    launchIdentity: DeepReadonly<RuntimeEpisodeVerifierLaunchIdentityV1>;
    authorityVerifier:
      RuntimeEpisodeVerifierInvocationAuthorityVerifier;
    executionPackManifest: DeepReadonly<VerifierExecutionPackManifestV1>;
    result: EpisodeVerifierRunnerResultV1;
  }>
>();

export class RuntimeEpisodeVerifierLaunchInfrastructureError extends Error {
  readonly code: string;
  readonly status = "infrastructure_error" as const;

  constructor(code: string) {
    super(code);
    this.name = "RuntimeEpisodeVerifierLaunchInfrastructureError";
    this.code = code;
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function assertExactBoundedString(
  value: unknown,
  label: string,
  maxUtf8Bytes: number,
): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\u0000")
    || Buffer.byteLength(value, "utf8") > maxUtf8Bytes
  ) {
    throw new TypeError(
      `${label} must be non-empty, exact, NUL-free, and at most ${maxUtf8Bytes} UTF-8 bytes`,
    );
  }
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} cannot contain symbol keys`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length !== 0) {
    throw new TypeError(`${label} contains unknown keys: ${unknown.join(", ")}`);
  }
}

function assertRunnerConfigInput(
  value: unknown,
): asserts value is EpisodeVerifierRunnerConfig {
  assertPlainRecord(value, "Verifier runner config");
  assertOnlyKeys(value, RUNNER_CONFIG_INPUT_KEYS, "Verifier runner config");
  if (value.environment !== undefined) {
    assertPlainRecord(
      value.environment,
      "Verifier runner environment",
    );
  }
}

function runnerInputFromCanonical(
  config: DeepReadonly<CanonicalEpisodeVerifierRunnerConfigV1>,
): EpisodeVerifierRunnerConfig {
  return {
    executable: config.executable,
    argv: [...config.argv],
    cwd: config.cwd,
    environment: Object.fromEntries(
      config.environment.map(({ key, value }) => [key, value]),
    ),
    infrastructure_exit_codes: [...config.infrastructure_exit_codes],
    timeout_ms: config.timeout_ms,
    terminate_grace_ms: config.terminate_grace_ms,
    max_stdout_bytes: config.max_stdout_bytes,
    max_stderr_bytes: config.max_stderr_bytes,
  };
}

function launchInfrastructureFailure(code: string): never {
  throw new RuntimeEpisodeVerifierLaunchInfrastructureError(code);
}

function pathIsWithin(root: string, candidate: string): boolean {
  let cursor = resolve(candidate);
  const missingSegments: string[] = [];
  while (true) {
    try {
      cursor = resolve(
        realpathSync.native(cursor),
        ...missingSegments,
      );
      break;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
  const fromRoot = relative(root, cursor);
  return (
    fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    )
  );
}

function valueReferencesLiveSubjectRoot(
  value: string,
  sourceSubjectRoot: string,
): boolean {
  if (value.includes(sourceSubjectRoot)) return true;
  if (isAbsolute(value) && pathIsWithin(sourceSubjectRoot, value)) {
    return true;
  }
  const equalsIndex = value.indexOf("=");
  if (equalsIndex >= 0) {
    const suffix = value.slice(equalsIndex + 1);
    if (
      suffix.includes(sourceSubjectRoot)
      || (isAbsolute(suffix) && pathIsWithin(sourceSubjectRoot, suffix))
    ) {
      return true;
    }
  }
  for (const pathListEntry of value.split(delimiter)) {
    if (
      isAbsolute(pathListEntry)
      && pathIsWithin(sourceSubjectRoot, pathListEntry)
    ) {
      return true;
    }
  }
  return false;
}

function assertStaticDefinitionDoesNotEscapeToLiveSubject(
  definition: DeepReadonly<RuntimeEpisodeVerifierDefinitionV1>,
  sourceSubjectRoot: string,
): void {
  for (const argument of definition.runner_config.argv) {
    if (valueReferencesLiveSubjectRoot(argument, sourceSubjectRoot)) {
      throw new Error(
        "runtime_episode_verifier_live_subject_path_in_argv_forbidden",
      );
    }
  }
  for (const { key, value } of definition.runner_config.environment) {
    if (RUNTIME_OWNED_VERIFIER_ENVIRONMENT_KEYS.has(key)) {
      throw new Error(
        "runtime_episode_verifier_runtime_owned_environment_override_forbidden",
      );
    }
    if (valueReferencesLiveSubjectRoot(value, sourceSubjectRoot)) {
      throw new Error(
        "runtime_episode_verifier_live_subject_path_in_environment_forbidden",
      );
    }
  }
}

function runtimeOwnedVerifierEnvironment(
  authority: ReturnType<
    typeof assertAuthenticRuntimeEpisodeVerifierInvocationAuthority
  >,
  materialization: ReturnType<
    typeof assertAuthenticVerifierSubjectMaterialization
  >,
  scratchRoot: string,
  launchAttemptId: string,
): Readonly<Record<string, string>> {
  return {
    [RUNTIME_EPISODE_VERIFIER_SUBJECT_ROOT_ENV]:
      materialization.subjectRoot,
    [RUNTIME_EPISODE_VERIFIER_SCRATCH_ROOT_ENV]:
      scratchRoot,
    AIONIS_VERIFIER_EPISODE_ID: authority.episodeId,
    AIONIS_VERIFIER_INVOCATION_ID: authority.verifierInvocationId,
    AIONIS_VERIFIER_INVOCATION_DIGEST:
      authority.verifierInvocationDigest,
    AIONIS_VERIFIER_LAUNCH_ATTEMPT_ID: launchAttemptId,
    AIONIS_VERIFIER_MATERIALIZATION_ID: materialization.materializationId,
    AIONIS_VERIFIER_SOURCE_CONTENT_DIGEST:
      authority.sourceContentDigest,
    AIONIS_VERIFIER_SOURCE_ENVIRONMENT_DIGEST:
      authority.sourceEnvironmentDigest,
    AIONIS_VERIFIER_SUBJECT_IDENTITY_DIGEST:
      authority.subjectIdentity.identity_sha256,
    HOME: scratchRoot,
    PWD: materialization.subjectRoot,
    TEMP: scratchRoot,
    TMP: scratchRoot,
    TMPDIR: scratchRoot,
  };
}

function resolvedRunnerInput(
  definition: DeepReadonly<RuntimeEpisodeVerifierDefinitionV1>,
  executionPack: VerifierExecutionPackV1,
  authority: ReturnType<
    typeof assertAuthenticRuntimeEpisodeVerifierInvocationAuthority
  >,
  materialization: ReturnType<
    typeof assertAuthenticVerifierSubjectMaterialization
  >,
  launchAttemptId: string,
): EpisodeVerifierRunnerConfig {
  const base = runnerInputFromCanonical(definition.runner_config);
  const resolution: VerifierExecutionPackRunnerResolutionV1 =
    executionPack.runner_resolution;
  return {
    ...base,
    executable: resolution.executable,
    argv: [...resolution.argv],
    cwd: resolution.cwd,
    environment: {
      ...resolution.environment,
      ...runtimeOwnedVerifierEnvironment(
        authority,
        materialization,
        executionPack.scratch_root,
        launchAttemptId,
      ),
    },
  };
}

type RuntimeEpisodeVerifierLaunchIdentityMaterialV1 = Omit<
  RuntimeEpisodeVerifierLaunchIdentityV1,
  "launch_sha256"
>;

export function runtimeEpisodeVerifierLaunchIdentityDigest(
  value: RuntimeEpisodeVerifierLaunchIdentityMaterialV1,
): string {
  return sha256Hex(stableStringify({
    contract: "runtime_episode_verifier_launch_identity_digest_v1",
    launch: value,
  }));
}

function resolvedEnvironmentDigest(
  config: CanonicalEpisodeVerifierRunnerConfigV1,
): string {
  return sha256Hex(stableStringify({
    contract: "runtime_episode_verifier_resolved_environment_digest_v1",
    environment: config.environment,
  }));
}

function canonicalVerifierMaterialPaths(
  value: unknown,
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length > VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS
  ) {
    throw new TypeError(
      `Runtime verifier material paths cannot exceed ${VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS} entries`,
    );
  }
  const paths = value.map((candidate, index) => {
    assertExactBoundedString(
      candidate,
      `Runtime verifier material path[${index}]`,
      MAX_VERIFIER_MATERIAL_PATH_BYTES,
    );
    if (!isAbsolute(candidate)) {
      throw new TypeError(
        `Runtime verifier material path[${index}] must be absolute`,
      );
    }
    return normalize(candidate);
  }).sort(canonicalUtf8Compare);
  if (new Set(paths).size !== paths.length) {
    throw new TypeError("Runtime verifier material paths must be unique");
  }
  return paths;
}

function canonicalVerifierContractId(
  value: unknown,
  label: string,
): string {
  assertExactBoundedString(value, label, MAX_VERIFIER_ID_BYTES);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new TypeError(`${label} has an invalid identifier format`);
  }
  return value;
}

function canonicalVerifierSubjectPath(
  value: unknown,
  label: string,
): string {
  assertExactBoundedString(value, label, MAX_VERIFIER_MATERIAL_PATH_BYTES);
  if (
    value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
  ) {
    throw new TypeError(`${label} must be a canonical subject-relative path`);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
    || segments[0] === ".git"
  ) {
    throw new TypeError(`${label} must be a canonical subject-relative path`);
  }
  return value;
}

function assertVerifierSubjectPathsDoNotOverlap(
  paths: readonly string[],
): void {
  const sorted = [...paths].sort(canonicalUtf8Compare);
  if (new Set(sorted).size !== sorted.length) {
    throw new TypeError("Runtime verifier subject attachment paths must be unique");
  }
  for (let index = 0; index < sorted.length; index += 1) {
    for (let other = index + 1; other < sorted.length; other += 1) {
      const left = sorted[index]!;
      const right = sorted[other]!;
      if (right.startsWith(`${left}/`) || left.startsWith(`${right}/`)) {
        throw new TypeError(
          "Runtime verifier subject attachment paths cannot overlap",
        );
      }
    }
  }
}

function canonicalVerifierReadonlyInputs(
  value: unknown,
): readonly RuntimeEpisodeVerifierReadonlyInputV1[] {
  if (
    value === undefined
    || !Array.isArray(value)
    || value.length > VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS
  ) {
    throw new TypeError(
      `Runtime verifier readonly inputs must be an array of at most ${VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS} entries`,
    );
  }
  const ids = new Set<string>();
  const sourcePaths = new Set<string>();
  const inputs = value.map((
    candidate,
    index,
  ): RuntimeEpisodeVerifierReadonlyInputV1 => {
    assertPlainRecord(candidate, `Runtime verifier readonly input[${index}]`);
    assertOnlyKeys(
      candidate,
      READONLY_INPUT_KEYS,
      `Runtime verifier readonly input[${index}]`,
    );
    if (
      candidate.contract_version
      !== "runtime_episode_verifier_readonly_input_v1"
    ) {
      throw new TypeError(
        `Runtime verifier readonly input[${index}] has an invalid contract version`,
      );
    }
    const inputId = canonicalVerifierContractId(
      candidate.input_id,
      `Runtime verifier readonly input[${index}] ID`,
    );
    if (ids.has(inputId)) {
      throw new TypeError("Runtime verifier readonly input IDs must be unique");
    }
    ids.add(inputId);
    const inputType = candidate.input_type;
    if (inputType !== "dependency" && inputType !== "oracle") {
      throw new TypeError(
        `Runtime verifier readonly input[${index}] type must be dependency or oracle`,
      );
    }
    assertExactBoundedString(
      candidate.source_path,
      `Runtime verifier readonly input[${index}] source path`,
      MAX_VERIFIER_MATERIAL_PATH_BYTES,
    );
    if (!isAbsolute(candidate.source_path)) {
      throw new TypeError(
        `Runtime verifier readonly input[${index}] source path must be absolute`,
      );
    }
    const sourcePath = normalize(candidate.source_path);
    if (sourcePaths.has(sourcePath)) {
      throw new TypeError(
        "Runtime verifier readonly input source paths must be unique",
      );
    }
    sourcePaths.add(sourcePath);
    const subjectPath = candidate.subject_path === undefined
      ? undefined
      : canonicalVerifierSubjectPath(
          candidate.subject_path,
          `Runtime verifier readonly input[${index}] subject path`,
        );
    return {
      contract_version: "runtime_episode_verifier_readonly_input_v1" as const,
      input_id: inputId,
      input_type: inputType,
      source_path: sourcePath,
      ...(subjectPath === undefined ? {} : { subject_path: subjectPath }),
    };
  }).sort((left, right) =>
    canonicalUtf8Compare(left.input_id, right.input_id));
  return inputs;
}

function canonicalVerifierScratchOverlays(
  value: unknown,
): readonly RuntimeEpisodeVerifierScratchOverlayV1[] {
  if (value === undefined || !Array.isArray(value)) {
    throw new TypeError("Runtime verifier scratch overlays must be an array");
  }
  const ids = new Set<string>();
  const overlays = value.map((
    candidate,
    index,
  ): RuntimeEpisodeVerifierScratchOverlayV1 => {
    assertPlainRecord(candidate, `Runtime verifier scratch overlay[${index}]`);
    assertOnlyKeys(
      candidate,
      SCRATCH_OVERLAY_KEYS,
      `Runtime verifier scratch overlay[${index}]`,
    );
    if (
      candidate.contract_version
      !== "runtime_episode_verifier_scratch_overlay_v1"
    ) {
      throw new TypeError(
        `Runtime verifier scratch overlay[${index}] has an invalid contract version`,
      );
    }
    const overlayId = canonicalVerifierContractId(
      candidate.overlay_id,
      `Runtime verifier scratch overlay[${index}] ID`,
    );
    if (ids.has(overlayId)) {
      throw new TypeError("Runtime verifier scratch overlay IDs must be unique");
    }
    ids.add(overlayId);
    const subjectPath = candidate.subject_path === undefined
      ? undefined
      : canonicalVerifierSubjectPath(
          candidate.subject_path,
          `Runtime verifier scratch overlay[${index}] subject path`,
        );
    return {
      contract_version: "runtime_episode_verifier_scratch_overlay_v1" as const,
      overlay_id: overlayId,
      ...(subjectPath === undefined ? {} : { subject_path: subjectPath }),
    };
  }).sort((left, right) =>
    canonicalUtf8Compare(left.overlay_id, right.overlay_id));
  return overlays;
}

export function canonicalRuntimeEpisodeVerifierDefinition(
  input: RuntimeEpisodeVerifierDefinitionInput,
): DeepReadonly<RuntimeEpisodeVerifierDefinitionV1> {
  assertPlainRecord(input, "Runtime verifier definition");
  assertOnlyKeys(input, DEFINITION_INPUT_KEYS, "Runtime verifier definition");
  assertExactBoundedString(
    input.verifier_id,
    "Runtime verifier ID",
    MAX_VERIFIER_ID_BYTES,
  );
  assertExactBoundedString(
    input.verifier_version,
    "Runtime verifier version",
    MAX_VERIFIER_VERSION_BYTES,
  );
  assertExactBoundedString(
    input.verifier_issuer_id,
    "Runtime verifier issuer ID",
    MAX_VERIFIER_ISSUER_ID_BYTES,
  );
  const verifierKind = VerifierKindV1Schema.parse(input.verifier_kind);
  if (input.reward_role !== "primary" && input.reward_role !== "diagnostic") {
    throw new TypeError(
      "Runtime verifier reward_role must be primary or diagnostic",
    );
  }
  if (
    input.reward_role === "primary"
    && verifierKind === "llm_judge_diagnostic"
  ) {
    throw new Error(
      "runtime_primary_verifier_cannot_be_llm_judge_diagnostic",
    );
  }
  if (
    verifierKind === "llm_judge_diagnostic"
    && input.reward_role !== "diagnostic"
  ) {
    throw new Error(
      "runtime_llm_judge_verifier_must_be_diagnostic_only",
    );
  }

  assertRunnerConfigInput(input.runner_config);
  const runnerConfig = canonicalEpisodeVerifierRunnerConfig(
    input.runner_config,
  );
  const verifierMaterialPaths = canonicalVerifierMaterialPaths(
    input.verifier_material_paths,
  );
  const readonlyInputs = canonicalVerifierReadonlyInputs(
    input.readonly_inputs ?? [],
  );
  const scratchOverlays = canonicalVerifierScratchOverlays(
    input.scratch_overlays ?? [],
  );
  if (
    verifierMaterialPaths.length + readonlyInputs.length
      > VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS
  ) {
    throw new TypeError(
      `Runtime verifier program and immutable inputs cannot exceed ${VERIFIER_PROGRAM_MAX_MATERIAL_ROOTS} total roots`,
    );
  }
  assertVerifierSubjectPathsDoNotOverlap([
    ...readonlyInputs.flatMap((item) =>
      item.subject_path === undefined ? [] : [item.subject_path]),
    ...scratchOverlays.flatMap((item) =>
      item.subject_path === undefined ? [] : [item.subject_path]),
  ]);
  return deepFreeze({
    contract_version: "runtime_episode_verifier_definition_v1",
    verifier_id: input.verifier_id,
    verifier_kind: verifierKind,
    verifier_version: input.verifier_version,
    verifier_issuer_id: input.verifier_issuer_id,
    reward_role: input.reward_role,
    verifier_material_paths: verifierMaterialPaths,
    readonly_inputs: readonlyInputs,
    scratch_overlays: scratchOverlays,
    runner_config: runnerConfig,
  });
}

export function runtimeEpisodeVerifierDefinitionDigest(
  input: RuntimeEpisodeVerifierDefinitionInput,
): string {
  return createRegistryEntry(input).identity.definition_sha256;
}

/**
 * Parses the Runtime-owned verifier manifest without ever reflecting raw JSON
 * or definition values into errors. The returned inputs have already passed
 * the canonical definition validator and are detached from the parsed JSON.
 */
export function parseRuntimeEpisodeVerifierDefinitionsJson(
  raw: string,
): readonly DeepReadonly<RuntimeEpisodeVerifierDefinitionInput>[] {
  if (typeof raw !== "string") {
    throw new TypeError(
      "AIONIS_EPISODE_VERIFIERS_JSON must be a JSON array",
    );
  }
  if (
    Buffer.byteLength(raw, "utf8")
    > RUNTIME_EPISODE_VERIFIER_DEFINITIONS_MAX_JSON_BYTES
  ) {
    throw new RangeError(
      "AIONIS_EPISODE_VERIFIERS_JSON exceeds the configured byte limit",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError(
      "AIONIS_EPISODE_VERIFIERS_JSON must be a valid JSON array",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(
      "AIONIS_EPISODE_VERIFIERS_JSON must be a JSON array",
    );
  }
  if (
    parsed.length
    > RUNTIME_EPISODE_VERIFIER_DEFINITIONS_MAX_ENTRIES
  ) {
    throw new RangeError(
      "AIONIS_EPISODE_VERIFIERS_JSON exceeds the verifier entry limit",
    );
  }

  const definitions = parsed.map((candidate, index) => {
    try {
      const canonical = canonicalRuntimeEpisodeVerifierDefinition(
        candidate as RuntimeEpisodeVerifierDefinitionInput,
      );
      return deepFreeze({
        verifier_id: canonical.verifier_id,
        verifier_kind: canonical.verifier_kind,
        verifier_version: canonical.verifier_version,
        verifier_issuer_id: canonical.verifier_issuer_id,
        reward_role: canonical.reward_role,
        verifier_material_paths: [...canonical.verifier_material_paths],
        readonly_inputs: canonical.readonly_inputs.map((item) => ({ ...item })),
        scratch_overlays: canonical.scratch_overlays.map((item) => ({ ...item })),
        runner_config: runnerInputFromCanonical(canonical.runner_config),
      });
    } catch {
      throw new TypeError(
        `AIONIS_EPISODE_VERIFIERS_JSON contains an invalid definition at index ${index}`,
      );
    }
  });
  return deepFreeze(definitions);
}

/**
 * Verifies that a launch wrapper and its untouched runner result were minted
 * by a Runtime-owned registry in this process. A caller-built wrapper around
 * an otherwise authentic arbitrary runner result does not acquire this
 * authority.
 */
export function assertAuthenticRuntimeEpisodeVerifierRegistryLaunch(
  value: RuntimeEpisodeVerifierLaunchV1,
): RuntimeEpisodeVerifierDefinitionIdentityV1 {
  const record = AUTHENTIC_RUNTIME_EPISODE_VERIFIER_LAUNCHES.get(value);
  if (
    !record
    || value.definition_identity !== record.identity
    || value.execution_pack_manifest !== record.executionPackManifest
    || value.launch_identity !== record.launchIdentity
    || value.effective_status !== record.launchIdentity.effective_status
    || value.infrastructure_failure_reasons
      !== record.launchIdentity.infrastructure_failure_reasons
    || value.result !== record.result
  ) {
    throw new Error(
      "runtime_episode_verifier_registry_launch_not_authentic",
    );
  }
  const {
    launch_sha256: _launchSha256,
    ...launchIdentityMaterial
  } = record.launchIdentity;
  const authentic = assertAuthenticEpisodeVerifierExecution(value.result);
  if (
    value.result.config_sha256
      !== record.launchIdentity.resolved_config_digest
    || value.result.result_sha256 !== record.launchIdentity.result_sha256
    || record.launchIdentity.launch_sha256
      !== runtimeEpisodeVerifierLaunchIdentityDigest(launchIdentityMaterial)
    || verifierExecutionPackManifestDigest(record.executionPackManifest)
      !== record.launchIdentity.execution_pack_manifest_sha256
    || record.executionPackManifest.invocation_id
      !== record.launchIdentity.verifier_invocation_id
    || record.executionPackManifest.verifier_program_digest
      !== record.launchIdentity.verifier_program_digest
    || authentic.config.executable
      !== record.executionPackManifest.executable.packed_path
    || authentic.executable_sha256
      !== record.executionPackManifest.executable.content_sha256
  ) {
    throw new Error(
      "runtime_episode_verifier_registry_launch_not_authentic",
    );
  }
  return record.identity;
}

export type AuthenticRuntimeEpisodeVerifierLaunchEvidenceV1 =
  Readonly<{
    definition_identity:
      DeepReadonly<RuntimeEpisodeVerifierDefinitionIdentityV1>;
    execution_pack_manifest:
      DeepReadonly<VerifierExecutionPackManifestV1>;
    launch_identity: DeepReadonly<RuntimeEpisodeVerifierLaunchIdentityV1>;
    result: EpisodeVerifierRunnerResultV1;
  }>;

export type RuntimeEpisodeVerifierExecutionEvidenceV1 = Readonly<{
  contract_version: "runtime_episode_verifier_execution_evidence_v1";
  definition_identity:
    DeepReadonly<RuntimeEpisodeVerifierDefinitionIdentityV1>;
  execution_pack_manifest:
    DeepReadonly<VerifierExecutionPackManifestV1>;
  launch_identity: DeepReadonly<RuntimeEpisodeVerifierLaunchIdentityV1>;
  effective_status: EpisodeVerifierRunnerResultV1["status"];
  infrastructure_failure_reasons: readonly string[];
  runner_result: EpisodeVerifierRunnerResultV1;
}>;

export type RuntimeEpisodeVerifierFailureAttributionV1 =
  | "arm_caused"
  | "arm_independent"
  | null;

export function runtimeEpisodeVerifierFailureAttribution(
  value: RuntimeEpisodeVerifierLaunchV1,
): RuntimeEpisodeVerifierFailureAttributionV1 {
  assertAuthenticRuntimeEpisodeVerifierRegistryLaunch(value);
  if (value.effective_status !== "infrastructure_error") return null;
  // Once treatment has started, spawn failures, deadlines, signals, subject
  // drift, and pack drift can all be caused by the produced state or by the
  // treatment path. They are therefore ITT failures by default. A future
  // arm-independent classification must carry a separate authenticated,
  // arm-blind incident/readiness authority; launch evidence alone can never
  // mint that exclusion.
  return "arm_caused";
}

/**
 * Canonical, serializable evidence retained in CAS. Authenticity is checked
 * before this document is exposed; offline replay can recompute launch_sha256
 * from its complete launch identity instead of trusting an opaque digest.
 */
export function runtimeEpisodeVerifierExecutionEvidence(
  value: RuntimeEpisodeVerifierLaunchV1,
): RuntimeEpisodeVerifierExecutionEvidenceV1 {
  assertAuthenticRuntimeEpisodeVerifierRegistryLaunch(value);
  return deepFreeze({
    contract_version: "runtime_episode_verifier_execution_evidence_v1",
    definition_identity: value.definition_identity,
    execution_pack_manifest: value.execution_pack_manifest,
    launch_identity: value.launch_identity,
    effective_status: value.effective_status,
    infrastructure_failure_reasons:
      [...value.infrastructure_failure_reasons],
    runner_result: value.result,
  });
}

/**
 * Returns every identity the persistence boundary needs to bind the real
 * launch. In particular, callers must use launch_identity.launch_sha256 and
 * resolved_config_digest rather than treating the static definition config as
 * the per-attempt process config.
 */
export function assertAuthenticRuntimeEpisodeVerifierLaunchEvidence(
  value: RuntimeEpisodeVerifierLaunchV1,
  expectedAuthorityVerifier:
    RuntimeEpisodeVerifierInvocationAuthorityVerifier,
): AuthenticRuntimeEpisodeVerifierLaunchEvidenceV1 {
  assertAuthenticRuntimeEpisodeVerifierRegistryLaunch(value);
  const record = AUTHENTIC_RUNTIME_EPISODE_VERIFIER_LAUNCHES.get(value);
  if (
    !record
    || record.authorityVerifier !== expectedAuthorityVerifier
    || record.launchIdentity.invocation_authority_channel_id
      !== expectedAuthorityVerifier.channel_id
  ) {
    throw new Error(
      "runtime_episode_verifier_launch_authority_channel_mismatch",
    );
  }
  return Object.freeze({
    definition_identity: record.identity,
    execution_pack_manifest: record.executionPackManifest,
    launch_identity: record.launchIdentity,
    result: record.result,
  });
}

function executionPackReadonlyInputs(
  definition: DeepReadonly<RuntimeEpisodeVerifierDefinitionV1>,
  programIdentity: DeepReadonly<VerifierProgramIdentityV2>,
): readonly VerifierExecutionPackReadonlyInputV1[] {
  return definition.readonly_inputs.map((input) => {
    const root = programIdentity.manifest.immutable_input_roots.find(
      (candidate) =>
        normalize(candidate.declared_path) === normalize(input.source_path),
    );
    if (!root) {
      throw new Error(
        "runtime_episode_verifier_readonly_input_program_identity_mismatch",
      );
    }
    return {
      contract_version:
        "verifier_execution_pack_readonly_input_v1" as const,
      input_id: input.input_id,
      input_type: input.input_type,
      source_root_resolved_path: root.resolved_path,
      ...(input.subject_path === undefined
        ? {}
        : { subject_path: input.subject_path }),
    };
  });
}

function executionPackScratchOverlays(
  definition: DeepReadonly<RuntimeEpisodeVerifierDefinitionV1>,
): readonly VerifierExecutionPackScratchOverlayV1[] {
  return definition.scratch_overlays.map((overlay) => ({
    contract_version: "verifier_execution_pack_scratch_overlay_v1" as const,
    overlay_id: overlay.overlay_id,
    ...(overlay.subject_path === undefined
      ? {}
      : { subject_path: overlay.subject_path }),
  }));
}

function createRegistryEntry(
  input: RuntimeEpisodeVerifierDefinitionInput,
): RuntimeEpisodeVerifierRegistryEntryV1 {
  const definition = canonicalRuntimeEpisodeVerifierDefinition(input);
  const programIdentity = captureVerifierProgramIdentity({
    runnerConfig: definition.runner_config,
    verifierMaterialPaths: definition.verifier_material_paths,
    immutableInputPaths: definition.readonly_inputs.map((item) =>
      item.source_path),
  });
  if (definition.reward_role === "primary") {
    assertPrimaryVerifierArgvMaterialCoverage({
      runnerConfig: definition.runner_config,
      materialRoots: programIdentity.manifest.material_roots,
    });
    assertPrimaryVerifierEnvironmentImmutableInputCoverage({
      runnerConfig: definition.runner_config,
      immutableInputRoots:
        programIdentity.manifest.immutable_input_roots,
    });
  }
  const verifierConfigDigest = episodeVerifierRunnerConfigDigest(
    runnerInputFromCanonical(definition.runner_config),
  );
  const definitionSha256 = sha256Hex(stableStringify({
    contract: "runtime_episode_verifier_definition_digest_v1",
    definition,
    verifier_program_digest: programIdentity.verifier_program_digest,
  }));
  return deepFreeze({
    definition,
    program_identity: programIdentity,
    identity: {
      contract_version: "runtime_episode_verifier_definition_identity_v1",
      verifier_id: definition.verifier_id,
      verifier_kind: definition.verifier_kind,
      verifier_version: definition.verifier_version,
      verifier_issuer_id: definition.verifier_issuer_id,
      reward_role: definition.reward_role,
      verifier_config_digest: verifierConfigDigest,
      verifier_program_digest: programIdentity.verifier_program_digest,
      definition_sha256: definitionSha256,
    },
  });
}

function canonicalUtf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function createRuntimeEpisodeVerifierRegistry(
  definitions: readonly RuntimeEpisodeVerifierDefinitionInput[],
  invocationAuthorityVerifier?:
    RuntimeEpisodeVerifierInvocationAuthorityVerifier,
): RuntimeEpisodeVerifierRegistry {
  if (!Array.isArray(definitions)) {
    throw new TypeError("Runtime verifier definitions must be an array");
  }

  const byId = new Map<string, RuntimeEpisodeVerifierRegistryEntryV1>();
  for (const input of definitions) {
    const entry = createRegistryEntry(input);
    if (byId.has(entry.definition.verifier_id)) {
      throw new Error(
        `duplicate_runtime_episode_verifier_id:${entry.definition.verifier_id}`,
      );
    }
    byId.set(entry.definition.verifier_id, entry);
  }

  const identities = deepFreeze(
    [...byId.values()]
      .map((entry) => entry.identity)
      .sort((left, right) =>
        canonicalUtf8Compare(left.verifier_id, right.verifier_id)),
  );

  return Object.freeze({
    registry_status: byId.size === 0 ? "unregistered" : "registered",
    identities,
    resolve(verifierId: string) {
      if (typeof verifierId !== "string") return null;
      return byId.get(verifierId) ?? null;
    },
    async launch(
      authorityOrVerifierId:
        | RuntimeEpisodeVerifierInvocationAuthorityV1
        | string,
      materialization?: VerifierSubjectMaterializationV1,
      lifecycle?: RuntimeEpisodeVerifierLaunchLifecycleV1,
    ) {
      if (
        arguments.length !== 3
        || typeof authorityOrVerifierId === "string"
        || materialization === undefined
        || lifecycle === undefined
      ) {
        throw new TypeError(
          "runtime_episode_verifier_launch_requires_persisted_invocation_authority_materialization_and_durable_lifecycle",
        );
      }
      assertExactBoundedString(
        lifecycle.launch_attempt_id,
        "Runtime verifier launch attempt ID",
        MAX_VERIFIER_ID_BYTES,
      );
      if (invocationAuthorityVerifier === undefined) {
        throw new Error(
          "runtime_episode_verifier_invocation_authority_verifier_not_configured",
        );
      }
      const authority =
        assertAuthenticRuntimeEpisodeVerifierInvocationAuthority(
          authorityOrVerifierId,
          invocationAuthorityVerifier,
        );
      const materializationRecord =
        assertAuthenticVerifierSubjectMaterialization(materialization);
      if (
        authority.materialization !== materialization
        || authority.materializationId
          !== materializationRecord.materializationId
        || authority.sourceContentDigest
          !== materializationRecord.sourceContentDigest
        || authority.sourceEnvironmentDigest
          !== materializationRecord.sourceEnvironmentDigest
        || authority.subjectViewContentDigest
          !== materializationRecord.verificationViewContentDigest
        || authority.subjectViewEnvironmentDigest
          !== materializationRecord.verificationViewEnvironmentDigest
      ) {
        throw new Error(
          "runtime_episode_verifier_authority_materialization_binding_mismatch",
        );
      }

      const required = authority.requiredVerifier;
      const entry = byId.get(required.verifier_id);
      if (!entry) {
        throw new Error(
          `unknown_runtime_episode_verifier_id:${required.verifier_id}`,
        );
      }
      if (
        entry.identity.verifier_id !== required.verifier_id
        || entry.identity.definition_sha256
          !== required.verifier_definition_sha256
        || entry.identity.verifier_program_digest
          !== required.verifier_program_digest
        || entry.identity.verifier_config_digest
          !== required.verifier_config_digest
      ) {
        throw new Error(
          "runtime_episode_verifier_invocation_definition_binding_mismatch",
        );
      }
      if (
        required.verifier_environment_digest
          !== authority.sourceEnvironmentDigest
      ) {
        throw new Error(
          "runtime_episode_verifier_invocation_environment_binding_mismatch",
        );
      }
      if (
        stableStringify(materialization.subject_state_spec)
          !== stableStringify(authority.subjectIdentity.subject_state_spec)
        || materialization.verification_view.algorithm_id
          !== authority.subjectIdentity.capture_algorithm_id
        || materialization.verification_view.algorithm_version
          !== authority.subjectIdentity.capture_algorithm_version
      ) {
        throw new Error(
          "runtime_episode_verifier_materialized_subject_view_mismatch",
        );
      }
      assertStaticDefinitionDoesNotEscapeToLiveSubject(
        entry.definition,
        authority.sourceSubjectRoot,
      );

      try {
        assertVerifierSubjectUnchanged(materialization);
      } catch {
        return launchInfrastructureFailure(
          "runtime_episode_verifier_subject_integrity_failure_before_launch",
        );
      }

      let beforeProgramIdentity: VerifierProgramIdentityV2;
      try {
        beforeProgramIdentity = captureVerifierProgramIdentity({
          runnerConfig: entry.definition.runner_config,
          verifierMaterialPaths: entry.definition.verifier_material_paths,
          immutableInputPaths: entry.definition.readonly_inputs.map((item) =>
            item.source_path),
        });
      } catch {
        return launchInfrastructureFailure(
          "runtime_episode_verifier_program_drift_before_launch",
        );
      }
      if (
        beforeProgramIdentity.verifier_program_digest
        !== entry.identity.verifier_program_digest
      ) {
        return launchInfrastructureFailure(
          "runtime_episode_verifier_program_drift_before_launch",
        );
      }

      const launchAttemptId = lifecycle.launch_attempt_id;
      let executionPack: VerifierExecutionPackV1;
      try {
        executionPack = materializeVerifierExecutionPack({
          invocation_id: authority.verifierInvocationId,
          program_identity: entry.program_identity,
          runner_config: runnerInputFromCanonical(
            entry.definition.runner_config,
          ),
          readonly_inputs: executionPackReadonlyInputs(
            entry.definition,
            entry.program_identity,
          ),
          scratch_overlays: executionPackScratchOverlays(entry.definition),
          subject_root: materializationRecord.subjectRoot,
          base_directory: materializationRecord.scratchRoot,
        });
      } catch {
        return launchInfrastructureFailure(
          "runtime_episode_verifier_execution_pack_materialization_failed",
        );
      }
      const executionPackManifest = executionPack.manifest;
      const executionPackManifestSha256 = executionPack.manifest_sha256;
      let resolvedInput: EpisodeVerifierRunnerConfig;
      let canonicalResolvedConfig: CanonicalEpisodeVerifierRunnerConfigV1;
      let resolvedConfigDigest: string;
      let resolvedEnvironmentSha256: string;
      try {
        resolvedInput = resolvedRunnerInput(
          entry.definition,
          executionPack,
          authority,
          materializationRecord,
          launchAttemptId,
        );
        canonicalResolvedConfig =
          canonicalEpisodeVerifierRunnerConfig(resolvedInput);
        resolvedConfigDigest = episodeVerifierRunnerConfigDigest(
          canonicalResolvedConfig,
        );
        resolvedEnvironmentSha256 = resolvedEnvironmentDigest(
          canonicalResolvedConfig,
        );
      } catch {
        try {
          executionPack.cleanup();
        } catch {
          // The launch authority has not been consumed; retry/recovery remains
          // possible even when local cleanup needs the materialization owner.
        }
        return launchInfrastructureFailure(
          "runtime_episode_verifier_execution_pack_resolution_failed",
        );
      }

      const preparedLaunch =
        deepFreeze<RuntimeEpisodeVerifierPreparedLaunchV1>({
          contract_version: "runtime_episode_verifier_prepared_launch_v1",
          launch_attempt_id: launchAttemptId,
          episode_id: authority.episodeId,
          verifier_invocation_id: authority.verifierInvocationId,
          verifier_invocation_digest:
            authority.verifierInvocationDigest,
          invocation_authority_sha256: authority.authoritySha256,
          invocation_authority_channel_id:
            invocationAuthorityVerifier.channel_id,
          materialization_id: authority.materializationId,
          materialized_subject_root: materializationRecord.subjectRoot,
          materialized_scratch_root: materializationRecord.scratchRoot,
          source_content_digest: authority.sourceContentDigest,
          source_environment_digest: authority.sourceEnvironmentDigest,
          subject_identity_sha256:
            authority.subjectIdentity.identity_sha256,
          subject_view_content_digest:
            authority.subjectViewContentDigest,
          subject_view_environment_digest:
            authority.subjectViewEnvironmentDigest,
          verifier_id: required.verifier_id,
          verifier_definition_sha256:
            required.verifier_definition_sha256,
          verifier_program_digest: required.verifier_program_digest,
          verifier_config_digest: required.verifier_config_digest,
          verifier_environment_digest:
            required.verifier_environment_digest,
          execution_pack_manifest_sha256:
            executionPackManifestSha256,
          resolved_config_digest: resolvedConfigDigest,
          resolved_environment_digest: resolvedEnvironmentSha256,
        });
      try {
        await lifecycle.persist_prepared_launch(preparedLaunch);
      } catch {
        try {
          executionPack.cleanup();
        } catch {
          // The launch authority remains unconsumed. A later retry can
          // rematerialize the complete pack even if this local cleanup fails.
        }
        return launchInfrastructureFailure(
          "runtime_episode_verifier_prepared_launch_persistence_failed",
        );
      }

      // A persisted invocation capability is single-use. It is consumed only
      // after every static and preflight binding check passes, immediately
      // before the real process is started.
      const infrastructureFailureReasons: string[] = [];
      let result: EpisodeVerifierRunnerResultV1;
      let spawnObservationPersistenceFailed = false;
      try {
        consumeRuntimeEpisodeVerifierInvocationAuthority(
          authorityOrVerifierId,
          invocationAuthorityVerifier,
        );
        result = await runEpisodeVerifier(resolvedInput, {
          on_spawn_observed: async (observation) => {
            try {
              await lifecycle.persist_spawn_observation({
                contract_version:
                  "runtime_episode_verifier_spawn_observation_v1",
                launch_attempt_id: launchAttemptId,
                process_id: observation.process_id,
                observed_at: observation.started_at,
              });
            } catch {
              spawnObservationPersistenceFailed = true;
            }
          },
        });
        if (spawnObservationPersistenceFailed) {
          infrastructureFailureReasons.push(
            "runtime_episode_verifier_spawn_observation_persistence_failed",
          );
        }
        try {
          assertVerifierExecutionPackUnchanged(executionPack);
        } catch {
          infrastructureFailureReasons.push(
            "runtime_episode_verifier_execution_pack_modified_during_launch",
          );
        }
        try {
          executionPack.detach();
        } catch {
          infrastructureFailureReasons.push(
            "runtime_episode_verifier_execution_pack_attachment_integrity_failure",
          );
        }
        try {
          assertVerifierSubjectUnchanged(materialization);
        } catch {
          infrastructureFailureReasons.push(
            "runtime_episode_verifier_subject_modified_during_launch",
          );
        }
      } finally {
        try {
          executionPack.cleanup();
        } catch {
          infrastructureFailureReasons.push(
            "runtime_episode_verifier_execution_pack_cleanup_failure",
          );
        }
      }
      if (result.status === "infrastructure_error") {
        infrastructureFailureReasons.push(
          "runtime_episode_verifier_runner_infrastructure_error",
        );
      }

      const authentic = assertAuthenticEpisodeVerifierExecution(result);
      if (
        result.config_sha256 !== resolvedConfigDigest
        || episodeVerifierRunnerConfigDigest(authentic.config)
          !== resolvedConfigDigest
        || authentic.config.executable
          !== executionPackManifest.executable.packed_path
        || authentic.executable_sha256
          !== executionPackManifest.executable.content_sha256
      ) {
        return launchInfrastructureFailure(
          "runtime_episode_verifier_launch_config_digest_mismatch",
        );
      }
      const canonicalInfrastructureFailureReasons = deepFreeze(
        [...new Set(infrastructureFailureReasons)]
          .sort(canonicalUtf8Compare),
      );
      const effectiveStatus =
        canonicalInfrastructureFailureReasons.length === 0
          ? result.status
          : "infrastructure_error";

      const launchIdentityMaterial =
        deepFreeze<RuntimeEpisodeVerifierLaunchIdentityMaterialV1>({
          contract_version: "runtime_episode_verifier_launch_identity_v1",
          launch_attempt_id: launchAttemptId,
          episode_id: authority.episodeId,
          verifier_invocation_id: authority.verifierInvocationId,
          verifier_invocation_digest:
            authority.verifierInvocationDigest,
          invocation_authority_sha256: authority.authoritySha256,
          invocation_authority_channel_id:
            invocationAuthorityVerifier.channel_id,
          materialization_id: authority.materializationId,
          source_content_digest: authority.sourceContentDigest,
          source_environment_digest: authority.sourceEnvironmentDigest,
          subject_identity_sha256:
            authority.subjectIdentity.identity_sha256,
          subject_view_content_digest:
            authority.subjectViewContentDigest,
          subject_view_environment_digest:
            authority.subjectViewEnvironmentDigest,
          verifier_id: required.verifier_id,
          verifier_definition_sha256:
            required.verifier_definition_sha256,
          verifier_program_digest: required.verifier_program_digest,
          verifier_config_digest: required.verifier_config_digest,
          execution_pack_manifest_sha256:
            executionPackManifestSha256,
          verifier_environment_digest:
            required.verifier_environment_digest,
          resolved_config_digest: resolvedConfigDigest,
          resolved_environment_digest: resolvedEnvironmentSha256,
          result_sha256: result.result_sha256,
          effective_status: effectiveStatus,
          infrastructure_failure_reasons:
            canonicalInfrastructureFailureReasons,
        });
      const launchIdentity =
        deepFreeze<RuntimeEpisodeVerifierLaunchIdentityV1>({
          ...launchIdentityMaterial,
          launch_sha256: runtimeEpisodeVerifierLaunchIdentityDigest(
            launchIdentityMaterial,
          ),
        });
      const launch: RuntimeEpisodeVerifierLaunchV1 = Object.freeze({
        contract_version: "runtime_episode_verifier_launch_v1",
        definition_identity: entry.identity,
        execution_pack_manifest: executionPackManifest,
        launch_identity: launchIdentity,
        effective_status: effectiveStatus,
        infrastructure_failure_reasons:
          launchIdentity.infrastructure_failure_reasons,
        result,
      });
      AUTHENTIC_RUNTIME_EPISODE_VERIFIER_LAUNCHES.set(launch, {
        identity: entry.identity,
        launchIdentity,
        authorityVerifier: invocationAuthorityVerifier,
        executionPackManifest,
        result,
      });
      return launch;
    },
  });
}
