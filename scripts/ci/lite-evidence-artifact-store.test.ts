import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  EvidenceArtifactRefV1Schema,
  EvidenceArtifactInputV1Schema,
  evidenceArtifactRefDigest,
  type EvidenceArtifactKindV1,
} from "../../src/memory/execution-episode.js";
import {
  LiteEvidenceArtifactStoreError,
  createLiteEvidenceArtifactStore,
  inspectLiteEvidenceArtifactIntegrity,
  type LiteEvidenceArtifactOrphanCleanupReceiptV1,
  type LiteEvidenceArtifactStore,
} from "../../src/store/lite-evidence-artifact-store.js";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.js";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.js";

const TENANT = "tenant-cas-test";
const SCOPE = "tenant:tenant-cas-test:project:artifact-test";
const EPISODE = "episode-real-sqlite-cas";
const REDACTION = "episode-default-redaction-v1";
const RETENTION = "episode-replay-v1";

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tempDatabasePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), "aionis-evidence-artifact-"));
  return join(directory, `${label}.sqlite`);
}

type OpenRuntime = {
  path: string;
  database: LiteRuntimeDatabase;
  writeStore: LiteWriteStore;
  artifactStore: LiteEvidenceArtifactStore;
  close(): Promise<void>;
};

function openRuntime(
  path: string,
  options: { uploadTtlMs?: number } = {},
): OpenRuntime {
  const database = createLiteRuntimeDatabase(path);
  const writeStore = createLiteWriteStoreFromDatabase(database, {
    annProjectionEnabled: false,
  });
  const artifactStore = createLiteEvidenceArtifactStore(database, options);
  let closed = false;
  return {
    path,
    database,
    writeStore,
    artifactStore,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await writeStore.close();
      } finally {
        await database.close();
      }
    },
  };
}

function inlineArtifact(
  content: Buffer,
  kind: EvidenceArtifactKindV1 = "manifest",
) {
  return EvidenceArtifactInputV1Schema.parse({
    contract_version: "evidence_artifact_input_v1",
    kind,
    declared_sha256: digest(content),
    declared_byte_length: content.byteLength,
    media_type: "application/json",
    encoding: "utf-8",
    ingest: {
      mode: "bounded_inline_base64",
      data: content.toString("base64"),
    },
  });
}

function assertStoreError(code: string): (error: unknown) => true {
  return (error: unknown) => {
    assert.ok(error instanceof LiteEvidenceArtifactStoreError);
    assert.equal(error.code, code);
    return true;
  };
}

async function startUpload(
  runtime: OpenRuntime,
  args: {
    operationId: string;
    content: Buffer;
    declaredSha256?: string;
    kind?: EvidenceArtifactKindV1;
  },
) {
  return await runtime.artifactStore.transactionRunner().run(async () =>
    await runtime.artifactStore.startUploadInCurrentTransaction({
      tenantId: TENANT,
      scope: SCOPE,
      episodeId: EPISODE,
      operationId: args.operationId,
      kind: args.kind ?? "workspace_diff",
      declaredSha256: args.declaredSha256 ?? digest(args.content),
      declaredByteLength: args.content.byteLength,
      mediaType: "application/octet-stream",
      encoding: "binary",
      redactionPolicy: REDACTION,
      retentionPolicy: RETENTION,
    })
  );
}

async function appendChunk(
  runtime: OpenRuntime,
  args: {
    operationId: string;
    uploadId: string;
    sequence: number;
    byteOffset: number;
    bytes: Buffer;
    chunkSha256?: string;
  },
) {
  return await runtime.artifactStore.transactionRunner().run(async () =>
    await runtime.artifactStore.appendUploadChunkInCurrentTransaction({
      tenantId: TENANT,
      scope: SCOPE,
      operationId: args.operationId,
      uploadId: args.uploadId,
      sequence: args.sequence,
      byteOffset: args.byteOffset,
      dataBase64: args.bytes.toString("base64"),
      chunkSha256: args.chunkSha256 ?? digest(args.bytes),
    })
  );
}

