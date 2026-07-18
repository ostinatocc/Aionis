import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS,
  LearningExternalIngestionLedgerVerificationV1Schema,
  LearningExternalRuntimeWriteSchemaVersionV1Schema,
  LearningExternalRequiredSeriesStatusEntryV1Schema,
  LearningExternalRequiredSeriesStatusV1Schema,
  RegisteredEvidenceSeriesV1Schema,
  RegisteredRevisionDigestsV1Schema,
  ResultTupleV1Schema,
  TerminalCoveragePreclaimHoldBranchV1Schema,
  TerminalCoverageResultBranchV1Schema,
  TerminalCoverageTerminationHoldBranchV1Schema,
  TerminalCoverageUnstartedBranchV1Schema,
  learningExternalIngestionLedgerVerificationDigest,
  learningExternalIngestionRevisionRowDigestV1,
  learningExternalRequiredSeriesStatusDigest,
  learningExternalTerminalCoverageFinalizedAtFromDatabaseFacts,
  learningRuntimeAuthorityRowV1,
} from "../../src/memory/learning-external-ingestion-attestation.js";
import { LearningExternalCanonicalUtcMillisSchema } from "../../src/memory/learning-external-authority.js";
import type { AuthorityReceiptResolvedKeyring } from "../../src/util/authority-receipt-keys.js";
import {
  LiteLearningExternalEvidenceIngestOperationReceiptV1Schema,
  type LiteLearningExternalEvidenceIngestOperationReceiptV1,
} from "../../packages/aionis-learning-authority/src/store/lite-learning-external-evidence-ingestion.js";
import { resolveLiteLearningExternalNormalLifecycleSnapshot } from "../../src/store/lite-learning-external-authority.js";
import {
  assertLiteLearningEpisodeLedgerIntegrity,
  assertLiteRuntimeAuthorityIdentity,
} from "../../src/store/lite-learning-episode-ledger.js";
import {
  readLiteLearningRuntimeAuthorityExactRows,
  readLiteLearningRuntimeExternalIngestionOperationRowsV1,
  type LiteLearningRuntimeAuthorityTypedRow,
} from "./lite-learning-runtime-authority-head.js";
import type { LiteRuntimeDatabase } from "../../src/store/lite-runtime-database.js";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_COMPONENT,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../src/store/lite-runtime-schema.js";

const MAX_CANONICAL_DRAFT_BYTES = 1_048_576;
const MAX_REQUIRED_SERIES_JSON_BYTES = 1_048_576;
const MAX_INGEST_RECEIPT_BYTES = 40 * 1024 * 1024;
function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const BoundedIdSchema = z.string().superRefine((value, context) => {
  if (value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > 256
    || containsUnpairedSurrogate(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected an exact identifier bounded to 256 UTF-8 bytes",
    });
  }
});
const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const TerminalCoverageTerminationHoldDatabaseBranchV1Schema =
  TerminalCoverageTerminationHoldBranchV1Schema.omit({
    termination_hold_bundle_sha256: true,
  });
const TerminalCoveragePreclaimHoldDatabaseBranchV1Schema =
  TerminalCoveragePreclaimHoldBranchV1Schema.omit({
    preclaim_hold_bundle_sha256: true,
  });

const TerminalCoverageDatabaseBranchV1Schema = z.discriminatedUnion("branch_kind", [
  TerminalCoverageResultBranchV1Schema,
  TerminalCoverageTerminationHoldDatabaseBranchV1Schema,
  TerminalCoveragePreclaimHoldDatabaseBranchV1Schema,
  TerminalCoverageUnstartedBranchV1Schema,
]);

export const LiteLearningExternalTerminalCoverageDatabaseDraftV1Schema = z.object({
  contract_version: z.literal(
    "aionis_learning_external_terminal_coverage_database_draft_v1",
  ),
  tenant_id: BoundedIdSchema,
  task_family: BoundedIdSchema,
  experiment_id: BoundedIdSchema,
  experiment_revision: PositiveSafeIntegerSchema,
  required_evidence_series_sha256: DigestSha256Schema,
  branches: z.array(TerminalCoverageDatabaseBranchV1Schema).length(3),
  finalized_at: LearningExternalCanonicalUtcMillisSchema,
  coverage_finality: z.literal("d3_launcher_write_fence_capability_required"),
}).strict().superRefine((value, context) => {
  for (const [index, expected] of LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS.entries()) {
    const actual = value.branches[index];
    if (actual?.role !== expected.role || actual.artifact_kind !== expected.artifact_kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["branches", index],
        message: "Database coverage must contain all external roles in canonical order",
      });
    }
    if (actual?.branch_kind !== "termination_hold") continue;
    const requiresNoBinding = actual.termination_reason === "launch_failure"
      || actual.termination_reason === "binding_integrity_failure";
    const requiresBinding = actual.termination_reason === "runner_crash"
      || actual.termination_reason === "post_quiesce_revoke"
      || actual.termination_reason === "finalize_timeout";
    if ((requiresNoBinding && actual.supervisor_binding_id !== null)
      || (requiresBinding && actual.supervisor_binding_id === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["branches", index, "supervisor_binding_id"],
        message: "Termination reason and supervisor binding shape disagree",
      });
    }
  }
});

const HoldCapabilityRequirementV1Schema = z.discriminatedUnion("branch_kind", [
  z.object({
    role: z.literal("offline_paired").or(z.literal("production_shadow")).or(z.literal("tool_e2e")),
    evidence_series_id: BoundedIdSchema,
    branch_kind: z.literal("termination_hold"),
    terminal_fact_sha256: DigestSha256Schema,
    capability: z.literal(
      "d3_verified_tracked_termination_hold_bundle_capability_required",
    ),
  }).strict(),
  z.object({
    role: z.literal("offline_paired").or(z.literal("production_shadow")).or(z.literal("tool_e2e")),
    evidence_series_id: BoundedIdSchema,
    branch_kind: z.literal("preclaim_hold"),
    terminal_fact_sha256: DigestSha256Schema,
    capability: z.literal(
      "d3_verified_tracked_preclaim_hold_bundle_capability_required",
    ),
  }).strict(),
]);

const D3CapabilityRequirementsV1Schema = z.object({
  coverage_final_write_fence: z.literal("required_before_final_projection"),
  unstarted_roles: z.array(
    z.literal("offline_paired").or(z.literal("production_shadow")).or(z.literal("tool_e2e")),
  ).max(3),
  physical_database_lineage: z.literal(
    "d3_launcher_database_binding_capability_required",
  ),
  database_binding_receipt: z.literal(
    "d3_launcher_database_binding_capability_required",
  ),
  authority_head: z.literal("d3_same_transaction_authority_head_required"),
  hold_bundles: z.array(HoldCapabilityRequirementV1Schema).max(3),
}).strict();

