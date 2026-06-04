import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import {
  buildAgentMemoryHandoffPackLite,
  buildAgentMemoryInspectLite,
  buildAgentMemoryReviewPackLite,
  buildAgentMemoryResumePackLite,
} from "../../src/memory/agent-memory-inspect-core.ts";
import { buildExecutionContractFromProjection } from "../../src/memory/execution-contract.ts";
import { buildHandoffWriteBody } from "../../src/memory/handoff.ts";
import { MemoryAnchorV1Schema } from "../../src/memory/schemas.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-agent-memory-"));
  return path.join(dir, `${name}.sqlite`);
}

const writeOptions = {
  maxTextLen: 10000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
};

function buildEnv() {
  return {
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
    RATE_LIMIT_BYPASS_LOOPBACK: false,
    WRITE_RATE_LIMIT_MAX_WAIT_MS: 0,
    RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS: 0,
    MAX_TEXT_LEN: 10000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
  } as any;
}

function registerApp(args: {
  app: ReturnType<typeof Fastify>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
}) {
  const env = buildEnv();
  const guards = createRequestGuards({
    env,
    embedder: DeterministicEmbeddingProvider,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });

  registerRuntimeErrorHandler(args.app);
  registerMemoryAccessRoutes({
    app: args.app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
}

async function seedEvolutionFixture(store: ReturnType<typeof createLiteWriteStore>) {
  const [sharedEmbedding] = await DeterministicEmbeddingProvider.embed(["recover durable workflow from failed validation"]);

  const trustedPattern = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    credibility_state: "trusted",
    task_signature: "tools_select:workflow-validation-recovery",
    task_family: "task:workflow_validation_recovery",
    error_family: "error:workflow-validation-mismatch",
    pattern_signature: "workflow-validation-recovery-stable-edit",
    summary: "Stable pattern: prefer edit for export repair.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "edit",
    file_path: "src/routes/export.ts",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests.",
    outcome: { status: "success", result_class: "tool_selection_pattern_stable", success_score: 0.94 },
    source: { source_kind: "tool_decision", decision_id: randomUUID() },
    payload_refs: { node_ids: [], decision_ids: [], run_ids: [randomUUID(), randomUUID(), randomUUID()], step_ids: [], commit_ids: [] },
    metrics: { usage_count: 0, reuse_success_count: 3, reuse_failure_count: 0, distinct_run_count: 3, last_used_at: null },
    promotion: {
      required_distinct_runs: 3,
      distinct_run_count: 3,
      observed_run_ids: [randomUUID(), randomUUID(), randomUUID()],
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
    trust_hardening: {
      task_family: "task:workflow_validation_recovery",
      error_family: "error:workflow-validation-mismatch",
      observed_task_families: ["task:workflow_validation_recovery"],
      observed_error_families: ["error:workflow-validation-mismatch"],
      distinct_task_family_count: 1,
      distinct_error_family_count: 1,
      post_contest_observed_run_ids: [],
      post_contest_distinct_run_count: 0,
      promotion_gate_kind: "current_distinct_runs_v1",
      promotion_gate_satisfied: true,
      revalidation_floor_kind: "post_contest_two_fresh_runs_v1",
      revalidation_floor_satisfied: true,
      task_affinity_weighting_enabled: true,
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

  const workflowAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: "L2",
    task_signature: "execution_task:workflow-validation-recovery",
    task_class: "execution_write_projection",
    workflow_signature: "execution_workflow:workflow-validation-recovery",
    summary: "Stable workflow for repairing validation failures.",
    tool_set: ["edit", "test"],
    file_path: "src/routes/export.ts",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests.",
    outcome: { status: "success", result_class: "execution_write_stable", success_score: 0.88 },
    source: { source_kind: "execution_write", node_id: randomUUID(), run_id: null, playbook_id: null, commit_id: null },
    payload_refs: { node_ids: [], decision_ids: [], run_ids: [], step_ids: [], commit_ids: [] },
    rehydration: {
      default_mode: "partial",
      payload_cost_hint: "low",
      recommended_when: ["workflow_summary_is_not_enough"],
    },
    metrics: { usage_count: 0, reuse_success_count: 0, reuse_failure_count: 0, distinct_run_count: 0, last_used_at: null },
    maintenance: {
      model: "lazy_online_v1",
      maintenance_state: "retain",
      offline_priority: "retain_workflow",
      lazy_update_fields: ["usage_count", "last_used_at"],
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
    workflow_promotion: {
      promotion_state: "stable",
      promotion_origin: "execution_write_auto_promotion",
      required_observations: 2,
      observed_count: 2,
      last_transition: "promoted_to_stable",
      last_transition_at: "2026-03-20T00:00:00Z",
      source_status: null,
    },
    schema_version: "anchor_v1",
  });

  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    input_text: [
      "Task Signature: workflow-validation-recovery-node-tests",
      "Error Signature: workflow-validation-mismatch",
      "Workflow Signature: inspect-patch-rerun",
      "Export repair requires inspect, patch, and rerun.",
    ].join("\n"),
    auto_embed: false,
    distill: {
      enabled: true,
      sources: ["input_text"],
      max_evidence_nodes: 2,
      max_fact_nodes: 4,
      min_sentence_chars: 12,
      attach_edges: true,
    },
    memory_lane: "shared",
    nodes: [
      {
        id: randomUUID(),
        type: "concept",
        title: "Stable edit pattern",
        text_summary: trustedPattern.summary,
        slots: {
          summary_kind: "pattern_anchor",
          compression_layer: "L3",
          anchor_v1: trustedPattern,
          execution_native_v1: {
            schema_version: "execution_native_v1",
            execution_kind: "pattern_anchor",
            summary_kind: "pattern_anchor",
            compression_layer: "L3",
            task_signature: trustedPattern.task_signature,
            task_family: trustedPattern.task_family,
            error_family: trustedPattern.error_family,
            pattern_signature: trustedPattern.pattern_signature,
            anchor_kind: "pattern",
            anchor_level: "L3",
            tool_set: trustedPattern.tool_set,
            selected_tool: trustedPattern.selected_tool,
            pattern_state: "stable",
            credibility_state: "trusted",
            file_path: trustedPattern.file_path,
            target_files: trustedPattern.target_files,
            next_action: trustedPattern.next_action,
            promotion: trustedPattern.promotion,
            trust_hardening: trustedPattern.trust_hardening,
            maintenance: trustedPattern.maintenance,
          },
        },
        embedding: sharedEmbedding,
        embedding_model: DeterministicEmbeddingProvider.name,
        salience: 0.8,
        importance: 0.9,
        confidence: 0.9,
      },
      {
        id: randomUUID(),
        type: "procedure",
        title: "Recover workflow validation failure",
        text_summary: workflowAnchor.summary,
        slots: {
          summary_kind: "workflow_anchor",
          compression_layer: "L2",
          anchor_v1: workflowAnchor,
          execution_native_v1: {
            schema_version: "execution_native_v1",
            execution_kind: "workflow_anchor",
            summary_kind: "workflow_anchor",
            compression_layer: "L2",
            task_signature: workflowAnchor.task_signature,
            task_class: workflowAnchor.task_class,
            workflow_signature: workflowAnchor.workflow_signature,
            anchor_kind: "workflow",
            anchor_level: "L2",
            tool_set: workflowAnchor.tool_set,
            file_path: workflowAnchor.file_path,
            target_files: workflowAnchor.target_files,
            next_action: workflowAnchor.next_action,
            workflow_promotion: workflowAnchor.workflow_promotion,
            maintenance: workflowAnchor.maintenance,
          },
        },
        embedding: sharedEmbedding,
        embedding_model: DeterministicEmbeddingProvider.name,
        salience: 0.78,
        importance: 0.88,
        confidence: 0.86,
      },
    ],
    edges: [],
  }, "default", "default", {
    maxTextLen: 10000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
  }, null);

  await store.withTx(() => applyMemoryWrite(prepared, {
    ...writeOptions,
    write_access: store,
  }));
}

async function seedHandoffFixture(store: ReturnType<typeof createLiteWriteStore>) {
  const handoffWrite = buildHandoffWriteBody({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    memory_lane: "shared",
    anchor: "resume:src/routes/export.ts",
    file_path: "src/routes/export.ts",
    repo_root: "/repo",
    handoff_kind: "patch_handoff",
    title: "Fix export route",
    summary: "Repair validation failure and keep tests green",
    handoff_text: "Fix export route and rerun targeted tests",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests",
    must_change: ["src/routes/export.ts"],
    must_remove: ["stale export recovery"],
    must_keep: ["existing success path"],
    acceptance_checks: ["npm run -s test:lite -- export"],
    execution_result_summary: {
      status: "passed",
      summary: "Export patch applied and targeted tests passed",
    },
    execution_artifacts: [{ ref: "artifact://export/patch" }],
    execution_evidence: [{ ref: "evidence://export/test" }],
  });

  const prepared = await prepareMemoryWrite(
    handoffWrite,
    "default",
    "default",
    {
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );

  await store.withTx(() => applyMemoryWrite(prepared, {
    ...writeOptions,
    write_access: store,
  }));
}

async function seedConflictingCanonicalHandoffFixture(store: ReturnType<typeof createLiteWriteStore>) {
  const handoffWrite = buildHandoffWriteBody({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    memory_lane: "shared",
    anchor: "resume:src/routes/stale-export.ts",
    file_path: "src/routes/stale-export.ts",
    repo_root: "/repo",
    handoff_kind: "patch_handoff",
    title: "Fix stale export route",
    summary: "Stale handoff fields conflict with the canonical execution contract",
    handoff_text: "Stale handoff text should not steer resume or handoff packs",
    target_files: ["src/routes/stale-export.ts"],
    next_action: "Stale handoff next action should not steer packs",
    must_change: ["src/routes/stale-export.ts"],
    acceptance_checks: ["npm run -s test:stale-export"],
  });
  const slots = handoffWrite.nodes?.[0]?.slots as Record<string, unknown>;
  slots.execution_contract_v1 = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    task_family: "task:canonical_handoff_resume",
    task_signature: "canonical-handoff-resume",
    workflow_signature: "execution_workflow:canonical-handoff-resume",
    selected_tool: "edit",
    file_path: "src/routes/canonical-export.ts",
    target_files: ["src/routes/canonical-export.ts"],
    next_action: "Canonical execution contract next action should steer packs",
    workflow_steps: ["inspect canonical handoff", "patch canonical export"],
    acceptance_checks: ["npm run -s test:canonical-export"],
    provenance: {
      source_kind: "manual_context",
      source_summary_version: "execution_contract_v1",
      source_anchor: "canonical-handoff-test",
      evidence_refs: [],
      notes: ["pack surfaces must prefer execution_contract_v1 over handoff fields"],
    },
  });

  const prepared = await prepareMemoryWrite(
    handoffWrite,
    "default",
    "default",
    {
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );

  await store.withTx(() => applyMemoryWrite(prepared, {
    ...writeOptions,
    write_access: store,
  }));
}

test("agent memory inspect facade composes continuity and evolution into review/resume/handoff packs", async () => {
  const dbPath = tmpDbPath("agent-memory-inspect");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);

  await seedEvolutionFixture(liteWriteStore);
  await seedHandoffFixture(liteWriteStore);

  const args = {
    liteWriteStore,
    liteRecallAccess: liteRecallStore.createRecallAccess(),
    embedder: DeterministicEmbeddingProvider,
    defaultScope: "default",
    defaultTenantId: "default",
    defaultActorId: "local-user",
    body: {
      tenant_id: "default",
      scope: "default",
      query_text: "recover workflow validation failure in src/routes/export.ts",
      context: {
        repo_root: "/repo",
        file_path: "src/routes/export.ts",
      },
      candidates: ["edit", "bash", "test"],
      anchor: "resume:src/routes/export.ts",
      file_path: "src/routes/export.ts",
      repo_root: "/repo",
      handoff_kind: "patch_handoff",
    },
  } as const;

  const ctx = {};
  const inspect = await buildAgentMemoryInspectLite(args, ctx);
  const reviewPack = await buildAgentMemoryReviewPackLite(args, ctx);
  const resumePack = await buildAgentMemoryResumePackLite(args, ctx);
  const handoffPack = await buildAgentMemoryHandoffPackLite(args, ctx);

  assert.equal(inspect.summary_version, "agent_memory_inspect_v1");
  assert.equal(inspect.agent_memory_summary.has_continuity, true);
  assert.equal(inspect.agent_memory_summary.latest_handoff_anchor, "resume:src/routes/export.ts");
  assert.ok(inspect.continuity_review_pack);
  assert.ok(inspect.evolution_review_pack.review_contract.trusted_pattern_anchor_ids.length >= 1);
  assert.ok(inspect.evolution_review_pack.review_contract.stable_workflow_anchor_id);
  assert.equal(inspect.agent_memory_summary.selected_tool, "edit");
  assert.equal(inspect.agent_memory_summary.distilled_evidence_count, 1);
  assert.equal(inspect.agent_memory_summary.distilled_fact_count, 3);
  assert.equal(inspect.agent_memory_summary.active_policy_count, 0);
  assert.equal(inspect.agent_memory_summary.contested_policy_count, 0);
  assert.equal(inspect.agent_memory_summary.retired_policy_count, 0);
  assert.equal(
    inspect.evolution_inspect.execution_introspection.recommended_workflows[0]?.execution_contract_v1?.schema_version,
    "execution_contract_v1",
  );
  assert.equal(
    inspect.evolution_inspect.execution_introspection.recommended_workflows[0]?.execution_contract_v1?.workflow_signature,
    "execution_workflow:workflow-validation-recovery",
  );

  assert.equal(reviewPack.agent_memory_review_pack.rollback_required, true);
  assert.deepEqual(reviewPack.agent_memory_review_pack.must_remove, ["stale export recovery"]);
  assert.equal(reviewPack.agent_memory_review_pack.selected_tool, "edit");
  assert.equal(
    reviewPack.agent_memory_review_pack.execution_contract_v1?.schema_version,
    "execution_contract_v1",
  );
  assert.equal(
    reviewPack.agent_memory_review_pack.execution_contract_v1?.selected_tool,
    "edit",
  );
  assert.equal(
    reviewPack.agent_memory_review_pack.execution_contract_v1?.file_path,
    "src/routes/export.ts",
  );
  assert.equal(
    reviewPack.agent_memory_review_pack.execution_contract_v1?.workflow_signature,
    "execution_workflow:workflow-validation-recovery",
  );

  assert.equal(resumePack.agent_memory_resume_pack.resume_file_path, "src/routes/export.ts");
  assert.equal(
    resumePack.agent_memory_resume_pack.resume_next_action,
    "Patch src/routes/export.ts and rerun export tests",
  );
  assert.ok(resumePack.agent_memory_resume_pack.execution_ready_handoff);
  assert.equal(
    resumePack.agent_memory_resume_pack.execution_contract_v1?.schema_version,
    "execution_contract_v1",
  );
  assert.equal(
    resumePack.agent_memory_resume_pack.execution_contract_v1?.selected_tool,
    "edit",
  );
  assert.equal(
    resumePack.agent_memory_resume_pack.execution_contract_v1?.file_path,
    "src/routes/export.ts",
  );

  assert.equal(handoffPack.agent_memory_handoff_pack.handoff_kind, "patch_handoff");
  assert.equal(handoffPack.agent_memory_handoff_pack.handoff_file_path, "src/routes/export.ts");
  assert.deepEqual(handoffPack.agent_memory_handoff_pack.acceptance_checks, ["npm run -s test:lite -- export"]);
  assert.equal(
    handoffPack.agent_memory_handoff_pack.execution_contract_v1?.schema_version,
    "execution_contract_v1",
  );
  assert.equal(
    handoffPack.agent_memory_handoff_pack.execution_contract_v1?.selected_tool,
    "edit",
  );
  assert.equal(
    handoffPack.agent_memory_handoff_pack.execution_contract_v1?.file_path,
    "src/routes/export.ts",
  );
});

