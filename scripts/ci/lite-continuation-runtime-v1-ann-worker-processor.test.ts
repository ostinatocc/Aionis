import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
} from "../../src/continuation/contract.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import {
  createContinuationRuntimeV1AnnIndexSegmentStore,
  parseContinuationRuntimeV1AnnIndexReceipt,
} from "../../src/runtime-v1/ann-index-segment-store.js";
import { createContinuationRuntimeV1AnnWorkerProcessor } from
  "../../src/runtime-v1/ann-worker-processor.js";
import {
  buildContinuationRuntimeV1AnnJobPayload,
  buildContinuationRuntimeV1EmbeddingArtifactSetRef,
  type ContinuationRuntimeV1AnnJobPayloadV1,
  type ContinuationRuntimeV1EmbeddingArtifactMemberRefV1,
  type ContinuationRuntimeV1EmbeddingArtifactSetRefV1,
} from "../../src/runtime-v1/embedding-job-contract.js";
import {
  createContinuationRuntimeV1VectorArtifactStore,
  type ContinuationRuntimeV1VectorArtifactRef,
  type ContinuationRuntimeV1VectorArtifactStore,
} from "../../src/runtime-v1/vector-artifact-store.js";
import {
  ContinuationRuntimeV1WorkerProcessorError,
  createContinuationRuntimeV1WorkerService,
  type ContinuationRuntimeV1WorkerAttemptJob,
} from "../../src/runtime-v1/worker-service.js";
import type { ContinuationRuntimeV1WorkerConfig } from
  "../../src/runtime-v1/worker-config.js";
import {
  createContinuationRuntimeV1DurableJobWorkerStore,
  type ContinuationRuntimeV1DurableJob,
} from "../../src/store/continuation-runtime-v1-durable-job-store.js";
import { createContinuationRuntimeV1DurableJobEnqueuer } from
  "../../src/store/continuation-runtime-v1-durable-job-enqueuer.js";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../../src/store/continuation-runtime-v1-database.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.js";
import { createContinuationRuntimeV1ObservationStore } from
  "../../src/store/continuation-runtime-v1-observation-store.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
} from "../../src/store/continuation-runtime-v1-operation-store.js";

const TENANT = "tenant-ann";
const SCOPE = "scope-ann";
const TASK_FAMILY = "coding";
const MODEL = "embedding-model-v1";
const SOURCE_SECRET = "raw-memory-source-must-not-enter-ann";
const PROVIDER_SECRET = "provider-secret-must-not-enter-ann-error";
const AUTHORITY_TABLES = Object.freeze([
  "memory_commits",
  "memory_scope_heads",
  "memory_items",
  "memory_relations",
  "capsule_revisions",
  "observation_snapshots",
  "authority_artifacts",
  "branch_revisions",
  "branch_capsule_bindings",
  "authority_heads",
  "effect_certificates",
  "effect_certificate_treatment_members",
  "episode_events",
  "episode_capsule_facts",
] as const);

type VectorSpec = Readonly<{
  vector: readonly number[];
  model?: string;
}>;

