import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExecutionCapsuleDraftV1 } from "../../src/continuation/capsule.ts";
import type { AuthorityBranchManifestV1 } from
  "../../src/continuation/authority-branch.ts";
import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
} from "../../src/continuation/contract.ts";
import {
  continuationServingMemoryProjectionFromHistoricalV1,
  createContinuationRuntimeV1MemoryHistoryStore,
} from "../../src/store/continuation-runtime-v1-memory-history.ts";
import {
  type AppendMemoryRevisionV1Args,
  type AppendMemoryRevisionV1Result,
} from "../../src/store/continuation-runtime-v1-memory-contract.ts";
import { createContinuationRuntimeV1MemoryStore } from
  "../../src/store/continuation-runtime-v1-memory-store.ts";
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
import { materializeContinuationCandidatesV1 } from
  "../../src/runtime-v1/continuation-candidate-materializer.ts";

const NOW = "2026-07-22T10:00:00.000Z";
const PRINCIPAL = "1".repeat(64);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-memory-history-"));
  const database = openContinuationRuntimeV1Database(join(root, "authority", "runtime.sqlite"), {
    databaseInstanceId: "b".repeat(64),
    now: () => "2026-07-22T09:00:00.000Z",
  });
  return { root, database };
}

function draft(args: Readonly<{
  capsuleId: string;
  kind: ExecutionCapsuleDraftV1["kind"];
  taskFamily?: string;
}>): Omit<ExecutionCapsuleDraftV1, "created_at"> {
  return {
    capsule_id: args.capsuleId,
    kind: args.kind,
    proposed_influence: args.kind === "constraint" || args.kind === "counter_evidence"
      ? "block" : "use",
    applicability: {
      task_family: args.taskFamily ?? "coding",
      task_signature: "task-profile",
      workflow_signature: null,
      workspace_signature: "workspace",
      producer_agent_id: "agent",
      owner_agent_id: null,
      owner_team_id: "team",
    },
    projection: {
      summary: `Capsule ${args.capsuleId}`,
      next_action: "Inspect exact state",
      target_refs: [{ kind: "memory", ref: args.capsuleId }],
      workflow_steps: ["inspect"],
      acceptance_statements: ["state verified"],
    },
    coverage_claims: [{
      obligation_kind: "required_state",
      target_refs: [{ kind: "memory", ref: args.capsuleId }],
      evidence_requirement: "runtime_state",
      required_probe_ids: [],
    }],
    precondition_specs: [],
    evidence_refs: [],
    verifier_refs: [],
    conflicts_with: [],
    supersedes: [],
    expires_at: "2026-07-23T10:00:00.000Z",
  };
}

function initialMutation(): AppendMemoryRevisionV1Args {
  return {
    expected_head_revision: null,
    items: [
      {
        memory_id: "memory-a", memory_kind: "current_state", lifecycle: "active",
        authority: "verified", hydrated: true, projection: { value: "a-one" },
        rehydration_ref: null, expires_at: "2026-07-23T10:00:00.000Z",
      },
      {
        memory_id: "memory-b", memory_kind: "verified_fact", lifecycle: "active",
        authority: "verified", hydrated: true, projection: { value: "b-one" },
        rehydration_ref: null, expires_at: null,
      },
      {
        memory_id: "memory-c", memory_kind: "procedure", lifecycle: "active",
        authority: "candidate", hydrated: true, projection: { value: "candidate" },
        rehydration_ref: null, expires_at: null,
      },
      {
        memory_id: "memory-d", memory_kind: "current_state", lifecycle: "active",
        authority: "verified", hydrated: true, projection: { value: "other-family" },
        rehydration_ref: null, expires_at: null,
      },
    ],
    relations: [{
      relation_id: "relation-a-b", relation_kind: "depends_on", lifecycle: "active",
      source_memory_id: "memory-a", target_memory_id: "memory-b",
      projection: { confidence: 100 },
    }],
    capsules: [
      { memory_id: "memory-a", draft: draft({ capsuleId: "capsule-a", kind: "current_state" }) },
      { memory_id: "memory-b", draft: draft({ capsuleId: "capsule-b", kind: "verified_fact" }) },
      { memory_id: "memory-c", draft: draft({ capsuleId: "capsule-c", kind: "procedure" }) },
      { memory_id: "memory-d", draft: draft({
        capsuleId: "capsule-d", kind: "current_state", taskFamily: "finance",
      }) },
    ],
  };
}

