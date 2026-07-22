import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExecutionCapsuleDraftV1 } from
  "../../src/continuation/capsule.js";
import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type Sha256,
} from "../../src/continuation/contract.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import {
  createContinuationRuntimeV1ApplicationService,
  type ContinuationRuntimeV1ApplicationServiceDependencies,
} from "../../src/runtime-v1/application-service.js";
import {
  buildAuthorityDecisionCommandV1,
  buildWorkerCompletionCommandV1,
} from "../../src/runtime-v1/command.js";
import { operationRequestFromVerifiedCommandV1 } from
  "../../src/runtime-v1/operation-request.js";
import {
  buildContinuationRuntimeV1AnnJobPayload,
  buildContinuationRuntimeV1EmbeddingArtifactSetRef,
  buildContinuationRuntimeV1EmbeddingDocument,
  buildContinuationRuntimeV1EmbeddingJobPayload,
  continuationRuntimeV1CapsuleRef,
  continuationRuntimeV1EmbeddingDocumentSha256,
} from "../../src/runtime-v1/embedding-job-contract.js";
import {
  buildContinuationRuntimeV1AnnIndexReceipt,
  createContinuationRuntimeV1AnnIndexSegmentStore,
} from "../../src/runtime-v1/ann-index-segment-store.js";
import { createContinuationRuntimeV1RetentionAuthorityResolver } from
  "../../src/runtime-v1/retention-authority-resolver.js";
import { buildContinuationRuntimeV1RetentionJobPayload } from
  "../../src/runtime-v1/retention-job-contract.js";
import { createContinuationRuntimeV1RetentionWorkerProcessor } from
  "../../src/runtime-v1/retention-worker-processor.js";
import { createContinuationRuntimeV1VectorArtifactStore } from
  "../../src/runtime-v1/vector-artifact-store.js";
import type { ContinuationRuntimeV1WorkerConfig } from
  "../../src/runtime-v1/worker-config.js";
import { continuationRuntimeV1WorkerPrincipal } from
  "../../src/runtime-v1/worker-identity.js";
import {
  ContinuationRuntimeV1WorkerProcessorError,
  createContinuationRuntimeV1WorkerService,
  type ContinuationRuntimeV1WorkerAttemptJob,
} from "../../src/runtime-v1/worker-service.js";
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
import { sha256Hex } from "../../src/util/crypto.js";

const TENANT = "tenant-retention";
const SCOPE = "scope-retention";
const HOST = "1".repeat(64) as Sha256;
const OPERATOR = "2".repeat(64) as Sha256;
const AUTHORITY_HEAD = "3".repeat(64) as Sha256;
// Intentionally historical: worker correctness must follow the database-owned
// authority clock, never the host wall clock running this test.
const NOW = "2000-01-02T10:00:00.000Z";

type Fixture = Readonly<{
  root: string;
  path: string;
  clock: { value: string };
  database: ContinuationRuntimeV1Database;
  operations: ReturnType<typeof createContinuationRuntimeV1OperationStore>;
  jobs: ReturnType<typeof createContinuationRuntimeV1DurableJobWorkerStore>;
  enqueuer: ReturnType<typeof createContinuationRuntimeV1DurableJobEnqueuer>;
  memory: ReturnType<typeof createContinuationRuntimeV1MemoryStore>;
  observations: ReturnType<typeof createContinuationRuntimeV1ObservationStore>;
  cleanup(): Promise<void>;
}>;

