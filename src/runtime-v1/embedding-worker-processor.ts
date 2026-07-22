import {
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type CapsuleRefV1,
  type ExecutionCapsuleV1,
  type Sha256,
} from "../continuation/contract.js";
import { assertExecutionCapsuleV1 } from "../continuation/validation.js";
import {
  type createContinuationRuntimeV1DurableJobEnqueuer,
} from "../store/continuation-runtime-v1-durable-job-enqueuer.js";
import type { createContinuationRuntimeV1MemoryStore } from
  "../store/continuation-runtime-v1-memory-store.js";
import {
  buildContinuationRuntimeV1AnnJobPayload,
  buildContinuationRuntimeV1EmbeddingArtifactSetRef,
  buildContinuationRuntimeV1EmbeddingDocument,
  continuationRuntimeV1EmbeddingDocumentSha256,
  parseContinuationRuntimeV1EmbeddingJobPayload,
  parseContinuationRuntimeV1EmbeddingVectorArtifactRef,
  type ContinuationRuntimeV1EmbeddingArtifactMemberRefV1,
  type ContinuationRuntimeV1EmbeddingDocumentV1,
  type ContinuationRuntimeV1EmbeddingVectorArtifactRefV1,
} from "./embedding-job-contract.js";
import {
  ContinuationRuntimeV1EmbeddingProviderError,
  type ContinuationRuntimeV1EmbeddingBatchResult,
  type ContinuationRuntimeV1EmbeddingProvider,
} from "./embedding-provider.js";
import {
  ContinuationRuntimeV1VectorArtifactError,
  type ContinuationRuntimeV1VectorArtifactRef,
  type ContinuationRuntimeV1VectorArtifactStore,
} from "./vector-artifact-store.js";
import {
  ContinuationRuntimeV1WorkerProcessorError,
  type ContinuationRuntimeV1PreparedWorkerSuccess,
  type ContinuationRuntimeV1WorkerProcessor,
  type ContinuationRuntimeV1WorkerProcessorInput,
} from "./worker-service.js";

type MemoryPort = Pick<
  ReturnType<typeof createContinuationRuntimeV1MemoryStore>,
  "readCapsule" | "readMemoryItem"
>;
type DurableJobPort = Pick<
  ReturnType<typeof createContinuationRuntimeV1DurableJobEnqueuer>,
  "enqueue"
>;

export type ContinuationRuntimeV1EmbeddingWorkerProcessorInput = Readonly<{
  memoryStore: MemoryPort;
  provider: ContinuationRuntimeV1EmbeddingProvider;
  vectorArtifactStore: ContinuationRuntimeV1VectorArtifactStore;
  durableJobStore: DurableJobPort;
}>;

const FACTORY_KEYS = Object.freeze([
  "durableJobStore", "memoryStore", "provider", "vectorArtifactStore",
] as const);
const PROVIDER_RESULT_KEYS = Object.freeze([
  "dimensions", "model", "schema_version", "vectors",
] as const);

function processorFailure(
  code: string,
  disposition: "retry" | "dead",
): never {
  throw new ContinuationRuntimeV1WorkerProcessorError({ code, disposition });
}

function configurationFailure(): never {
  throw new Error("continuation_runtime_v1_embedding_worker_processor_invalid");
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw new Error("record_invalid");
  }
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

function denseArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length === 0 || value.length > maximum) {
    throw new Error("array_invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1
    || keys.some((key) => typeof key !== "string")) {
    throw new Error("array_invalid");
  }
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("array_invalid");
    }
    out.push(descriptor.value);
  }
  return out;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error("text_invalid");
  assertUnicodeScalarString(value, "embedding worker text");
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error("text_invalid");
  }
  return value;
}

function digest(value: unknown): Sha256 {
  if (typeof value !== "string") throw new Error("digest_invalid");
  assertSha256(value, "embedding worker digest");
  return value;
}

function parsePayload(
  input: ContinuationRuntimeV1WorkerProcessorInput<"embedding">,
): readonly CapsuleRefV1[] {
  try {
    if (input.job.job_kind !== "embedding") throw new Error("job_kind_invalid");
    const payload = parseContinuationRuntimeV1EmbeddingJobPayload(
      input.job.payload,
    );
    if (canonicalContinuationSha256(payload)
        !== input.job.payload_sha256) {
      throw new Error("payload_digest_invalid");
    }
    return payload.capsule_refs;
  } catch {
    processorFailure("embedding_payload_invalid", "dead");
  }
}