export const LiteLearningExternalIngestionDatabaseProjectionDraftV1Schema = z.object({
  contract_version: z.literal("unsigned_d2_database_projection_draft_v1"),
  signing_eligible: z.literal(false),
  schema_component: z.literal("write_projection"),
  schema_version: LearningExternalRuntimeWriteSchemaVersionV1Schema,
  database_instance_id: DigestSha256Schema,
  ledger_verifier_id: z.literal("aionis_lite_learning_ledger_replay"),
  ledger_verifier_version: z.literal(1),
  ledger_verification: LearningExternalIngestionLedgerVerificationV1Schema,
  ledger_verification_sha256: DigestSha256Schema,
  tenant_id: BoundedIdSchema,
  task_family: BoundedIdSchema,
  confirmatory_attempt_id: BoundedIdSchema,
  experiment_id: BoundedIdSchema,
  experiment_revision: PositiveSafeIntegerSchema,
  registered_revision: RegisteredRevisionDigestsV1Schema,
  registered_evidence_series: RegisteredEvidenceSeriesV1Schema,
  required_series_status: LearningExternalRequiredSeriesStatusV1Schema,
  required_series_status_sha256: DigestSha256Schema,
  terminal_coverage_database_draft:
    LiteLearningExternalTerminalCoverageDatabaseDraftV1Schema,
  terminal_coverage_database_draft_sha256: DigestSha256Schema,
  result_tuples: z.array(ResultTupleV1Schema).max(3),
  result_tuples_sha256: DigestSha256Schema,
  d3_capability_requirements: D3CapabilityRequirementsV1Schema,
}).strict().superRefine((value, context) => {
  const status = value.required_series_status;
  const coverage = value.terminal_coverage_database_draft;
  const bindings: ReadonlyArray<readonly [unknown, unknown, readonly (string | number)[]]> = [
    [value.schema_version, value.ledger_verification.schema_version,
      ["ledger_verification", "schema_version"]],
    [value.database_instance_id, value.ledger_verification.database_instance_id,
      ["ledger_verification", "database_instance_id"]],
    [value.ledger_verifier_id, value.ledger_verification.ledger_verifier_id,
      ["ledger_verification", "ledger_verifier_id"]],
    [value.ledger_verifier_version, value.ledger_verification.ledger_verifier_version,
      ["ledger_verification", "ledger_verifier_version"]],
    [coverage.finalized_at, value.ledger_verification.checked_at,
      ["ledger_verification", "checked_at"]],
    [status.tenant_id, value.tenant_id, ["required_series_status", "tenant_id"]],
    [coverage.tenant_id, value.tenant_id,
      ["terminal_coverage_database_draft", "tenant_id"]],
    [status.task_family, value.task_family, ["required_series_status", "task_family"]],
    [coverage.task_family, value.task_family,
      ["terminal_coverage_database_draft", "task_family"]],
    [status.experiment_id, value.experiment_id,
      ["required_series_status", "experiment_id"]],
    [coverage.experiment_id, value.experiment_id,
      ["terminal_coverage_database_draft", "experiment_id"]],
    [status.experiment_revision, value.experiment_revision,
      ["required_series_status", "experiment_revision"]],
    [coverage.experiment_revision, value.experiment_revision,
      ["terminal_coverage_database_draft", "experiment_revision"]],
    [status.required_evidence_series_sha256,
      value.registered_revision.required_evidence_series_sha256,
      ["required_series_status", "required_evidence_series_sha256"]],
    [coverage.required_evidence_series_sha256,
      value.registered_revision.required_evidence_series_sha256,
      ["terminal_coverage_database_draft", "required_evidence_series_sha256"]],
  ];
  for (const [actual, expected, path] of bindings) {
    if (actual !== expected) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "binding mismatch" });
    }
  }

  const digestBindings: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    [value.ledger_verification_sha256,
      learningExternalIngestionLedgerVerificationDigest(value.ledger_verification),
      ["ledger_verification_sha256"]],
    [value.registered_revision.required_evidence_series_sha256,
      sha256Canonical(value.registered_evidence_series),
      ["registered_revision", "required_evidence_series_sha256"]],
    [value.required_series_status_sha256,
      learningExternalRequiredSeriesStatusDigest(status),
      ["required_series_status_sha256"]],
    [value.terminal_coverage_database_draft_sha256,
      sha256Canonical(coverage),
      ["terminal_coverage_database_draft_sha256"]],
    [value.result_tuples_sha256, sha256Canonical(value.result_tuples),
      ["result_tuples_sha256"]],
  ];
  for (const [actual, expected, path] of digestBindings) {
    if (actual !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path],
        message: "canonical digest mismatch",
      });
    }
  }

  const resultBranches: Array<z.infer<typeof TerminalCoverageResultBranchV1Schema>> = [];
  const expectedUnstartedRoles: string[] = [];
  const expectedHoldRequirements: Array<z.infer<typeof HoldCapabilityRequirementV1Schema>> = [];
  for (const [index, roleSpec] of LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS.entries()) {
    const expectedSeriesId = value.registered_evidence_series[roleSpec.role];
    const statusEntry = status.series[index];
    const branch = coverage.branches[index];
    if (!statusEntry || !branch
      || statusEntry.role !== roleSpec.role
      || branch.role !== roleSpec.role
      || statusEntry.artifact_kind !== roleSpec.artifact_kind
      || branch.artifact_kind !== roleSpec.artifact_kind
      || statusEntry.evidence_series_id !== expectedSeriesId
      || branch.evidence_series_id !== expectedSeriesId
      || statusEntry.branch_kind !== branch.branch_kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["required_series_status", "series", index],
        message: "registered series, status, and database coverage disagree",
      });
      continue;
    }
    if (branch.branch_kind === "result") {
      resultBranches.push(branch);
      if (statusEntry.branch_kind !== "result"
        || statusEntry.artifact_status !== branch.artifact_status) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["required_series_status", "series", index],
          message: "result status mismatch",
        });
      }
    } else if (branch.branch_kind === "termination_hold") {
      if (statusEntry.branch_kind !== "termination_hold"
        || statusEntry.termination_reason !== branch.termination_reason) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["required_series_status", "series", index],
          message: "termination-hold reason mismatch",
        });
      }
      expectedHoldRequirements.push({
        role: branch.role,
        evidence_series_id: branch.evidence_series_id,
        branch_kind: "termination_hold",
        terminal_fact_sha256: branch.session_termination_sha256,
        capability: "d3_verified_tracked_termination_hold_bundle_capability_required",
      });
    } else if (branch.branch_kind === "preclaim_hold") {
      if (statusEntry.branch_kind !== "preclaim_hold"
        || statusEntry.preclaim_hold_reason !== branch.preclaim_hold_reason) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["required_series_status", "series", index],
          message: "preclaim-hold reason mismatch",
        });
      }
      expectedHoldRequirements.push({
        role: branch.role,
        evidence_series_id: branch.evidence_series_id,
        branch_kind: "preclaim_hold",
        terminal_fact_sha256: branch.preclaim_hold_sha256,
        capability: "d3_verified_tracked_preclaim_hold_bundle_capability_required",
      });
    } else {
      expectedUnstartedRoles.push(branch.role);
    }
  }

  if (stableStringify(value.d3_capability_requirements.unstarted_roles)
      !== stableStringify(expectedUnstartedRoles)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["d3_capability_requirements", "unstarted_roles"],
      message: "unstarted roles do not match the database snapshot",
    });
  }
  if (stableStringify(value.d3_capability_requirements.hold_bundles)
      !== stableStringify(expectedHoldRequirements)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["d3_capability_requirements", "hold_bundles"],
      message: "hold capability requirements do not match the database snapshot",
    });
  }

  if (value.result_tuples.length !== resultBranches.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["result_tuples"],
      message: "every result branch must have exactly one result tuple",
    });
  }
  for (const [index, branch] of resultBranches.entries()) {
    const tuple = value.result_tuples[index];
    if (!tuple) continue;
    for (const field of [
      "role", "artifact_kind", "evidence_series_id", "artifact_status", "reservation_id",
      "ticket_consumption_id", "claim_id", "supervisor_binding_id",
      "session_termination_id", "session_termination_sha256", "report_sha256",
      "public_run_authority_sha256", "run_bundle_manifest_sha256",
      "run_bundle_archive_sha256", "bundle_commit_id",
    ] as const) {
      if (tuple[field] !== branch[field]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["result_tuples", index, field],
          message: "result tuple does not match the coverage branch",
        });
      }
    }
  }

  if (Buffer.byteLength(stableStringify(value), "utf8") > MAX_CANONICAL_DRAFT_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "D2 database projection draft exceeds its canonical byte limit",
    });
  }
});

export type LiteLearningExternalIngestionDatabaseProjectionDraftV1 = z.infer<
  typeof LiteLearningExternalIngestionDatabaseProjectionDraftV1Schema
>;

export type ProjectLiteLearningExternalIngestionDatabaseDraftV1Args = Readonly<{
  database: LiteRuntimeDatabase;
  tenantId: string;
  confirmatoryAttemptId: string;
  authorityReceiptKeyring?: AuthorityReceiptResolvedKeyring;
}>;

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function liteLearningExternalIngestionDatabaseProjectionDraftJsonV1(
  value: unknown,
): string {
  return stableStringify(
    LiteLearningExternalIngestionDatabaseProjectionDraftV1Schema.parse(value),
  );
}

export function liteLearningExternalIngestionDatabaseProjectionDraftDigestV1(
  value: unknown,
): string {
  return createHash("sha256")
    .update(liteLearningExternalIngestionDatabaseProjectionDraftJsonV1(value))
    .digest("hex");
}

