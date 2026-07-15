#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
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
import { z } from "zod";

import {
  HostTaskEnvelopeV1Schema,
  HostUseReceiptV1Schema,
  hostTaskEnvelopeDigest,
  type HostTaskEnvelopeV1,
  type HostUseReceiptV1,
} from "../src/memory/learning-episode-ledger.js";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_LINE_BYTES = 256 * 1024;
const MAX_CASES = 256;
const MAX_RESULT_BYTES = 128 * 1024;

const REQUIRED_VERIFY_FLAGS = Object.freeze([
  "manifest",
  "collector-id",
  "collector-version",
  "verifier-policy-sha256",
  "out",
] as const);
const ALLOWED_VERIFY_FLAGS = new Set<string>(REQUIRED_VERIFY_FLAGS);
const DIGEST_SHA256 = /^[0-9a-f]{64}$/u;

const ExactBoundedIdSchema = z.string().min(1).max(256).refine(
  (value) => value === value.trim(),
  "Expected an exact non-blank identifier",
);
const ExactBoundedKindSchema = z.string().min(1).max(120).refine(
  (value) => value === value.trim(),
  "Expected an exact non-blank version",
);
const ExactHostVerifierVersionSchema = z.string().min(1)
  .refine((value) => value === value.trim(), "Expected an exact non-blank verifier version")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 120,
    "Expected a verifier version bounded to 120 UTF-8 bytes",
  );
const DigestSha256Schema = z.string().regex(DIGEST_SHA256);

const HostVerifierSchema = z.object({
  kind: z.enum(["instrumented_agent_trace", "deterministic_scorer"]),
  version: ExactHostVerifierVersionSchema,
  config_sha256: DigestSha256Schema,
}).strict();

type HostVerifier = z.infer<typeof HostVerifierSchema>;

const HostReceiptManifestHeaderV1Schema = z.object({
  contract_version: z.literal("aionis_host_receipt_conformance_manifest_v1"),
  host_adapter_id: ExactBoundedIdSchema,
  host_adapter_version: ExactBoundedKindSchema,
  host_adapter_sha256: DigestSha256Schema,
  collector_id: ExactBoundedIdSchema,
  collector_version: ExactBoundedKindSchema,
  verifier_policy_sha256: DigestSha256Schema,
  allowed_verifiers: z.array(HostVerifierSchema).min(1).max(32),
  case_count: z.number().int().min(1).max(MAX_CASES),
}).strict();

const HostReceiptManifestCaseV1Schema = z.object({
  contract_version: z.literal("aionis_host_receipt_conformance_case_v1"),
  case_id: ExactBoundedIdSchema,
  host_task_envelope_v1: HostTaskEnvelopeV1Schema,
  host_task_envelope_sha256: DigestSha256Schema,
  host_use_receipt_v1: HostUseReceiptV1Schema,
}).strict();

type HostReceiptManifestHeaderV1 = z.infer<typeof HostReceiptManifestHeaderV1Schema>;
type HostReceiptManifestCaseV1 = z.infer<typeof HostReceiptManifestCaseV1Schema>;

type CliOutput = (value: string) => void;

export type LearningHostReceiptCliOptions = Readonly<{
  stdout?: CliOutput;
  stderr?: CliOutput;
}>;

class LearningHostReceiptCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LearningHostReceiptCliError";
    this.code = code;
  }
}