function verifiedCapsule(
  value: unknown,
  ref: CapsuleRefV1,
  job: ContinuationRuntimeV1WorkerProcessorInput<"embedding">["job"],
): ExecutionCapsuleV1 {
  try {
    assertExecutionCapsuleV1(value);
    const capsule = value as ExecutionCapsuleV1;
    const { capsule_sha256: _digest, ...body } = capsule;
    if (capsule.capsule_id !== ref.capsule_id
      || capsule.capsule_revision !== ref.capsule_revision
      || capsule.capsule_sha256 !== ref.capsule_sha256
      || canonicalContinuationSha256(body) !== ref.capsule_sha256
      || capsule.applicability.tenant_id !== job.tenant_id
      || capsule.applicability.scope !== job.scope
      || capsule.applicability.task_family !== job.task_family) {
      throw new Error("capsule_binding_invalid");
    }
    digest(capsule.source.source_projection_sha256);
    return canonicalContinuationClone(capsule);
  } catch {
    processorFailure("embedding_capsule_binding_invalid", "dead");
  }
}

function parseProviderResult(
  value: ContinuationRuntimeV1EmbeddingBatchResult,
  expectedCount: number,
): ContinuationRuntimeV1EmbeddingBatchResult {
  try {
    const record = exactRecord(value, PROVIDER_RESULT_KEYS);
    if (record.schema_version !== "embedding_batch_result_v1"
      || !Number.isSafeInteger(record.dimensions)
      || (record.dimensions as number) < 1
      || (record.dimensions as number) > 65_536) {
      throw new Error("provider_result_invalid");
    }
    const model = boundedText(record.model, 256);
    const dimensions = record.dimensions as number;
    const vectors = denseArray(record.vectors, expectedCount);
    if (vectors.length !== expectedCount) throw new Error("provider_result_count");
    const checked = vectors.map((vector) => {
      const values = denseArray(vector, dimensions);
      if (values.length !== dimensions) throw new Error("provider_vector_dimensions");
      return Object.freeze(values.map((component) => {
        if (typeof component !== "number" || !Number.isFinite(component)) {
          throw new Error("provider_vector_component");
        }
        return component;
      }));
    });
    return Object.freeze({
      schema_version: "embedding_batch_result_v1" as const,
      model,
      dimensions,
      vectors: Object.freeze(checked),
    });
  } catch {
    processorFailure("embedding_provider_contract_invalid", "dead");
  }
}

function mapProviderFailure(error: unknown): never {
  if (!(error instanceof ContinuationRuntimeV1EmbeddingProviderError)) {
    processorFailure("embedding_provider_unavailable", "retry");
  }
  switch (error.code) {
    case "request_aborted":
    case "lease_deadline_exceeded":
      processorFailure("embedding_provider_interrupted", "retry");
    case "transport_failure":
    case "provider_http_failure":
      processorFailure("embedding_provider_unavailable", "retry");
    case "configuration_invalid":
    case "input_invalid":
    case "provider_response_too_large":
    case "provider_response_malformed":
    case "provider_response_model_mismatch":
    case "provider_response_dimensions_mismatch":
    case "provider_response_vector_invalid":
      processorFailure("embedding_provider_contract_invalid", "dead");
  }
}

function mapSidecarFailure(error: unknown): never {
  if (!(error instanceof ContinuationRuntimeV1VectorArtifactError)) {
    processorFailure("embedding_sidecar_unavailable", "retry");
  }
  switch (error.code) {
    case "io_failure":
      processorFailure("embedding_sidecar_unavailable", "retry");
    case "symlink_forbidden":
    case "artifact_conflict":
    case "artifact_tampered":
      processorFailure("embedding_sidecar_integrity_failure", "dead");
    case "configuration_invalid":
    case "input_invalid":
    case "path_invalid":
      processorFailure("embedding_sidecar_contract_invalid", "dead");
    case "scan_limit_exceeded":
      processorFailure("embedding_sidecar_contract_invalid", "dead");
  }
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) processorFailure("embedding_processor_aborted", "retry");
}