type ExternalRoleSpec = (typeof LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS)[number];
type ResultTupleV1 = z.infer<typeof ResultTupleV1Schema>;
type RequiredSeriesStatusV1 = z.infer<typeof LearningExternalRequiredSeriesStatusV1Schema>;
type TerminalCoverageDatabaseDraftV1 = z.infer<
  typeof LiteLearningExternalTerminalCoverageDatabaseDraftV1Schema
>;
type TerminalFactTimeV1 =
  | Readonly<{
    role: ExternalRoleSpec["role"];
    branch_kind: "result";
    ingest_operation_created_at: string;
  }>
  | Readonly<{
    role: ExternalRoleSpec["role"];
    branch_kind: "termination_hold";
    terminated_at: string;
  }>
  | Readonly<{
    role: ExternalRoleSpec["role"];
    branch_kind: "preclaim_hold";
    held_at: string;
  }>;

type ParsedIngestOperation = Readonly<{
  row: LiteLearningRuntimeAuthorityTypedRow;
  receipt: LiteLearningExternalEvidenceIngestOperationReceiptV1;
  receiptSha256: string;
  rowSha256: string;
}>;

function projectorError(code: string, detail: string): never {
  throw new Error(`lite_learning_external_ingestion_projector_${code}:${detail}`);
}

function assertActiveTransaction(database: LiteRuntimeDatabase): symbol {
  if (!database.transaction.inTransaction()) {
    return projectorError(
      "active_transaction_required",
      "D2 reconstruction must run inside an active Runtime transaction",
    );
  }
  const identity = database.transaction.currentTransactionIdentity();
  if (identity === null) {
    return projectorError(
      "transaction_identity_required",
      "active Runtime transaction has no identity",
    );
  }
  return identity;
}

function assertSameTransaction(database: LiteRuntimeDatabase, identity: symbol): void {
  if (!database.transaction.inTransaction()
    || database.transaction.currentTransactionIdentity() !== identity) {
    return projectorError(
      "transaction_identity_changed",
      "D2 reconstruction escaped the transaction where it started",
    );
  }
}

function assertCurrentV5Schema(database: LiteRuntimeDatabase): void {
  const schema = inspectLiteRuntimeSchema(database.db);
  if (schema.classification !== "current"
    || schema.component !== LITE_RUNTIME_WRITE_SCHEMA_COMPONENT
    || schema.detected_version !== LITE_RUNTIME_WRITE_SCHEMA_VERSION) {
    return projectorError(
      "current_v5_database_required",
      "D2 reconstruction accepts only the exact current write_projection schema",
    );
  }
}

function assertSqliteHealth(database: LiteRuntimeDatabase): void {
  const quickRows = database.db.prepare("PRAGMA quick_check(1)").all();
  const quickValues = quickRows.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    return Object.values(row as Readonly<Record<string, unknown>>);
  });
  if (quickRows.length !== 1 || quickValues.length !== 1 || quickValues[0] !== "ok") {
    return projectorError("sqlite_quick_check_failed", stableStringify(quickRows));
  }
  const firstForeignKeyViolation = database.db.prepare("PRAGMA foreign_key_check").get();
  if (firstForeignKeyViolation !== undefined) {
    return projectorError(
      "sqlite_foreign_key_check_failed",
      stableStringify(firstForeignKeyViolation),
    );
  }
}

function typedColumn(
  row: LiteLearningRuntimeAuthorityTypedRow,
  column: string,
): LiteLearningRuntimeAuthorityTypedRow[string] {
  const value = row[column];
  if (!value) return projectorError("typed_column_missing", column);
  return value;
}

function textValue(row: LiteLearningRuntimeAuthorityTypedRow, column: string): string {
  const value = typedColumn(row, column);
  if (value.storage_class !== "text") {
    return projectorError("text_storage_class_required", column);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value.value);
  } catch {
    return projectorError("text_invalid_utf8", column);
  }
  if (Buffer.compare(Buffer.from(decoded, "utf8"), Buffer.from(value.value)) !== 0) {
    return projectorError("text_noncanonical_utf8", column);
  }
  return decoded;
}

function boundedIdValue(row: LiteLearningRuntimeAuthorityTypedRow, column: string): string {
  return BoundedIdSchema.parse(textValue(row, column));
}

function digestValue(row: LiteLearningRuntimeAuthorityTypedRow, column: string): string {
  return DigestSha256Schema.parse(textValue(row, column));
}

function canonicalTimeValue(row: LiteLearningRuntimeAuthorityTypedRow, column: string): string {
  return LearningExternalCanonicalUtcMillisSchema.parse(textValue(row, column));
}

function integerValue(row: LiteLearningRuntimeAuthorityTypedRow, column: string): number {
  const value = typedColumn(row, column);
  if (value.storage_class !== "integer") {
    return projectorError("integer_storage_class_required", column);
  }
  if (!Number.isSafeInteger(value.value) || Object.is(value.value, -0)) {
    return projectorError("safe_integer_required", column);
  }
  return value.value;
}

function nullableTextValue(
  row: LiteLearningRuntimeAuthorityTypedRow,
  column: string,
): string | null {
  const value = typedColumn(row, column);
  if (value.storage_class === "null") return null;
  return textValue(row, column);
}

function exactRows(args: Readonly<{
  database: LiteRuntimeDatabase;
  table: string;
  bindings: Readonly<Record<string, string | number | Uint8Array | null>>;
}>): readonly LiteLearningRuntimeAuthorityTypedRow[] {
  return readLiteLearningRuntimeAuthorityExactRows(args);
}

function exactlyOne(
  rows: readonly LiteLearningRuntimeAuthorityTypedRow[],
  label: string,
): LiteLearningRuntimeAuthorityTypedRow {
  if (rows.length !== 1) {
    return projectorError("exactly_one_row_required", `${label}:${rows.length}`);
  }
  return rows[0]!;
}

function atMostOne(
  rows: readonly LiteLearningRuntimeAuthorityTypedRow[],
  label: string,
): LiteLearningRuntimeAuthorityTypedRow | null {
  if (rows.length > 1) {
    return projectorError("at_most_one_row_required", `${label}:${rows.length}`);
  }
  return rows[0] ?? null;
}

function parseCanonicalJson<T>(args: Readonly<{
  raw: string;
  schema: z.ZodType<T>;
  label: string;
  maxBytes: number;
}>): T {
  if (Buffer.byteLength(args.raw, "utf8") > args.maxBytes) {
    return projectorError("canonical_json_too_large", args.label);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(args.raw);
  } catch {
    return projectorError("canonical_json_invalid", args.label);
  }
  if (stableStringify(decoded) !== args.raw) {
    return projectorError("canonical_json_noncanonical", args.label);
  }
  const parsed = args.schema.parse(decoded);
  if (stableStringify(parsed) !== args.raw) {
    return projectorError("canonical_json_schema_normalized", args.label);
  }
  return parsed;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) return projectorError("binding_mismatch", label);
}

function plainSqliteValue(row: LiteLearningRuntimeAuthorityTypedRow, column: string): unknown {
  const value = typedColumn(row, column);
  if (value.storage_class === "null") return null;
  if (value.storage_class === "integer") return value.value;
  if (value.storage_class === "text") return textValue(row, column);
  return Buffer.from(value.value);
}

function sqliteValueEqual(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    return Buffer.compare(Buffer.from(actual), Buffer.from(expected)) === 0;
  }
  return Object.is(actual, expected);
}

function assertTypedRowMatchesRaw(
  typed: LiteLearningRuntimeAuthorityTypedRow,
  raw: Readonly<Record<string, unknown>>,
  label: string,
): void {
  for (const column of Object.keys(raw)) {
    if (!(column in typed)
      || !sqliteValueEqual(plainSqliteValue(typed, column), raw[column])) {
      return projectorError("resolver_row_mismatch", `${label}.${column}`);
    }
  }
}