function cliError(code: string, message: string): never {
  throw new LearningHostReceiptCliError(code, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function verifierKey(verifier: HostVerifier): string {
  return `${verifier.kind}\u0000${verifier.version}\u0000${verifier.config_sha256}`;
}

function usage(): string {
  return `Aionis host task-envelope/use-receipt conformance

Usage:
  npx tsx scripts/learning-host-receipt.ts verify \\
    --manifest /absolute/path/to/sanitized-host-adapter-conformance.jsonl \\
    --collector-id COLLECTOR_ID --collector-version COLLECTOR_VERSION \\
    --verifier-policy-sha256 SHA256 \\
    --out /absolute/path/to/host-adapter-conformance.json

The result proves contract conformance only. It does not verify or provision an
eligible-host principal identity.
`;
}

function outputTo(sink: CliOutput | undefined, fallback: NodeJS.WriteStream, value: string): void {
  if (sink) {
    sink(value);
    return;
  }
  fallback.write(value);
}

type ParsedVerifyCommand = Readonly<{ values: ReadonlyMap<string, string> }>;

function parseArgs(argv: readonly string[]): ParsedVerifyCommand | "help" {
  const [command, ...tokens] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    if (command !== undefined && tokens.length > 0) {
      cliError("learning_host_receipt_cli_argument_invalid", "help does not accept additional arguments");
    }
    return "help";
  }
  if (command !== "verify") {
    cliError("learning_host_receipt_cli_unknown_command", `unknown command: ${command}`);
  }
  if (tokens.length === 1 && tokens[0] === "--help") return "help";

  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!/^--[a-z][a-z0-9-]*$/u.test(token)) {
      cliError("learning_host_receipt_cli_argument_invalid", "unexpected positional or malformed argument");
    }
    const key = token.slice(2);
    if (!ALLOWED_VERIFY_FLAGS.has(key)) {
      cliError("learning_host_receipt_cli_unknown_flag", `unknown flag: --${key}`);
    }
    if (values.has(key)) {
      cliError("learning_host_receipt_cli_duplicate_flag", `duplicate flag: --${key}`);
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      cliError("learning_host_receipt_cli_flag_value_required", `--${key} requires a value`);
    }
    values.set(key, value);
    index += 1;
  }
  for (const key of REQUIRED_VERIFY_FLAGS) {
    const value = values.get(key);
    if (value === undefined || value.length === 0) {
      cliError("learning_host_receipt_cli_required_flag_missing", `missing required --${key}`);
    }
  }
  for (const key of ["manifest", "out"] as const) {
    if (!isAbsolute(requiredValue(values, key))) {
      cliError("learning_host_receipt_cli_absolute_path_required", `--${key} must be an absolute path`);
    }
  }
  const collectorId = requiredValue(values, "collector-id");
  const collectorVersion = requiredValue(values, "collector-version");
  if (!exactBoundedValue(collectorId, 256)) {
    cliError("learning_host_receipt_cli_collector_invalid", "--collector-id must be an exact bounded identifier");
  }
  if (!exactBoundedValue(collectorVersion, 120)) {
    cliError("learning_host_receipt_cli_collector_invalid", "--collector-version must be an exact bounded version");
  }
  if (!DIGEST_SHA256.test(requiredValue(values, "verifier-policy-sha256"))) {
    cliError(
      "learning_host_receipt_cli_verifier_policy_invalid",
      "--verifier-policy-sha256 must be a lowercase SHA-256 digest",
    );
  }
  return { values };
}

function exactBoundedValue(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && value === value.trim();
}

function requiredValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.length === 0) {
    cliError("learning_host_receipt_cli_required_flag_missing", `missing required --${key}`);
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
  if (
    (process.platform === "darwin" || process.platform === "win32")
    && leftIdentity.toLocaleLowerCase("en-US") === rightIdentity.toLocaleLowerCase("en-US")
  ) {
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

function assertPathsDisjoint(values: ReadonlyMap<string, string>): void {
  if (sameFilesystemEntry(requiredValue(values, "manifest"), requiredValue(values, "out"))) {
    cliError(
      "learning_host_receipt_cli_path_collision",
      "--manifest must not alias --out",
    );
  }
}

const FORBIDDEN_EXACT_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "content",
  "credential",
  "credentials",
  "evidence_payload",
  "host_trace",
  "memory_content",
  "password",
  "prompt",
  "prompt_text",
  "raw",
  "raw_content",
  "raw_host_trace",
  "refresh_token",
  "response_text",
  "secret",
  "secrets",
  "token",
  "tool_output",
]);

function forbiddenManifestKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase("en-US").replace(/-/gu, "_");
  return FORBIDDEN_EXACT_KEYS.has(normalized)
    || normalized.startsWith("raw_")
    || normalized.endsWith("_secret")
    || normalized.endsWith("_password")
    || normalized.endsWith("_credential")
    || normalized.endsWith("_token");
}

function assertNoSecretOrRawFields(value: unknown): void {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 100_000) {
      cliError("learning_host_receipt_manifest_invalid", "manifest object graph exceeds its bound");
    }
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (forbiddenManifestKey(key)) {
        cliError(
          "learning_host_receipt_manifest_forbidden_content",
          "manifest contains a forbidden secret, raw-content, prompt, or credential field",
        );
      }
      pending.push(child);
    }
  }
}

type ParsedManifest = Readonly<{
  header: HostReceiptManifestHeaderV1;
  cases: readonly HostReceiptManifestCaseV1[];
  canonicalJsonl: string;
}>;

function parseCanonicalLine(line: string, index: number): unknown {
  if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_MANIFEST_LINE_BYTES) {
    cliError("learning_host_receipt_manifest_invalid", `manifest line ${index + 1} is empty or too large`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    cliError("learning_host_receipt_manifest_invalid", `manifest line ${index + 1} is not valid JSON`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    cliError("learning_host_receipt_manifest_invalid", `manifest line ${index + 1} must contain one JSON object`);
  }
  assertNoSecretOrRawFields(raw);
  if (stableStringify(raw) !== line) {
    cliError("learning_host_receipt_manifest_invalid", `manifest line ${index + 1} must use canonical JSON`);
  }
  return raw;
}

function readManifest(path: string): ParsedManifest {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const before = fstatSync(descriptor);
    if (!before.isFile()) {
      cliError("learning_host_receipt_manifest_invalid", "--manifest must name a regular file");
    }
    if (before.size === 0 || before.size > MAX_MANIFEST_BYTES) {
      cliError("learning_host_receipt_manifest_too_large", "--manifest must contain 1 byte through 2 MiB");
    }
    const encoded = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (encoded.byteLength === 0 || encoded.byteLength > MAX_MANIFEST_BYTES) {
      cliError("learning_host_receipt_manifest_too_large", "--manifest must contain 1 byte through 2 MiB");
    }
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      cliError("learning_host_receipt_manifest_invalid", "--manifest changed while it was being read");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    } catch {
      cliError("learning_host_receipt_manifest_invalid", "--manifest must be valid UTF-8");
    }
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length < 2 || lines.length > MAX_CASES + 1 || lines.some((line) => line.length === 0)) {
      cliError(
        "learning_host_receipt_manifest_invalid",
        `--manifest must contain one header and 1-${MAX_CASES} non-empty case lines`,
      );
    }
    const rawHeader = parseCanonicalLine(lines[0]!, 0);
    let header: HostReceiptManifestHeaderV1;
    try {
      header = HostReceiptManifestHeaderV1Schema.parse(rawHeader);
    } catch {
      cliError("learning_host_receipt_manifest_invalid", "manifest header does not satisfy its strict contract");
    }
    if (stableStringify(header) !== lines[0]) {
      cliError("learning_host_receipt_manifest_invalid", "manifest header is not canonically encoded");
    }

    const cases = lines.slice(1).map((line, index) => {
      const rawCase = parseCanonicalLine(line, index + 1);
      try {
        const parsed = HostReceiptManifestCaseV1Schema.parse(rawCase);
        if (stableStringify(parsed) !== line) {
          cliError("learning_host_receipt_manifest_invalid", `manifest case ${index + 1} is not canonically encoded`);
        }
        return parsed;
      } catch (error) {
        if (error instanceof LearningHostReceiptCliError) throw error;
        cliError("learning_host_receipt_manifest_invalid", `manifest case ${index + 1} does not satisfy its strict contract`);
      }
    });
    if (header.case_count !== cases.length) {
      cliError("learning_host_receipt_manifest_invalid", "manifest header case_count does not match its case lines");
    }
    return { header, cases, canonicalJsonl: `${lines.join("\n")}\n` };
  } catch (error) {
    if (error instanceof LearningHostReceiptCliError) throw error;
    throw new LearningHostReceiptCliError(
      "learning_host_receipt_manifest_invalid",
      "--manifest could not be read",
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function assertUnique(value: string, seen: Set<string>, label: string): void {
  if (seen.has(value)) {
    cliError("learning_host_receipt_manifest_duplicate_identity", `manifest contains a duplicate ${label}`);
  }
  seen.add(value);
}

type VerifiedManifest = Readonly<{
  taskEnvelopeDigests: readonly string[];
  receiptDigests: readonly string[];
  verifierKeys: readonly string[];
  receiptItemCount: number;
}>;

function verifyManifest(
  manifest: ParsedManifest,
  values: ReadonlyMap<string, string>,
): VerifiedManifest {
  const { header } = manifest;
  const collectorId = requiredValue(values, "collector-id");
  const collectorVersion = requiredValue(values, "collector-version");
  if (header.collector_id !== collectorId || header.collector_version !== collectorVersion) {
    cliError(
      "learning_host_receipt_collector_mismatch",
      "collector flags do not match the manifest header",
    );
  }

  const allowedKeys = header.allowed_verifiers.map(verifierKey);
  const sortedAllowedKeys = [...allowedKeys].sort(compareUtf8);
  if (
    new Set(allowedKeys).size !== allowedKeys.length
    || allowedKeys.some((value, index) => value !== sortedAllowedKeys[index])
  ) {
    cliError(
      "learning_host_receipt_verifier_policy_invalid",
      "allowed_verifiers must be unique and sorted by canonical verifier key",
    );
  }
  const expectedPolicySha256 = sha256(stableStringify({
    allowed_verifiers: header.allowed_verifiers,
  }));
  if (
    header.verifier_policy_sha256 !== expectedPolicySha256
    || requiredValue(values, "verifier-policy-sha256") !== expectedPolicySha256
  ) {
    cliError(
      "learning_host_receipt_verifier_policy_mismatch",
      "verifier policy flag/header does not bind the exact allowed_verifiers list",
    );
  }

  const allowedVerifierKeys = new Set(allowedKeys);
  const seenCaseIds = new Set<string>();
  const seenSourceEvents = new Set<string>();
  const seenReceiptIds = new Set<string>();
  const seenOperationIds = new Set<string>();
  const taskEnvelopeDigests: string[] = [];
  const receiptDigests: string[] = [];
  const observedVerifierKeys = new Set<string>();
  let receiptItemCount = 0;

  for (const entry of manifest.cases) {
    const envelope: HostTaskEnvelopeV1 = entry.host_task_envelope_v1;
    const receipt: HostUseReceiptV1 = entry.host_use_receipt_v1;
    assertUnique(entry.case_id, seenCaseIds, "case_id");
    assertUnique(envelope.source_event_sha256, seenSourceEvents, "source_event_sha256");
    assertUnique(receipt.receipt_id, seenReceiptIds, "receipt_id");
    assertUnique(receipt.operation_id, seenOperationIds, "operation_id");

    const envelopeSha256 = hostTaskEnvelopeDigest(envelope);
    if (entry.host_task_envelope_sha256 !== envelopeSha256) {
      cliError(
        "learning_host_receipt_envelope_digest_mismatch",
        "host-task envelope digest does not bind its canonical envelope",
      );
    }
    if (
      envelope.collector_id !== collectorId
      || envelope.collector_version !== collectorVersion
      || receipt.collector_id !== collectorId
      || receipt.collector_version !== collectorVersion
    ) {
      cliError(
        "learning_host_receipt_collector_mismatch",
        "case envelope/receipt collector does not match the named collector",
      );
    }
    if (
      receipt.host_task_id !== envelope.host_task_id
      || receipt.host_task_envelope_sha256 !== envelopeSha256
    ) {
      cliError(
        "learning_host_receipt_binding_mismatch",
        "host-use receipt does not bind the exact host-task envelope",
      );
    }
    for (const item of receipt.items) {
      const key = verifierKey({
        kind: item.verifier_kind,
        version: item.verifier_version,
        config_sha256: item.verifier_config_sha256,
      });
      if (!allowedVerifierKeys.has(key)) {
        cliError(
          "learning_host_receipt_verifier_unregistered",
          "host-use receipt uses a verifier tuple outside the frozen policy",
        );
      }
      observedVerifierKeys.add(key);
      receiptItemCount += 1;
    }
    taskEnvelopeDigests.push(envelopeSha256);
    receiptDigests.push(receipt.receipt_sha256);
  }

  return {
    taskEnvelopeDigests: taskEnvelopeDigests.sort(compareUtf8),
    receiptDigests: receiptDigests.sort(compareUtf8),
    verifierKeys: [...observedVerifierKeys].sort(compareUtf8),
    receiptItemCount,
  };
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeCanonicalResultAtomic(path: string, resultJson: string): void {
  if (Buffer.byteLength(resultJson, "utf8") > MAX_RESULT_BYTES) {
    cliError("learning_host_receipt_result_too_large", "canonical conformance result exceeds 128 KiB");
  }
  const destination = resolve(path);
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(destination)}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | null = null;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    temporaryExists = true;
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, resultJson, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, destination);
    temporaryExists = false;
    fsyncDirectory(directory);
  } catch (error) {
    if (error instanceof LearningHostReceiptCliError) throw error;
    cliError("learning_host_receipt_output_failed", "canonical conformance result could not be written");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (temporaryExists) rmSync(temporary, { force: true });
  }
}

