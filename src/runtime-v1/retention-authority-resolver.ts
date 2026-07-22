import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type CapsuleRefV1,
  type Sha256,
} from "../continuation/contract.js";
import type { ContinuationRuntimeV1Database } from
  "../store/continuation-runtime-v1-database.js";
import {
  createContinuationRuntimeV1DurableJobWorkerStore,
  type ContinuationRuntimeV1DurableJob,
} from "../store/continuation-runtime-v1-durable-job-store.js";
import { createContinuationRuntimeV1MemoryStore } from
  "../store/continuation-runtime-v1-memory-store.js";
import { createContinuationRuntimeV1OperationStore } from
  "../store/continuation-runtime-v1-operation-store.js";
import {
  buildAuthorityDecisionCommandV1,
  buildWorkerCompletionCommandV1,
} from "./command.js";
import { operationRequestFromVerifiedCommandV1 } from "./operation-request.js";
import {
  buildContinuationRuntimeV1EmbeddingDocument,
  continuationRuntimeV1EmbeddingDocumentSha256,
  parseContinuationRuntimeV1AnnJobPayload,
  parseContinuationRuntimeV1EmbeddingArtifactSetRef,
  parseContinuationRuntimeV1EmbeddingJobPayload,
  type ContinuationRuntimeV1EmbeddingVectorArtifactRefV1,
} from "./embedding-job-contract.js";
import {
  parseContinuationRuntimeV1AnnIndexReceipt,
  type ContinuationRuntimeV1AnnIndexSegmentRefV1,
} from "./ann-index-segment-store.js";
import { parseContinuationRuntimeV1RetentionJobPayload } from
  "./retention-job-contract.js";
import type { ContinuationRuntimeV1WorkerAttemptJob } from
  "./worker-service.js";
import { continuationRuntimeV1WorkerPrincipal } from
  "./worker-identity.js";

const MAX_SCOPE_EMBEDDING_JOBS = 32_768;

export type ContinuationRuntimeV1RetentionAuthorityPlanV1 = Readonly<{
  schema_version: "retention_authority_plan_v1";
  authority_plan_sha256: Sha256;
  target_capsule_refs: readonly CapsuleRefV1[];
  embedding_document_sha256s: readonly Sha256[];
  vector_artifact_refs: readonly ContinuationRuntimeV1EmbeddingVectorArtifactRefV1[];
  ann_segment_refs: readonly ContinuationRuntimeV1AnnIndexSegmentRefV1[];
}>;

export type ContinuationRuntimeV1RetentionAuthorityErrorCode =
  | "invalid"
  | "pending"
  | "unavailable";

export class ContinuationRuntimeV1RetentionAuthorityError extends Error {
  constructor(readonly code: ContinuationRuntimeV1RetentionAuthorityErrorCode) {
    super("continuation_runtime_v1_retention_authority_resolution_failed");
    this.name = "ContinuationRuntimeV1RetentionAuthorityError";
  }
}

export type ContinuationRuntimeV1RetentionAuthorityResolver = Readonly<{
  resolve(
    job: ContinuationRuntimeV1WorkerAttemptJob<"retention">,
  ): Promise<ContinuationRuntimeV1RetentionAuthorityPlanV1>;
}>;

function authorityFailure(
  code: ContinuationRuntimeV1RetentionAuthorityErrorCode,
): never {
  throw new ContinuationRuntimeV1RetentionAuthorityError(code);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) authorityFailure("invalid");
  const actual = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !expected.has(key))) {
    authorityFailure("invalid");
  }
  for (const key of actual as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      authorityFailure("invalid");
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalContinuationJson(left) === canonicalContinuationJson(right);
}

function capsuleRefKey(ref: CapsuleRefV1): string {
  return canonicalContinuationJson(ref);
}

function canonicalUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  const byKey = new Map<string, T>();
  for (const value of values) byKey.set(key(value), value);
  return Object.freeze([...byKey.entries()]
    .sort(([left], [right]) => compareCanonicalUtf8(left, right))
    .map(([, value]) => value));
}

function isAuthorityIntegrityFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:_corrupt(?::|$)|_mismatch$|_invalid$|_conflict$)/u.test(error.message);
}

function asResolverFailure(error: unknown): never {
  if (error instanceof ContinuationRuntimeV1RetentionAuthorityError) throw error;
  authorityFailure(isAuthorityIntegrityFailure(error) ? "invalid" : "unavailable");
}

