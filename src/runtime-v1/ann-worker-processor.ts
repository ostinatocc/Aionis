import { createHash } from "node:crypto";

import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type Sha256,
} from "../continuation/contract.js";
import {
  buildContinuationRuntimeV1AnnIndexReceipt,
  ContinuationRuntimeV1AnnIndexSegmentError,
  parseContinuationRuntimeV1AnnIndexReceipt,
  parseContinuationRuntimeV1AnnIndexSegmentRef,
  type ContinuationRuntimeV1AnnIndexSegmentStore,
  type ContinuationRuntimeV1AnnIndexVectorInputV1,
} from "./ann-index-segment-store.js";
import {
  parseContinuationRuntimeV1AnnJobPayload,
  parseContinuationRuntimeV1EmbeddingVectorArtifactRef,
  type ContinuationRuntimeV1EmbeddingVectorArtifactRefV1,
} from "./embedding-job-contract.js";
import {
  ContinuationRuntimeV1VectorArtifactError,
  type ContinuationRuntimeV1VectorArtifactReadResult,
  type ContinuationRuntimeV1VectorArtifactStore,
} from "./vector-artifact-store.js";
import {
  ContinuationRuntimeV1WorkerProcessorError,
  type ContinuationRuntimeV1PreparedWorkerSuccess,
  type ContinuationRuntimeV1WorkerProcessor,
  type ContinuationRuntimeV1WorkerProcessorInput,
} from "./worker-service.js";

const FACTORY_KEYS = Object.freeze([
  "indexSegmentStore", "vectorArtifactStore",
] as const);
const VECTOR_READ_KEYS = Object.freeze([
  "encoding_format", "ref", "schema_version", "vector",
] as const);
const MAX_RECEIPT_BYTES = 4_096;

export type ContinuationRuntimeV1AnnWorkerProcessorInput = Readonly<{
  vectorArtifactStore: Pick<ContinuationRuntimeV1VectorArtifactStore, "read">;
  indexSegmentStore: Pick<ContinuationRuntimeV1AnnIndexSegmentStore, "write">;
}>;

function processorFailure(
  code: string,
  disposition: "retry" | "dead",
): never {
  throw new ContinuationRuntimeV1WorkerProcessorError({ code, disposition });
}

function configurationFailure(): never {
  throw new Error("continuation_runtime_v1_ann_worker_processor_invalid");
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) throw new Error("record_invalid");
  const actual = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new Error("record_invalid");
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of actual as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("record_invalid");
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseVector(value: unknown, dimensions: number): readonly number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length !== dimensions) throw new Error("vector_invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== dimensions + 1
    || keys.some((key) => typeof key !== "string")) throw new Error("vector_invalid");
  const vector: number[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const component = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (!descriptor?.enumerable || typeof component !== "number"
      || !Number.isFinite(component) || !Number.isFinite(Math.fround(component))) {
      throw new Error("vector_invalid");
    }
    vector.push(Math.fround(component));
  }
  return Object.freeze(vector);
}

function vectorBinary(values: readonly number[]): Buffer {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    bytes.writeFloatLE(values[index]!, index * 4);
  }
  return bytes;
}

function vectorRefArtifactSha256(
  ref: ContinuationRuntimeV1EmbeddingVectorArtifactRefV1,
): Sha256 {
  return canonicalContinuationSha256({
    schema_version: "vector_artifact_metadata_v1",
    source_projection_sha256: ref.source_projection_sha256,
    embedding_document_sha256: ref.embedding_document_sha256,
    model: ref.model,
    dimensions: ref.dimensions,
    encoding_format: "float32_le",
    vector_byte_length: ref.dimensions * 4,
    vector_sha256: ref.vector_sha256,
  });
}

