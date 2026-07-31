import { createHash } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";

import {
  EXECUTION_EPISODE_MAX_ARTIFACT_BYTES,
  EXECUTION_EPISODE_MAX_INLINE_ARTIFACT_BYTES,
  EvidenceArtifactInputV1Schema,
  type EvidenceArtifactKindV1,
  type EvidenceArtifactRefV1,
} from "../memory/execution-episode.js";
import type {
  LiteEvidenceArtifactStore,
} from "../store/lite-evidence-artifact-store.js";

const RUNTIME_EVIDENCE_CHUNK_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type RuntimeOwnedEvidenceBytesV1 = Readonly<{
  tenantId: string;
  scope: string;
  episodeId: string;
  operationId: string;
  kind: EvidenceArtifactKindV1;
  bytes: Uint8Array;
  mediaType: string;
  encoding: string;
  redactionPolicy: string;
  retentionPolicy: string;
  retentionUntil?: string | null;
}>;

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stageOperationId(
  operationId: string,
  stage: string,
  sequence: number | null = null,
): string {
  if (
    operationId.length === 0
    || operationId !== operationId.trim()
    || Buffer.byteLength(operationId, "utf8") > 256
  ) {
    throw new TypeError(
      "Runtime evidence operationId must be exact and at most 256 UTF-8 bytes",
    );
  }
  return `reo_${sha256Bytes(Buffer.from(stableStringify({
    contract_version: "runtime_owned_evidence_operation_v1",
    operation_id: operationId,
    stage,
    sequence,
  }), "utf8"))}`;
}

/**
 * Materializes bytes observed or produced by Runtime itself. The caller owns
 * the surrounding Runtime transaction so the final artifact and its
 * referencing episode event can commit atomically.
 */
export async function materializeRuntimeOwnedEvidenceInCurrentTransaction(
  store: LiteEvidenceArtifactStore,
  input: RuntimeOwnedEvidenceBytesV1,
): Promise<EvidenceArtifactRefV1> {
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > EXECUTION_EPISODE_MAX_ARTIFACT_BYTES) {
    throw new RangeError(
      `Runtime evidence exceeds ${EXECUTION_EPISODE_MAX_ARTIFACT_BYTES} bytes`,
    );
  }
  const declaredSha256 = sha256Bytes(bytes);
  if (!SHA256_PATTERN.test(declaredSha256)) {
    throw new Error("runtime_owned_evidence_sha256_invalid");
  }

  if (bytes.byteLength <= EXECUTION_EPISODE_MAX_INLINE_ARTIFACT_BYTES) {
    return await store.materializeInputInCurrentTransaction({
      tenantId: input.tenantId,
      scope: input.scope,
      episodeId: input.episodeId,
      operationId: stageOperationId(input.operationId, "inline"),
      artifact: EvidenceArtifactInputV1Schema.parse({
        contract_version: "evidence_artifact_input_v1",
        kind: input.kind,
        declared_sha256: declaredSha256,
        declared_byte_length: bytes.byteLength,
        media_type: input.mediaType,
        encoding: input.encoding,
        ingest: {
          mode: "bounded_inline_base64",
          data: bytes.toString("base64"),
        },
      }),
      redactionPolicy: input.redactionPolicy,
      retentionPolicy: input.retentionPolicy,
      retentionUntil: input.retentionUntil,
    });
  }

  const started = await store.startUploadInCurrentTransaction({
    tenantId: input.tenantId,
    scope: input.scope,
    episodeId: input.episodeId,
    operationId: stageOperationId(input.operationId, "upload_start"),
    kind: input.kind,
    declaredSha256,
    declaredByteLength: bytes.byteLength,
    mediaType: input.mediaType,
    encoding: input.encoding,
    redactionPolicy: input.redactionPolicy,
    retentionPolicy: input.retentionPolicy,
    retentionUntil: input.retentionUntil,
  });
  const chunkBytes = Math.min(
    RUNTIME_EVIDENCE_CHUNK_BYTES,
    started.max_chunk_bytes,
  );
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("runtime_owned_evidence_chunk_limit_invalid");
  }
  let sequence = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + chunkBytes, bytes.byteLength),
    );
    await store.appendUploadChunkInCurrentTransaction({
      tenantId: input.tenantId,
      scope: input.scope,
      operationId: stageOperationId(
        input.operationId,
        "upload_chunk",
        sequence,
      ),
      uploadId: started.upload_id,
      sequence,
      byteOffset: offset,
      dataBase64: chunk.toString("base64"),
      chunkSha256: sha256Bytes(chunk),
    });
    sequence += 1;
  }
  const finalized = await store.finalizeUploadInCurrentTransaction({
    tenantId: input.tenantId,
    scope: input.scope,
    operationId: stageOperationId(input.operationId, "upload_finalize"),
    uploadId: started.upload_id,
    expectedChunkCount: sequence,
    declaredSha256,
    declaredByteLength: bytes.byteLength,
  });
  return finalized.artifact_ref;
}
