import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalContinuationJson,
  type CanonicalJson,
} from "../../src/continuation/contract.ts";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.ts";
import {
  createContinuationRuntimeV1DurableJobWorkerStore,
  type ContinuationRuntimeV1DurableJob,
} from "../../src/store/continuation-runtime-v1-durable-job-store.ts";
import {
  ContinuationRuntimeV1DurableJobEnqueueDefinitionConflictError,
  ContinuationRuntimeV1DurableJobEnqueuePayloadConflictError,
  createContinuationRuntimeV1DurableJobEnqueuer,
  type EnqueueContinuationRuntimeV1DurableJobArgs,
} from "../../src/store/continuation-runtime-v1-durable-job-enqueuer.ts";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../../src/store/continuation-runtime-v1-database.ts";
import { createContinuationRuntimeV1ObservationStore } from
  "../../src/store/continuation-runtime-v1-observation-store.ts";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.ts";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
} from "../../src/store/continuation-runtime-v1-operation-store.ts";
import { sha256Hex } from "../../src/util/crypto.ts";

const BASE = "2026-07-21T10:00:00.000Z";
const TASK_FAMILY = "durable-job";

function authoritySubject(scope = "scope"): string {
  return continuationAuthoritySubjectSha256V1({
    tenant_id: "tenant",
    scope,
    task_family: TASK_FAMILY,
  });
}

