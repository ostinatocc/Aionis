import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalContinuationClone } from
  "../../src/continuation/contract.ts";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.ts";
import {
  ContinuationRuntimeV1WorkerProcessorError,
  createContinuationRuntimeV1WorkerService,
  type ContinuationRuntimeV1WorkerProcessor,
  type ContinuationRuntimeV1WorkerRole,
} from "../../src/runtime-v1/worker-service.ts";
import type { ContinuationRuntimeV1WorkerConfig } from
  "../../src/runtime-v1/worker-config.ts";
import {
  createContinuationRuntimeV1DurableJobWorkerStore,
  type ContinuationRuntimeV1CanonicalObject,
  type ContinuationRuntimeV1DurableJob,
} from "../../src/store/continuation-runtime-v1-durable-job-store.ts";
import { createContinuationRuntimeV1DurableJobEnqueuer } from
  "../../src/store/continuation-runtime-v1-durable-job-enqueuer.ts";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../../src/store/continuation-runtime-v1-database.ts";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.ts";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
} from "../../src/store/continuation-runtime-v1-operation-store.ts";

type Fixture = Readonly<{
  root: string;
  path: string;
  database: ContinuationRuntimeV1Database;
  cleanup(): Promise<void>;
}>;

function fixture(authorityNow?: () => string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-worker-service-"));
  const path = join(root, "authority", "runtime.sqlite");
  const database = openContinuationRuntimeV1Database(path, {
    databaseInstanceId: "c".repeat(64),
    ...(authorityNow ? { authorityNow } : {}),
  });
  return {
    root,
    path,
    database,
    async cleanup() {
      await database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function workerConfig(
  path: string,
  tenantId: string,
  workerRole: ContinuationRuntimeV1WorkerRole,
  overrides: Partial<ContinuationRuntimeV1WorkerConfig["jobs"]> = {},
): ContinuationRuntimeV1WorkerConfig {
  return canonicalContinuationClone({
    dataPath: path,
    tenantId,
    trustRootPublicKeyPath: join(path, "..", "trust-root.pem"),
    trustRootSha256: "1".repeat(64),
    workerRole,
    jobs: {
      pollMs: 10,
      batchSize: 4,
      leaseMs: 5_000,
      ...overrides,
    },
    logLevel: "error" as const,
    shutdownTimeoutMs: 5_000,
    embedding: null,
    effect: null,
  });
}

function subject(tenantId: string, scope: string, taskFamily: string): string {
  return continuationAuthoritySubjectSha256V1({
    tenant_id: tenantId,
    scope,
    task_family: taskFamily,
  });
}

async function enqueueRetentionJob(args: Readonly<{
  database: ContinuationRuntimeV1Database;
  tenantId: string;
  scope: string;
  operationId: string;
  dedupeKey: string;
  maxAttempts?: number;
  payload?: ContinuationRuntimeV1CanonicalObject;
}>): Promise<ContinuationRuntimeV1DurableJob> {
  const taskFamily = `family-${args.scope}`;
  const jobs = createContinuationRuntimeV1DurableJobWorkerStore(args.database);
  const enqueuer = createContinuationRuntimeV1DurableJobEnqueuer(args.database);
  const operations = createContinuationRuntimeV1OperationStore(args.database);
  let createdJobId: string | null = null;
  await operations.execute({
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind: "authority_decision",
    operationId: args.operationId,
    actorKind: "operator",
    actorPrincipalSha256: "2".repeat(64),
    request: { schedule: args.dedupeKey },
    produce: async (context) => {
      const receipt = await enqueuer.enqueue(context, {
        task_family: taskFamily,
        authority_subject_sha256: subject(args.tenantId, args.scope, taskFamily),
        job_kind: "retention",
        dedupe_key: args.dedupeKey,
        priority: 0,
        max_attempts: args.maxAttempts ?? 3,
        payload: args.payload ?? { retention_action: args.dedupeKey },
        available_at: new Date(
          Date.parse(args.database.authorityNow()) - 1_000,
        ).toISOString(),
      });
      createdJobId = receipt.job_id;
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        args.database,
      );
      return deriveContinuationRuntimeV1OperationResultV1(
        args.database,
        binding,
        "before_receipt_insert",
      );
    },
  });
  assert.ok(createdJobId);
  const created = await jobs.read({
    tenant_id: args.tenantId,
    scope: args.scope,
    job_id: createdJobId,
  });
  assert.ok(created);
  return created;
}

async function leaseRetention(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  leaseMs: number,
): Promise<ContinuationRuntimeV1DurableJob> {
  const job = await createContinuationRuntimeV1DurableJobWorkerStore(database).leaseNext({
    tenant_id: tenantId,
    job_kind: "retention",
    lease_owner: `worker_retention_${createContinuationRuntimeV1WorkerService({
      database,
      config: workerConfig(database.path, tenantId, "retention", { leaseMs }),
      processor: Object.freeze({
        worker_role: "retention" as const,
        async process() {
          throw new Error("identity-only processor must not run");
        },
      }),
    }).workerPrincipal().actor_principal_sha256}`,
    lease_duration_ms: leaseMs,
  });
  assert.ok(job);
  return job;
}

function retentionSuccessProcessor(
  hooks: Readonly<{
    process?: (inTransaction: boolean, hasLeaseToken: boolean) => void;
    commit?: (inTransaction: boolean) => void;
  }> = {},
  database?: ContinuationRuntimeV1Database,
): ContinuationRuntimeV1WorkerProcessor<"retention"> {
  return Object.freeze({
    worker_role: "retention" as const,
    async process(input) {
      hooks.process?.(
        database?.transaction.inTransaction() ?? false,
        Object.prototype.hasOwnProperty.call(input.job, "lease_token"),
      );
      return {
        output: {
          kind: "retention" as const,
          result: { retention_result: "applied" },
        },
        async commitAuthority() {
          hooks.commit?.(database?.transaction.inTransaction() ?? false);
        },
      };
    },
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("worker service test wait timed out");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1));
  }
}

test("processor computation is outside SQLite, authority commit is inside, and replay skips processing", async () => {
  const current = fixture();
  try {
    await enqueueRetentionJob({
      database: current.database,
      tenantId: "tenant-a",
      scope: "scope-a",
      operationId: "schedule-success",
      dedupeKey: "success",
    });
    const config = workerConfig(current.path, "tenant-a", "retention");
    let processCount = 0;
    let commitCount = 0;
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config,
      processor: retentionSuccessProcessor({
        process(inTransaction, hasLeaseToken) {
          processCount += 1;
          assert.equal(inTransaction, false);
          assert.equal(hasLeaseToken, false);
        },
        commit(inTransaction) {
          commitCount += 1;
          assert.equal(inTransaction, true);
        },
      }, current.database),
    });
    const lease = await createContinuationRuntimeV1DurableJobWorkerStore(
      current.database,
    ).leaseNext({
      tenant_id: "tenant-a",
      job_kind: "retention",
      lease_owner: `worker_retention_${service.workerPrincipal().actor_principal_sha256}`,
      lease_duration_ms: config.jobs.leaseMs,
    });
    assert.ok(lease);

    const first = await service.processLeasedJob(lease);
    assert.equal(first.operation_status, "created");
    assert.equal(first.transition_state, "succeeded");
    assert.match(first.operation_id, /^worker_completion_[0-9a-f]{64}$/u);
    assert.equal(processCount, 1);
    assert.equal(commitCount, 1);

    const replay = await service.processLeasedJob(lease);
    assert.equal(replay.operation_status, "replayed");
    assert.equal(replay.operation_id, first.operation_id);
    assert.equal(processCount, 1);
    assert.equal(commitCount, 1);
    assert.equal(Number((current.database.db.prepare(
      `SELECT count(*) AS count FROM operations
        WHERE operation_kind = 'worker_completion'`,
    ).get() as { count: number }).count), 1);
  } finally {
    await current.cleanup();
  }
});