async function append(
  database: ContinuationRuntimeV1Database,
  memory: ReturnType<typeof createContinuationRuntimeV1MemoryStore>,
  args: AppendMemoryRevisionV1Args,
  operationId: string,
  operationKind: "record_observations" | "authority_decision" = "record_observations",
): Promise<AppendMemoryRevisionV1Result> {
  const operations = createContinuationRuntimeV1OperationStore(database, { now: () => NOW });
  let result: AppendMemoryRevisionV1Result | null = null;
  const execution = await operations.execute({
    tenantId: "tenant",
    scope: "scope",
    operationKind,
    actorKind: operationKind === "authority_decision" ? "operator" : "trusted_host",
    actorPrincipalSha256: PRINCIPAL,
    operationId,
    request: { append: operationId },
    produce: async (context) => {
      if (operationKind === "record_observations") {
        await createContinuationRuntimeV1ObservationStore(database, { now: () => NOW }).put(context, {
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
            issued_at: "2026-07-22T09:00:00.000Z",
            expires_at: "2026-07-22T12:00:00.000Z",
          },
          collector_observations: [],
          signed_observations: [],
        });
      }
      result = await memory.appendMemoryRevision(context, args);
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
      return deriveContinuationRuntimeV1OperationResultV1(
        database,
        binding,
        "before_receipt_insert",
      );
    },
  });
  assert.equal(execution.status, "created");
  assert.ok(result);
  return result;
}

async function seeded(database: ContinuationRuntimeV1Database) {
  const memory = createContinuationRuntimeV1MemoryStore(database, { now: () => NOW });
  const first = await append(database, memory, initialMutation(), "history-one");
  const second = await append(database, memory, {
    expected_head_revision: 1,
    items: [
      {
        memory_id: "memory-a", memory_kind: "current_state", lifecycle: "active",
        authority: "verified", hydrated: true, projection: { value: "a-two" },
        rehydration_ref: null, expires_at: "2026-07-23T10:00:00.000Z",
      },
      {
        memory_id: "memory-b", memory_kind: "verified_fact", lifecycle: "suppressed",
        authority: "verified", hydrated: true, projection: { value: "b-one" },
        rehydration_ref: null, expires_at: null,
      },
    ],
    relations: [{
      relation_id: "relation-a-b", relation_kind: "depends_on", lifecycle: "active",
      source_memory_id: "memory-a", target_memory_id: "memory-b",
      projection: { confidence: 80 },
    }],
    capsules: [{
      memory_id: "memory-a",
      draft: draft({ capsuleId: "capsule-a", kind: "current_state" }),
    }],
  }, "history-two", "authority_decision");
  return { memory, first, second };
}

function request(
  revision: AppendMemoryRevisionV1Result,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    tenant_id: "tenant",
    scope: "scope",
    task_family: "coding",
    memory_scope_head_revision: revision.head.head_revision,
    memory_scope_head_sha256: revision.head.head_sha256,
    ...overrides,
  };
}