function formalOperationStore(
  database: ContinuationRuntimeV1Database,
  clock: () => string,
) {
  const raw = createContinuationRuntimeV1OperationStore(database, { now: clock });
  return Object.freeze({
    read: raw.read,
    execute: async (args: any) => raw.execute({
      ...args,
      produce: async (context) => {
        await args.produce(context);
        if (args.operationKind === "record_observations") {
          await createContinuationRuntimeV1ObservationStore(database, {
            now: clock,
          }).put(context, {
            host_task_envelope: {
              host_task_id: `task-${args.operationId}`,
              episode_id: `episode-${args.operationId}`,
              run_id: `run-${args.operationId}`,
              consumer_agent_id: "durable-job-test",
              consumer_team_id: null,
              task_family: "durable-job",
              task_signature: "durable-job-test",
              workflow_signature: null,
              workspace_signature: "workspace",
              source_task_sha256: "8".repeat(64),
              source_event_sha256: "9".repeat(64),
              issued_at: "2026-07-21T09:00:00.000Z",
              expires_at: "2026-07-22T09:00:00.000Z",
            },
            collector_observations: [],
            signed_observations: [],
          });
        }
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
    }),
  });
}

function fixture(initialClock = BASE) {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-jobs-"));
  const path = join(root, "authority", "runtime.sqlite");
  let clock = initialClock;
  const database = openContinuationRuntimeV1Database(path, {
    databaseInstanceId: "c".repeat(64),
    now: () => "2026-07-21T09:00:00.000Z",
  });
  const createStores = (db: ContinuationRuntimeV1Database = database) => ({
    operations: formalOperationStore(db, () => clock),
    jobs: createContinuationRuntimeV1DurableJobWorkerStore(db, { now: () => clock }),
    enqueuer: createContinuationRuntimeV1DurableJobEnqueuer(db, { now: () => clock }),
  });
  return {
    root,
    path,
    database,
    createStores,
    setClock(value: string) { clock = value; },
    getClock() { return clock; },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function enqueueArgs(
  dedupeKey: string,
  overrides: Partial<EnqueueContinuationRuntimeV1DurableJobArgs> = {},
): EnqueueContinuationRuntimeV1DurableJobArgs {
  return {
    task_family: TASK_FAMILY,
    authority_subject_sha256: authoritySubject(),
    job_kind: "embedding",
    dedupe_key: dedupeKey,
    priority: 0,
    max_attempts: 3,
    payload: { effect_id: dedupeKey, nested: { enabled: true } },
    available_at: BASE,
    ...overrides,
  };
}

async function enqueueOwned(args: {
  database: ContinuationRuntimeV1Database;
  operationId: string;
  enqueue: EnqueueContinuationRuntimeV1DurableJobArgs;
  clock: () => string;
}): Promise<ContinuationRuntimeV1DurableJob> {
  const operations = formalOperationStore(args.database, args.clock);
  const jobs = createContinuationRuntimeV1DurableJobWorkerStore(args.database, {
    now: args.clock,
  });
  const enqueuer = createContinuationRuntimeV1DurableJobEnqueuer(args.database, {
    now: args.clock,
  });
  let jobId: string | undefined;
  const operation = await operations.execute({
    tenantId: "tenant",
    scope: "scope",
    operationKind: "record_observations",
    actorKind: "trusted_host",
    actorPrincipalSha256: "1".repeat(64),
    operationId: args.operationId,
    request: { dedupe_key: args.enqueue.dedupe_key, payload: args.enqueue.payload },
    produce: async (context) => {
      const receipt = await enqueuer.enqueue(context, args.enqueue);
      jobId = receipt.job_id;
      return receipt;
    },
  });
  assert.equal(operation.status, "created");
  assert.ok(jobId);
  const job = await jobs.read({ tenant_id: "tenant", scope: "scope", job_id: jobId });
  assert.ok(job);
  return job;
}

async function workerOperation<
  TResult extends Readonly<{ [key: string]: CanonicalJson }>,
>(args: {
  database: ContinuationRuntimeV1Database;
  operationId: string;
  clock: () => string;
  jobId: string;
  token: string;
  produce: (
    context: Parameters<ReturnType<typeof createContinuationRuntimeV1DurableJobWorkerStore>["complete"]>[0],
    jobs: ReturnType<typeof createContinuationRuntimeV1DurableJobWorkerStore>,
    enqueuer: ReturnType<typeof createContinuationRuntimeV1DurableJobEnqueuer>,
  ) => Promise<TResult>;
}) {
  const operations = formalOperationStore(args.database, args.clock);
  const jobs = createContinuationRuntimeV1DurableJobWorkerStore(args.database, {
    now: args.clock,
  });
  const enqueuer = createContinuationRuntimeV1DurableJobEnqueuer(args.database, {
    now: args.clock,
  });
  return await operations.execute({
    tenantId: "tenant",
    scope: "scope",
    operationKind: "worker_completion",
    actorKind: "worker",
    actorPrincipalSha256: "1".repeat(64),
    operationId: args.operationId,
    request: { job_id: args.jobId, lease_token: args.token },
    produce: (context) => args.produce(context, jobs, enqueuer),
  });
}

test("narrow enqueue capability persists jobs without worker transition methods", async () => {
  const f = fixture();
  try {
    const operations = formalOperationStore(f.database, () => f.getClock());
    const enqueuer = createContinuationRuntimeV1DurableJobEnqueuer(
      f.database,
      { now: () => f.getClock() },
    );
    const workerStore = createContinuationRuntimeV1DurableJobWorkerStore(
      f.database,
      { now: () => f.getClock() },
    );
    assert.deepEqual(Object.keys(enqueuer), ["enqueue"]);
    assert.deepEqual(Object.keys(workerStore), ["leaseNext", "complete", "fail", "read"]);
    assert.equal("enqueue" in workerStore, false);
    let firstReceipt: Awaited<ReturnType<typeof enqueuer.enqueue>> | undefined;
    await operations.execute({
      tenantId: "tenant",
      scope: "scope",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "narrow-enqueue",
      request: { kind: "narrow-enqueue" },
      produce: async (context) => {
        firstReceipt = await enqueuer.enqueue(context, enqueueArgs("narrow"));
        const repeated = await enqueuer.enqueue(context, enqueueArgs("narrow"));
        assert.deepEqual(repeated, firstReceipt);
        await assert.rejects(
          enqueuer.enqueue(context, enqueueArgs("narrow", {
            payload: { changed: true },
          })),
          ContinuationRuntimeV1DurableJobEnqueuePayloadConflictError,
        );
        await assert.rejects(
          enqueuer.enqueue(context, enqueueArgs("narrow", { priority: 1 })),
          ContinuationRuntimeV1DurableJobEnqueueDefinitionConflictError,
        );
        return firstReceipt;
      },
    });
    assert.ok(firstReceipt);
    const persisted = await f.createStores().jobs.read({
      tenant_id: "tenant",
      scope: "scope",
      job_id: firstReceipt.job_id,
    });
    assert.equal(persisted?.state, "queued");
    assert.equal(persisted?.payload_sha256, firstReceipt.payload_sha256);
  } finally {
    await f.database.close();
    f.cleanup();
  }
});

test("enqueue is operation-owned, deterministic, canonical, detached, and definition-frozen", async () => {
  const f = fixture();
  try {
    const payload = { z: 2, a: { value: "original" } };
    const first = await enqueueOwned({
      database: f.database,
      operationId: "enqueue-1",
      enqueue: enqueueArgs("same", { payload }),
      clock: () => f.getClock(),
    });
    assert.match(first.job_id, /^job_[0-9a-f]{64}$/u);
    assert.equal(first.payload_sha256, sha256Hex(canonicalContinuationJson(payload)));
    assert.deepEqual(first.source_operation, {
      tenant_id: "tenant",
      scope: "scope",
      operation_kind: "record_observations",
      operation_id: "enqueue-1",
      request_sha256: first.source_operation.request_sha256,
      actor_kind: "trusted_host",
      actor_principal_sha256: "1".repeat(64),
    });
    assert.equal(first.terminal_reason, null);
    assert.equal(first.completion_operation, null);
    assert.equal(first.previous_completion_operation, null);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.payload), true);
    payload.a.value = "caller-mutated";
    assert.deepEqual(first.payload, { a: { value: "original" }, z: 2 });

    await assert.rejects(enqueueOwned({
      database: f.database,
      operationId: "enqueue-2",
      enqueue: enqueueArgs("same", {
        priority: 999,
        max_attempts: 1,
        available_at: "2026-07-22T10:00:00.000Z",
        payload: { a: { value: "original" }, z: 2 },
      }),
      clock: () => f.getClock(),
    }), ContinuationRuntimeV1DurableJobEnqueueDefinitionConflictError);
    assert.equal(await createContinuationRuntimeV1OperationStore(f.database).read({
      tenantId: "tenant", scope: "scope", operationKind: "record_observations",
      operationId: "enqueue-2",
    }), null);
    await assert.rejects(enqueueOwned({
      database: f.database,
      operationId: "enqueue-conflict",
      enqueue: enqueueArgs("same", { payload: { different: true } }),
      clock: () => f.getClock(),
    }), ContinuationRuntimeV1DurableJobEnqueuePayloadConflictError);
    assert.equal(await createContinuationRuntimeV1OperationStore(f.database).read({
      tenantId: "tenant", scope: "scope", operationKind: "record_observations",
      operationId: "enqueue-conflict",
    }), null);
    assert.equal(Number((f.database.db.prepare(
      "SELECT COUNT(*) AS count FROM durable_jobs",
    ).get() as { count: number }).count), 1);

    const enqueuer = f.createStores().enqueuer;
    await assert.rejects(enqueuer.enqueue({} as never, enqueueArgs("forged")),
      /authority_write_context_unrecognized/u);
    await assert.rejects(enqueueOwned({
      database: f.database,
      operationId: "enqueue-large",
      enqueue: enqueueArgs("large", { payload: { value: "x".repeat(262_144) } }),
      clock: () => f.getClock(),
    }), /payload_too_large/u);
  } finally {
    await f.database.close();
    f.cleanup();
  }
});

test("one operation context may enqueue an atomic batch and expires after its producer", async () => {
  const f = fixture();
  try {
    const { operations, enqueuer } = f.createStores();
    let captured: Parameters<typeof enqueuer.enqueue>[0] | null = null;
    const execution = await operations.execute({
      tenantId: "tenant", scope: "scope", operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "batch", request: { jobs: ["batch-a", "batch-b"] },
      produce: async (context) => {
        captured = context;
        const first = await enqueuer.enqueue(
          context,
          enqueueArgs("batch-a", { job_kind: "embedding" }),
        );
        const second = await enqueuer.enqueue(context, enqueueArgs("batch-b", { job_kind: "embedding" }));
        const replay = await enqueuer.enqueue(
          context,
          enqueueArgs("batch-a", { job_kind: "embedding" }),
        );
        assert.deepEqual(replay, first);
        return { job_ids: [first.job_id, second.job_id] };
      },
    });
    assert.equal(execution.status, "created");
    assert.equal(Number((f.database.db.prepare(
      "SELECT COUNT(*) AS count FROM durable_jobs",
    ).get() as { count: number }).count), 2);
    assert.ok(captured);
    await assert.rejects(enqueuer.enqueue(captured, enqueueArgs("after-commit")),
      /authority_write_context_expired/u);
  } finally {
    await f.database.close();
    f.cleanup();
  }
});

test("leaseNext owns a short transaction and follows ready-first, priority, stable identity order", async () => {
  const f = fixture();
  try {
    const definitions = [
      enqueueArgs("later-high", { priority: 100, available_at: BASE }),
      enqueueArgs("early-low", { priority: -100, available_at: "2026-07-21T09:59:59.000Z" }),
      enqueueArgs("same-low", { priority: 1, available_at: BASE }),
      enqueueArgs("same-high", { priority: 10, available_at: BASE }),
    ];
    const created: ContinuationRuntimeV1DurableJob[] = [];
    for (const [index, definition] of definitions.entries()) {
      created.push(await enqueueOwned({
        database: f.database,
        operationId: `order-${index}`,
        enqueue: definition,
        clock: () => f.getClock(),
      }));
    }
    const jobs = f.createStores().jobs;
    const leased = [];
    for (let index = 0; index < 4; index += 1) {
      const job = await jobs.leaseNext({
        tenant_id: "tenant", job_kind: "embedding",
        lease_owner: "worker-a", lease_duration_ms: 60_000,
      });
      assert.ok(job);
      assert.equal(f.database.transaction.inTransaction(), false);
      leased.push(job);
    }
    assert.deepEqual(leased.map((job) => job.dedupe_key), [
      "later-high", "same-high", "same-low", "early-low",
    ]);
    assert.equal(new Set(leased.map((job) => job.lease_token)).size, 4);
    for (const job of leased) {
      assert.equal(job.state, "leased");
      assert.equal(job.attempt_count, 1);
      assert.match(job.lease_token!, /^[0-9a-f]{64}$/u);
      assert.ok(job.lease_acquired_at! > job.created_at);
    }

    const only = await enqueueOwned({
      database: f.database,
      operationId: "concurrent-only",
      enqueue: enqueueArgs("concurrent-only"),
      clock: () => f.getClock(),
    });
    const concurrent = await Promise.all([
      jobs.leaseNext({
        tenant_id: "tenant", job_kind: "embedding",
        lease_owner: "worker-left", lease_duration_ms: 60_000,
      }),
      jobs.leaseNext({
        tenant_id: "tenant", job_kind: "embedding",
        lease_owner: "worker-right", lease_duration_ms: 60_000,
      }),
    ]);
    assert.equal(concurrent.filter((job) => job?.job_id === only.job_id).length, 1);
    assert.equal(concurrent.filter((job) => job === null).length, 1);
    await assert.rejects(jobs.leaseNext({
      tenant_id: "tenant", job_kind: "embedding",
      lease_owner: "worker", lease_duration_ms: 999,
    }),
      /lease_duration_ms_invalid/u);

    const operations = f.createStores().operations;
    await assert.rejects(operations.execute({
      tenantId: "tenant", scope: "scope", operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "nested-lease", request: { nested: true },
      produce: async () => {
        await jobs.leaseNext({
          tenant_id: "tenant", job_kind: "embedding",
          lease_owner: "nested", lease_duration_ms: 1_000,
        });
        return { impossible: true };
      },
    }), /lease_must_own_transaction/u);
  } finally {
    await f.database.close();
    f.cleanup();
  }
});

test("expired leases are recovered before dequeue, stale tokens fail, and exhausted attempts die", async () => {
  const f = fixture();
  try {
    const job = await enqueueOwned({
      database: f.database,
      operationId: "expiry-enqueue",
      enqueue: enqueueArgs("expiry", { max_attempts: 2 }),
      clock: () => f.getClock(),
    });
    const jobs = f.createStores().jobs;
    const first = await jobs.leaseNext({
      tenant_id: "tenant", job_kind: "embedding",
      lease_owner: "worker-1", lease_duration_ms: 1_000,
    });
    assert.equal(first?.job_id, job.job_id);
    f.setClock(first!.lease_expires_at!);
    const second = await jobs.leaseNext({
      tenant_id: "tenant", job_kind: "embedding",
      lease_owner: "worker-2", lease_duration_ms: 1_000,
    });
    assert.equal(second?.job_id, job.job_id);
    assert.equal(second?.attempt_count, 2);
    assert.notEqual(second?.lease_token, first?.lease_token);
    assert.ok(second!.updated_at > first!.updated_at);

    await assert.rejects(workerOperation({
      database: f.database,
      operationId: "stale-completion",
      clock: () => f.getClock(),
      jobId: job.job_id,
      token: first!.lease_token!,
      produce: async (context, store) => {
        await store.complete(context, { job_id: job.job_id, lease_token: first!.lease_token! });
        return { impossible: true };
      },
    }), /lease_token_mismatch/u);
    f.setClock(second!.lease_expires_at!);
    assert.equal(await jobs.leaseNext({
      tenant_id: "tenant", job_kind: "embedding",
      lease_owner: "worker-3", lease_duration_ms: 1_000,
    }), null);
    const dead = await jobs.read({ tenant_id: "tenant", scope: "scope", job_id: job.job_id });
    assert.equal(dead?.state, "dead");
    assert.equal(dead?.attempt_count, 2);
    assert.equal(dead?.last_error?.code, "lease_expired_attempts_exhausted");
    assert.equal(dead?.completed_at, dead?.updated_at);
    assert.equal(dead?.terminal_reason, "lease_expired_attempts_exhausted");
    assert.equal(dead?.completion_operation, null);
    assert.equal(dead?.previous_completion_operation, null);
  } finally {
    await f.database.close();
    f.cleanup();
  }
});

test("worker completion context gates retry/dead/success transitions and exact lease expiry", async () => {
  const f = fixture();
  try {
    const job = await enqueueOwned({
      database: f.database,
      operationId: "failure-enqueue",
      enqueue: enqueueArgs("failure", { max_attempts: 2 }),
      clock: () => f.getClock(),
    });
    const jobs = f.createStores().jobs;
    const first = await jobs.leaseNext({
      tenant_id: "tenant", job_kind: "embedding",
      lease_owner: "worker", lease_duration_ms: 60_000,
    });
    assert.equal(first?.job_id, job.job_id);
    await assert.rejects(workerOperation({
      database: f.database,
      operationId: "wrong-token",
      clock: () => f.getClock(),
      jobId: job.job_id,
      token: "0".repeat(64),
      produce: async (context, store) => {
        await store.fail(context, {
          job_id: job.job_id, lease_token: "0".repeat(64), disposition: "retry",
          retry_at: BASE, error: { code: "temporary" },
        });
        return { impossible: true };
      },
    }), /lease_token_mismatch/u);
    const retry = await workerOperation({
      database: f.database,
      operationId: "retry",
      clock: () => f.getClock(),
      jobId: job.job_id,
      token: first!.lease_token!,
      produce: async (context, store) => {
        const failed = await store.fail(context, {
          job_id: job.job_id, lease_token: first!.lease_token!, disposition: "retry",
          retry_at: BASE, error: { message: "retry me", code: "temporary" },
        });
        return { state: failed.state, attempt_count: failed.attempt_count };
      },
    });
    assert.equal(retry.receipt.result.schema_version, "worker_completion_result_v1");
    if (retry.receipt.result.schema_version !== "worker_completion_result_v1") {
      throw new Error("expected worker completion result");
    }
    assert.equal(retry.receipt.result.transition_ref.state, "queued");
    const queued = await jobs.read({ tenant_id: "tenant", scope: "scope", job_id: job.job_id });
    assert.deepEqual(queued?.last_error, { code: "temporary", message: "retry me" });
    assert.equal(queued?.available_at, queued?.updated_at);
    assert.equal(queued?.completion_operation?.operation_id, "retry");
    assert.equal(queued?.previous_completion_operation, null);
    f.setClock(queued!.available_at);
    const second = await jobs.leaseNext({
      tenant_id: "tenant", job_kind: "embedding",
      lease_owner: "worker", lease_duration_ms: 60_000,
    });
    assert.equal(second?.attempt_count, 2);

    const completed = await workerOperation({
      database: f.database,
      operationId: "success",
      clock: () => f.getClock(),
      jobId: job.job_id,
      token: second!.lease_token!,
      produce: async (context, store, enqueuer) => {
        const followUp = await enqueuer.enqueue(context, enqueueArgs("follow-up", {
          job_kind: "ann", payload: { source_job_id: job.job_id },
          available_at: "2026-07-22T10:00:00.000Z",
        }));
        const succeeded = await store.complete(context, {
          job_id: job.job_id, lease_token: second!.lease_token!,
        });
        return { state: succeeded.state, follow_up_job_id: followUp.job_id };
      },
    });
    assert.equal(completed.receipt.result.schema_version, "worker_completion_result_v1");
    if (completed.receipt.result.schema_version !== "worker_completion_result_v1") {
      throw new Error("expected worker completion result");
    }
    assert.equal(completed.receipt.result.transition_ref.state, "succeeded");
    const succeeded = await jobs.read({ tenant_id: "tenant", scope: "scope", job_id: job.job_id });
    assert.equal(succeeded?.state, "succeeded");
    assert.equal(succeeded?.last_error, null);
    assert.equal(succeeded?.lease_token, null);
    assert.equal(succeeded?.terminal_reason, "worker_succeeded");
    assert.equal(succeeded?.completion_operation?.operation_kind, "worker_completion");
    assert.equal(succeeded?.completion_operation?.operation_id, "success");
    assert.equal(succeeded?.completion_operation?.actor_kind, "worker");
    assert.equal(succeeded?.previous_completion_operation?.operation_id, "retry");

    const maxOne = await enqueueOwned({
      database: f.database,
      operationId: "max-one-enqueue",
      enqueue: enqueueArgs("max-one", { max_attempts: 1 }),
      clock: () => f.getClock(),
    });
    const maxLease = await jobs.leaseNext({
      tenant_id: "tenant", job_kind: "embedding",
      lease_owner: "worker", lease_duration_ms: 60_000,
    });
    assert.equal(maxLease?.job_id, maxOne.job_id);
    const forcedDead = await workerOperation({
      database: f.database,
      operationId: "max-one-fail",
      clock: () => f.getClock(),
      jobId: maxOne.job_id,
      token: maxLease!.lease_token!,
      produce: async (context, store) => {
        const result = await store.fail(context, {
          job_id: maxOne.job_id, lease_token: maxLease!.lease_token!, disposition: "retry",
          retry_at: BASE, error: { code: "still-failed" },
        });
        return { state: result.state };
      },
    });
    assert.equal(forcedDead.receipt.result.schema_version, "worker_completion_result_v1");
    if (forcedDead.receipt.result.schema_version !== "worker_completion_result_v1") {
      throw new Error("expected worker completion result");
    }
    assert.equal(forcedDead.receipt.result.transition_ref.state, "dead");
    const deadByWorker = await jobs.read({
      tenant_id: "tenant", scope: "scope", job_id: maxOne.job_id,
    });
    assert.equal(deadByWorker?.terminal_reason, "worker_dead");
    assert.equal(deadByWorker?.completion_operation?.operation_id, "max-one-fail");
    assert.equal(deadByWorker?.previous_completion_operation, null);
  } finally {
    await f.database.close();
    f.cleanup();
  }
});

test("completion rollback is total and the same active lease survives reopen", async () => {
  const f = fixture();
  let database: ContinuationRuntimeV1Database | null = f.database;
  try {
    const job = await enqueueOwned({
      database,
      operationId: "rollback-enqueue",
      enqueue: enqueueArgs("rollback"),
      clock: () => f.getClock(),
    });
    let jobs = createContinuationRuntimeV1DurableJobWorkerStore(database, { now: () => f.getClock() });
    const lease = await jobs.leaseNext({
      tenant_id: "tenant", job_kind: "embedding",
      lease_owner: "worker", lease_duration_ms: 60_000,
    });
    await assert.rejects(workerOperation({
      database,
      operationId: "rollback-complete",
      clock: () => f.getClock(),
      jobId: job.job_id,
      token: lease!.lease_token!,
      produce: async (context, store, enqueuer) => {
        await enqueuer.enqueue(context, enqueueArgs("rollback-ann", {
          job_kind: "ann",
          payload: { source_job_id: job.job_id },
        }));
        await store.complete(context, { job_id: job.job_id, lease_token: lease!.lease_token! });
        throw new Error("abort_after_complete");
      },
    }), /abort_after_complete/u);
    assert.equal((await jobs.read({ tenant_id: "tenant", scope: "scope", job_id: job.job_id }))?.state,
      "leased");
    assert.equal(await createContinuationRuntimeV1OperationStore(database).read({
      tenantId: "tenant", scope: "scope", operationKind: "worker_completion",
      operationId: "rollback-complete",
    }), null);

    await database.close();
    database = openContinuationRuntimeV1Database(f.path);
    jobs = createContinuationRuntimeV1DurableJobWorkerStore(database, { now: () => f.getClock() });
    const reopened = await jobs.read({ tenant_id: "tenant", scope: "scope", job_id: job.job_id });
    assert.equal(reopened?.state, "leased");
    assert.equal(reopened?.lease_token, lease?.lease_token);
    await workerOperation({
      database,
      operationId: "reopen-complete",
      clock: () => f.getClock(),
      jobId: job.job_id,
      token: lease!.lease_token!,
      produce: async (context, store, enqueuer) => {
        await enqueuer.enqueue(context, enqueueArgs("rollback-ann", {
          job_kind: "ann",
          payload: { source_job_id: job.job_id },
        }));
        const result = await store.complete(context, {
          job_id: job.job_id, lease_token: lease!.lease_token!,
        });
        return { state: result.state };
      },
    });
    assert.equal((await jobs.read({ tenant_id: "tenant", scope: "scope", job_id: job.job_id }))?.state,
      "succeeded");
  } finally {
    await database?.close();
    f.cleanup();
  }
});

test("two opener lease race never issues the same job twice", async () => {
  const f = fixture();
  let second: ContinuationRuntimeV1Database | null = null;
  try {
    const job = await enqueueOwned({
      database: f.database,
      operationId: "two-opener-enqueue",
      enqueue: enqueueArgs("two-opener"),
      clock: () => f.getClock(),
    });
    second = openContinuationRuntimeV1Database(f.path);
    f.database.db.exec("PRAGMA busy_timeout = 0");
    second.db.exec("PRAGMA busy_timeout = 0");
    const firstStore = createContinuationRuntimeV1DurableJobWorkerStore(f.database, {
      now: () => f.getClock(),
    });
    const secondStore = createContinuationRuntimeV1DurableJobWorkerStore(second, {
      now: () => f.getClock(),
    });
    const settled = await Promise.allSettled([
      firstStore.leaseNext({
        tenant_id: "tenant", job_kind: "embedding",
        lease_owner: "first-opener", lease_duration_ms: 60_000,
      }),
      secondStore.leaseNext({
        tenant_id: "tenant", job_kind: "embedding",
        lease_owner: "second-opener", lease_duration_ms: 60_000,
      }),
    ]);
    const claims = settled.flatMap((result) => result.status === "fulfilled" && result.value
      ? [result.value]
      : []);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.job_id, job.job_id);
    for (const result of settled) {
      if (result.status === "rejected") {
        const sqlite = result.reason as { errcode?: unknown };
        assert.equal(typeof sqlite.errcode, "number");
        assert.equal((sqlite.errcode as number) & 0xff, 5);
      }
    }
    const authoritative = await secondStore.read({
      tenant_id: "tenant", scope: "scope", job_id: job.job_id,
    });
    assert.equal(authoritative?.state, "leased");
    assert.equal(authoritative?.lease_token, claims[0]?.lease_token);
  } finally {
    await second?.close();
    await f.database.close();
    f.cleanup();
  }
});

