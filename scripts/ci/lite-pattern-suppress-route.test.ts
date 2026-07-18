import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import stableStringify from "fast-json-stable-stringify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { sealAuthorityReceiptsForPreparedWrite } from "./authority-fixture-helpers.ts";
import { createRequestGuards } from "./support/create-request-guards-test-config.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import {
  MemoryAnchorV1Schema,
  PatternSuppressResponseSchema,
} from "../../src/memory/schemas.ts";
import { buildExecutionContractFromProjection } from "../../src/memory/execution-contract.ts";
import {
  suppressAnchorLite,
  suppressPatternAnchorLite,
  unsuppressAnchorLite,
} from "../../src/memory/pattern-operator-override.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { registerMemoryFeedbackToolRoutes } from "./support/register-memory-feedback-tool-test-routes.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";
import { sha256Hex } from "../../src/util/crypto.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-pattern-suppress-route-"));
  return path.join(dir, `${name}.sqlite`);
}

function buildRequestGuards() {
  return createRequestGuards({
    env: {
      AIONIS_EDITION: "lite",
      MEMORY_AUTH_MODE: "off",
      TENANT_QUOTA_ENABLED: false,
      LITE_LOCAL_ACTOR_ID: "local-user",
      MEMORY_TENANT_ID: "default",
      MEMORY_SCOPE: "default",
      APP_ENV: "test",
      ADMIN_TOKEN: "",
      TRUST_PROXY: false,
      TRUSTED_PROXY_CIDRS: [],
      RATE_LIMIT_ENABLED: false,
      WRITE_RATE_LIMIT_MAX_WAIT_MS: 0,
      RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS: 0,
    } as any,
    embedder: DeterministicEmbeddingProvider,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });
}

async function seedStablePattern(dbPath: string) {
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const [sharedEmbedding] = await DeterministicEmbeddingProvider.embed(["recover durable workflow from failed validation"]);
  const stablePattern = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    credibility_state: "trusted",
    task_signature: "tools_select:workflow-validation-recovery",
    task_class: "tools_select_pattern",
    task_family: "task:workflow_validation_recovery",
    error_family: "error:workflow-validation-mismatch",
    pattern_signature: "stable-edit-pattern",
    summary: "Stable pattern: prefer edit for workflow_validation_recovery after repeated successful runs.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "bash",
    outcome: {
      status: "success",
      result_class: "tool_selection_pattern_stable",
      success_score: 0.93,
    },
    source: {
      source_kind: "tool_decision",
      decision_id: randomUUID(),
    },
    payload_refs: {
      node_ids: [],
      decision_ids: [],
      run_ids: [randomUUID(), randomUUID()],
      step_ids: [],
      commit_ids: [],
    },
    metrics: {
      usage_count: 0,
      reuse_success_count: 2,
      reuse_failure_count: 0,
      distinct_run_count: 2,
      last_used_at: null,
    },
    promotion: {
      required_distinct_runs: 2,
      distinct_run_count: 2,
      observed_run_ids: [randomUUID(), randomUUID()],
      counter_evidence_count: 0,
      counter_evidence_open: false,
      credibility_state: "trusted",
      previous_credibility_state: "candidate",
      last_transition: "promoted_to_trusted",
      last_transition_at: new Date().toISOString(),
      stable_at: new Date().toISOString(),
      last_validated_at: new Date().toISOString(),
      last_counter_evidence_at: null,
    },
    maintenance: {
      model: "lazy_online_v1",
      maintenance_state: "retain",
      offline_priority: "retain_trusted",
      lazy_update_fields: ["usage_count", "last_used_at"],
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
    schema_version: "anchor_v1",
  });

  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "seed stable pattern for suppression route tests",
      auto_embed: false,
      memory_lane: "shared",
      nodes: [
        {
          id: randomUUID(),
          type: "concept",
          title: "Stable edit pattern",
          text_summary: stablePattern.summary,
          slots: {
            summary_kind: "pattern_anchor",
            compression_layer: "L3",
            anchor_v1: stablePattern,
            execution_contract_v1: buildExecutionContractFromProjection({
              contract_trust: "authoritative",
              task_family: "task:workflow_validation_recovery",
              task_signature: "tools_select:workflow-validation-recovery",
              workflow_signature: "workflow:stable-edit-pattern",
              selected_tool: "edit",
              target_files: ["src/export.ts"],
              next_action: "prefer edit before broad scans for export repair",
              workflow_steps: ["inspect export mismatch", "edit targeted file", "re-run focused checks"],
              pattern_hints: ["stable trusted pattern should override stale anchor slots"],
              provenance: {
                source_kind: "workflow_projection",
                source_summary_version: "test",
                source_anchor: "stable-edit-pattern",
              },
            }),
          },
          embedding: sharedEmbedding,
          embedding_model: DeterministicEmbeddingProvider.name,
          salience: 0.8,
          importance: 0.9,
          confidence: 0.9,
        },
      ],
      edges: [],
    },
    "default",
    "default",
    {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );

  sealAuthorityReceiptsForPreparedWrite(prepared);
  const out = await liteWriteStore.withTx(() =>
    applyMemoryWrite(prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
    }),
  );
  return {
    liteWriteStore,
    liteRecallStore,
    patternNodeId: out.nodes.find((node) => node.type === "concept")?.id ?? null,
  };
}