function fixture(name: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `aionis-v1-retention-${name}-`));
  const path = join(root, "authority", "runtime.sqlite");
  const clock = { value: NOW };
  const database = openContinuationRuntimeV1Database(path, {
    databaseInstanceId: "8".repeat(64),
    authorityNow: () => clock.value,
  });
  return {
    root,
    path,
    clock,
    database,
    operations: createContinuationRuntimeV1OperationStore(database),
    jobs: createContinuationRuntimeV1DurableJobWorkerStore(database),
    enqueuer: createContinuationRuntimeV1DurableJobEnqueuer(database),
    memory: createContinuationRuntimeV1MemoryStore(database),
    observations: createContinuationRuntimeV1ObservationStore(database),
    async cleanup() {
      await database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function subject(taskFamily: string): Sha256 {
  return continuationAuthoritySubjectSha256V1({
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: taskFamily,
  });
}

function capsuleDraft(
  capsuleId: string,
  taskFamily: string,
): ExecutionCapsuleDraftV1 {
  return canonicalContinuationClone({
    capsule_id: capsuleId,
    kind: "procedure" as const,
    proposed_influence: "inspect" as const,
    applicability: {
      task_family: taskFamily,
      task_signature: "retention-task",
      workflow_signature: null,
      workspace_signature: "retention-workspace",
      producer_agent_id: "producer",
      owner_agent_id: null,
      owner_team_id: "team",
    },
    projection: {
      summary: `Capsule ${capsuleId}`,
      next_action: "Verify authority state.",
      target_refs: [{ kind: "memory" as const, ref: "authority-state" }],
      workflow_steps: ["Read state.", "Verify digest."],
      acceptance_statements: ["The digest matches."],
    },
    coverage_claims: [{
      obligation_kind: "required_state" as const,
      target_refs: [{ kind: "memory" as const, ref: "authority-state" }],
      evidence_requirement: "runtime_state" as const,
      required_probe_ids: [],
    }],
    precondition_specs: [],
    evidence_refs: [],
    verifier_refs: [],
    conflicts_with: [],
    supersedes: [],
    expires_at: "2000-01-03T10:00:00.000Z",
  });
}

async function seedMemory(
  current: Fixture,
  args: Readonly<{
    operationId: string;
    capsuleFamilies: readonly string[];
    enqueueEmbedding?: boolean;
    includeOtherMemory?: boolean;
  }>,
) {
  let appended: Awaited<ReturnType<typeof current.memory.appendMemoryRevision>>
    | null = null;
  let embedding: Awaited<ReturnType<Fixture["enqueuer"]["enqueue"]>> | null = null;
  await current.operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "record_observations",
    operationId: args.operationId,
    actorKind: "trusted_host",
    actorPrincipalSha256: HOST,
    request: { schema_version: "retention_test_seed_v1", seed_id: args.operationId },
    produce: async (context) => {
      await current.observations.put(context, {
        host_task_envelope: {
          host_task_id: `task-${args.operationId}`,
          episode_id: `episode-${args.operationId}`,
          run_id: `run-${args.operationId}`,
          consumer_agent_id: "consumer",
          consumer_team_id: "team",
          task_family: args.capsuleFamilies[0] ?? "capsule-free-family",
          task_signature: "retention-task",
          workflow_signature: null,
          workspace_signature: "retention-workspace",
          source_task_sha256: "4".repeat(64),
          source_event_sha256: "5".repeat(64),
          issued_at: "2000-01-02T09:00:00.000Z",
          expires_at: "2000-01-02T12:00:00.000Z",
        },
        collector_observations: [],
        signed_observations: [],
      });
      appended = await current.memory.appendMemoryRevision(context, {
        expected_head_revision: null,
        items: [{
          memory_id: "memory-a",
          memory_kind: "procedure",
          lifecycle: "active",
          authority: "verified",
          hydrated: true,
          projection: { value: "authoritative retained body" },
          rehydration_ref: null,
          expires_at: null,
        }, ...(args.includeOtherMemory ? [{
          memory_id: "memory-b",
          memory_kind: "procedure",
          lifecycle: "active" as const,
          authority: "verified" as const,
          hydrated: true,
          projection: { value: "unrelated retained body" },
          rehydration_ref: null,
          expires_at: null,
        }] : [])],
        relations: [],
        capsules: args.capsuleFamilies.map((family, index) => ({
          memory_id: "memory-a",
          draft: capsuleDraft(`capsule-${index + 1}`, family),
        })).concat(args.includeOtherMemory ? [{
          memory_id: "memory-b",
          draft: capsuleDraft("capsule-unrelated", "unrelated-family"),
        }] : []),
      });
      if (args.enqueueEmbedding && appended.capsules.length > 0) {
        const payload = buildContinuationRuntimeV1EmbeddingJobPayload(
          appended.capsules.map(continuationRuntimeV1CapsuleRef),
        );
        embedding = await current.enqueuer.enqueue(context, {
          task_family: args.capsuleFamilies[0]!,
          authority_subject_sha256: subject(args.capsuleFamilies[0]!),
          job_kind: "embedding",
          dedupe_key: `seed-embedding-${args.operationId}`,
          priority: 0,
          max_attempts: 3,
          payload,
          available_at: NOW,
        });
      }
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
  assert.ok(appended);
  return { appended, embedding };
}

function application(current: Fixture) {
  const unused = async (): Promise<never> => {
    throw new Error("retention_test_unexpected_dependency_call");
  };
  const authorityStore = {
    advanceCandidate: unused,
    createIsolatedCandidateDraft: unused,
    ensureGenesis: unused,
    mergeCandidate: unused,
    readHead: async () => ({
      head_revision: 1,
      head_sha256: AUTHORITY_HEAD,
      source_operation: { scope: SCOPE },
    }),
    revertAuthority: unused,
    rotatePolicies: unused,
    terminateCandidate: unused,
  };
  return createContinuationRuntimeV1ApplicationService({
    tenantId: TENANT,
    trustRootSha256: "9".repeat(64) as Sha256,
    database: current.database,
    operationStore: current.operations,
    durableJobStore: current.enqueuer,
    observationStore: current.observations,
    memoryStore: current.memory,
    policyAuthority: { resolveCurrent: unused },
    authorityStore,
    episodeStore: {
      appendExposure: unused,
      appendOutcomeBundle: unused,
      readDecision: unused,
    },
    decisionAssembly: { assemble: unused },
    decisionReader: { read: unused },
  } as unknown as ContinuationRuntimeV1ApplicationServiceDependencies);
}

async function govern(
  current: Fixture,
  args: Readonly<{
    operationId: string;
    taskFamily: string;
    kind: "lifecycle_suppress" | "lifecycle_archive";
  }>,
) {
  const head = await current.memory.readHead(TENANT, SCOPE);
  assert.ok(head);
  const decision = args.kind === "lifecycle_archive"
    ? {
        kind: "lifecycle_archive" as const,
        memory_id: "memory-a",
        expected_memory_head: {
          revision: head.head_revision,
          head_sha256: head.head_sha256,
        },
        rehydration_ref: `rehydration:v1:${"a".repeat(64)}` as const,
        reason_codes: ["retention_test_archive"],
      }
    : {
        kind: "lifecycle_suppress" as const,
        memory_id: "memory-a",
        expected_memory_head: {
          revision: head.head_revision,
          head_sha256: head.head_sha256,
        },
        reason_codes: ["retention_test_suppress"],
      };
  const command = buildAuthorityDecisionCommandV1(args.operationId, {
    schema_version: "authority_decision_body_v1",
    expected_head: { revision: 1, head_sha256: AUTHORITY_HEAD },
    decision,
  }, {
    tenant_id: TENANT,
    scope: SCOPE,
    actor_kind: "operator",
    actor_principal_sha256: OPERATOR,
    task_family: args.taskFamily,
    authority_subject_sha256: subject(args.taskFamily),
  });
  return await Promise.resolve(application(current).decideAuthority(command));
}

test("archive carries verified task family forward for capsule-free and multi-family memory; suppress schedules nothing", async () => {
  const capsuleFree = fixture("forward-family-empty");
  try {
    await seedMemory(capsuleFree, {
      operationId: "seed-capsule-free",
      capsuleFamilies: [],
    });
    const suppressed = await govern(capsuleFree, {
      operationId: "suppress-capsule-free",
      taskFamily: "governed-family",
      kind: "lifecycle_suppress",
    }) as { result: { decision_kind: string } };
    assert.equal(suppressed.result.decision_kind, "memory_update");
    assert.equal((capsuleFree.database.db.prepare(
      "SELECT COUNT(*) AS count FROM durable_jobs WHERE job_kind='retention'",
    ).get() as { count: number }).count, 0);
    const archived = await govern(capsuleFree, {
      operationId: "archive-capsule-free",
      taskFamily: "governed-family",
      kind: "lifecycle_archive",
    }) as { result: { decision_kind: string } };
    assert.equal(archived.result.decision_kind, "lifecycle_archive");
    const row = capsuleFree.database.db.prepare(`SELECT task_family, payload_json
      FROM durable_jobs WHERE job_kind='retention'`).get() as {
      task_family: string;
      payload_json: string;
    };
    assert.equal(row.task_family, "governed-family");
    assert.equal(row.payload_json, canonicalContinuationJson(
      buildContinuationRuntimeV1RetentionJobPayload(),
    ));
  } finally {
    await capsuleFree.cleanup();
  }

  const multiFamily = fixture("forward-family-multi");
  try {
    await seedMemory(multiFamily, {
      operationId: "seed-multi-family",
      capsuleFamilies: ["capsule-family-a", "capsule-family-b"],
    });
    const archived = await govern(multiFamily, {
      operationId: "archive-multi-family",
      taskFamily: "governed-family",
      kind: "lifecycle_archive",
    }) as { result: { decision_kind: string } };
    assert.equal(archived.result.decision_kind, "lifecycle_archive");
    const row = multiFamily.database.db.prepare(`SELECT task_family, payload_json
      FROM durable_jobs WHERE job_kind='retention'`).get() as {
      task_family: string;
      payload_json: string;
    };
    assert.equal(row.task_family, "governed-family");
    assert.equal(row.payload_json.includes("memory-a"), false);
    assert.equal(row.payload_json.includes("capsule-family"), false);
  } finally {
    await multiFamily.cleanup();
  }
});

async function lease(
  current: Fixture,
  kind: "embedding" | "ann" | "retention",
  owner: string,
  duration = 60_000,
): Promise<ContinuationRuntimeV1DurableJob> {
  const job = await current.jobs.leaseNext({
    tenant_id: TENANT,
    job_kind: kind,
    lease_owner: owner,
    lease_duration_ms: duration,
  });
  assert.ok(job);
  return job;
}

function completionBinding(
  current: Fixture,
  job: ContinuationRuntimeV1DurableJob,
  role: "embedding" | "ann",
) {
  assert.ok(job.lease_token);
  const principal = continuationRuntimeV1WorkerPrincipal({
    database_instance_id: current.database.databaseInstanceId as Sha256,
    worker_role: role,
  });
  return {
    principal,
    binding: {
      tenant_id: TENANT,
      scope: SCOPE,
      actor_kind: "worker" as const,
      actor_principal_sha256: principal.actor_principal_sha256,
      task_family: job.task_family,
      authority_subject_sha256: job.authority_subject_sha256 as Sha256,
      job_id: job.job_id,
      job_kind: role,
      job_payload_sha256: job.payload_sha256 as Sha256,
      attempt_count: job.attempt_count,
      lease_token_sha256: sha256Hex(job.lease_token),
    },
  };
}

async function completeEmbedding(
  current: Fixture,
  capsule: Awaited<ReturnType<Fixture["memory"]["readCapsule"]>>,
  vectorStore: ReturnType<typeof createContinuationRuntimeV1VectorArtifactStore>,
) {
  assert.ok(capsule);
  const leased = await lease(current, "embedding", "embedding-test-worker");
  const document = buildContinuationRuntimeV1EmbeddingDocument(capsule);
  const documentSha256 = continuationRuntimeV1EmbeddingDocumentSha256(document);
  const vectorRef = await vectorStore.write({
    schema_version: "vector_artifact_write_v1",
    source_projection_sha256: document.source_projection_sha256,
    embedding_document_sha256: documentSha256,
    model: "retention-test-model",
    dimensions: 3,
    vector: [0.25, -0.5, 0.75],
  });
  const artifactSet = buildContinuationRuntimeV1EmbeddingArtifactSetRef([{
    capsule_ref: continuationRuntimeV1CapsuleRef(capsule),
    embedding_document_sha256: documentSha256,
    vector_artifact_ref: vectorRef,
  }]);
  const { principal, binding } = completionBinding(current, leased, "embedding");
  const operationId = "complete-embedding-retention-test";
  const command = buildWorkerCompletionCommandV1(operationId, {
    schema_version: "worker_completion_body_v1",
    completion: {
      status: "succeeded",
      output: { kind: "embedding", artifact_ref: artifactSet },
    },
  }, binding);
  await current.operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "worker_completion",
    operationId,
    actorKind: "worker",
    actorPrincipalSha256: principal.actor_principal_sha256,
    request: operationRequestFromVerifiedCommandV1(command),
    produce: async (context) => {
      const annPayload = buildContinuationRuntimeV1AnnJobPayload(artifactSet);
      await current.enqueuer.enqueue(context, {
        task_family: leased.task_family,
        authority_subject_sha256: leased.authority_subject_sha256,
        job_kind: "ann",
        dedupe_key: "retention-test-ann-child",
        priority: 0,
        max_attempts: 3,
        payload: annPayload,
        available_at: NOW,
      });
      await current.jobs.complete(context, {
        job_id: leased.job_id,
        lease_token: leased.lease_token!,
      });
      const authority = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        current.database,
      );
      return deriveContinuationRuntimeV1OperationResultV1(
        current.database,
        authority,
        "before_receipt_insert",
      );
    },
  });
  const annId = (current.database.db.prepare(
    "SELECT job_id FROM durable_jobs WHERE job_kind='ann'",
  ).get() as { job_id: string }).job_id;
  const ann = await current.jobs.read({
    tenant_id: TENANT,
    scope: SCOPE,
    job_id: annId,
  });
  assert.ok(ann);
  return { vectorRef, artifactSet, ann };
}

