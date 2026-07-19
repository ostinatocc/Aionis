import { createHash } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";
import {
  appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction,
} from "../../../../src/store/lite-runtime-applied-authority.js";
import { z } from "zod";

import { LearningExternalCanonicalUtcMillisSchema } from
  "../../../../src/memory/learning-external-authority.js";
import {
  readLearningExternalEvidenceArchiveProofV1,
} from "../memory/learning-external-evidence-archive.js";
import {
  LearningExternalEvidenceIngestRequestV1Schema,
  LearningExternalEvidenceRunBundleV1Schema,
  learningExternalEvidenceArtifactId,
  learningExternalEvidenceIngestRequestDigest,
  learningExternalEvidenceReportJson,
  learningExternalEvidenceRunBundleDigest,
  validateLearningExternalEvidenceContractSetV1,
  type LearningExternalEvidenceIngestRequestV1,
  type LearningExternalEvidenceRunBundleV1,
} from "../memory/learning-external-evidence.js";
import {
  LearningExternalPublicRunAuthorityV1Schema,
  learningExternalPublicRunAuthorityDigest,
  validateLearningExternalPublicRunAuthorityV1,
  type LearningExternalPublicRunAuthorityV1,
} from "../memory/learning-external-public-authority.js";
import type { LiteLearningAuthorityRow } from
  "../../../../src/store/lite-learning-confirmatory-authority.js";
import {
  assertPreparedLiteLearningExternalEvidenceArchivePinned,
  inspectPreparedLiteLearningExternalEvidenceArchive,
  type PreparedLiteLearningExternalEvidenceArchive,
} from "./lite-learning-external-evidence-archive-reader.js";
import {
  resolveLiteLearningExternalNormalLifecycleSnapshot,
  type LiteLearningExternalNormalLifecycleSnapshot,
} from "./lite-learning-external-lifecycle-reader.js";
import type { LiteRuntimeDatabase } from "../../../../src/store/lite-runtime-database.js";
import {
  assertLiteRuntimeProtectedAuthorityTransactionCapability,
  type LiteRuntimeProtectedAuthorityTransactionCapability,
} from "./lite-runtime-protected-authority-database.js";
import type { SqliteDatabase } from "../../../../src/store/sqlite.js";
import type { SqliteTransactionRunner } from
  "../../../../src/store/sqlite-transaction-runner.js";

const EXTERNAL_AUTHORITY_SCOPE = "learning_external_authority_v1" as const;
const EXTERNAL_EVIDENCE_INGEST_OPERATION_KIND = "learning_evidence_ingest_v1" as const;
const MAX_INGEST_OPERATION_RECEIPT_BYTES = 40 * 1024 * 1024;

const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const BoundedIdSchema = z.string().superRefine((value, context) => {
  if (value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > 256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected an exact identifier bounded to 256 UTF-8 bytes",
    });
  }
});

const EVIDENCE_ARTIFACT_COLUMNS = [
  "tenant_id", "artifact_id", "artifact_kind", "evidence_series_id",
  "external_run_reservation_id", "external_ticket_consumption_id",
  "external_run_claim_id", "external_supervisor_binding_id",
  "external_session_termination_id", "supersedes_artifact_id", "artifact_status",
  "task_family", "candidate_policy_id", "candidate_policy_version",
  "candidate_policy_implementation_sha256", "candidate_policy_config_sha256",
  "applicable_experiment_id", "applicable_experiment_revision",
  "source_experiment_id", "source_experiment_revision", "source_serving_phase",
  "look_index", "look_proposal_sha256", "gate_policy_id", "gate_policy_version",
  "gate_policy_config_sha256", "evidence_scope_set_sha256", "source_bundle_sha256",
  "harness_bundle_sha256", "report_sha256", "report_json", "source_ref",
  "source_commit_id", "collected_at", "ingested_at", "created_by",
] as const;

const ExternalEvidencePostTransactionProjectionV1Schema = z.object({
  contract_version: z.literal(
    "aionis_learning_external_evidence_post_transaction_projection_v1",
  ),
  tenant_id: BoundedIdSchema,
  database_instance_id: DigestSha256Schema,
  scope: z.literal(EXTERNAL_AUTHORITY_SCOPE),
  operation_kind: z.literal(EXTERNAL_EVIDENCE_INGEST_OPERATION_KIND),
  operation_id: BoundedIdSchema,
  request_sha256: DigestSha256Schema,
  artifact_id: BoundedIdSchema,
  artifact_row_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifact_row_sha256: DigestSha256Schema,
  evidence_series_id: BoundedIdSchema,
  series_head_artifact_id: BoundedIdSchema,
  series_head_row_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifact_status: z.enum(["passed", "failed", "inconclusive"]),
  reservation_id: BoundedIdSchema,
  ticket_consumption_id: BoundedIdSchema,
  claim_id: BoundedIdSchema,
  supervisor_binding_id: BoundedIdSchema,
  session_termination_id: BoundedIdSchema,
  public_run_authority_sha256: DigestSha256Schema,
  run_bundle_manifest_sha256: DigestSha256Schema,
  run_bundle_archive_sha256: DigestSha256Schema,
  bundle_commit_id: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
}).strict();

export const LiteLearningExternalEvidencePostTransactionProjectionV1Schema =
  ExternalEvidencePostTransactionProjectionV1Schema;

export type LiteLearningExternalEvidencePostTransactionProjectionV1 = z.infer<
  typeof ExternalEvidencePostTransactionProjectionV1Schema
>;