async function seedWorkflowAnchor(
  liteWriteStore: ReturnType<typeof createLiteWriteStore>,
  options: {
    memoryLane?: "private" | "shared";
    ownerAgentId?: string | null;
  } = {},
): Promise<string> {
  const nodeId = randomUUID();
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    input_text: "seed workflow anchor for operator override authority tests",
    auto_embed: false,
    memory_lane: options.memoryLane ?? "shared",
    nodes: [{
      id: nodeId,
      type: "procedure",
      title: "Verified workflow anchor",
      text_summary: "Inspect the target file, apply the focused repair, and run the verifier.",
      memory_lane: options.memoryLane ?? "shared",
      ...(options.ownerAgentId ? { owner_agent_id: options.ownerAgentId } : {}),
      slots: {
        summary_kind: "workflow_anchor",
        execution_native_v1: {
          schema_version: "execution_native_v1",
          execution_kind: "workflow_anchor",
          anchor_kind: "workflow",
          task_signature: "operator-override-authority",
          workflow_signature: `workflow:${nodeId}`,
          target_files: ["src/runtime.ts"],
          tool_set: ["read", "edit", "test"],
        },
        anchor_v1: {
          schema_version: "anchor_v1",
          anchor_kind: "workflow",
          anchor_level: "L2",
          task_signature: "operator-override-authority",
          workflow_signature: `workflow:${nodeId}`,
          summary: "Verified workflow anchor",
        },
      },
      salience: 0.7,
      importance: 0.8,
      confidence: 0.9,
    }],
    edges: [],
  }, "default", "default", {
    maxTextLen: 10_000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
  }, null);
  sealAuthorityReceiptsForPreparedWrite(prepared);
  const written = await liteWriteStore.withTx(() => applyMemoryWrite(prepared, {
    maxTextLen: 10_000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
    associativeLinkOrigin: "memory_write",
    write_access: liteWriteStore,
  }));
  assert.equal(written.nodes[0]?.id, nodeId);
  return nodeId;
}

function operatorAuthoritySnapshot(dbPath: string, anchorId: string): string {
  const db = createSqliteDatabase(dbPath);
  try {
    const rows = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params);
    return stableStringify({
      head: rows("SELECT * FROM lite_memory_scope_heads WHERE scope = ?", "default"),
      commits: rows(
        `SELECT id, scope, parent_commit_id, input_sha256, diff_json, actor,
                commit_hash, digest_version, revision, mutation_digest,
                legacy_anchor_commit_id, created_at
         FROM lite_memory_commits WHERE scope = ? ORDER BY revision, created_at, id`,
        "default",
      ),
      node: rows("SELECT * FROM lite_memory_nodes WHERE scope = ? AND id = ?", "default", anchorId),
      execution_index: rows(
        "SELECT * FROM lite_memory_execution_native_index WHERE scope = ? AND node_id = ?",
        "default",
        anchorId,
      ),
      keyword_index: rows(
        "SELECT * FROM lite_memory_keyword_index WHERE scope = ? AND node_id = ?",
        "default",
        anchorId,
      ),
      projection_jobs: rows(
        "SELECT * FROM lite_memory_projection_jobs WHERE scope = ? AND node_id = ? ORDER BY job_kind",
        "default",
        anchorId,
      ),
    });
  } finally {
    db.close();
  }
}

