#!/usr/bin/env node

import { randomBytes as operatingSystemRandomBytes } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import stableStringify from "fast-json-stable-stringify";

import {
  loadEnv,
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
} from "../src/config.js";
import {
  LearningExperimentExternalInputSetV1Schema,
  LearningMemoryNamespaceManifestV1Schema,
  learningMemoryNamespaceManifestScopeEncodingIssue,
  type LearningExperimentExternalInputSetV1,
  type LearningMemoryNamespaceManifestV1,
} from "../src/memory/learning-experiment-provisioning.js";
import {
  LearningExperimentCloseAuthorizationEnvelopeV1Schema,
  type LearningExperimentCloseAuthorizationEnvelopeV1,
} from "../src/memory/learning-experiment-closing.js";
import {
  LearningExperimentClosingError,
  closeLiteLearningExperiment,
} from "../tools/learning-experiments/lite-learning-experiment-closing.js";
import {
  LearningExperimentProvisioningError,
  provisionLiteLearningExperiment,
} from "../tools/learning-experiments/lite-learning-experiment-provisioning.js";

const MAX_PROFILE_RULE_BYTES = 512 * 1024;
const MAX_EXTERNAL_INPUT_SET_BYTES = 512 * 1024;
const MAX_MEMORY_NAMESPACE_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_CLOSE_APPROVAL_BYTES = 64 * 1024;

const REQUIRED_PROVISION_FLAGS = Object.freeze([
  "db",
  "tenant",
  "actor",
  "operation-id",
  "profile-rule-file",
  "task-family",
  "experiment-id",
  "revision",
  "out",
] as const);

const OPTIONAL_CONFIRMATORY_FLAGS = Object.freeze([
  "memory-namespace-manifest",
  "external-input-set",
] as const);

const REQUIRED_CLOSE_FLAGS = Object.freeze([
  "db",
  "tenant",
  "actor",
  "operation-id",
  "approval",
  "experiment-id",
  "revision",
] as const);

const ALLOWED_PROVISION_FLAGS = new Set<string>([
  ...REQUIRED_PROVISION_FLAGS,
  ...OPTIONAL_CONFIRMATORY_FLAGS,
]);

const ALLOWED_CLOSE_FLAGS = new Set<string>(REQUIRED_CLOSE_FLAGS);

const PATH_FLAGS = new Set<string>([
  "db",
  "profile-rule-file",
  "out",
  ...OPTIONAL_CONFIRMATORY_FLAGS,
]);

const CLOSE_PATH_FLAGS = new Set<string>(["db", "approval"]);

const ASSIGNMENT_AUTHORITY_ARGUMENT = /(?:^|-)(?:seed|bits|randomness)(?:-|$)/iu;
const ASSIGNMENT_AUTHORITY_PROFILE_KEY = /(?:^|_)(?:seed|bits|randomness)(?:_|$)/iu;

type CliOutput = (value: string) => void;

type ParsedLearningExperimentCommand = Readonly<{
  command: "provision" | "close";
  values: ReadonlyMap<string, string>;
}>;

export type LearningExperimentCliOptions = Readonly<{
  stdout?: CliOutput;
  stderr?: CliOutput;
}>;

class LearningExperimentCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LearningExperimentCliError";
    this.code = code;
  }
}

function cliError(code: string, message: string): never {
  throw new LearningExperimentCliError(code, message);
}

function usage(): string {
  return `Aionis learning experiment operations

Usage:
  npx tsx scripts/learning-experiment.ts provision \\
    --db /absolute/path/to/runtime.sqlite \\
    --tenant TENANT_ID --actor ACTOR --operation-id OPERATION_ID \\
    --profile-rule-file /absolute/path/to/profile-rule.json \\
    [--memory-namespace-manifest /absolute/path/to/namespaces.json] \\
    [--external-input-set /absolute/path/to/external-inputs.json] \\
    --task-family TASK_FAMILY --experiment-id EXPERIMENT_ID \\
    --revision REVISION --out /absolute/path/to/applicability-manifest.json

  npx tsx scripts/learning-experiment.ts close \\
    --db /absolute/path/to/runtime.sqlite \\
    --tenant TENANT_ID --actor ACTOR --operation-id OPERATION_ID \\
    --approval /secure/path/to/learning-experiment-close-approval.json \\
    --experiment-id EXPERIMENT_ID --revision REVISION

--memory-namespace-manifest and --external-input-set are both required for
active_control confirmatory provisioning and are forbidden for integrity-only
A/A and shadow provisioning.
`;
}