function assertVectorRefBinding(args: Readonly<{
  ref: ContinuationRuntimeV1VectorArtifactRef;
  sourceProjectionSha256: Sha256;
  embeddingDocumentSha256: Sha256;
  model: string;
  dimensions: number;
}>): ContinuationRuntimeV1EmbeddingVectorArtifactRefV1 {
  try {
    const ref = parseContinuationRuntimeV1EmbeddingVectorArtifactRef(args.ref);
    if (ref.source_projection_sha256 !== args.sourceProjectionSha256
      || ref.embedding_document_sha256 !== args.embeddingDocumentSha256
      || ref.model !== args.model
      || ref.dimensions !== args.dimensions) {
      throw new Error("vector_ref_binding_invalid");
    }
    return ref;
  } catch {
    processorFailure("embedding_sidecar_contract_invalid", "dead");
  }
}

function assertCommitBinding(
  received: Parameters<
    NonNullable<ContinuationRuntimeV1PreparedWorkerSuccess<"embedding">["commitAuthority"]>
  >[0],
  expectedJob: ContinuationRuntimeV1WorkerProcessorInput<"embedding">["job"],
  expectedOutput: ContinuationRuntimeV1PreparedWorkerSuccess<"embedding">["output"],
): void {
  try {
    if (canonicalContinuationJson(received.job)
        !== canonicalContinuationJson(expectedJob)
      || canonicalContinuationJson(received.output)
        !== canonicalContinuationJson(expectedOutput)) {
      throw new Error("commit_binding_invalid");
    }
  } catch {
    processorFailure("embedding_commit_binding_invalid", "dead");
  }
}