test("wrong database/kind contexts and exact expiry fail without changing the lease", async () => {
  const first = fixture();
  const second = fixture();
  try {
    const job = await enqueueOwned({
      database: first.database,
      operationId: "context-enqueue",
      enqueue: enqueueArgs("context"),
      clock: () => first.getClock(),
    });
    const jobs = first.createStores().jobs;
    const lease = await jobs.leaseNext({
      tenant_id: "tenant", job_kind: "embedding",
      lease_owner: "worker", lease_duration_ms: 1_000,
    });
    await assert.rejects(first.createStores().operations.execute({
      tenantId: "tenant", scope: "scope", operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "wrong-kind", request: { job_id: job.job_id },
      produce: async (context) => {
        await jobs.complete(context, { job_id: job.job_id, lease_token: lease!.lease_token! });
        return { impossible: true };
      },
    }), /worker_context_required/u);
    await assert.rejects(first.createStores().operations.execute({
      tenantId: "tenant", scope: "scope", operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "wrong-database", request: { enqueue: true },
      produce: async (context) => {
        await second.createStores().enqueuer.enqueue(
          context,
          enqueueArgs("wrong-database"),
        );
        return { impossible: true };
      },
    }), /database_mismatch/u);
    first.setClock(lease!.lease_expires_at!);
    await assert.rejects(workerOperation({
      database: first.database,
      operationId: "expired-complete",
      clock: () => first.getClock(),
      jobId: job.job_id,
      token: lease!.lease_token!,
      produce: async (context, store) => {
        await store.complete(context, { job_id: job.job_id, lease_token: lease!.lease_token! });
        return { impossible: true };
      },
    }), /lease_expired/u);
    assert.equal((await jobs.read({ tenant_id: "tenant", scope: "scope", job_id: job.job_id }))?.state,
      "leased");
  } finally {
    await second.database.close();
    await first.database.close();
    second.cleanup();
    first.cleanup();
  }
});