function assertAttemptRevisionBindings(
  attempt: LiteLearningRuntimeAuthorityTypedRow,
  revision: LiteLearningRuntimeAuthorityTypedRow,
): void {
  for (const field of [
    "tenant_id",
    "candidate_policy_id",
    "candidate_policy_version",
    "candidate_policy_implementation_sha256",
    "experiment_id",
    "experiment_revision",
    "gate_policy_id",
    "gate_policy_version",
    "gate_policy_config_sha256",
    "eligible_memory_namespace_set_sha256",
    "eligible_memory_namespace_count",
    "randomization_pair_manifest_sha256",
    "randomization_pair_count",
    "activation_schedule_sha256",
  ] as const) {
    if (!sqliteValueEqual(plainSqliteValue(attempt, field), plainSqliteValue(revision, field))) {
      return projectorError("attempt_revision_mismatch", field);
    }
  }
  assertEqual(textValue(revision, "evidence_intent"), "confirmatory", "revision.evidence_intent");
  assertEqual(textValue(revision, "serving_phase"), "active_control", "revision.serving_phase");
}

function assertReservationBindings(args: Readonly<{
  reservation: LiteLearningRuntimeAuthorityTypedRow;
  roleSpec: ExternalRoleSpec;
  evidenceSeriesId: string;
  attempt: LiteLearningRuntimeAuthorityTypedRow;
  revision: LiteLearningRuntimeAuthorityTypedRow;
}>): void {
  const { reservation, roleSpec, evidenceSeriesId, attempt, revision } = args;
  assertEqual(textValue(reservation, "artifact_kind"), roleSpec.artifact_kind,
    `${roleSpec.role}.artifact_kind`);
  assertEqual(textValue(reservation, "evidence_series_id"), evidenceSeriesId,
    `${roleSpec.role}.evidence_series_id`);
  const pairs: ReadonlyArray<readonly [string, LiteLearningRuntimeAuthorityTypedRow, string]> = [
    ["task_family", attempt, "task_family"],
    ["candidate_policy_id", revision, "candidate_policy_id"],
    ["candidate_policy_version", revision, "candidate_policy_version"],
    ["candidate_policy_implementation_sha256", revision,
      "candidate_policy_implementation_sha256"],
    ["candidate_policy_config_sha256", revision, "candidate_policy_config_sha256"],
    ["applicable_experiment_id", revision, "experiment_id"],
    ["applicable_experiment_revision", revision, "experiment_revision"],
    ["gate_policy_id", revision, "gate_policy_id"],
    ["gate_policy_version", revision, "gate_policy_version"],
    ["gate_policy_config_sha256", revision, "gate_policy_config_sha256"],
  ];
  for (const [reservationField, authorityRow, authorityField] of pairs) {
    if (!sqliteValueEqual(
      plainSqliteValue(reservation, reservationField),
      plainSqliteValue(authorityRow, authorityField),
    )) {
      return projectorError("reservation_revision_mismatch", `${roleSpec.role}.${reservationField}`);
    }
  }
}

function assertLifecycleChain(args: Readonly<{
  reservation: LiteLearningRuntimeAuthorityTypedRow;
  consumption: LiteLearningRuntimeAuthorityTypedRow;
  hold: LiteLearningRuntimeAuthorityTypedRow | null;
  claim: LiteLearningRuntimeAuthorityTypedRow | null;
  binding: LiteLearningRuntimeAuthorityTypedRow | null;
  termination: LiteLearningRuntimeAuthorityTypedRow | null;
}>): void {
  const reservationId = boundedIdValue(args.reservation, "reservation_id");
  for (const [label, row] of [
    ["consumption", args.consumption],
    ["hold", args.hold],
    ["claim", args.claim],
    ["binding", args.binding],
    ["termination", args.termination],
  ] as const) {
    if (row && textValue(row, "reservation_id") !== reservationId) {
      return projectorError("lifecycle_reservation_mismatch", label);
    }
  }
  const consumptionId = boundedIdValue(args.consumption, "consumption_id");
  if (args.hold
    && textValue(args.hold, "ticket_consumption_id") !== consumptionId) {
    return projectorError("lifecycle_consumption_mismatch", "preclaim_hold");
  }
  if (args.claim
    && textValue(args.claim, "ticket_consumption_id") !== consumptionId) {
    return projectorError("lifecycle_consumption_mismatch", "claim");
  }
  if (args.binding && args.claim) {
    assertEqual(textValue(args.binding, "ticket_consumption_id"), consumptionId,
      "binding.ticket_consumption_id");
    assertEqual(textValue(args.binding, "claim_id"), textValue(args.claim, "claim_id"),
      "binding.claim_id");
  }
  if (args.termination && args.claim) {
    assertEqual(textValue(args.termination, "ticket_consumption_id"), consumptionId,
      "termination.ticket_consumption_id");
    assertEqual(textValue(args.termination, "claim_id"), textValue(args.claim, "claim_id"),
      "termination.claim_id");
    const terminationBindingId = nullableTextValue(args.termination, "supervisor_binding_id");
    assertEqual(
      terminationBindingId,
      args.binding ? textValue(args.binding, "binding_id") : null,
      "termination.supervisor_binding_id",
    );
  }
}

function loadAnchor(args: ProjectLiteLearningExternalIngestionDatabaseDraftV1Args): Readonly<{
  attempt: LiteLearningRuntimeAuthorityTypedRow;
  revision: LiteLearningRuntimeAuthorityTypedRow;
  registeredRevision: z.infer<typeof RegisteredRevisionDigestsV1Schema>;
  registeredEvidenceSeries: z.infer<typeof RegisteredEvidenceSeriesV1Schema>;
}> {
  const { database, tenantId, confirmatoryAttemptId } = args;
  const attempt = exactlyOne(exactRows({
    database,
    table: "lite_learning_confirmatory_attempts",
    bindings: {
      tenant_id: tenantId,
      confirmatory_attempt_id: confirmatoryAttemptId,
    },
  }), "confirmatory_attempt");
  const experimentId = boundedIdValue(attempt, "experiment_id");
  const experimentRevision = integerValue(attempt, "experiment_revision");
  const revision = exactlyOne(exactRows({
    database,
    table: "lite_learning_experiment_revisions",
    bindings: {
      tenant_id: tenantId,
      experiment_id: experimentId,
      experiment_revision: experimentRevision,
    },
  }), "experiment_revision");
  assertAttemptRevisionBindings(attempt, revision);

  const candidatePolicyId = boundedIdValue(revision, "candidate_policy_id");
  const candidatePolicyVersion = textValue(revision, "candidate_policy_version");
  const candidatePolicy = exactlyOne(exactRows({
    database,
    table: "lite_learning_policy_versions",
    bindings: {
      tenant_id: tenantId,
      policy_kind: "candidate",
      policy_id: candidatePolicyId,
      policy_version: candidatePolicyVersion,
    },
  }), "candidate_policy");
  assertEqual(
    digestValue(candidatePolicy, "implementation_contract_sha256"),
    digestValue(revision, "candidate_policy_implementation_sha256"),
    "candidate_policy.implementation_contract_sha256",
  );
  assertEqual(
    digestValue(candidatePolicy, "policy_config_sha256"),
    digestValue(revision, "candidate_policy_config_sha256"),
    "candidate_policy.policy_config_sha256",
  );

  const gatePolicyId = boundedIdValue(revision, "gate_policy_id");
  const gatePolicyVersion = textValue(revision, "gate_policy_version");
  const gatePolicy = exactlyOne(exactRows({
    database,
    table: "lite_learning_policy_versions",
    bindings: {
      tenant_id: tenantId,
      policy_kind: "gate",
      policy_id: gatePolicyId,
      policy_version: gatePolicyVersion,
    },
  }), "gate_policy");
  assertEqual(
    digestValue(gatePolicy, "policy_config_sha256"),
    digestValue(revision, "gate_policy_config_sha256"),
    "gate_policy.policy_config_sha256",
  );
  assertEqual(
    digestValue(gatePolicy, "prospective_calibration_sha256"),
    digestValue(revision, "gate_prospective_calibration_sha256"),
    "gate_policy.prospective_calibration_sha256",
  );

  const requiredSeriesRaw = textValue(revision, "required_evidence_series_json");
  const registeredEvidenceSeries = parseCanonicalJson({
    raw: requiredSeriesRaw,
    schema: RegisteredEvidenceSeriesV1Schema,
    label: "revision.required_evidence_series_json",
    maxBytes: MAX_REQUIRED_SERIES_JSON_BYTES,
  });
  const requiredSeriesSha256 = createHash("sha256")
    .update(requiredSeriesRaw, "utf8")
    .digest("hex");
  assertEqual(
    requiredSeriesSha256,
    digestValue(revision, "required_evidence_series_sha256"),
    "revision.required_evidence_series_sha256",
  );

  const registeredRevision = RegisteredRevisionDigestsV1Schema.parse({
    revision_row_sha256: learningExternalIngestionRevisionRowDigestV1(revision),
    profile_rule_sha256: digestValue(revision, "profile_rule_sha256"),
    experiment_config_sha256: digestValue(revision, "config_sha256"),
    confirmatory_attempt_sha256: digestValue(attempt, "attempt_sha256"),
    candidate_policy_implementation_sha256:
      digestValue(revision, "candidate_policy_implementation_sha256"),
    candidate_policy_config_sha256:
      digestValue(revision, "candidate_policy_config_sha256"),
    collection_source_policy_sha256:
      digestValue(revision, "collection_source_policy_sha256"),
    gate_policy_implementation_sha256:
      digestValue(gatePolicy, "implementation_contract_sha256"),
    gate_policy_config_sha256: digestValue(revision, "gate_policy_config_sha256"),
    gate_prospective_calibration_sha256:
      digestValue(revision, "gate_prospective_calibration_sha256"),
    required_evidence_series_sha256: requiredSeriesSha256,
    required_external_inputs_sha256:
      digestValue(revision, "required_external_inputs_sha256"),
    external_execution_policy_sha256:
      digestValue(revision, "external_execution_policy_sha256"),
  });
  return Object.freeze({
    attempt,
    revision,
    registeredRevision,
    registeredEvidenceSeries,
  });
}