export function createContinuationRuntimeV1EmbeddingWorkerProcessor(
  value: ContinuationRuntimeV1EmbeddingWorkerProcessorInput,
): ContinuationRuntimeV1WorkerProcessor<"embedding"> {
  let dependencies: ContinuationRuntimeV1EmbeddingWorkerProcessorInput;
  try {
    const record = exactRecord(value, FACTORY_KEYS);
    const memoryStore = record.memoryStore as MemoryPort;
    const provider = record.provider as ContinuationRuntimeV1EmbeddingProvider;
    const vectorArtifactStore = record.vectorArtifactStore as
      ContinuationRuntimeV1VectorArtifactStore;
    const durableJobStore = record.durableJobStore as DurableJobPort;
    if (!memoryStore || typeof memoryStore.readCapsule !== "function"
      || typeof memoryStore.readMemoryItem !== "function"
      || !provider || typeof provider.embed !== "function"
      || !vectorArtifactStore || typeof vectorArtifactStore.write !== "function"
      || !durableJobStore || typeof durableJobStore.enqueue !== "function") {
      configurationFailure();
    }
    dependencies = { memoryStore, provider, vectorArtifactStore, durableJobStore };
  } catch {
    configurationFailure();
  }

  return Object.freeze({
    worker_role: "embedding" as const,
    async process(
      input: ContinuationRuntimeV1WorkerProcessorInput<"embedding">,
    ): Promise<ContinuationRuntimeV1PreparedWorkerSuccess<"embedding">> {
      checkSignal(input.signal);
      const refs = parsePayload(input);
      const documents: ContinuationRuntimeV1EmbeddingDocumentV1[] = [];
      for (const ref of refs) {
        checkSignal(input.signal);
        let value: unknown;
        try {
          value = await dependencies.memoryStore.readCapsule(
            input.job.tenant_id,
            input.job.scope,
            ref.capsule_id,
            ref.capsule_revision,
          );
        } catch (error) {
          if (error instanceof Error
            && error.message.startsWith("continuation_runtime_v1_memory_corrupt:")) {
            processorFailure("embedding_capsule_corrupt", "dead");
          }
          processorFailure("embedding_capsule_read_failed", "retry");
        }
        if (value === null) processorFailure("embedding_capsule_missing", "dead");
        const capsule = verifiedCapsule(value, ref, input.job);
        let source: Awaited<ReturnType<MemoryPort["readMemoryItem"]>>;
        try {
          source = await dependencies.memoryStore.readMemoryItem(
            input.job.tenant_id,
            input.job.scope,
            capsule.source.memory_id,
          );
        } catch (error) {
          if (error instanceof Error
            && error.message.startsWith("continuation_runtime_v1_memory_corrupt:")) {
            processorFailure("embedding_source_not_serviceable", "dead");
          }
          processorFailure("embedding_source_read_failed", "retry");
        }
        const acquiredAt = input.job.lease_acquired_at;
        if (source === null
          || source.lifecycle !== "active"
          || source.hydrated !== true
          || source.projection_sha256 !== capsule.source.source_projection_sha256
          || source.memory_kind !== capsule.kind
          || (source.expires_at !== null && acquiredAt >= source.expires_at)
          || (capsule.expires_at !== null && acquiredAt >= capsule.expires_at)) {
          processorFailure("embedding_source_not_serviceable", "dead");
        }
        documents.push(buildContinuationRuntimeV1EmbeddingDocument(capsule));
      }

      checkSignal(input.signal);
      let providerValue: ContinuationRuntimeV1EmbeddingBatchResult;
      try {
        providerValue = await dependencies.provider.embed({
          schema_version: "embedding_batch_input_v1",
          texts: documents.map((document) => canonicalContinuationJson(document)),
          lease_deadline_at: input.job.lease_expires_at,
          signal: input.signal,
        });
      } catch (error) {
        mapProviderFailure(error);
      }
      const providerResult = parseProviderResult(providerValue!, documents.length);
      const artifacts: ContinuationRuntimeV1EmbeddingArtifactMemberRefV1[] = [];
      for (let index = 0; index < documents.length; index += 1) {
        checkSignal(input.signal);
        const document = documents[index]!;
        const documentSha256 = continuationRuntimeV1EmbeddingDocumentSha256(
          document,
        );
        let vectorRef: ContinuationRuntimeV1VectorArtifactRef;
        try {
          vectorRef = await dependencies.vectorArtifactStore.write({
            schema_version: "vector_artifact_write_v1",
            source_projection_sha256: document.source_projection_sha256,
            embedding_document_sha256: documentSha256,
            model: providerResult.model,
            dimensions: providerResult.dimensions,
            vector: providerResult.vectors[index]!,
          });
        } catch (error) {
          mapSidecarFailure(error);
        }
        const boundVectorRef = assertVectorRefBinding({
          ref: vectorRef!,
          sourceProjectionSha256: document.source_projection_sha256,
          embeddingDocumentSha256: documentSha256,
          model: providerResult.model,
          dimensions: providerResult.dimensions,
        });
        artifacts.push(canonicalContinuationClone({
          capsule_ref: refs[index]!,
          embedding_document_sha256: documentSha256,
          vector_artifact_ref: boundVectorRef,
        }));
      }
      const setRef = buildContinuationRuntimeV1EmbeddingArtifactSetRef(
        Object.freeze(artifacts),
      );
      const output = canonicalContinuationClone({
        kind: "embedding" as const,
        artifact_ref: setRef,
      });
      const parentJob = canonicalContinuationClone(input.job);
      const childPayload = buildContinuationRuntimeV1AnnJobPayload(setRef);
      const childPayloadSha256 = canonicalContinuationSha256(childPayload);
      const parentOutputSha256 = canonicalContinuationSha256(output);
      const dedupeDigest = canonicalContinuationSha256({
        schema_version: "embedding_ann_child_dedupe_v1",
        parent_job_id: parentJob.job_id,
        parent_payload_sha256: parentJob.payload_sha256,
        parent_output_sha256: parentOutputSha256,
        child_payload_sha256: childPayloadSha256,
      });
      return Object.freeze({
        output,
        async commitAuthority(commitInput) {
          assertCommitBinding(commitInput, parentJob, output);
          try {
            await dependencies.durableJobStore.enqueue(commitInput.context, {
              task_family: parentJob.task_family,
              authority_subject_sha256: parentJob.authority_subject_sha256,
              job_kind: "ann",
              dedupe_key: `embedding-ann-${dedupeDigest}`,
              priority: 0,
              max_attempts: parentJob.max_attempts,
              payload: childPayload,
              available_at: parentJob.lease_acquired_at,
            });
          } catch (error) {
            if (error instanceof Error
              && (error.message
                  === "continuation_runtime_v1_durable_job_payload_conflict"
                || error.message
                  === "continuation_runtime_v1_durable_job_definition_conflict")) {
              processorFailure("embedding_ann_child_conflict", "dead");
            }
            processorFailure("embedding_ann_enqueue_failed", "retry");
          }
        },
      });
    },
  });
}