function outputTo(sink: CliOutput | undefined, fallback: NodeJS.WriteStream, value: string): void {
  if (sink) {
    sink(value);
    return;
  }
  fallback.write(value);
}

function parseLearningExperimentArgs(
  argv: readonly string[],
): ParsedLearningExperimentCommand | "help" {
  const [command, ...tokens] = argv;
  if (command === undefined) return "help";
  if (command === "help" || command === "--help") {
    if (tokens.length > 0) {
      cliError("learning_experiment_cli_argument_invalid", "help does not accept additional arguments");
    }
    return "help";
  }
  if (command !== "provision" && command !== "close") {
    cliError("learning_experiment_cli_unknown_command", `unknown command: ${command}`);
  }
  if (tokens.length === 1 && tokens[0] === "--help") return "help";

  const allowedFlags = command === "provision" ? ALLOWED_PROVISION_FLAGS : ALLOWED_CLOSE_FLAGS;
  const requiredFlags = command === "provision" ? REQUIRED_PROVISION_FLAGS : REQUIRED_CLOSE_FLAGS;
  const pathFlags = command === "provision" ? PATH_FLAGS : CLOSE_PATH_FLAGS;

  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!/^--[a-z][a-z0-9-]*$/u.test(token)) {
      cliError("learning_experiment_cli_argument_invalid", `unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (command === "provision" && ASSIGNMENT_AUTHORITY_ARGUMENT.test(key)) {
      cliError(
        "learning_experiment_cli_assignment_authority_forbidden",
        `caller-supplied assignment seed, bits, or randomness is forbidden: --${key}`,
      );
    }
    if (!allowedFlags.has(key)) {
      cliError("learning_experiment_cli_unknown_flag", `unknown flag: --${key}`);
    }
    if (values.has(key)) {
      cliError("learning_experiment_cli_duplicate_flag", `duplicate flag: --${key}`);
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      cliError("learning_experiment_cli_flag_value_required", `--${key} requires a value`);
    }
    values.set(key, value);
    index += 1;
  }

  for (const key of requiredFlags) {
    const value = values.get(key);
    if (value === undefined || value.length === 0) {
      cliError("learning_experiment_cli_required_flag_missing", `missing required --${key}`);
    }
  }
  for (const key of pathFlags) {
    const value = values.get(key);
    if (value !== undefined && !isAbsolute(value)) {
      cliError("learning_experiment_cli_absolute_path_required", `--${key} must be an absolute path`);
    }
  }
  return { command, values };
}

function requiredValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.length === 0) {
    cliError("learning_experiment_cli_required_flag_missing", `missing required --${key}`);
  }
  return value;
}

function normalizedPathIdentity(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function sameFilesystemEntry(left: string, right: string): boolean {
  const leftIdentity = normalizedPathIdentity(left);
  const rightIdentity = normalizedPathIdentity(right);
  if (leftIdentity === rightIdentity) return true;
  if ((process.platform === "darwin" || process.platform === "win32")
    && leftIdentity.toLocaleLowerCase("en-US") === rightIdentity.toLocaleLowerCase("en-US")) {
    return true;
  }
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function assertProvisionProtectedPathsDisjoint(values: ReadonlyMap<string, string>): void {
  const database = requiredValue(values, "db");
  const profile = requiredValue(values, "profile-rule-file");
  const output = requiredValue(values, "out");
  const protectedPaths: Array<readonly [label: string, path: string]> = [
    ["--db", database],
    ["--db WAL sidecar", `${database}-wal`],
    ["--db shared-memory sidecar", `${database}-shm`],
    ["--profile-rule-file", profile],
  ];
  for (const flag of OPTIONAL_CONFIRMATORY_FLAGS) {
    const value = values.get(flag);
    if (value !== undefined) protectedPaths.push([`--${flag}`, value]);
  }
  protectedPaths.push(["--out", output]);
  for (let leftIndex = 0; leftIndex < protectedPaths.length; leftIndex += 1) {
    const [leftLabel, leftPath] = protectedPaths[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < protectedPaths.length; rightIndex += 1) {
      const [rightLabel, rightPath] = protectedPaths[rightIndex]!;
      if (!sameFilesystemEntry(leftPath, rightPath)) continue;
      cliError(
        "learning_experiment_cli_path_collision",
        `${leftLabel} must not alias ${rightLabel}`,
      );
    }
  }
}

function assertCloseProtectedPathsDisjoint(values: ReadonlyMap<string, string>): void {
  const database = requiredValue(values, "db");
  const approval = requiredValue(values, "approval");
  for (const [databaseLabel, databasePath] of [
    ["--db", database],
    ["--db WAL sidecar", `${database}-wal`],
    ["--db shared-memory sidecar", `${database}-shm`],
  ] as const) {
    if (!sameFilesystemEntry(databasePath, approval)) continue;
    cliError(
      "learning_experiment_cli_path_collision",
      `${databaseLabel} must not alias --approval`,
    );
  }
}

function positiveRevision(raw: string): number {
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    cliError("learning_experiment_cli_revision_invalid", "--revision must be a positive integer");
  }
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision)) {
    cliError("learning_experiment_cli_revision_invalid", "--revision exceeds the safe integer range");
  }
  return revision;
}

function assertNoCallerAssignmentAuthority(value: unknown): void {
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: "$profile" }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > 100_000) {
      cliError("learning_experiment_cli_profile_invalid", "profile rule object is too deeply nested");
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => pending.push({
        value: child,
        path: `${current.path}[${index}]`,
      }));
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      if (ASSIGNMENT_AUTHORITY_PROFILE_KEY.test(key)) {
        cliError(
          "learning_experiment_cli_assignment_authority_forbidden",
          `caller-supplied assignment seed, bits, or randomness is forbidden at ${current.path}.${key}`,
        );
      }
      pending.push({ value: child, path: `${current.path}.${key}` });
    }
  }
}

function readProfileRule(path: string): AionisAdmissionCandidatePolicyProfileRule {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      cliError("learning_experiment_cli_profile_invalid", "--profile-rule-file must name a regular file");
    }
    if (stat.size > MAX_PROFILE_RULE_BYTES) {
      cliError(
        "learning_experiment_cli_profile_too_large",
        "--profile-rule-file exceeds the 512 KiB limit",
      );
    }
    const encoded = readFileSync(descriptor);
    if (encoded.byteLength > MAX_PROFILE_RULE_BYTES) {
      cliError(
        "learning_experiment_cli_profile_too_large",
        "--profile-rule-file exceeds the 512 KiB limit",
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    } catch {
      cliError("learning_experiment_cli_profile_invalid", "--profile-rule-file must be valid UTF-8");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      cliError("learning_experiment_cli_profile_invalid", "--profile-rule-file must contain valid JSON");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      cliError("learning_experiment_cli_profile_invalid", "--profile-rule-file must contain one JSON object");
    }
    assertNoCallerAssignmentAuthority(raw);
    const rules = parseAdmissionCandidatePolicyProfileRules(stableStringify([raw]));
    if (rules.length !== 1 || !rules[0]) {
      cliError("learning_experiment_cli_profile_invalid", "--profile-rule-file must contain one profile rule");
    }
    return rules[0];
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

type StrictJsonSchema<T> = Readonly<{
  parse(value: unknown): T;
}>;

function readStrictJsonObjectFile<T>(args: {
  path: string;
  label: string;
  maxBytes: number;
  tooLargeCode: string;
  invalidCode: string;
  schema: StrictJsonSchema<T>;
  privateAuthorizationFile?: boolean;
}): T {
  let descriptor: number | null = null;
  try {
    descriptor = args.privateAuthorizationFile
      ? openSync(args.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      : openSync(args.path, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      cliError(args.invalidCode, `${args.label} must name a regular file`);
    }
    if (args.privateAuthorizationFile && process.platform !== "win32") {
      if ((stat.mode & 0o077) !== 0) {
        cliError(args.invalidCode, `${args.label} must not grant group or other permissions`);
      }
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        cliError(args.invalidCode, `${args.label} must be owned by the current user`);
      }
    }
    if (stat.size > args.maxBytes) {
      cliError(args.tooLargeCode, `${args.label} exceeds its bounded input size`);
    }
    const encoded = readFileSync(descriptor);
    if (encoded.byteLength > args.maxBytes) {
      cliError(args.tooLargeCode, `${args.label} exceeds its bounded input size`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    } catch {
      cliError(args.invalidCode, `${args.label} must be valid UTF-8`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      cliError(args.invalidCode, `${args.label} must contain valid JSON`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      cliError(args.invalidCode, `${args.label} must contain one JSON object`);
    }
    try {
      return args.schema.parse(raw);
    } catch {
      cliError(args.invalidCode, `${args.label} does not satisfy its strict contract`);
    }
  } catch (error) {
    if (error instanceof LearningExperimentCliError) throw error;
    cliError(args.invalidCode, `${args.label} could not be read`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function readConfirmatoryInputs(
  values: ReadonlyMap<string, string>,
  profileRule: AionisAdmissionCandidatePolicyProfileRule,
): Readonly<{
  memoryNamespaceManifest?: LearningMemoryNamespaceManifestV1;
  externalInputSet?: LearningExperimentExternalInputSetV1;
}> {
  const experiment = profileRule.experiment;
  const confirmatory = experiment?.serving_phase === "active_control"
    && experiment.evidence_intent === "confirmatory";
  const namespacePath = values.get("memory-namespace-manifest");
  const externalInputPath = values.get("external-input-set");
  if (!confirmatory) {
    if (namespacePath !== undefined || externalInputPath !== undefined) {
      cliError(
        "learning_experiment_cli_confirmatory_inputs_forbidden",
        "integrity-only provisioning forbids confirmatory input files",
      );
    }
    return {};
  }
  if (namespacePath === undefined || externalInputPath === undefined) {
    cliError(
      "learning_experiment_cli_confirmatory_inputs_required",
      "active_control confirmatory provisioning requires both input files",
    );
  }
  return {
    memoryNamespaceManifest: readStrictJsonObjectFile({
      path: namespacePath,
      label: "--memory-namespace-manifest",
      maxBytes: MAX_MEMORY_NAMESPACE_MANIFEST_BYTES,
      tooLargeCode: "learning_experiment_cli_memory_namespace_manifest_too_large",
      invalidCode: "learning_experiment_cli_memory_namespace_manifest_invalid",
      schema: LearningMemoryNamespaceManifestV1Schema,
    }),
    externalInputSet: readStrictJsonObjectFile({
      path: externalInputPath,
      label: "--external-input-set",
      maxBytes: MAX_EXTERNAL_INPUT_SET_BYTES,
      tooLargeCode: "learning_experiment_cli_external_input_set_too_large",
      invalidCode: "learning_experiment_cli_external_input_set_invalid",
      schema: LearningExperimentExternalInputSetV1Schema,
    }),
  };
}

function readCloseAuthorization(
  values: ReadonlyMap<string, string>,
): LearningExperimentCloseAuthorizationEnvelopeV1 {
  return readStrictJsonObjectFile({
    path: requiredValue(values, "approval"),
    label: "--approval",
    maxBytes: MAX_CLOSE_APPROVAL_BYTES,
    tooLargeCode: "learning_experiment_cli_close_approval_too_large",
    invalidCode: "learning_experiment_cli_close_approval_invalid",
    schema: LearningExperimentCloseAuthorizationEnvelopeV1Schema,
    privateAuthorizationFile: true,
  });
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeCanonicalManifestAtomic(path: string, manifestJson: string): void {
  const destination = resolve(path);
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true });
  if (Buffer.byteLength(manifestJson, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("learning_experiment_applicability_manifest_too_large");
  }
  const temporary = join(
    directory,
    `.${basename(destination)}.${String(process.pid)}.${operatingSystemRandomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | null = null;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, manifestJson, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, destination);
    temporaryExists = false;
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (temporaryExists) rmSync(temporary, { force: true });
  }
}