function parseIngestOperation(
  row: LiteLearningRuntimeAuthorityTypedRow,
): ParsedIngestOperation {
  const raw = textValue(row, "receipt_json");
  const receipt = parseCanonicalJson({
    raw,
    schema: LiteLearningExternalEvidenceIngestOperationReceiptV1Schema,
    label: "lite_runtime_write_operations.receipt_json",
    maxBytes: MAX_INGEST_RECEIPT_BYTES,
  });
  assertEqual(textValue(row, "tenant_id"), receipt.tenant_id, "operation.tenant_id");
  assertEqual(textValue(row, "scope"), receipt.scope, "operation.scope");
  assertEqual(textValue(row, "operation_kind"), receipt.operation_kind,
    "operation.operation_kind");
  assertEqual(textValue(row, "operation_id"), receipt.operation_id,
    "operation.operation_id");
  assertEqual(digestValue(row, "request_sha256"), receipt.request_sha256,
    "operation.request_sha256");
  assertEqual(nullableTextValue(row, "commit_id"), receipt.bundle_commit_id,
    "operation.commit_id");
  assertEqual(canonicalTimeValue(row, "created_at"), receipt.recorded_at,
    "operation.created_at");
  return Object.freeze({
    row,
    receipt,
    receiptSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    rowSha256: learningRuntimeAuthorityRowV1({
      table: "lite_runtime_write_operations",
      row,
    }).authority_row_sha256,
  });
}

function scanRelevantIngestOperations(args: Readonly<{
  database: LiteRuntimeDatabase;
  tenantId: string;
  registeredEvidenceSeries: z.infer<typeof RegisteredEvidenceSeriesV1Schema>;
}>): ReadonlyMap<string, readonly ParsedIngestOperation[]> {
  const relevantSeries = new Set([
    args.registeredEvidenceSeries.offline_paired,
    args.registeredEvidenceSeries.production_shadow,
    args.registeredEvidenceSeries.tool_e2e,
  ]);
  const operations = new Map<string, ParsedIngestOperation[]>();
  for (const evidenceSeriesId of relevantSeries) operations.set(evidenceSeriesId, []);
  const rows = readLiteLearningRuntimeExternalIngestionOperationRowsV1({
    database: args.database,
    tenantId: args.tenantId,
    evidenceSeriesIds: [
      args.registeredEvidenceSeries.offline_paired,
      args.registeredEvidenceSeries.production_shadow,
      args.registeredEvidenceSeries.tool_e2e,
    ],
  });
  for (const row of rows) {
    const operation = parseIngestOperation(row);
    const evidenceSeriesId = operation.receipt.request.evidence_series_id;
    if (!relevantSeries.has(evidenceSeriesId)) {
      return projectorError("stream_reader_returned_unregistered_series", evidenceSeriesId);
    }
    const seriesOperations = operations.get(evidenceSeriesId)!;
    seriesOperations.push(operation);
    if (seriesOperations.length > 1) {
      return projectorError(
        "multiple_ingest_operations_for_registered_series",
        evidenceSeriesId,
      );
    }
  }
  return operations;
}

function roleRows(args: Readonly<{
  database: LiteRuntimeDatabase;
  tenantId: string;
  evidenceSeriesId: string;
}>): Readonly<{
  reservations: readonly LiteLearningRuntimeAuthorityTypedRow[];
  artifacts: readonly LiteLearningRuntimeAuthorityTypedRow[];
  heads: readonly LiteLearningRuntimeAuthorityTypedRow[];
}> {
  return Object.freeze({
    reservations: exactRows({
      database: args.database,
      table: "lite_learning_external_run_reservations",
      bindings: {
        tenant_id: args.tenantId,
        evidence_series_id: args.evidenceSeriesId,
      },
    }),
    artifacts: exactRows({
      database: args.database,
      table: "lite_learning_evidence_artifacts",
      bindings: {
        tenant_id: args.tenantId,
        evidence_series_id: args.evidenceSeriesId,
      },
    }),
    heads: exactRows({
      database: args.database,
      table: "lite_learning_evidence_artifacts",
      bindings: {
        tenant_id: args.tenantId,
        evidence_series_id: args.evidenceSeriesId,
        supersedes_artifact_id: null,
      },
    }),
  });
}

function lifecycleRows(args: Readonly<{
  database: LiteRuntimeDatabase;
  tenantId: string;
  reservationId: string;
}>): Readonly<{
  consumptions: readonly LiteLearningRuntimeAuthorityTypedRow[];
  holds: readonly LiteLearningRuntimeAuthorityTypedRow[];
  claims: readonly LiteLearningRuntimeAuthorityTypedRow[];
  bindings: readonly LiteLearningRuntimeAuthorityTypedRow[];
  terminations: readonly LiteLearningRuntimeAuthorityTypedRow[];
}> {
  const bindings = { tenant_id: args.tenantId, reservation_id: args.reservationId };
  return Object.freeze({
    consumptions: exactRows({
      database: args.database,
      table: "lite_learning_external_ticket_consumptions",
      bindings,
    }),
    holds: exactRows({
      database: args.database,
      table: "lite_learning_external_preclaim_holds",
      bindings,
    }),
    claims: exactRows({
      database: args.database,
      table: "lite_learning_external_run_claims",
      bindings,
    }),
    bindings: exactRows({
      database: args.database,
      table: "lite_learning_external_supervisor_bindings",
      bindings,
    }),
    terminations: exactRows({
      database: args.database,
      table: "lite_learning_external_session_terminations",
      bindings,
    }),
  });
}

function plainArtifactWithoutRowId(
  artifact: LiteLearningRuntimeAuthorityTypedRow,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.keys(artifact)
      .filter((column) => column !== "row_id")
      .map((column) => [column, plainSqliteValue(artifact, column)]),
  ));
}

