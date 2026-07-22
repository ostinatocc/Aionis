import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
} from "../continuation/contract.js";
import {
  ContinuationRuntimeV1AnnIndexSegmentError,
  type ContinuationRuntimeV1AnnIndexSegmentStore,
} from "./ann-index-segment-store.js";
import {
  ContinuationRuntimeV1RetentionAuthorityError,
  type ContinuationRuntimeV1RetentionAuthorityResolver,
} from "./retention-authority-resolver.js";
import { parseContinuationRuntimeV1RetentionJobPayload } from
  "./retention-job-contract.js";
import {
  ContinuationRuntimeV1VectorArtifactError,
  type ContinuationRuntimeV1VectorArtifactStore,
} from "./vector-artifact-store.js";
import {
  ContinuationRuntimeV1WorkerProcessorError,
  type ContinuationRuntimeV1PreparedWorkerSuccess,
  type ContinuationRuntimeV1WorkerProcessor,
  type ContinuationRuntimeV1WorkerProcessorInput,
} from "./worker-service.js";

const FACTORY_KEYS = Object.freeze([
  "authorityResolver", "indexSegmentStore", "vectorArtifactStore",
] as const);

export type ContinuationRuntimeV1RetentionWorkerProcessorInput = Readonly<{
  authorityResolver: ContinuationRuntimeV1RetentionAuthorityResolver;
  indexSegmentStore: Pick<ContinuationRuntimeV1AnnIndexSegmentStore,
  "delete" | "discoverByCapsuleRefs">;
  vectorArtifactStore: Pick<ContinuationRuntimeV1VectorArtifactStore,
  "delete" | "discoverByEmbeddingDocumentSha256s">;
}>;

function processorFailure(
  code: string,
  disposition: "retry" | "dead",
): never {
  throw new ContinuationRuntimeV1WorkerProcessorError({ code, disposition });
}

function configurationFailure(): never {
  throw new Error("continuation_runtime_v1_retention_worker_processor_invalid");
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) configurationFailure();
  const actual = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !expected.has(key))) {
    configurationFailure();
  }
  for (const key of actual as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      configurationFailure();
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) processorFailure("retention_processor_aborted", "retry");
}

function mapAuthorityFailure(error: unknown): never {
  if (!(error instanceof ContinuationRuntimeV1RetentionAuthorityError)) {
    processorFailure("retention_authority_unavailable", "retry");
  }
  if (error.code === "invalid") {
    processorFailure("retention_authority_invalid", "dead");
  }
  if (error.code === "pending") {
    processorFailure("retention_authority_pending", "retry");
  }
  processorFailure("retention_authority_unavailable", "retry");
}

function mapVectorFailure(error: unknown): never {
  if (!(error instanceof ContinuationRuntimeV1VectorArtifactError)) {
    processorFailure("retention_sidecar_unavailable", "retry");
  }
  switch (error.code) {
    case "io_failure":
      processorFailure("retention_sidecar_unavailable", "retry");
    case "symlink_forbidden":
    case "artifact_conflict":
    case "artifact_tampered":
      processorFailure("retention_sidecar_integrity_failure", "dead");
    case "configuration_invalid":
    case "input_invalid":
    case "path_invalid":
      processorFailure("retention_sidecar_contract_invalid", "dead");
    case "scan_limit_exceeded":
      processorFailure("retention_sidecar_capacity_exceeded", "dead");
  }
}

function mapIndexFailure(error: unknown): never {
  if (!(error instanceof ContinuationRuntimeV1AnnIndexSegmentError)) {
    processorFailure("retention_sidecar_unavailable", "retry");
  }
  switch (error.code) {
    case "io_failure":
      processorFailure("retention_sidecar_unavailable", "retry");
    case "symlink_forbidden":
    case "segment_conflict":
    case "segment_tampered":
      processorFailure("retention_sidecar_integrity_failure", "dead");
    case "configuration_invalid":
    case "input_invalid":
    case "path_invalid":
      processorFailure("retention_sidecar_contract_invalid", "dead");
    case "scan_limit_exceeded":
      processorFailure("retention_sidecar_capacity_exceeded", "dead");
  }
}

function canonicalRefUnion<T>(values: readonly T[]): readonly T[] {
  const refs = new Map<string, T>();
  for (const value of values) refs.set(canonicalContinuationJson(value), value);
  return Object.freeze([...refs.entries()]
    .sort(([left], [right]) => compareCanonicalUtf8(left, right))
    .map(([, value]) => value));
}

/**
 * Deletes only content-addressed, rebuildable vector and ANN sidecars selected
 * by an authenticated archive authority plan. No database authority mutation
 * port is exposed to this processor.
 */