test("one database authority clock governs leases, processor deadlines, and completion receipts", async () => {
  let clock = "2000-01-01T00:00:00.000Z";
  const current = fixture(() => clock);
  try {
    await enqueueRetentionJob({
      database: current.database,
      tenantId: "tenant-clock",
      scope: "scope-clock",
      operationId: "schedule-clock",
      dedupeKey: "clock",
    });
    const config = workerConfig(current.path, "tenant-clock", "retention");
    let processCount = 0;
    let commitCount = 0;
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config,
      processor: retentionSuccessProcessor({
        process() { processCount += 1; },
        commit() { commitCount += 1; },
      }, current.database),
    });
    const store = createContinuationRuntimeV1DurableJobWorkerStore(current.database);
    const lease = await store.leaseNext({
      tenant_id: "tenant-clock",
      job_kind: "retention",
      lease_owner: `worker_retention_${service.workerPrincipal().actor_principal_sha256}`,
      lease_duration_ms: config.jobs.leaseMs,
    });
    assert.ok(lease);
    // The host clock is decades later. Success proves every authority check
    // uses the database clock rather than ambient Date.now().
    assert.ok(Date.now() > Date.parse(lease.lease_expires_at!));
    const completed = await service.processLeasedJob(lease);
    assert.equal(completed.transition_state, "succeeded");
    assert.equal(processCount, 1);
    assert.equal(commitCount, 1);
    assert.equal((await store.read({
      tenant_id: lease.tenant_id,
      scope: lease.scope,
      job_id: lease.job_id,
    }))?.state, "succeeded");

    clock = "2000-01-01T00:00:10.000Z";
    assert.equal(current.database.authorityNow(), clock);
  } finally {
    await current.cleanup();
  }
});

