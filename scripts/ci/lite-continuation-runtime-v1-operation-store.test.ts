import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type CanonicalJson,
} from "../../src/continuation/contract.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../../src/store/continuation-runtime-v1-database.js";
import { createContinuationRuntimeV1DurableJobEnqueuer } from
  "../../src/store/continuation-runtime-v1-durable-job-enqueuer.js";
import { createContinuationRuntimeV1ObservationStore } from
  "../../src/store/continuation-runtime-v1-observation-store.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.js";
import {
  ContinuationRuntimeV1OperationActorConflictError,
  ContinuationRuntimeV1OperationConflictError,
  assertContinuationRuntimeV1AuthorityWriteContext,
  constrainContinuationRuntimeV1OperationCompletion,
  createContinuationRuntimeV1OperationStore,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationKind,
  type ContinuationRuntimeV1OperationStoreOptions,
} from "../../src/store/continuation-runtime-v1-operation-store.js";

const DATABASE_NOW = "2026-07-21T00:00:00.000Z";
const OPERATION_NOW = "2026-07-21T00:01:00.000Z";
const DATABASE_ID = "a".repeat(64);
const TASK_FAMILY = "operation-store";

function authoritySubject(tenantId: string, scope: string): string {
  return continuationAuthoritySubjectSha256V1({
    tenant_id: tenantId,
    scope,
    task_family: TASK_FAMILY,
  });
}