test("agent memory resume pack can recover latest handoff from repo_root without a constructed cwd anchor", async () => {
  const dbPath = tmpDbPath("agent-memory-repo-root-handoff");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);

  await seedEvolutionFixture(liteWriteStore);
  await seedHandoffFixture(liteWriteStore);

  const resumePack = await buildAgentMemoryResumePackLite({
    liteWriteStore,
    liteRecallAccess: liteRecallStore.createRecallAccess(),
    embedder: DeterministicEmbeddingProvider,
    defaultScope: "default",
    defaultTenantId: "default",
    defaultActorId: "local-user",
    body: {
      tenant_id: "default",
      scope: "default",
      query_text: "resume latest repo handoff",
      context: {
        repo_root: "/repo",
      },
      candidates: ["edit", "bash", "test"],
      repo_root: "/repo",
      handoff_kind: "patch_handoff",
    },
  });

  assert.equal(resumePack.agent_memory_resume_pack.latest_handoff_anchor, "resume:src/routes/export.ts");
  assert.equal(resumePack.agent_memory_resume_pack.resume_file_path, "src/routes/export.ts");
  assert.equal(
    resumePack.agent_memory_resume_pack.resume_next_action,
    "Patch src/routes/export.ts and rerun export tests",
  );
  assert.ok(resumePack.agent_memory_resume_pack.recovered_handoff);
});