test("database clock deadline and exact expiry remain fail-closed without running the processor", async () => {
  let clock = "2001-01-01T00:00:00.000Z";
  const current = fixture(() => clock);
  try {
    await enqueueRetentionJob({
      database: current.database,
      tenantId: "tenant-clock-boundary",
      scope: "scope-deadline",
      operationId: "schedule-clock-deadline",
      dedupeKey: "clock-deadline",
    });
    const config = workerConfig(
      current.path,
      "tenant-clock-boundary",
      "retention",
    );
    let processorCalls = 0;
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config,
      processor: Object.freeze({
        worker_role: "retention" as const,
        async process() {
          processorCalls += 1;
          return {
            output: { kind: "retention" as const, result: {} },
            async commitAuthority() {},
          };
        },
      }),
    });
    const store = createContinuationRuntimeV1DurableJobWorkerStore(current.database);
    const owner = `worker_retention_${service.workerPrincipal().actor_principal_sha256}`;
    const lease = await store.leaseNext({
      tenant_id: "tenant-clock-boundary",
      job_kind: "retention",
      lease_owner: owner,
      lease_duration_ms: config.jobs.leaseMs,
    });
    assert.ok(lease?.lease_expires_at);
    const firstToken = lease.lease_token;
    clock = lease.lease_expires_at;

    await assert.rejects(
      service.processLeasedJob(lease),
      /durable_job_lease_expired/u,
    );
    assert.equal(processorCalls, 0);
    assert.equal(Number((current.database.db.prepare(
      "SELECT COUNT(*) AS count FROM operations WHERE operation_kind = 'worker_completion'",
    ).get() as { count: number }).count), 0);
    const stillLeased = await store.read({
      tenant_id: lease.tenant_id,
      scope: lease.scope,
      job_id: lease.job_id,
    });
    assert.equal(stillLeased?.state, "leased");
    assert.equal(stillLeased?.lease_token, firstToken);

    const recovered = await store.leaseNext({
      tenant_id: lease.tenant_id,
      job_kind: "retention",
      lease_owner: owner,
      lease_duration_ms: config.jobs.leaseMs,
    });
    assert.ok(recovered);
    assert.equal(recovered.job_id, lease.job_id);
    assert.equal(recovered.attempt_count, lease.attempt_count + 1);
    assert.notEqual(recovered.lease_token, firstToken);
  } finally {
    await current.cleanup();
  }
});

test("unknown processor errors persist only a stable redacted code and digest", async () => {
  const current = fixture();
  const secret = "provider-secret-response-and-stack";
  try {
    await enqueueRetentionJob({
      database: current.database,
      tenantId: "tenant-a",
      scope: "scope-error",
      operationId: "schedule-error",
      dedupeKey: "error",
      maxAttempts: 2,
    });
    const config = workerConfig(current.path, "tenant-a", "retention");
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config,
      processor: Object.freeze({
        worker_role: "retention" as const,
        async process() {
          throw new Error(secret);
        },
      }),
    });
    const store = createContinuationRuntimeV1DurableJobWorkerStore(current.database);
    const lease = await store.leaseNext({
      tenant_id: "tenant-a",
      job_kind: "retention",
      lease_owner: `worker_retention_${service.workerPrincipal().actor_principal_sha256}`,
      lease_duration_ms: config.jobs.leaseMs,
    });
    assert.ok(lease);
    const result = await service.processLeasedJob(lease);
    assert.equal(result.transition_state, "queued");
    const queued = await store.read({
      tenant_id: lease.tenant_id,
      scope: lease.scope,
      job_id: lease.job_id,
    });
    assert.deepEqual(Object.keys(queued?.last_error ?? {}).sort(), [
      "code", "error_sha256", "schema_version",
    ]);
    assert.equal(queued?.last_error?.code, "processor_unhandled_error");
    assert.match(String(queued?.last_error?.error_sha256), /^[0-9a-f]{64}$/u);
    const persisted = current.database.db.prepare(
      `SELECT request_json, receipt_json FROM operations
        WHERE operation_kind = 'worker_completion'`,
    ).get() as { request_json: string; receipt_json: string };
    const allPersisted = JSON.stringify({ queued: queued?.last_error, ...persisted });
    assert.equal(allPersisted.includes(secret), false);
    assert.equal(allPersisted.includes("stack"), false);
    assert.equal(allPersisted.includes("message"), false);
  } finally {
    await current.cleanup();
  }
});