export function createContinuationRuntimeV1RetentionAuthorityResolver(
  database: ContinuationRuntimeV1Database,
): ContinuationRuntimeV1RetentionAuthorityResolver {
  if (!database || typeof database !== "object"
    || typeof database.databaseInstanceId !== "string"
    || typeof database.read !== "function") {
    throw new Error("continuation_runtime_v1_retention_authority_resolver_invalid");
  }
  const jobs = createContinuationRuntimeV1DurableJobWorkerStore(database);
  const operations = createContinuationRuntimeV1OperationStore(database);
  const memory = createContinuationRuntimeV1MemoryStore(database);

  async function readJob(
    tenantId: string,
    scope: string,
    jobId: string,
  ): Promise<ContinuationRuntimeV1DurableJob> {
    const job = await jobs.read({ tenant_id: tenantId, scope, job_id: jobId });
    if (!job) authorityFailure("invalid");
    return job;
  }

  async function verifiedWorkerSuccess(
    job: ContinuationRuntimeV1DurableJob,
    role: "embedding" | "ann",
  ) {
    if (job.job_kind !== role || job.state !== "succeeded"
      || job.terminal_reason !== "worker_succeeded"
      || job.completion_operation === null) authorityFailure("invalid");
    const lineage = job.completion_operation;
    const principal = continuationRuntimeV1WorkerPrincipal({
      database_instance_id: database.databaseInstanceId as Sha256,
      worker_role: role,
    });
    if (lineage.operation_kind !== "worker_completion"
      || lineage.actor_kind !== "worker"
      || lineage.actor_principal_sha256 !== principal.actor_principal_sha256) {
      authorityFailure("invalid");
    }
    const operation = await operations.read({
      tenantId: job.tenant_id,
      scope: job.scope,
      operationKind: "worker_completion",
      operationId: lineage.operation_id,
    });
    if (!operation || operation.request_sha256 !== lineage.request_sha256) {
      authorityFailure("invalid");
    }
    const request = exactRecord(operation.request, [
      "actor_kind", "actor_principal_sha256", "authority_subject_sha256",
      "body", "body_sha256", "leased_job_binding", "operation_id",
      "operation_kind", "schema_version", "scope", "tenant_id",
    ]);
    const leased = exactRecord(request.leased_job_binding, [
      "attempt_count", "job_id", "job_kind", "job_payload_sha256",
      "lease_token_sha256",
    ]);
    if (typeof leased.lease_token_sha256 !== "string") authorityFailure("invalid");
    const rebuilt = buildWorkerCompletionCommandV1(lineage.operation_id, {
      schema_version: "worker_completion_body_v1",
      ...exactRecord(request.body, ["completion", "schema_version"]),
    }, {
      tenant_id: job.tenant_id,
      scope: job.scope,
      actor_kind: "worker",
      actor_principal_sha256: principal.actor_principal_sha256,
      task_family: job.task_family,
      authority_subject_sha256: job.authority_subject_sha256 as Sha256,
      job_id: job.job_id,
      job_kind: role,
      job_payload_sha256: job.payload_sha256 as Sha256,
      attempt_count: job.attempt_count,
      lease_token_sha256: leased.lease_token_sha256 as Sha256,
    });
    if (rebuilt.command_sha256 !== operation.request_sha256
      || !same(operationRequestFromVerifiedCommandV1(rebuilt), operation.request)
      || operation.receipt.actor_principal_sha256
        !== principal.actor_principal_sha256) authorityFailure("invalid");
    const completion = rebuilt.body.completion;
    if (completion.status !== "succeeded" || completion.output.kind !== role) {
      authorityFailure("invalid");
    }
    const result = operation.receipt.result;
    if (result.schema_version !== "worker_completion_result_v1"
      || result.transition_ref.job_id !== job.job_id
      || result.transition_ref.job_kind !== role
      || result.transition_ref.state !== "succeeded"
      || result.transition_ref.payload_sha256 !== job.payload_sha256) {
      authorityFailure("invalid");
    }
    return completion.output;
  }

  async function resolve(
    attempt: ContinuationRuntimeV1WorkerAttemptJob<"retention">,
  ): Promise<ContinuationRuntimeV1RetentionAuthorityPlanV1> {
    try {
      if (attempt.job_kind !== "retention") authorityFailure("invalid");
      const payload = parseContinuationRuntimeV1RetentionJobPayload(attempt.payload);
      if (canonicalContinuationSha256(payload) !== attempt.payload_sha256) {
        authorityFailure("invalid");
      }
      const retention = await readJob(
        attempt.tenant_id,
        attempt.scope,
        attempt.job_id,
      );
      if (retention.job_kind !== "retention" || retention.state !== "leased"
        || retention.attempt_count !== attempt.attempt_count
        || retention.payload_sha256 !== attempt.payload_sha256
        || retention.task_family !== attempt.task_family
        || retention.authority_subject_sha256
          !== attempt.authority_subject_sha256
        || !same(retention.payload, payload)
        || retention.source_operation.operation_kind !== "authority_decision") {
        authorityFailure("invalid");
      }

      const source = retention.source_operation;
      const authorityOperation = await operations.read({
        tenantId: retention.tenant_id,
        scope: retention.scope,
        operationKind: "authority_decision",
        operationId: source.operation_id,
      });
      if (!authorityOperation
        || authorityOperation.request_sha256 !== source.request_sha256
        || authorityOperation.receipt.actor_kind !== "operator"
        || authorityOperation.receipt.actor_principal_sha256
          !== source.actor_principal_sha256) authorityFailure("invalid");
      const authorityRequest = exactRecord(authorityOperation.request, [
        "actor_kind", "actor_principal_sha256", "authority_subject_sha256",
        "body", "body_sha256", "operation_id", "operation_kind",
        "schema_version", "scope", "task_family", "tenant_id",
      ]);
      const archiveCommand = buildAuthorityDecisionCommandV1(
        source.operation_id,
        authorityRequest.body,
        {
          tenant_id: retention.tenant_id,
          scope: retention.scope,
          actor_kind: "operator",
          actor_principal_sha256: source.actor_principal_sha256 as Sha256,
          task_family: retention.task_family,
          authority_subject_sha256:
            retention.authority_subject_sha256 as Sha256,
        },
      );
      if (archiveCommand.command_sha256 !== source.request_sha256
        || !same(
          operationRequestFromVerifiedCommandV1(archiveCommand),
          authorityOperation.request,
        )
        || archiveCommand.body.decision.kind !== "lifecycle_archive") {
        authorityFailure("invalid");
      }
      const authorityResult = authorityOperation.receipt.result;
      if (authorityResult.schema_version !== "authority_decision_result_v1"
        || authorityResult.decision_kind !== "lifecycle_archive"
        || authorityResult.retention_job_ref.job_id !== retention.job_id
        || authorityResult.retention_job_ref.payload_sha256
          !== retention.payload_sha256
        || authorityResult.retention_job_ref.job_kind !== "retention") {
        authorityFailure("invalid");
      }
      const decision = archiveCommand.body.decision;
      const archived = await memory.readMemoryItem(
        retention.tenant_id,
        retention.scope,
        decision.memory_id,
      );
      if (!archived || archived.lifecycle !== "archived"
        || archived.hydrated !== false
        || archived.rehydration_ref !== decision.rehydration_ref
        || archived.source_commit_id
          !== authorityResult.memory_revision_ref.commit_id
        || archived.source_commit_sha256
          !== authorityResult.memory_revision_ref.commit_sha256) {
        authorityFailure("invalid");
      }

      const capsuleRows = await database.read(() => database.db.prepare(
        `SELECT capsule_id, capsule_revision, capsule_sha256
           FROM capsule_revisions
          WHERE tenant_id = ? AND scope = ? AND memory_id = ?
          ORDER BY capsule_id, capsule_revision`,
      ).all(retention.tenant_id, retention.scope, decision.memory_id) as readonly {
        capsule_id?: unknown;
        capsule_revision?: unknown;
        capsule_sha256?: unknown;
      }[]);
      const targetCapsules: CapsuleRefV1[] = [];
      const targetDocumentSha256s: Sha256[] = [];
      for (const row of capsuleRows) {
        if (typeof row.capsule_id !== "string"
          || !Number.isSafeInteger(row.capsule_revision)
          || typeof row.capsule_sha256 !== "string") authorityFailure("invalid");
        const capsule = await memory.readCapsule(
          retention.tenant_id,
          retention.scope,
          row.capsule_id,
          row.capsule_revision as number,
        );
        if (!capsule || capsule.capsule_sha256 !== row.capsule_sha256
          || capsule.source.memory_id !== decision.memory_id
          || capsule.applicability.task_family.length === 0) {
          authorityFailure("invalid");
        }
        targetCapsules.push(canonicalContinuationClone({
          capsule_id: capsule.capsule_id,
          capsule_revision: capsule.capsule_revision,
          capsule_sha256: capsule.capsule_sha256,
        }));
        targetDocumentSha256s.push(
          continuationRuntimeV1EmbeddingDocumentSha256(
            buildContinuationRuntimeV1EmbeddingDocument(capsule),
          ),
        );
      }
      const targetKeys = new Set(targetCapsules.map(capsuleRefKey));
      const embeddingRows = await database.read(() => database.db.prepare(
        `SELECT job_id FROM durable_jobs
          WHERE tenant_id = ? AND scope = ? AND job_kind = 'embedding'
          ORDER BY job_id LIMIT ?`,
      ).all(
        retention.tenant_id,
        retention.scope,
        MAX_SCOPE_EMBEDDING_JOBS + 1,
      ) as readonly { job_id?: unknown }[]);
      if (embeddingRows.length > MAX_SCOPE_EMBEDDING_JOBS) {
        authorityFailure("unavailable");
      }

      const vectorRefs: ContinuationRuntimeV1EmbeddingVectorArtifactRefV1[] = [];
      const segmentRefs: ContinuationRuntimeV1AnnIndexSegmentRefV1[] = [];
      for (const row of embeddingRows) {
        if (typeof row.job_id !== "string") authorityFailure("invalid");
        const embedding = await readJob(
          retention.tenant_id,
          retention.scope,
          row.job_id,
        );
        let embeddingPayload;
        try {
          embeddingPayload = parseContinuationRuntimeV1EmbeddingJobPayload(
            embedding.payload,
          );
        } catch {
          continue;
        }
        if (!embeddingPayload.capsule_refs.some(
          (ref) => targetKeys.has(capsuleRefKey(ref)),
        )) continue;
        if (embedding.state === "queued" || embedding.state === "leased") {
          authorityFailure("pending");
        }
        if (embedding.state === "dead") continue;
        const embeddingOutput = await verifiedWorkerSuccess(embedding, "embedding");
        if (embeddingOutput.kind !== "embedding") authorityFailure("invalid");
        const artifactSet = parseContinuationRuntimeV1EmbeddingArtifactSetRef(
          embeddingOutput.artifact_ref,
        );
        if (!same(
          artifactSet.artifacts.map((member) => member.capsule_ref),
          embeddingPayload.capsule_refs,
        )) authorityFailure("invalid");
        for (const member of artifactSet.artifacts) {
          const capsule = await memory.readCapsule(
            retention.tenant_id,
            retention.scope,
            member.capsule_ref.capsule_id,
            member.capsule_ref.capsule_revision,
          );
          if (!capsule
            || capsule.capsule_sha256 !== member.capsule_ref.capsule_sha256
            || continuationRuntimeV1EmbeddingDocumentSha256(
              buildContinuationRuntimeV1EmbeddingDocument(capsule),
            ) !== member.embedding_document_sha256) authorityFailure("invalid");
          if (targetKeys.has(capsuleRefKey(member.capsule_ref))) {
            vectorRefs.push(member.vector_artifact_ref);
          }
        }

        const completion = embedding.completion_operation!;
        const annRows = await database.read(() => database.db.prepare(
          `SELECT job_id FROM durable_jobs
            WHERE tenant_id = ? AND scope = ? AND job_kind = 'ann'
              AND source_operation_kind = 'worker_completion'
              AND source_operation_id = ? AND source_request_sha256 = ?
            ORDER BY job_id`,
        ).all(
          retention.tenant_id,
          retention.scope,
          completion.operation_id,
          completion.request_sha256,
        ) as readonly { job_id?: unknown }[]);
        if (annRows.length !== 1 || typeof annRows[0]!.job_id !== "string") {
          authorityFailure("invalid");
        }
        const ann = await readJob(
          retention.tenant_id,
          retention.scope,
          annRows[0]!.job_id,
        );
        const annPayload = parseContinuationRuntimeV1AnnJobPayload(ann.payload);
        if (!same(annPayload.embedding_artifact_set_ref, artifactSet)) {
          authorityFailure("invalid");
        }
        if (ann.state === "queued" || ann.state === "leased") {
          authorityFailure("pending");
        }
        if (ann.state === "succeeded") {
          const annOutput = await verifiedWorkerSuccess(ann, "ann");
          if (annOutput.kind !== "ann") authorityFailure("invalid");
          const receipt = parseContinuationRuntimeV1AnnIndexReceipt(
            annOutput.index_receipt,
          );
          if (receipt.source_job_payload_sha256 !== ann.payload_sha256
            || receipt.artifact_set_sha256 !== artifactSet.artifact_set_sha256) {
            authorityFailure("invalid");
          }
          segmentRefs.push(receipt.segment_ref);
        }
      }

      const vectors = canonicalUnique(
        vectorRefs,
        (ref) => canonicalContinuationJson(ref),
      );
      const segments = canonicalUnique(
        segmentRefs,
        (ref) => canonicalContinuationJson(ref),
      );
      const planBody = canonicalContinuationClone({
        schema_version: "retention_authority_plan_v1" as const,
        archive_operation_request_sha256: source.request_sha256,
        archived_memory_id: decision.memory_id,
        rehydration_ref: decision.rehydration_ref,
        target_capsule_refs: targetCapsules,
        embedding_document_sha256s: canonicalUnique(
          targetDocumentSha256s,
          (digest) => digest,
        ),
        vector_artifact_refs: vectors,
        ann_segment_refs: segments,
      });
      return canonicalContinuationClone({
        schema_version: "retention_authority_plan_v1" as const,
        authority_plan_sha256: canonicalContinuationSha256(planBody),
        target_capsule_refs: targetCapsules,
        embedding_document_sha256s: planBody.embedding_document_sha256s,
        vector_artifact_refs: vectors,
        ann_segment_refs: segments,
      });
    } catch (error) {
      asResolverFailure(error);
    }
  }

  return Object.freeze({ resolve });
}