type Fixture = Readonly<{
  root: string;
  dataPath: string;
  vectorRoot: string;
  database: ContinuationRuntimeV1Database;
  jobs: ReturnType<typeof createContinuationRuntimeV1DurableJobWorkerStore>;
  enqueuer: ReturnType<typeof createContinuationRuntimeV1DurableJobEnqueuer>;
  vectorStore: ContinuationRuntimeV1VectorArtifactStore;
  indexStore: ReturnType<typeof createContinuationRuntimeV1AnnIndexSegmentStore>;
  cleanup(): Promise<void>;
}>;

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "aionis-v1-ann-processor-"));
  const dataPath = join(root, "authority", "runtime.sqlite");
  const vectorRoot = `${dataPath}.vector-artifacts-v1`;
  const database = openContinuationRuntimeV1Database(dataPath, {
    databaseInstanceId: "a".repeat(64),
  });
  return {
    root,
    dataPath,
    vectorRoot,
    database,
    jobs: createContinuationRuntimeV1DurableJobWorkerStore(database),
    enqueuer: createContinuationRuntimeV1DurableJobEnqueuer(database),
    vectorStore: createContinuationRuntimeV1VectorArtifactStore({ rootPath: vectorRoot }),
    indexStore: createContinuationRuntimeV1AnnIndexSegmentStore({
      rootPath: join(vectorRoot, "index-segments-v1"),
    }),
    async cleanup() {
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function artifactSet(
  current: Fixture,
  specs: readonly VectorSpec[] = [
    { vector: [1.25, -2.5, 3.75] },
    { vector: [4.5, 5.25, -6.125] },
  ],
): Promise<ContinuationRuntimeV1EmbeddingArtifactSetRefV1> {
  const members: ContinuationRuntimeV1EmbeddingArtifactMemberRefV1[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]!;
    const documentSha256 = createHash("sha256")
      .update(`embedding-document-${index}`)
      .digest("hex");
    const ref = await current.vectorStore.write({
      schema_version: "vector_artifact_write_v1",
      source_projection_sha256: documentSha256,
      embedding_document_sha256: documentSha256,
      model: spec.model ?? MODEL,
      dimensions: spec.vector.length,
      vector: spec.vector,
    });
    members.push({
      capsule_ref: {
        capsule_id: `capsule-${String(index).padStart(2, "0")}`,
        capsule_revision: 1,
        capsule_sha256: createHash("sha256").update(`capsule-${index}`).digest("hex"),
      },
      embedding_document_sha256: documentSha256,
      vector_artifact_ref: ref,
    });
  }
  return buildContinuationRuntimeV1EmbeddingArtifactSetRef(members);
}

async function enqueue(
  current: Fixture,
  payload: ContinuationRuntimeV1AnnJobPayloadV1,
  suffix = "default",
): Promise<ContinuationRuntimeV1DurableJob> {
  const operations = createContinuationRuntimeV1OperationStore(current.database);
  let parentJobId: string | null = null;
  await operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "record_observations",
    operationId: `seed-embedding-parent-${suffix}`,
    actorKind: "trusted_host",
    actorPrincipalSha256: "3".repeat(64),
    request: { seed_parent: suffix },
    produce: async (context) => {
      await createContinuationRuntimeV1ObservationStore(current.database).put(
        context,
        {
          host_task_envelope: {
            host_task_id: `ann-parent-${suffix}`,
            episode_id: `ann-episode-${suffix}`,
            run_id: `ann-run-${suffix}`,
            consumer_agent_id: "agent-ann",
            consumer_team_id: "team-ann",
            task_family: TASK_FAMILY,
            task_signature: "ann-task-profile",
            workflow_signature: null,
            workspace_signature: "ann-workspace-profile",
            source_task_sha256: "5".repeat(64),
            source_event_sha256: "6".repeat(64),
            issued_at: new Date(Date.now() - 60_000).toISOString(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          collector_observations: [],
          signed_observations: [],
        },
      );
      const receipt = await current.enqueuer.enqueue(context, {
        task_family: TASK_FAMILY,
        authority_subject_sha256: continuationAuthoritySubjectSha256V1({
          tenant_id: TENANT,
          scope: SCOPE,
          task_family: TASK_FAMILY,
        }),
        job_kind: "embedding",
        dedupe_key: `embedding-parent-${suffix}`,
        priority: 0,
        max_attempts: 3,
        payload: { seed_parent: suffix },
        available_at: new Date(Date.now() - 1_000).toISOString(),
      });
      parentJobId = receipt.job_id;
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        current.database,
      );
      return deriveContinuationRuntimeV1OperationResultV1(
        current.database,
        binding,
        "before_receipt_insert",
      );
    },
  });
  assert.ok(parentJobId);
  const parent = await current.jobs.read({
    tenant_id: TENANT,
    scope: SCOPE,
    job_id: parentJobId,
  });
  assert.ok(parent);
  const embeddingWorkerSha = "4".repeat(64);
  const parentLease = await current.jobs.leaseNext({
    tenant_id: TENANT,
    job_kind: "embedding",
    lease_owner: `worker_embedding_${embeddingWorkerSha}`,
    lease_duration_ms: 5_000,
  });
  assert.ok(parentLease);
  let createdJobId: string | null = null;
  await operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "worker_completion",
    operationId: `schedule-ann-${suffix}`,
    actorKind: "worker",
    actorPrincipalSha256: embeddingWorkerSha,
    request: { parent_job_id: parentLease.job_id, schedule: suffix },
    produce: async (context) => {
      const receipt = await current.enqueuer.enqueue(context, {
        task_family: TASK_FAMILY,
        authority_subject_sha256: continuationAuthoritySubjectSha256V1({
          tenant_id: TENANT,
          scope: SCOPE,
          task_family: TASK_FAMILY,
        }),
        job_kind: "ann",
        dedupe_key: `ann-${suffix}`,
        priority: 0,
        max_attempts: 3,
        payload,
        available_at: new Date(Date.now() - 1_000).toISOString(),
      });
      createdJobId = receipt.job_id;
      await current.jobs.complete(context, {
        job_id: parentLease.job_id,
        lease_token: parentLease.lease_token!,
      });
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        current.database,
      );
      return deriveContinuationRuntimeV1OperationResultV1(
        current.database,
        binding,
        "before_receipt_insert",
      );
    },
  });
  assert.ok(createdJobId);
  const created = await current.jobs.read({
    tenant_id: TENANT,
    scope: SCOPE,
    job_id: createdJobId,
  });
  assert.ok(created);
  return created;
}