async function completeAnn(
  current: Fixture,
  artifactSet: Awaited<ReturnType<typeof completeEmbedding>>["artifactSet"],
  vectorRef: Awaited<ReturnType<typeof completeEmbedding>>["vectorRef"],
  indexStore: ReturnType<typeof createContinuationRuntimeV1AnnIndexSegmentStore>,
) {
  const leased = await lease(current, "ann", "ann-test-worker");
  const segmentRef = await indexStore.write({
    schema_version: "ann_index_segment_write_v1",
    embedding_artifact_set_ref: artifactSet,
    vectors: [{ vector_artifact_ref: vectorRef, vector: [0.25, -0.5, 0.75] }],
  });
  const receipt = buildContinuationRuntimeV1AnnIndexReceipt(
    leased.payload_sha256 as Sha256,
    segmentRef,
  );
  const { principal, binding } = completionBinding(current, leased, "ann");
  const operationId = "complete-ann-retention-test";
  const command = buildWorkerCompletionCommandV1(operationId, {
    schema_version: "worker_completion_body_v1",
    completion: {
      status: "succeeded",
      output: { kind: "ann", index_receipt: receipt },
    },
  }, binding);
  await current.operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "worker_completion",
    operationId,
    actorKind: "worker",
    actorPrincipalSha256: principal.actor_principal_sha256,
    request: operationRequestFromVerifiedCommandV1(command),
    produce: async (context) => {
      await current.jobs.complete(context, {
        job_id: leased.job_id,
        lease_token: leased.lease_token!,
      });
      const authority = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        current.database,
      );
      return deriveContinuationRuntimeV1OperationResultV1(
        current.database,
        authority,
        "before_receipt_insert",
      );
    },
  });
  return segmentRef;
}