test("agent memory resume pack treats missing implicit repo handoff as optional continuity", async () => {
  const dbPath = tmpDbPath("agent-memory-missing-repo-handoff");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);

  await seedEvolutionFixture(liteWriteStore);

  const resumePack = await buildAgentMemoryResumePackLite({
    liteWriteStore,
    liteRecallAccess: liteRecallStore.createRecallAccess(),
    embedder: DeterministicEmbeddingProvider,
    defaultScope: "default",
    defaultTenantId: "default",
    defaultActorId: "local-user",
    body: {
      tenant_id: "default",
      scope: "default",
      query_text: "recover workflow validation failure in src/routes/export.ts",
      context: {
        repo_root: "/repo-without-handoff",
      },
      candidates: ["edit", "bash", "test"],
      repo_root: "/repo-without-handoff",
      handoff_kind: "patch_handoff",
    },
  });

  assert.equal(resumePack.summary_version, "agent_memory_resume_pack_v1");
  assert.equal(resumePack.agent_memory_resume_pack.latest_handoff_anchor, null);
  assert.equal(resumePack.agent_memory_resume_pack.recovered_handoff, null);
  assert.equal(resumePack.agent_memory_resume_pack.resume_selected_tool, "edit");
});

test("agent memory resume and handoff packs prefer canonical contract over stale handoff fields", async () => {
  const dbPath = tmpDbPath("agent-memory-canonical-handoff");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);

  await seedEvolutionFixture(liteWriteStore);
  await seedConflictingCanonicalHandoffFixture(liteWriteStore);

  const args = {
    liteWriteStore,
    liteRecallAccess: liteRecallStore.createRecallAccess(),
    embedder: DeterministicEmbeddingProvider,
    defaultScope: "default",
    defaultTenantId: "default",
    defaultActorId: "local-user",
    body: {
      tenant_id: "default",
      scope: "default",
      query_text: "resume canonical export handoff",
      context: {
        repo_root: "/repo",
        file_path: "src/routes/stale-export.ts",
      },
      candidates: ["edit", "bash", "test"],
      anchor: "resume:src/routes/stale-export.ts",
      file_path: "src/routes/stale-export.ts",
      repo_root: "/repo",
      handoff_kind: "patch_handoff",
    },
  } as const;

  const ctx = {};
  const resumePack = await buildAgentMemoryResumePackLite(args, ctx);
  const handoffPack = await buildAgentMemoryHandoffPackLite(args, ctx);

  assert.equal(
    resumePack.agent_memory_resume_pack.execution_contract_v1?.file_path,
    "src/routes/canonical-export.ts",
  );
  assert.deepEqual(
    resumePack.agent_memory_resume_pack.execution_contract_v1?.target_files,
    ["src/routes/canonical-export.ts"],
  );
  assert.equal(resumePack.agent_memory_resume_pack.resume_file_path, "src/routes/canonical-export.ts");
  assert.deepEqual(resumePack.agent_memory_resume_pack.resume_target_files, ["src/routes/canonical-export.ts"]);
  assert.equal(
    resumePack.agent_memory_resume_pack.resume_next_action,
    "Canonical execution contract next action should steer packs",
  );
  assert.equal(
    handoffPack.agent_memory_handoff_pack.execution_contract_v1?.file_path,
    "src/routes/canonical-export.ts",
  );
  assert.deepEqual(
    handoffPack.agent_memory_handoff_pack.execution_contract_v1?.target_files,
    ["src/routes/canonical-export.ts"],
  );
  assert.equal(handoffPack.agent_memory_handoff_pack.handoff_file_path, "src/routes/canonical-export.ts");
  assert.deepEqual(handoffPack.agent_memory_handoff_pack.handoff_target_files, ["src/routes/canonical-export.ts"]);
  assert.equal(
    handoffPack.agent_memory_handoff_pack.handoff_next_action,
    "Canonical execution contract next action should steer packs",
  );
});

