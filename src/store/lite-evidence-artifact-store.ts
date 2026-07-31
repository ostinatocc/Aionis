import { createHash } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";

import {
  EXECUTION_EPISODE_MAX_ARTIFACT_BYTES,
  EvidenceArtifactInputV1Schema,
  EvidenceArtifactRefV1Schema,
  evidenceArtifactRefDigest,
  type EvidenceArtifactInputV1,
  type EvidenceArtifactKindV1,
  type EvidenceArtifactRefV1,
} from "../memory/execution-episode.js";
import { stableUuid } from "../util/uuid.js";
import {
  appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction,
} from "./lite-runtime-applied-authority.js";
import type { LiteRuntimeDatabase } from "./lite-runtime-database.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";

const MAX_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_UPLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_POLICY_BYTES = 256;
const MAX_REASON_BYTES = 2048;
const MAX_CLEANUP_BATCH = 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_UTC_MILLIS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const OPERATION_KIND = Object.freeze({
  inlineIngest: "evidence_artifact_inline_ingest_v1",
  inputMaterialize: "evidence_artifact_input_materialize_v1",
  uploadStart: "evidence_artifact_upload_start_v1",
  uploadChunk: "evidence_artifact_upload_chunk_v1",
  uploadFinalize: "evidence_artifact_upload_finalize_v1",
  uploadAbort: "evidence_artifact_upload_abort_v1",
  orphanCleanup: "evidence_artifact_orphan_cleanup_v1",
});

export class LiteEvidenceArtifactStoreError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "LiteEvidenceArtifactStoreError";
    this.code = code;
  }
}

export type LiteEvidenceArtifactUploadStartReceiptV1 = Readonly<{
  contract_version: "artifact_upload_start_receipt_v1";
  upload_id: string;
  episode_id: string;
  expires_at: string;
  max_chunk_bytes: number;
}>;

export type LiteEvidenceArtifactUploadChunkReceiptV1 = Readonly<{
  contract_version: "artifact_upload_chunk_receipt_v1";
  upload_id: string;
  sequence: number;
  byte_offset: number;
  byte_length: number;
  next_sequence: number;
  next_byte_offset: number;
}>;

export type LiteEvidenceArtifactUploadFinalizeReceiptV1 = Readonly<{
  contract_version: "artifact_upload_finalize_receipt_v1";
  upload_id: string;
  artifact_ref: EvidenceArtifactRefV1;
  finalize_receipt_digest: string;
}>;

export type LiteEvidenceArtifactUploadAbortReceiptV1 = Readonly<{
  contract_version: "artifact_upload_abort_receipt_v1";
  upload_id: string;
  status: "aborted";
  reason: string;
  discarded_chunk_count: number;
  discarded_byte_length: number;
}>;

export type LiteEvidenceArtifactInlineIngestReceiptV1 = Readonly<{
  contract_version: "artifact_inline_ingest_receipt_v1";
  artifact_ref: EvidenceArtifactRefV1;
}>;

export type LiteEvidenceArtifactOrphanUploadCandidateV1 = Readonly<{
  tenant_id: string;
  scope: string;
  upload_id: string;
  episode_id: string;
  expires_at: string;
  chunk_count: number;
  byte_length: number;
}>;

export type LiteEvidenceArtifactOrphanCleanupReceiptV1 = Readonly<{
  contract_version: "artifact_orphan_cleanup_receipt_v1";
  mode: "apply";
  as_of: string;
  request_limit: number;
  expired_uploads: readonly LiteEvidenceArtifactOrphanUploadCandidateV1[];
  discarded_chunk_count: number;
  discarded_byte_length: number;
}>;

export type LiteEvidenceArtifactIntegrityReportV1 = Readonly<{
  contract_version: "lite_evidence_artifact_integrity_v1";
  ok: boolean;
  counts: Readonly<{
    blobs: number;
    artifacts: number;
    uploads: number;
    chunks: number;
    unreferenced_artifacts: number;
    unreferenced_blobs: number;
    retention_expired_referenced_artifacts: number;
  }>;
  garbage_collection: Readonly<{
    mode: "report_only_fail_closed_v1";
    apply_supported: false;
    deletion_blocked: boolean;
    unreferenced_artifacts: readonly string[];
    unreferenced_blobs: readonly string[];
    retention_expired_referenced_artifacts: readonly string[];
  }>;
  problems: readonly string[];
  warnings: readonly string[];
}>;

export type LiteEvidenceArtifactStore = {
  transactionRunner(): SqliteTransactionRunner;
  materializeInputInCurrentTransaction(args: {
    tenantId: string;
    scope: string;
    episodeId: string;
    operationId: string;
    artifact: EvidenceArtifactInputV1;
    redactionPolicy: string;
    retentionPolicy: string;
    retentionUntil?: string | null;
  }): Promise<EvidenceArtifactRefV1>;
  ingestInlineInCurrentTransaction(args: {
    tenantId: string;
    scope: string;
    episodeId: string;
    operationId: string;
    artifact: EvidenceArtifactInputV1;
    redactionPolicy: string;
    retentionPolicy: string;
    retentionUntil?: string | null;
  }): Promise<LiteEvidenceArtifactInlineIngestReceiptV1>;
  startUploadInCurrentTransaction(args: {
    tenantId: string;
    scope: string;
    episodeId: string;
    operationId: string;
    kind: EvidenceArtifactKindV1;
    declaredSha256: string;
    declaredByteLength: number;
    mediaType: string;
    encoding: string;
    redactionPolicy: string;
    retentionPolicy: string;
    retentionUntil?: string | null;
  }): Promise<LiteEvidenceArtifactUploadStartReceiptV1>;
  appendUploadChunkInCurrentTransaction(args: {
    tenantId: string;
    scope: string;
    operationId: string;
    uploadId: string;
    sequence: number;
    byteOffset: number;
    dataBase64: string;
    chunkSha256: string;
  }): Promise<LiteEvidenceArtifactUploadChunkReceiptV1>;
  finalizeUploadInCurrentTransaction(args: {
    tenantId: string;
    scope: string;
    operationId: string;
    uploadId: string;
    expectedChunkCount: number;
    declaredSha256: string;
    declaredByteLength: number;
  }): Promise<LiteEvidenceArtifactUploadFinalizeReceiptV1>;
  abortUploadInCurrentTransaction(args: {
    tenantId: string;
    scope: string;
    operationId: string;
    uploadId: string;
    reason: string;
  }): Promise<LiteEvidenceArtifactUploadAbortReceiptV1>;
  resolveArtifact(args: {
    tenantId: string;
    scope: string;
    artifactId: string;
    episodeId: string;
  }): Promise<EvidenceArtifactRefV1 | null>;
  readArtifactBytes(args: {
    tenantId: string;
    scope: string;
    artifactId: string;
    episodeId: string;
  }): Promise<Buffer>;
  inspectIntegrity(): Promise<LiteEvidenceArtifactIntegrityReportV1>;
  collectExpiredOrphanUploads(args:
    | {
      mode: "dry_run";
      asOf?: string;
      limit?: number;
    }
    | {
      mode: "apply";
      tenantId: string;
      scope: string;
      operationId: string;
      asOf?: string;
      limit?: number;
    }
  ): Promise<
    | readonly LiteEvidenceArtifactOrphanUploadCandidateV1[]
    | LiteEvidenceArtifactOrphanCleanupReceiptV1
  >;
};

type ArtifactRow = {
  tenant_id: string;
  scope: string;
  artifact_id: string;
  episode_id: string;
  kind: EvidenceArtifactKindV1;
  sha256: string;
  storage_ref: string;
  byte_length: number;
  media_type: string;
  encoding: string;
  redaction_policy: string;
  retention_policy: string;
  retention_until: string | null;
  ingest_mode: "bounded_inline_base64" | "finalized_runtime_upload";
  source_upload_id: string | null;
  artifact_ref_sha256: string;
  created_at: string;
};

type UploadRow = {
  tenant_id: string;
  scope: string;
  upload_id: string;
  episode_id: string;
  kind: EvidenceArtifactKindV1;
  declared_sha256: string;
  declared_byte_length: number;
  media_type: string;
  encoding: string;
  redaction_policy: string;
  retention_policy: string;
  retention_until: string | null;
  start_operation_id: string;
  start_request_sha256: string;
  status: "open" | "finalized" | "aborted" | "expired";
  next_sequence: number;
  next_byte_offset: number;
  terminal_operation_id: string | null;
  terminal_request_sha256: string | null;
  finalized_artifact_id: string | null;
  finalize_receipt_sha256: string | null;
  terminal_reason: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  row_version: number;
};

type ChunkRow = {
  sequence: number;
  byte_offset: number;
  byte_length: number;
  chunk_sha256: string;
  chunk_bytes: Uint8Array;
  operation_id: string;
  request_sha256: string;
};

type OperationRow = {
  request_sha256: string;
  receipt_json: string;
};