function errorCode(error: unknown): string {
  if (error instanceof LearningExperimentProvisioningError
    || error instanceof LearningExperimentClosingError
    || error instanceof LearningExperimentCliError) {
    return error.code;
  }
  return "learning_experiment_operation_failed";
}

export async function runLearningExperimentCli(
  argv: readonly string[],
  options: LearningExperimentCliOptions = {},
): Promise<number> {
  try {
    const parsed = parseLearningExperimentArgs(argv);
    if (parsed === "help") {
      outputTo(options.stdout, process.stdout, usage());
      return 0;
    }

    if (parsed.command === "close") {
      assertCloseProtectedPathsDisjoint(parsed.values);
      const authorization = readCloseAuthorization(parsed.values);
      // Resolve aliases again after the reviewed authorization has been opened.
      assertCloseProtectedPathsDisjoint(parsed.values);
      const result = await closeLiteLearningExperiment({
        path: requiredValue(parsed.values, "db"),
        tenantId: requiredValue(parsed.values, "tenant"),
        actor: requiredValue(parsed.values, "actor"),
        operationId: requiredValue(parsed.values, "operation-id"),
        authorization,
        experimentId: requiredValue(parsed.values, "experiment-id"),
        experimentRevision: positiveRevision(requiredValue(parsed.values, "revision")),
      });
      outputTo(options.stdout, process.stdout, `${result.receiptJson}\n`);
      return 0;
    }

    const values = parsed.values;
    assertProvisionProtectedPathsDisjoint(values);
    const profileRuleFile = requiredValue(values, "profile-rule-file");
    const out = requiredValue(values, "out");
    const profileRule = readProfileRule(profileRuleFile);
    const confirmatoryInputs = readConfirmatoryInputs(values, profileRule);
    if (confirmatoryInputs.memoryNamespaceManifest) {
      const issue = learningMemoryNamespaceManifestScopeEncodingIssue({
        manifest: confirmatoryInputs.memoryNamespaceManifest,
        defaultTenantId: loadEnv().MEMORY_TENANT_ID,
      });
      if (issue) {
        cliError(
          "learning_experiment_cli_memory_namespace_scope_encoding_invalid",
          `--memory-namespace-manifest pair ${issue.pair_index} member ${issue.member_index} exceeds the 256-byte store-scope limit after tenant encoding`,
        );
      }
    }
    // Recheck after all reviewed files have been opened and parsed. This closes
    // aliases that became observable while resolving symlinks or hard links,
    // before the Runtime database is opened for mutation.
    assertProvisionProtectedPathsDisjoint(values);
    const result = await provisionLiteLearningExperiment({
      path: requiredValue(values, "db"),
      tenantId: requiredValue(values, "tenant"),
      actor: requiredValue(values, "actor"),
      operationId: requiredValue(values, "operation-id"),
      profileRule,
      taskFamily: requiredValue(values, "task-family"),
      experimentId: requiredValue(values, "experiment-id"),
      experimentRevision: positiveRevision(requiredValue(values, "revision")),
      memoryNamespaceManifest: confirmatoryInputs.memoryNamespaceManifest,
      externalInputSet: confirmatoryInputs.externalInputSet,
    });

    const canonicalManifestJson = stableStringify(result.applicabilityManifest);
    if (canonicalManifestJson !== result.applicabilityManifestJson) {
      throw new Error("learning_experiment_applicability_manifest_not_canonical");
    }
    // Recheck after provisioning because --db may have been created by this
    // invocation and can now reveal a case-folded, symlink, or inode alias that
    // was not observable during argument preflight.
    assertProvisionProtectedPathsDisjoint(values);
    writeCanonicalManifestAtomic(out, canonicalManifestJson);
    outputTo(options.stdout, process.stdout, `${result.receiptJson}\n`);
    return 0;
  } catch (error) {
    outputTo(options.stderr, process.stderr, `${stableStringify({
      error: "learning_experiment_operation_failed",
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    return 1;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href;
}

if (isMainModule()) {
  void runLearningExperimentCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