function fixture(): Readonly<{
  root: string;
  path: string;
  cleanup(): void;
}> {
  const root = mkdtempSync(join(tmpdir(), "aionis-continuation-operation-"));
  return {
    root,
    path: join(root, "authority", "runtime.sqlite"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function openDatabase(path: string): ContinuationRuntimeV1Database {
  return openContinuationRuntimeV1Database(path, {
    now: () => DATABASE_NOW,
    databaseInstanceId: DATABASE_ID,
  });
}

async function putTestSnapshot(
  database: ContinuationRuntimeV1Database,
  context: ContinuationRuntimeV1AuthorityWriteContext,
  operationId: string,
): Promise<void> {
  await createContinuationRuntimeV1ObservationStore(database, {
    now: () => OPERATION_NOW,
  }).put(context, {
    host_task_envelope: {
      host_task_id: `task-${operationId}`,
      episode_id: `episode-${operationId}`,
      run_id: `run-${operationId}`,
      consumer_agent_id: "operation-store-test",
      consumer_team_id: null,
      task_family: "operation-store",
      task_signature: "formal-operation-store-test",
      workflow_signature: null,
      workspace_signature: "workspace",
      source_task_sha256: "8".repeat(64),
      source_event_sha256: "9".repeat(64),
      issued_at: DATABASE_NOW,
      expires_at: "2026-07-21T02:00:00.000Z",
    },
    collector_observations: [],
    signed_observations: [],
  });
}

function createFormalOperationStore(
  database: ContinuationRuntimeV1Database,
  options: ContinuationRuntimeV1OperationStoreOptions = {},
) {
  const raw = createContinuationRuntimeV1OperationStore(database, options);
  const jobs = createContinuationRuntimeV1DurableJobEnqueuer(database, {
    now: () => OPERATION_NOW,
  });
  return Object.freeze({
    read: raw.read,
    execute: async (args: any) => raw.execute({
      ...args,
      produce: async (context) => {
        await args.produce(context);
        if (args.operationKind === "record_observations") {
          await putTestSnapshot(database, context, args.operationId);
        } else if (args.operationKind === "authority_decision") {
          await jobs.enqueue(context, {
            task_family: TASK_FAMILY,
            authority_subject_sha256: authoritySubject(args.tenantId, args.scope),
            job_kind: "retention",
            dedupe_key: `authority-${args.operationId}`,
            priority: 0,
            max_attempts: 3,
            payload: { authority_operation_id: args.operationId },
            available_at: OPERATION_NOW,
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

function operationCount(database: ContinuationRuntimeV1Database): number {
  const row = database.db.prepare("SELECT COUNT(*) AS count FROM operations").get() as {
    count: number;
  };
  return Number(row.count);
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const sqlite = error as { errcode?: unknown; message?: unknown };
  return (typeof sqlite.errcode === "number" && (sqlite.errcode & 0xff) === 5)
    || (typeof sqlite.message === "string" && /database is locked|busy/iu.test(sqlite.message));
}

test("first execution persists one canonical receipt and equal canonical input replays it", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    let nowCalls = 0;
    let producerCalls = 0;
    const store = createFormalOperationStore(database, {
      now: () => {
        nowCalls += 1;
        return OPERATION_NOW;
      },
    });
    const firstRequest = { z: ["state", 2], a: { ready: true } } as const;
    let firstContext: ContinuationRuntimeV1AuthorityWriteContext | null = null;
    const first = await store.execute({
      tenantId: "tenant-a",
      scope: "scope-a",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-a",
      request: firstRequest,
      produce: (context) => {
        producerCalls += 1;
        firstContext = context;
        const binding = assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          database!,
        );
        assert.equal(Object.isFrozen(context), true);
        assert.equal(Object.isFrozen(binding), true);
        assert.equal(binding.transactionIdentity, database!.transaction.currentTransactionIdentity());
        assert.equal(binding.tenantId, "tenant-a");
        assert.equal(binding.scope, "scope-a");
        assert.equal(binding.operationKind, "record_observations");
        assert.equal(binding.operationId, "operation-a");
        assert.equal(binding.requestSha256, canonicalContinuationSha256(firstRequest));
        assert.equal(binding.actorKind, "trusted_host");
        assert.equal(binding.actorPrincipalSha256, "1".repeat(64));
        return { z_result: [3, 2, 1], accepted: true } as const;
      },
    });

    assert.equal(first.status, "created");
    assert.equal(first.request_sha256, canonicalContinuationSha256(firstRequest));
    assert.equal(first.receipt.completed_at, OPERATION_NOW);
    assert.equal(first.receipt.request_sha256, first.request_sha256);
    assert.equal(first.receipt.actor_kind, "trusted_host");
    assert.equal(first.receipt.actor_principal_sha256, "1".repeat(64));
    assert.equal(first.receipt_sha256, canonicalContinuationSha256(first.receipt));
    assert.equal(Object.isFrozen(first.receipt), true);
    assert.equal(Object.isFrozen(first.receipt.result), true);
    assert.equal(first.receipt.result.schema_version, "record_observations_result_v1");
    assert.equal(producerCalls, 1);
    assert.equal(nowCalls, 1);
    assert.equal(operationCount(database), 1);
    assert.ok(firstContext !== null);
    assert.throws(
      () => assertContinuationRuntimeV1AuthorityWriteContext(firstContext, database!),
      /authority_write_context_expired/u,
    );

    const persisted = database.db.prepare(
      `SELECT actor_kind, actor_principal_sha256, request_sha256, request_json,
              receipt_sha256, receipt_json, completed_at
         FROM operations
        WHERE tenant_id = ? AND scope = ?
          AND operation_kind = ? AND operation_id = ?`,
    ).get(
      "tenant-a",
      "scope-a",
      "record_observations",
      "operation-a",
    ) as Record<string, unknown>;
    assert.equal(persisted.request_sha256, first.request_sha256);
    assert.equal(persisted.request_json, canonicalContinuationJson(firstRequest));
    assert.equal(persisted.actor_kind, "trusted_host");
    assert.equal(persisted.actor_principal_sha256, "1".repeat(64));
    assert.equal(persisted.receipt_sha256, first.receipt_sha256);
    assert.equal(persisted.receipt_json, canonicalContinuationJson(first.receipt));
    assert.equal(persisted.completed_at, OPERATION_NOW);

    const lookedUp = await store.read({
      tenantId: "tenant-a",
      scope: "scope-a",
      operationKind: "record_observations",
      operationId: "operation-a",
    });
    assert.ok(lookedUp !== null);
    assert.equal(Object.isFrozen(lookedUp), true);
    assert.equal(Object.isFrozen(lookedUp.request), true);
    assert.equal(Object.isFrozen((lookedUp.request as typeof firstRequest).a), true);
    assert.equal(Object.isFrozen(lookedUp.receipt), true);
    assert.equal(Object.isFrozen(lookedUp.receipt.result), true);
    assert.equal(lookedUp.request_sha256, first.request_sha256);
    assert.deepEqual(lookedUp.request, firstRequest);
    assert.equal(lookedUp.receipt_sha256, first.receipt_sha256);
    assert.deepEqual(lookedUp.receipt, first.receipt);
    assert.deepEqual(
      {
        observation_batch_id: lookedUp.receipt.operation_id,
        operation_receipt_sha256: lookedUp.receipt_sha256,
      },
      {
        observation_batch_id: "operation-a",
        operation_receipt_sha256: first.receipt_sha256,
      },
    );
    assert.equal(await store.read({
      tenantId: "tenant-a",
      scope: "scope-a",
      operationKind: "record_observations",
      operationId: "missing-operation",
    }), null);
    await assert.rejects(
      store.read({
        tenantId: "tenant-a",
        scope: "scope-a",
        operationKind: "record_observations",
        operationId: "operation-a",
        requestSha256: first.request_sha256,
      } as never),
      /operation_read_identity_shape_invalid/u,
    );

    const replay = await store.execute({
      tenantId: "tenant-a",
      scope: "scope-a",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-a",
      request: { a: { ready: true }, z: ["state", 2] },
      produce: () => {
        producerCalls += 1;
        throw new Error("replay_must_not_call_producer");
      },
    });
    assert.equal(replay.status, "replayed");
    assert.equal(replay.request_sha256, first.request_sha256);
    assert.equal(replay.receipt_sha256, first.receipt_sha256);
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(producerCalls, 1);
    assert.equal(nowCalls, 1);
    assert.equal(operationCount(database), 1);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("exact result census rolls back omitted mutations, rejects overreporting, and revalidates reads", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    const raw = createContinuationRuntimeV1OperationStore(database, {
      now: () => OPERATION_NOW,
    });
    const jobs = createContinuationRuntimeV1DurableJobEnqueuer(database, {
      now: () => OPERATION_NOW,
    });
    const emptySet = {
      count: 0,
      set_sha256: canonicalContinuationSha256([]),
      refs: [],
    } as const;

    await assert.rejects(raw.execute({
      tenantId: "tenant-census",
      scope: "scope-census",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "omitted-job",
      request: { census: "omitted" },
      produce: async (context) => {
        await putTestSnapshot(database!, context, "omitted-job");
        await jobs.enqueue(context, {
          task_family: TASK_FAMILY,
          authority_subject_sha256: authoritySubject(
            "tenant-census",
            "scope-census",
          ),
          job_kind: "embedding",
          dedupe_key: "omitted-job",
          priority: 0,
          max_attempts: 3,
          payload: { snapshot_id: "omitted-job" },
          available_at: OPERATION_NOW,
        });
        const binding = assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          database!,
        );
        const actual = deriveContinuationRuntimeV1OperationResultV1(
          database!,
          binding,
          "before_receipt_insert",
        );
        assert.equal(actual.schema_version, "record_observations_result_v1");
        return { ...actual, durable_job_set: emptySet };
      },
    }), /operation_result_declaration_mismatch/u);
    assert.equal(operationCount(database), 0);
    assert.equal(Number((database.db.prepare(
      "SELECT count(*) AS count FROM observation_snapshots",
    ).get() as { count: number }).count), 0);
    assert.equal(Number((database.db.prepare(
      "SELECT count(*) AS count FROM durable_jobs",
    ).get() as { count: number }).count), 0);

    const fakeJobRef = {
      task_family: TASK_FAMILY,
      authority_subject_sha256: authoritySubject(
        "tenant-census",
        "scope-census",
      ),
      job_id: "job_overreported",
      job_kind: "embedding" as const,
      payload_sha256: "a".repeat(64),
      definition_sha256: "b".repeat(64),
    };
    const overreportedSet = {
      count: 1,
      set_sha256: canonicalContinuationSha256([fakeJobRef]),
      refs: [fakeJobRef],
    } as const;
    await assert.rejects(raw.execute({
      tenantId: "tenant-census",
      scope: "scope-census",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "overreported-job",
      request: { census: "overreported" },
      produce: async (context) => {
        await putTestSnapshot(database!, context, "overreported-job");
        const binding = assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          database!,
        );
        const actual = deriveContinuationRuntimeV1OperationResultV1(
          database!,
          binding,
          "before_receipt_insert",
        );
        assert.equal(actual.schema_version, "record_observations_result_v1");
        return { ...actual, durable_job_set: overreportedSet };
      },
    }), /operation_result_declaration_mismatch/u);
    assert.equal(operationCount(database), 0);

    const formal = createFormalOperationStore(database, { now: () => OPERATION_NOW });
    const created = await formal.execute({
      tenantId: "tenant-census",
      scope: "scope-census",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "read-tamper",
      request: { census: "read" },
      produce: () => emptySet,
    });
    assert.equal(created.receipt.result.schema_version, "record_observations_result_v1");
    const tamperedReceipt = {
      ...created.receipt,
      result: {
        ...created.receipt.result,
        durable_job_set: overreportedSet,
      },
    };
    const tamperedJson = canonicalContinuationJson(tamperedReceipt);
    database.db.exec("DROP TRIGGER operations_no_update");
    database.db.prepare(`UPDATE operations SET receipt_json = ?, receipt_sha256 = ?
      WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`).run(
      tamperedJson,
      canonicalContinuationSha256(tamperedReceipt),
      "tenant-census",
      "scope-census",
      "record_observations",
      "read-tamper",
    );
    await assert.rejects(raw.read({
      tenantId: "tenant-census",
      scope: "scope-census",
      operationKind: "record_observations",
      operationId: "read-tamper",
    }), /operation_receipt_corrupt:result/u);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("stored canonical requests are immutable and tampering fails closed before receipt replay", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    const store = createFormalOperationStore(database, { now: () => OPERATION_NOW });
    for (const operationId of ["request-digest", "request-encoding"] as const) {
      await store.execute({
        tenantId: "tenant-request-evidence",
        scope: "scope-request-evidence",
        operationKind: "record_observations",
        actorKind: "trusted_host",
        actorPrincipalSha256: "1".repeat(64),
        operationId,
        request: { operation_id: operationId, reason_codes: ["verified"] },
        produce: () => ({ ignored: true }),
      });
    }

    assert.throws(() => database!.db.prepare(`UPDATE operations
      SET request_json = request_json
      WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`).run(
      "tenant-request-evidence",
      "scope-request-evidence",
      "record_observations",
      "request-digest",
    ), /operations is immutable/u);

    database.db.exec("DROP TRIGGER operations_no_update");
    database.db.prepare(`UPDATE operations SET request_json = ?
      WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`).run(
      canonicalContinuationJson({ tampered: true }),
      "tenant-request-evidence",
      "scope-request-evidence",
      "record_observations",
      "request-digest",
    );
    database.db.prepare(`UPDATE operations SET request_json = ?
      WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`).run(
      "{\"z\":1, \"a\":2}",
      "tenant-request-evidence",
      "scope-request-evidence",
      "record_observations",
      "request-encoding",
    );

    await assert.rejects(store.read({
      tenantId: "tenant-request-evidence",
      scope: "scope-request-evidence",
      operationKind: "record_observations",
      operationId: "request-digest",
    }), /operation_request_corrupt:request_digest/u);
    await assert.rejects(store.read({
      tenantId: "tenant-request-evidence",
      scope: "scope-request-evidence",
      operationKind: "record_observations",
      operationId: "request-encoding",
    }), /operation_request_corrupt:request_json_encoding/u);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("authority write contexts reject forgery, copying, wrong databases, transaction escape, and expiry", async () => {
  const current = fixture();
  const other = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  let otherDatabase: ContinuationRuntimeV1Database | null = null;
  const outsideTransaction = new AsyncResource("aionis-operation-context-outside");
  try {
    database = openDatabase(current.path);
    otherDatabase = openContinuationRuntimeV1Database(other.path, {
      now: () => DATABASE_NOW,
      databaseInstanceId: "b".repeat(64),
    });
    const store = createFormalOperationStore(database, {
      now: () => OPERATION_NOW,
    });
    let issued: ContinuationRuntimeV1AuthorityWriteContext | null = null;
    await store.execute({
      tenantId: "tenant-context",
      scope: "scope-context",
      operationKind: "authority_decision",
      actorKind: "operator",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-context",
      request: { expected_revision: 4 },
      produce: (context) => {
        issued = context;
        const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database!);
        assert.equal(binding.operationId, "operation-context");

        assert.throws(
          () => assertContinuationRuntimeV1AuthorityWriteContext({}, database!),
          /authority_write_context_unrecognized/u,
        );
        assert.throws(
          () => assertContinuationRuntimeV1AuthorityWriteContext(
            { ...context },
            database!,
          ),
          /authority_write_context_unrecognized/u,
        );
        assert.throws(
          () => assertContinuationRuntimeV1AuthorityWriteContext(context, otherDatabase!),
          /authority_write_context_database_mismatch/u,
        );
        outsideTransaction.runInAsyncScope(() => {
          assert.throws(
            () => assertContinuationRuntimeV1AuthorityWriteContext(context, database!),
            /authority_write_context_transaction_required/u,
          );
        });
        return { authority_revision: 5 };
      },
    });

    assert.ok(issued !== null);
    assert.throws(
      () => assertContinuationRuntimeV1AuthorityWriteContext(issued, database!),
      /authority_write_context_expired/u,
    );
  } finally {
    outsideTransaction.emitDestroy();
    await otherDatabase?.close();
    await database?.close();
    other.cleanup();
    current.cleanup();
  }
});

test("the tightest producer-discovered completion deadline is enforced before receipt insertion", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    const store = createContinuationRuntimeV1OperationStore(database, {
      now: () => OPERATION_NOW,
    });
    let issued: ContinuationRuntimeV1AuthorityWriteContext | null = null;
    await assert.rejects(store.execute({
      tenantId: "tenant-deadline",
      scope: "scope-deadline",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-deadline",
      request: { cutoff: "settlement" },
      produce: async (context) => {
        issued = context;
        await putTestSnapshot(database!, context, "operation-deadline");
        constrainContinuationRuntimeV1OperationCompletion(
          context,
          database!,
          "2026-07-21T02:00:00.000Z",
        );
        // A later call cannot relax the already registered protocol cutoff.
        constrainContinuationRuntimeV1OperationCompletion(
          context,
          database!,
          "2026-07-21T00:00:59.999Z",
        );
        constrainContinuationRuntimeV1OperationCompletion(
          context,
          database!,
          "2026-07-21T03:00:00.000Z",
        );
        const binding = assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          database!,
        );
        return deriveContinuationRuntimeV1OperationResultV1(
          database!,
          binding,
          "before_receipt_insert",
        );
      },
    }), /operation_completion_deadline_exceeded/u);
    assert.equal(operationCount(database), 0);
    assert.equal(Number((database.db.prepare(
      "SELECT COUNT(*) AS count FROM observation_snapshots",
    ).get() as { count: number }).count), 0);
    assert.ok(issued !== null);
    assert.throws(
      () => constrainContinuationRuntimeV1OperationCompletion(
        issued,
        database!,
        "2026-07-21T04:00:00.000Z",
      ),
      /authority_write_context_expired/u,
    );

    const accepted = await store.execute({
      tenantId: "tenant-deadline",
      scope: "scope-deadline",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-at-deadline",
      request: { cutoff: "exact" },
      produce: async (context) => {
        await putTestSnapshot(database!, context, "operation-at-deadline");
        constrainContinuationRuntimeV1OperationCompletion(
          context,
          database!,
          OPERATION_NOW,
        );
        const binding = assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          database!,
        );
        return deriveContinuationRuntimeV1OperationResultV1(
          database!,
          binding,
          "before_receipt_insert",
        );
      },
    });
    assert.equal(accepted.receipt.completed_at, OPERATION_NOW);
    assert.equal(operationCount(database), 1);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("same identity with a different canonical request fails with an explicit conflict", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    const store = createFormalOperationStore(database, {
      now: () => OPERATION_NOW,
    });
    await store.execute({
      tenantId: "tenant-conflict",
      scope: "scope-conflict",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-conflict",
      request: { revision: 1 },
      produce: () => ({ decision_id: "decision-1" }),
    });

    let conflictingProducerCalled = false;
    await assert.rejects(
      store.execute({
        tenantId: "tenant-conflict",
        scope: "scope-conflict",
        operationKind: "record_observations",
        actorKind: "trusted_host",
        actorPrincipalSha256: "1".repeat(64),
        operationId: "operation-conflict",
        request: { revision: 2 },
        produce: () => {
          conflictingProducerCalled = true;
          return { decision_id: "decision-2" };
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ContinuationRuntimeV1OperationConflictError);
        assert.equal(error.message, "continuation_runtime_v1_operation_conflict");
        assert.equal(error.operationId, "operation-conflict");
        assert.equal(error.operationKind, "record_observations");
        assert.notEqual(error.storedRequestSha256, error.receivedRequestSha256);
        return true;
      },
    );
    assert.equal(conflictingProducerCalled, false);
    assert.equal(operationCount(database), 1);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("a corrupt stored receipt fails closed before a different request can be called a conflict", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    const corruptRequestJson = canonicalContinuationJson({ corrupt: true });
    database.db.prepare(
      `INSERT INTO operations(
         tenant_id, scope, operation_kind, operation_id,
         actor_kind, actor_principal_sha256, request_sha256, request_json,
         receipt_sha256, receipt_json, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    ).run(
      "tenant-corrupt",
      "scope-corrupt",
      "record_observations",
      "operation-corrupt",
      "trusted_host",
      "1".repeat(64),
      canonicalContinuationSha256({ corrupt: true }),
      corruptRequestJson,
      "c".repeat(64),
      OPERATION_NOW,
    );
    let producerCalled = false;
    const store = createFormalOperationStore(database, {
      now: () => OPERATION_NOW,
    });
    await assert.rejects(
      store.read({
        tenantId: "tenant-corrupt",
        scope: "scope-corrupt",
        operationKind: "record_observations",
        operationId: "operation-corrupt",
      }),
      /operation_receipt_corrupt:receipt_envelope_shape/u,
    );
    await assert.rejects(
      store.execute({
        tenantId: "tenant-corrupt",
        scope: "scope-corrupt",
        operationKind: "record_observations",
        actorKind: "trusted_host",
        actorPrincipalSha256: "1".repeat(64),
        operationId: "operation-corrupt",
        request: { request_is_different: true },
        produce: () => {
          producerCalled = true;
          return { decision_id: "must-not-run" };
        },
      }),
      (error: unknown) => {
        assert.ok(!(error instanceof ContinuationRuntimeV1OperationConflictError));
        assert.match(
          String((error as Error).message),
          /operation_receipt_corrupt:receipt_envelope_shape/u,
        );
        return true;
      },
    );
    assert.equal(producerCalled, false);
    assert.equal(operationCount(database), 1);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("a producer failure rolls back both producer writes and the operation receipt", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    const store = createFormalOperationStore(database, {
      now: () => OPERATION_NOW,
    });
    let rolledBackContext: ContinuationRuntimeV1AuthorityWriteContext | null = null;
    await assert.rejects(
      store.execute({
        tenantId: "tenant-rollback",
        scope: "scope-rollback",
        operationKind: "record_observations",
        actorKind: "trusted_host",
        actorPrincipalSha256: "1".repeat(64),
        operationId: "operation-rollback",
        request: { outcome: "failed" },
        produce: (context) => {
          rolledBackContext = context;
          const binding = assertContinuationRuntimeV1AuthorityWriteContext(
            context,
            database!,
          );
          database!.db.prepare(
            `INSERT INTO durable_jobs(
               tenant_id, scope, task_family, authority_subject_sha256,
               job_id, job_kind, dedupe_key,
               source_operation_kind, source_operation_id,
               source_request_sha256, state, priority, attempt_count,
               max_attempts, payload_sha256, payload_json, initial_available_at,
               available_at,
               created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, 'embedding', ?, ?, ?, ?, 'queued', 0, 0, 3,
               ?, '{}', ?, ?, ?, ?)`,
          ).run(
            "tenant-rollback",
            "scope-rollback",
            TASK_FAMILY,
            authoritySubject("tenant-rollback", "scope-rollback"),
            "job-rollback",
            "dedupe-rollback",
            binding.operationKind,
            binding.operationId,
            binding.requestSha256,
            "b".repeat(64),
            OPERATION_NOW,
            OPERATION_NOW,
            OPERATION_NOW,
            OPERATION_NOW,
          );
          throw new Error("producer_failed_after_write");
        },
      }),
      /producer_failed_after_write/u,
    );
    assert.ok(rolledBackContext !== null);
    assert.throws(
      () => assertContinuationRuntimeV1AuthorityWriteContext(
        rolledBackContext,
        database!,
      ),
      /authority_write_context_expired/u,
    );
    assert.equal(operationCount(database), 0);
    assert.equal(
      Number((database.db.prepare(
        "SELECT COUNT(*) AS count FROM durable_jobs",
      ).get() as { count: number }).count),
      0,
    );

    const retry = await store.execute({
      tenantId: "tenant-rollback",
      scope: "scope-rollback",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-rollback",
      request: { outcome: "failed" },
      produce: () => ({ accepted: true }),
    });
    assert.equal(retry.status, "created");
    assert.equal(operationCount(database), 1);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("concurrent equal calls serialize and invoke exactly one producer", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    const store = createFormalOperationStore(database, {
      now: () => OPERATION_NOW,
    });
    let producerCalls = 0;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let releaseProducer!: () => void;
    const producerGate = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });
    const common = {
      tenantId: "tenant-concurrent",
      scope: "scope-concurrent",
      operationKind: "authority_decision" as const,
      actorKind: "operator" as const,
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-concurrent",
      request: { expected_revision: 7 } as const,
    };
    const firstPromise = store.execute({
      ...common,
      produce: async () => {
        producerCalls += 1;
        announceStarted();
        await producerGate;
        return { authority_revision: 8 } as const;
      },
    });
    await started;
    const secondPromise = store.execute({
      ...common,
      produce: () => {
        producerCalls += 1;
        return { authority_revision: 999 } as const;
      },
    });
    await Promise.resolve();
    assert.equal(producerCalls, 1);
    releaseProducer();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.deepEqual([first.status, second.status], ["created", "replayed"]);
    assert.deepEqual(second.receipt, first.receipt);
    assert.equal(second.receipt_sha256, first.receipt_sha256);
    assert.equal(producerCalls, 1);
    assert.equal(operationCount(database), 1);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("two opener connections fail busy without double-producing, then equal retry replays", async () => {
  const current = fixture();
  let firstDatabase: ContinuationRuntimeV1Database | null = null;
  let secondDatabase: ContinuationRuntimeV1Database | null = null;
  try {
    let announceBeforeCommit!: () => void;
    const beforeCommit = new Promise<void>((resolve) => {
      announceBeforeCommit = resolve;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let holdFirstCommit = true;
    firstDatabase = openContinuationRuntimeV1Database(current.path, {
      now: () => DATABASE_NOW,
      databaseInstanceId: DATABASE_ID,
      faultInjector: async (phase) => {
        if (phase === "before_commit" && holdFirstCommit) {
          holdFirstCommit = false;
          announceBeforeCommit();
          await commitGate;
        }
      },
    });
    secondDatabase = openContinuationRuntimeV1Database(current.path);
    secondDatabase.db.exec("PRAGMA busy_timeout = 0");
    const firstStore = createFormalOperationStore(firstDatabase, {
      now: () => OPERATION_NOW,
    });
    const secondStore = createFormalOperationStore(secondDatabase, {
      now: () => OPERATION_NOW,
    });
    let firstProducerCalls = 0;
    let secondProducerCalls = 0;
    const common = {
      tenantId: "tenant-cross-equal",
      scope: "scope-cross-equal",
      operationKind: "record_observations" as const,
      actorKind: "trusted_host" as const,
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-cross-equal",
      request: { batch_id: "batch-1" } as const,
    };
    const first = firstStore.execute({
      ...common,
      produce: () => {
        firstProducerCalls += 1;
        return { commit_id: "commit-1" } as const;
      },
    });
    await beforeCommit;
    await assert.rejects(
      secondStore.execute({
        ...common,
        produce: () => {
          secondProducerCalls += 1;
          return { commit_id: "must-not-run" } as const;
        },
      }),
      isSqliteBusy,
    );
    assert.equal(secondProducerCalls, 0);
    releaseCommit();
    const created = await first;

    const replay = await secondStore.execute({
      ...common,
      produce: () => {
        secondProducerCalls += 1;
        return { commit_id: "must-not-run" } as const;
      },
    });
    assert.equal(created.status, "created");
    assert.equal(replay.status, "replayed");
    assert.deepEqual(replay.receipt, created.receipt);
    assert.equal(firstProducerCalls, 1);
    assert.equal(secondProducerCalls, 0);
    assert.equal(operationCount(firstDatabase), 1);
  } finally {
    await secondDatabase?.close();
    await firstDatabase?.close();
    current.cleanup();
  }
});

test("two opener connections preserve the winner and conflict a different retry", async () => {
  const current = fixture();
  let firstDatabase: ContinuationRuntimeV1Database | null = null;
  let secondDatabase: ContinuationRuntimeV1Database | null = null;
  try {
    let announceBeforeCommit!: () => void;
    const beforeCommit = new Promise<void>((resolve) => {
      announceBeforeCommit = resolve;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let holdFirstCommit = true;
    firstDatabase = openContinuationRuntimeV1Database(current.path, {
      now: () => DATABASE_NOW,
      databaseInstanceId: DATABASE_ID,
      faultInjector: async (phase) => {
        if (phase === "before_commit" && holdFirstCommit) {
          holdFirstCommit = false;
          announceBeforeCommit();
          await commitGate;
        }
      },
    });
    secondDatabase = openContinuationRuntimeV1Database(current.path);
    secondDatabase.db.exec("PRAGMA busy_timeout = 0");
    const firstStore = createFormalOperationStore(firstDatabase, {
      now: () => OPERATION_NOW,
    });
    const secondStore = createFormalOperationStore(secondDatabase, {
      now: () => OPERATION_NOW,
    });
    let firstProducerCalls = 0;
    let secondProducerCalls = 0;
    const identity = {
      tenantId: "tenant-cross-conflict",
      scope: "scope-cross-conflict",
      operationKind: "record_observations" as const,
      actorKind: "trusted_host" as const,
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-cross-conflict",
    };
    const first = firstStore.execute({
      ...identity,
      request: { revision: 1 },
      produce: () => {
        firstProducerCalls += 1;
        return { decision_id: "decision-1" } as const;
      },
    });
    await beforeCommit;
    const losingCall = () => secondStore.execute({
      ...identity,
      request: { revision: 2 },
      produce: () => {
        secondProducerCalls += 1;
        return { decision_id: "must-not-run" } as const;
      },
    });
    await assert.rejects(losingCall(), isSqliteBusy);
    assert.equal(secondProducerCalls, 0);
    releaseCommit();
    const created = await first;
    assert.equal(created.status, "created");

    await assert.rejects(
      losingCall(),
      ContinuationRuntimeV1OperationConflictError,
    );
    assert.equal(firstProducerCalls, 1);
    assert.equal(secondProducerCalls, 0);
    assert.equal(operationCount(secondDatabase), 1);
  } finally {
    await secondDatabase?.close();
    await firstDatabase?.close();
    current.cleanup();
  }
});

test("a canonical receipt survives close and exact reopen replay", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    const firstStore = createFormalOperationStore(database, {
      now: () => OPERATION_NOW,
    });
    const created = await firstStore.execute({
      tenantId: "tenant-reopen",
      scope: "scope-reopen",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-reopen",
      request: { job_id: "job-1", lease_token: "lease-1" },
      produce: () => ({ completed: true, emitted: ["effect"] }),
    });
    await database.close();
    database = openContinuationRuntimeV1Database(current.path);
    let replayProducerCalled = false;
    const reopenedStore = createFormalOperationStore(database, {
      now: () => {
        throw new Error("replay_must_not_read_clock");
      },
    });
    const reopenedRecord = await reopenedStore.read({
      tenantId: "tenant-reopen",
      scope: "scope-reopen",
      operationKind: "record_observations",
      operationId: "operation-reopen",
    });
    assert.ok(reopenedRecord !== null);
    assert.deepEqual(reopenedRecord.request, {
      job_id: "job-1",
      lease_token: "lease-1",
    });
    assert.equal(
      reopenedRecord.request_sha256,
      canonicalContinuationSha256(reopenedRecord.request),
    );
    const replay = await reopenedStore.execute({
      tenantId: "tenant-reopen",
      scope: "scope-reopen",
      operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "operation-reopen",
      request: { lease_token: "lease-1", job_id: "job-1" },
      produce: () => {
        replayProducerCalled = true;
        return { completed: false };
      },
    });
    assert.equal(replay.status, "replayed");
    assert.equal(replayProducerCalled, false);
    assert.deepEqual(replay.receipt, created.receipt);
    assert.equal(replay.receipt_sha256, created.receipt_sha256);
    assert.equal(operationCount(database), 1);
    assert.equal(database.db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    assert.deepEqual(database.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("operation actors are required, role-mapped, digest-bound, and replay-stable", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    const store = createFormalOperationStore(database, {
      now: () => OPERATION_NOW,
    });
    let producerCalls = 0;
    const base = {
      tenantId: "tenant-actor",
      scope: "scope-actor",
      operationKind: "record_observations" as const,
      request: { outcome: "ok" } as const,
      produce: () => {
        producerCalls += 1;
        return { accepted: true } as const;
      },
    };
    await assert.rejects(store.execute({
      ...base,
      operationId: "wrong-role",
      actorKind: "operator",
      actorPrincipalSha256: "1".repeat(64),
    }), /operation_actor_kind_mismatch/u);
    await assert.rejects(store.execute({
      ...base,
      operationId: "bad-principal",
      actorKind: "trusted_host",
      actorPrincipalSha256: "A".repeat(64),
    }), /operation_actor_principal_sha256_invalid/u);
    const created = await store.execute({
      ...base,
      operationId: "stable-actor",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64),
    });
    assert.equal(created.receipt.actor_principal_sha256, "1".repeat(64));
    await assert.rejects(store.execute({
      ...base,
      operationId: "stable-actor",
      actorKind: "trusted_host",
      actorPrincipalSha256: "2".repeat(64),
    }), ContinuationRuntimeV1OperationActorConflictError);
    assert.equal(producerCalls, 1);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("closed kinds and canonical text, time, JSON, and transaction ownership fail closed", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    let producerCalls = 0;
    const store = createFormalOperationStore(database, {
      now: () => "2026-07-21T00:01:00Z",
    });
    await assert.rejects(
      store.execute({
        tenantId: "tenant-validation",
        scope: "scope-validation",
        operationKind: "unknown" as ContinuationRuntimeV1OperationKind,
        actorKind: "trusted_host",
        actorPrincipalSha256: "1".repeat(64),
        operationId: "unknown-kind",
        request: {},
        produce: () => {
          producerCalls += 1;
          return {};
        },
      }),
      /operation_kind_unknown/u,
    );
    await assert.rejects(
      store.execute({
        tenantId: " tenant-validation",
        scope: "scope-validation",
        operationKind: "record_observations",
        actorKind: "trusted_host",
        actorPrincipalSha256: "1".repeat(64),
        operationId: "bad-text",
        request: {},
        produce: () => {
          producerCalls += 1;
          return {};
        },
      }),
      /tenant_id_must_be_canonical_utf8_text/u,
    );
    await assert.rejects(
      store.execute({
        tenantId: "tenant-validation",
        scope: "scope-validation",
        operationKind: "record_observations",
        actorKind: "trusted_host",
        actorPrincipalSha256: "1".repeat(64),
        operationId: "bad-json",
        request: { score: 0.5 } as unknown as CanonicalJson,
        produce: () => {
          producerCalls += 1;
          return {};
        },
      }),
      /safe integers/u,
    );
    await assert.rejects(
      store.execute({
        tenantId: "tenant-validation",
        scope: "scope-validation",
        operationKind: "record_observations",
        actorKind: "trusted_host",
        actorPrincipalSha256: "1".repeat(64),
        operationId: "oversized-request",
        request: { value: "x".repeat(1_048_577) },
        produce: () => {
          producerCalls += 1;
          return {};
        },
      }),
      /operation_request_too_large/u,
    );
    let boundedWorkerProducerCalled = false;
    await assert.rejects(store.execute({
      tenantId: "tenant-validation",
      scope: "scope-validation",
      operationKind: "worker_completion",
      actorKind: "worker",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "bounded-worker-request",
      request: { body: "x".repeat(2_000_000) },
      produce: () => {
        boundedWorkerProducerCalled = true;
        throw new Error("bounded_worker_request_reached_producer");
      },
    }), /bounded_worker_request_reached_producer/u);
    assert.equal(boundedWorkerProducerCalled, true);
    let oversizedWorkerProducerCalled = false;
    await assert.rejects(store.execute({
      tenantId: "tenant-validation",
      scope: "scope-validation",
      operationKind: "worker_completion",
      actorKind: "worker",
      actorPrincipalSha256: "1".repeat(64),
      operationId: "oversized-worker-request",
      request: { body: "x".repeat(8_388_609) },
      produce: () => {
        oversizedWorkerProducerCalled = true;
        throw new Error("oversized_worker_request_reached_producer");
      },
    }), /operation_request_too_large/u);
    assert.equal(oversizedWorkerProducerCalled, false);
    await assert.rejects(
      store.execute({
        tenantId: "tenant-validation",
        scope: "scope-validation",
        operationKind: "record_observations",
        actorKind: "trusted_host",
        actorPrincipalSha256: "1".repeat(64),
        operationId: "bad-time",
        request: {},
        produce: () => {
          producerCalls += 1;
          return { accepted: true };
        },
      }),
      /canonical UTC millisecond timestamp/u,
    );
    assert.equal(producerCalls, 1, "only invalid time reaches the producer");
    assert.equal(operationCount(database), 0);

    const boundedStore = createContinuationRuntimeV1OperationStore(database, {
      now: () => OPERATION_NOW,
    });
    const boundedObservations = createContinuationRuntimeV1ObservationStore(database, {
      now: () => OPERATION_NOW,
    });
    await assert.rejects(
      boundedStore.execute({
        tenantId: "tenant-validation",
        scope: "scope-validation",
        operationKind: "record_observations",
        actorKind: "trusted_host",
        actorPrincipalSha256: "1".repeat(64),
        operationId: "oversized-result",
        request: {},
        produce: async (context) => {
          await boundedObservations.put(context, {
            host_task_envelope: {
              host_task_id: "task-oversized-result",
              episode_id: "episode-oversized-result",
              run_id: "run-oversized-result",
              consumer_agent_id: "operation-store-test",
              consumer_team_id: null,
              task_family: "operation-store",
              task_signature: "formal-operation-store-test",
              workflow_signature: null,
              workspace_signature: "workspace",
              source_task_sha256: "8".repeat(64),
              source_event_sha256: "9".repeat(64),
              issued_at: DATABASE_NOW,
              expires_at: "2026-07-21T02:00:00.000Z",
            },
            collector_observations: [],
            signed_observations: [],
          });
          return { value: "x".repeat(262_144) } as never;
        },
      }),
      /operation_result_declaration_mismatch/u,
    );
    assert.equal(operationCount(database), 0);

    await database.withTx(async () => {
      await assert.rejects(
        store.execute({
          tenantId: "tenant-validation",
          scope: "scope-validation",
          operationKind: "record_observations",
          actorKind: "trusted_host",
          actorPrincipalSha256: "1".repeat(64),
          operationId: "nested",
          request: {},
          produce: () => ({}),
        }),
        /operation_must_own_outer_transaction/u,
      );
    });
    assert.equal(operationCount(database), 0);
  } finally {
    await database?.close();
    current.cleanup();
  }
});