async function failLeasedWorkerJob(
  current: Fixture,
  leased: ContinuationRuntimeV1DurableJob,
  role: "embedding" | "ann",
  suffix: string,
): Promise<void> {
  const { principal, binding } = completionBinding(current, leased, role);
  const operationId = `dead-${role}-${suffix}`;
  const error = canonicalContinuationClone({
    schema_version: "retention_test_worker_failure_v1",
    code: "intentional_dead_after_sidecar_write",
  });
  const command = buildWorkerCompletionCommandV1(operationId, {
    schema_version: "worker_completion_body_v1",
    completion: { status: "dead", retry_at: null, error },
  }, binding);
  await current.operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "worker_completion",
    operationId,
    actorKind: "worker",
    actorPrincipalSha256: principal.actor_principal_sha256,
    request: operationRequestFromVerifiedCommandV1(command),
    produce: async (context) => {
      await current.jobs.fail(context, {
        job_id: leased.job_id,
        lease_token: leased.lease_token!,
        disposition: "dead",
        retry_at: null,
        error,
      });
      const authority = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        current.database,
      );
      return deriveContinuationRuntimeV1OperationResultV1(
        current.database,
        authority,
        "before_receipt_insert",
      );
    },
  });
}

async function rollbackAnnSuccessThenDead(
  current: Fixture,
  leased: ContinuationRuntimeV1DurableJob,
  segmentRef: Awaited<ReturnType<typeof completeAnn>>,
): Promise<void> {
  const receipt = buildContinuationRuntimeV1AnnIndexReceipt(
    leased.payload_sha256 as Sha256,
    segmentRef,
  );
  const { principal, binding } = completionBinding(current, leased, "ann");
  const command = buildWorkerCompletionCommandV1("rollback-ann-success", {
    schema_version: "worker_completion_body_v1",
    completion: {
      status: "succeeded",
      output: { kind: "ann", index_receipt: receipt },
    },
  }, binding);
  await assert.rejects(current.operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "worker_completion",
    operationId: "rollback-ann-success",
    actorKind: "worker",
    actorPrincipalSha256: principal.actor_principal_sha256,
    request: operationRequestFromVerifiedCommandV1(command),
    produce: async (context) => {
      await current.jobs.complete(context, {
        job_id: leased.job_id,
        lease_token: leased.lease_token!,
      });
      throw new Error("intentional_ann_completion_rollback");
    },
  }), /intentional_ann_completion_rollback/u);
  const afterRollback = await current.jobs.read({
    tenant_id: TENANT,
    scope: SCOPE,
    job_id: leased.job_id,
  });
  assert.equal(afterRollback?.state, "leased");
  await failLeasedWorkerJob(current, leased, "ann", "after-rollback");
}