function fail(code: string, message = code): never {
  throw new LiteEvidenceArtifactStoreError(code, message);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function canonicalNow(): string {
  return new Date().toISOString();
}

function assertCanonicalTimestamp(value: string, code: string): void {
  if (
    !CANONICAL_UTC_MILLIS_PATTERN.test(value)
    || new Date(value).toISOString() !== value
  ) {
    fail(code);
  }
}

function assertExactString(
  value: string,
  maximumBytes: number,
  code: string,
): void {
  if (
    value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    fail(code);
  }
}

function assertIdentity(args: {
  tenantId: string;
  scope: string;
  operationId?: string;
  episodeId?: string;
  uploadId?: string;
}): void {
  assertExactString(args.tenantId, 256, "evidence_artifact_tenant_invalid");
  assertExactString(args.scope, 256, "evidence_artifact_scope_invalid");
  if (args.operationId !== undefined) {
    assertExactString(
      args.operationId,
      256,
      "evidence_artifact_operation_id_invalid",
    );
  }
  if (args.episodeId !== undefined) {
    assertExactString(
      args.episodeId,
      256,
      "evidence_artifact_episode_id_invalid",
    );
  }
  if (args.uploadId !== undefined) {
    assertExactString(args.uploadId, 256, "evidence_artifact_upload_id_invalid");
  }
}

function assertSha256(value: string, code: string): void {
  if (!SHA256_PATTERN.test(value)) fail(code);
}

function assertByteLength(value: number, code: string): void {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > EXECUTION_EPISODE_MAX_ARTIFACT_BYTES
  ) {
    fail(code);
  }
}

function assertPolicies(args: {
  redactionPolicy: string;
  retentionPolicy: string;
  retentionUntil?: string | null;
}): void {
  assertExactString(
    args.redactionPolicy,
    MAX_POLICY_BYTES,
    "evidence_artifact_redaction_policy_invalid",
  );
  assertExactString(
    args.retentionPolicy,
    MAX_POLICY_BYTES,
    "evidence_artifact_retention_policy_invalid",
  );
  if (args.retentionUntil) {
    assertCanonicalTimestamp(
      args.retentionUntil,
      "evidence_artifact_retention_until_invalid",
    );
  }
}

function decodeCanonicalBase64(value: string, code: string): Buffer {
  if (
    value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)
  ) {
    fail(code);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(code);
  return bytes;
}

function artifactRefFromRow(row: ArtifactRow): EvidenceArtifactRefV1 {
  return EvidenceArtifactRefV1Schema.parse({
    contract_version: "evidence_artifact_ref_v1",
    artifact_id: row.artifact_id,
    kind: row.kind,
    sha256: row.sha256,
    storage_ref: row.storage_ref,
    byte_length: row.byte_length,
    media_type: row.media_type,
    encoding: row.encoding,
    redaction_policy: row.redaction_policy,
    retention_policy: row.retention_policy,
  });
}

function readVerifiedArtifactBytes(
  db: SqliteDatabase,
  artifact: ArtifactRow,
): Buffer {
  const blob = db.prepare(
    `SELECT byte_length, content_bytes
     FROM lite_runtime_evidence_blobs
     WHERE tenant_id = ? AND blob_sha256 = ?`,
  ).get(
    artifact.tenant_id,
    artifact.sha256,
  ) as { byte_length: number; content_bytes: Uint8Array } | undefined;
  if (!blob) fail("evidence_artifact_blob_missing");
  const bytes = Buffer.from(blob.content_bytes);
  if (
    blob.byte_length !== artifact.byte_length
    || bytes.byteLength !== artifact.byte_length
    || sha256Bytes(bytes) !== artifact.sha256
  ) {
    fail("evidence_artifact_blob_integrity_failed");
  }
  return bytes;
}

function verifiedArtifactRefFromRow(
  db: SqliteDatabase,
  artifact: ArtifactRow,
): EvidenceArtifactRefV1 {
  const reference = artifactRefFromRow(artifact);
  if (
    artifact.storage_ref !== `sqlite-cas://sha256/${artifact.sha256}`
    || evidenceArtifactRefDigest(reference) !== artifact.artifact_ref_sha256
  ) {
    fail("evidence_artifact_reference_integrity_failed");
  }
  readVerifiedArtifactBytes(db, artifact);
  return reference;
}

function exactArtifactId(args: {
  tenantId: string;
  scope: string;
  episodeId: string;
  kind: EvidenceArtifactKindV1;
  sha256: string;
  byteLength: number;
  mediaType: string;
  encoding: string;
  redactionPolicy: string;
  retentionPolicy: string;
  retentionUntil: string | null;
  sourceUploadId: string | null;
}): string {
  return stableUuid(
    stableStringify({
      contract: "runtime_evidence_artifact_identity_v1",
      tenant_id: args.tenantId,
      scope: args.scope,
      episode_id: args.episodeId,
      kind: args.kind,
      sha256: args.sha256,
      byte_length: args.byteLength,
      media_type: args.mediaType,
      encoding: args.encoding,
      redaction_policy: args.redactionPolicy,
      retention_policy: args.retentionPolicy,
      retention_until: args.retentionUntil,
      source_upload_id: args.sourceUploadId,
    }),
    "aionis-runtime-evidence-artifact-v1",
  );
}

function exactUploadId(args: {
  tenantId: string;
  scope: string;
  operationId: string;
  requestSha256: string;
}): string {
  return stableUuid(
    `${args.tenantId}:${args.scope}:${args.operationId}:${args.requestSha256}`,
    "aionis-runtime-evidence-upload-v1",
  );
}

function exactCleanupTerminalOperationId(
  cleanupOperationId: string,
  uploadId: string,
): string {
  return stableUuid(
    `${cleanupOperationId}:${uploadId}`,
    "aionis-runtime-evidence-expiry-v1",
  );
}

function operationRow(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    operationKind: string;
    operationId: string;
  },
): OperationRow | null {
  return (
    db.prepare(
      `SELECT request_sha256, receipt_json
       FROM lite_runtime_write_operations
       WHERE tenant_id = ?
         AND scope = ?
         AND operation_kind = ?
         AND operation_id = ?`,
    ).get(
      args.tenantId,
      args.scope,
      args.operationKind,
      args.operationId,
    ) as OperationRow | undefined
  ) ?? null;
}

function operationBinding(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    operationKind: string;
    operationId: string;
    requestSha256: string;
  },
): Record<string, unknown> | null {
  const row = operationRow(db, args);
  if (!row || row.request_sha256 !== args.requestSha256) return null;
  try {
    const receipt = JSON.parse(row.receipt_json) as unknown;
    return receipt && typeof receipt === "object" && !Array.isArray(receipt)
      ? receipt as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function replayReceipt<T>(args: {
  db: SqliteDatabase;
  tenantId: string;
  scope: string;
  operationKind: string;
  operationId: string;
  requestSha256: string;
}): T | null {
  const existing = operationRow(args.db, args);
  if (!existing) return null;
  if (existing.request_sha256 !== args.requestSha256) {
    fail("evidence_artifact_operation_conflict");
  }
  try {
    const parsed = JSON.parse(existing.receipt_json) as T;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("evidence_artifact_operation_receipt_corrupt");
    }
    return parsed;
  } catch (error) {
    if (error instanceof LiteEvidenceArtifactStoreError) throw error;
    fail("evidence_artifact_operation_receipt_corrupt");
  }
}

function recordOperation(args: {
  db: SqliteDatabase;
  transaction: SqliteTransactionRunner;
  tenantId: string;
  scope: string;
  operationKind: string;
  operationId: string;
  requestSha256: string;
  receipt: object;
  createdAt: string;
}): void {
  appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction({
    db: args.db,
    transaction: args.transaction,
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind: args.operationKind,
    operationId: args.operationId,
    requestSha256: args.requestSha256,
    receiptJson: stableStringify(args.receipt),
    commitId: null,
    createdAt: args.createdAt,
  });
}

function assertCurrentTransaction(transaction: SqliteTransactionRunner): void {
  if (!transaction.inTransaction()) {
    fail("evidence_artifact_mutation_requires_shared_transaction");
  }
}

let artifactMutationSavepointSequence = 0;

async function withArtifactMutationSavepoint<T>(
  db: SqliteDatabase,
  transaction: SqliteTransactionRunner,
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  assertCurrentTransaction(transaction);
  artifactMutationSavepointSequence += 1;
  const savepoint =
    `evidence_artifact_${label}_${String(artifactMutationSavepointSequence)}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const value = await fn();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return value;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // Preserve the domain/authority failure. If SQLite could not restore the
      // local savepoint, the owning Runtime transaction still owns rollback.
    }
    throw error;
  }
}

function getUpload(
  db: SqliteDatabase,
  args: { tenantId: string; scope: string; uploadId: string },
): UploadRow | null {
  return (
    db.prepare(
      `SELECT tenant_id, scope, upload_id, episode_id, kind,
              declared_sha256, declared_byte_length, media_type, encoding,
              redaction_policy, retention_policy, retention_until,
              start_operation_id, start_request_sha256, status,
              next_sequence, next_byte_offset, terminal_operation_id,
              terminal_request_sha256, finalized_artifact_id,
              finalize_receipt_sha256, terminal_reason, expires_at,
              created_at, updated_at, terminal_at, row_version
       FROM lite_runtime_evidence_uploads
       WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
    ).get(
      args.tenantId,
      args.scope,
      args.uploadId,
    ) as UploadRow | undefined
  ) ?? null;
}