const ExternalEvidenceIngestOperationReceiptV1Schema = z.object({
  contract_version: z.literal(
    "aionis_learning_external_evidence_ingest_operation_receipt_v1",
  ),
  tenant_id: BoundedIdSchema,
  scope: z.literal(EXTERNAL_AUTHORITY_SCOPE),
  operation_kind: z.literal(EXTERNAL_EVIDENCE_INGEST_OPERATION_KIND),
  operation_id: BoundedIdSchema,
  actor_id: BoundedIdSchema,
  request: LearningExternalEvidenceIngestRequestV1Schema,
  request_sha256: DigestSha256Schema,
  artifact_id: BoundedIdSchema,
  artifact_row_sha256: DigestSha256Schema,
  artifact_status: z.enum(["passed", "failed", "inconclusive"]),
  public_run_authority_sha256: DigestSha256Schema,
  run_bundle_manifest_sha256: DigestSha256Schema,
  run_bundle_archive_sha256: DigestSha256Schema,
  bundle_commit_id: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  public_run_authority: LearningExternalPublicRunAuthorityV1Schema,
  run_bundle: LearningExternalEvidenceRunBundleV1Schema,
  post_transaction_projection: ExternalEvidencePostTransactionProjectionV1Schema,
  post_transaction_projection_sha256: DigestSha256Schema,
  recorded_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((receipt, context) => {
  const expectedRequestSha256 = learningExternalEvidenceIngestRequestDigest(receipt.request);
  const expectedPublicAuthoritySha256 = learningExternalPublicRunAuthorityDigest(
    receipt.public_run_authority,
  );
  const expectedRunBundleSha256 = learningExternalEvidenceRunBundleDigest(receipt.run_bundle);
  const expectedProjectionSha256 = sha256Canonical(receipt.post_transaction_projection);
  const bindings: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [receipt.tenant_id, receipt.request.tenant_id, "tenant_id"],
    [receipt.operation_id, receipt.request.operation_id, "operation_id"],
    [receipt.actor_id, receipt.request.actor_id, "actor_id"],
    [receipt.request_sha256, expectedRequestSha256, "request_sha256"],
    [receipt.public_run_authority_sha256,
      expectedPublicAuthoritySha256, "public_run_authority_sha256"],
    [receipt.public_run_authority_sha256,
      receipt.request.public_run_authority_sha256, "request.public_run_authority_sha256"],
    [receipt.run_bundle_manifest_sha256,
      expectedRunBundleSha256, "run_bundle_manifest_sha256"],
    [receipt.run_bundle_manifest_sha256,
      receipt.request.run_bundle_manifest_sha256, "request.run_bundle_manifest_sha256"],
    [receipt.run_bundle_archive_sha256,
      receipt.request.run_bundle_archive_sha256, "run_bundle_archive_sha256"],
    [receipt.bundle_commit_id, receipt.request.bundle_commit_id, "bundle_commit_id"],
    [receipt.post_transaction_projection_sha256,
      expectedProjectionSha256, "post_transaction_projection_sha256"],
    [receipt.artifact_id,
      receipt.post_transaction_projection.artifact_id, "artifact_id"],
    [receipt.artifact_row_sha256,
      receipt.post_transaction_projection.artifact_row_sha256, "artifact_row_sha256"],
    [receipt.artifact_status,
      receipt.post_transaction_projection.artifact_status, "artifact_status"],
    [receipt.tenant_id,
      receipt.post_transaction_projection.tenant_id, "projection.tenant_id"],
    [receipt.public_run_authority.payload.database_instance_id,
      receipt.post_transaction_projection.database_instance_id,
      "projection.database_instance_id"],
    [receipt.request_sha256,
      receipt.post_transaction_projection.request_sha256, "projection.request_sha256"],
    [receipt.operation_id,
      receipt.post_transaction_projection.operation_id, "projection.operation_id"],
    [receipt.request.evidence_series_id,
      receipt.post_transaction_projection.evidence_series_id,
      "projection.evidence_series_id"],
    [receipt.artifact_id,
      receipt.post_transaction_projection.series_head_artifact_id,
      "projection.series_head_artifact_id"],
    [receipt.run_bundle.reservation_id,
      receipt.post_transaction_projection.reservation_id, "projection.reservation_id"],
    [receipt.run_bundle.ticket_consumption_id,
      receipt.post_transaction_projection.ticket_consumption_id,
      "projection.ticket_consumption_id"],
    [receipt.run_bundle.claim_id,
      receipt.post_transaction_projection.claim_id, "projection.claim_id"],
    [receipt.run_bundle.supervisor_binding_id,
      receipt.post_transaction_projection.supervisor_binding_id,
      "projection.supervisor_binding_id"],
    [receipt.run_bundle.session_termination_id,
      receipt.post_transaction_projection.session_termination_id,
      "projection.session_termination_id"],
    [receipt.public_run_authority_sha256,
      receipt.post_transaction_projection.public_run_authority_sha256,
      "projection.public_run_authority_sha256"],
    [receipt.run_bundle_manifest_sha256,
      receipt.post_transaction_projection.run_bundle_manifest_sha256,
      "projection.run_bundle_manifest_sha256"],
    [receipt.run_bundle_archive_sha256,
      receipt.post_transaction_projection.run_bundle_archive_sha256,
      "projection.run_bundle_archive_sha256"],
    [receipt.bundle_commit_id,
      receipt.post_transaction_projection.bundle_commit_id,
      "projection.bundle_commit_id"],
  ];
  for (const [actual, expected, field] of bindings) {
    if (actual !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} does not bind the canonical ingestion material`,
      });
    }
  }
  if (Buffer.byteLength(stableStringify(receipt), "utf8")
    > MAX_INGEST_OPERATION_RECEIPT_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `External evidence ingest receipt exceeds ${MAX_INGEST_OPERATION_RECEIPT_BYTES} bytes`,
    });
  }
});

export const LiteLearningExternalEvidenceIngestOperationReceiptV1Schema =
  ExternalEvidenceIngestOperationReceiptV1Schema;

export type LiteLearningExternalEvidenceIngestOperationReceiptV1 = z.infer<
  typeof ExternalEvidenceIngestOperationReceiptV1Schema
>;

type LiteRuntimeWriteOperationRow = Readonly<{
  tenant_id: string;
  scope: string;
  operation_kind: string;
  operation_id: string;
  request_sha256: string;
  receipt_json: string;
  commit_id: string | null;
  created_at: string;
}>;

export type LiteLearningExternalEvidenceIngestInput = Readonly<{
  request: LearningExternalEvidenceIngestRequestV1;
  preparedArchive: PreparedLiteLearningExternalEvidenceArchive;
  protectedTransactionCapability:
    LiteRuntimeProtectedAuthorityTransactionCapability;
  recordedAt: string;
}>;

type LiteLearningExternalEvidenceCanonicalInput = Readonly<{
  request: LearningExternalEvidenceIngestRequestV1;
  publicRunAuthority: LearningExternalPublicRunAuthorityV1;
  runBundle: LearningExternalEvidenceRunBundleV1;
  recordedAt: string;
}>;

export type LiteLearningExternalEvidenceIngestionValidation = Readonly<{
  request: LearningExternalEvidenceIngestRequestV1;
  publicRunAuthority: LearningExternalPublicRunAuthorityV1;
  runBundle: LearningExternalEvidenceRunBundleV1;
  lifecycle: LiteLearningExternalNormalLifecycleSnapshot;
  artifact: LiteLearningAuthorityRow;
  artifactRowSha256: string;
  recordedAt: string;
}>;

type PersistedExternalEvidenceArtifact = Readonly<{
  rowId: number;
  row: LiteLearningAuthorityRow;
  seriesHeadRowId: number;
  seriesHeadArtifactId: string;
}>;

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function requiredString(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${field}`);
  return value;
}

function assertCanonicalEqual(label: string, actual: unknown, expected: unknown): void {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`learning_external_evidence_ingest_mismatch:${label}`);
  }
}