function parsePayload(
  input: ContinuationRuntimeV1WorkerProcessorInput<"ann">,
) {
  try {
    if (input.job.job_kind !== "ann") throw new Error("job_kind_invalid");
    const payload = parseContinuationRuntimeV1AnnJobPayload(input.job.payload);
    if (canonicalContinuationSha256(payload) !== input.job.payload_sha256) {
      throw new Error("payload_digest_invalid");
    }
    return payload;
  } catch {
    processorFailure("ann_payload_invalid", "dead");
  }
}

function assertVectorFamily(
  refs: readonly ContinuationRuntimeV1EmbeddingVectorArtifactRefV1[],
): Readonly<{ model: string; dimensions: number }> {
  try {
    const parsed = refs.map((value) => {
      const ref = parseContinuationRuntimeV1EmbeddingVectorArtifactRef(value);
      if (vectorRefArtifactSha256(ref) !== ref.artifact_sha256) {
        throw new Error("artifact_ref_digest_invalid");
      }
      return ref;
    });
    const first = parsed[0]!;
    if (parsed.some((ref) => ref.model !== first.model
      || ref.dimensions !== first.dimensions)) {
      processorFailure("ann_vector_family_mismatch", "dead");
    }
    return Object.freeze({ model: first.model, dimensions: first.dimensions });
  } catch (error) {
    if (error instanceof ContinuationRuntimeV1WorkerProcessorError) throw error;
    processorFailure("ann_vector_ref_invalid", "dead");
  }
}

function verifiedRead(
  value: ContinuationRuntimeV1VectorArtifactReadResult,
  expected: ContinuationRuntimeV1EmbeddingVectorArtifactRefV1,
): readonly number[] {
  try {
    const record = exactRecord(value, VECTOR_READ_KEYS);
    if (record.schema_version !== "vector_artifact_read_v1"
      || record.encoding_format !== "float32_le") throw new Error("read_schema_invalid");
    const ref = parseContinuationRuntimeV1EmbeddingVectorArtifactRef(record.ref);
    if (canonicalContinuationJson(ref) !== canonicalContinuationJson(expected)
      || vectorRefArtifactSha256(ref) !== ref.artifact_sha256) {
      throw new Error("read_ref_invalid");
    }
    const vector = denseVector(record.vector, ref.dimensions);
    const binary = vectorBinary(vector);
    try {
      if (createHash("sha256").update(binary).digest("hex") !== ref.vector_sha256) {
        throw new Error("read_vector_digest_invalid");
      }
    } finally { binary.fill(0); }
    return vector;
  } catch {
    processorFailure("ann_vector_sidecar_contract_invalid", "dead");
  }
}

function mapVectorSidecarFailure(error: unknown): never {
  if (!(error instanceof ContinuationRuntimeV1VectorArtifactError)) {
    processorFailure("ann_vector_sidecar_unavailable", "retry");
  }
  switch (error.code) {
    case "io_failure":
      processorFailure("ann_vector_sidecar_unavailable", "retry");
    case "symlink_forbidden":
    case "artifact_conflict":
    case "artifact_tampered":
      processorFailure("ann_vector_sidecar_integrity_failure", "dead");
    case "configuration_invalid":
    case "input_invalid":
    case "path_invalid":
      processorFailure("ann_vector_sidecar_contract_invalid", "dead");
    case "scan_limit_exceeded":
      processorFailure("ann_vector_sidecar_contract_invalid", "dead");
  }
}

function mapIndexSidecarFailure(error: unknown): never {
  if (!(error instanceof ContinuationRuntimeV1AnnIndexSegmentError)) {
    processorFailure("ann_index_sidecar_unavailable", "retry");
  }
  switch (error.code) {
    case "io_failure":
      processorFailure("ann_index_sidecar_unavailable", "retry");
    case "symlink_forbidden":
    case "segment_conflict":
    case "segment_tampered":
      processorFailure("ann_index_sidecar_integrity_failure", "dead");
    case "configuration_invalid":
    case "input_invalid":
    case "path_invalid":
      processorFailure("ann_index_sidecar_contract_invalid", "dead");
    case "scan_limit_exceeded":
      processorFailure("ann_index_sidecar_contract_invalid", "dead");
  }
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) processorFailure("ann_processor_aborted", "retry");
}