test("inline evidence uses the real v7 database, exact operation replay, and read-time CAS verification", async () => {
  const path = tempDatabasePath("inline");
  let runtime = openRuntime(path);
  const content = Buffer.from(
    JSON.stringify({ task_id: "task-42", objective: "preserve replay truth" }),
    "utf8",
  );
  const artifact = inlineArtifact(content);
  try {
    const version = runtime.database.db.prepare(
      `SELECT version
       FROM lite_runtime_schema_metadata
       WHERE component = 'write_projection'`,
    ).get() as { version: number };
    assert.equal(version.version, 8);

    await assert.rejects(
      runtime.artifactStore.ingestInlineInCurrentTransaction({
        tenantId: TENANT,
        scope: SCOPE,
        episodeId: EPISODE,
        operationId: "inline-operation-1",
        artifact,
        redactionPolicy: REDACTION,
        retentionPolicy: RETENTION,
      }),
      assertStoreError("evidence_artifact_mutation_requires_shared_transaction"),
    );

    const first = await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.ingestInlineInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          episodeId: EPISODE,
          operationId: "inline-operation-1",
          artifact,
          redactionPolicy: REDACTION,
          retentionPolicy: RETENTION,
        }),
    );
    assert.equal(
      first.artifact_ref.storage_ref,
      `sqlite-cas://sha256/${digest(content)}`,
    );
    assert.notEqual(first.artifact_ref.artifact_id, "inline-operation-1");

    const replay = await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.ingestInlineInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          episodeId: EPISODE,
          operationId: "inline-operation-1",
          artifact,
          redactionPolicy: REDACTION,
          retentionPolicy: RETENTION,
        }),
    );
    assert.deepEqual(replay, first);

    await assert.rejects(
      runtime.artifactStore.transactionRunner().run(
        async () =>
          await runtime.artifactStore.ingestInlineInCurrentTransaction({
            tenantId: TENANT,
            scope: SCOPE,
            episodeId: EPISODE,
            operationId: "inline-operation-1",
            artifact,
            redactionPolicy: REDACTION,
            retentionPolicy: "different-retention-policy-v1",
          }),
      ),
      assertStoreError("evidence_artifact_operation_conflict"),
    );

    assert.deepEqual(
      await runtime.artifactStore.readArtifactBytes({
        tenantId: TENANT,
        scope: SCOPE,
        episodeId: EPISODE,
        artifactId: first.artifact_ref.artifact_id,
      }),
      content,
    );
    await assert.rejects(
      runtime.artifactStore.readArtifactBytes({
        tenantId: TENANT,
        scope: SCOPE,
        episodeId: "different-episode",
        artifactId: first.artifact_ref.artifact_id,
      }),
      assertStoreError("evidence_artifact_not_found"),
    );
    assert.equal(
      await runtime.artifactStore.resolveArtifact({
        tenantId: TENANT,
        scope: SCOPE,
        episodeId: "different-episode",
        artifactId: first.artifact_ref.artifact_id,
      }),
      null,
    );
    const integrity = await runtime.artifactStore.inspectIntegrity();
    assert.equal(integrity.ok, true);
    assert.deepEqual(
      inspectLiteEvidenceArtifactIntegrity(runtime.database.db),
      integrity,
    );

    await assert.rejects(
      runtime.artifactStore.transactionRunner().run(async () => {
        runtime.database.db.prepare(
          `DELETE FROM lite_runtime_evidence_blobs
           WHERE tenant_id = ? AND blob_sha256 = ?`,
        ).run(TENANT, digest(content));
      }),
      /runtime_evidence_blob_is_referenced/,
    );

    await runtime.close();
    runtime = openRuntime(path);
    assert.deepEqual(
      await runtime.artifactStore.readArtifactBytes({
        tenantId: TENANT,
        scope: SCOPE,
        episodeId: EPISODE,
        artifactId: first.artifact_ref.artifact_id,
      }),
      content,
    );
    assert.deepEqual(
      await runtime.artifactStore.resolveArtifact({
        tenantId: TENANT,
        scope: SCOPE,
        episodeId: EPISODE,
        artifactId: first.artifact_ref.artifact_id,
      }),
      first.artifact_ref,
    );
  } finally {
    await runtime.close();
  }
});