function workerConfig(current: Fixture): ContinuationRuntimeV1WorkerConfig {
  return canonicalContinuationClone({
    dataPath: current.dataPath,
    tenantId: TENANT,
    trustRootPublicKeyPath: join(current.root, "root.pem"),
    trustRootSha256: "1".repeat(64),
    workerRole: "ann" as const,
    jobs: { pollMs: 10, batchSize: 4, leaseMs: 5_000 },
    logLevel: "error" as const,
    shutdownTimeoutMs: 5_000,
    embedding: null,
    effect: null,
  });
}

function processor(current: Fixture) {
  return createContinuationRuntimeV1AnnWorkerProcessor({
    vectorArtifactStore: current.vectorStore,
    indexSegmentStore: current.indexStore,
  });
}

async function lease(
  current: Fixture,
  service: ReturnType<typeof createContinuationRuntimeV1WorkerService>,
): Promise<ContinuationRuntimeV1DurableJob> {
  const job = await current.jobs.leaseNext({
    tenant_id: TENANT,
    job_kind: "ann",
    lease_owner: `worker_ann_${service.workerPrincipal().actor_principal_sha256}`,
    lease_duration_ms: workerConfig(current).jobs.leaseMs,
  });
  assert.ok(job);
  return job;
}

function attemptJob(job: ContinuationRuntimeV1DurableJob):
ContinuationRuntimeV1WorkerAttemptJob<"ann"> {
  assert.equal(job.job_kind, "ann");
  assert.ok(job.lease_acquired_at);
  assert.ok(job.lease_expires_at);
  return canonicalContinuationClone({
    schema_version: "continuation_runtime_worker_attempt_job_v1" as const,
    tenant_id: job.tenant_id,
    scope: job.scope,
    task_family: job.task_family,
    authority_subject_sha256: job.authority_subject_sha256,
    job_id: job.job_id,
    job_kind: "ann" as const,
    payload_sha256: job.payload_sha256,
    payload: job.payload,
    attempt_count: job.attempt_count,
    max_attempts: job.max_attempts,
    lease_acquired_at: job.lease_acquired_at!,
    lease_expires_at: job.lease_expires_at!,
  });
}

function processorInput(job: ContinuationRuntimeV1WorkerAttemptJob<"ann">) {
  return Object.freeze({
    schema_version: "continuation_runtime_worker_processor_input_v1" as const,
    attempt_operation_id: `attempt-${job.job_id}`,
    job,
    signal: new AbortController().signal,
  });
}

async function processorError(operation: Promise<unknown>): Promise<
  ContinuationRuntimeV1WorkerProcessorError
> {
  try { await operation; } catch (error) {
    assert.ok(error instanceof ContinuationRuntimeV1WorkerProcessorError);
    assert.equal(error.message, "continuation_runtime_v1_worker_processor_failed");
    assert.equal("cause" in error, false);
    return error;
  }
  assert.fail("processor unexpectedly succeeded");
}

function vectorPath(root: string, ref: ContinuationRuntimeV1VectorArtifactRef): string {
  return join(
    root,
    "objects",
    ref.artifact_sha256.slice(0, 2),
    ref.artifact_sha256,
    "vector.f32",
  );
}

function authoritySnapshot(database: ContinuationRuntimeV1Database) {
  return Object.fromEntries(AUTHORITY_TABLES.map((table) => {
    const row = database.db.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).get() as { count: number };
    return [table, Number(row.count)];
  }));
}