function assertReportMatchesLiveAuthority(
  report: Readonly<Record<string, unknown>>,
  lifecycle: LiteLearningExternalNormalLifecycleSnapshot,
): void {
  const reservation = lifecycle.reservation;
  const liveBindings: ReadonlyArray<readonly [string, unknown]> = [
    ["tenant_id", reservation.tenant_id],
    ["database_instance_id", lifecycle.databaseInstanceId],
    ["artifact_kind", reservation.artifact_kind],
    ["evidence_series_id", reservation.evidence_series_id],
    ["task_family", reservation.task_family],
    ["applicable_experiment_id", reservation.applicable_experiment_id],
    ["applicable_experiment_revision", reservation.applicable_experiment_revision],
    ["candidate_policy_id", reservation.candidate_policy_id],
    ["candidate_policy_version", reservation.candidate_policy_version],
    ["candidate_policy_implementation_sha256",
      reservation.candidate_policy_implementation_sha256],
    ["candidate_policy_config_sha256", reservation.candidate_policy_config_sha256],
    ["gate_policy_id", reservation.gate_policy_id],
    ["gate_policy_version", reservation.gate_policy_version],
    ["gate_policy_config_sha256", reservation.gate_policy_config_sha256],
    ["applicability_manifest_sha256", reservation.applicability_manifest_sha256],
    ["immutable_input_manifest_sha256", reservation.immutable_input_manifest_sha256],
    ["retry_policy_sha256", reservation.retry_policy_sha256],
    ["harness_bundle_sha256", reservation.harness_bundle_sha256],
    ["source_snapshot_sha256", reservation.source_snapshot_sha256],
    ["run_id", reservation.run_id],
    ["artifact_status", lifecycle.termination.termination_reason],
  ];
  for (const [field, expected] of liveBindings) {
    if (report[field] !== expected) {
      throw new Error(`learning_external_evidence_ingest_mismatch:report.${field}`);
    }
  }
  const payload = report.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("learning_external_evidence_ingest_mismatch:report.payload");
  }
  const payloadRow = payload as Readonly<Record<string, unknown>>;
  if (report.artifact_kind === "offline_paired_rerun") {
    for (const [field, expected] of [
      ["case_set_sha256", reservation.case_set_sha256],
      ["execution_profile_sha256", reservation.execution_profile_sha256],
      ["model_identity_sha256", reservation.model_identity_sha256],
      ["execution_order_sha256", reservation.execution_order_sha256],
    ] as const) {
      if (payloadRow[field] !== expected) {
        throw new Error(`learning_external_evidence_ingest_mismatch:report.payload.${field}`);
      }
    }
  } else if (report.artifact_kind === "tool_e2e_gate"
    && payloadRow.tool_manifest_sha256 !== reservation.tool_manifest_sha256) {
    throw new Error("learning_external_evidence_ingest_mismatch:report.payload.tool_manifest_sha256");
  }
}

function assertPublicArchiveMatchesLiveAuthority(
  publicRunAuthority: LearningExternalPublicRunAuthorityV1,
  lifecycle: LiteLearningExternalNormalLifecycleSnapshot,
): void {
  const payload = publicRunAuthority.payload;
  const comparisons: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["reservation.row", payload.reservation.row, lifecycle.reservation],
    ["reservation.holdout_members",
      payload.reservation.holdout_members, lifecycle.holdoutMembers],
    ["reservation.operation", payload.reservation.operation, lifecycle.operations.reservation],
    ["ticket_consumption.row", payload.ticket_consumption.row, lifecycle.consumption],
    ["ticket_consumption.operation",
      payload.ticket_consumption.operation, lifecycle.operations.consumption],
    ["claim.row", payload.claim.row, lifecycle.claim],
    ["claim.operation", payload.claim.operation, lifecycle.operations.claim],
    ["supervisor_binding.row", payload.supervisor_binding.row, lifecycle.binding],
    ["supervisor_binding.operation",
      payload.supervisor_binding.operation, lifecycle.operations.binding],
    ["session_termination.row", payload.session_termination.row, lifecycle.termination],
    ["session_termination.operation",
      payload.session_termination.operation, lifecycle.operations.termination],
    ["lifecycle_authority_projection",
      payload.lifecycle_authority_projection, lifecycle.lifecycleAuthorityProjection],
  ];
  for (const [label, actual, expected] of comparisons) {
    assertCanonicalEqual(`public_run_authority.${label}`, actual, expected);
  }
}