function workerConfig(path: string): ContinuationRuntimeV1WorkerConfig {
  return canonicalContinuationClone({
    dataPath: path,
    tenantId: TENANT,
    trustRootPublicKeyPath: join(path, "..", "unused-trust-root.pem"),
    trustRootSha256: "9".repeat(64),
    workerRole: "retention" as const,
    jobs: { pollMs: 10, batchSize: 1, leaseMs: 5_000 },
    logLevel: "error" as const,
    shutdownTimeoutMs: 5_000,
    embedding: null,
    effect: null,
  });
}

function attemptJob(
  job: ContinuationRuntimeV1DurableJob,
): ContinuationRuntimeV1WorkerAttemptJob<"retention"> {
  assert.equal(job.job_kind, "retention");
  assert.equal(job.state, "leased");
  assert.ok(job.lease_acquired_at);
  assert.ok(job.lease_expires_at);
  return canonicalContinuationClone({
    schema_version: "continuation_runtime_worker_attempt_job_v1" as const,
    tenant_id: job.tenant_id,
    scope: job.scope,
    task_family: job.task_family,
    authority_subject_sha256: job.authority_subject_sha256 as Sha256,
    job_id: job.job_id,
    job_kind: "retention" as const,
    payload_sha256: job.payload_sha256 as Sha256,
    payload: job.payload,
    attempt_count: job.attempt_count,
    max_attempts: job.max_attempts,
    lease_acquired_at: job.lease_acquired_at,
    lease_expires_at: job.lease_expires_at,
  });
}

const AUTHORITY_TABLES = Object.freeze([
  "runtime_meta", "memory_commits", "memory_scope_heads", "memory_items",
  "memory_relations", "capsule_revisions", "observation_snapshots",
  "authority_artifacts", "branch_revisions", "branch_capsule_bindings",
  "authority_heads", "effect_certificates",
  "effect_certificate_treatment_members", "episode_events",
  "episode_capsule_facts",
] as const);

function authoritySnapshot(database: ContinuationRuntimeV1Database): string {
  return canonicalContinuationJson(AUTHORITY_TABLES.map((table) => ({
    table,
    rows: database.db.prepare(table === "runtime_meta"
      ? `SELECT singleton, database_instance_id, schema_id, schema_version,
                schema_manifest_sha256, created_at
           FROM runtime_meta ORDER BY rowid`
      : `SELECT * FROM ${table} ORDER BY rowid`).all(),
  })));
}

