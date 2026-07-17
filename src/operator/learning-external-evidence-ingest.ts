import {
  lstatSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  LearningExternalEvidenceArtifactKindSchema,
  type LearningExternalEvidenceArtifactKind,
} from "../memory/learning-external-evidence.js";
import {
  LearningExternalEvidenceReceiptWriterError,
  publishLearningExternalEvidenceReceipt,
} from "./learning-external-evidence-receipt-writer.js";
import {
  ingestLiteLearningExternalEvidence,
  LiteLearningExternalEvidenceServiceError,
} from "../store/lite-learning-external-evidence-service.js";

const REQUIRED_INGEST_FLAGS = Object.freeze([
  "db",
  "tenant",
  "actor",
  "operation-id",
  "kind",
  "public-run-authority",
  "run-bundle",
  "series-id",
  "task-family",
  "applicable-experiment-id",
  "applicable-revision",
  "out",
] as const);

const ALLOWED_INGEST_FLAGS = new Set<string>(REQUIRED_INGEST_FLAGS);
const PATH_FLAGS = Object.freeze([
  "db",
  "public-run-authority",
  "run-bundle",
  "out",
] as const);
const FORMAL_ERROR_CODE = /^(?:learning_external_evidence|lite_runtime_)[a-z0-9_]+$/u;

type CliOutput = (value: string) => void;

type ParsedIngestCommand = Readonly<{
  command: "ingest";
  values: ReadonlyMap<string, string>;
}>;

type ProtectedPath = Readonly<{
  label: string;
  path: string;
}>;

type ProtectedPathIdentity = ProtectedPath & Readonly<{
  normalizedRealpath: string;
  caseFoldedRealpath: string;
  stat: BigIntStats | null;
}>;

export type LearningExternalEvidenceIngestCliOptions = Readonly<{
  stdout?: CliOutput;
  stderr?: CliOutput;
}>;

export type LearningExternalEvidenceIngestCliErrorCode =
  | "learning_external_evidence_cli_unknown_command"
  | "learning_external_evidence_cli_argument_invalid"
  | "learning_external_evidence_cli_unknown_flag"
  | "learning_external_evidence_cli_duplicate_flag"
  | "learning_external_evidence_cli_flag_value_required"
  | "learning_external_evidence_cli_required_flag_missing"
  | "learning_external_evidence_cli_absolute_path_required"
  | "learning_external_evidence_cli_path_inspection_failed"
  | "learning_external_evidence_cli_path_collision"
  | "learning_external_evidence_cli_kind_invalid"
  | "learning_external_evidence_cli_revision_invalid";

export class LearningExternalEvidenceIngestCliError extends Error {
  readonly code: LearningExternalEvidenceIngestCliErrorCode;

  constructor(code: LearningExternalEvidenceIngestCliErrorCode, message: string) {
    super(message);
    this.name = "LearningExternalEvidenceIngestCliError";
    this.code = code;
  }
}

function cliError(
  code: LearningExternalEvidenceIngestCliErrorCode,
  message: string,
): never {
  throw new LearningExternalEvidenceIngestCliError(code, message);
}

export function learningExternalEvidenceIngestUsage(): string {
  return `Aionis external learning-evidence ingestion

Usage:
  npx tsx scripts/learning-evidence.ts ingest \\
    --db /absolute/path/to/runtime.sqlite \\
    --tenant TENANT_ID --actor ACTOR --operation-id OPERATION_ID \\
    --kind offline_paired_rerun|production_shadow_gate|tool_e2e_gate \\
    --public-run-authority /absolute/path/to/public-run-authority.json \\
    --run-bundle /absolute/path/to/run-bundle.aionis \\
    --series-id EVIDENCE_SERIES_ID --task-family TASK_FAMILY \\
    --applicable-experiment-id EXPERIMENT_ID \\
    --applicable-revision REVISION \\
    --out /absolute/path/to/persisted-receipt.json
`;
}

function outputTo(
  sink: CliOutput | undefined,
  fallback: NodeJS.WriteStream,
  value: string,
): void {
  if (sink) {
    sink(value);
    return;
  }
  fallback.write(value);
}

function assertCanonicalAbsolutePath(value: string, flag: string): void {
  if (!isAbsolute(value)
    || value !== normalize(value)
    || value !== resolve(value)
    || value.includes("\0")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || basename(value).length === 0) {
    cliError(
      "learning_external_evidence_cli_absolute_path_required",
      `--${flag} must be a canonical absolute file path`,
    );
  }
}