function assertRequestBindings(args: {
  request: LearningExternalEvidenceIngestRequestV1;
  publicRunAuthoritySha256: string;
  runBundleSha256: string;
  lifecycleProjectionSha256: string;
  lifecycle: LiteLearningExternalNormalLifecycleSnapshot;
}): void {
  const reservation = args.lifecycle.reservation;
  const expected: ReadonlyArray<readonly [string, unknown]> = [
    ["tenant_id", reservation.tenant_id],
    ["artifact_kind", reservation.artifact_kind],
    ["evidence_series_id", reservation.evidence_series_id],
    ["task_family", reservation.task_family],
    ["applicable_experiment_id", reservation.applicable_experiment_id],
    ["applicable_experiment_revision", reservation.applicable_experiment_revision],
    ["lifecycle_authority_projection_sha256", args.lifecycleProjectionSha256],
    ["public_run_authority_sha256", args.publicRunAuthoritySha256],
    ["run_bundle_manifest_sha256", args.runBundleSha256],
  ];
  for (const [field, value] of expected) {
    if (args.request[field as keyof LearningExternalEvidenceIngestRequestV1] !== value) {
      throw new Error(`learning_external_evidence_ingest_mismatch:request.${field}`);
    }
  }
}

function canonicalInputFromPreparedArchive(
  input: LiteLearningExternalEvidenceIngestInput,
): LiteLearningExternalEvidenceCanonicalInput {
  assertPreparedLiteLearningExternalEvidenceArchivePinned(
    input.preparedArchive,
    { verifyHead: false },
  );
  const inspected = inspectPreparedLiteLearningExternalEvidenceArchive(
    input.preparedArchive,
  );
  const archive = inspected.archiveValidation;
  const tracking = inspected.tracking;
  const proof = readLearningExternalEvidenceArchiveProofV1(archive.proof);
  const request = LearningExternalEvidenceIngestRequestV1Schema.parse(input.request);
  const publicRunAuthority = LearningExternalPublicRunAuthorityV1Schema.parse(
    archive.publicRunAuthority,
  );
  const runBundle = LearningExternalEvidenceRunBundleV1Schema.parse(
    archive.contracts.runBundle,
  );
  const contracts = validateLearningExternalEvidenceContractSetV1({
    lifecycleAuthorityProjection: archive.contracts.lifecycleAuthorityProjection,
    report: archive.contracts.report,
    attemptChain: archive.contracts.attemptChain,
    runnerOutputManifest: archive.contracts.runnerOutputManifest,
    terminalRunManifest: archive.contracts.terminalRunManifest,
    publicRunAuthoritySha256: learningExternalPublicRunAuthorityDigest(
      publicRunAuthority,
    ),
    runBundle,
  });
  assertCanonicalEqual("archive.contracts", contracts, archive.contracts);

  const publicRunAuthoritySha256 = learningExternalPublicRunAuthorityDigest(
    publicRunAuthority,
  );
  const runBundleManifestSha256 = learningExternalEvidenceRunBundleDigest(runBundle);
  const publicMember = runBundle.members.find(
    (member) => member.role === "public_run_authority",
  );
  const publicRunAuthorityByteLength = Buffer.byteLength(
    stableStringify(publicRunAuthority),
    "utf8",
  );
  const bindings: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [archive.rawArchiveSha256, proof.raw_archive_sha256, "archive.raw_sha256"],
    [archive.rawArchiveByteLength, proof.raw_archive_byte_length, "archive.raw_byte_length"],
    [archive.runBundleManifestSha256,
      proof.run_bundle_manifest_sha256, "archive.manifest_sha256"],
    [publicRunAuthoritySha256,
      proof.public_run_authority_sha256, "archive.public_run_authority_sha256"],
    [runBundleManifestSha256,
      proof.run_bundle_manifest_sha256, "archive.run_bundle_manifest_sha256"],
    [runBundle.evidence_binding_sha256,
      proof.evidence_binding_sha256, "archive.evidence_binding_sha256"],
    [tracking.raw_archive_sha256,
      proof.raw_archive_sha256, "tracking.raw_archive_sha256"],
    [tracking.raw_archive_byte_length,
      proof.raw_archive_byte_length, "tracking.raw_archive_byte_length"],
    [tracking.public_run_authority_sha256,
      proof.public_run_authority_sha256, "tracking.public_run_authority_sha256"],
    [tracking.public_run_authority_byte_length,
      publicRunAuthorityByteLength, "tracking.public_run_authority_byte_length"],
    [tracking.run_bundle_manifest_sha256,
      proof.run_bundle_manifest_sha256, "tracking.run_bundle_manifest_sha256"],
    [tracking.evidence_binding_sha256,
      proof.evidence_binding_sha256, "tracking.evidence_binding_sha256"],
    [publicMember?.sha256,
      proof.public_run_authority_sha256, "archive.public_member_sha256"],
    [publicMember?.byte_length,
      publicRunAuthorityByteLength, "archive.public_member_byte_length"],
    [request.public_run_authority_sha256,
      proof.public_run_authority_sha256, "request.public_run_authority_sha256"],
    [request.run_bundle_manifest_sha256,
      proof.run_bundle_manifest_sha256, "request.run_bundle_manifest_sha256"],
    [request.run_bundle_archive_sha256,
      proof.raw_archive_sha256, "request.run_bundle_archive_sha256"],
    [request.bundle_commit_id,
      tracking.bundle_commit_id, "request.bundle_commit_id"],
  ];
  for (const [actual, expected, label] of bindings) {
    if (actual !== expected) {
      throw new Error(`learning_external_evidence_ingest_mismatch:${label}`);
    }
  }
  return {
    request,
    publicRunAuthority,
    runBundle,
    recordedAt: LearningExternalCanonicalUtcMillisSchema.parse(input.recordedAt),
  };
}

