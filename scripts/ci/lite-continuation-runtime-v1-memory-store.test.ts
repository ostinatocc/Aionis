import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExecutionCapsuleDraftV1 } from "../../src/continuation/capsule.ts";
import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
} from "../../src/continuation/contract.ts";
import { openContinuationRuntimeV1Database, type ContinuationRuntimeV1Database } from
  "../../src/store/continuation-runtime-v1-database.ts";
import { createContinuationRuntimeV1ObservationStore } from
  "../../src/store/continuation-runtime-v1-observation-store.ts";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.ts";
import {
  buildArchivedMemoryProjectionV1,
  ContinuationRuntimeV1MemoryHeadConflictError,
  type AppendMemoryRevisionV1Args,
  type AppendMemoryRevisionV1Result,
} from "../../src/store/continuation-runtime-v1-memory-contract.ts";
import { createContinuationRuntimeV1MemoryStore } from
  "../../src/store/continuation-runtime-v1-memory-store.ts";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
} from "../../src/store/continuation-runtime-v1-operation-store.ts";

const NOW = "2026-07-21T10:00:00.000Z";
const TEST_DATABASES = new WeakMap<object, ContinuationRuntimeV1Database>();

function testOperationStore(
  database: ContinuationRuntimeV1Database,
  options: Parameters<typeof createContinuationRuntimeV1OperationStore>[1] = {},
) {
  const store = createContinuationRuntimeV1OperationStore(database, options);
  TEST_DATABASES.set(store, database);
  return store;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-memory-"));
  const path = join(root, "authority", "runtime.sqlite");
  const database = openContinuationRuntimeV1Database(path, {
    databaseInstanceId: "b".repeat(64), now: () => "2026-07-21T09:00:00.000Z",
  });
  return { root, path, database };
}

function draft(capsuleId: string, refs: ExecutionCapsuleDraftV1["conflicts_with"] = []) {
  return {
    capsule_id: capsuleId,
    kind: "procedure" as const,
    proposed_influence: "inspect" as const,
    applicability: {
      task_family: "coding", task_signature: "task-profile", workflow_signature: null,
      workspace_signature: "workspace", producer_agent_id: "agent", owner_agent_id: null,
      owner_team_id: "team",
    },
    projection: {
      summary: `Capsule ${capsuleId}`, next_action: "Inspect state",
      target_refs: [{ kind: "memory" as const, ref: "verified-state" }],
      workflow_steps: ["inspect"], acceptance_statements: ["state verified"],
    },
    coverage_claims: [{ obligation_kind: "required_state" as const,
      target_refs: [{ kind: "memory" as const, ref: "verified-state" }],
      evidence_requirement: "runtime_state" as const, required_probe_ids: [] }],
    precondition_specs: [], evidence_refs: [], verifier_refs: [],
    conflicts_with: refs, supersedes: [], expires_at: "2026-07-22T10:00:00.000Z",
  };
}

function firstArgs(): AppendMemoryRevisionV1Args {
  return {
    expected_head_revision: null,
    items: [
      { memory_id: "memory-a", memory_kind: "state", lifecycle: "active", authority: "verified",
        hydrated: true, projection: { value: "one" }, rehydration_ref: null, expires_at: null },
      { memory_id: "memory-b", memory_kind: "fact", lifecycle: "active", authority: "verified",
        hydrated: true, projection: { value: "two" }, rehydration_ref: null, expires_at: null },
    ],
    relations: [{ relation_id: "relation-a-b", relation_kind: "depends_on", lifecycle: "active",
      source_memory_id: "memory-a", target_memory_id: "memory-b", projection: { confidence: 100 } }],
    capsules: [{ memory_id: "memory-a", draft: draft("capsule-target") }],
  };
}