function getArtifact(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    scope: string;
    artifactId: string;
    episodeId?: string;
  },
): ArtifactRow | null {
  const row = db.prepare(
    `SELECT tenant_id, scope, artifact_id, episode_id, kind, sha256,
            storage_ref, byte_length, media_type, encoding,
            redaction_policy, retention_policy, retention_until,
            ingest_mode, source_upload_id, artifact_ref_sha256, created_at
     FROM lite_runtime_evidence_artifacts
     WHERE tenant_id = ? AND scope = ? AND artifact_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    args.artifactId,
  ) as ArtifactRow | undefined;
  if (!row) return null;
  if (args.episodeId !== undefined && row.episode_id !== args.episodeId) {
    return null;
  }
  return row;
}

function insertOrVerifyBlob(args: {
  db: SqliteDatabase;
  tenantId: string;
  sha256: string;
  bytes: Buffer;
  createdAt: string;
}): void {
  const existing = args.db.prepare(
    `SELECT byte_length, content_bytes
     FROM lite_runtime_evidence_blobs
     WHERE tenant_id = ? AND blob_sha256 = ?`,
  ).get(args.tenantId, args.sha256) as {
    byte_length: number;
    content_bytes: Uint8Array;
  } | undefined;
  if (existing) {
    const existingBytes = Buffer.from(existing.content_bytes);
    if (
      existing.byte_length !== args.bytes.byteLength
      || sha256Bytes(existingBytes) !== args.sha256
      || !existingBytes.equals(args.bytes)
    ) {
      fail("evidence_artifact_blob_collision_or_corruption");
    }
    return;
  }
  args.db.prepare(
    `INSERT INTO lite_runtime_evidence_blobs
       (tenant_id, blob_sha256, byte_length, content_bytes, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    args.tenantId,
    args.sha256,
    args.bytes.byteLength,
    args.bytes,
    args.createdAt,
  );
}

function insertOrVerifyArtifact(args: {
  db: SqliteDatabase;
  tenantId: string;
  scope: string;
  episodeId: string;
  kind: EvidenceArtifactKindV1;
  sha256: string;
  byteLength: number;
  mediaType: string;
  encoding: string;
  redactionPolicy: string;
  retentionPolicy: string;
  retentionUntil: string | null;
  ingestMode: "bounded_inline_base64" | "finalized_runtime_upload";
  sourceUploadId: string | null;
  createdAt: string;
}): EvidenceArtifactRefV1 {
  const artifactId = exactArtifactId({
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.episodeId,
    kind: args.kind,
    sha256: args.sha256,
    byteLength: args.byteLength,
    mediaType: args.mediaType,
    encoding: args.encoding,
    redactionPolicy: args.redactionPolicy,
    retentionPolicy: args.retentionPolicy,
    retentionUntil: args.retentionUntil,
    sourceUploadId: args.sourceUploadId,
  });
  const reference = EvidenceArtifactRefV1Schema.parse({
    contract_version: "evidence_artifact_ref_v1",
    artifact_id: artifactId,
    kind: args.kind,
    sha256: args.sha256,
    storage_ref: `sqlite-cas://sha256/${args.sha256}`,
    byte_length: args.byteLength,
    media_type: args.mediaType,
    encoding: args.encoding,
    redaction_policy: args.redactionPolicy,
    retention_policy: args.retentionPolicy,
  });
  const referenceSha256 = evidenceArtifactRefDigest(reference);
  const existing = getArtifact(args.db, {
    tenantId: args.tenantId,
    scope: args.scope,
    artifactId,
    episodeId: args.episodeId,
  });
  if (existing) {
    if (
      evidenceArtifactRefDigest(artifactRefFromRow(existing)) !== referenceSha256
      || existing.retention_until !== args.retentionUntil
      || existing.ingest_mode !== args.ingestMode
      || existing.source_upload_id !== args.sourceUploadId
      || existing.artifact_ref_sha256 !== referenceSha256
    ) {
      fail("evidence_artifact_identity_conflict");
    }
    return reference;
  }
  args.db.prepare(
    `INSERT INTO lite_runtime_evidence_artifacts
       (tenant_id, scope, artifact_id, episode_id, kind, sha256,
        storage_ref, byte_length, media_type, encoding, redaction_policy,
        retention_policy, retention_until, ingest_mode, source_upload_id,
        artifact_ref_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.tenantId,
    args.scope,
    artifactId,
    args.episodeId,
    args.kind,
    args.sha256,
    reference.storage_ref,
    args.byteLength,
    args.mediaType,
    args.encoding,
    args.redactionPolicy,
    args.retentionPolicy,
    args.retentionUntil,
    args.ingestMode,
    args.sourceUploadId,
    referenceSha256,
    args.createdAt,
  );
  return reference;
}

function parseLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CLEANUP_BATCH) {
    fail("evidence_artifact_cleanup_limit_invalid");
  }
  return limit;
}

function cleanupCandidates(
  db: SqliteDatabase,
  args: {
    asOf: string;
    limit: number;
    tenantId?: string;
    scope?: string;
  },
): LiteEvidenceArtifactOrphanUploadCandidateV1[] {
  const whereTenant = args.tenantId === undefined
    ? ""
    : " AND upload.tenant_id = ? AND upload.scope = ?";
  const params = args.tenantId === undefined
    ? [args.asOf, args.limit]
    : [args.asOf, args.tenantId, args.scope, args.limit];
  const rows = db.prepare(
    `SELECT upload.tenant_id, upload.scope, upload.upload_id,
            upload.episode_id, upload.expires_at,
            count(chunk.sequence) AS chunk_count,
            COALESCE(sum(chunk.byte_length), 0) AS byte_length
     FROM lite_runtime_evidence_uploads AS upload
     LEFT JOIN lite_runtime_evidence_upload_chunks AS chunk
       ON chunk.tenant_id = upload.tenant_id
      AND chunk.scope = upload.scope
      AND chunk.upload_id = upload.upload_id
     WHERE upload.status = 'open'
       AND upload.expires_at <= ?${whereTenant}
     GROUP BY upload.tenant_id, upload.scope, upload.upload_id
     ORDER BY upload.expires_at, upload.tenant_id, upload.scope,
              upload.upload_id
     LIMIT ?`,
  ).all(...params) as LiteEvidenceArtifactOrphanUploadCandidateV1[];
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    scope: row.scope,
    upload_id: row.upload_id,
    episode_id: row.episode_id,
    expires_at: row.expires_at,
    chunk_count: Number(row.chunk_count),
    byte_length: Number(row.byte_length),
  }));
}

function artifactIdentityKey(
  tenantId: string,
  scope: string,
  artifactId: string,
): string {
  return `${tenantId}\u0000${scope}\u0000${artifactId}`;
}

function artifactDisplayIdentity(
  tenantId: string,
  scope: string,
  artifactId: string,
): string {
  return `${tenantId}:${scope}:${artifactId}`;
}

function collectArtifactIdsFromReceipt(
  value: unknown,
  out: Set<string>,
  depth = 0,
): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIdsFromReceipt(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    record.contract_version === "evidence_artifact_ref_v1"
    && typeof record.artifact_id === "string"
  ) {
    out.add(record.artifact_id);
  }
  for (const nested of Object.values(record)) {
    collectArtifactIdsFromReceipt(nested, out, depth + 1);
  }
}

/**
 * Synchronous, read-only integrity inspection for Runtime data operations and
 * already-open read snapshots. It never begins a transaction or mutates the
 * supplied connection; callers decide how the snapshot is serialized.
 */
export function inspectLiteEvidenceArtifactIntegrity(
  db: SqliteDatabase,
  options: { asOf?: string } = {},
): LiteEvidenceArtifactIntegrityReportV1 {
  const asOf = options.asOf ?? canonicalNow();
  assertCanonicalTimestamp(
    asOf,
    "evidence_artifact_integrity_as_of_invalid",
  );
  const problems: string[] = [];
  const warnings: string[] = [];
  const blobs = db.prepare(
    `SELECT tenant_id, blob_sha256, byte_length, content_bytes
     FROM lite_runtime_evidence_blobs
     ORDER BY tenant_id, blob_sha256`,
  ).all() as Array<{
    tenant_id: string;
    blob_sha256: string;
    byte_length: number;
    content_bytes: Uint8Array;
  }>;
  for (const blob of blobs) {
    const bytes = Buffer.from(blob.content_bytes);
    if (
      bytes.byteLength !== blob.byte_length
      || sha256Bytes(bytes) !== blob.blob_sha256
    ) {
      problems.push(`blob_integrity:${blob.tenant_id}:${blob.blob_sha256}`);
    }
  }

  const artifacts = db.prepare(
    `SELECT tenant_id, scope, artifact_id, episode_id, kind, sha256,
            storage_ref, byte_length, media_type, encoding,
            redaction_policy, retention_policy, retention_until,
            ingest_mode, source_upload_id, artifact_ref_sha256, created_at
     FROM lite_runtime_evidence_artifacts
     ORDER BY tenant_id, scope, artifact_id`,
  ).all() as ArtifactRow[];
  for (const artifact of artifacts) {
    try {
      const reference = artifactRefFromRow(artifact);
      const blob = db.prepare(
        `SELECT byte_length
         FROM lite_runtime_evidence_blobs
         WHERE tenant_id = ? AND blob_sha256 = ?`,
      ).get(
        artifact.tenant_id,
        artifact.sha256,
      ) as { byte_length: number } | undefined;
      if (
        !blob
        || blob.byte_length !== artifact.byte_length
        || artifact.storage_ref !== `sqlite-cas://sha256/${artifact.sha256}`
        || evidenceArtifactRefDigest(reference) !== artifact.artifact_ref_sha256
      ) {
        problems.push(
          `artifact_integrity:${artifact.tenant_id}:${artifact.scope}:${artifact.artifact_id}`,
        );
      }
    } catch {
      problems.push(
        `artifact_contract:${artifact.tenant_id}:${artifact.scope}:${artifact.artifact_id}`,
      );
    }
  }

  const referencedArtifactKeys = new Set<string>();
  const structuralReferences = db.prepare(
    `SELECT tenant_id, scope, artifact_id
     FROM lite_execution_state_snapshots
     UNION
     SELECT tenant_id, scope, task_envelope_artifact_id AS artifact_id
     FROM lite_execution_episodes
     UNION
     SELECT tenant_id, scope, verifier_input_artifact_id AS artifact_id
     FROM lite_execution_verifier_invocations
     UNION
     SELECT tenant_id, scope, verifier_input_artifact_id AS artifact_id
     FROM lite_execution_verifier_receipts
     UNION
     SELECT tenant_id, scope, verifier_output_artifact_id AS artifact_id
     FROM lite_execution_verifier_receipts
     UNION
     SELECT tenant_id, scope, artifact_id
     FROM lite_execution_event_artifact_refs
     UNION
     SELECT tenant_id, scope, finalized_artifact_id AS artifact_id
     FROM lite_runtime_evidence_uploads
     WHERE status = 'finalized' AND finalized_artifact_id IS NOT NULL`,
  ).all() as Array<{
    tenant_id: string;
    scope: string;
    artifact_id: string;
  }>;
  for (const reference of structuralReferences) {
    referencedArtifactKeys.add(artifactIdentityKey(
      reference.tenant_id,
      reference.scope,
      reference.artifact_id,
    ));
  }
  const operationReceipts = db.prepare(
    `SELECT tenant_id, scope, receipt_json
     FROM lite_runtime_write_operations
     ORDER BY tenant_id, scope, operation_kind, operation_id`,
  ).all() as Array<{
    tenant_id: string;
    scope: string;
    receipt_json: string;
  }>;
  for (const operation of operationReceipts) {
    try {
      const artifactIds = new Set<string>();
      collectArtifactIdsFromReceipt(
        JSON.parse(operation.receipt_json) as unknown,
        artifactIds,
      );
      for (const artifactId of artifactIds) {
        referencedArtifactKeys.add(artifactIdentityKey(
          operation.tenant_id,
          operation.scope,
          artifactId,
        ));
      }
    } catch {
      // Commit-authority integrity reports malformed operation receipts. They
      // cannot grant artifact retention authority here.
    }
  }
  const unreferencedArtifacts = artifacts
    .filter((artifact) => !referencedArtifactKeys.has(artifactIdentityKey(
      artifact.tenant_id,
      artifact.scope,
      artifact.artifact_id,
    )))
    .map((artifact) => artifactDisplayIdentity(
      artifact.tenant_id,
      artifact.scope,
      artifact.artifact_id,
    ));
  const referencedBlobKeys = new Set(
    artifacts.map((artifact) => `${artifact.tenant_id}\u0000${artifact.sha256}`),
  );
  const unreferencedBlobs = blobs
    .filter((blob) => !referencedBlobKeys.has(
      `${blob.tenant_id}\u0000${blob.blob_sha256}`,
    ))
    .map((blob) => `${blob.tenant_id}:${blob.blob_sha256}`);
  const retentionExpiredReferencedArtifacts = artifacts
    .filter((artifact) =>
      artifact.retention_until !== null
      && artifact.retention_until <= asOf
      && referencedArtifactKeys.has(artifactIdentityKey(
        artifact.tenant_id,
        artifact.scope,
        artifact.artifact_id,
      ))
    )
    .map((artifact) => artifactDisplayIdentity(
      artifact.tenant_id,
      artifact.scope,
      artifact.artifact_id,
    ));
  for (const identity of unreferencedArtifacts) {
    warnings.push(`artifact_gc_unreferenced:${identity}`);
  }
  for (const identity of unreferencedBlobs) {
    warnings.push(`blob_gc_unreferenced:${identity}`);
  }
  for (const identity of retentionExpiredReferencedArtifacts) {
    warnings.push(`artifact_retention_expired_but_referenced:${identity}`);
  }

  const uploads = db.prepare(
    `SELECT tenant_id, scope, upload_id, episode_id, kind,
            declared_sha256, declared_byte_length, media_type, encoding,
            redaction_policy, retention_policy, retention_until,
            start_operation_id, start_request_sha256, status,
            next_sequence, next_byte_offset, terminal_operation_id,
            terminal_request_sha256, finalized_artifact_id,
            finalize_receipt_sha256, terminal_reason, expires_at,
            created_at, updated_at, terminal_at, row_version
     FROM lite_runtime_evidence_uploads
     ORDER BY tenant_id, scope, upload_id`,
  ).all() as UploadRow[];
  const chunks = db.prepare(
    `SELECT tenant_id, scope, upload_id, sequence, byte_offset,
            byte_length, chunk_sha256, chunk_bytes,
            operation_id, request_sha256
     FROM lite_runtime_evidence_upload_chunks
     ORDER BY tenant_id, scope, upload_id, sequence`,
  ).all() as Array<ChunkRow & {
    tenant_id: string;
    scope: string;
    upload_id: string;
  }>;
  const chunkGroups = new Map<string, typeof chunks>();
  for (const chunk of chunks) {
    const key = `${chunk.tenant_id}\u0000${chunk.scope}\u0000${chunk.upload_id}`;
    const group = chunkGroups.get(key) ?? [];
    group.push(chunk);
    chunkGroups.set(key, group);
  }

  for (const upload of uploads) {
    const key = `${upload.tenant_id}\u0000${upload.scope}\u0000${upload.upload_id}`;
    const group = chunkGroups.get(key) ?? [];
    const startRequestSha256 = canonicalDigest({
      contract: "artifact_upload_start_request_v1",
      tenant_id: upload.tenant_id,
      scope: upload.scope,
      episode_id: upload.episode_id,
      operation_id: upload.start_operation_id,
      kind: upload.kind,
      declared_sha256: upload.declared_sha256,
      declared_byte_length: upload.declared_byte_length,
      media_type: upload.media_type,
      encoding: upload.encoding,
      redaction_policy: upload.redaction_policy,
      retention_policy: upload.retention_policy,
      retention_until: upload.retention_until,
    });
    const startReceipt = operationBinding(db, {
      tenantId: upload.tenant_id,
      scope: upload.scope,
      operationKind: OPERATION_KIND.uploadStart,
      operationId: upload.start_operation_id,
      requestSha256: startRequestSha256,
    });
    if (
      upload.start_request_sha256 !== startRequestSha256
      || startReceipt?.contract_version !== "artifact_upload_start_receipt_v1"
      || startReceipt.upload_id !== upload.upload_id
      || startReceipt.episode_id !== upload.episode_id
      || startReceipt.expires_at !== upload.expires_at
    ) {
      problems.push(
        `upload_start_operation:${upload.tenant_id}:${upload.scope}:${upload.upload_id}`,
      );
    }

    let offset = 0;
    let validChunks = true;
    for (let index = 0; index < group.length; index += 1) {
      const chunk = group[index]!;
      const bytes = Buffer.from(chunk.chunk_bytes);
      const chunkRequestSha256 = canonicalDigest({
        contract: "artifact_upload_chunk_request_v1",
        tenant_id: upload.tenant_id,
        scope: upload.scope,
        operation_id: chunk.operation_id,
        upload_id: upload.upload_id,
        sequence: chunk.sequence,
        byte_offset: chunk.byte_offset,
        data_base64: bytes.toString("base64"),
        chunk_sha256: chunk.chunk_sha256,
      });
      const chunkReceipt = operationBinding(db, {
        tenantId: upload.tenant_id,
        scope: upload.scope,
        operationKind: OPERATION_KIND.uploadChunk,
        operationId: chunk.operation_id,
        requestSha256: chunkRequestSha256,
      });
      if (
        chunk.sequence !== index
        || chunk.byte_offset !== offset
        || chunk.byte_length !== bytes.byteLength
        || sha256Bytes(bytes) !== chunk.chunk_sha256
        || chunk.request_sha256 !== chunkRequestSha256
        || chunkReceipt?.contract_version !== "artifact_upload_chunk_receipt_v1"
        || chunkReceipt.upload_id !== upload.upload_id
        || chunkReceipt.sequence !== chunk.sequence
        || chunkReceipt.byte_offset !== chunk.byte_offset
        || chunkReceipt.byte_length !== chunk.byte_length
      ) {
        validChunks = false;
        break;
      }
      offset += bytes.byteLength;
    }
    if (
      !validChunks
      || (
        upload.status === "open"
        && (
          group.length !== upload.next_sequence
          || offset !== upload.next_byte_offset
        )
      )
      || (upload.status !== "open" && group.length !== 0)
    ) {
      problems.push(
        `upload_integrity:${upload.tenant_id}:${upload.scope}:${upload.upload_id}`,
      );
    }

    if (upload.status === "finalized") {
      const artifact = upload.finalized_artifact_id
        ? getArtifact(db, {
          tenantId: upload.tenant_id,
          scope: upload.scope,
          artifactId: upload.finalized_artifact_id,
          episodeId: upload.episode_id,
        })
        : null;
      if (
        !artifact
        || artifact.source_upload_id !== upload.upload_id
        || artifact.sha256 !== upload.declared_sha256
        || artifact.byte_length !== upload.declared_byte_length
      ) {
        problems.push(
          `finalized_upload_artifact:${upload.tenant_id}:${upload.scope}:${upload.upload_id}`,
        );
      }
      const terminalOperationId = upload.terminal_operation_id;
      const terminalRequestSha256 = terminalOperationId
        ? canonicalDigest({
          contract: "artifact_upload_finalize_request_v1",
          tenant_id: upload.tenant_id,
          scope: upload.scope,
          operation_id: terminalOperationId,
          upload_id: upload.upload_id,
          expected_chunk_count: upload.next_sequence,
          declared_sha256: upload.declared_sha256,
          declared_byte_length: upload.declared_byte_length,
        })
        : null;
      const terminalReceipt =
        terminalOperationId && terminalRequestSha256
          ? operationBinding(db, {
            tenantId: upload.tenant_id,
            scope: upload.scope,
            operationKind: OPERATION_KIND.uploadFinalize,
            operationId: terminalOperationId,
            requestSha256: terminalRequestSha256,
          })
          : null;
      const terminalArtifactRef = terminalReceipt?.artifact_ref;
      if (
        terminalRequestSha256 === null
        || upload.terminal_request_sha256 !== terminalRequestSha256
        || terminalReceipt?.contract_version
          !== "artifact_upload_finalize_receipt_v1"
        || terminalReceipt.upload_id !== upload.upload_id
        || terminalReceipt.finalize_receipt_digest
          !== upload.finalize_receipt_sha256
        || !terminalArtifactRef
        || typeof terminalArtifactRef !== "object"
        || Array.isArray(terminalArtifactRef)
        || (terminalArtifactRef as Record<string, unknown>).artifact_id
          !== upload.finalized_artifact_id
      ) {
        problems.push(
          `upload_finalize_operation:${upload.tenant_id}:${upload.scope}:${upload.upload_id}`,
        );
      }
    } else if (upload.status === "aborted") {
      const terminalOperationId = upload.terminal_operation_id;
      const terminalRequestSha256 =
        terminalOperationId && upload.terminal_reason
          ? canonicalDigest({
            contract: "artifact_upload_abort_request_v1",
            tenant_id: upload.tenant_id,
            scope: upload.scope,
            operation_id: terminalOperationId,
            upload_id: upload.upload_id,
            reason: upload.terminal_reason,
          })
          : null;
      const terminalReceipt =
        terminalOperationId && terminalRequestSha256
          ? operationBinding(db, {
            tenantId: upload.tenant_id,
            scope: upload.scope,
            operationKind: OPERATION_KIND.uploadAbort,
            operationId: terminalOperationId,
            requestSha256: terminalRequestSha256,
          })
          : null;
      if (
        terminalRequestSha256 === null
        || upload.terminal_request_sha256 !== terminalRequestSha256
        || terminalReceipt?.contract_version !== "artifact_upload_abort_receipt_v1"
        || terminalReceipt.upload_id !== upload.upload_id
        || terminalReceipt.reason !== upload.terminal_reason
      ) {
        problems.push(
          `upload_abort_operation:${upload.tenant_id}:${upload.scope}:${upload.upload_id}`,
        );
      }
    } else if (upload.status === "expired") {
      const cleanupRows = db.prepare(
        `SELECT operation_id, request_sha256, receipt_json
         FROM lite_runtime_write_operations
         WHERE tenant_id = ? AND scope = ? AND operation_kind = ?`,
      ).all(
        upload.tenant_id,
        upload.scope,
        OPERATION_KIND.orphanCleanup,
      ) as Array<{
        operation_id: string;
        request_sha256: string;
        receipt_json: string;
      }>;
      let matchedCleanup = false;
      for (const cleanupRow of cleanupRows) {
        try {
          const receipt = JSON.parse(cleanupRow.receipt_json) as {
            contract_version?: unknown;
            as_of?: unknown;
            request_limit?: unknown;
            expired_uploads?: unknown;
          };
          if (
            receipt.contract_version !== "artifact_orphan_cleanup_receipt_v1"
            || typeof receipt.as_of !== "string"
            || !Number.isSafeInteger(receipt.request_limit)
            || Number(receipt.request_limit) < 1
            || !Array.isArray(receipt.expired_uploads)
            || !receipt.expired_uploads.some((candidate) =>
              candidate
              && typeof candidate === "object"
              && !Array.isArray(candidate)
              && (candidate as Record<string, unknown>).upload_id
                === upload.upload_id
            )
          ) {
            continue;
          }
          const cleanupRequestSha256 = canonicalDigest({
            contract: "artifact_orphan_cleanup_request_v1",
            tenant_id: upload.tenant_id,
            scope: upload.scope,
            operation_id: cleanupRow.operation_id,
            as_of: receipt.as_of,
            limit: receipt.request_limit,
          });
          if (cleanupRow.request_sha256 !== cleanupRequestSha256) continue;
          const expectedTerminalOperationId = exactCleanupTerminalOperationId(
            cleanupRow.operation_id,
            upload.upload_id,
          );
          const expectedTerminalRequestSha256 = canonicalDigest({
            contract: "artifact_upload_expiry_request_v1",
            cleanup_operation_id: cleanupRow.operation_id,
            upload_id: upload.upload_id,
            as_of: receipt.as_of,
          });
          if (
            upload.terminal_operation_id === expectedTerminalOperationId
            && upload.terminal_request_sha256 === expectedTerminalRequestSha256
          ) {
            matchedCleanup = true;
            break;
          }
        } catch {
          // A malformed operation is not a valid expiry binding.
        }
      }
      if (!matchedCleanup) {
        problems.push(
          `upload_expiry_operation:${upload.tenant_id}:${upload.scope}:${upload.upload_id}`,
        );
      }
    }
  }

  const foreignKeyProblems = (
    db.prepare("PRAGMA foreign_key_check").all()
  ) as Array<{ table: string; rowid: number | null; parent: string }>;
  for (const problem of foreignKeyProblems) {
    problems.push(
      `foreign_key:${problem.table}:${String(problem.rowid)}:${problem.parent}`,
    );
  }
  return Object.freeze({
    contract_version: "lite_evidence_artifact_integrity_v1",
    ok: problems.length === 0,
    counts: Object.freeze({
      blobs: blobs.length,
      artifacts: artifacts.length,
      uploads: uploads.length,
      chunks: chunks.length,
      unreferenced_artifacts: unreferencedArtifacts.length,
      unreferenced_blobs: unreferencedBlobs.length,
      retention_expired_referenced_artifacts:
        retentionExpiredReferencedArtifacts.length,
    }),
    garbage_collection: Object.freeze({
      mode: "report_only_fail_closed_v1",
      apply_supported: false,
      deletion_blocked:
        unreferencedArtifacts.length > 0
        || unreferencedBlobs.length > 0
        || retentionExpiredReferencedArtifacts.length > 0,
      unreferenced_artifacts: Object.freeze(unreferencedArtifacts),
      unreferenced_blobs: Object.freeze(unreferencedBlobs),
      retention_expired_referenced_artifacts: Object.freeze(
        retentionExpiredReferencedArtifacts,
      ),
    }),
    problems: Object.freeze(problems),
    warnings: Object.freeze(warnings),
  });
}

