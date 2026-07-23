import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExecutionCapsuleDraftV1 } from "../../src/continuation/capsule.js";
import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type CapsuleRefV1,
  type ExecutionCapsuleV1,
} from "../../src/continuation/contract.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import {
  buildContinuationRuntimeV1EmbeddingJobPayload,
  buildContinuationRuntimeV1EmbeddingDocument,
  type ContinuationRuntimeV1EmbeddingArtifactSetRefV1,
  type ContinuationRuntimeV1EmbeddingJobPayloadV1,
} from "../../src/runtime-v1/embedding-job-contract.js";
import {
  createContinuationRuntimeV1EmbeddingWorkerProcessor,
} from "../../src/runtime-v1/embedding-worker-processor.js";
import {
  ContinuationRuntimeV1EmbeddingProviderError,
  type ContinuationRuntimeV1EmbeddingBatchInput,
  type ContinuationRuntimeV1EmbeddingProvider,
} from "../../src/runtime-v1/embedding-provider.js";
import {
  createContinuationRuntimeV1VectorArtifactStore,
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
import {
  buildArchivedMemoryProjectionV1,
} from
  "../../src/store/continuation-runtime-v1-memory-contract.js";
import { createContinuationRuntimeV1MemoryStore } from
  "../../src/store/continuation-runtime-v1-memory-store.js";
import { createContinuationRuntimeV1ObservationStore } from
  "../../src/store/continuation-runtime-v1-observation-store.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
} from "../../src/store/continuation-runtime-v1-operation-store.js";

const TENANT = "tenant-embedding";
const SCOPE = "scope-embedding";
const TASK_FAMILY = "coding";
const MODEL = "fake-embedding-model-v1";
const DIMENSIONS = 3;
const SOURCE_SECRET = "source-summary-secret-must-not-enter-job-or-output";
const PROVIDER_SECRET = "provider-raw-secret-must-not-enter-worker-error";
const HOST = "1".repeat(64);

type Fixture = Readonly<{
  root: string;
  database: ContinuationRuntimeV1Database;
  memory: ReturnType<typeof createContinuationRuntimeV1MemoryStore>;
  jobs: ReturnType<typeof createContinuationRuntimeV1DurableJobWorkerStore>;
  enqueuer: ReturnType<typeof createContinuationRuntimeV1DurableJobEnqueuer>;
  vectorStore: ContinuationRuntimeV1VectorArtifactStore;
  capsules: readonly ExecutionCapsuleV1[];
  embeddingJob: ContinuationRuntimeV1DurableJob;
  cleanup(): Promise<void>;
}>;