function derivedJobId(tenantId: string, scope: string, jobKind: string, dedupeKey: string): string {
  return `job_${sha256Hex(canonicalContinuationJson({
    schema_version: "continuation_runtime_durable_job_identity_v1",
    tenant_id: tenantId,
    scope,
    job_kind: jobKind,
    dedupe_key: dedupeKey,
  }))}`;
}

test("reads fail closed on payload corruption and DDL rejects token or terminal fabrication", async () => {
  const f = fixture();
  try {
    const insertQueued = async (args: {
      scope: string;
      dedupe: string;
      payloadJson?: string;
      payloadSha?: string;
    }) => {
      const payloadJson = args.payloadJson ?? "{}";
      const jobId = derivedJobId("tenant", args.scope, "embedding", args.dedupe);
      const operationId = `source-${args.dedupe}`;
      const requestJson = canonicalContinuationJson({ dedupe_key: args.dedupe });
      const requestSha256 = sha256Hex(requestJson);
      await f.database.withTx(async () => {
        f.database.db.prepare(`INSERT INTO durable_jobs(
          tenant_id, scope, task_family, authority_subject_sha256,
          job_id, job_kind, dedupe_key,
          source_operation_kind, source_operation_id,
          source_request_sha256, state, priority, attempt_count,
          max_attempts, payload_sha256, payload_json, initial_available_at, available_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'embedding', ?, 'record_observations', ?, ?, 'queued',
          0, 0, 3, ?, ?, ?, ?, ?, ?)`).run(
          "tenant", args.scope, TASK_FAMILY, authoritySubject(args.scope),
          jobId, args.dedupe, operationId,
          requestSha256, args.payloadSha ?? sha256Hex(payloadJson),
          payloadJson, BASE, BASE, BASE, BASE,
        );
        f.database.db.prepare(`INSERT INTO operations(
          tenant_id, scope, operation_kind, operation_id, actor_kind,
          actor_principal_sha256, request_sha256, request_json, receipt_sha256,
          receipt_json, completed_at
        ) VALUES (?, ?, 'record_observations', ?, 'trusted_host', ?, ?, ?, ?, '{}', ?)`)
          .run(
            "tenant", args.scope, operationId, "1".repeat(64),
            requestSha256, requestJson, sha256Hex(`receipt:${args.dedupe}`), BASE,
          );
      });
      return jobId;
    };
    const badDigest = await insertQueued({
      scope: "bad-digest", dedupe: "bad-digest",
      payloadSha: "0".repeat(64),
    });
    const noncanonical = await insertQueued({
      scope: "noncanonical", dedupe: "noncanonical",
      payloadJson: "{\"z\":1, \"a\":2}",
    });
    const jobs = f.createStores().jobs;
    await assert.rejects(jobs.read({ tenant_id: "tenant", scope: "bad-digest", job_id: badDigest }),
      /payload_digest/u);
    await assert.rejects(jobs.read({ tenant_id: "tenant", scope: "noncanonical", job_id: noncanonical }),
      /payload_json/u);

    const guarded = await enqueueOwned({
      database: f.database,
      operationId: "guarded-source",
      enqueue: enqueueArgs("guarded"),
      clock: () => f.getClock(),
    });
    assert.throws(() => f.database.db.prepare(`UPDATE durable_jobs SET
      state = 'leased', attempt_count = 1, lease_owner = 'worker',
      lease_token = 'predictable-token', lease_acquired_at = ?,
      lease_expires_at = ?, updated_at = ?
      WHERE tenant_id = ? AND scope = ? AND job_id = ?`).run(
      "2026-07-21T10:00:00.001Z", "2026-07-21T10:01:00.001Z",
      "2026-07-21T10:00:00.001Z", guarded.tenant_id, guarded.scope,
      guarded.job_id,
    ));
    assert.throws(() => f.database.db.prepare(`UPDATE durable_jobs SET
      state = 'succeeded', attempt_count = 1, completed_at = ?,
      terminal_reason = 'worker_succeeded',
      completion_operation_kind = 'worker_completion',
      completion_operation_id = 'fabricated', completion_request_sha256 = ?,
      updated_at = ?
      WHERE tenant_id = ? AND scope = ? AND job_id = ?`).run(
      "2026-07-21T10:00:00.001Z", "f".repeat(64),
      "2026-07-21T10:00:00.001Z", guarded.tenant_id, guarded.scope,
      guarded.job_id,
    ), /invalid durable_jobs transition|constraint failed/u);
  } finally {
    await f.database.close();
    f.cleanup();
  }
});