function parseLearningExternalEvidenceIngestArgs(
  argv: readonly string[],
): ParsedIngestCommand | "help" {
  const [command, ...tokens] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    if (command !== undefined && tokens.length > 0) {
      cliError(
        "learning_external_evidence_cli_argument_invalid",
        "help does not accept additional arguments",
      );
    }
    return "help";
  }
  if (command !== "ingest") {
    cliError(
      "learning_external_evidence_cli_unknown_command",
      `unknown command: ${command}`,
    );
  }
  if (tokens.length === 1 && tokens[0] === "--help") return "help";

  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!/^--[a-z][a-z0-9-]*$/u.test(token)) {
      cliError(
        "learning_external_evidence_cli_argument_invalid",
        `unexpected argument: ${token}`,
      );
    }
    const key = token.slice(2);
    if (!ALLOWED_INGEST_FLAGS.has(key)) {
      cliError(
        "learning_external_evidence_cli_unknown_flag",
        `unknown flag: --${key}`,
      );
    }
    if (values.has(key)) {
      cliError(
        "learning_external_evidence_cli_duplicate_flag",
        `duplicate flag: --${key}`,
      );
    }
    const value = tokens[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      cliError(
        "learning_external_evidence_cli_flag_value_required",
        `--${key} requires a non-empty value`,
      );
    }
    values.set(key, value);
    index += 1;
  }

  for (const key of REQUIRED_INGEST_FLAGS) {
    if (!values.has(key)) {
      cliError(
        "learning_external_evidence_cli_required_flag_missing",
        `missing required --${key}`,
      );
    }
  }
  for (const key of PATH_FLAGS) {
    assertCanonicalAbsolutePath(requiredValue(values, key), key);
  }
  return { command, values };
}

function requiredValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.length === 0) {
    cliError(
      "learning_external_evidence_cli_required_flag_missing",
      `missing required --${key}`,
    );
  }
  return value;
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function normalizedRealpathIncludingMissingTail(path: string): string {
  let cursor = path;
  const missingTail: string[] = [];
  while (true) {
    try {
      lstatSync(cursor);
    } catch (error) {
      if (filesystemErrorCode(error) !== "ENOENT") {
        cliError(
          "learning_external_evidence_cli_path_inspection_failed",
          `protected path could not be inspected: ${path}`,
        );
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        cliError(
          "learning_external_evidence_cli_path_inspection_failed",
          `protected path has no resolvable ancestor: ${path}`,
        );
      }
      missingTail.unshift(basename(cursor));
      cursor = parent;
      continue;
    }

    let canonicalAncestor: string;
    try {
      canonicalAncestor = realpathSync.native(cursor);
    } catch {
      cliError(
        "learning_external_evidence_cli_path_inspection_failed",
        `protected path could not be resolved safely: ${path}`,
      );
    }
    return missingTail.reduce((parent, member) => join(parent, member), canonicalAncestor);
  }
}

function existingPathStat(path: string): BigIntStats | null {
  try {
    return statSync(path, { bigint: true });
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") return null;
    cliError(
      "learning_external_evidence_cli_path_inspection_failed",
      `protected path identity could not be inspected: ${path}`,
    );
  }
}

function protectedPaths(values: ReadonlyMap<string, string>): readonly ProtectedPath[] {
  const database = requiredValue(values, "db");
  // The protected service opens the database's canonical real path, so SQLite
  // creates its sidecars next to that target rather than next to a lexical
  // symlink supplied through --db. Derive the collision boundary from the
  // same real path or an output could otherwise alias the actual -journal,
  // -wal, or -shm name while appearing disjoint from the symlink spelling.
  const databaseRealpath = normalizedRealpathIncludingMissingTail(database);
  return Object.freeze([
    { label: "--db", path: database },
    { label: "--db WAL sidecar", path: `${databaseRealpath}-wal` },
    { label: "--db shared-memory sidecar", path: `${databaseRealpath}-shm` },
    { label: "--db rollback-journal sidecar", path: `${databaseRealpath}-journal` },
    { label: "--run-bundle", path: requiredValue(values, "run-bundle") },
    {
      label: "--public-run-authority",
      path: requiredValue(values, "public-run-authority"),
    },
    { label: "--out", path: requiredValue(values, "out") },
  ]);
}

function protectedPathIdentity(value: ProtectedPath): ProtectedPathIdentity {
  const normalizedRealpath = normalizedRealpathIncludingMissingTail(value.path);
  return {
    ...value,
    normalizedRealpath,
    caseFoldedRealpath: normalizedRealpath
      .normalize("NFC")
      .toLocaleLowerCase("en-US"),
    stat: existingPathStat(value.path),
  };
}

function sameInode(
  left: BigIntStats | null,
  right: BigIntStats | null,
): boolean {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino;
}