function assertResultReceiptBindings(args: Readonly<{
  database: LiteRuntimeDatabase;
  tenantId: string;
  roleSpec: ExternalRoleSpec;
  evidenceSeriesId: string;
  attempt: LiteLearningRuntimeAuthorityTypedRow;
  revision: LiteLearningRuntimeAuthorityTypedRow;
  reservation: LiteLearningRuntimeAuthorityTypedRow;
  consumption: LiteLearningRuntimeAuthorityTypedRow;
  claim: LiteLearningRuntimeAuthorityTypedRow;
  binding: LiteLearningRuntimeAuthorityTypedRow;
  termination: LiteLearningRuntimeAuthorityTypedRow;
  artifact: LiteLearningRuntimeAuthorityTypedRow;
  head: LiteLearningRuntimeAuthorityTypedRow;
  operation: ParsedIngestOperation;
}>): ResultTupleV1 {
  const { receipt } = args.operation;
  const request = receipt.request;
  const projection = receipt.post_transaction_projection;
  const reservationId = boundedIdValue(args.reservation, "reservation_id");
  const consumptionId = boundedIdValue(args.consumption, "consumption_id");
  const claimId = boundedIdValue(args.claim, "claim_id");
  const bindingId = boundedIdValue(args.binding, "binding_id");
  const terminationId = boundedIdValue(args.termination, "termination_id");
  const artifactId = boundedIdValue(args.artifact, "artifact_id");
  const artifactRowId = PositiveSafeIntegerSchema.parse(integerValue(args.artifact, "row_id"));
  const artifactStatus = textValue(args.artifact, "artifact_status");
  const reportSha256 = digestValue(args.artifact, "report_sha256");

  const directBindings: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [receipt.tenant_id, args.tenantId, "receipt.tenant_id"],
    [request.artifact_kind, args.roleSpec.artifact_kind, "request.artifact_kind"],
    [request.evidence_series_id, args.evidenceSeriesId, "request.evidence_series_id"],
    [request.task_family, textValue(args.attempt, "task_family"), "request.task_family"],
    [request.applicable_experiment_id, textValue(args.revision, "experiment_id"),
      "request.applicable_experiment_id"],
    [request.applicable_experiment_revision, integerValue(args.revision, "experiment_revision"),
      "request.applicable_experiment_revision"],
    [projection.artifact_id, artifactId, "projection.artifact_id"],
    [projection.artifact_row_id, artifactRowId, "projection.artifact_row_id"],
    [projection.evidence_series_id, args.evidenceSeriesId,
      "projection.evidence_series_id"],
    [projection.series_head_artifact_id, artifactId,
      "projection.series_head_artifact_id"],
    [projection.series_head_row_id, artifactRowId, "projection.series_head_row_id"],
    [projection.artifact_status, artifactStatus, "projection.artifact_status"],
    [projection.reservation_id, reservationId, "projection.reservation_id"],
    [projection.ticket_consumption_id, consumptionId,
      "projection.ticket_consumption_id"],
    [projection.claim_id, claimId, "projection.claim_id"],
    [projection.supervisor_binding_id, bindingId, "projection.supervisor_binding_id"],
    [projection.session_termination_id, terminationId,
      "projection.session_termination_id"],
    [receipt.artifact_id, artifactId, "receipt.artifact_id"],
    [receipt.artifact_status, artifactStatus, "receipt.artifact_status"],
    [textValue(args.artifact, "artifact_kind"), args.roleSpec.artifact_kind,
      "artifact.artifact_kind"],
    [textValue(args.artifact, "evidence_series_id"), args.evidenceSeriesId,
      "artifact.evidence_series_id"],
    [textValue(args.artifact, "external_run_reservation_id"), reservationId,
      "artifact.external_run_reservation_id"],
    [textValue(args.artifact, "external_ticket_consumption_id"), consumptionId,
      "artifact.external_ticket_consumption_id"],
    [textValue(args.artifact, "external_run_claim_id"), claimId,
      "artifact.external_run_claim_id"],
    [textValue(args.artifact, "external_supervisor_binding_id"), bindingId,
      "artifact.external_supervisor_binding_id"],
    [textValue(args.artifact, "external_session_termination_id"), terminationId,
      "artifact.external_session_termination_id"],
    [nullableTextValue(args.artifact, "supersedes_artifact_id"), null,
      "artifact.supersedes_artifact_id"],
    [textValue(args.artifact, "task_family"), textValue(args.attempt, "task_family"),
      "artifact.task_family"],
    [textValue(args.artifact, "applicable_experiment_id"),
      textValue(args.revision, "experiment_id"), "artifact.applicable_experiment_id"],
    [integerValue(args.artifact, "applicable_experiment_revision"),
      integerValue(args.revision, "experiment_revision"),
      "artifact.applicable_experiment_revision"],
    [textValue(args.termination, "termination_reason"), artifactStatus,
      "termination.termination_reason"],
    [integerValue(args.head, "row_id"), artifactRowId, "head.row_id"],
    [textValue(args.head, "artifact_id"), artifactId, "head.artifact_id"],
  ];
  for (const [actual, expected, label] of directBindings) {
    assertEqual(actual, expected, label);
  }

  const genericArtifactSha256 = sha256Canonical(plainArtifactWithoutRowId(args.artifact));
  assertEqual(genericArtifactSha256, receipt.artifact_row_sha256,
    "receipt.artifact_row_sha256");
  assertEqual(genericArtifactSha256, projection.artifact_row_sha256,
    "projection.artifact_row_sha256");

  const lifecycle = resolveLiteLearningExternalNormalLifecycleSnapshot(args.database.db, {
    tenantId: args.tenantId,
    reservationId,
    evidenceBindingSha256: receipt.public_run_authority.payload.evidence_binding_sha256,
  });
  assertEqual(lifecycle.roleName, args.roleSpec.role, "normal_lifecycle.role_name");
  assertTypedRowMatchesRaw(args.reservation, lifecycle.reservation, "reservation");
  assertTypedRowMatchesRaw(args.consumption, lifecycle.consumption, "consumption");
  assertTypedRowMatchesRaw(args.claim, lifecycle.claim, "claim");
  assertTypedRowMatchesRaw(args.binding, lifecycle.binding, "binding");
  assertTypedRowMatchesRaw(args.termination, lifecycle.termination, "termination");

  return ResultTupleV1Schema.parse({
    role: args.roleSpec.role,
    artifact_kind: args.roleSpec.artifact_kind,
    evidence_series_id: args.evidenceSeriesId,
    artifact_status: artifactStatus,
    reservation_id: reservationId,
    ticket_consumption_id: consumptionId,
    claim_id: claimId,
    supervisor_binding_id: bindingId,
    session_termination_id: terminationId,
    session_termination_sha256: digestValue(args.termination, "termination_sha256"),
    report_sha256: reportSha256,
    public_run_authority_sha256: receipt.public_run_authority_sha256,
    run_bundle_manifest_sha256: receipt.run_bundle_manifest_sha256,
    run_bundle_archive_sha256: receipt.run_bundle_archive_sha256,
    bundle_commit_id: receipt.bundle_commit_id,
    ingest_operation_scope: receipt.scope,
    ingest_operation_kind: receipt.operation_kind,
    ingest_operation_id: receipt.operation_id,
    ingest_operation_request_sha256: receipt.request_sha256,
    ingest_operation_receipt_sha256: args.operation.receiptSha256,
    ingest_operation_commit_id: receipt.bundle_commit_id,
    ingest_operation_created_at: canonicalTimeValue(args.operation.row, "created_at"),
    ingest_operation_row_sha256: args.operation.rowSha256,
    post_transaction_projection_sha256: receipt.post_transaction_projection_sha256,
    artifact_id: artifactId,
    artifact_row_id: artifactRowId,
    artifact_row_sha256: genericArtifactSha256,
    artifact_authority_row_sha256: learningRuntimeAuthorityRowV1({
      table: "lite_learning_evidence_artifacts",
      row: args.artifact,
    }).authority_row_sha256,
    series_head_artifact_id: artifactId,
    series_head_row_id: artifactRowId,
    series_head_artifact_row_sha256: genericArtifactSha256,
    series_head_row_sha256: learningRuntimeAuthorityRowV1({
      table: "lite_learning_evidence_artifacts",
      row: args.head,
    }).authority_row_sha256,
  });
}

const NORMAL_TERMINATION_REASONS = new Set(["passed", "failed", "inconclusive"]);
const ABNORMAL_TERMINATION_REASONS = new Set([
  "launch_failure",
  "binding_integrity_failure",
  "runner_crash",
  "lease_expired",
  "operator_revoke",
  "post_quiesce_revoke",
  "finalize_timeout",
]);