export function createContinuationRuntimeV1RetentionWorkerProcessor(
  value: ContinuationRuntimeV1RetentionWorkerProcessorInput,
): ContinuationRuntimeV1WorkerProcessor<"retention"> {
  let dependencies: ContinuationRuntimeV1RetentionWorkerProcessorInput;
  try {
    const record = exactRecord(value, FACTORY_KEYS);
    const authorityResolver = record.authorityResolver as
      ContinuationRuntimeV1RetentionAuthorityResolver;
    const indexSegmentStore = record.indexSegmentStore as
      ContinuationRuntimeV1RetentionWorkerProcessorInput["indexSegmentStore"];
    const vectorArtifactStore = record.vectorArtifactStore as
      ContinuationRuntimeV1RetentionWorkerProcessorInput["vectorArtifactStore"];
    if (!authorityResolver || typeof authorityResolver.resolve !== "function"
      || !indexSegmentStore || typeof indexSegmentStore.delete !== "function"
      || typeof indexSegmentStore.discoverByCapsuleRefs !== "function"
      || !vectorArtifactStore || typeof vectorArtifactStore.delete !== "function"
      || typeof vectorArtifactStore.discoverByEmbeddingDocumentSha256s
        !== "function") {
      configurationFailure();
    }
    dependencies = Object.freeze({
      authorityResolver,
      indexSegmentStore,
      vectorArtifactStore,
    });
  } catch (error) {
    if (error instanceof Error
      && error.message === "continuation_runtime_v1_retention_worker_processor_invalid") {
      throw error;
    }
    configurationFailure();
  }

  return Object.freeze({
    worker_role: "retention" as const,
    async process(
      input: ContinuationRuntimeV1WorkerProcessorInput<"retention">,
    ): Promise<ContinuationRuntimeV1PreparedWorkerSuccess<"retention">> {
      checkSignal(input.signal);
      try {
        if (input.job.job_kind !== "retention") throw new Error("kind");
        const payload = parseContinuationRuntimeV1RetentionJobPayload(
          input.job.payload,
        );
        if (canonicalContinuationSha256(payload) !== input.job.payload_sha256) {
          throw new Error("digest");
        }
      } catch {
        processorFailure("retention_payload_invalid", "dead");
      }

      let plan;
      try {
        plan = await dependencies.authorityResolver.resolve(input.job);
      } catch (error) {
        mapAuthorityFailure(error);
      }
      let discoveredSegments = [] as Awaited<ReturnType<
        typeof dependencies.indexSegmentStore.discoverByCapsuleRefs
      >>;
      let discoveredVectors = [] as Awaited<ReturnType<
        typeof dependencies.vectorArtifactStore.discoverByEmbeddingDocumentSha256s
      >>;
      try {
        if (plan!.target_capsule_refs.length > 0) {
          discoveredSegments = await dependencies.indexSegmentStore
            .discoverByCapsuleRefs({
              capsule_refs: plan!.target_capsule_refs,
              scan_limit: 32_768,
            });
        }
      } catch (error) {
        mapIndexFailure(error);
      }
      try {
        if (plan!.embedding_document_sha256s.length > 0) {
          discoveredVectors = await dependencies.vectorArtifactStore
            .discoverByEmbeddingDocumentSha256s({
              embedding_document_sha256s: plan!.embedding_document_sha256s,
              scan_limit: 32_768,
            });
        }
      } catch (error) {
        mapVectorFailure(error);
      }
      const annTargets = canonicalRefUnion([
        ...plan!.ann_segment_refs,
        ...discoveredSegments,
      ]);
      const vectorTargets = canonicalRefUnion([
        ...plan!.vector_artifact_refs,
        ...discoveredVectors,
      ]);
      let annRemoved = 0;
      let annMissing = 0;
      for (const ref of annTargets) {
        checkSignal(input.signal);
        let removed: boolean;
        try {
          removed = await dependencies.indexSegmentStore.delete(ref);
        } catch (error) {
          mapIndexFailure(error);
        }
        if (removed!) annRemoved += 1;
        else annMissing += 1;
      }
      let vectorRemoved = 0;
      let vectorMissing = 0;
      for (const ref of vectorTargets) {
        checkSignal(input.signal);
        let removed: boolean;
        try {
          removed = await dependencies.vectorArtifactStore.delete(ref);
        } catch (error) {
          mapVectorFailure(error);
        }
        if (removed!) vectorRemoved += 1;
        else vectorMissing += 1;
      }
      checkSignal(input.signal);
      return Object.freeze({
        output: canonicalContinuationClone({
          kind: "retention" as const,
          result: {
            schema_version: "retention_cleanup_result_v1" as const,
            authority_plan_sha256: plan!.authority_plan_sha256,
            ann_target_count: annTargets.length,
            ann_removed_count: annRemoved,
            ann_missing_count: annMissing,
            vector_target_count: vectorTargets.length,
            vector_removed_count: vectorRemoved,
            vector_missing_count: vectorMissing,
          },
        }),
        async commitAuthority(): Promise<void> {},
      });
    },
  });
}