async function runRetentionOnce(
  current: Fixture,
  vectorStore: ReturnType<typeof createContinuationRuntimeV1VectorArtifactStore>,
  indexStore: ReturnType<typeof createContinuationRuntimeV1AnnIndexSegmentStore>,
) {
  const processor = createContinuationRuntimeV1RetentionWorkerProcessor({
    authorityResolver: createContinuationRuntimeV1RetentionAuthorityResolver(
      current.database,
    ),
    vectorArtifactStore: vectorStore,
    indexSegmentStore: indexStore,
  });
  const service = createContinuationRuntimeV1WorkerService({
    database: current.database,
    config: workerConfig(current.path),
    processor,
  });
  const leased = await lease(
    current,
    "retention",
    `worker_retention_${service.workerPrincipal().actor_principal_sha256}`,
    5_000,
  );
  const prepared = await processor.process({
    schema_version: "continuation_runtime_worker_processor_input_v1",
    attempt_operation_id: `direct-${leased.job_id}`,
    job: attemptJob(leased),
    signal: new AbortController().signal,
  });
  const completed = await service.processLeasedJob(leased);
  assert.equal(completed.transition_state, "succeeded");
  return prepared.output.result as Readonly<Record<string, unknown>>;
}

test("retention resolves archive authority, deletes real ANN/vector sidecars idempotently, and leaves authority unchanged", async () => {
  const current = fixture("processor-cleanup");
  try {
    const seeded = await seedMemory(current, {
      operationId: "seed-cleanup-chain",
      capsuleFamilies: ["chain-family"],
      enqueueEmbedding: true,
    });
    assert.ok(seeded.embedding);
    const capsule = seeded.appended.capsules[0]!;
    const vectorRoot = `${current.path}.vector-artifacts-v1`;
    const vectorStore = createContinuationRuntimeV1VectorArtifactStore({
      rootPath: vectorRoot,
    });
    const indexStore = createContinuationRuntimeV1AnnIndexSegmentStore({
      rootPath: `${vectorRoot}/index-segments-v1`,
    });
    const embedding = await completeEmbedding(current, capsule, vectorStore);
    const segmentRef = await completeAnn(
      current,
      embedding.artifactSet,
      embedding.vectorRef,
      indexStore,
    );
    await govern(current, {
      operationId: "archive-cleanup-chain",
      taskFamily: "chain-family",
      kind: "lifecycle_archive",
    });
    assert.ok(await vectorStore.read(embedding.vectorRef));
    assert.ok(await indexStore.read(segmentRef));
    assert.deepEqual(await indexStore.discoverByCapsuleRefs({
      capsule_refs: [continuationRuntimeV1CapsuleRef(capsule)],
      scan_limit: 32_768,
    }), [segmentRef]);

    const processor = createContinuationRuntimeV1RetentionWorkerProcessor({
      authorityResolver: createContinuationRuntimeV1RetentionAuthorityResolver(
        current.database,
      ),
      vectorArtifactStore: vectorStore,
      indexSegmentStore: indexStore,
    });
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config: workerConfig(current.path),
      processor,
    });
    const leased = await lease(
      current,
      "retention",
      `worker_retention_${service.workerPrincipal().actor_principal_sha256}`,
      5_000,
    );
    const attempt = attemptJob(leased);
    const forgedMarker = "/private/forged-secret-sidecar-path";
    const forged = canonicalContinuationClone({
      ...attempt,
      payload: {
        schema_version: "retention_job_payload_v1",
        sidecar_path: forgedMarker,
      },
    }) as unknown as ContinuationRuntimeV1WorkerAttemptJob<"retention">;
    await assert.rejects(
      processor.process({
        schema_version: "continuation_runtime_worker_processor_input_v1",
        attempt_operation_id: "forged-retention-attempt",
        job: forged,
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ContinuationRuntimeV1WorkerProcessorError);
        assert.equal(error.code, "retention_payload_invalid");
        assert.equal(error.disposition, "dead");
        assert.equal(error.message.includes(forgedMarker), false);
        return true;
      },
    );
    assert.ok(await vectorStore.read(embedding.vectorRef));
    assert.ok(await indexStore.read(segmentRef));

    const authorityBefore = authoritySnapshot(current.database);
    const first = await processor.process({
      schema_version: "continuation_runtime_worker_processor_input_v1",
      attempt_operation_id: "direct-retention-first",
      job: attempt,
      signal: new AbortController().signal,
    });
    assert.equal(first.output.kind, "retention");
    assert.deepEqual(first.output.result, {
      schema_version: "retention_cleanup_result_v1",
      authority_plan_sha256: (first.output.result as {
        authority_plan_sha256: string;
      }).authority_plan_sha256,
      ann_target_count: 1,
      ann_removed_count: 1,
      ann_missing_count: 0,
      vector_target_count: 1,
      vector_removed_count: 1,
      vector_missing_count: 0,
    });
    assert.equal(await vectorStore.read(embedding.vectorRef), null);
    assert.equal(await indexStore.read(segmentRef), null);

    const second = await processor.process({
      schema_version: "continuation_runtime_worker_processor_input_v1",
      attempt_operation_id: "direct-retention-repeat",
      job: attempt,
      signal: new AbortController().signal,
    });
    assert.deepEqual(second.output.result, {
      schema_version: "retention_cleanup_result_v1",
      authority_plan_sha256: (first.output.result as {
        authority_plan_sha256: string;
      }).authority_plan_sha256,
      ann_target_count: 1,
      ann_removed_count: 0,
      ann_missing_count: 1,
      vector_target_count: 1,
      vector_removed_count: 0,
      vector_missing_count: 1,
    });

    const completed = await service.processLeasedJob(leased);
    assert.equal(completed.transition_state, "succeeded");
    assert.equal(authoritySnapshot(current.database), authorityBefore);
    const persisted = await current.jobs.read({
      tenant_id: TENANT,
      scope: SCOPE,
      job_id: leased.job_id,
    });
    assert.equal(persisted?.state, "succeeded");
    assert.equal(persisted?.terminal_reason, "worker_succeeded");
  } finally {
    await current.cleanup();
  }
});