function servingManifest(
  learningCapsule: AppendMemoryRevisionV1Result["capsules"][number],
): AuthorityBranchManifestV1 {
  return {
    schema_version: "authority_branch_manifest_v1",
    tenant_id: "tenant",
    authority_subject_sha256: "a".repeat(64),
    branch_id: "branch-current-serving",
    branch_revision: 1,
    branch_kind: "authoritative",
    state: "authoritative",
    base_authoritative_ref: null,
    previous_revision_ref: null,
    capsule_bindings: [{
      capsule_scope: "scope",
      capsule: {
        capsule_id: learningCapsule.capsule_id,
        capsule_revision: learningCapsule.capsule_revision,
        capsule_sha256: learningCapsule.capsule_sha256,
      },
      disposition: "include",
      admission_authority: "authoritative",
    }],
    compiler_policy_ref: {
      artifact_sha256: "b".repeat(64),
      payload_sha256: "c".repeat(64),
    },
    evidence_policy_ref: {
      artifact_sha256: "d".repeat(64),
      payload_sha256: "e".repeat(64),
    },
    effect_certificate_sha256: null,
    reverts_authority_ref: null,
    policy_rotation_artifact_ref: null,
    trusted_observation_admission_ref: null,
    created_at: NOW,
    manifest_sha256: "f".repeat(64),
  };
}