test("ANN worker builds one replayable segment and mutates no database authority", async () => {
  const current = await fixture();
  try {
    const set = await artifactSet(current);
    await enqueue(current, buildContinuationRuntimeV1AnnJobPayload(set));
    const annProcessor = processor(current);
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config: workerConfig(current),
      processor: annProcessor,
    });
    const leased = await lease(current, service);
    const prepared = await annProcessor.process(processorInput(attemptJob(leased)));
    assert.equal(prepared.output.kind, "ann");
    const receipt = parseContinuationRuntimeV1AnnIndexReceipt(
      prepared.output.index_receipt,
    );
    assert.equal(receipt.source_job_payload_sha256, leased.payload_sha256);
    assert.equal(receipt.artifact_set_sha256, set.artifact_set_sha256);
    assert.equal(canonicalContinuationJson(receipt).includes(SOURCE_SECRET), false);
    assert.equal(canonicalContinuationJson(receipt).includes(PROVIDER_SECRET), false);
    const authorityBefore = authoritySnapshot(current.database);
    const jobsBefore = Number((current.database.db.prepare(
      "SELECT COUNT(*) AS count FROM durable_jobs",
    ).get() as { count: number }).count);
    const completed = await service.processLeasedJob(leased);
    assert.equal(completed.transition_state, "succeeded");
    assert.deepEqual(authoritySnapshot(current.database), authorityBefore);
    assert.equal(Number((current.database.db.prepare(
      "SELECT COUNT(*) AS count FROM durable_jobs",
    ).get() as { count: number }).count), jobsBefore);
    const replay = await service.processLeasedJob(leased);
    assert.equal(replay.operation_status, "replayed");
    assert.deepEqual((current.database.db.prepare(
      `SELECT job_kind, COUNT(*) AS count FROM durable_jobs
       GROUP BY job_kind ORDER BY job_kind`,
    ).all() as Array<{ job_kind: string; count: number }>).map((row) => ({ ...row })), [
      { job_kind: "ann", count: 1 },
      { job_kind: "embedding", count: 1 },
    ]);
    assert.deepEqual(await current.indexStore.read(receipt.segment_ref), {
      schema_version: "ann_index_segment_read_v1",
      ref: receipt.segment_ref,
    });
  } finally {
    await current.cleanup();
  }
});

test("ANN worker converges concurrent exact attempts to the same receipt", async () => {
  const current = await fixture();
  try {
    const set = await artifactSet(current);
    await enqueue(current, buildContinuationRuntimeV1AnnJobPayload(set), "concurrent");
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config: workerConfig(current),
      processor: processor(current),
    });
    const leased = await lease(current, service);
    const annProcessor = processor(current);
    const outputs = await Promise.all(Array.from({ length: 16 }, async () =>
      (await annProcessor.process(processorInput(attemptJob(leased)))).output));
    outputs.forEach((output) => assert.deepEqual(output, outputs[0]));
  } finally {
    await current.cleanup();
  }
});

test("ANN worker rejects payload SHA drift and nested artifact-set digest drift", async () => {
  const current = await fixture();
  try {
    const set = await artifactSet(current);
    await enqueue(current, buildContinuationRuntimeV1AnnJobPayload(set), "payload-drift");
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config: workerConfig(current),
      processor: processor(current),
    });
    const leased = await lease(current, service);
    const base = attemptJob(leased);
    const shaDrift = await processorError(processor(current).process(processorInput({
      ...base,
      payload_sha256: "f".repeat(64),
    })));
    assert.deepEqual(
      { code: shaDrift.code, disposition: shaDrift.disposition },
      { code: "ann_payload_invalid", disposition: "dead" },
    );

    const nestedPayload = canonicalContinuationClone({
      ...base.payload,
      embedding_artifact_set_ref: {
        ...(base.payload.embedding_artifact_set_ref as Record<string, unknown>),
        artifact_set_sha256: "e".repeat(64),
      },
    });
    const nestedDrift = await processorError(processor(current).process(processorInput({
      ...base,
      payload: nestedPayload,
      payload_sha256: canonicalContinuationSha256(nestedPayload),
    })));
    assert.deepEqual(
      { code: nestedDrift.code, disposition: nestedDrift.disposition },
      { code: "ann_payload_invalid", disposition: "dead" },
    );
  } finally {
    await current.cleanup();
  }
});