test("retention discovers an embedding vector written before a dead completion and preserves a non-target capsule vector", async () => {
  const current = fixture("embedding-dead-orphan");
  try {
    const seeded = await seedMemory(current, {
      operationId: "seed-embedding-dead",
      capsuleFamilies: ["target-family"],
      enqueueEmbedding: true,
      includeOtherMemory: true,
    });
    const targetCapsule = seeded.appended.capsules.find(
      (capsule) => capsule.source.memory_id === "memory-a",
    );
    const otherCapsule = seeded.appended.capsules.find(
      (capsule) => capsule.source.memory_id === "memory-b",
    );
    assert.ok(targetCapsule);
    assert.ok(otherCapsule);
    const vectorRoot = `${current.path}.vector-artifacts-v1`;
    const vectorStore = createContinuationRuntimeV1VectorArtifactStore({
      rootPath: vectorRoot,
    });
    const indexStore = createContinuationRuntimeV1AnnIndexSegmentStore({
      rootPath: `${vectorRoot}/index-segments-v1`,
    });
    const writeFor = async (
      capsule: NonNullable<typeof targetCapsule>,
      vector: readonly number[],
    ) => {
      const document = buildContinuationRuntimeV1EmbeddingDocument(capsule);
      return await vectorStore.write({
        schema_version: "vector_artifact_write_v1",
        source_projection_sha256: document.source_projection_sha256,
        embedding_document_sha256:
          continuationRuntimeV1EmbeddingDocumentSha256(document),
        model: "retention-orphan-model",
        dimensions: vector.length,
        vector,
      });
    };
    const targetVector = await writeFor(targetCapsule, [0.1, 0.2, 0.3]);
    const otherVector = await writeFor(otherCapsule, [0.4, 0.5, 0.6]);
    const embeddingLease = await lease(
      current,
      "embedding",
      "embedding-dead-after-write",
    );
    await failLeasedWorkerJob(
      current,
      embeddingLease,
      "embedding",
      "orphan-vector",
    );
    await govern(current, {
      operationId: "archive-embedding-dead",
      taskFamily: "target-family",
      kind: "lifecycle_archive",
    });
    const authorityBefore = authoritySnapshot(current.database);
    const result = await runRetentionOnce(current, vectorStore, indexStore);
    assert.equal(result.vector_target_count, 1);
    assert.equal(result.vector_removed_count, 1);
    assert.equal(result.ann_target_count, 0);
    assert.equal(await vectorStore.read(targetVector), null);
    assert.ok(await vectorStore.read(otherVector));
    assert.equal(authoritySnapshot(current.database), authorityBefore);
  } finally {
    await current.cleanup();
  }
});

test("retention discovers an ANN segment after completion rollback/dead and ignores strict crash residue", async () => {
  const current = fixture("ann-dead-orphan");
  try {
    const seeded = await seedMemory(current, {
      operationId: "seed-ann-dead",
      capsuleFamilies: ["ann-orphan-family"],
      enqueueEmbedding: true,
    });
    const capsule = seeded.appended.capsules[0]!;
    const vectorRoot = `${current.path}.vector-artifacts-v1`;
    const vectorStore = createContinuationRuntimeV1VectorArtifactStore({
      rootPath: vectorRoot,
    });
    const indexRoot = `${vectorRoot}/index-segments-v1`;
    const indexStore = createContinuationRuntimeV1AnnIndexSegmentStore({
      rootPath: indexRoot,
    });
    const embedding = await completeEmbedding(current, capsule, vectorStore);
    const annLease = await lease(current, "ann", "ann-dead-after-write");
    const segmentRef = await indexStore.write({
      schema_version: "ann_index_segment_write_v1",
      embedding_artifact_set_ref: embedding.artifactSet,
      vectors: [{
        vector_artifact_ref: embedding.vectorRef,
        vector: [0.25, -0.5, 0.75],
      }],
    });
    await rollbackAnnSuccessThenDead(current, annLease, segmentRef);
    await govern(current, {
      operationId: "archive-ann-dead",
      taskFamily: "ann-orphan-family",
      kind: "lifecycle_archive",
    });

    const vectorResidue = join(
      vectorRoot,
      "objects",
      embedding.vectorRef.artifact_sha256.slice(0, 2),
      `.tmp-${"d".repeat(64)}-${"e".repeat(24)}`,
    );
    const annResidue = join(
      indexRoot,
      "segments",
      segmentRef.segment_sha256.slice(0, 2),
      `.delete-${"f".repeat(64)}-${"1".repeat(24)}`,
    );
    mkdirSync(vectorResidue, { mode: 0o700 });
    mkdirSync(annResidue, { mode: 0o700 });

    const result = await runRetentionOnce(current, vectorStore, indexStore);
    assert.equal(result.ann_target_count, 1);
    assert.equal(result.ann_removed_count, 1);
    assert.equal(result.vector_target_count, 1);
    assert.equal(result.vector_removed_count, 1);
    assert.equal(await indexStore.read(segmentRef), null);
    assert.equal(await vectorStore.read(embedding.vectorRef), null);
    const rolledBack = await current.operations.read({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "worker_completion",
      operationId: "rollback-ann-success",
    });
    assert.equal(rolledBack, null);
  } finally {
    await current.cleanup();
  }
});