function buildArtifactRow(args: {
  request: LearningExternalEvidenceIngestRequestV1;
  recordedAt: string;
  lifecycle: LiteLearningExternalNormalLifecycleSnapshot;
  report: ReturnType<typeof validateLearningExternalEvidenceContractSetV1>["report"];
  runBundle: LearningExternalEvidenceRunBundleV1;
  digests: ReturnType<typeof validateLearningExternalEvidenceContractSetV1>["digests"];
}): LiteLearningAuthorityRow {
  const { request, lifecycle, report, runBundle, digests } = args;
  const identity = {
    contract_version: "aionis_learning_external_evidence_artifact_identity_v1",
    evidence_binding_sha256: report.evidence_binding_sha256,
    artifact_kind: report.artifact_kind,
    artifact_status: report.artifact_status,
    tenant_id: report.tenant_id,
    evidence_series_id: report.evidence_series_id,
    task_family: report.task_family,
    applicable_experiment_id: report.applicable_experiment_id,
    applicable_experiment_revision: report.applicable_experiment_revision,
    reservation_id: runBundle.reservation_id,
    ticket_consumption_id: runBundle.ticket_consumption_id,
    claim_id: runBundle.claim_id,
    supervisor_binding_id: runBundle.supervisor_binding_id,
    session_termination_id: runBundle.session_termination_id,
    session_termination_sha256: runBundle.session_termination_sha256,
    report_sha256: digests.report_sha256,
    attempt_chain_sha256: digests.attempt_chain_sha256,
    runner_output_manifest_sha256: digests.runner_output_manifest_sha256,
    terminal_run_manifest_sha256: digests.terminal_run_manifest_sha256,
    source_bundle_sha256: report.source_bundle_sha256,
    harness_bundle_sha256: report.harness_bundle_sha256,
    preterminal_payload_set_sha256: runBundle.preterminal_payload_set_sha256,
  } as const;
  return {
    tenant_id: report.tenant_id,
    artifact_id: learningExternalEvidenceArtifactId(identity),
    artifact_kind: report.artifact_kind,
    evidence_series_id: request.evidence_series_id,
    external_run_reservation_id: runBundle.reservation_id,
    external_ticket_consumption_id: runBundle.ticket_consumption_id,
    external_run_claim_id: runBundle.claim_id,
    external_supervisor_binding_id: runBundle.supervisor_binding_id,
    external_session_termination_id: runBundle.session_termination_id,
    supersedes_artifact_id: null,
    artifact_status: report.artifact_status,
    task_family: request.task_family,
    candidate_policy_id: report.candidate_policy_id,
    candidate_policy_version: report.candidate_policy_version,
    candidate_policy_implementation_sha256: report.candidate_policy_implementation_sha256,
    candidate_policy_config_sha256: report.candidate_policy_config_sha256,
    applicable_experiment_id: request.applicable_experiment_id,
    applicable_experiment_revision: request.applicable_experiment_revision,
    source_experiment_id: report.source_experiment_id,
    source_experiment_revision: report.source_experiment_revision,
    source_serving_phase: report.source_serving_phase,
    look_index: null,
    look_proposal_sha256: null,
    gate_policy_id: report.gate_policy_id,
    gate_policy_version: report.gate_policy_version,
    gate_policy_config_sha256: report.gate_policy_config_sha256,
    evidence_scope_set_sha256: report.evidence_scope_set_sha256,
    source_bundle_sha256: report.source_bundle_sha256,
    harness_bundle_sha256: report.harness_bundle_sha256,
    report_sha256: digests.report_sha256,
    report_json: learningExternalEvidenceReportJson(report),
    source_ref: runBundle.source_ref,
    source_commit_id: runBundle.source_commit_id,
    collected_at: report.collected_at,
    ingested_at: args.recordedAt,
    created_by: request.actor_id,
  };
}

export function validateLiteLearningExternalEvidenceIngestion(
  db: SqliteDatabase,
  input: LiteLearningExternalEvidenceCanonicalInput,
): LiteLearningExternalEvidenceIngestionValidation {
  const request = LearningExternalEvidenceIngestRequestV1Schema.parse(input.request);
  const publicRunAuthority = LearningExternalPublicRunAuthorityV1Schema.parse(
    input.publicRunAuthority,
  );
  const runBundle = LearningExternalEvidenceRunBundleV1Schema.parse(input.runBundle);
  const recordedAt = LearningExternalCanonicalUtcMillisSchema.parse(input.recordedAt);
  const payload = publicRunAuthority.payload;
  if (payload.reservation.row.reservation_id !== runBundle.reservation_id) {
    throw new Error("learning_external_evidence_ingest_mismatch:reservation_id");
  }

  const lifecycle = resolveLiteLearningExternalNormalLifecycleSnapshot(db, {
    tenantId: payload.tenant_id,
    reservationId: payload.reservation.row.reservation_id,
    evidenceBindingSha256: payload.evidence_binding_sha256,
  });
  const publicAuthorityValidation = validateLearningExternalPublicRunAuthorityV1({
    publicRunAuthority,
    expected: {
      tenant_id: lifecycle.tenantId,
      database_instance_id: lifecycle.databaseInstanceId,
      broker_public_key_base64: lifecycle.frozenRole.broker_public_key_base64,
      broker_policy_sha256: lifecycle.frozenRole.broker_policy_sha256,
      broker_binary_sha256: lifecycle.frozenRole.broker_binary_sha256,
      broker_key_id: lifecycle.frozenRole.broker_key_id,
      service_launcher_public_key_base64:
        lifecycle.frozenRuntimeAuthorityAttestor.service_launcher_public_key_base64,
      service_launcher_policy_sha256: lifecycle.frozenRole.service_launcher_policy_sha256,
      service_launcher_binary_sha256: lifecycle.frozenRole.service_launcher_binary_sha256,
      service_launcher_key_id: lifecycle.frozenRole.service_launcher_key_id,
    },
  });
  assertPublicArchiveMatchesLiveAuthority(
    publicAuthorityValidation.publicRunAuthority,
    lifecycle,
  );

  const contracts = validateLearningExternalEvidenceContractSetV1({
    lifecycleAuthorityProjection: payload.lifecycle_authority_projection,
    report: payload.report,
    attemptChain: payload.attempt_chain,
    runnerOutputManifest: payload.runner_output_manifest,
    terminalRunManifest: payload.terminal_run_manifest,
    publicRunAuthoritySha256: publicAuthorityValidation.publicRunAuthoritySha256,
    runBundle,
  });
  const publicAuthorityMember = contracts.runBundle.members.find(
    (member) => member.role === "public_run_authority",
  );
  if (!publicAuthorityMember
    || publicAuthorityMember.byte_length !== publicAuthorityValidation.canonicalByteLength) {
    throw new Error(
      "learning_external_evidence_ingest_mismatch:public_run_authority_byte_length",
    );
  }
  if (contracts.runBundle.committed_at
    < publicAuthorityValidation.publicRunAuthority.terminal_fact_drain_receipt.body.drained_at) {
    throw new Error("external evidence run bundle cannot precede terminal-fact drain");
  }
  if (recordedAt < contracts.runBundle.committed_at) {
    throw new Error("external evidence ingestion cannot precede run-bundle commit");
  }
  assertReportMatchesLiveAuthority(contracts.report, lifecycle);
  assertRequestBindings({
    request,
    publicRunAuthoritySha256: publicAuthorityValidation.publicRunAuthoritySha256,
    runBundleSha256: contracts.digests.run_bundle_sha256,
    lifecycleProjectionSha256: contracts.digests.lifecycle_authority_projection_sha256,
    lifecycle,
  });

  const artifact = buildArtifactRow({
    request,
    recordedAt,
    lifecycle,
    report: contracts.report,
    runBundle: contracts.runBundle,
    digests: contracts.digests,
  });
  const artifactRowSha256 = sha256Canonical(artifact);
  return {
    request,
    publicRunAuthority: publicAuthorityValidation.publicRunAuthority,
    runBundle: contracts.runBundle,
    lifecycle,
    artifact,
    artifactRowSha256,
    recordedAt,
  };
}