test("historical memory projection replays the requested head and exposes a strict continuity track", async () => {
  const f = fixture();
  try {
    const { first, second } = await seeded(f.database);
    const history = createContinuationRuntimeV1MemoryHistoryStore(f.database);
    const atFirst = await history.readHistoricalProjection(request(first));
    const atSecond = await history.readHistoricalProjection(request(second));

    assert.equal(atFirst.verified_commit_count, 1);
    assert.equal(atSecond.verified_commit_count, 2);
    assert.deepEqual(
      atFirst.audit_items.map((item) => [item.memory_id, item.projection, item.lifecycle, item.authority]),
      [
        ["memory-a", { value: "a-one" }, "active", "verified"],
        ["memory-b", { value: "b-one" }, "active", "verified"],
        ["memory-c", { value: "candidate" }, "active", "candidate"],
      ],
    );
    assert.deepEqual(
      atFirst.continuity_records.map((record) => record.capsule.capsule.capsule_id),
      ["capsule-a", "capsule-b"],
    );
    assert.deepEqual(
      atSecond.continuity_records.map((record) => [
        record.capsule.capsule.capsule_id,
        record.capsule.capsule.capsule_revision,
        record.item.projection,
      ]),
      [["capsule-a", 2, { value: "a-two" }]],
    );
    assert.deepEqual(atSecond.audit_relations[0]?.projection, { confidence: 80 });
    assert.equal(atSecond.audit_capsules.some(
      (entry) => entry.capsule.capsule_id === "capsule-c",
    ), true, "candidate procedure remains audit-visible");
    assert.equal(atSecond.continuity_records.some(
      (record) => record.capsule.capsule.kind === "procedure",
    ), false, "candidate procedure never enters continuity");
    assert.equal(atSecond.audit_capsules.some(
      (entry) => entry.capsule.capsule_id === "capsule-d",
    ), false, "another task family never leaks into the projection");
    assert.equal(Object.isFrozen(atSecond), true);
    assert.equal(Object.isFrozen(atSecond.continuity_records), true);
    assert.equal(Object.isFrozen(atSecond.continuity_records[0]?.item.projection), true);
    const { projection_sha256: _, ...body } = atSecond;
    assert.equal(atSecond.projection_sha256, canonicalContinuationSha256(body));
    assert.notEqual(atFirst.projection_sha256, atSecond.projection_sha256);
  } finally {
    await f.database.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("bounded current serving projection materializes byte-identical candidates at the same head", async () => {
  const f = fixture();
  try {
    const { memory, first, second } = await seeded(f.database);
    const learningCapsule = first.capsules.find(
      (capsule) => capsule.capsule_id === "capsule-c",
    );
    assert.ok(learningCapsule);
    const manifest = servingManifest(learningCapsule);
    const learningRef = manifest.capsule_bindings[0]!.capsule;
    const current = await memory.readCurrentServingProjection({
      ...request(second),
      evaluated_at: NOW,
      learning_capsule_refs: [learningRef],
    });
    const historical = await createContinuationRuntimeV1MemoryHistoryStore(
      f.database,
    ).readHistoricalProjection(request(second));
    const fromCurrent = materializeContinuationCandidatesV1({
      scope: "scope",
      served_manifest: manifest,
      memory_projection: current,
      evaluated_at: NOW,
    });
    const fromHistory = materializeContinuationCandidatesV1({
      scope: "scope",
      served_manifest: manifest,
      memory_projection:
        continuationServingMemoryProjectionFromHistoricalV1(historical),
      evaluated_at: NOW,
    });
    assert.equal(
      canonicalContinuationJson(fromCurrent),
      canonicalContinuationJson(fromHistory),
    );
    assert.deepEqual(
      fromCurrent.map((candidate) => [
        candidate.provenance.lane,
        candidate.capsule.capsule_id,
        candidate.capsule.capsule_revision,
      ]),
      [
        ["governed_learning", "capsule-c", 1],
        ["verified_continuity", "capsule-a", 2],
      ],
    );
    const { projection_sha256: _, ...body } = current;
    assert.equal(current.projection_sha256, canonicalContinuationSha256(body));
    assert.equal(Object.isFrozen(current), true);
  } finally {
    await f.database.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("controlled forgetting omits bound learning while active source drift fails closed", async () => {
  for (const state of ["suppressed", "expired", "active_drift"] as const) {
    const f = fixture();
    try {
      const { memory, first, second } = await seeded(f.database);
      const learningCapsule = first.capsules.find(
        (capsule) => capsule.capsule_id === "capsule-c",
      );
      assert.ok(learningCapsule);
      const manifest = servingManifest(learningCapsule);
      const next = await append(f.database, memory, {
        expected_head_revision: second.head.head_revision,
        items: [{
          memory_id: "memory-c",
          memory_kind: "procedure",
          lifecycle: state === "suppressed" ? "suppressed" : "active",
          authority: "candidate",
          hydrated: true,
          projection: state === "suppressed"
            ? { value: "candidate" }
            : { value: "candidate-drift" },
          rehydration_ref: null,
          expires_at: state === "expired"
            ? "2026-07-22T09:59:59.999Z"
            : null,
        }],
        relations: [],
        capsules: [],
      }, `learning-${state}`, state === "suppressed"
        ? "authority_decision"
        : "record_observations");
      const current = await memory.readCurrentServingProjection({
        ...request(next),
        evaluated_at: NOW,
        learning_capsule_refs: [manifest.capsule_bindings[0]!.capsule],
      });
      const historical = await createContinuationRuntimeV1MemoryHistoryStore(
        f.database,
      ).readHistoricalProjection(request(next));
      const projections = [
        current,
        continuationServingMemoryProjectionFromHistoricalV1(historical),
      ] as const;
      if (state !== "active_drift") {
        for (const projection of projections) {
          const candidates = materializeContinuationCandidatesV1({
            scope: "scope",
            served_manifest: manifest,
            memory_projection: projection,
            evaluated_at: NOW,
          });
          assert.equal(candidates.some((candidate) =>
            candidate.provenance.lane === "governed_learning"), false);
        }
      } else {
        for (const projection of projections) {
          assert.throws(() => materializeContinuationCandidatesV1({
            scope: "scope",
            served_manifest: manifest,
            memory_projection: projection,
            evaluated_at: NOW,
          }), /learning_capsule_active_memory_state_invalid/u);
        }
      }
    } finally {
      await f.database.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("current serving projection fails closed on materialized-row or head tampering", async () => {
  for (const target of ["item", "head"] as const) {
    const f = fixture();
    try {
      const { memory, second } = await seeded(f.database);
      if (target === "item") {
        f.database.db.exec("DROP TRIGGER memory_items_update_guard");
        f.database.db.prepare(`UPDATE memory_items SET projection_json = ?
          WHERE tenant_id = ? AND scope = ? AND memory_id = ?`).run(
          canonicalContinuationJson({ value: "tampered" }),
          "tenant",
          "scope",
          "memory-a",
        );
      } else {
        f.database.db.exec(`
          DROP TRIGGER memory_scope_heads_advance_guard;
          DROP TRIGGER memory_scope_heads_source_operation_update_fence;
        `);
        f.database.db.prepare(`UPDATE memory_scope_heads SET head_sha256 = ?
          WHERE tenant_id = ? AND scope = ?`).run(
          "0".repeat(64),
          "tenant",
          "scope",
        );
      }
      await assert.rejects(
        memory.readCurrentServingProjection({
          ...request(second),
          evaluated_at: NOW,
          learning_capsule_refs: [],
        }),
        /continuation_runtime_v1_memory_(?:corrupt|current_serving)/u,
      );
    } finally {
      await f.database.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("historical projection is independent of later writes and all mutable materialization tables", async () => {
  const f = fixture();
  try {
    const { first } = await seeded(f.database);
    const history = createContinuationRuntimeV1MemoryHistoryStore(f.database);
    const before = await history.readHistoricalProjection(request(first));

    f.database.db.exec(`PRAGMA foreign_keys=OFF;
      DROP TRIGGER capsule_revisions_no_delete;
      DROP TRIGGER memory_items_no_delete;
      DROP TRIGGER memory_items_update_guard;`);
    f.database.db.prepare(`UPDATE memory_items SET projection_json=?
      WHERE tenant_id='tenant' AND scope='scope' AND memory_id='memory-a'`).run(
      canonicalContinuationJson({ drifted: true }),
    );
    assert.deepEqual(await history.readHistoricalProjection(request(first)), before);

    f.database.db.exec(`DELETE FROM capsule_revisions;
      DELETE FROM memory_relations;
      DELETE FROM memory_items;`);
    assert.deepEqual(await history.readHistoricalProjection(request(first)), before);
  } finally {
    await f.database.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("historical projection rejects mutation, parent, and cycle-shaped commit tampering", async (t) => {
  await t.test("mutation bytes are authenticated", async () => {
    const f = fixture();
    try {
      const { first } = await seeded(f.database);
      const history = createContinuationRuntimeV1MemoryHistoryStore(f.database);
      f.database.db.exec("DROP TRIGGER memory_commits_no_update");
      f.database.db.prepare(`UPDATE memory_commits SET mutation_json=?
        WHERE tenant_id='tenant' AND scope='scope' AND revision=1`).run(
        '{"capsules":[],"items":[],"relations":[],"schema_version":"memory_mutation_v1"}',
      );
      await assert.rejects(
        history.readHistoricalProjection(request(first)),
        /commit_mutation_digest_mismatch/u,
      );
    } finally {
      await f.database.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  await t.test("a fully rehashed child still cannot point at a nonexistent parent", async () => {
    const f = fixture();
    try {
      const { second } = await seeded(f.database);
      const history = createContinuationRuntimeV1MemoryHistoryStore(f.database);
      const row = f.database.db.prepare(`SELECT request_sha256, mutation_sha256, created_at
        FROM memory_commits WHERE tenant_id='tenant' AND scope='scope' AND revision=2`).get() as {
        request_sha256: string; mutation_sha256: string; created_at: string;
      };
      const wrongParentSha = "f".repeat(64);
      const lineage = second.commit.source_operation;
      const forgedCommitId = `mc_${canonicalContinuationSha256({
        schema_version: "memory_commit_id_v1",
        source_operation: lineage,
        revision: 2,
        parent_commit_sha256: wrongParentSha,
      })}`;
      const forgedCommitSha = canonicalContinuationSha256({
        schema_version: "memory_commit_v1",
        tenant_id: "tenant",
        scope: "scope",
        revision: 2,
        commit_id: forgedCommitId,
        parent_revision: 1,
        parent_commit_id: "missing-parent",
        parent_commit_sha256: wrongParentSha,
        request_sha256: row.request_sha256,
        source_operation: lineage,
        mutation_sha256: row.mutation_sha256,
        created_at: row.created_at,
      });
      const forgedHeadSha = canonicalContinuationSha256({
        schema_version: "memory_scope_head_v1",
        tenant_id: "tenant",
        scope: "scope",
        head_revision: 2,
        head_commit_id: forgedCommitId,
        head_commit_sha256: forgedCommitSha,
        source_operation: lineage,
        updated_at: row.created_at,
      });
      f.database.db.exec(`PRAGMA foreign_keys=OFF;
        DROP TRIGGER memory_commits_no_update;`);
      f.database.db.prepare(`UPDATE memory_commits SET commit_id=?, commit_sha256=?,
        parent_commit_id=?, parent_commit_sha256=?
        WHERE tenant_id='tenant' AND scope='scope' AND revision=2`).run(
        forgedCommitId,
        forgedCommitSha,
        "missing-parent",
        wrongParentSha,
      );
      await assert.rejects(history.readHistoricalProjection(request(second, {
        memory_scope_head_sha256: forgedHeadSha,
      })), /commit_chain_invalid/u);
    } finally {
      await f.database.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  await t.test("cycle-shaped parent revisions are rejected before traversal", async () => {
    const f = fixture();
    try {
      const { second } = await seeded(f.database);
      const history = createContinuationRuntimeV1MemoryHistoryStore(f.database);
      f.database.db.exec(`PRAGMA foreign_keys=OFF;
        PRAGMA ignore_check_constraints=ON;
        DROP TRIGGER memory_commits_no_update;`);
      f.database.db.prepare(`UPDATE memory_commits SET parent_revision=2
        WHERE tenant_id='tenant' AND scope='scope' AND revision=2`).run();
      await assert.rejects(
        history.readHistoricalProjection(request(second)),
        /commit_parent_revision_invalid/u,
      );
    } finally {
      await f.database.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

test("historical projection binds tenant, scope, task family, exact head, and bounded depth", async () => {
  const f = fixture();
  try {
    const { first } = await seeded(f.database);
    const history = createContinuationRuntimeV1MemoryHistoryStore(f.database);
    await assert.rejects(history.readHistoricalProjection(request(first, {
      tenant_id: "other-tenant",
    })), /head_not_found/u);
    await assert.rejects(history.readHistoricalProjection(request(first, {
      scope: "other-scope",
    })), /head_not_found/u);
    await assert.rejects(history.readHistoricalProjection(request(first, {
      memory_scope_head_sha256: "f".repeat(64),
    })), /head_digest_mismatch/u);
    await assert.rejects(history.readHistoricalProjection(request(first, {
      memory_scope_head_revision: 32_769,
    })), /depth_limit_exceeded/u);

    const wrongFamily = await history.readHistoricalProjection(request(first, {
      task_family: "legal",
    }));
    assert.deepEqual(wrongFamily.audit_items, []);
    assert.deepEqual(wrongFamily.audit_capsules, []);
    assert.deepEqual(wrongFamily.continuity_records, []);
    assert.notEqual(
      wrongFamily.projection_sha256,
      (await history.readHistoricalProjection(request(first))).projection_sha256,
    );
    await assert.rejects(history.readHistoricalProjection({
      ...request(first),
      injected: true,
    } as never), /request_shape_invalid/u);
    const accessor = { ...request(first) };
    Object.defineProperty(accessor, "task_family", {
      enumerable: true,
      get: () => "coding",
    });
    await assert.rejects(
      history.readHistoricalProjection(accessor),
      /request_shape_invalid/u,
    );
  } finally {
    await f.database.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