function capsuleDraft(index: number): Omit<ExecutionCapsuleDraftV1, "created_at"> {
  const target = `memory-${index}`;
  return {
    capsule_id: `capsule-${String(index).padStart(2, "0")}`,
    kind: "procedure",
    proposed_influence: "inspect",
    applicability: {
      task_family: TASK_FAMILY,
      task_signature: "task-profile",
      workflow_signature: null,
      workspace_signature: "workspace-profile",
      producer_agent_id: "agent-a",
      owner_agent_id: null,
      owner_team_id: "team-a",
    },
    projection: {
      summary: `${SOURCE_SECRET}-${index}`,
      next_action: `Inspect immutable state ${index}`,
      target_refs: [{ kind: "memory", ref: target }],
      workflow_steps: [`read ${target}`, `verify ${target}`],
      acceptance_statements: [`${target} is verified`],
    },
    coverage_claims: [{
      obligation_kind: "required_state",
      target_refs: [{ kind: "memory", ref: target }],
      evidence_requirement: "runtime_state",
      required_probe_ids: [],
    }],
    precondition_specs: [],
    evidence_refs: [],
    verifier_refs: [],
    conflicts_with: [],
    supersedes: [],
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function refs(capsules: readonly ExecutionCapsuleV1[]): readonly CapsuleRefV1[] {
  return capsules.map((capsule) => canonicalContinuationClone({
    capsule_id: capsule.capsule_id,
    capsule_revision: capsule.capsule_revision,
    capsule_sha256: capsule.capsule_sha256,
  }));
}

function payload(capsules: readonly ExecutionCapsuleV1[]):
ContinuationRuntimeV1EmbeddingJobPayloadV1 {
  return buildContinuationRuntimeV1EmbeddingJobPayload(refs(capsules));
}

async function fixture(capsuleCount = 2): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "aionis-v1-embedding-processor-"));
  const database = openContinuationRuntimeV1Database(
    join(root, "authority", "runtime.sqlite"),
    { databaseInstanceId: "e".repeat(64) },
  );
  const memory = createContinuationRuntimeV1MemoryStore(database);
  const jobs = createContinuationRuntimeV1DurableJobWorkerStore(database);
  const enqueuer = createContinuationRuntimeV1DurableJobEnqueuer(database);
  const operations = createContinuationRuntimeV1OperationStore(database);
  let capsules: readonly ExecutionCapsuleV1[] | null = null;
  let embeddingJobId: string | null = null;
  const issued = new Date(Date.now() - 60_000).toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  await operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "record_observations",
    operationId: `seed-embedding-${capsuleCount}`,
    actorKind: "trusted_host",
    actorPrincipalSha256: HOST,
    request: { seed: `embedding-${capsuleCount}` },
    produce: async (context) => {
      await createContinuationRuntimeV1ObservationStore(database).put(context, {
        host_task_envelope: {
          host_task_id: `task-${capsuleCount}`,
          episode_id: `episode-${capsuleCount}`,
          run_id: `run-${capsuleCount}`,
          consumer_agent_id: "agent-a",
          consumer_team_id: "team-a",
          task_family: TASK_FAMILY,
          task_signature: "task-profile",
          workflow_signature: null,
          workspace_signature: "workspace-profile",
          source_task_sha256: "2".repeat(64),
          source_event_sha256: "3".repeat(64),
          issued_at: issued,
          expires_at: expires,
        },
        collector_observations: [],
        signed_observations: [],
      });
      const appended = await memory.appendMemoryRevision(context, {
        expected_head_revision: null,
        items: Array.from({ length: capsuleCount }, (_, index) => ({
          memory_id: `memory-${index}`,
          memory_kind: "procedure",
          lifecycle: "active" as const,
          authority: "verified" as const,
          hydrated: true,
          projection: { value: `${SOURCE_SECRET}-${index}` },
          rehydration_ref: null,
          expires_at: null,
        })),
        relations: [],
        capsules: Array.from({ length: capsuleCount }, (_, index) => ({
          memory_id: `memory-${index}`,
          draft: capsuleDraft(index),
        })),
      });
      capsules = appended.capsules;
      const receipt = await enqueuer.enqueue(context, {
        task_family: TASK_FAMILY,
        authority_subject_sha256: continuationAuthoritySubjectSha256V1({
          tenant_id: TENANT,
          scope: SCOPE,
          task_family: TASK_FAMILY,
        }),
        job_kind: "embedding",
        dedupe_key: `embedding-seed-${capsuleCount}`,
        priority: 0,
        max_attempts: 3,
        payload: payload(appended.capsules),
        available_at: new Date(Date.now() - 1_000).toISOString(),
      });
      embeddingJobId = receipt.job_id;
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        database,
      );
      return deriveContinuationRuntimeV1OperationResultV1(
        database,
        binding,
        "before_receipt_insert",
      );
    },
  });
  assert.ok(capsules);
  assert.ok(embeddingJobId);
  const embeddingJob = await jobs.read({
    tenant_id: TENANT,
    scope: SCOPE,
    job_id: embeddingJobId,
  });
  assert.ok(embeddingJob);
  return {
    root,
    database,
    memory,
    jobs,
    enqueuer,
    vectorStore: createContinuationRuntimeV1VectorArtifactStore({
      rootPath: join(root, "vector-sidecar"),
    }),
    capsules,
    embeddingJob,
    async cleanup() {
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function fakeProvider(
  vectors: readonly (readonly number[])[],
  failure: unknown = null,
) {
  const inputs: ContinuationRuntimeV1EmbeddingBatchInput[] = [];
  let calls = 0;
  const port: ContinuationRuntimeV1EmbeddingProvider = Object.freeze({
    async embed(input) {
      calls += 1;
      inputs.push(input);
      if (failure !== null) throw failure;
      return {
        schema_version: "embedding_batch_result_v1",
        model: MODEL,
        dimensions: DIMENSIONS,
        vectors,
      };
    },
  });
  return { port, inputs, calls: () => calls };
}

async function lease(f: Fixture, owner = "unit-embedding-worker") {
  const leased = await f.jobs.leaseNext({
    tenant_id: TENANT,
    job_kind: "embedding",
    lease_owner: owner,
    lease_duration_ms: 30_000,
  });
  assert.ok(leased);
  return leased;
}

function attemptJob(job: ContinuationRuntimeV1DurableJob):
ContinuationRuntimeV1WorkerAttemptJob<"embedding"> {
  assert.equal(job.job_kind, "embedding");
  assert.ok(job.lease_acquired_at);
  assert.ok(job.lease_expires_at);
  return canonicalContinuationClone({
    schema_version: "continuation_runtime_worker_attempt_job_v1" as const,
    tenant_id: job.tenant_id,
    scope: job.scope,
    task_family: job.task_family,
    authority_subject_sha256: job.authority_subject_sha256,
    job_id: job.job_id,
    job_kind: "embedding" as const,
    payload_sha256: job.payload_sha256,
    payload: job.payload,
    attempt_count: job.attempt_count,
    max_attempts: job.max_attempts,
    lease_acquired_at: job.lease_acquired_at,
    lease_expires_at: job.lease_expires_at,
  });
}

function processorInput(job: ContinuationRuntimeV1DurableJob) {
  return Object.freeze({
    schema_version: "continuation_runtime_worker_processor_input_v1" as const,
    attempt_operation_id: "unit-embedding-attempt",
    job: attemptJob(job),
    signal: new AbortController().signal,
  });
}

async function rejectedProcessorError(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof ContinuationRuntimeV1WorkerProcessorError);
    return error;
  }
  assert.fail("processor unexpectedly succeeded");
}