test("chunk upload rejects digest mismatch, gaps, overlaps, and conflicting operation replay", async () => {
  const runtime = openRuntime(tempDatabasePath("chunk-rejections"));
  const content = Buffer.from("0123456789abcdef", "utf8");
  const firstChunk = content.subarray(0, 8);
  try {
    const upload = await startUpload(runtime, {
      operationId: "start-rejections",
      content,
    });

    await assert.rejects(
      appendChunk(runtime, {
        operationId: "chunk-wrong-digest",
        uploadId: upload.upload_id,
        sequence: 0,
        byteOffset: 0,
        bytes: firstChunk,
        chunkSha256: "f".repeat(64),
      }),
      assertStoreError("evidence_artifact_upload_chunk_digest_mismatch"),
    );
    await assert.rejects(
      appendChunk(runtime, {
        operationId: "chunk-gap",
        uploadId: upload.upload_id,
        sequence: 1,
        byteOffset: 0,
        bytes: firstChunk,
      }),
      assertStoreError("evidence_artifact_upload_chunk_not_next"),
    );
    assert.equal((await runtime.artifactStore.inspectIntegrity()).ok, true);

    const appended = await appendChunk(runtime, {
      operationId: "chunk-zero",
      uploadId: upload.upload_id,
      sequence: 0,
      byteOffset: 0,
      bytes: firstChunk,
    });
    assert.equal(appended.next_sequence, 1);
    assert.equal(appended.next_byte_offset, 8);
    assert.deepEqual(
      await appendChunk(runtime, {
        operationId: "chunk-zero",
        uploadId: upload.upload_id,
        sequence: 0,
        byteOffset: 0,
        bytes: firstChunk,
      }),
      appended,
    );

    await assert.rejects(
      appendChunk(runtime, {
        operationId: "chunk-zero",
        uploadId: upload.upload_id,
        sequence: 0,
        byteOffset: 0,
        bytes: content.subarray(8),
      }),
      assertStoreError("evidence_artifact_operation_conflict"),
    );
    await assert.rejects(
      appendChunk(runtime, {
        operationId: "chunk-overlap",
        uploadId: upload.upload_id,
        sequence: 1,
        byteOffset: 4,
        bytes: content.subarray(8),
      }),
      assertStoreError("evidence_artifact_upload_chunk_not_next"),
    );
    await assert.rejects(
      appendChunk(runtime, {
        operationId: "chunk-gap-after-first",
        uploadId: upload.upload_id,
        sequence: 2,
        byteOffset: 8,
        bytes: content.subarray(8),
      }),
      assertStoreError("evidence_artifact_upload_chunk_not_next"),
    );
  } finally {
    await runtime.close();
  }
});