/**
 * Builds a verifiable immutable index segment only. It has no database port,
 * no memory/effect authority port, no provider, and no child-job queue port.
 */
export function createContinuationRuntimeV1AnnWorkerProcessor(
  value: ContinuationRuntimeV1AnnWorkerProcessorInput,
): ContinuationRuntimeV1WorkerProcessor<"ann"> {
  let dependencies: ContinuationRuntimeV1AnnWorkerProcessorInput;
  try {
    const record = exactRecord(value, FACTORY_KEYS);
    const vectorArtifactStore = record.vectorArtifactStore as
      ContinuationRuntimeV1AnnWorkerProcessorInput["vectorArtifactStore"];
    const indexSegmentStore = record.indexSegmentStore as
      ContinuationRuntimeV1AnnWorkerProcessorInput["indexSegmentStore"];
    if (!vectorArtifactStore || typeof vectorArtifactStore.read !== "function"
      || !indexSegmentStore || typeof indexSegmentStore.write !== "function") {
      configurationFailure();
    }
    dependencies = Object.freeze({ vectorArtifactStore, indexSegmentStore });
  } catch (error) {
    if (error instanceof Error
      && error.message === "continuation_runtime_v1_ann_worker_processor_invalid") {
      throw error;
    }
    configurationFailure();
  }

  return Object.freeze({
    worker_role: "ann" as const,
    async process(
      input: ContinuationRuntimeV1WorkerProcessorInput<"ann">,
    ): Promise<ContinuationRuntimeV1PreparedWorkerSuccess<"ann">> {
      checkSignal(input.signal);
      const payload = parsePayload(input);
      const artifacts = payload.embedding_artifact_set_ref.artifacts;
      assertVectorFamily(artifacts.map((member) => member.vector_artifact_ref));
      const vectors: ContinuationRuntimeV1AnnIndexVectorInputV1[] = [];
      for (const member of artifacts) {
        checkSignal(input.signal);
        let value: ContinuationRuntimeV1VectorArtifactReadResult | null;
        try {
          value = await dependencies.vectorArtifactStore.read(
            member.vector_artifact_ref,
          );
        } catch (error) {
          mapVectorSidecarFailure(error);
        }
        if (value === null) processorFailure("ann_vector_artifact_missing", "dead");
        vectors.push(Object.freeze({
          vector_artifact_ref: member.vector_artifact_ref,
          vector: verifiedRead(value!, member.vector_artifact_ref),
        }));
      }
      checkSignal(input.signal);
      let segmentRef;
      try {
        segmentRef = await dependencies.indexSegmentStore.write({
          schema_version: "ann_index_segment_write_v1",
          embedding_artifact_set_ref: payload.embedding_artifact_set_ref,
          vectors: Object.freeze(vectors),
        });
      } catch (error) {
        mapIndexSidecarFailure(error);
      }
      let receipt;
      try {
        const ref = parseContinuationRuntimeV1AnnIndexSegmentRef(segmentRef!);
        if (ref.artifact_set_sha256
          !== payload.embedding_artifact_set_ref.artifact_set_sha256) {
          throw new Error("segment_binding_invalid");
        }
        receipt = parseContinuationRuntimeV1AnnIndexReceipt(
          buildContinuationRuntimeV1AnnIndexReceipt(input.job.payload_sha256, ref),
        );
        if (Buffer.byteLength(canonicalContinuationJson(receipt), "utf8")
          > MAX_RECEIPT_BYTES) throw new Error("receipt_too_large");
      } catch {
        processorFailure("ann_index_sidecar_contract_invalid", "dead");
      }
      return Object.freeze({
        output: canonicalContinuationClone({
          kind: "ann" as const,
          index_receipt: receipt!,
        }),
        // Deliberate no-op: the generic runner alone records completion and
        // transitions the durable job. ANN has no authority mutation.
        async commitAuthority(): Promise<void> {},
      });
    },
  });
}