function buildPersistedIngestReceipt(
  validation: LiteLearningExternalEvidenceIngestionValidation,
  persisted: PersistedExternalEvidenceArtifact,
): LiteLearningExternalEvidenceIngestOperationReceiptV1 {
  const { request, lifecycle, artifact } = validation;
  const requestSha256 = learningExternalEvidenceIngestRequestDigest(request);
  const projection = ExternalEvidencePostTransactionProjectionV1Schema.parse({
    contract_version: "aionis_learning_external_evidence_post_transaction_projection_v1",
    tenant_id: request.tenant_id,
    database_instance_id: lifecycle.databaseInstanceId,
    scope: EXTERNAL_AUTHORITY_SCOPE,
    operation_kind: EXTERNAL_EVIDENCE_INGEST_OPERATION_KIND,
    operation_id: request.operation_id,
    request_sha256: requestSha256,
    artifact_id: requiredString(artifact, "artifact_id"),
    artifact_row_id: persisted.rowId,
    artifact_row_sha256: validation.artifactRowSha256,
    evidence_series_id: request.evidence_series_id,
    series_head_artifact_id: persisted.seriesHeadArtifactId,
    series_head_row_id: persisted.seriesHeadRowId,
    artifact_status: requiredString(artifact, "artifact_status"),
    reservation_id: requiredString(artifact, "external_run_reservation_id"),
    ticket_consumption_id: requiredString(artifact, "external_ticket_consumption_id"),
    claim_id: requiredString(artifact, "external_run_claim_id"),
    supervisor_binding_id: requiredString(artifact, "external_supervisor_binding_id"),
    session_termination_id: requiredString(artifact, "external_session_termination_id"),
    public_run_authority_sha256: request.public_run_authority_sha256,
    run_bundle_manifest_sha256: request.run_bundle_manifest_sha256,
    run_bundle_archive_sha256: request.run_bundle_archive_sha256,
    bundle_commit_id: request.bundle_commit_id,
  });
  return ExternalEvidenceIngestOperationReceiptV1Schema.parse({
    contract_version: "aionis_learning_external_evidence_ingest_operation_receipt_v1",
    tenant_id: request.tenant_id,
    scope: EXTERNAL_AUTHORITY_SCOPE,
    operation_kind: EXTERNAL_EVIDENCE_INGEST_OPERATION_KIND,
    operation_id: request.operation_id,
    actor_id: request.actor_id,
    request,
    request_sha256: requestSha256,
    artifact_id: requiredString(artifact, "artifact_id"),
    artifact_row_sha256: validation.artifactRowSha256,
    artifact_status: requiredString(artifact, "artifact_status"),
    public_run_authority_sha256: request.public_run_authority_sha256,
    run_bundle_manifest_sha256: request.run_bundle_manifest_sha256,
    run_bundle_archive_sha256: request.run_bundle_archive_sha256,
    bundle_commit_id: request.bundle_commit_id,
    public_run_authority: validation.publicRunAuthority,
    run_bundle: validation.runBundle,
    post_transaction_projection: projection,
    post_transaction_projection_sha256: sha256Canonical(projection),
    recorded_at: validation.recordedAt,
  });
}

function parseIngestReceipt(raw: unknown): LiteLearningExternalEvidenceIngestOperationReceiptV1 {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8")
    > MAX_INGEST_OPERATION_RECEIPT_BYTES) {
    throw new Error("external evidence ingest operation receipt is missing or oversized");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("external evidence ingest operation receipt is invalid JSON");
  }
  if (stableStringify(value) !== raw) {
    throw new Error("external evidence ingest operation receipt is not canonical JSON");
  }
  const parsed = ExternalEvidenceIngestOperationReceiptV1Schema.parse(value);
  if (stableStringify(parsed) !== raw) {
    throw new Error("external evidence ingest operation receipt is not schema-canonical");
  }
  return parsed;
}

function operationRow(
  db: SqliteDatabase,
  tenantId: string,
  operationId: string,
): LiteRuntimeWriteOperationRow | null {
  return (db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at
     FROM lite_runtime_write_operations
     WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
  ).get(
    tenantId,
    EXTERNAL_AUTHORITY_SCOPE,
    EXTERNAL_EVIDENCE_INGEST_OPERATION_KIND,
    operationId,
  ) as LiteRuntimeWriteOperationRow | undefined) ?? null;
}