test("explicit dead classification and commit-port failures are operation-owned transitions", async () => {
  const current = fixture();
  try {
    await enqueueRetentionJob({
      database: current.database,
      tenantId: "tenant-a",
      scope: "scope-dead",
      operationId: "schedule-dead",
      dedupeKey: "dead",
    });
    const config = workerConfig(current.path, "tenant-a", "retention");
    const deadService = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config,
      processor: Object.freeze({
        worker_role: "retention" as const,
        async process() {
          throw new ContinuationRuntimeV1WorkerProcessorError({
            code: "input_permanently_invalid",
            disposition: "dead",
          });
        },
      }),
    });
    const store = createContinuationRuntimeV1DurableJobWorkerStore(current.database);
    const deadLease = await store.leaseNext({
      tenant_id: "tenant-a",
      job_kind: "retention",
      lease_owner: `worker_retention_${deadService.workerPrincipal().actor_principal_sha256}`,
      lease_duration_ms: config.jobs.leaseMs,
    });
    assert.ok(deadLease);
    assert.equal((await deadService.processLeasedJob(deadLease)).transition_state, "dead");
    assert.equal((await store.read({
      tenant_id: deadLease.tenant_id,
      scope: deadLease.scope,
      job_id: deadLease.job_id,
    }))?.last_error?.code, "input_permanently_invalid");

    await enqueueRetentionJob({
      database: current.database,
      tenantId: "tenant-a",
      scope: "scope-commit-failure",
      operationId: "schedule-commit-failure",
      dedupeKey: "commit-failure",
      maxAttempts: 2,
    });
    const commitService = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config,
      processor: Object.freeze({
        worker_role: "retention" as const,
        async process() {
          return {
            output: { kind: "retention" as const, result: { accepted: true } },
            async commitAuthority() {
              throw new Error("sensitive commit implementation failure");
            },
          };
        },
      }),
    });
    const commitLease = await store.leaseNext({
      tenant_id: "tenant-a",
      job_kind: "retention",
      lease_owner: `worker_retention_${commitService.workerPrincipal().actor_principal_sha256}`,
      lease_duration_ms: config.jobs.leaseMs,
    });
    assert.ok(commitLease);
    assert.equal((await commitService.processLeasedJob(commitLease)).transition_state, "queued");
    const retried = await store.read({
      tenant_id: commitLease.tenant_id,
      scope: commitLease.scope,
      job_id: commitLease.job_id,
    });
    assert.equal(retried?.last_error?.code, "processor_authority_commit_failed");
  } finally {
    await current.cleanup();
  }
});