test("pattern suppress and unsuppress routes preserve learned credibility while toggling operator overlay", async () => {
  const app = Fastify();
  const dbPath = tmpDbPath("route");
  const { liteWriteStore, liteRecallStore, patternNodeId } = await seedStablePattern(dbPath);
  assert.ok(patternNodeId);
  try {
    const headBefore = await liteWriteStore.readScopeHead("default");
    assert.ok(headBefore);
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    registerMemoryFeedbackToolRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10000,
        PII_REDACTION: false,
      } as any,
      embedder: DeterministicEmbeddingProvider,
      liteRecallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const suppress = await app.inject({
      method: "POST",
      url: "/v1/memory/patterns/suppress",
      payload: {
        tenant_id: "default",
        scope: "default",
        anchor_id: patternNodeId,
        reason: "bad trusted pattern in current workspace",
      },
    });
    assert.equal(suppress.statusCode, 200);
    const suppressBody = PatternSuppressResponseSchema.parse(suppress.json());
    assert.equal(suppressBody.anchor_id, patternNodeId);
    assert.equal(suppressBody.credibility_state, "trusted");
    assert.equal(suppressBody.selected_tool, "edit");
    assert.equal(suppressBody.operator_override.suppressed, true);
    assert.equal(suppressBody.operator_override.mode, "shadow_learn");

    const suppressHead = await liteWriteStore.readScopeHead("default");
    assert.ok(suppressHead);
    assert.equal(suppressHead.revision, headBefore.revision + 1);
    const authorityDb = createSqliteDatabase(dbPath);
    try {
      const commit = authorityDb.prepare<{
        parent_commit_id: string | null;
        input_sha256: string;
        diff_json: string;
        actor: string;
        digest_version: number;
        revision: number;
        mutation_digest: string;
      }>(
        `SELECT parent_commit_id, input_sha256, diff_json, actor,
                digest_version, revision, mutation_digest
         FROM lite_memory_commits WHERE id = ?`,
      ).get(suppressHead.commitId);
      assert.ok(commit);
      assert.equal(commit.parent_commit_id, headBefore.commitId);
      assert.equal(commit.digest_version, 2);
      assert.equal(commit.revision, suppressHead.revision);
      assert.equal(commit.actor, "local-user");
      assert.match(commit.mutation_digest, /^[a-f0-9]{64}$/u);
      assert.equal(commit.input_sha256, sha256Hex(stableStringify({
        action: "pattern_suppress",
        scope: "default",
        anchor_id: patternNodeId,
        reason: "bad trusted pattern in current workspace",
        mode: "shadow_learn",
        until: null,
      })));
      const diff = JSON.parse(commit.diff_json) as Record<string, any>;
      assert.equal(diff.contract, "aionis_applied_authority_mutation_v2");
      assert.equal(diff.authority_kind, "operator_anchor_override");
      assert.equal(diff.applied_at, suppressBody.operator_override.updated_at);
      assert.equal(diff.mutations.length, 1);
      const mutation = diff.mutations[0];
      assert.equal(mutation.table, "lite_memory_nodes");
      assert.deepEqual(mutation.identity, { scope: "default", id: patternNodeId });
      assert.equal(mutation.operation, "update");
      assert.equal(Object.keys(mutation.before).length, 24);
      assert.equal(Object.keys(mutation.after).length, 24);
      assert.equal(mutation.after.commit_id, "$self");
      assert.equal(mutation.after.slots_json.operator_override_v1.updated_at, diff.applied_at);
      assert.deepEqual(mutation.requested.operator_override_action, {
        action: "pattern_suppress",
        target_contract: "pattern",
        actor: "local-user",
        reason: "bad trusted pattern in current workspace",
        mode: "shadow_learn",
        until: null,
        anchor_kind: "pattern",
      });
    } finally {
      authorityDb.close();
    }

    const afterSuppress = await liteWriteStore.findNodes({
      scope: "default",
      id: patternNodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(afterSuppress.rows[0]?.slots.anchor_v1.credibility_state, "trusted");
    assert.equal(afterSuppress.rows[0]?.slots.operator_override_v1.suppressed, true);

    const unsuppress = await app.inject({
      method: "POST",
      url: "/v1/memory/patterns/unsuppress",
      payload: {
        tenant_id: "default",
        scope: "default",
        anchor_id: patternNodeId,
        reason: "re-enable after operator review",
      },
    });
    assert.equal(unsuppress.statusCode, 200);
    const unsuppressBody = PatternSuppressResponseSchema.parse(unsuppress.json());
    assert.equal(unsuppressBody.operator_override.suppressed, false);
    assert.equal(unsuppressBody.operator_override.last_action, "unsuppress");

    const afterUnsuppress = await liteWriteStore.findNodes({
      scope: "default",
      id: patternNodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(afterUnsuppress.rows[0]?.slots.anchor_v1.credibility_state, "trusted");
    assert.equal(afterUnsuppress.rows[0]?.slots.operator_override_v1.suppressed, false);
    const unsuppressHead = await liteWriteStore.readScopeHead("default");
    assert.ok(unsuppressHead);
    assert.equal(unsuppressHead.revision, suppressHead.revision + 1);
    assert.equal(afterUnsuppress.rows[0]?.commit_id, unsuppressHead.commitId);
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("workflow anchor overrides use v2 authority and exact duplicate suppression is a no-op", async () => {
  const dbPath = tmpDbPath("workflow-authority");
  const liteWriteStore = createLiteWriteStore(dbPath);
  try {
    const workflowId = await seedWorkflowAnchor(liteWriteStore);
    const headBefore = await liteWriteStore.readScopeHead("default");
    assert.ok(headBefore);
    const request = {
      tenant_id: "default",
      scope: "default",
      anchor_id: workflowId,
      reason: "Pause this workflow while its verifier contract is reviewed.",
      mode: "hard_freeze",
    };
    const suppressed = await suppressAnchorLite({
      body: request,
      defaultScope: "default",
      defaultTenantId: "default",
      liteWriteStore,
    });
    assert.equal(suppressed.anchor_kind, "workflow");
    assert.equal(suppressed.node_type, "procedure");
    assert.equal(suppressed.operator_override.suppressed, true);
    assert.equal(suppressed.operator_override.updated_by, "system");
    const suppressHead = await liteWriteStore.readScopeHead("default");
    assert.ok(suppressHead);
    assert.equal(suppressHead.revision, headBefore.revision + 1);

    const beforeExactReplay = operatorAuthoritySnapshot(dbPath, workflowId);
    const replayed = await suppressAnchorLite({
      body: request,
      defaultScope: "default",
      defaultTenantId: "default",
      liteWriteStore,
    });
    assert.deepEqual(replayed, suppressed);
    assert.deepEqual(await liteWriteStore.readScopeHead("default"), suppressHead);
    assert.equal(operatorAuthoritySnapshot(dbPath, workflowId), beforeExactReplay);

    const authorityDb = createSqliteDatabase(dbPath);
    try {
      const commit = authorityDb.prepare<{ actor: string; digest_version: number; revision: number }>(
        "SELECT actor, digest_version, revision FROM lite_memory_commits WHERE id = ?",
      ).get(suppressHead.commitId);
      assert.deepEqual(commit ? { ...commit } : commit, {
        actor: "system",
        digest_version: 2,
        revision: suppressHead.revision,
      });
    } finally {
      authorityDb.close();
    }

    const unsuppressed = await unsuppressAnchorLite({
      body: {
        tenant_id: "default",
        scope: "default",
        anchor_id: workflowId,
        reason: "Verifier review passed.",
      },
      defaultScope: "default",
      defaultTenantId: "default",
      liteWriteStore,
    });
    assert.equal(unsuppressed.operator_override.suppressed, false);
    assert.equal(unsuppressed.operator_override.updated_by, "system");
    assert.equal((await liteWriteStore.readScopeHead("default"))?.revision, suppressHead.revision + 1);
  } finally {
    await liteWriteStore.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test("stale operator override head fences reject a concurrent write without partial state", async () => {
  const dbPath = tmpDbPath("stale-authority");
  const firstStore = createLiteWriteStore(dbPath);
  let secondStore: ReturnType<typeof createLiteWriteStore> | null = null;
  try {
    const workflowId = await seedWorkflowAnchor(firstStore);
    const staleHead = await firstStore.readScopeHead("default");
    assert.ok(staleHead);
    secondStore = createLiteWriteStore(dbPath);
    await suppressAnchorLite({
      body: {
        tenant_id: "default",
        scope: "default",
        actor: "operator-a",
        anchor_id: workflowId,
        reason: "Concurrent operator suppression wins the head race.",
      },
      defaultScope: "default",
      defaultTenantId: "default",
      liteWriteStore: secondStore,
    });
    const beforeStaleAttempt = operatorAuthoritySnapshot(dbPath, workflowId);
    await assert.rejects(
      () => unsuppressAnchorLite({
        body: {
          tenant_id: "default",
          scope: "default",
          actor: "operator-b",
          anchor_id: workflowId,
          reason: "This request was prepared from the old head.",
        },
        defaultScope: "default",
        defaultTenantId: "default",
        liteWriteStore: firstStore,
        expectedHeadRevision: staleHead.revision,
        expectedHeadCommitId: staleHead.commitId,
      }),
      (error: any) => {
        assert.equal(error?.statusCode, 409);
        assert.equal(error?.code, "scope_head_conflict");
        return true;
      },
    );
    assert.equal(operatorAuthoritySnapshot(dbPath, workflowId), beforeStaleAttempt);
  } finally {
    if (secondStore) await secondStore.close();
    await firstStore.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test("private workflow overrides enforce actor visibility before authority planning", async () => {
  const dbPath = tmpDbPath("private-visibility");
  const liteWriteStore = createLiteWriteStore(dbPath);
  try {
    const workflowId = await seedWorkflowAnchor(liteWriteStore, {
      memoryLane: "private",
      ownerAgentId: "workflow-owner",
    });
    const headBefore = await liteWriteStore.readScopeHead("default");
    assert.ok(headBefore);
    await assert.rejects(
      () => suppressAnchorLite({
        body: {
          tenant_id: "default",
          scope: "default",
          actor: "different-agent",
          anchor_id: workflowId,
          reason: "An unrelated agent must not see this private workflow.",
        },
        defaultScope: "default",
        defaultTenantId: "default",
        liteWriteStore,
      }),
      (error: any) => {
        assert.equal(error?.statusCode, 404);
        assert.equal(error?.code, "anchor_not_found");
        return true;
      },
    );
    assert.deepEqual(await liteWriteStore.readScopeHead("default"), headBefore);

    const ownerResult = await suppressAnchorLite({
      body: {
        tenant_id: "default",
        scope: "default",
        actor: "workflow-owner",
        anchor_id: workflowId,
        reason: "The owner temporarily freezes the private workflow.",
      },
      defaultScope: "default",
      defaultTenantId: "default",
      liteWriteStore,
    });
    assert.equal(ownerResult.operator_override.suppressed, true);
    assert.equal(ownerResult.operator_override.updated_by, "workflow-owner");
  } finally {
    await liteWriteStore.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test("operator override read-after mismatch rolls back node, indexes, jobs, commit, and head", async () => {
  const dbPath = tmpDbPath("read-after-mismatch");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const triggerName = "test_operator_override_read_after_mismatch";
  try {
    const workflowId = await seedWorkflowAnchor(liteWriteStore);
    const triggerDb = createSqliteDatabase(dbPath);
    try {
      triggerDb.exec(
        `CREATE TRIGGER ${triggerName}
         AFTER UPDATE OF slots_json ON lite_memory_nodes
         WHEN NEW.id = '${workflowId}'
          AND json_extract(NEW.slots_json, '$.operator_override_v1.reason') = 'force read-after mismatch'
         BEGIN
           UPDATE lite_memory_nodes
           SET confidence = confidence - 0.125
           WHERE scope = NEW.scope AND id = NEW.id;
         END`,
      );
    } finally {
      triggerDb.close();
    }
    const before = operatorAuthoritySnapshot(dbPath, workflowId);
    await assert.rejects(
      () => suppressAnchorLite({
        body: {
          tenant_id: "default",
          scope: "default",
          actor: "local-user",
          anchor_id: workflowId,
          reason: "force read-after mismatch",
        },
        defaultScope: "default",
        defaultTenantId: "default",
        liteWriteStore,
      }),
      /applied_authority_read_after_verification_mismatch/u,
    );
    assert.equal(operatorAuthoritySnapshot(dbPath, workflowId), before);
  } finally {
    const cleanupDb = createSqliteDatabase(dbPath);
    try {
      cleanupDb.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    } finally {
      cleanupDb.close();
    }
    await liteWriteStore.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