test("artifact savepoints prevent half commits when callers catch operation conflicts or authority failures", async () => {
  const runtime = openRuntime(tempDatabasePath("mutation-savepoints"));
  const conflictEpisode = "episode-savepoint-operation-conflict";
  const conflictContent = Buffer.from(
    "domain rows must not survive operation conflict",
    "utf8",
  );
  const authorityContent = Buffer.from(
    "finalize rows must not survive authority failure",
    "utf8",
  );
  try {
    runtime.database.db.exec(`
      CREATE TRIGGER test_artifact_operation_conflict
      AFTER INSERT ON lite_runtime_evidence_artifacts
      WHEN NEW.episode_id = '${conflictEpisode}'
      BEGIN
        INSERT INTO lite_runtime_write_operations
          (tenant_id, scope, operation_kind, operation_id, request_sha256,
           receipt_json, commit_id, created_at)
        VALUES
          (NEW.tenant_id, NEW.scope, 'evidence_artifact_inline_ingest_v1',
           'savepoint-operation-conflict', '${"f".repeat(64)}',
           '{}', NULL, NEW.created_at);
      END;
    `);

    await runtime.artifactStore.transactionRunner().run(async () => {
      await assert.rejects(
        runtime.artifactStore.ingestInlineInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          episodeId: conflictEpisode,
          operationId: "savepoint-operation-conflict",
          artifact: inlineArtifact(conflictContent),
          redactionPolicy: REDACTION,
          retentionPolicy: RETENTION,
        }),
        /UNIQUE constraint failed/u,
      );
      assert.equal(runtime.artifactStore.transactionRunner().inTransaction(), true);
    });

    const conflictState = runtime.database.db.prepare(
      `SELECT
         (SELECT count(*)
            FROM lite_runtime_evidence_artifacts
           WHERE tenant_id = ? AND scope = ? AND episode_id = ?) AS artifacts,
         (SELECT count(*)
            FROM lite_runtime_evidence_blobs
           WHERE tenant_id = ? AND blob_sha256 = ?) AS blobs,
         (SELECT count(*)
            FROM lite_runtime_write_operations
           WHERE tenant_id = ? AND scope = ?
             AND operation_kind = 'evidence_artifact_inline_ingest_v1'
             AND operation_id = 'savepoint-operation-conflict') AS operations`,
    ).get(
      TENANT,
      SCOPE,
      conflictEpisode,
      TENANT,
      digest(conflictContent),
      TENANT,
      SCOPE,
    ) as { artifacts: number; blobs: number; operations: number };
    assert.deepEqual({ ...conflictState }, {
      artifacts: 0,
      blobs: 0,
      operations: 0,
    });
    runtime.database.db.exec("DROP TRIGGER test_artifact_operation_conflict");

    const upload = await startUpload(runtime, {
      operationId: "start-savepoint-authority-failure",
      content: authorityContent,
      kind: "tool_result",
    });
    await appendChunk(runtime, {
      operationId: "chunk-savepoint-authority-failure",
      uploadId: upload.upload_id,
      sequence: 0,
      byteOffset: 0,
      bytes: authorityContent,
    });
    runtime.database.db.exec(`
      CREATE TRIGGER test_artifact_authority_failure
      BEFORE INSERT ON lite_runtime_write_operations
      WHEN NEW.operation_kind = 'evidence_artifact_upload_finalize_v1'
       AND NEW.operation_id = 'savepoint-finalize-authority-failure'
      BEGIN
        SELECT RAISE(ABORT, 'forced_artifact_authority_failure');
      END;
    `);

    await runtime.artifactStore.transactionRunner().run(async () => {
      await assert.rejects(
        runtime.artifactStore.finalizeUploadInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          operationId: "savepoint-finalize-authority-failure",
          uploadId: upload.upload_id,
          expectedChunkCount: 1,
          declaredSha256: digest(authorityContent),
          declaredByteLength: authorityContent.byteLength,
        }),
        /forced_artifact_authority_failure/u,
      );
      assert.equal(runtime.artifactStore.transactionRunner().inTransaction(), true);
    });

    const uploadAfterCaughtFailure = runtime.database.db.prepare(
      `SELECT status, next_sequence, next_byte_offset, finalized_artifact_id
       FROM lite_runtime_evidence_uploads
       WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
    ).get(TENANT, SCOPE, upload.upload_id) as {
      status: string;
      next_sequence: number;
      next_byte_offset: number;
      finalized_artifact_id: string | null;
    };
    assert.deepEqual({ ...uploadAfterCaughtFailure }, {
      status: "open",
      next_sequence: 1,
      next_byte_offset: authorityContent.byteLength,
      finalized_artifact_id: null,
    });
    const finalizeFailureState = runtime.database.db.prepare(
      `SELECT
         (SELECT count(*)
            FROM lite_runtime_evidence_upload_chunks
           WHERE tenant_id = ? AND scope = ? AND upload_id = ?) AS chunks,
         (SELECT count(*)
            FROM lite_runtime_evidence_artifacts
           WHERE tenant_id = ? AND scope = ? AND source_upload_id = ?) AS artifacts,
         (SELECT count(*)
            FROM lite_runtime_evidence_blobs
           WHERE tenant_id = ? AND blob_sha256 = ?) AS blobs,
         (SELECT count(*)
            FROM lite_runtime_write_operations
           WHERE tenant_id = ? AND scope = ?
             AND operation_kind = 'evidence_artifact_upload_finalize_v1'
             AND operation_id = 'savepoint-finalize-authority-failure')
           AS operations`,
    ).get(
      TENANT,
      SCOPE,
      upload.upload_id,
      TENANT,
      SCOPE,
      upload.upload_id,
      TENANT,
      digest(authorityContent),
      TENANT,
      SCOPE,
    ) as {
      chunks: number;
      artifacts: number;
      blobs: number;
      operations: number;
    };
    assert.deepEqual({ ...finalizeFailureState }, {
      chunks: 1,
      artifacts: 0,
      blobs: 0,
      operations: 0,
    });

    runtime.database.db.exec("DROP TRIGGER test_artifact_authority_failure");
    const recovered = await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.finalizeUploadInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          operationId: "savepoint-finalize-recovered",
          uploadId: upload.upload_id,
          expectedChunkCount: 1,
          declaredSha256: digest(authorityContent),
          declaredByteLength: authorityContent.byteLength,
        }),
    );
    assert.equal(recovered.artifact_ref.sha256, digest(authorityContent));
  } finally {
    await runtime.close();
  }
});

test("finalize atomically seals real chunks, rereads after reopen, and rejects a wrong final digest", async () => {
  const path = tempDatabasePath("finalize");
  let runtime = openRuntime(path);
  const content = Buffer.from("real-runtime-upload-payload", "utf8");
  const split = 11;
  try {
    const upload = await startUpload(runtime, {
      operationId: "start-finalize",
      content,
      kind: "tool_result",
    });
    await appendChunk(runtime, {
      operationId: "finalize-chunk-0",
      uploadId: upload.upload_id,
      sequence: 0,
      byteOffset: 0,
      bytes: content.subarray(0, split),
    });
    await appendChunk(runtime, {
      operationId: "finalize-chunk-1",
      uploadId: upload.upload_id,
      sequence: 1,
      byteOffset: split,
      bytes: content.subarray(split),
    });

    const finalized = await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.finalizeUploadInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          operationId: "finalize-operation",
          uploadId: upload.upload_id,
          expectedChunkCount: 2,
          declaredSha256: digest(content),
          declaredByteLength: content.byteLength,
        }),
    );
    assert.equal(finalized.artifact_ref.kind, "tool_result");
    assert.equal(finalized.artifact_ref.sha256, digest(content));
    assert.equal(finalized.finalize_receipt_digest.length, 64);
    const chunkCount = runtime.database.db.prepare(
      `SELECT count(*) AS count
       FROM lite_runtime_evidence_upload_chunks
       WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
    ).get(TENANT, SCOPE, upload.upload_id) as { count: number };
    assert.equal(chunkCount.count, 0);

    const replay = await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.finalizeUploadInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          operationId: "finalize-operation",
          uploadId: upload.upload_id,
          expectedChunkCount: 2,
          declaredSha256: digest(content),
          declaredByteLength: content.byteLength,
        }),
    );
    assert.deepEqual(replay, finalized);
    await assert.rejects(
      runtime.database.transaction.run(async () => {
        runtime.database.db.prepare(
          `DELETE FROM lite_runtime_evidence_uploads
           WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
        ).run(TENANT, SCOPE, upload.upload_id);
      }),
      /FOREIGN KEY constraint failed/u,
    );
    const finalizedInput = EvidenceArtifactInputV1Schema.parse({
      contract_version: "evidence_artifact_input_v1",
      kind: finalized.artifact_ref.kind,
      declared_sha256: finalized.artifact_ref.sha256,
      declared_byte_length: finalized.artifact_ref.byte_length,
      media_type: finalized.artifact_ref.media_type,
      encoding: finalized.artifact_ref.encoding,
      ingest: {
        mode: "finalized_runtime_upload",
        upload_id: finalized.upload_id,
        finalize_receipt_digest: finalized.finalize_receipt_digest,
      },
    });
    const materialized = await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.materializeInputInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          episodeId: EPISODE,
          operationId: "materialize-finalized-operation",
          artifact: finalizedInput,
          redactionPolicy: REDACTION,
          retentionPolicy: RETENTION,
        }),
    );
    assert.deepEqual(materialized, finalized.artifact_ref);
    assert.deepEqual(
      await runtime.artifactStore.transactionRunner().run(
        async () =>
          await runtime.artifactStore.materializeInputInCurrentTransaction({
            tenantId: TENANT,
            scope: SCOPE,
            episodeId: EPISODE,
            operationId: "materialize-finalized-operation",
            artifact: finalizedInput,
            redactionPolicy: REDACTION,
            retentionPolicy: RETENTION,
          }),
      ),
      materialized,
    );
    await assert.rejects(
      runtime.artifactStore.transactionRunner().run(
        async () =>
          await runtime.artifactStore.materializeInputInCurrentTransaction({
            tenantId: TENANT,
            scope: SCOPE,
            episodeId: EPISODE,
            operationId: "materialize-finalized-operation",
            artifact: finalizedInput,
            redactionPolicy: REDACTION,
            retentionPolicy: "conflicting-retention-policy-v1",
          }),
      ),
      assertStoreError("evidence_artifact_operation_conflict"),
    );
    await assert.rejects(
      runtime.artifactStore.transactionRunner().run(
        async () =>
          await runtime.artifactStore.materializeInputInCurrentTransaction({
            tenantId: TENANT,
            scope: SCOPE,
            episodeId: "different-episode",
            operationId: "materialize-cross-episode",
            artifact: finalizedInput,
            redactionPolicy: REDACTION,
            retentionPolicy: RETENTION,
          }),
      ),
      assertStoreError("evidence_artifact_upload_episode_conflict"),
    );
    await assert.rejects(
      runtime.artifactStore.transactionRunner().run(
        async () =>
          await runtime.artifactStore.materializeInputInCurrentTransaction({
            tenantId: TENANT,
            scope: SCOPE,
            episodeId: EPISODE,
            operationId: "materialize-wrong-finalize-digest",
            artifact: EvidenceArtifactInputV1Schema.parse({
              ...finalizedInput,
              ingest: {
                ...finalizedInput.ingest,
                finalize_receipt_digest: "f".repeat(64),
              },
            }),
            redactionPolicy: REDACTION,
            retentionPolicy: RETENTION,
          }),
      ),
      assertStoreError("evidence_artifact_upload_finalize_receipt_mismatch"),
    );
    await assert.rejects(
      runtime.artifactStore.transactionRunner().run(
        async () =>
          await runtime.artifactStore.finalizeUploadInCurrentTransaction({
            tenantId: TENANT,
            scope: SCOPE,
            operationId: "finalize-operation",
            uploadId: upload.upload_id,
            expectedChunkCount: 1,
            declaredSha256: digest(content),
            declaredByteLength: content.byteLength,
          }),
      ),
      assertStoreError("evidence_artifact_operation_conflict"),
    );
    assert.equal((await runtime.artifactStore.inspectIntegrity()).ok, true);

    await runtime.close();
    runtime = openRuntime(path);
    assert.deepEqual(
      await runtime.artifactStore.readArtifactBytes({
        tenantId: TENANT,
        scope: SCOPE,
        episodeId: EPISODE,
        artifactId: finalized.artifact_ref.artifact_id,
      }),
      content,
    );

    const wrongDigestContent = Buffer.from("wrong-final-digest", "utf8");
    const wrongDigestUpload = await startUpload(runtime, {
      operationId: "start-wrong-final-digest",
      content: wrongDigestContent,
      declaredSha256: "a".repeat(64),
    });
    await appendChunk(runtime, {
      operationId: "wrong-final-digest-chunk",
      uploadId: wrongDigestUpload.upload_id,
      sequence: 0,
      byteOffset: 0,
      bytes: wrongDigestContent,
    });
    await assert.rejects(
      runtime.artifactStore.transactionRunner().run(
        async () =>
          await runtime.artifactStore.finalizeUploadInCurrentTransaction({
            tenantId: TENANT,
            scope: SCOPE,
            operationId: "wrong-final-digest-finalize",
            uploadId: wrongDigestUpload.upload_id,
            expectedChunkCount: 1,
            declaredSha256: "a".repeat(64),
            declaredByteLength: wrongDigestContent.byteLength,
          }),
      ),
      assertStoreError("evidence_artifact_upload_finalize_digest_mismatch"),
    );
  } finally {
    await runtime.close();
  }
});

test("abort and expired-orphan cleanup discard only uncommitted chunks with dry-run/apply separation", async () => {
  const runtime = openRuntime(tempDatabasePath("cleanup"), {
    uploadTtlMs: 80,
  });
  const abortedContent = Buffer.from("abort-this-upload", "utf8");
  const expiredContent = Buffer.from("expire-this-upload", "utf8");
  try {
    const aborted = await startUpload(runtime, {
      operationId: "start-abort",
      content: abortedContent,
    });
    await appendChunk(runtime, {
      operationId: "abort-chunk",
      uploadId: aborted.upload_id,
      sequence: 0,
      byteOffset: 0,
      bytes: abortedContent,
    });
    const abortReceipt = await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.abortUploadInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          operationId: "abort-operation",
          uploadId: aborted.upload_id,
          reason: "host_cancelled_before_episode_commit",
        }),
    );
    assert.equal(abortReceipt.discarded_chunk_count, 1);
    assert.equal(abortReceipt.discarded_byte_length, abortedContent.byteLength);
    assert.deepEqual(
      await runtime.artifactStore.transactionRunner().run(
        async () =>
          await runtime.artifactStore.abortUploadInCurrentTransaction({
            tenantId: TENANT,
            scope: SCOPE,
            operationId: "abort-operation",
            uploadId: aborted.upload_id,
            reason: "host_cancelled_before_episode_commit",
          }),
      ),
      abortReceipt,
    );

    const expired = await startUpload(runtime, {
      operationId: "start-expire",
      content: expiredContent,
    });
    await appendChunk(runtime, {
      operationId: "expire-chunk",
      uploadId: expired.upload_id,
      sequence: 0,
      byteOffset: 0,
      bytes: expiredContent,
    });
    await delay(120);
    const asOf = new Date().toISOString();
    const dryRun = await runtime.artifactStore.collectExpiredOrphanUploads({
      mode: "dry_run",
      asOf,
      limit: 10,
    });
    assert.ok(Array.isArray(dryRun));
    assert.deepEqual(
      (dryRun as ReadonlyArray<{ upload_id: string }>).map(
        (candidate) => candidate.upload_id,
      ),
      [expired.upload_id],
    );
    const stillOpen = runtime.database.db.prepare(
      `SELECT status
       FROM lite_runtime_evidence_uploads
       WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
    ).get(TENANT, SCOPE, expired.upload_id) as { status: string };
    assert.equal(stillOpen.status, "open");

    const applied = await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.collectExpiredOrphanUploads({
          mode: "apply",
          tenantId: TENANT,
          scope: SCOPE,
          operationId: "cleanup-expired-operation",
          asOf,
          limit: 10,
        }),
    ) as LiteEvidenceArtifactOrphanCleanupReceiptV1;
    assert.equal(applied.expired_uploads.length, 1);
    assert.equal(applied.request_limit, 10);
    assert.equal(applied.discarded_chunk_count, 1);
    assert.equal(applied.discarded_byte_length, expiredContent.byteLength);

    const replay = await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.collectExpiredOrphanUploads({
          mode: "apply",
          tenantId: TENANT,
          scope: SCOPE,
          operationId: "cleanup-expired-operation",
          asOf,
          limit: 10,
        }),
    );
    assert.deepEqual(replay, applied);
    const replayWithoutAsOf =
      await runtime.artifactStore.transactionRunner().run(
        async () =>
          await runtime.artifactStore.collectExpiredOrphanUploads({
            mode: "apply",
            tenantId: TENANT,
            scope: SCOPE,
            operationId: "cleanup-expired-operation",
            limit: 10,
          }),
      );
    assert.deepEqual(replayWithoutAsOf, applied);
    const expiredRow = runtime.database.db.prepare(
      `SELECT status
       FROM lite_runtime_evidence_uploads
       WHERE tenant_id = ? AND scope = ? AND upload_id = ?`,
    ).get(TENANT, SCOPE, expired.upload_id) as { status: string };
    assert.equal(expiredRow.status, "expired");
    const chunks = runtime.database.db.prepare(
      `SELECT count(*) AS count
       FROM lite_runtime_evidence_upload_chunks
       WHERE tenant_id = ? AND scope = ? AND upload_id IN (?, ?)`,
    ).get(
      TENANT,
      SCOPE,
      aborted.upload_id,
      expired.upload_id,
    ) as { count: number };
    assert.equal(chunks.count, 0);
    assert.equal((await runtime.artifactStore.inspectIntegrity()).ok, true);
  } finally {
    await runtime.close();
  }
});