test("a forged retention job sourced from suppress is rejected before any sidecar deletion", async () => {
  const current = fixture("suppress-forged-job");
  try {
    const seeded = await seedMemory(current, {
      operationId: "seed-suppress-forgery",
      capsuleFamilies: ["suppress-family"],
    });
    const capsule = seeded.appended.capsules[0]!;
    const vectorRoot = `${current.path}.vector-artifacts-v1`;
    const vectorStore = createContinuationRuntimeV1VectorArtifactStore({
      rootPath: vectorRoot,
    });
    const indexStore = createContinuationRuntimeV1AnnIndexSegmentStore({
      rootPath: `${vectorRoot}/index-segments-v1`,
    });
    const document = buildContinuationRuntimeV1EmbeddingDocument(capsule);
    const vectorRef = await vectorStore.write({
      schema_version: "vector_artifact_write_v1",
      source_projection_sha256: document.source_projection_sha256,
      embedding_document_sha256:
        continuationRuntimeV1EmbeddingDocumentSha256(document),
      model: "suppression-must-not-delete",
      dimensions: 2,
      vector: [0.2, 0.8],
    });
    const head = await current.memory.readHead(TENANT, SCOPE);
    const item = await current.memory.readMemoryItem(TENANT, SCOPE, "memory-a");
    assert.ok(head);
    assert.ok(item);
    const command = buildAuthorityDecisionCommandV1("forged-suppress-source", {
      schema_version: "authority_decision_body_v1",
      expected_head: { revision: 1, head_sha256: AUTHORITY_HEAD },
      decision: {
        kind: "lifecycle_suppress",
        memory_id: "memory-a",
        expected_memory_head: {
          revision: head.head_revision,
          head_sha256: head.head_sha256,
        },
        reason_codes: ["suppress_only"],
      },
    }, {
      tenant_id: TENANT,
      scope: SCOPE,
      actor_kind: "operator",
      actor_principal_sha256: OPERATOR,
      task_family: "suppress-family",
      authority_subject_sha256: subject("suppress-family"),
    });
    await current.operations.execute({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "authority_decision",
      operationId: command.operation_id,
      actorKind: "operator",
      actorPrincipalSha256: OPERATOR,
      request: operationRequestFromVerifiedCommandV1(command),
      produce: async (context) => {
        await current.memory.appendMemoryRevision(context, {
          expected_head_revision: head.head_revision,
          items: [{
            memory_id: "memory-a",
            memory_kind: item.memory_kind as string,
            lifecycle: "suppressed",
            authority: item.authority as "candidate" | "verified" | "authoritative",
            hydrated: true,
            projection: item.projection,
            rehydration_ref: null,
            expires_at: item.expires_at as string | null,
          }],
          relations: [],
          capsules: [],
        });
        await current.enqueuer.enqueue(context, {
          task_family: "suppress-family",
          authority_subject_sha256: subject("suppress-family"),
          job_kind: "retention",
          dedupe_key: "forged-retention-from-suppress",
          priority: 0,
          max_attempts: 3,
          payload: buildContinuationRuntimeV1RetentionJobPayload(),
          available_at: NOW,
        });
        const authority = assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          current.database,
        );
        return deriveContinuationRuntimeV1OperationResultV1(
          current.database,
          authority,
          "before_receipt_insert",
        );
      },
    });
    const processor = createContinuationRuntimeV1RetentionWorkerProcessor({
      authorityResolver: createContinuationRuntimeV1RetentionAuthorityResolver(
        current.database,
      ),
      vectorArtifactStore: vectorStore,
      indexSegmentStore: indexStore,
    });
    const leased = await lease(current, "retention", "forged-suppress-worker");
    await assert.rejects(processor.process({
      schema_version: "continuation_runtime_worker_processor_input_v1",
      attempt_operation_id: "reject-forged-suppress",
      job: attemptJob(leased),
      signal: new AbortController().signal,
    }), (error: unknown) => {
      assert.ok(error instanceof ContinuationRuntimeV1WorkerProcessorError);
      assert.equal(error.code, "retention_authority_invalid");
      assert.equal(error.disposition, "dead");
      assert.equal(error.message, "continuation_runtime_v1_worker_processor_failed");
      return true;
    });
    assert.ok(await vectorStore.read(vectorRef));
    assert.equal(
      (await current.memory.readMemoryItem(TENANT, SCOPE, "memory-a"))?.lifecycle,
      "suppressed",
    );
  } finally {
    await current.cleanup();
  }
});