test("ANN worker rejects mixed model/dimensions and vector-ref self-digest drift", async () => {
  for (const [suffix, specs] of [
    ["model", [
      { vector: [1, 2, 3], model: MODEL },
      { vector: [4, 5, 6], model: "other-model" },
    ]],
    ["dimensions", [
      { vector: [1, 2, 3], model: MODEL },
      { vector: [4, 5], model: MODEL },
    ]],
  ] as const) {
    const current = await fixture();
    try {
      const set = await artifactSet(current, specs);
      await enqueue(current, buildContinuationRuntimeV1AnnJobPayload(set), suffix);
      const service = createContinuationRuntimeV1WorkerService({
        database: current.database,
        config: workerConfig(current),
        processor: processor(current),
      });
      const leased = await lease(current, service);
      const error = await processorError(
        processor(current).process(processorInput(attemptJob(leased))),
      );
      assert.deepEqual(
        { code: error.code, disposition: error.disposition },
        { code: "ann_vector_family_mismatch", disposition: "dead" },
      );
    } finally {
      await current.cleanup();
    }
  }

  const digestCase = await fixture();
  try {
    const set = await artifactSet(digestCase, [{ vector: [1, 2, 3] }]);
    const member = set.artifacts[0]!;
    const driftedSet = buildContinuationRuntimeV1EmbeddingArtifactSetRef([{
      ...member,
      vector_artifact_ref: {
        ...member.vector_artifact_ref,
        artifact_sha256: "d".repeat(64),
      },
    }]);
    await enqueue(
      digestCase,
      buildContinuationRuntimeV1AnnJobPayload(driftedSet),
      "ref-drift",
    );
    const service = createContinuationRuntimeV1WorkerService({
      database: digestCase.database,
      config: workerConfig(digestCase),
      processor: processor(digestCase),
    });
    const leased = await lease(digestCase, service);
    const error = await processorError(
      processor(digestCase).process(processorInput(attemptJob(leased))),
    );
    assert.deepEqual(
      { code: error.code, disposition: error.disposition },
      { code: "ann_vector_ref_invalid", disposition: "dead" },
    );
  } finally {
    await digestCase.cleanup();
  }
});

test("ANN worker classifies missing and tampered artifacts as stable dead failures", async () => {
  const missing = await fixture();
  try {
    const set = await artifactSet(missing, [{ vector: [1, 2, 3] }]);
    await missing.vectorStore.delete(set.artifacts[0]!.vector_artifact_ref);
    await enqueue(missing, buildContinuationRuntimeV1AnnJobPayload(set), "missing");
    const service = createContinuationRuntimeV1WorkerService({
      database: missing.database,
      config: workerConfig(missing),
      processor: processor(missing),
    });
    const leased = await lease(missing, service);
    const error = await processorError(
      processor(missing).process(processorInput(attemptJob(leased))),
    );
    assert.deepEqual(
      { code: error.code, disposition: error.disposition },
      { code: "ann_vector_artifact_missing", disposition: "dead" },
    );
  } finally {
    await missing.cleanup();
  }

  const tampered = await fixture();
  try {
    const set = await artifactSet(tampered, [{ vector: [1, 2, 3] }]);
    const ref = set.artifacts[0]!.vector_artifact_ref;
    const path = vectorPath(tampered.vectorRoot, ref);
    const bytes = await readFile(path);
    bytes[0] = bytes[0]! ^ 0xff;
    await writeFile(path, bytes, { mode: 0o600 });
    await enqueue(tampered, buildContinuationRuntimeV1AnnJobPayload(set), "tampered");
    const service = createContinuationRuntimeV1WorkerService({
      database: tampered.database,
      config: workerConfig(tampered),
      processor: processor(tampered),
    });
    const leased = await lease(tampered, service);
    const error = await processorError(
      processor(tampered).process(processorInput(attemptJob(leased))),
    );
    assert.deepEqual(
      { code: error.code, disposition: error.disposition },
      { code: "ann_vector_sidecar_integrity_failure", disposition: "dead" },
    );
  } finally {
    await tampered.cleanup();
  }
});

test("ANN worker redacts unknown sidecar failures and classifies them retryably", async () => {
  const current = await fixture();
  try {
    const set = await artifactSet(current, [{ vector: [1, 2, 3] }]);
    await enqueue(current, buildContinuationRuntimeV1AnnJobPayload(set), "redacted");
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config: workerConfig(current),
      processor: processor(current),
    });
    const leased = await lease(current, service);
    const failing = createContinuationRuntimeV1AnnWorkerProcessor({
      vectorArtifactStore: {
        async read() { throw new Error(PROVIDER_SECRET); },
      },
      indexSegmentStore: current.indexStore,
    });
    const error = await processorError(
      failing.process(processorInput(attemptJob(leased))),
    );
    assert.deepEqual(
      { code: error.code, disposition: error.disposition },
      { code: "ann_vector_sidecar_unavailable", disposition: "retry" },
    );
    assert.equal(error.message.includes(PROVIDER_SECRET), false);
    assert.equal(JSON.stringify({ code: error.code }).includes(PROVIDER_SECRET), false);
  } finally {
    await current.cleanup();
  }
});