test("integrity keeps GC warnings distinct from byte/reference corruption and blocks deletion", async () => {
  const runtime = openRuntime(tempDatabasePath("gc-report"));
  const orphanArtifactBytes = Buffer.from("orphan-artifact-bytes", "utf8");
  const orphanBlobBytes = Buffer.from("orphan-blob-only", "utf8");
  const retainedBytes = Buffer.from("retention-expired-reference", "utf8");
  try {
    await runtime.artifactStore.transactionRunner().run(async () => {
      const createdAt = new Date().toISOString();
      runtime.database.db.prepare(
        `INSERT INTO lite_runtime_evidence_blobs
           (tenant_id, blob_sha256, byte_length, content_bytes, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        TENANT,
        digest(orphanArtifactBytes),
        orphanArtifactBytes.byteLength,
        orphanArtifactBytes,
        createdAt,
      );
      const orphanRef = EvidenceArtifactRefV1Schema.parse({
        contract_version: "evidence_artifact_ref_v1",
        artifact_id: "orphan-artifact-fixture",
        kind: "manifest",
        sha256: digest(orphanArtifactBytes),
        storage_ref:
          `sqlite-cas://sha256/${digest(orphanArtifactBytes)}`,
        byte_length: orphanArtifactBytes.byteLength,
        media_type: "application/octet-stream",
        encoding: "binary",
        redaction_policy: REDACTION,
        retention_policy: RETENTION,
      });
      runtime.database.db.prepare(
        `INSERT INTO lite_runtime_evidence_artifacts
           (tenant_id, scope, artifact_id, episode_id, kind, sha256,
            storage_ref, byte_length, media_type, encoding, redaction_policy,
            retention_policy, retention_until, ingest_mode, source_upload_id,
            artifact_ref_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
                 'bounded_inline_base64', NULL, ?, ?)`,
      ).run(
        TENANT,
        SCOPE,
        orphanRef.artifact_id,
        EPISODE,
        orphanRef.kind,
        orphanRef.sha256,
        orphanRef.storage_ref,
        orphanRef.byte_length,
        orphanRef.media_type,
        orphanRef.encoding,
        orphanRef.redaction_policy,
        orphanRef.retention_policy,
        evidenceArtifactRefDigest(orphanRef),
        createdAt,
      );
      runtime.database.db.prepare(
        `INSERT INTO lite_runtime_evidence_blobs
           (tenant_id, blob_sha256, byte_length, content_bytes, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        TENANT,
        digest(orphanBlobBytes),
        orphanBlobBytes.byteLength,
        orphanBlobBytes,
        createdAt,
      );
    });
    await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.ingestInlineInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          episodeId: EPISODE,
          operationId: "retention-expired-inline",
          artifact: inlineArtifact(retainedBytes),
          redactionPolicy: REDACTION,
          retentionPolicy: RETENTION,
          retentionUntil: "2000-01-01T00:00:00.000Z",
        }),
    );

    const report = inspectLiteEvidenceArtifactIntegrity(
      runtime.database.db,
      { asOf: "2026-07-27T12:00:00.000Z" },
    );
    assert.equal(report.ok, true);
    assert.deepEqual(report.problems, []);
    assert.equal(report.garbage_collection.apply_supported, false);
    assert.equal(report.garbage_collection.deletion_blocked, true);
    assert.equal(report.counts.unreferenced_artifacts, 1);
    assert.equal(report.counts.unreferenced_blobs, 1);
    assert.equal(report.counts.retention_expired_referenced_artifacts, 1);
    assert.ok(report.warnings.some((problem) =>
      problem.startsWith("artifact_gc_unreferenced:")
    ));
    assert.ok(report.warnings.some((problem) =>
      problem.startsWith("blob_gc_unreferenced:")
    ));
    assert.ok(report.warnings.some((problem) =>
      problem.startsWith("artifact_retention_expired_but_referenced:")
    ));
  } finally {
    await runtime.close();
  }
});

test("read and integrity inspection independently detect same-length CAS corruption", async () => {
  const runtime = openRuntime(tempDatabasePath("tamper"));
  const content = Buffer.from("original-bytes", "utf8");
  try {
    const receipt = await runtime.artifactStore.transactionRunner().run(
      async () =>
        await runtime.artifactStore.ingestInlineInCurrentTransaction({
          tenantId: TENANT,
          scope: SCOPE,
          episodeId: EPISODE,
          operationId: "tamper-inline-operation",
          artifact: inlineArtifact(content, "verifier_output"),
          redactionPolicy: REDACTION,
          retentionPolicy: RETENTION,
        }),
    );
    const corrupted = Buffer.from("corruptd-bytes", "utf8");
    assert.equal(corrupted.byteLength, content.byteLength);
    runtime.database.db.exec(`
      DROP TRIGGER trg_lite_runtime_evidence_blobs_no_update;
      PRAGMA ignore_check_constraints = ON;
    `);
    runtime.database.db.prepare(
      `UPDATE lite_runtime_evidence_blobs
       SET content_bytes = ?
       WHERE tenant_id = ? AND blob_sha256 = ?`,
    ).run(corrupted, TENANT, digest(content));

    await assert.rejects(
      runtime.artifactStore.readArtifactBytes({
        tenantId: TENANT,
        scope: SCOPE,
        episodeId: EPISODE,
        artifactId: receipt.artifact_ref.artifact_id,
      }),
      assertStoreError("evidence_artifact_blob_integrity_failed"),
    );
    await assert.rejects(
      runtime.artifactStore.resolveArtifact({
        tenantId: TENANT,
        scope: SCOPE,
        episodeId: EPISODE,
        artifactId: receipt.artifact_ref.artifact_id,
      }),
      assertStoreError("evidence_artifact_blob_integrity_failed"),
    );
    await assert.rejects(
      runtime.artifactStore.transactionRunner().run(
        async () =>
          await runtime.artifactStore.ingestInlineInCurrentTransaction({
            tenantId: TENANT,
            scope: SCOPE,
            episodeId: EPISODE,
            operationId: "tamper-inline-operation",
            artifact: inlineArtifact(content, "verifier_output"),
            redactionPolicy: REDACTION,
            retentionPolicy: RETENTION,
          }),
      ),
      assertStoreError("evidence_artifact_blob_integrity_failed"),
    );
    const report = await runtime.artifactStore.inspectIntegrity();
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.startsWith("blob_integrity:")));
  } finally {
    // Deliberate schema/content corruption is the subject of this test. Close
    // the database directly instead of asking the normal write-store shutdown
    // audit to accept the tampered fixture.
    await runtime.database.close();
  }
});