function classifyRole(args: Readonly<{
  database: LiteRuntimeDatabase;
  tenantId: string;
  roleSpec: ExternalRoleSpec;
  evidenceSeriesId: string;
  attempt: LiteLearningRuntimeAuthorityTypedRow;
  revision: LiteLearningRuntimeAuthorityTypedRow;
  operations: readonly ParsedIngestOperation[];
}>): Readonly<{
  status: RequiredSeriesStatusV1["series"][number];
  branch: TerminalCoverageDatabaseDraftV1["branches"][number];
  resultTuple: ResultTupleV1 | null;
  terminalFact: TerminalFactTimeV1 | null;
}> {
  const roleAuthority = roleRows(args);
  if (roleAuthority.reservations.length > 1) {
    return projectorError(
      "multiple_reservations_for_registered_series",
      args.evidenceSeriesId,
    );
  }
  const reservation = roleAuthority.reservations[0] ?? null;
  if (!reservation) {
    const vector = [
      roleAuthority.reservations.length,
      0,
      0,
      0,
      0,
      0,
      roleAuthority.artifacts.length,
      args.operations.length,
      roleAuthority.heads.length,
    ];
    if (vector.some((count) => count !== 0)) {
      return projectorError(
        "invalid_terminal_branch_vector",
        `${args.roleSpec.role}:${vector.join("")}`,
      );
    }
    return Object.freeze({
      status: {
        role: args.roleSpec.role,
        artifact_kind: args.roleSpec.artifact_kind,
        evidence_series_id: args.evidenceSeriesId,
        branch_kind: "unstarted",
      },
      branch: {
        role: args.roleSpec.role,
        artifact_kind: args.roleSpec.artifact_kind,
        evidence_series_id: args.evidenceSeriesId,
        branch_kind: "unstarted",
        reservation_count: 0,
        ticket_consumption_count: 0,
        preclaim_hold_count: 0,
        claim_count: 0,
        supervisor_binding_count: 0,
        session_termination_count: 0,
        artifact_count: 0,
        ingest_operation_count: 0,
        current_series_head_count: 0,
      },
      resultTuple: null,
      terminalFact: null,
    });
  }

  assertReservationBindings({
    reservation,
    roleSpec: args.roleSpec,
    evidenceSeriesId: args.evidenceSeriesId,
    attempt: args.attempt,
    revision: args.revision,
  });
  const reservationId = boundedIdValue(reservation, "reservation_id");
  const lifecycle = lifecycleRows({
    database: args.database,
    tenantId: args.tenantId,
    reservationId,
  });
  const counts = Object.freeze({
    reservation: 1,
    consumption: lifecycle.consumptions.length,
    hold: lifecycle.holds.length,
    claim: lifecycle.claims.length,
    binding: lifecycle.bindings.length,
    termination: lifecycle.terminations.length,
    artifact: roleAuthority.artifacts.length,
    operation: args.operations.length,
    head: roleAuthority.heads.length,
  });
  const vector = [
    counts.reservation,
    counts.consumption,
    counts.hold,
    counts.claim,
    counts.binding,
    counts.termination,
    counts.artifact,
    counts.operation,
    counts.head,
  ].join("");

  if (vector === "111000000") {
    const consumption = lifecycle.consumptions[0]!;
    const hold = lifecycle.holds[0]!;
    assertLifecycleChain({
      reservation,
      consumption,
      hold,
      claim: null,
      binding: null,
      termination: null,
    });
    const reason = textValue(hold, "hold_reason");
    const branch = TerminalCoveragePreclaimHoldDatabaseBranchV1Schema.parse({
      role: args.roleSpec.role,
      artifact_kind: args.roleSpec.artifact_kind,
      evidence_series_id: args.evidenceSeriesId,
      branch_kind: "preclaim_hold",
      reservation_id: reservationId,
      ticket_consumption_id: boundedIdValue(consumption, "consumption_id"),
      preclaim_hold_id: boundedIdValue(hold, "hold_id"),
      preclaim_hold_sha256: digestValue(hold, "hold_sha256"),
      zero_effects_proof_sha256: digestValue(hold, "zero_effects_proof_sha256"),
      preclaim_hold_reason: reason,
      claim_count: 0,
      supervisor_binding_count: 0,
      session_termination_count: 0,
      artifact_count: 0,
      ingest_operation_count: 0,
      current_series_head_count: 0,
    });
    const status = LearningExternalRequiredSeriesStatusEntryV1Schema.parse({
      role: args.roleSpec.role,
      artifact_kind: args.roleSpec.artifact_kind,
      evidence_series_id: args.evidenceSeriesId,
      branch_kind: "preclaim_hold",
      preclaim_hold_reason: reason,
    });
    return Object.freeze({
      status,
      branch,
      resultTuple: null,
      terminalFact: {
        role: args.roleSpec.role,
        branch_kind: "preclaim_hold",
        held_at: canonicalTimeValue(hold, "held_at"),
      },
    });
  }

  const termination = atMostOne(lifecycle.terminations, `${args.roleSpec.role}.termination`);
  const terminationReason = termination ? textValue(termination, "termination_reason") : null;
  const terminationBindingId = termination
    ? nullableTextValue(termination, "supervisor_binding_id")
    : null;
  const terminationVector = terminationBindingId === null ? "110101000" : "110111000";
  if (vector === terminationVector && termination && terminationReason
    && ABNORMAL_TERMINATION_REASONS.has(terminationReason)) {
    const consumption = lifecycle.consumptions[0]!;
    const claim = lifecycle.claims[0]!;
    const binding = lifecycle.bindings[0] ?? null;
    assertLifecycleChain({
      reservation,
      consumption,
      hold: null,
      claim,
      binding,
      termination,
    });
    const branch = TerminalCoverageTerminationHoldDatabaseBranchV1Schema.parse({
      role: args.roleSpec.role,
      artifact_kind: args.roleSpec.artifact_kind,
      evidence_series_id: args.evidenceSeriesId,
      branch_kind: "termination_hold",
      reservation_id: reservationId,
      ticket_consumption_id: boundedIdValue(consumption, "consumption_id"),
      claim_id: boundedIdValue(claim, "claim_id"),
      supervisor_binding_id: terminationBindingId,
      session_termination_id: boundedIdValue(termination, "termination_id"),
      session_termination_sha256: digestValue(termination, "termination_sha256"),
      termination_reason: terminationReason,
      artifact_count: 0,
      ingest_operation_count: 0,
      current_series_head_count: 0,
    });
    const status = LearningExternalRequiredSeriesStatusEntryV1Schema.parse({
      role: args.roleSpec.role,
      artifact_kind: args.roleSpec.artifact_kind,
      evidence_series_id: args.evidenceSeriesId,
      branch_kind: "termination_hold",
      termination_reason: terminationReason,
    });
    return Object.freeze({
      status,
      branch,
      resultTuple: null,
      terminalFact: {
        role: args.roleSpec.role,
        branch_kind: "termination_hold",
        terminated_at: canonicalTimeValue(termination, "terminated_at"),
      },
    });
  }

  if (vector === "110111111" && termination && terminationReason
    && NORMAL_TERMINATION_REASONS.has(terminationReason)) {
    const consumption = lifecycle.consumptions[0]!;
    const claim = lifecycle.claims[0]!;
    const binding = lifecycle.bindings[0]!;
    const artifact = roleAuthority.artifacts[0]!;
    const head = roleAuthority.heads[0]!;
    const operation = args.operations[0]!;
    assertLifecycleChain({
      reservation,
      consumption,
      hold: null,
      claim,
      binding,
      termination,
    });
    const tuple = assertResultReceiptBindings({
      database: args.database,
      tenantId: args.tenantId,
      roleSpec: args.roleSpec,
      evidenceSeriesId: args.evidenceSeriesId,
      attempt: args.attempt,
      revision: args.revision,
      reservation,
      consumption,
      claim,
      binding,
      termination,
      artifact,
      head,
      operation,
    });
    const branch = TerminalCoverageResultBranchV1Schema.parse({
      role: tuple.role,
      artifact_kind: tuple.artifact_kind,
      evidence_series_id: tuple.evidence_series_id,
      branch_kind: "result",
      artifact_status: tuple.artifact_status,
      reservation_id: tuple.reservation_id,
      ticket_consumption_id: tuple.ticket_consumption_id,
      claim_id: tuple.claim_id,
      supervisor_binding_id: tuple.supervisor_binding_id,
      session_termination_id: tuple.session_termination_id,
      session_termination_sha256: tuple.session_termination_sha256,
      report_sha256: tuple.report_sha256,
      public_run_authority_sha256: tuple.public_run_authority_sha256,
      run_bundle_manifest_sha256: tuple.run_bundle_manifest_sha256,
      run_bundle_archive_sha256: tuple.run_bundle_archive_sha256,
      bundle_commit_id: tuple.bundle_commit_id,
      artifact_count: 1,
      ingest_operation_count: 1,
      current_series_head_count: 1,
    });
    const status = LearningExternalRequiredSeriesStatusEntryV1Schema.parse({
      role: args.roleSpec.role,
      artifact_kind: args.roleSpec.artifact_kind,
      evidence_series_id: args.evidenceSeriesId,
      branch_kind: "result",
      artifact_status: tuple.artifact_status,
    });
    return Object.freeze({
      status,
      branch,
      resultTuple: tuple,
      terminalFact: {
        role: args.roleSpec.role,
        branch_kind: "result",
        ingest_operation_created_at: tuple.ingest_operation_created_at,
      },
    });
  }

  return projectorError(
    "invalid_terminal_branch_vector",
    `${args.roleSpec.role}:${vector}:${terminationReason ?? "none"}`,
  );
}