test("tenant and role filters bound each batch and payload cannot shadow authority", async () => {
  const current = fixture();
  try {
    for (const [tenantId, scope, suffix] of [
      ["tenant-a", "scope-a-1", "a-1"],
      ["tenant-a", "scope-a-2", "a-2"],
      ["tenant-b", "scope-b-1", "b-1"],
    ] as const) {
      await enqueueRetentionJob({
        database: current.database,
        tenantId,
        scope,
        operationId: `schedule-${suffix}`,
        dedupeKey: suffix,
      });
    }
    let annCalls = 0;
    const annService = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config: workerConfig(current.path, "tenant-a", "ann"),
      processor: Object.freeze({
        worker_role: "ann" as const,
        async process() {
          annCalls += 1;
          return {
            output: { kind: "ann" as const, index_receipt: { revision: 1 } },
            async commitAuthority() {},
          };
        },
      }),
    });
    assert.equal((await annService.runBatch()).leased_count, 0);
    assert.equal(annCalls, 0);

    const retentionService = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config: workerConfig(current.path, "tenant-a", "retention", { batchSize: 1 }),
      processor: retentionSuccessProcessor({}, current.database),
    });
    const batch = await retentionService.runBatch();
    assert.equal(batch.leased_count, 1);
    assert.equal(batch.succeeded_count, 1);
    const states = (current.database.db.prepare(
      `SELECT tenant_id, state, count(*) AS count FROM durable_jobs
        GROUP BY tenant_id, state ORDER BY tenant_id, state`,
    ).all() as Array<{ tenant_id: string; state: string; count: number }>).map(
      (row) => ({ ...row }),
    );
    assert.deepEqual(states, [
      { tenant_id: "tenant-a", state: "queued", count: 1 },
      { tenant_id: "tenant-a", state: "succeeded", count: 1 },
      { tenant_id: "tenant-b", state: "queued", count: 1 },
    ]);

    await enqueueRetentionJob({
      database: current.database,
      tenantId: "tenant-shadow",
      scope: "scope-shadow",
      operationId: "schedule-shadow",
      dedupeKey: "shadow",
      payload: { task_family: "payload-must-not-govern" },
    });
    const shadowConfig = workerConfig(current.path, "tenant-shadow", "retention");
    let shadowCalls = 0;
    const shadowService = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config: shadowConfig,
      processor: Object.freeze({
        worker_role: "retention" as const,
        async process() {
          shadowCalls += 1;
          return {
            output: { kind: "retention" as const, result: {} },
            async commitAuthority() {},
          };
        },
      }),
    });
    const shadowLease = await createContinuationRuntimeV1DurableJobWorkerStore(
      current.database,
    ).leaseNext({
      tenant_id: "tenant-shadow",
      job_kind: "retention",
      lease_owner: `worker_retention_${shadowService.workerPrincipal().actor_principal_sha256}`,
      lease_duration_ms: shadowConfig.jobs.leaseMs,
    });
    assert.ok(shadowLease);
    await assert.rejects(
      shadowService.processLeasedJob(shadowLease),
      /leased_job_binding_invalid/u,
    );
    assert.equal(shadowCalls, 0);
  } finally {
    await current.cleanup();
  }
});

test("lease watchdog aborts an ignoring processor and forbids every late authority commit", async () => {
  const current = fixture();
  try {
    await enqueueRetentionJob({
      database: current.database,
      tenantId: "tenant-a",
      scope: "scope-deadline",
      operationId: "schedule-deadline",
      dedupeKey: "deadline",
      maxAttempts: 2,
    });
    const config = workerConfig(current.path, "tenant-a", "retention", {
      leaseMs: 1_000,
    });
    let processorSignal: AbortSignal | null = null;
    let commitCount = 0;
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config,
      processor: Object.freeze({
        worker_role: "retention" as const,
        async process(input) {
          processorSignal = input.signal;
          return await new Promise<never>(() => undefined);
        },
      }),
    });
    const store = createContinuationRuntimeV1DurableJobWorkerStore(current.database);
    const lease = await store.leaseNext({
      tenant_id: "tenant-a",
      job_kind: "retention",
      lease_owner: `worker_retention_${service.workerPrincipal().actor_principal_sha256}`,
      lease_duration_ms: config.jobs.leaseMs,
    });
    assert.ok(lease);
    const started = Date.now();
    const result = await service.processLeasedJob(lease);
    const elapsed = Date.now() - started;
    assert.equal(result.transition_state, "queued");
    assert.equal(processorSignal?.aborted, true);
    assert.equal(commitCount, 0);
    assert.ok(elapsed >= 500 && elapsed < 1_000, `deadline elapsed ${elapsed}`);
    const queued = await store.read({
      tenant_id: lease.tenant_id,
      scope: lease.scope,
      job_id: lease.job_id,
    });
    assert.equal(queued?.last_error?.code, "processor_lease_deadline");
  } finally {
    await current.cleanup();
  }
});