function assertProtectedPathsDisjoint(values: ReadonlyMap<string, string>): void {
  const identities = protectedPaths(values).map(protectedPathIdentity);
  for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
    const left = identities[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1) {
      const right = identities[rightIndex]!;
      if (left.normalizedRealpath !== right.normalizedRealpath
        && left.caseFoldedRealpath !== right.caseFoldedRealpath
        && !sameInode(left.stat, right.stat)) {
        continue;
      }
      cliError(
        "learning_external_evidence_cli_path_collision",
        `${left.label} must not alias ${right.label}`,
      );
    }
  }
}

function positiveRevision(raw: string): number {
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    cliError(
      "learning_external_evidence_cli_revision_invalid",
      "--applicable-revision must be a positive integer",
    );
  }
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision)) {
    cliError(
      "learning_external_evidence_cli_revision_invalid",
      "--applicable-revision exceeds the safe integer range",
    );
  }
  return revision;
}

function artifactKind(raw: string): LearningExternalEvidenceArtifactKind {
  const parsed = LearningExternalEvidenceArtifactKindSchema.safeParse(raw);
  if (!parsed.success) {
    cliError(
      "learning_external_evidence_cli_kind_invalid",
      "--kind must be offline_paired_rerun, production_shadow_gate, or tool_e2e_gate",
    );
  }
  return parsed.data;
}

function formalErrorCode(error: unknown): string {
  if (error instanceof LearningExternalEvidenceIngestCliError
    || error instanceof LiteLearningExternalEvidenceServiceError
    || error instanceof LearningExternalEvidenceReceiptWriterError) {
    return error.code;
  }
  if (typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && FORMAL_ERROR_CODE.test(error.code)) {
    return error.code;
  }
  return "learning_external_evidence_ingest_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @internal Exported for deterministic operator-envelope contract tests. */
export function learningExternalEvidenceIngestCliFailureJson(
  error: unknown,
  committed: boolean,
): string {
  if (committed) {
    return stableStringify({
      error: "learning_external_evidence_ingest_failed",
      code: "learning_external_evidence_receipt_output_failed_after_commit",
      message: `evidence was committed but durable receipt output failed: ${errorMessage(error)}`,
      committed: true,
      retry: "same_operation_id",
    });
  }
  return stableStringify({
    error: "learning_external_evidence_ingest_failed",
    code: formalErrorCode(error),
    message: errorMessage(error),
  });
}

export async function runLearningExternalEvidenceIngestCli(
  argv: readonly string[],
  options: LearningExternalEvidenceIngestCliOptions = {},
): Promise<number> {
  let committed = false;
  try {
    const parsed = parseLearningExternalEvidenceIngestArgs(argv);
    if (parsed === "help") {
      outputTo(options.stdout, process.stdout, learningExternalEvidenceIngestUsage());
      return 0;
    }

    const values = parsed.values;
    assertProtectedPathsDisjoint(values);
    const result = await ingestLiteLearningExternalEvidence({
      databasePath: requiredValue(values, "db"),
      archivePath: requiredValue(values, "run-bundle"),
      publicRunAuthorityPath: requiredValue(values, "public-run-authority"),
      tenantId: requiredValue(values, "tenant"),
      actorId: requiredValue(values, "actor"),
      operationId: requiredValue(values, "operation-id"),
      artifactKind: artifactKind(requiredValue(values, "kind")),
      evidenceSeriesId: requiredValue(values, "series-id"),
      taskFamily: requiredValue(values, "task-family"),
      applicableExperimentId: requiredValue(values, "applicable-experiment-id"),
      applicableExperimentRevision: positiveRevision(
        requiredValue(values, "applicable-revision"),
      ),
    });
    committed = true;

    const canonicalReceiptJson = stableStringify(result.receipt);
    if (canonicalReceiptJson !== result.receiptJson) {
      throw new Error("external evidence service returned noncanonical receipt bytes");
    }
    // Re-resolve every protected path after the transaction has returned. This
    // catches aliases that were created or became observable during ingest.
    assertProtectedPathsDisjoint(values);
    publishLearningExternalEvidenceReceipt({
      destination: requiredValue(values, "out"),
      receiptJson: canonicalReceiptJson,
    });
    outputTo(options.stdout, process.stdout, `${canonicalReceiptJson}\n`);
    return 0;
  } catch (error) {
    if (error instanceof LiteLearningExternalEvidenceServiceError
      && error.committed) {
      committed = true;
    }
    outputTo(
      options.stderr,
      process.stderr,
      `${learningExternalEvidenceIngestCliFailureJson(error, committed)}\n`,
    );
    return 1;
  }
}