function assertWorkerError(
  error: ContinuationRuntimeV1WorkerProcessorError,
  code: string,
  disposition: "retry" | "dead",
  secrets: readonly string[] = [],
) {
  assert.equal(error.code, code);
  assert.equal(error.disposition, disposition);
  assert.equal(error.message, "continuation_runtime_v1_worker_processor_failed");
  const serialized = `${String(error)}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
}

function processor(
  f: Fixture,
  provider: ContinuationRuntimeV1EmbeddingProvider,
  vectorStore = f.vectorStore,
) {
  return createContinuationRuntimeV1EmbeddingWorkerProcessor({
    memoryStore: f.memory,
    provider,
    vectorArtifactStore: vectorStore,
    durableJobStore: f.enqueuer,
  });
}

function workerConfig(f: Fixture): ContinuationRuntimeV1WorkerConfig {
  return canonicalContinuationClone({
    dataPath: f.database.path,
    tenantId: TENANT,
    trustRootPublicKeyPath: join(f.root, "trust-root.pem"),
    trustRootSha256: "4".repeat(64),
    workerRole: "embedding" as const,
    jobs: { pollMs: 10, batchSize: 4, leaseMs: 30_000 },
    logLevel: "error" as const,
    shutdownTimeoutMs: 5_000,
    embedding: {
      baseUrl: "http://127.0.0.1:1/v1",
      model: MODEL,
      apiKeyFilePath: join(f.root, "embedding-api-key"),
      dimensions: DIMENSIONS,
    },
    effect: null,
  });
}

async function governQueuedSource(
  f: Fixture,
  state: "quarantined" | "archived" | "expired",
): Promise<void> {
  const current = await f.memory.readMemoryItem(TENANT, SCOPE, "memory-0");
  assert.ok(current);
  const rehydrationRef = `rehydration:v1:${"f".repeat(64)}` as const;
  const operations = createContinuationRuntimeV1OperationStore(f.database);
  await operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "authority_decision",
    operationId: `govern-queued-source-${state}`,
    actorKind: "operator",
    actorPrincipalSha256: "5".repeat(64),
    request: { state },
    produce: async (context) => {
      const archived = state === "archived";
      await f.memory.appendMemoryRevision(context, {
        expected_head_revision: 1,
        items: [{
          memory_id: current.memory_id,
          memory_kind: current.memory_kind,
          lifecycle: archived ? "archived" : state === "quarantined"
            ? "quarantined" : "active",
          authority: current.authority,
          hydrated: !archived,
          projection: archived
            ? buildArchivedMemoryProjectionV1({
                memory_id: current.memory_id,
                source_projection_sha256: current.projection_sha256,
                rehydration_ref: rehydrationRef,
              })
            : current.projection,
          rehydration_ref: archived ? rehydrationRef : null,
          expires_at: state === "expired"
            ? new Date(Date.now() - 1_000).toISOString()
            : current.expires_at,
        }],
        relations: [],
        capsules: [],
      });
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        f.database,
      );
      return deriveContinuationRuntimeV1OperationResultV1(
        f.database,
        binding,
        "before_receipt_insert",
      );
    },
  });
}

test("processor reads immutable refs, builds canonical documents, and exposes only content-addressed refs", async () => {
  const f = await fixture(2);
  try {
    const vectors = [[1.25, 2.5, 3.75], [4.25, 5.5, 6.75]];
    const fake = fakeProvider(vectors);
    const leased = await lease(f);
    const prepared = await processor(f, fake.port).process(processorInput(leased));
    assert.equal(fake.calls(), 1);
    assert.equal(fake.inputs.length, 1);
    assert.equal(fake.inputs[0]!.texts.length, 2);
    const documents = fake.inputs[0]!.texts.map((raw) => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(canonicalContinuationJson(parsed), raw);
      assert.deepEqual(Object.keys(parsed).sort(), [
        "capsule_ref", "schema_version", "semantic_projection",
        "source_projection_sha256",
      ]);
      return parsed;
    });

    assert.equal(prepared.output.kind, "embedding");
    const setRef = prepared.output.artifact_ref as unknown as
      ContinuationRuntimeV1EmbeddingArtifactSetRefV1;
    const { artifact_set_sha256: setDigest, ...setBody } = setRef;
    assert.equal(setDigest, canonicalContinuationSha256(setBody));
    assert.equal(setRef.artifacts.length, 2);
    for (let index = 0; index < setRef.artifacts.length; index += 1) {
      const member = setRef.artifacts[index]!;
      assert.deepEqual(member.capsule_ref, refs(f.capsules)[index]);
      assert.equal(
        member.embedding_document_sha256,
        canonicalContinuationSha256(documents[index]),
      );
      assert.equal(
        member.vector_artifact_ref.source_projection_sha256,
        documents[index]!.source_projection_sha256,
      );
      assert.equal(
        member.vector_artifact_ref.embedding_document_sha256,
        member.embedding_document_sha256,
      );
      const stored = await f.vectorStore.read(member.vector_artifact_ref);
      assert.ok(stored);
      assert.deepEqual(stored.vector, vectors[index]!.map(Math.fround));
    }
    const payloadJson = canonicalContinuationJson(leased.payload);
    const outputJson = canonicalContinuationJson(prepared.output);
    assert.equal(payloadJson.includes(SOURCE_SECRET), false);
    assert.equal(outputJson.includes(SOURCE_SECRET), false);
    assert.equal(outputJson.includes("semantic_projection"), false);
    assert.equal(outputJson.includes("[1.25,2.5,3.75]"), false);
    assert.equal(Object.isFrozen(setRef), true);
    assert.equal(Object.isFrozen(setRef.artifacts), true);
  } finally {
    await f.cleanup();
  }
});

test("processor rejects non-exact, non-canonical, duplicate, and over-64 payloads before provider use", async () => {
  const f = await fixture(2);
  try {
    const fake = fakeProvider([[1, 2, 3], [4, 5, 6]]);
    const leased = await lease(f);
    const service = processor(f, fake.port);
    const validRefs = refs(f.capsules);
    const invalidPayloads: unknown[] = [
      { ...payload(f.capsules), source_text: SOURCE_SECRET },
      { schema_version: "embedding_job_payload_v1", capsule_refs: [...validRefs].reverse() },
      { schema_version: "embedding_job_payload_v1", capsule_refs: [validRefs[0], validRefs[0]] },
      {
        schema_version: "embedding_job_payload_v1",
        capsule_refs: Array.from({ length: 65 }, (_, index) => ({
          capsule_id: `capsule-over-${String(index).padStart(2, "0")}`,
          capsule_revision: 1,
          capsule_sha256: "a".repeat(64),
        })),
      },
    ];
    for (const invalid of invalidPayloads) {
      const job = attemptJob(leased);
      const candidate = canonicalContinuationClone({
        ...job,
        payload: invalid,
        payload_sha256: canonicalContinuationSha256(invalid),
      });
      const error = await rejectedProcessorError(service.process({
        schema_version: "continuation_runtime_worker_processor_input_v1",
        attempt_operation_id: "invalid-payload",
        job: candidate as unknown as ContinuationRuntimeV1WorkerAttemptJob<"embedding">,
        signal: new AbortController().signal,
      }));
      assertWorkerError(error, "embedding_payload_invalid", "dead", [SOURCE_SECRET]);
    }
    assert.equal(fake.calls(), 0);
  } finally {
    await f.cleanup();
  }
});

test("processor maps provider and real sidecar failures to stable retry/dead errors without leakage", async () => {
  const f = await fixture(1);
  try {
    const leased = await lease(f);
    for (const [failure, code, disposition] of [
      [new ContinuationRuntimeV1EmbeddingProviderError("transport_failure"),
        "embedding_provider_unavailable", "retry"],
      [new ContinuationRuntimeV1EmbeddingProviderError("provider_response_model_mismatch"),
        "embedding_provider_contract_invalid", "dead"],
      [new Error(PROVIDER_SECRET), "embedding_provider_unavailable", "retry"],
    ] as const) {
      const fake = fakeProvider([], failure);
      const error = await rejectedProcessorError(
        processor(f, fake.port).process(processorInput(leased)),
      );
      assertWorkerError(error, code, disposition, [PROVIDER_SECRET, SOURCE_SECRET]);
    }

    const success = fakeProvider([[1, 2, 3]]);
    const realRoot = join(f.root, "real-vector-root");
    const linkedRoot = join(f.root, "linked-vector-root");
    await mkdir(realRoot, { mode: 0o700 });
    await symlink(realRoot, linkedRoot, "dir");
    const symlinkStore = createContinuationRuntimeV1VectorArtifactStore({
      rootPath: linkedRoot,
    });
    const symlinkError = await rejectedProcessorError(
      processor(f, success.port, symlinkStore).process(processorInput(leased)),
    );
    assertWorkerError(
      symlinkError,
      "embedding_sidecar_integrity_failure",
      "dead",
      [SOURCE_SECRET],
    );

    const tooLongRoot = join(f.root, "x".repeat(5_000));
    const unavailableStore = createContinuationRuntimeV1VectorArtifactStore({
      rootPath: tooLongRoot,
    });
    const ioError = await rejectedProcessorError(
      processor(f, success.port, unavailableStore).process(processorInput(leased)),
    );
    assertWorkerError(
      ioError,
      "embedding_sidecar_unavailable",
      "retry",
      [SOURCE_SECRET],
    );
  } finally {
    await f.cleanup();
  }
});

test("queued work refuses quarantined, archived, and expired current sources before provider or sidecar", async () => {
  for (const state of ["quarantined", "archived", "expired"] as const) {
    const f = await fixture(1);
    try {
      await governQueuedSource(f, state);
      const fake = fakeProvider([[1, 2, 3]]);
      const leased = await lease(f);
      const error = await rejectedProcessorError(
        processor(f, fake.port).process(processorInput(leased)),
      );
      assertWorkerError(
        error,
        "embedding_source_not_serviceable",
        "dead",
        [SOURCE_SECRET],
      );
      assert.equal(fake.calls(), 0);
      assert.equal((await f.vectorStore.reconcile()).verified_artifact_count, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("partial sidecar state and complete processor replay converge to the same artifact set", async () => {
  const f = await fixture(2);
  try {
    const vectors = [[0.5, 1.5, 2.5], [3.5, 4.5, 5.5]];
    const firstCapsule = f.capsules[0]!;
    const firstDocumentSha256 = canonicalContinuationSha256(
      buildContinuationRuntimeV1EmbeddingDocument(firstCapsule),
    );
    const preexisting = await f.vectorStore.write({
      schema_version: "vector_artifact_write_v1",
      source_projection_sha256: firstCapsule.source.source_projection_sha256,
      embedding_document_sha256: firstDocumentSha256,
      model: MODEL,
      dimensions: DIMENSIONS,
      vector: vectors[0]!,
    });
    const fake = fakeProvider(vectors);
    const leased = await lease(f);
    const service = processor(f, fake.port);
    const first = await service.process(processorInput(leased));
    const second = await service.process(processorInput(leased));
    assert.deepEqual(second.output, first.output);
    const setRef = first.output.artifact_ref as unknown as
      ContinuationRuntimeV1EmbeddingArtifactSetRefV1;
    assert.deepEqual(setRef.artifacts[0]!.vector_artifact_ref, preexisting);
    assert.equal(fake.calls(), 2);
    assert.deepEqual(await f.vectorStore.reconcile(), {
      schema_version: "vector_artifact_reconcile_result_v1",
      verified_artifact_count: 2,
      removed_temporary_count: 0,
    });
  } finally {
    await f.cleanup();
  }
});

test("ANN child enqueue and embedding completion commit atomically; rollback leaves only replayable sidecar", async () => {
  const f = await fixture(1);
  try {
    const fake = fakeProvider([[9.25, 8.5, 7.75]]);
    const embeddingProcessor = processor(f, fake.port);
    const service = createContinuationRuntimeV1WorkerService({
      database: f.database,
      config: workerConfig(f),
      processor: embeddingProcessor,
    });
    const leased = await lease(
      f,
      `worker_embedding_${service.workerPrincipal().actor_principal_sha256}`,
    );
    f.database.db.exec(`CREATE TRIGGER test_force_embedding_completion_rollback
      BEFORE UPDATE OF state ON durable_jobs
      WHEN OLD.job_kind = 'embedding' AND OLD.state = 'leased'
        AND NEW.state = 'succeeded'
      BEGIN
        SELECT RAISE(ABORT, 'forced embedding completion rollback');
      END`);
    await assert.rejects(
      service.processLeasedJob(leased),
      /forced embedding completion rollback/u,
    );
    const afterRollback = f.database.db.prepare(
      `SELECT job_kind, state, COUNT(*) AS count FROM durable_jobs
       GROUP BY job_kind, state ORDER BY job_kind, state`,
    ).all() as Array<{ job_kind: string; state: string; count: number }>;
    assert.deepEqual(afterRollback.map((row) => ({ ...row })), [
      { job_kind: "embedding", state: "leased", count: 1 },
    ]);
    assert.equal((f.database.db.prepare(
      "SELECT COUNT(*) AS count FROM operations WHERE operation_kind='worker_completion'",
    ).get() as { count: number }).count, 0);
    assert.equal((await f.vectorStore.reconcile()).verified_artifact_count, 1);

    f.database.db.exec("DROP TRIGGER test_force_embedding_completion_rollback");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const completed = await service.processLeasedJob(leased);
    assert.equal(completed.operation_status, "created");
    assert.equal(completed.transition_state, "succeeded");
    const rows = f.database.db.prepare(`SELECT job_id, job_kind, state, dedupe_key,
      payload_sha256, payload_json, source_operation_kind, source_operation_id,
      completion_operation_kind, completion_operation_id
      FROM durable_jobs ORDER BY job_kind`).all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    const ann = rows.find((row) => row.job_kind === "ann")!;
    const parent = rows.find((row) => row.job_kind === "embedding")!;
    assert.equal(parent.state, "succeeded");
    assert.equal(parent.completion_operation_kind, "worker_completion");
    assert.equal(parent.completion_operation_id, completed.operation_id);
    assert.equal(ann.state, "queued");
    assert.equal(ann.source_operation_kind, "worker_completion");
    assert.equal(ann.source_operation_id, completed.operation_id);
    const annPayload = JSON.parse(ann.payload_json as string) as {
      schema_version: string;
      embedding_artifact_set_ref: ContinuationRuntimeV1EmbeddingArtifactSetRefV1;
    };
    assert.deepEqual(Object.keys(annPayload).sort(), [
      "embedding_artifact_set_ref", "schema_version",
    ]);
    assert.equal(annPayload.schema_version, "ann_job_payload_v1");
    const parentOutput = {
      kind: "embedding",
      artifact_ref: annPayload.embedding_artifact_set_ref,
    } as const;
    const expectedDedupe = canonicalContinuationSha256({
      schema_version: "embedding_ann_child_dedupe_v1",
      parent_job_id: parent.job_id,
      parent_payload_sha256: parent.payload_sha256,
      parent_output_sha256: canonicalContinuationSha256(parentOutput),
      child_payload_sha256: canonicalContinuationSha256(annPayload),
    });
    assert.equal(ann.dedupe_key, `embedding-ann-${expectedDedupe}`);
    assert.equal(canonicalContinuationJson(annPayload).includes(SOURCE_SECRET), false);
    assert.equal(canonicalContinuationJson(annPayload).includes("[9.25,8.5,7.75]"), false);
    assert.equal(fake.calls(), 2);

    const replay = await service.processLeasedJob(leased);
    assert.equal(replay.operation_status, "replayed");
    assert.equal(fake.calls(), 2);
    assert.equal((f.database.db.prepare(
      "SELECT COUNT(*) AS count FROM durable_jobs WHERE job_kind='ann'",
    ).get() as { count: number }).count, 1);
  } finally {
    try {
      f.database.db.exec("DROP TRIGGER IF EXISTS test_force_embedding_completion_rollback");
    } catch { /* database may already be closed only after this block */ }
    await f.cleanup();
  }
});

test("embedding document digest is deterministic and binds the immutable capsule projection", async () => {
  const f = await fixture(1);
  try {
    const first = buildContinuationRuntimeV1EmbeddingDocument(f.capsules[0]!);
    const second = buildContinuationRuntimeV1EmbeddingDocument(f.capsules[0]!);
    assert.deepEqual(second, first);
    assert.equal(
      canonicalContinuationSha256(second),
      canonicalContinuationSha256(first),
    );
    assert.equal(first.semantic_projection.projection.summary.includes(SOURCE_SECRET), true);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.semantic_projection), true);
  } finally {
    await f.cleanup();
  }
});