/**
 * Reconstructs the complete D2 factual projection from one live Runtime v5
 * transaction. The result is deliberately unsigned and cannot be promoted to
 * the final D1 projection without the D3 launcher capabilities named inside it.
 */
export function projectLiteLearningExternalIngestionDatabaseDraftV1(
  args: ProjectLiteLearningExternalIngestionDatabaseDraftV1Args,
): LiteLearningExternalIngestionDatabaseProjectionDraftV1 {
  const tenantId = BoundedIdSchema.parse(args.tenantId);
  const confirmatoryAttemptId = BoundedIdSchema.parse(args.confirmatoryAttemptId);
  const transactionIdentity = assertActiveTransaction(args.database);
  assertCurrentV5Schema(args.database);
  assertSqliteHealth(args.database);

  const anchor = loadAnchor({
    database: args.database,
    tenantId,
    confirmatoryAttemptId,
    authorityReceiptKeyring: args.authorityReceiptKeyring,
  });
  const operations = scanRelevantIngestOperations({
    database: args.database,
    tenantId,
    registeredEvidenceSeries: anchor.registeredEvidenceSeries,
  });
  const roleProjections = LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS.map((roleSpec) => {
    const evidenceSeriesId = anchor.registeredEvidenceSeries[roleSpec.role];
    return classifyRole({
      database: args.database,
      tenantId,
      roleSpec,
      evidenceSeriesId,
      attempt: anchor.attempt,
      revision: anchor.revision,
      operations: operations.get(evidenceSeriesId) ?? [],
    });
  });

  const taskFamily = boundedIdValue(anchor.attempt, "task_family");
  const experimentId = boundedIdValue(anchor.revision, "experiment_id");
  const experimentRevision = PositiveSafeIntegerSchema.parse(
    integerValue(anchor.revision, "experiment_revision"),
  );
  const requiredEvidenceSeriesSha256 = anchor.registeredRevision
    .required_evidence_series_sha256;
  const requiredSeriesStatus = LearningExternalRequiredSeriesStatusV1Schema.parse({
    contract_version: "aionis_learning_external_required_series_status_v1",
    tenant_id: tenantId,
    task_family: taskFamily,
    experiment_id: experimentId,
    experiment_revision: experimentRevision,
    required_evidence_series_sha256: requiredEvidenceSeriesSha256,
    series: roleProjections.map(({ status }) => status),
  });
  const terminalFacts = roleProjections.flatMap(({ terminalFact }) =>
    terminalFact ? [terminalFact] : []);
  const finalizedAt = learningExternalTerminalCoverageFinalizedAtFromDatabaseFacts({
    revision_created_at: canonicalTimeValue(anchor.revision, "created_at"),
    confirmatory_attempt_created_at: canonicalTimeValue(anchor.attempt, "created_at"),
    terminal_facts: terminalFacts,
  });
  const terminalCoverageDatabaseDraft =
    LiteLearningExternalTerminalCoverageDatabaseDraftV1Schema.parse({
      contract_version:
        "aionis_learning_external_terminal_coverage_database_draft_v1",
      tenant_id: tenantId,
      task_family: taskFamily,
      experiment_id: experimentId,
      experiment_revision: experimentRevision,
      required_evidence_series_sha256: requiredEvidenceSeriesSha256,
      branches: roleProjections.map(({ branch }) => branch),
      finalized_at: finalizedAt,
      coverage_finality: "d3_launcher_write_fence_capability_required",
    });
  const resultTuples = roleProjections.flatMap(({ resultTuple }) =>
    resultTuple ? [resultTuple] : []);

  const replay = assertLiteLearningEpisodeLedgerIntegrity(
    args.database.db,
    finalizedAt,
    { authorityReceiptKeyring: args.authorityReceiptKeyring },
  );
  const databaseInstanceId = assertLiteRuntimeAuthorityIdentity(args.database.db);
  const ledgerVerification = LearningExternalIngestionLedgerVerificationV1Schema.parse({
    contract_version: "aionis_learning_external_ingestion_ledger_verification_v1",
    schema_component: "write_projection",
    schema_version: LITE_RUNTIME_WRITE_SCHEMA_VERSION,
    database_instance_id: databaseInstanceId,
    checked_at: finalizedAt,
    ledger_verifier_id: "aionis_lite_learning_ledger_replay",
    ledger_verifier_version: 1,
    replay,
  });

  const holdRequirements: Array<z.infer<typeof HoldCapabilityRequirementV1Schema>> = [];
  for (const branch of terminalCoverageDatabaseDraft.branches) {
    if (branch.branch_kind === "termination_hold") {
      holdRequirements.push({
        role: branch.role,
        evidence_series_id: branch.evidence_series_id,
        branch_kind: "termination_hold",
        terminal_fact_sha256: branch.session_termination_sha256,
        capability:
          "d3_verified_tracked_termination_hold_bundle_capability_required",
      });
      continue;
    }
    if (branch.branch_kind === "preclaim_hold") {
      holdRequirements.push({
        role: branch.role,
        evidence_series_id: branch.evidence_series_id,
        branch_kind: "preclaim_hold",
        terminal_fact_sha256: branch.preclaim_hold_sha256,
        capability:
          "d3_verified_tracked_preclaim_hold_bundle_capability_required",
      });
    }
  }
  const unstartedRoles = terminalCoverageDatabaseDraft.branches.flatMap((branch) =>
    branch.branch_kind === "unstarted" ? [branch.role] : []);

  const draft = LiteLearningExternalIngestionDatabaseProjectionDraftV1Schema.parse({
    contract_version: "unsigned_d2_database_projection_draft_v1",
    signing_eligible: false,
    schema_component: "write_projection",
    schema_version: LITE_RUNTIME_WRITE_SCHEMA_VERSION,
    database_instance_id: databaseInstanceId,
    ledger_verifier_id: "aionis_lite_learning_ledger_replay",
    ledger_verifier_version: 1,
    ledger_verification: ledgerVerification,
    ledger_verification_sha256:
      learningExternalIngestionLedgerVerificationDigest(ledgerVerification),
    tenant_id: tenantId,
    task_family: taskFamily,
    confirmatory_attempt_id: confirmatoryAttemptId,
    experiment_id: experimentId,
    experiment_revision: experimentRevision,
    registered_revision: anchor.registeredRevision,
    registered_evidence_series: anchor.registeredEvidenceSeries,
    required_series_status: requiredSeriesStatus,
    required_series_status_sha256:
      learningExternalRequiredSeriesStatusDigest(requiredSeriesStatus),
    terminal_coverage_database_draft: terminalCoverageDatabaseDraft,
    terminal_coverage_database_draft_sha256:
      sha256Canonical(terminalCoverageDatabaseDraft),
    result_tuples: resultTuples,
    result_tuples_sha256: sha256Canonical(resultTuples),
    d3_capability_requirements: {
      coverage_final_write_fence: "required_before_final_projection",
      unstarted_roles: unstartedRoles,
      physical_database_lineage:
        "d3_launcher_database_binding_capability_required",
      database_binding_receipt:
        "d3_launcher_database_binding_capability_required",
      authority_head: "d3_same_transaction_authority_head_required",
      hold_bundles: holdRequirements,
    },
  });
  assertSameTransaction(args.database, transactionIdentity);
  return draft;
}