test("agent memory routes expose inspect, review, resume, and handoff packs", async () => {
  const dbPath = tmpDbPath("agent-memory-routes");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);

  try {
    await seedEvolutionFixture(liteWriteStore);
    await seedHandoffFixture(liteWriteStore);
    registerApp({ app, liteWriteStore, liteRecallStore });

    const payload = {
      tenant_id: "default",
      scope: "default",
      query_text: "recover workflow validation failure in src/routes/export.ts",
      context: {
        repo_root: "/repo",
        file_path: "src/routes/export.ts",
      },
      candidates: ["edit", "bash", "test"],
      anchor: "resume:src/routes/export.ts",
      file_path: "src/routes/export.ts",
      repo_root: "/repo",
      handoff_kind: "patch_handoff",
    };

    const inspectResp = await app.inject({
      method: "POST",
      url: "/v1/memory/agent/inspect",
      payload,
    });
    assert.equal(inspectResp.statusCode, 200, inspectResp.body);
    const inspect = inspectResp.json();
    assert.equal(inspect.summary_version, "agent_memory_inspect_v1");
    assert.equal(inspect.agent_memory_summary.has_continuity, true);
    assert.equal(
      inspect.evolution_inspect.execution_introspection.recommended_workflows[0]?.execution_contract_v1?.schema_version,
      "execution_contract_v1",
    );

    const reviewResp = await app.inject({
      method: "POST",
      url: "/v1/memory/agent/review-pack",
      payload,
    });
    assert.equal(reviewResp.statusCode, 200, reviewResp.body);
    const review = reviewResp.json();
    assert.equal(review.summary_version, "agent_memory_review_pack_v1");
    assert.equal(review.agent_memory_review_pack.selected_tool, "edit");
    assert.equal(
      review.agent_memory_review_pack.execution_contract_v1?.schema_version,
      "execution_contract_v1",
    );

    const resumeResp = await app.inject({
      method: "POST",
      url: "/v1/memory/agent/resume-pack",
      payload,
    });
    assert.equal(resumeResp.statusCode, 200, resumeResp.body);
    const resume = resumeResp.json();
    assert.equal(resume.summary_version, "agent_memory_resume_pack_v1");
    assert.equal(resume.agent_memory_resume_pack.resume_file_path, "src/routes/export.ts");
    assert.equal(
      resume.agent_memory_resume_pack.execution_contract_v1?.schema_version,
      "execution_contract_v1",
    );

    const handoffResp = await app.inject({
      method: "POST",
      url: "/v1/memory/agent/handoff-pack",
      payload,
    });
    assert.equal(handoffResp.statusCode, 200, handoffResp.body);
    const handoff = handoffResp.json();
    assert.equal(handoff.summary_version, "agent_memory_handoff_pack_v1");
    assert.equal(handoff.agent_memory_handoff_pack.handoff_kind, "patch_handoff");
    assert.equal(
      handoff.agent_memory_handoff_pack.execution_contract_v1?.schema_version,
      "execution_contract_v1",
    );
  } finally {
    await app.close();
  }
});