function buildResult(manifest: ParsedManifest, verified: VerifiedManifest) {
  const body = {
    contract_version: "aionis_host_receipt_conformance_result_v1" as const,
    status: "passed" as const,
    authority_ceiling: "contract_conformance_only" as const,
    eligible_host_identity_verified: false as const,
    host_adapter_id: manifest.header.host_adapter_id,
    host_adapter_version: manifest.header.host_adapter_version,
    host_adapter_sha256: manifest.header.host_adapter_sha256,
    collector_id: manifest.header.collector_id,
    collector_version: manifest.header.collector_version,
    verifier_policy_sha256: manifest.header.verifier_policy_sha256,
    manifest_sha256: sha256(manifest.canonicalJsonl),
    case_count: manifest.cases.length,
    receipt_item_count: verified.receiptItemCount,
    task_envelope_set_sha256: sha256(stableStringify(verified.taskEnvelopeDigests)),
    host_use_receipt_set_sha256: sha256(stableStringify(verified.receiptDigests)),
    verifier_tuple_set_sha256: sha256(stableStringify(verified.verifierKeys)),
  };
  return {
    ...body,
    result_sha256: sha256(stableStringify(body)),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof LearningHostReceiptCliError) return error.code;
  return "learning_host_receipt_operation_failed";
}

export async function runLearningHostReceiptCli(
  argv: readonly string[],
  options: LearningHostReceiptCliOptions = {},
): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed === "help") {
      outputTo(options.stdout, process.stdout, usage());
      return 0;
    }
    assertPathsDisjoint(parsed.values);
    const manifest = readManifest(requiredValue(parsed.values, "manifest"));
    const verified = verifyManifest(manifest, parsed.values);
    // Recheck after opening and validating the input so newly observable inode
    // or symlink aliases cannot turn the output into a destructive write.
    assertPathsDisjoint(parsed.values);
    const result = buildResult(manifest, verified);
    const resultJson = stableStringify(result);
    writeCanonicalResultAtomic(requiredValue(parsed.values, "out"), resultJson);
    outputTo(options.stdout, process.stdout, `${resultJson}\n`);
    return 0;
  } catch (error) {
    outputTo(options.stderr, process.stderr, `${stableStringify({
      error: "learning_host_receipt_verification_failed",
      code: errorCode(error),
      message: error instanceof Error ? error.message : "host receipt verification failed",
    })}\n`);
    return 1;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href;
}

if (isMainModule()) {
  void runLearningHostReceiptCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