export function createLiteEvidenceArtifactStore(
  database: LiteRuntimeDatabase,
  options: { uploadTtlMs?: number } = {},
): LiteEvidenceArtifactStore {
  const { db, transaction } = database;
  const uploadTtlMs = options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS;
  if (
    !Number.isSafeInteger(uploadTtlMs)
    || uploadTtlMs < 1
    || uploadTtlMs > MAX_UPLOAD_TTL_MS
  ) {
    fail("evidence_artifact_upload_ttl_invalid");
  }

  const access: LiteEvidenceArtifactStore = {
    transactionRunner(): SqliteTransactionRunner {
      return transaction;
    },

    async materializeInputInCurrentTransaction(
      args,
    ): Promise<EvidenceArtifactRefV1> {
      assertCurrentTransaction(transaction);
      return await withArtifactMutationSavepoint(
        db,
        transaction,
        "materialize",
        async () => {
      assertIdentity(args);
      assertPolicies(args);
      const artifact = EvidenceArtifactInputV1Schema.parse(args.artifact);
      if (artifact.ingest.mode === "bounded_inline_base64") {
        const receipt = await access.ingestInlineInCurrentTransaction({
          ...args,
          artifact,
        });
        return receipt.artifact_ref;
      }
      const requestSha256 = canonicalDigest({
        contract: "artifact_input_materialize_request_v1",
        tenant_id: args.tenantId,
        scope: args.scope,
        episode_id: args.episodeId,
        operation_id: args.operationId,
        artifact,
        redaction_policy: args.redactionPolicy,
        retention_policy: args.retentionPolicy,
        retention_until: args.retentionUntil ?? null,
      });
      const replay = replayReceipt<{
        contract_version: "artifact_input_materialize_receipt_v1";
        artifact_ref: EvidenceArtifactRefV1;
      }>({
        db,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.inputMaterialize,
        operationId: args.operationId,
        requestSha256,
      });
      if (replay) {
        const persisted = getArtifact(db, {
          tenantId: args.tenantId,
          scope: args.scope,
          episodeId: args.episodeId,
          artifactId: replay.artifact_ref.artifact_id,
        });
        if (!persisted) {
          fail("evidence_artifact_operation_replay_target_missing");
        }
        const persistedRef = verifiedArtifactRefFromRow(db, persisted);
        if (
          evidenceArtifactRefDigest(persistedRef)
            !== evidenceArtifactRefDigest(replay.artifact_ref)
        ) {
          fail("evidence_artifact_operation_replay_target_missing");
        }
        return persistedRef;
      }
      const upload = getUpload(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        uploadId: artifact.ingest.upload_id,
      });
      if (!upload) fail("evidence_artifact_upload_not_found");
      if (upload.status !== "finalized") {
        fail("evidence_artifact_upload_not_finalized");
      }
      if (upload.episode_id !== args.episodeId) {
        fail("evidence_artifact_upload_episode_conflict");
      }
      if (
        upload.kind !== artifact.kind
        || upload.declared_sha256 !== artifact.declared_sha256
        || upload.declared_byte_length !== artifact.declared_byte_length
        || upload.media_type !== artifact.media_type
        || upload.encoding !== artifact.encoding
        || upload.redaction_policy !== args.redactionPolicy
        || upload.retention_policy !== args.retentionPolicy
        || upload.retention_until !== (args.retentionUntil ?? null)
      ) {
        fail("evidence_artifact_upload_materialization_conflict");
      }
      if (
        upload.finalize_receipt_sha256
          !== artifact.ingest.finalize_receipt_digest
      ) {
        fail("evidence_artifact_upload_finalize_receipt_mismatch");
      }
      if (!upload.finalized_artifact_id) {
        fail("evidence_artifact_finalized_artifact_missing");
      }
      const persisted = getArtifact(db, {
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: args.episodeId,
        artifactId: upload.finalized_artifact_id,
      });
      if (
        !persisted
        || persisted.source_upload_id !== upload.upload_id
        || persisted.sha256 !== upload.declared_sha256
      ) {
        fail("evidence_artifact_finalized_artifact_missing");
      }
      const artifactRef = verifiedArtifactRefFromRow(db, persisted);
      const receipt = Object.freeze({
        contract_version: "artifact_input_materialize_receipt_v1" as const,
        artifact_ref: artifactRef,
      });
      const createdAt = canonicalNow();
      recordOperation({
        db,
        transaction,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.inputMaterialize,
        operationId: args.operationId,
        requestSha256,
        receipt,
        createdAt,
      });
      return artifactRef;
        },
      );
    },

    async ingestInlineInCurrentTransaction(
      args,
    ): Promise<LiteEvidenceArtifactInlineIngestReceiptV1> {
      assertCurrentTransaction(transaction);
      return await withArtifactMutationSavepoint(
        db,
        transaction,
        "inline_ingest",
        async () => {
      assertIdentity(args);
      assertPolicies(args);
      const artifact = EvidenceArtifactInputV1Schema.parse(args.artifact);
      if (artifact.ingest.mode !== "bounded_inline_base64") {
        fail("evidence_artifact_inline_ingest_mode_required");
      }
      const requestSha256 = canonicalDigest({
        contract: "artifact_inline_ingest_request_v1",
        tenant_id: args.tenantId,
        scope: args.scope,
        episode_id: args.episodeId,
        operation_id: args.operationId,
        artifact,
        redaction_policy: args.redactionPolicy,
        retention_policy: args.retentionPolicy,
        retention_until: args.retentionUntil ?? null,
      });
      const replay = replayReceipt<LiteEvidenceArtifactInlineIngestReceiptV1>({
        db,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.inlineIngest,
        operationId: args.operationId,
        requestSha256,
      });
      if (replay) {
        const persisted = getArtifact(db, {
          tenantId: args.tenantId,
          scope: args.scope,
          artifactId: replay.artifact_ref.artifact_id,
          episodeId: args.episodeId,
        });
        if (!persisted) {
          fail("evidence_artifact_operation_replay_target_missing");
        }
        const persistedRef = verifiedArtifactRefFromRow(db, persisted);
        if (
          evidenceArtifactRefDigest(persistedRef)
            !== evidenceArtifactRefDigest(replay.artifact_ref)
        ) {
          fail("evidence_artifact_operation_replay_target_missing");
        }
        return Object.freeze({
          ...replay,
          artifact_ref: persistedRef,
        });
      }
      const bytes = decodeCanonicalBase64(
        artifact.ingest.data,
        "evidence_artifact_inline_base64_invalid",
      );
      const createdAt = canonicalNow();
      insertOrVerifyBlob({
        db,
        tenantId: args.tenantId,
        sha256: artifact.declared_sha256,
        bytes,
        createdAt,
      });
      const artifactRef = insertOrVerifyArtifact({
        db,
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: args.episodeId,
        kind: artifact.kind,
        sha256: artifact.declared_sha256,
        byteLength: artifact.declared_byte_length,
        mediaType: artifact.media_type,
        encoding: artifact.encoding,
        redactionPolicy: args.redactionPolicy,
        retentionPolicy: args.retentionPolicy,
        retentionUntil: args.retentionUntil ?? null,
        ingestMode: "bounded_inline_base64",
        sourceUploadId: null,
        createdAt,
      });
      const receipt: LiteEvidenceArtifactInlineIngestReceiptV1 = Object.freeze({
        contract_version: "artifact_inline_ingest_receipt_v1",
        artifact_ref: artifactRef,
      });
      recordOperation({
        db,
        transaction,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.inlineIngest,
        operationId: args.operationId,
        requestSha256,
        receipt,
        createdAt,
      });
      return receipt;
        },
      );
    },

    async startUploadInCurrentTransaction(
      args,
    ): Promise<LiteEvidenceArtifactUploadStartReceiptV1> {
      assertCurrentTransaction(transaction);
      return await withArtifactMutationSavepoint(
        db,
        transaction,
        "upload_start",
        async () => {
      assertIdentity(args);
      assertSha256(
        args.declaredSha256,
        "evidence_artifact_declared_sha256_invalid",
      );
      assertByteLength(
        args.declaredByteLength,
        "evidence_artifact_declared_byte_length_invalid",
      );
      assertExactString(
        args.mediaType,
        255,
        "evidence_artifact_media_type_invalid",
      );
      assertExactString(
        args.encoding,
        64,
        "evidence_artifact_encoding_invalid",
      );
      assertPolicies(args);
      const requestSha256 = canonicalDigest({
        contract: "artifact_upload_start_request_v1",
        tenant_id: args.tenantId,
        scope: args.scope,
        episode_id: args.episodeId,
        operation_id: args.operationId,
        kind: args.kind,
        declared_sha256: args.declaredSha256,
        declared_byte_length: args.declaredByteLength,
        media_type: args.mediaType,
        encoding: args.encoding,
        redaction_policy: args.redactionPolicy,
        retention_policy: args.retentionPolicy,
        retention_until: args.retentionUntil ?? null,
      });
      const replay = replayReceipt<LiteEvidenceArtifactUploadStartReceiptV1>({
        db,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.uploadStart,
        operationId: args.operationId,
        requestSha256,
      });
      if (replay) {
        const persisted = getUpload(db, {
          tenantId: args.tenantId,
          scope: args.scope,
          uploadId: replay.upload_id,
        });
        if (!persisted || persisted.start_request_sha256 !== requestSha256) {
          fail("evidence_artifact_operation_replay_target_missing");
        }
        return replay;
      }
      const createdAt = canonicalNow();
      const expiresAt = new Date(
        Date.parse(createdAt) + uploadTtlMs,
      ).toISOString();
      const uploadId = exactUploadId({
        tenantId: args.tenantId,
        scope: args.scope,
        operationId: args.operationId,
        requestSha256,
      });
      db.prepare(
        `INSERT INTO lite_runtime_evidence_uploads
           (tenant_id, scope, upload_id, episode_id, kind,
            declared_sha256, declared_byte_length, media_type, encoding,
            redaction_policy, retention_policy, retention_until,
            start_operation_id, start_request_sha256, status,
            next_sequence, next_byte_offset, terminal_operation_id,
            terminal_request_sha256, finalized_artifact_id,
            finalize_receipt_sha256, terminal_reason, expires_at,
            created_at, updated_at, terminal_at, row_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open',
                 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, 1)`,
      ).run(
        args.tenantId,
        args.scope,
        uploadId,
        args.episodeId,
        args.kind,
        args.declaredSha256,
        args.declaredByteLength,
        args.mediaType,
        args.encoding,
        args.redactionPolicy,
        args.retentionPolicy,
        args.retentionUntil ?? null,
        args.operationId,
        requestSha256,
        expiresAt,
        createdAt,
        createdAt,
      );
      const receipt: LiteEvidenceArtifactUploadStartReceiptV1 = Object.freeze({
        contract_version: "artifact_upload_start_receipt_v1",
        upload_id: uploadId,
        episode_id: args.episodeId,
        expires_at: expiresAt,
        max_chunk_bytes: MAX_UPLOAD_CHUNK_BYTES,
      });
      recordOperation({
        db,
        transaction,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.uploadStart,
        operationId: args.operationId,
        requestSha256,
        receipt,
        createdAt,
      });
      return receipt;
        },
      );
    },

    async appendUploadChunkInCurrentTransaction(
      args,
    ): Promise<LiteEvidenceArtifactUploadChunkReceiptV1> {
      assertCurrentTransaction(transaction);
      return await withArtifactMutationSavepoint(
        db,
        transaction,
        "upload_chunk",
        async () => {
      assertIdentity(args);
      if (!Number.isSafeInteger(args.sequence) || args.sequence < 0) {
        fail("evidence_artifact_upload_chunk_sequence_invalid");
      }
      if (!Number.isSafeInteger(args.byteOffset) || args.byteOffset < 0) {
        fail("evidence_artifact_upload_chunk_offset_invalid");
      }
      assertSha256(
        args.chunkSha256,
        "evidence_artifact_upload_chunk_sha256_invalid",
      );
      const bytes = decodeCanonicalBase64(
        args.dataBase64,
        "evidence_artifact_upload_chunk_base64_invalid",
      );
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_UPLOAD_CHUNK_BYTES) {
        fail("evidence_artifact_upload_chunk_size_invalid");
      }
      if (sha256Bytes(bytes) !== args.chunkSha256) {
        fail("evidence_artifact_upload_chunk_digest_mismatch");
      }
      const requestSha256 = canonicalDigest({
        contract: "artifact_upload_chunk_request_v1",
        tenant_id: args.tenantId,
        scope: args.scope,
        operation_id: args.operationId,
        upload_id: args.uploadId,
        sequence: args.sequence,
        byte_offset: args.byteOffset,
        data_base64: args.dataBase64,
        chunk_sha256: args.chunkSha256,
      });
      const replay = replayReceipt<LiteEvidenceArtifactUploadChunkReceiptV1>({
        db,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.uploadChunk,
        operationId: args.operationId,
        requestSha256,
      });
      if (replay) return replay;
      const upload = getUpload(db, args);
      if (!upload) fail("evidence_artifact_upload_not_found");
      if (upload.status !== "open") {
        fail("evidence_artifact_upload_not_open");
      }
      if (Date.now() >= Date.parse(upload.expires_at)) {
        fail("evidence_artifact_upload_expired");
      }
      if (
        args.sequence !== upload.next_sequence
        || args.byteOffset !== upload.next_byte_offset
      ) {
        fail("evidence_artifact_upload_chunk_not_next");
      }
      if (args.byteOffset + bytes.byteLength > upload.declared_byte_length) {
        fail("evidence_artifact_upload_chunk_exceeds_declared_length");
      }
      const sequenceConflict = db.prepare(
        `SELECT operation_id, request_sha256
         FROM lite_runtime_evidence_upload_chunks
         WHERE tenant_id = ? AND scope = ? AND upload_id = ? AND sequence = ?`,
      ).get(
        args.tenantId,
        args.scope,
        args.uploadId,
        args.sequence,
      ) as { operation_id: string; request_sha256: string } | undefined;
      if (sequenceConflict) {
        fail("evidence_artifact_upload_chunk_sequence_conflict");
      }
      const createdAt = canonicalNow();
      db.prepare(
        `INSERT INTO lite_runtime_evidence_upload_chunks
           (tenant_id, scope, upload_id, sequence, byte_offset, byte_length,
            chunk_sha256, chunk_bytes, operation_id, request_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        args.tenantId,
        args.scope,
        args.uploadId,
        args.sequence,
        args.byteOffset,
        bytes.byteLength,
        args.chunkSha256,
        bytes,
        args.operationId,
        requestSha256,
        createdAt,
      );
      const nextSequence = args.sequence + 1;
      const nextByteOffset = args.byteOffset + bytes.byteLength;
      db.prepare(
        `UPDATE lite_runtime_evidence_uploads
         SET next_sequence = ?,
             next_byte_offset = ?,
             updated_at = ?,
             row_version = row_version + 1
         WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
      ).run(
        nextSequence,
        nextByteOffset,
        createdAt,
        args.tenantId,
        args.scope,
        args.uploadId,
      );
      const receipt: LiteEvidenceArtifactUploadChunkReceiptV1 = Object.freeze({
        contract_version: "artifact_upload_chunk_receipt_v1",
        upload_id: args.uploadId,
        sequence: args.sequence,
        byte_offset: args.byteOffset,
        byte_length: bytes.byteLength,
        next_sequence: nextSequence,
        next_byte_offset: nextByteOffset,
      });
      recordOperation({
        db,
        transaction,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.uploadChunk,
        operationId: args.operationId,
        requestSha256,
        receipt,
        createdAt,
      });
      return receipt;
        },
      );
    },

    async finalizeUploadInCurrentTransaction(
      args,
    ): Promise<LiteEvidenceArtifactUploadFinalizeReceiptV1> {
      assertCurrentTransaction(transaction);
      return await withArtifactMutationSavepoint(
        db,
        transaction,
        "upload_finalize",
        async () => {
      assertIdentity(args);
      if (
        !Number.isSafeInteger(args.expectedChunkCount)
        || args.expectedChunkCount < 0
      ) {
        fail("evidence_artifact_upload_finalize_chunk_count_invalid");
      }
      assertSha256(
        args.declaredSha256,
        "evidence_artifact_declared_sha256_invalid",
      );
      assertByteLength(
        args.declaredByteLength,
        "evidence_artifact_declared_byte_length_invalid",
      );
      const requestSha256 = canonicalDigest({
        contract: "artifact_upload_finalize_request_v1",
        tenant_id: args.tenantId,
        scope: args.scope,
        operation_id: args.operationId,
        upload_id: args.uploadId,
        expected_chunk_count: args.expectedChunkCount,
        declared_sha256: args.declaredSha256,
        declared_byte_length: args.declaredByteLength,
      });
      const replay =
        replayReceipt<LiteEvidenceArtifactUploadFinalizeReceiptV1>({
          db,
          tenantId: args.tenantId,
          scope: args.scope,
          operationKind: OPERATION_KIND.uploadFinalize,
          operationId: args.operationId,
          requestSha256,
        });
      if (replay) {
        const replayUpload = getUpload(db, {
          tenantId: args.tenantId,
          scope: args.scope,
          uploadId: args.uploadId,
        });
        const persisted = getArtifact(db, {
          tenantId: args.tenantId,
          scope: args.scope,
          artifactId: replay.artifact_ref.artifact_id,
          episodeId: replayUpload?.episode_id,
        });
        if (
          !replayUpload
          || replayUpload.status !== "finalized"
          || replayUpload.finalized_artifact_id
            !== replay.artifact_ref.artifact_id
          || replayUpload.finalize_receipt_sha256
            !== replay.finalize_receipt_digest
          || !persisted
          || persisted.source_upload_id !== args.uploadId
        ) {
          fail("evidence_artifact_operation_replay_target_missing");
        }
        const persistedRef = verifiedArtifactRefFromRow(db, persisted);
        if (
          evidenceArtifactRefDigest(persistedRef)
            !== evidenceArtifactRefDigest(replay.artifact_ref)
        ) {
          fail("evidence_artifact_operation_replay_target_missing");
        }
        return Object.freeze({
          ...replay,
          artifact_ref: persistedRef,
        });
      }
      const upload = getUpload(db, args);
      if (!upload) fail("evidence_artifact_upload_not_found");
      if (upload.status !== "open") {
        fail("evidence_artifact_upload_not_open");
      }
      if (Date.now() >= Date.parse(upload.expires_at)) {
        fail("evidence_artifact_upload_expired");
      }
      if (
        upload.declared_sha256 !== args.declaredSha256
        || upload.declared_byte_length !== args.declaredByteLength
      ) {
        fail("evidence_artifact_upload_finalize_declaration_conflict");
      }
      if (upload.next_sequence !== args.expectedChunkCount) {
        fail("evidence_artifact_upload_finalize_chunk_count_mismatch");
      }
      if (upload.next_byte_offset !== args.declaredByteLength) {
        fail("evidence_artifact_upload_finalize_length_mismatch");
      }
      const chunks = db.prepare(
        `SELECT sequence, byte_offset, byte_length, chunk_sha256, chunk_bytes,
                operation_id, request_sha256
         FROM lite_runtime_evidence_upload_chunks
         WHERE tenant_id = ? AND scope = ? AND upload_id = ?
         ORDER BY sequence`,
      ).all(
        args.tenantId,
        args.scope,
        args.uploadId,
      ) as ChunkRow[];
      if (chunks.length !== args.expectedChunkCount) {
        fail("evidence_artifact_upload_finalize_chunk_count_mismatch");
      }
      let expectedOffset = 0;
      const buffers: Buffer[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const bytes = Buffer.from(chunk.chunk_bytes);
        if (
          chunk.sequence !== index
          || chunk.byte_offset !== expectedOffset
          || chunk.byte_length !== bytes.byteLength
          || sha256Bytes(bytes) !== chunk.chunk_sha256
        ) {
          fail("evidence_artifact_upload_chunk_integrity_failed");
        }
        expectedOffset += bytes.byteLength;
        buffers.push(bytes);
      }
      const bytes = Buffer.concat(buffers, expectedOffset);
      if (bytes.byteLength !== args.declaredByteLength) {
        fail("evidence_artifact_upload_finalize_length_mismatch");
      }
      if (sha256Bytes(bytes) !== args.declaredSha256) {
        fail("evidence_artifact_upload_finalize_digest_mismatch");
      }
      const createdAt = canonicalNow();
      insertOrVerifyBlob({
        db,
        tenantId: args.tenantId,
        sha256: args.declaredSha256,
        bytes,
        createdAt,
      });
      const artifactRef = insertOrVerifyArtifact({
        db,
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: upload.episode_id,
        kind: upload.kind,
        sha256: args.declaredSha256,
        byteLength: args.declaredByteLength,
        mediaType: upload.media_type,
        encoding: upload.encoding,
        redactionPolicy: upload.redaction_policy,
        retentionPolicy: upload.retention_policy,
        retentionUntil: upload.retention_until,
        ingestMode: "finalized_runtime_upload",
        sourceUploadId: args.uploadId,
        createdAt,
      });
      const finalizeReceiptPayload = Object.freeze({
        contract_version: "artifact_upload_finalize_receipt_payload_v1",
        upload_id: args.uploadId,
        artifact_ref: artifactRef,
      });
      const finalizeReceiptDigest = canonicalDigest(finalizeReceiptPayload);
      db.prepare(
        `UPDATE lite_runtime_evidence_uploads
         SET status = 'finalized',
             terminal_operation_id = ?,
             terminal_request_sha256 = ?,
             finalized_artifact_id = ?,
             finalize_receipt_sha256 = ?,
             terminal_reason = NULL,
             updated_at = ?,
             terminal_at = ?,
             row_version = row_version + 1
         WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
      ).run(
        args.operationId,
        requestSha256,
        artifactRef.artifact_id,
        finalizeReceiptDigest,
        createdAt,
        createdAt,
        args.tenantId,
        args.scope,
        args.uploadId,
      );
      db.prepare(
        `DELETE FROM lite_runtime_evidence_upload_chunks
         WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
      ).run(args.tenantId, args.scope, args.uploadId);
      const receipt: LiteEvidenceArtifactUploadFinalizeReceiptV1 =
        Object.freeze({
          contract_version: "artifact_upload_finalize_receipt_v1",
          upload_id: args.uploadId,
          artifact_ref: artifactRef,
          finalize_receipt_digest: finalizeReceiptDigest,
        });
      recordOperation({
        db,
        transaction,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.uploadFinalize,
        operationId: args.operationId,
        requestSha256,
        receipt,
        createdAt,
      });
      return receipt;
        },
      );
    },

    async abortUploadInCurrentTransaction(
      args,
    ): Promise<LiteEvidenceArtifactUploadAbortReceiptV1> {
      assertCurrentTransaction(transaction);
      return await withArtifactMutationSavepoint(
        db,
        transaction,
        "upload_abort",
        async () => {
      assertIdentity(args);
      assertExactString(args.reason, MAX_REASON_BYTES, "evidence_artifact_upload_abort_reason_invalid");
      const requestSha256 = canonicalDigest({
        contract: "artifact_upload_abort_request_v1",
        tenant_id: args.tenantId,
        scope: args.scope,
        operation_id: args.operationId,
        upload_id: args.uploadId,
        reason: args.reason,
      });
      const replay = replayReceipt<LiteEvidenceArtifactUploadAbortReceiptV1>({
        db,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.uploadAbort,
        operationId: args.operationId,
        requestSha256,
      });
      if (replay) return replay;
      const upload = getUpload(db, args);
      if (!upload) fail("evidence_artifact_upload_not_found");
      if (upload.status !== "open") {
        fail("evidence_artifact_upload_not_open");
      }
      const discardedChunkCount = upload.next_sequence;
      const discardedByteLength = upload.next_byte_offset;
      const terminalAt = canonicalNow();
      db.prepare(
        `UPDATE lite_runtime_evidence_uploads
         SET status = 'aborted',
             terminal_operation_id = ?,
             terminal_request_sha256 = ?,
             finalized_artifact_id = NULL,
             finalize_receipt_sha256 = NULL,
             terminal_reason = ?,
             updated_at = ?,
             terminal_at = ?,
             row_version = row_version + 1
         WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
      ).run(
        args.operationId,
        requestSha256,
        args.reason,
        terminalAt,
        terminalAt,
        args.tenantId,
        args.scope,
        args.uploadId,
      );
      db.prepare(
        `DELETE FROM lite_runtime_evidence_upload_chunks
         WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
      ).run(args.tenantId, args.scope, args.uploadId);
      const receipt: LiteEvidenceArtifactUploadAbortReceiptV1 = Object.freeze({
        contract_version: "artifact_upload_abort_receipt_v1",
        upload_id: args.uploadId,
        status: "aborted",
        reason: args.reason,
        discarded_chunk_count: discardedChunkCount,
        discarded_byte_length: discardedByteLength,
      });
      recordOperation({
        db,
        transaction,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.uploadAbort,
        operationId: args.operationId,
        requestSha256,
        receipt,
        createdAt: terminalAt,
      });
      return receipt;
        },
      );
    },

    async resolveArtifact(args): Promise<EvidenceArtifactRefV1 | null> {
      assertIdentity(args);
      assertExactString(
        args.episodeId,
        256,
        "evidence_artifact_episode_id_invalid",
      );
      assertExactString(
        args.artifactId,
        256,
        "evidence_artifact_id_invalid",
      );
      return await transaction.read(() => {
        const row = getArtifact(db, args);
        if (!row) return null;
        return verifiedArtifactRefFromRow(db, row);
      });
    },

    async readArtifactBytes(args): Promise<Buffer> {
      assertIdentity(args);
      assertExactString(
        args.episodeId,
        256,
        "evidence_artifact_episode_id_invalid",
      );
      assertExactString(
        args.artifactId,
        256,
        "evidence_artifact_id_invalid",
      );
      return await transaction.read(() => {
        const artifact = getArtifact(db, args);
        if (!artifact) fail("evidence_artifact_not_found");
        return Buffer.from(readVerifiedArtifactBytes(db, artifact));
      });
    },

    async inspectIntegrity(): Promise<LiteEvidenceArtifactIntegrityReportV1> {
      return await transaction.read(() =>
        inspectLiteEvidenceArtifactIntegrity(db)
      );
    },

    async collectExpiredOrphanUploads(
      args:
        | {
          mode: "dry_run";
          asOf?: string;
          limit?: number;
        }
        | {
          mode: "apply";
          tenantId: string;
          scope: string;
          operationId: string;
          asOf?: string;
          limit?: number;
        },
    ): Promise<
      | readonly LiteEvidenceArtifactOrphanUploadCandidateV1[]
      | LiteEvidenceArtifactOrphanCleanupReceiptV1
    > {
      let asOf = args.asOf;
      if (args.mode === "apply" && asOf === undefined) {
        assertIdentity(args);
        const prior = operationRow(db, {
          tenantId: args.tenantId,
          scope: args.scope,
          operationKind: OPERATION_KIND.orphanCleanup,
          operationId: args.operationId,
        });
        if (prior) {
          try {
            const receipt = JSON.parse(prior.receipt_json) as {
              contract_version?: unknown;
              as_of?: unknown;
            };
            if (
              receipt.contract_version
                !== "artifact_orphan_cleanup_receipt_v1"
              || typeof receipt.as_of !== "string"
            ) {
              fail("evidence_artifact_operation_receipt_corrupt");
            }
            asOf = receipt.as_of;
          } catch (error) {
            if (error instanceof LiteEvidenceArtifactStoreError) throw error;
            fail("evidence_artifact_operation_receipt_corrupt");
          }
        }
      }
      asOf ??= canonicalNow();
      assertCanonicalTimestamp(
        asOf,
        "evidence_artifact_cleanup_as_of_invalid",
      );
      const limit = parseLimit(args.limit);
      if (args.mode === "dry_run") {
        return await transaction.read(() => Object.freeze(
          cleanupCandidates(db, { asOf, limit }),
        ));
      }
      assertCurrentTransaction(transaction);
      return await withArtifactMutationSavepoint(
        db,
        transaction,
        "orphan_cleanup",
        async () => {
      assertIdentity(args);
      const requestSha256 = canonicalDigest({
        contract: "artifact_orphan_cleanup_request_v1",
        tenant_id: args.tenantId,
        scope: args.scope,
        operation_id: args.operationId,
        as_of: asOf,
        limit,
      });
      const replay =
        replayReceipt<LiteEvidenceArtifactOrphanCleanupReceiptV1>({
          db,
          tenantId: args.tenantId,
          scope: args.scope,
          operationKind: OPERATION_KIND.orphanCleanup,
          operationId: args.operationId,
          requestSha256,
        });
      if (replay) return replay;
      const candidates = cleanupCandidates(db, {
        asOf,
        limit,
        tenantId: args.tenantId,
        scope: args.scope,
      });
      const terminalAt = canonicalNow();
      for (const candidate of candidates) {
        const terminalOperationId = exactCleanupTerminalOperationId(
          args.operationId,
          candidate.upload_id,
        );
        const terminalRequestSha256 = canonicalDigest({
          contract: "artifact_upload_expiry_request_v1",
          cleanup_operation_id: args.operationId,
          upload_id: candidate.upload_id,
          as_of: asOf,
        });
        db.prepare(
          `UPDATE lite_runtime_evidence_uploads
           SET status = 'expired',
               terminal_operation_id = ?,
               terminal_request_sha256 = ?,
               finalized_artifact_id = NULL,
               finalize_receipt_sha256 = NULL,
               terminal_reason = 'upload_expired',
               updated_at = ?,
               terminal_at = ?,
               row_version = row_version + 1
           WHERE tenant_id = ? AND scope = ? AND upload_id = ?
             AND status = 'open' AND expires_at <= ?`,
        ).run(
          terminalOperationId,
          terminalRequestSha256,
          terminalAt,
          terminalAt,
          candidate.tenant_id,
          candidate.scope,
          candidate.upload_id,
          asOf,
        );
        db.prepare(
          `DELETE FROM lite_runtime_evidence_upload_chunks
           WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
        ).run(
          candidate.tenant_id,
          candidate.scope,
          candidate.upload_id,
        );
      }
      const receipt: LiteEvidenceArtifactOrphanCleanupReceiptV1 =
        Object.freeze({
          contract_version: "artifact_orphan_cleanup_receipt_v1",
          mode: "apply",
          as_of: asOf,
          request_limit: limit,
          expired_uploads: Object.freeze(candidates),
          discarded_chunk_count: candidates.reduce(
            (sum, candidate) => sum + candidate.chunk_count,
            0,
          ),
          discarded_byte_length: candidates.reduce(
            (sum, candidate) => sum + candidate.byte_length,
            0,
          ),
        });
      recordOperation({
        db,
        transaction,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: OPERATION_KIND.orphanCleanup,
        operationId: args.operationId,
        requestSha256,
        receipt,
        createdAt: terminalAt,
      });
      return receipt;
        },
      );
    },
  };
  return access;
}