test("logical archive redacts only the current materialization, remains auditable, and is terminal", async () => {
  const current = fixture();
  try {
    const memory = createContinuationRuntimeV1MemoryStore(current.database, {
      now: () => NOW,
    });
    const operations = testOperationStore(current.database, { now: () => NOW });
    await appendOwned(memory, operations, firstArgs(), "archive-seed");
    await appendOwned(memory, operations, {
      expected_head_revision: 1,
      items: [{
        memory_id: "memory-a",
        memory_kind: "state",
        lifecycle: "suppressed",
        authority: "verified",
        hydrated: true,
        projection: { value: "one" },
        rehydration_ref: null,
        expires_at: null,
      }],
      relations: [],
      capsules: [],
    }, "suppress", { operationKind: "authority_decision" });
    await appendOwned(memory, operations, {
      expected_head_revision: 2,
      items: [{
        memory_id: "memory-a",
        memory_kind: "state",
        lifecycle: "active",
        authority: "verified",
        hydrated: true,
        projection: { value: "one" },
        rehydration_ref: null,
        expires_at: null,
      }],
      relations: [],
      capsules: [],
    }, "restore-suppressed", { operationKind: "authority_decision" });

    const beforeArchive = await memory.readMemoryItem("tenant", "scope", "memory-a");
    assert.ok(beforeArchive);
    const rehydrationRef = `rehydration:v1:${"e".repeat(64)}` as const;
    const tombstone = buildArchivedMemoryProjectionV1({
      memory_id: "memory-a",
      source_projection_sha256: beforeArchive.projection_sha256 as string,
      rehydration_ref: rehydrationRef,
    });
    await appendOwned(memory, operations, {
      expected_head_revision: 3,
      items: [{
        memory_id: "memory-a",
        memory_kind: "state",
        lifecycle: "archived",
        authority: "verified",
        hydrated: false,
        projection: tombstone,
        rehydration_ref: rehydrationRef,
        expires_at: null,
      }],
      relations: [],
      capsules: [],
    }, "archive", { operationKind: "authority_decision" });
    const archived = await memory.readMemoryItem("tenant", "scope", "memory-a");
    assert.equal(archived?.lifecycle, "archived");
    assert.equal(archived?.hydrated, false);
    assert.equal(archived?.rehydration_ref, rehydrationRef);
    assert.deepEqual(archived?.projection, tombstone);
    assert.equal(canonicalContinuationJson(archived?.projection).includes("\"value\":\"one\""), false);
    const immutableGenesis = current.database.db.prepare(
      `SELECT mutation_json FROM memory_commits
        WHERE tenant_id = ? AND scope = ? AND revision = 1`,
    ).get("tenant", "scope") as { mutation_json: string };
    assert.equal(immutableGenesis.mutation_json.includes("\"value\":\"one\""), true);

    await assert.rejects(appendOwned(memory, operations, {
      expected_head_revision: 4,
      items: [{
        memory_id: "memory-a",
        memory_kind: "state",
        lifecycle: "active",
        authority: "verified",
        hydrated: true,
        projection: { value: "one" },
        rehydration_ref: null,
        expires_at: null,
      }],
      relations: [],
      capsules: [],
    }, "forbidden-archive-restore", {
      operationKind: "authority_decision",
    }), /archived_terminal/u);
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("only active memory can be created and governed quarantine is terminal", async () => {
  const current = fixture();
  try {
    const memory = createContinuationRuntimeV1MemoryStore(current.database, {
      now: () => NOW,
    });
    const operations = testOperationStore(current.database, { now: () => NOW });
    await assert.rejects(appendOwned(memory, operations, {
      expected_head_revision: null,
      items: [{
        memory_id: "memory-impossible",
        memory_kind: "state",
        lifecycle: "quarantined",
        authority: "verified",
        hydrated: true,
        projection: { value: "untrusted" },
        rehydration_ref: null,
        expires_at: null,
      }],
      relations: [],
      capsules: [],
    }, "forbidden-direct-quarantine", {
      operationKind: "authority_decision",
    }), /initial_lifecycle_invalid/u);

    await appendOwned(memory, operations, firstArgs(), "quarantine-seed");
    await appendOwned(memory, operations, {
      expected_head_revision: 1,
      items: [{
        memory_id: "memory-a",
        memory_kind: "state",
        lifecycle: "quarantined",
        authority: "verified",
        hydrated: true,
        projection: { value: "one" },
        rehydration_ref: null,
        expires_at: null,
      }],
      relations: [],
      capsules: [],
    }, "quarantine", { operationKind: "authority_decision" });
    const quarantined = await memory.readMemoryItem(
      "tenant",
      "scope",
      "memory-a",
    );
    assert.equal(quarantined?.lifecycle, "quarantined");
    assert.equal(quarantined?.hydrated, true);
    assert.deepEqual(quarantined?.projection, { value: "one" });

    await assert.rejects(appendOwned(memory, operations, {
      expected_head_revision: 2,
      items: [{
        memory_id: "memory-a",
        memory_kind: "state",
        lifecycle: "active",
        authority: "verified",
        hydrated: true,
        projection: { value: "one" },
        rehydration_ref: null,
        expires_at: null,
      }],
      relations: [],
      capsules: [],
    }, "forbidden-quarantine-restore", {
      operationKind: "authority_decision",
    }), /quarantined_terminal/u);
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

async function appendOwned(
  memory: ReturnType<typeof createContinuationRuntimeV1MemoryStore>,
  operations: ReturnType<typeof createContinuationRuntimeV1OperationStore>,
  args: AppendMemoryRevisionV1Args,
  operationId: string,
  options: Readonly<{
    operationKind?: "record_observations" | "authority_decision" | "worker_completion";
    actorKind?: "trusted_host" | "operator" | "worker";
    actorPrincipalSha256?: string;
    request?: Readonly<Record<string, string>>;
  }> = {},
): Promise<AppendMemoryRevisionV1Result> {
  let appended: AppendMemoryRevisionV1Result | null = null;
  const operationKind = options.operationKind ?? "record_observations";
  const actorKind = options.actorKind
    ?? (operationKind === "authority_decision" ? "operator"
      : operationKind === "worker_completion" ? "worker" : "trusted_host");
  const request = options.request ?? { append: operationId };
  const database = TEST_DATABASES.get(operations);
  assert.ok(database, "test operation store must retain its database");
  const execution = await operations.execute({
    tenantId: "tenant", scope: "scope", operationKind,
    actorKind,
    actorPrincipalSha256: options.actorPrincipalSha256 ?? "1".repeat(64),
    operationId, request,
    produce: async (context) => {
      if (operationKind === "record_observations") {
        await createContinuationRuntimeV1ObservationStore(database, {
          now: () => NOW,
        }).put(context, {
          host_task_envelope: {
            host_task_id: `task-${operationId}`,
            episode_id: `episode-${operationId}`,
            run_id: `run-${operationId}`,
            consumer_agent_id: "agent",
            consumer_team_id: null,
            task_family: "coding",
            task_signature: "task-profile",
            workflow_signature: null,
            workspace_signature: "workspace",
            source_task_sha256: "8".repeat(64),
            source_event_sha256: "9".repeat(64),
            issued_at: "2026-07-21T09:00:00.000Z",
            expires_at: "2026-07-21T12:00:00.000Z",
          },
          collector_observations: [],
          signed_observations: [],
        });
      }
      appended = await memory.appendMemoryRevision(context, args);
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      return deriveContinuationRuntimeV1OperationResultV1(
        database,
        binding,
        "before_receipt_insert",
      );
    },
  });
  assert.equal(execution.status, "created");
  assert.ok(appended);
  return appended;
}

function expectedCommitId(args: Readonly<{
  revision: number;
  operationId: string;
  parentCommitSha256: string | null;
  actorPrincipalSha256?: string;
}>): string {
  return `mc_${canonicalContinuationSha256({
    schema_version: "memory_commit_id_v1",
    source_operation: {
      tenant_id: "tenant",
      scope: "scope",
      operation_kind: "record_observations",
      operation_id: args.operationId,
      request_sha256: canonicalContinuationSha256({ append: args.operationId }),
      actor_kind: "trusted_host",
      actor_principal_sha256: args.actorPrincipalSha256 ?? "1".repeat(64),
    },
    revision: args.revision,
    parent_commit_sha256: args.parentCommitSha256,
  })}`;
}

test("memory authority appends, advances monotonically, authenticates refs, and survives reopen", async () => {
  const f = fixture();
  let database: ContinuationRuntimeV1Database | null = f.database;
  try {
    let store = createContinuationRuntimeV1MemoryStore(database, { now: () => NOW });
    let operations = testOperationStore(database, { now: () => NOW });
    const first = await appendOwned(store, operations, firstArgs(), "operation-1");
    assert.equal(first.commit.revision, 1);
    assert.equal(first.commit.created_at, NOW);
    assert.equal(first.commit.commit_id, expectedCommitId({
      revision: 1,
      operationId: "operation-1",
      parentCommitSha256: null,
    }));
    const firstLineage = {
      tenant_id: "tenant",
      scope: "scope",
      operation_kind: "record_observations",
      operation_id: "operation-1",
      request_sha256: canonicalContinuationSha256({ append: "operation-1" }),
      actor_kind: "trusted_host",
      actor_principal_sha256: "1".repeat(64),
    } as const;
    assert.deepEqual(first.commit.source_operation, firstLineage);
    assert.deepEqual(first.head.source_operation, firstLineage);
    assert.equal(first.capsules[0]?.created_at, NOW);
    assert.equal(first.capsules[0]?.source.source_commit_id, first.commit.commit_id);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.commit));
    assert.ok(Object.isFrozen(first.commit.source_operation));
    assert.ok(Object.isFrozen(first.head));
    assert.ok(Object.isFrozen(first.head.source_operation));
    assert.ok(Object.isFrozen(first.capsules));
    assert.ok(Object.isFrozen(first.capsules[0]));
    const requestBindings = database.db.prepare(`SELECT
      memory_commit.request_sha256 AS commit_request,
      memory_commit.source_operation_kind AS commit_kind,
      memory_commit.source_operation_id AS commit_operation_id,
      memory_commit.source_request_sha256 AS commit_source_request,
      memory_commit.actor_kind AS commit_actor_kind,
      memory_commit.actor_principal_sha256 AS commit_actor_principal,
      memory_head.source_operation_kind AS head_kind,
      memory_head.source_operation_id AS head_operation_id,
      memory_head.source_request_sha256 AS head_source_request,
      source_operation.request_sha256 AS operation_request
      FROM memory_commits AS memory_commit
      JOIN memory_scope_heads AS memory_head USING (tenant_id, scope)
      JOIN operations AS source_operation
        ON source_operation.tenant_id = memory_commit.tenant_id
       AND source_operation.scope = memory_commit.scope
       AND source_operation.operation_kind = memory_commit.source_operation_kind
       AND source_operation.operation_id = memory_commit.source_operation_id
      WHERE memory_commit.tenant_id='tenant' AND memory_commit.scope='scope'
        AND memory_commit.revision=1`).get() as {
      commit_request: string; commit_kind: string; commit_operation_id: string;
      commit_source_request: string; commit_actor_kind: string; commit_actor_principal: string;
      head_kind: string; head_operation_id: string; head_source_request: string;
      operation_request: string;
    };
    assert.equal(requestBindings.commit_request, requestBindings.operation_request);
    assert.deepEqual({
      operation_kind: requestBindings.commit_kind,
      operation_id: requestBindings.commit_operation_id,
      request_sha256: requestBindings.commit_source_request,
      actor_kind: requestBindings.commit_actor_kind,
      actor_principal_sha256: requestBindings.commit_actor_principal,
    }, {
      operation_kind: firstLineage.operation_kind,
      operation_id: firstLineage.operation_id,
      request_sha256: firstLineage.request_sha256,
      actor_kind: firstLineage.actor_kind,
      actor_principal_sha256: firstLineage.actor_principal_sha256,
    });
    assert.deepEqual([
      requestBindings.head_kind,
      requestBindings.head_operation_id,
      requestBindings.head_source_request,
    ], [firstLineage.operation_kind, firstLineage.operation_id, firstLineage.request_sha256]);
    const { actor_kind: _actorKind, actor_principal_sha256: _actorPrincipal, ...actorBlindLineage }
      = firstLineage;
    assert.notEqual(first.commit.commit_id, `mc_${canonicalContinuationSha256({
      schema_version: "memory_commit_id_v1", source_operation: actorBlindLineage,
      revision: 1, parent_commit_sha256: null,
    })}`);
    assert.notEqual(first.commit.commit_sha256, canonicalContinuationSha256({
      schema_version: "memory_commit_v1", tenant_id: "tenant", scope: "scope",
      revision: 1, commit_id: first.commit.commit_id, parent_revision: null,
      parent_commit_id: null, parent_commit_sha256: null,
      request_sha256: firstLineage.request_sha256, source_operation: actorBlindLineage,
      mutation_sha256: first.commit.mutation_sha256, created_at: first.commit.created_at,
    }));
    assert.notEqual(first.head.head_sha256, canonicalContinuationSha256({
      schema_version: "memory_scope_head_v1", tenant_id: "tenant", scope: "scope",
      head_revision: 1, head_commit_id: first.commit.commit_id,
      head_commit_sha256: first.commit.commit_sha256,
      source_operation: actorBlindLineage, updated_at: first.commit.created_at,
    }));
    const firstHead = await store.readHead("tenant", "scope");
    const firstItem = await store.readMemoryItem("tenant", "scope", "memory-a");
    const firstRelation = await store.readRelation("tenant", "scope", "relation-a-b");
    assert.equal(firstHead?.head_sha256, first.head.head_sha256);
    assert.deepEqual(firstItem?.projection, { value: "one" });
    assert.deepEqual(firstRelation?.projection, { confidence: 100 });
    assert.ok(Object.isFrozen(firstHead));
    assert.ok(Object.isFrozen(firstItem));
    assert.ok(Object.isFrozen(firstItem?.projection));
    assert.ok(Object.isFrozen(firstRelation));
    assert.ok(Object.isFrozen(firstRelation?.projection));
    assert.throws(() => {
      (firstItem!.projection as { value: string }).value = "caller-tamper";
    }, TypeError);
    assert.deepEqual((await store.readMemoryItem("tenant", "scope", "memory-a"))?.projection,
      { value: "one" });
    assert.deepEqual(await store.auditScope("tenant", "scope"), {
      head: first.head,
      verified_commit_count: 1,
    });

    const target = first.capsules[0]!;
    const second = await appendOwned(store, operations, {
      expected_head_revision: 1,
      items: [{ memory_id: "memory-a", memory_kind: "state", lifecycle: "active", authority: "authoritative",
        hydrated: true, projection: { value: "updated" }, rehydration_ref: null, expires_at: null }],
      relations: [],
      capsules: [{ memory_id: "memory-a", draft: draft("capsule-main", [{
        capsule_id: target.capsule_id, capsule_revision: target.capsule_revision,
        capsule_sha256: target.capsule_sha256,
      }]) }],
    }, "operation-2");
    assert.equal(second.commit.revision, 2);
    assert.equal(second.commit.commit_id, expectedCommitId({
      revision: 2,
      operationId: "operation-2",
      parentCommitSha256: first.commit.commit_sha256,
    }));
    assert.equal(second.commit.created_at, "2026-07-21T10:00:00.001Z");
    assert.equal(second.capsules[0]?.created_at, second.commit.created_at);
    assert.equal(second.capsules[0]?.conflicts_with[0]?.capsule_sha256, target.capsule_sha256);

    const third = await appendOwned(store, operations, {
      expected_head_revision: 2,
      items: [], relations: [], capsules: [{ memory_id: "memory-a", draft: draft("capsule-main") }],
    }, "operation-3");
    assert.equal(third.commit.created_at, "2026-07-21T10:00:00.002Z");
    assert.equal(third.commit.commit_id, expectedCommitId({
      revision: 3,
      operationId: "operation-3",
      parentCommitSha256: second.commit.commit_sha256,
    }));
    assert.equal(third.capsules[0]?.capsule_revision, 2);
    assert.equal(third.capsules[0]?.parent_capsule_sha256, second.capsules[0]?.capsule_sha256);

    const injected = { ...draft("capsule-injected"), created_at: "2020-01-01T00:00:00.000Z" };
    await assert.rejects(appendOwned(store, operations, {
      expected_head_revision: 3,
      items: [], relations: [],
      capsules: [{ memory_id: "memory-a", draft: injected as never }],
    }, "operation-injected"), /created_at_forbidden/u);
    const mismatched = draft("capsule-mismatch", [{ capsule_id: target.capsule_id,
      capsule_revision: target.capsule_revision, capsule_sha256: target.capsule_sha256 }]);
    await assert.rejects(appendOwned(store, operations, {
      expected_head_revision: 3,
      items: [], relations: [],
      capsules: [{ memory_id: "memory-a", draft: { ...mismatched,
        applicability: { ...mismatched.applicability, task_family: "different-profile" } } }],
    }, "operation-mismatch"), /ref_profile_mismatch/u);
    await assert.rejects(appendOwned(store, operations, {
      ...firstArgs(), expected_head_revision: 3, commit_id: "caller-controlled",
    } as AppendMemoryRevisionV1Args, "operation-commit-injection"), /append_args_shape_invalid/u);
    await assert.rejects(appendOwned(store, operations, {
      ...firstArgs(), expected_head_revision: 3,
      items: [{ ...firstArgs().items[0]!, memory_kind: "state\ncontrol" }],
      relations: [], capsules: [],
    }, "operation-control-text"), /memory_kind_invalid/u);
    await assert.rejects(appendOwned(store, operations, {
      ...firstArgs(), expected_head_revision: 3,
      items: [{ ...firstArgs().items[0]!, memory_id: "memory-\ud800" }],
      relations: [], capsules: [],
    }, "operation-nonscalar-text"), /Unicode scalar values/u);
    assert.equal((await store.readHead("tenant", "scope"))?.head_revision, 3);
    const audit = await store.auditScope("tenant", "scope");
    assert.equal(audit.verified_commit_count, 3);
    assert.ok(Object.isFrozen(audit));
    assert.ok(Object.isFrozen(audit.head));

    await database.close();
    database = openContinuationRuntimeV1Database(f.path);
    store = createContinuationRuntimeV1MemoryStore(database);
    operations = testOperationStore(database);
    const reopenedHead = await store.readHead("tenant", "scope");
    assert.equal(reopenedHead?.head_revision, 3);
    assert.deepEqual(reopenedHead?.source_operation, third.commit.source_operation);
    assert.ok(Object.isFrozen(reopenedHead?.source_operation));
    assert.equal((await store.auditScope("tenant", "scope")).verified_commit_count, 3);
    assert.equal((await store.readCapsule("tenant", "scope", "capsule-target", 1))?.capsule_sha256,
      target.capsule_sha256);
    assert.equal((await store.readCapsule("tenant", "scope", "capsule-main", 2))?.capsule_sha256,
      third.capsules[0]?.capsule_sha256);
  } finally {
    await database?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("same expected head is CAS serialized and only one concurrent append commits", async () => {
  const f = fixture();
  try {
    const store = createContinuationRuntimeV1MemoryStore(f.database, { now: () => NOW });
    const operations = testOperationStore(f.database, { now: () => NOW });
    await assert.rejects(store.appendMemoryRevision({} as never, firstArgs()),
      /operation_transaction_required/u);
    await appendOwned(store, operations, firstArgs(), "operation-first");
    const append = (suffix: string) => appendOwned(store, operations, {
      expected_head_revision: 1,
      items: [{ memory_id: "memory-a", memory_kind: "state", lifecycle: "active", authority: "verified",
        hydrated: true, projection: { suffix }, rehydration_ref: null, expires_at: null }],
      relations: [], capsules: [],
    }, `operation-${suffix}`);
    const settled = await Promise.allSettled([append("left"), append("right")]);
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
    const rejected = settled.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof ContinuationRuntimeV1MemoryHeadConflictError);
    assert.equal((await store.readHead("tenant", "scope"))?.head_revision, 2);
  } finally {
    await f.database.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("operation credential is authority and changes commit and head identity", async () => {
  const firstFixture = fixture();
  const secondFixture = fixture();
  try {
    const append = async (database: ContinuationRuntimeV1Database, principal: string) => appendOwned(
      createContinuationRuntimeV1MemoryStore(database, { now: () => NOW }),
      testOperationStore(database, { now: () => NOW }),
      firstArgs(),
      "same-operation",
      { actorPrincipalSha256: principal },
    );
    const first = await append(firstFixture.database, "1".repeat(64));
    const second = await append(secondFixture.database, "2".repeat(64));
    assert.notEqual(first.commit.commit_id, second.commit.commit_id);
    assert.notEqual(first.commit.commit_sha256, second.commit.commit_sha256);
    assert.notEqual(first.head.head_sha256, second.head.head_sha256);
    assert.equal(first.commit.source_operation.actor_principal_sha256, "1".repeat(64));
    assert.equal(second.commit.source_operation.actor_principal_sha256, "2".repeat(64));
  } finally {
    await firstFixture.database.close();
    await secondFixture.database.close();
    rmSync(firstFixture.root, { recursive: true, force: true });
    rmSync(secondFixture.root, { recursive: true, force: true });
  }
});

test("operation producer nests the memory append in one transaction and rollback is total", async () => {
  const f = fixture();
  try {
    const memory = createContinuationRuntimeV1MemoryStore(f.database, { now: () => NOW });
    const operations = testOperationStore(f.database, { now: () => NOW });
    await assert.rejects(operations.execute({
      tenantId: "tenant", scope: "scope", operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64), operationId: "op-twice",
      request: { writes: 2 }, produce: async (context) => {
        await memory.appendMemoryRevision(context, firstArgs());
        await memory.appendMemoryRevision(context, {
          ...firstArgs(), expected_head_revision: 1,
        });
        return { impossible: true };
      },
    }), /operation_context_already_used/u);
    assert.equal(await memory.readHead("tenant", "scope"), null);
    await assert.rejects(operations.execute({
      tenantId: "tenant", scope: "scope", operationKind: "create_continuation",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64), operationId: "op-kind",
      request: { write: true }, produce: async (context) => {
        await memory.appendMemoryRevision(context, firstArgs());
        return { impossible: true };
      },
    }), /operation_kind_forbidden/u);
    assert.equal(await memory.readHead("tenant", "scope"), null);
    await assert.rejects(operations.execute({
      tenantId: "tenant", scope: "scope", operationKind: "record_observations",
      actorKind: "worker", actorPrincipalSha256: "1".repeat(64),
      operationId: "op-wrong-actor", request: { write: true },
      produce: () => ({ impossible: true }),
    }), /operation_actor_kind_mismatch/u);
    await assert.rejects(operations.execute({
      tenantId: "tenant", scope: "scope", operationKind: "record_observations",
      actorKind: "trusted_host", actorPrincipalSha256: "1".repeat(64),
      operationId: "op-actor-injection", request: { write: true }, produce: async (context) => {
        await memory.appendMemoryRevision(context, {
          ...firstArgs(), actor_kind: "operator", actor_principal_sha256: "f".repeat(64),
        } as never);
        return { impossible: true };
      },
    }), /append_args_shape_invalid/u);
    assert.equal(await memory.readHead("tenant", "scope"), null);
    await assert.rejects(operations.execute({
      tenantId: "tenant", scope: "scope", operationKind: "record_observations",
      actorKind: "trusted_host",
      actorPrincipalSha256: "1".repeat(64), operationId: "op-fail",
      request: { write: true }, produce: async (context) => {
        await memory.appendMemoryRevision(context, firstArgs());
        throw new Error("abort_after_memory_write");
      },
    }), /abort_after_memory_write/u);
    assert.equal(await memory.readHead("tenant", "scope"), null);
    assert.equal(Number((f.database.db.prepare("SELECT COUNT(*) AS count FROM memory_commits").get() as { count: number }).count), 0);

    const completed = await appendOwned(memory, operations, firstArgs(), "op-ok");
    assert.equal(completed.commit.revision, 1);
    assert.equal((await memory.readHead("tenant", "scope"))?.head_revision, 1);
  } finally { await f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("readHead verifies only the authenticated frontier while auditScope verifies the full chain", async () => {
  const f = fixture();
  try {
    const memory = createContinuationRuntimeV1MemoryStore(f.database, { now: () => NOW });
    const operations = testOperationStore(f.database, { now: () => NOW });
    await appendOwned(memory, operations, firstArgs(), "frontier-1");
    await appendOwned(memory, operations, {
      ...firstArgs(), expected_head_revision: 1,
      items: [{ ...firstArgs().items[0]!, projection: { value: "two" } }],
      relations: [], capsules: [],
    }, "frontier-2");
    await appendOwned(memory, operations, {
      ...firstArgs(), expected_head_revision: 2,
      items: [{ ...firstArgs().items[0]!, projection: { value: "three" } }],
      relations: [], capsules: [],
    }, "frontier-3");
    assert.equal((await memory.auditScope("tenant", "scope")).verified_commit_count, 3);

    f.database.db.exec("DROP TRIGGER memory_commits_no_update");
    const operationRequests = f.database.db.prepare(`SELECT operation_id, request_sha256
      FROM operations WHERE tenant_id='tenant' AND scope='scope'
        AND operation_kind='record_observations'`).all() as Array<{
      operation_id: string; request_sha256: string;
    }>;
    const requestFor = (operationId: string) => operationRequests
      .find((row) => row.operation_id === operationId)!.request_sha256;
    f.database.db.exec("PRAGMA ignore_check_constraints=ON");
    f.database.db.prepare(`UPDATE memory_commits
      SET source_operation_id=?, source_request_sha256=?
      WHERE tenant_id=? AND scope=? AND revision=1`).run(
      "frontier-2", requestFor("frontier-2"), "tenant", "scope",
    );
    assert.equal((await memory.readHead("tenant", "scope"))?.head_revision, 3);
    await assert.rejects(memory.auditScope("tenant", "scope"), /commit_source_operation_drift/u);
    f.database.db.prepare(`UPDATE memory_commits
      SET source_operation_id=?, source_request_sha256=?
      WHERE tenant_id=? AND scope=? AND revision=1`).run(
      "frontier-1", requestFor("frontier-1"), "tenant", "scope",
    );
    f.database.db.exec("PRAGMA ignore_check_constraints=OFF");
    assert.equal((await memory.auditScope("tenant", "scope")).verified_commit_count, 3);
    f.database.db.prepare(
      "UPDATE memory_commits SET mutation_json = ? WHERE tenant_id = ? AND scope = ? AND revision = 1",
    ).run(
      '{"capsules":[],"items":[],"relations":[],"schema_version":"memory_mutation_v1"}',
      "tenant",
      "scope",
    );
    assert.equal((await memory.readHead("tenant", "scope"))?.head_revision, 3);
    await assert.rejects(memory.auditScope("tenant", "scope"), /mutation_digest/u);
  } finally { await f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("capsule reads independently authenticate the projection digest", async () => {
  const f = fixture();
  try {
    const memory = createContinuationRuntimeV1MemoryStore(f.database, { now: () => NOW });
    const operations = testOperationStore(f.database, { now: () => NOW });
    const first = await appendOwned(memory, operations, firstArgs(), "capsule-projection");
    const capsule = first.capsules[0]!;
    const { capsule_sha256: _capsuleSha256, ...capsuleBody } = capsule;
    const forgedBody = {
      ...capsuleBody,
      projection: { ...capsuleBody.projection, projection_sha256: "f".repeat(64) },
    };
    const forgedCapsule = {
      ...forgedBody,
      capsule_sha256: canonicalContinuationSha256(forgedBody),
    };
    f.database.db.exec("DROP TRIGGER capsule_revisions_no_update");
    f.database.db.prepare(`UPDATE capsule_revisions
      SET projection_sha256=?, projection_json=?, capsule_sha256=?, capsule_json=?
      WHERE tenant_id=? AND scope=? AND capsule_id=? AND capsule_revision=?`).run(
      forgedBody.projection.projection_sha256,
      canonicalContinuationJson(forgedBody.projection),
      forgedCapsule.capsule_sha256,
      canonicalContinuationJson(forgedCapsule),
      "tenant",
      "scope",
      capsule.capsule_id,
      capsule.capsule_revision,
    );
    await assert.rejects(
      memory.readCapsule("tenant", "scope", capsule.capsule_id, capsule.capsule_revision),
      /capsule_projection_digest/u,
    );
  } finally { await f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("commit and head identities reject actor-blind canonical bodies", async () => {
  const f = fixture();
  try {
    const memory = createContinuationRuntimeV1MemoryStore(f.database, { now: () => NOW });
    const operations = testOperationStore(f.database, { now: () => NOW });
    const appended = await appendOwned(memory, operations, firstArgs(), "actor-bound");
    const { actor_kind: _kind, actor_principal_sha256: _principal, ...actorBlindLineage }
      = appended.commit.source_operation;
    const actorBlindCommitId = `mc_${canonicalContinuationSha256({
      schema_version: "memory_commit_id_v1", source_operation: actorBlindLineage,
      revision: 1, parent_commit_sha256: null,
    })}`;
    const actorBlindCommitSha = canonicalContinuationSha256({
      schema_version: "memory_commit_v1", tenant_id: "tenant", scope: "scope",
      revision: 1, commit_id: appended.commit.commit_id, parent_revision: null,
      parent_commit_id: null, parent_commit_sha256: null,
      request_sha256: appended.commit.source_operation.request_sha256,
      source_operation: actorBlindLineage,
      mutation_sha256: appended.commit.mutation_sha256, created_at: appended.commit.created_at,
    });
    const actorBlindHeadSha = canonicalContinuationSha256({
      schema_version: "memory_scope_head_v1", tenant_id: "tenant", scope: "scope",
      head_revision: 1, head_commit_id: appended.commit.commit_id,
      head_commit_sha256: appended.commit.commit_sha256,
      source_operation: actorBlindLineage, updated_at: appended.commit.created_at,
    });
    f.database.db.exec(`PRAGMA foreign_keys=OFF;
      DROP TRIGGER memory_commits_no_update;
      DROP TRIGGER memory_scope_heads_advance_guard;
      DROP TRIGGER memory_scope_heads_source_operation_update_fence;`);
    const updateCommit = f.database.db.prepare(`UPDATE memory_commits SET commit_id=?, commit_sha256=?
      WHERE tenant_id='tenant' AND scope='scope' AND revision=1`);
    updateCommit.run(actorBlindCommitId, appended.commit.commit_sha256);
    await assert.rejects(memory.readHead("tenant", "scope"), /commit_id/u);
    updateCommit.run(appended.commit.commit_id, actorBlindCommitSha);
    await assert.rejects(memory.readHead("tenant", "scope"), /commit_digest/u);
    updateCommit.run(appended.commit.commit_id, appended.commit.commit_sha256);
    f.database.db.prepare(`UPDATE memory_scope_heads SET head_sha256=?
      WHERE tenant_id='tenant' AND scope='scope'`).run(actorBlindHeadSha);
    await assert.rejects(memory.readHead("tenant", "scope"), /head_digest/u);
  } finally { await f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("head and commit reads reject source lineage drift and missing operation parents", async () => {
  const f = fixture();
  try {
    const memory = createContinuationRuntimeV1MemoryStore(f.database, { now: () => NOW });
    const operations = testOperationStore(f.database, { now: () => NOW });
    const first = await appendOwned(memory, operations, firstArgs(), "source-1");
    const second = await appendOwned(memory, operations, {
      ...firstArgs(), expected_head_revision: 1,
      items: [{ ...firstArgs().items[0]!, projection: { value: "second" } }],
      relations: [], capsules: [],
    }, "source-2");
    f.database.db.exec(`DROP TRIGGER memory_scope_heads_advance_guard;
      DROP TRIGGER memory_scope_heads_source_operation_update_fence;`);
    const updateHeadSource = f.database.db.prepare(`UPDATE memory_scope_heads SET
      source_operation_kind=?, source_operation_id=?, source_request_sha256=?
      WHERE tenant_id='tenant' AND scope='scope'`);
    updateHeadSource.run(first.commit.source_operation.operation_kind,
      first.commit.source_operation.operation_id, first.commit.source_operation.request_sha256);
    await assert.rejects(memory.readHead("tenant", "scope"), /head_commit_ref/u);
    updateHeadSource.run(second.commit.source_operation.operation_kind,
      second.commit.source_operation.operation_id, second.commit.source_operation.request_sha256);
    assert.equal((await memory.readHead("tenant", "scope"))?.head_revision, 2);

    f.database.db.exec("DROP TRIGGER memory_commits_no_update");
    f.database.db.exec("PRAGMA foreign_keys=OFF");
    f.database.db.prepare(`UPDATE memory_commits SET actor_principal_sha256=?
      WHERE tenant_id='tenant' AND scope='scope' AND revision=2`).run("f".repeat(64));
    await assert.rejects(memory.readHead("tenant", "scope"), /commit_source_operation_drift/u);
    f.database.db.prepare(`UPDATE memory_commits SET actor_principal_sha256=?
      WHERE tenant_id='tenant' AND scope='scope' AND revision=2`).run(
      second.commit.source_operation.actor_principal_sha256,
    );
    f.database.db.exec("DROP TRIGGER operations_no_delete;");
    f.database.db.prepare(`DELETE FROM operations WHERE tenant_id='tenant' AND scope='scope'
      AND operation_kind=? AND operation_id=?`).run(
      second.commit.source_operation.operation_kind,
      second.commit.source_operation.operation_id,
    );
    await assert.rejects(memory.readHead("tenant", "scope"), /source_operation_missing/u);
  } finally { await f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
});