test("caller abort is propagated, redacted, and settled before the lease deadline", async () => {
  const current = fixture();
  try {
    await enqueueRetentionJob({
      database: current.database,
      tenantId: "tenant-a",
      scope: "scope-abort",
      operationId: "schedule-abort",
      dedupeKey: "abort",
      maxAttempts: 2,
    });
    const config = workerConfig(current.path, "tenant-a", "retention");
    let started!: () => void;
    const didStart = new Promise<void>((resolveStart) => { started = resolveStart; });
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config,
      processor: Object.freeze({
        worker_role: "retention" as const,
        async process(input) {
          started();
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener("abort", () => {
              reject(new Error("abort reason must not persist"));
            }, { once: true });
          });
          throw new Error("unreachable");
        },
      }),
    });
    const store = createContinuationRuntimeV1DurableJobWorkerStore(current.database);
    const lease = await store.leaseNext({
      tenant_id: "tenant-a",
      job_kind: "retention",
      lease_owner: `worker_retention_${service.workerPrincipal().actor_principal_sha256}`,
      lease_duration_ms: config.jobs.leaseMs,
    });
    assert.ok(lease);
    const controller = new AbortController();
    const attempt = service.processLeasedJob(lease, controller.signal);
    await didStart;
    controller.abort("secret abort reason");
    assert.equal((await attempt).transition_state, "queued");
    const queued = await store.read({
      tenant_id: lease.tenant_id,
      scope: lease.scope,
      job_id: lease.job_id,
    });
    assert.equal(queued?.last_error?.code, "processor_aborted");
    assert.equal(JSON.stringify(queued?.last_error).includes("secret"), false);
  } finally {
    await current.cleanup();
  }
});

test("stop fences lease admission, drain waits accepted work, and public attempts stay closed", async () => {
  const current = fixture();
  try {
    for (let index = 0; index < 8; index += 1) {
      await enqueueRetentionJob({
        database: current.database,
        tenantId: "tenant-a",
        scope: `scope-stop-${index}`,
        operationId: `schedule-stop-${index}`,
        dedupeKey: `stop-${index}`,
      });
    }
    const config = workerConfig(current.path, "tenant-a", "retention", {
      batchSize: 8,
    });
    const releases: Array<() => void> = [];
    let processCount = 0;
    const service = createContinuationRuntimeV1WorkerService({
      database: current.database,
      config,
      processor: Object.freeze({
        worker_role: "retention" as const,
        async process() {
          processCount += 1;
          await new Promise<void>((resolveProcess) => releases.push(resolveProcess));
          return {
            output: { kind: "retention" as const, result: { stopped: false } },
            async commitAuthority() {},
          };
        },
      }),
    });
    const running = service.runUntilStopped();
    await waitUntil(() => processCount > 0);
    await service.stopNewWork();
    assert.equal(service.acceptingNewWork(), false);
    const acceptedAtFence = processCount;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    assert.equal(processCount, acceptedAtFence);

    let drained = false;
    const drain = service.drainInFlight().then(() => { drained = true; });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    assert.equal(drained, false);
    for (const release of releases) release();
    await drain;
    await running;
    assert.equal(service.inFlightCount(), 0);

    await enqueueRetentionJob({
      database: current.database,
      tenantId: "tenant-a",
      scope: "scope-after-stop",
      operationId: "schedule-after-stop",
      dedupeKey: "after-stop",
    });
    const store = createContinuationRuntimeV1DurableJobWorkerStore(current.database);
    const remaining = await store.leaseNext({
      tenant_id: "tenant-a",
      job_kind: "retention",
      lease_owner: `worker_retention_${service.workerPrincipal().actor_principal_sha256}`,
      lease_duration_ms: config.jobs.leaseMs,
    });
    assert.ok(remaining);
    await assert.rejects(
      service.processLeasedJob(remaining),
      /new_attempts_stopped/u,
    );
    assert.equal(processCount, acceptedAtFence);
  } finally {
    await current.cleanup();
  }
});

test("construction rejects path, role, and processor error contract drift", async () => {
  const current = fixture();
  try {
    const retention = retentionSuccessProcessor({}, current.database);
    assert.throws(() => createContinuationRuntimeV1WorkerService({
      database: current.database,
      config: workerConfig(join(current.root, "other.sqlite"), "tenant-a", "retention"),
      processor: retention,
    }), /database_path_mismatch/u);
    assert.throws(() => createContinuationRuntimeV1WorkerService({
      database: current.database,
      config: workerConfig(current.path, "tenant-a", "ann"),
      processor: retention,
    }), /processor_role_mismatch/u);
    assert.throws(() => new ContinuationRuntimeV1WorkerProcessorError({
      code: "contains-hyphen",
      disposition: "retry",
    }), /processor_error_code_invalid/u);
    assert.throws(() => new ContinuationRuntimeV1WorkerProcessorError({
      code: "valid_code",
      disposition: "later" as "retry",
    }), /processor_error_disposition_invalid/u);
  } finally {
    await current.cleanup();
  }
});