function assertOperationRowMatchesReceipt(
  operation: LiteRuntimeWriteOperationRow,
  receipt: LiteLearningExternalEvidenceIngestOperationReceiptV1,
): void {
  const expectedReceiptJson = stableStringify(receipt);
  if (operation.tenant_id !== receipt.tenant_id
    || operation.scope !== receipt.scope
    || operation.operation_kind !== receipt.operation_kind
    || operation.operation_id !== receipt.operation_id
    || operation.request_sha256 !== receipt.request_sha256
    || operation.receipt_json !== expectedReceiptJson
    || operation.commit_id !== receipt.bundle_commit_id
    || operation.created_at !== receipt.recorded_at) {
    throw new Error("learning_external_evidence_ingest_operation_receipt_conflict");
  }
}

function selectArtifact(
  db: SqliteDatabase,
  tenantId: string,
  artifactId: string,
): Readonly<{ rowId: number; row: LiteLearningAuthorityRow }> | null {
  const selected = db.prepare(
    `SELECT row_id, ${EVIDENCE_ARTIFACT_COLUMNS.join(", ")}
     FROM lite_learning_evidence_artifacts
     WHERE tenant_id = ? AND artifact_id = ? LIMIT 1`,
  ).get(tenantId, artifactId) as (LiteLearningAuthorityRow & { row_id: number }) | undefined;
  if (!selected || !Number.isSafeInteger(selected.row_id) || selected.row_id <= 0) return null;
  const { row_id: rowId, ...row } = selected;
  return { rowId, row };
}

function assertArtifactExact(
  existing: LiteLearningAuthorityRow,
  expected: LiteLearningAuthorityRow,
): void {
  for (const field of EVIDENCE_ARTIFACT_COLUMNS) {
    if (!Object.is(existing[field], expected[field])) {
      throw new Error(`learning_external_evidence_ingest_replay_conflict:artifact.${field}`);
    }
  }
}

function assertPersistedArtifact(
  db: SqliteDatabase,
  validation: LiteLearningExternalEvidenceIngestionValidation,
): PersistedExternalEvidenceArtifact {
  const artifactId = requiredString(validation.artifact, "artifact_id");
  const persisted = selectArtifact(db, validation.request.tenant_id, artifactId);
  if (!persisted) throw new Error("external evidence ingest artifact row is missing");
  assertArtifactExact(persisted.row, validation.artifact);
  if (sha256Canonical(persisted.row) !== validation.artifactRowSha256) {
    throw new Error("external evidence ingest artifact row digest mismatch");
  }
  const seriesHeads = db.prepare(
    `SELECT row_id, artifact_id FROM lite_learning_evidence_artifacts
     WHERE tenant_id = ? AND evidence_series_id = ? AND supersedes_artifact_id IS NULL`,
  ).all(
    validation.request.tenant_id,
    validation.request.evidence_series_id,
  ) as Array<{ row_id: number; artifact_id: string }>;
  const seriesHead = seriesHeads[0];
  if (seriesHeads.length !== 1
    || !seriesHead
    || !Number.isSafeInteger(seriesHead.row_id)
    || seriesHead.row_id <= 0
    || seriesHead.artifact_id !== artifactId
    || seriesHead.row_id !== persisted.rowId) {
    throw new Error("external evidence ingest series head mismatch");
  }
  return {
    rowId: persisted.rowId,
    row: persisted.row,
    seriesHeadRowId: seriesHead.row_id,
    seriesHeadArtifactId: seriesHead.artifact_id,
  };
}

function assertNoExistingExternalArtifactPrefix(
  db: SqliteDatabase,
  artifact: LiteLearningAuthorityRow,
): void {
  const conflict = db.prepare(
    `SELECT artifact_id FROM lite_learning_evidence_artifacts
     WHERE tenant_id = ? AND (
       artifact_id = ? OR report_sha256 = ? OR evidence_series_id = ?
       OR external_run_reservation_id = ? OR external_ticket_consumption_id = ?
       OR external_run_claim_id = ? OR external_supervisor_binding_id = ?
       OR external_session_termination_id = ?
     ) LIMIT 1`,
  ).get(
    artifact.tenant_id,
    artifact.artifact_id,
    artifact.report_sha256,
    artifact.evidence_series_id,
    artifact.external_run_reservation_id,
    artifact.external_ticket_consumption_id,
    artifact.external_run_claim_id,
    artifact.external_supervisor_binding_id,
    artifact.external_session_termination_id,
  );
  if (conflict) {
    throw new Error("external evidence artifact prefix exists without its ingest operation");
  }
}

function insertArtifact(db: SqliteDatabase, artifact: LiteLearningAuthorityRow): void {
  db.prepare(
    `INSERT INTO lite_learning_evidence_artifacts
       (${EVIDENCE_ARTIFACT_COLUMNS.join(", ")})
     VALUES (${EVIDENCE_ARTIFACT_COLUMNS.map(() => "?").join(", ")})`,
  ).run(...EVIDENCE_ARTIFACT_COLUMNS.map((field) => artifact[field]));
}

function insertOperation(
  db: SqliteDatabase,
  transaction: SqliteTransactionRunner,
  receipt: LiteLearningExternalEvidenceIngestOperationReceiptV1,
): void {
  appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction({
    db,
    transaction,
    tenantId: receipt.tenant_id,
    scope: receipt.scope,
    operationKind: receipt.operation_kind,
    operationId: receipt.operation_id,
    requestSha256: receipt.request_sha256,
    receiptJson: stableStringify(receipt),
    commitId: receipt.bundle_commit_id,
    createdAt: receipt.recorded_at,
  });
}

let savepointSequence = 0;

function withSavepoint<T>(db: SqliteDatabase, fn: () => T): T {
  savepointSequence += 1;
  const savepoint = `learning_external_evidence_ingest_${savepointSequence}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

export type LiteLearningExternalEvidenceIngestionAccess = Readonly<{
  ingestExternalEvidence(input: LiteLearningExternalEvidenceIngestInput): Promise<Readonly<{
    artifact: LiteLearningAuthorityRow;
    receipt: LiteLearningExternalEvidenceIngestOperationReceiptV1;
    replayed: boolean;
  }>>;
}>;

export type LiteLearningExternalEvidenceIngestionPhase =
  | "after_artifact_insert"
  | "after_operation_insert";

export function createLiteLearningExternalEvidenceIngestionAccess(args: Readonly<{
  database: LiteRuntimeDatabase;
  /** @internal Process-crash testing only; formal operator paths never configure this. */
  faultInjector?: (phase: LiteLearningExternalEvidenceIngestionPhase) => void;
}>): LiteLearningExternalEvidenceIngestionAccess {
  const { database, faultInjector } = args;
  const { db, transaction } = database;
  return {
    async ingestExternalEvidence(input) {
      assertLiteRuntimeProtectedAuthorityTransactionCapability(
        input.protectedTransactionCapability,
        database,
      );
      const canonicalInput = canonicalInputFromPreparedArchive(input);
      const request = canonicalInput.request;
      const existingOperation = operationRow(db, request.tenant_id, request.operation_id);
      if (existingOperation) {
        const persistedReceipt = parseIngestReceipt(existingOperation.receipt_json);
        const { publicRunAuthority, runBundle } = canonicalInput;
        assertCanonicalEqual("replay.request", request, persistedReceipt.request);
        assertCanonicalEqual(
          "replay.public_run_authority",
          publicRunAuthority,
          persistedReceipt.public_run_authority,
        );
        assertCanonicalEqual("replay.run_bundle", runBundle, persistedReceipt.run_bundle);
        const validation = validateLiteLearningExternalEvidenceIngestion(db, {
          request,
          publicRunAuthority,
          runBundle,
          // Retry wall time is deliberately ignored. The first receipt owns audit time.
          recordedAt: persistedReceipt.recorded_at,
        });
        const persisted = assertPersistedArtifact(db, validation);
        const expectedReceipt = buildPersistedIngestReceipt(validation, persisted);
        assertCanonicalEqual("replay.receipt", persistedReceipt, expectedReceipt);
        assertOperationRowMatchesReceipt(existingOperation, persistedReceipt);
        assertPreparedLiteLearningExternalEvidenceArchivePinned(
          input.preparedArchive,
          { verifyHead: false },
        );
        assertLiteRuntimeProtectedAuthorityTransactionCapability(
          input.protectedTransactionCapability,
          database,
        );
        return {
          artifact: persisted.row,
          receipt: persistedReceipt,
          replayed: true,
        };
      }

      const validation = validateLiteLearningExternalEvidenceIngestion(db, canonicalInput);
      assertNoExistingExternalArtifactPrefix(db, validation.artifact);
      const result = withSavepoint(db, () => {
        insertArtifact(db, validation.artifact);
        faultInjector?.("after_artifact_insert");
        const persisted = assertPersistedArtifact(db, validation);
        const receipt = buildPersistedIngestReceipt(validation, persisted);
        insertOperation(db, transaction, receipt);
        faultInjector?.("after_operation_insert");
        const operation = operationRow(
          db,
          validation.request.tenant_id,
          validation.request.operation_id,
        );
        if (!operation) throw new Error("external evidence ingest operation row is missing");
        assertOperationRowMatchesReceipt(operation, receipt);
        return {
          artifact: persisted.row,
          receipt,
          replayed: false,
        };
      });
      assertPreparedLiteLearningExternalEvidenceArchivePinned(
        input.preparedArchive,
        { verifyHead: false },
      );
      assertLiteRuntimeProtectedAuthorityTransactionCapability(
        input.protectedTransactionCapability,
        database,
      );
      return result;
    },
  };
}

export function assertLiteLearningExternalEvidenceIngestionIntegrity(
  db: SqliteDatabase,
): void {
  const operations = db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at
     FROM lite_runtime_write_operations
     WHERE scope = ? AND operation_kind = ?
     ORDER BY tenant_id, operation_id`,
  ).all(
    EXTERNAL_AUTHORITY_SCOPE,
    EXTERNAL_EVIDENCE_INGEST_OPERATION_KIND,
  ) as LiteRuntimeWriteOperationRow[];
  const artifacts = db.prepare(
    `SELECT ${EVIDENCE_ARTIFACT_COLUMNS.join(", ")}
     FROM lite_learning_evidence_artifacts
     WHERE artifact_kind <> 'runtime_integrity_gate'
     ORDER BY tenant_id, artifact_id`,
  ).all() as LiteLearningAuthorityRow[];
  const artifactsByIdentity = new Map<string, LiteLearningAuthorityRow>();
  for (const artifact of artifacts) {
    artifactsByIdentity.set(
      `${requiredString(artifact, "tenant_id")}\u0000${requiredString(artifact, "artifact_id")}`,
      artifact,
    );
  }
  const verifiedArtifactIdentities = new Set<string>();
  for (const operation of operations) {
    const receipt = parseIngestReceipt(operation.receipt_json);
    const validation = validateLiteLearningExternalEvidenceIngestion(db, {
      request: receipt.request,
      publicRunAuthority: receipt.public_run_authority,
      runBundle: receipt.run_bundle,
      recordedAt: receipt.recorded_at,
    });
    const persisted = assertPersistedArtifact(db, validation);
    const expectedReceipt = buildPersistedIngestReceipt(validation, persisted);
    assertCanonicalEqual("reopen.receipt", receipt, expectedReceipt);
    assertOperationRowMatchesReceipt(operation, receipt);
    const identity = `${receipt.tenant_id}\u0000${receipt.artifact_id}`;
    if (verifiedArtifactIdentities.has(identity)) {
      throw new Error("multiple external evidence ingest operations target one artifact");
    }
    const artifact = artifactsByIdentity.get(identity);
    if (!artifact) throw new Error("external evidence ingest operation has no artifact");
    assertArtifactExact(artifact, validation.artifact);
    verifiedArtifactIdentities.add(identity);
  }
  for (const identity of artifactsByIdentity.keys()) {
    if (!verifiedArtifactIdentities.has(identity)) {
      throw new Error("external evidence artifact has no protected ingest operation");
    }
  }
}
