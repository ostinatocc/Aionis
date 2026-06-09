import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerHandoffRoutes } from "../../src/routes/handoff.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { registerMemoryFeedbackToolRoutes } from "../../src/routes/memory-feedback-tools.ts";
import { registerLiteMemoryLifecycleRoutes } from "../../src/routes/memory-lifecycle-lite.ts";
import { registerMemoryWriteRoutes } from "../../src/routes/memory-write.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  type ExecutionTreeOperationV1,
} from "../../src/execution/index.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-feedback-closed-loop-"));
  return path.join(dir, `${name}.sqlite`);
}

function liteEnv() {
  return {
    AIONIS_EDITION: "lite",
    AIONIS_INSPECT_BEFORE_USE_MODE: "shadow",
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
    MAX_TEXT_LEN: 10_000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    AUTO_TOPIC_CLUSTER_ON_WRITE: false,
    TOPIC_CLUSTER_ASYNC_ON_WRITE: true,
    MEMORY_WRITE_REQUIRE_NODES: false,
    MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT: 4096,
    MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: true,
    MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
    MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
  } as any;
}

function requestGuards(env: ReturnType<typeof liteEnv>) {
  return createRequestGuards({
    env,
    embedder: DeterministicEmbeddingProvider,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });
}

function registerProductFacade(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  guards: ReturnType<typeof requestGuards>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
}) {
  registerProductFacadeRoutes({
    app: args.app,
    env: args.env,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
}

function registerProductMemoryApp(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  guards: ReturnType<typeof requestGuards>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
}) {
  registerRuntimeErrorHandler(args.app);
  registerMemoryWriteRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
    executionStateStore: null,
  });
  registerHandoffRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
    executionStateStore: null,
  });
  registerMemoryAccessRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    executionStateStore: null,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
  registerMemoryContextRuntimeRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    recallTextEmbedBatcher: { stats: () => null },
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    enforceRecallTextEmbedQuota: args.guards.enforceRecallTextEmbedQuota,
    buildRecallAuth: args.guards.buildRecallAuth,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
    hasExplicitRecallKnobs: () => false,
    resolveRecallProfile: () => ({ profile: "balanced", source: "test" }),
    resolveExplicitRecallMode: () => ({
      mode: null,
      profile: "balanced",
      defaults: {},
      applied: false,
      reason: "test_default",
      source: "test",
    }),
    resolveClassAwareRecallProfile: (_endpoint, _body, baseProfile) => ({
      profile: baseProfile,
      defaults: {},
      enabled: false,
      applied: false,
      reason: "test_default",
      source: "test",
      workload_class: null,
      signals: [],
    }),
    withRecallProfileDefaults: (body) => ({ ...(body as Record<string, unknown>) }),
    resolveRecallStrategy: () => ({ strategy: "local", defaults: {}, applied: false }),
    resolveAdaptiveRecallProfile: (profile) => ({ profile, defaults: {}, applied: false, reason: "test_default" }),
    resolveAdaptiveRecallHardCap: () => ({ defaults: {}, applied: false, reason: "test_default" }),
    inferRecallStrategyFromKnobs: () => "local",
    buildRecallTrajectory: () => ({ strategy: "local" }),
    embedRecallTextQuery: async (provider, queryText) => {
      const [vec] = await provider.embed([queryText]);
      return {
        vec,
        ms: 0,
        cache_hit: false,
        singleflight_join: false,
        queue_wait_ms: 0,
        batch_size: 1,
      };
    },
    mapRecallTextEmbeddingError: () => ({
      statusCode: 500,
      code: "embed_failed",
      message: "embedding failed",
    }),
    recordContextAssemblyTelemetryBestEffort: async () => {},
  });
  registerLiteMemoryLifecycleRoutes({
    app: args.app,
    env: args.env,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
  registerMemoryFeedbackToolRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
  registerProductFacade(args);
}

function setupProductApp(name: string, overrides: Partial<ReturnType<typeof liteEnv>> = {}) {
  const app = Fastify();
  const env = {
    ...liteEnv(),
    ...overrides,
  };
  const guards = requestGuards(env);
  const dbPath = tmpDbPath(name);
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  registerProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });
  return { app, liteWriteStore };
}

async function observeMemory(args: {
  app: ReturnType<typeof Fastify>;
  clientId: string;
  title: string;
  text: string;
  confidence?: number;
}): Promise<string> {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/observe",
    payload: {
      tenant_id: "default",
      scope: "default",
      auto_embed: true,
      input_text: args.text,
      memory: {
        client_id: args.clientId,
        type: "concept",
        tier: "warm",
        memory_kind: "general_memory",
        title: args.title,
        text_summary: args.text,
        confidence: args.confidence ?? 0.84,
      },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().memory_write.nodes[0].id;
}

async function guideForMarker(args: {
  app: ReturnType<typeof Fastify>;
  marker: string;
}) {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/guide",
    payload: {
      tenant_id: "default",
      scope: "default",
      query_text: `${args.marker} status update memory`,
      consumer_agent_id: "local-user",
      limit: 8,
      include_packets: true,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

function productGuideTreeOperation(
  input: Omit<ExecutionTreeOperationV1, "tree_id" | "scope" | "actor_role">,
): ExecutionTreeOperationV1 {
  return {
    tree_id: "tree-product-guide-execution-evidence",
    scope: "aionis://execution-tree/product-guide-execution-evidence",
    actor_role: "worker",
    ...input,
  } as ExecutionTreeOperationV1;
}

function buildProductGuideExecutionTree() {
  let tree = createExecutionTreeV1({
    tree_id: "tree-product-guide-execution-evidence",
    scope: "aionis://execution-tree/product-guide-execution-evidence",
    task_brief: "Use execution evidence context in the product guide.",
    at: "2026-06-09T00:00:00.000Z",
  });
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "grow",
    operation_id: "product-guide-grow-wrong",
    at: "2026-06-09T00:01:00.000Z",
    action: "Try formula A with duplicated tax.",
    observation: "Formula A fails validation because tax is double-counted.",
    title: "Wrong formula A",
    refs: ["trace://product-guide/formula-a/raw"],
  }));
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "compress",
    operation_id: "product-guide-compress-wrong",
    at: "2026-06-09T00:02:00.000Z",
    title: "Formula A rejected",
    summary: "Formula A double-counted tax and must not be reused.",
  }));
  const wrongSummaryNodeId = tree.current_summary_node_id;
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "maintain",
    operation_id: "product-guide-maintain-wrong",
    at: "2026-06-09T00:03:00.000Z",
    passed: false,
    target_summary_node_id: wrongSummaryNodeId,
    diagnostic_note: "Formula A is a failed branch.",
  }));
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "revise",
    operation_id: "product-guide-revise-wrong",
    at: "2026-06-09T00:04:00.000Z",
    target_summary_node_id: wrongSummaryNodeId,
    diagnostic_note: "Return to the root and try a corrected formula.",
  }));
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "grow",
    operation_id: "product-guide-grow-passed",
    at: "2026-06-09T00:05:00.000Z",
    action: "Use formula B after removing duplicated tax.",
    observation: "Formula B matches all validation rows.",
    title: "Verified formula B",
    refs: ["trace://product-guide/formula-b/raw"],
  }));
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "compress",
    operation_id: "product-guide-compress-passed",
    at: "2026-06-09T00:06:00.000Z",
    title: "Verified formula B",
    summary: "Formula B computes subtotal + single tax + shipping.",
  }));
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "maintain",
    operation_id: "product-guide-maintain-passed",
    at: "2026-06-09T00:07:00.000Z",
    passed: true,
    target_summary_node_id: tree.current_summary_node_id,
    diagnostic_note: null,
  }));
  return tree;
}

test("product guide projects execution evidence context into agent context by default", async () => {
  const { app } = setupProductApp("execution-evidence-guide-default");
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "continue the verified formula branch",
        context: {
          goal: "continue the verified formula branch",
        },
        consumer_agent_id: "local-user",
        execution_tree_v1: buildProductGuideExecutionTree(),
        include_packets: true,
        limit: 8,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.agent_context.history_used, true);
    assert.equal(body.agent_context.authority, "advisory");
    assert.ok(body.agent_context.use_now.some((entry: string) =>
      entry.includes("Passed solution") && entry.includes("Formula B computes subtotal")
    ));
    assert.ok(body.agent_context.do_not_use.some((entry: string) =>
      entry.includes("Failed branch to avoid") && entry.includes("Formula A double-counted tax")
    ));
    assert.match(body.agent_context.prompt_text, /Passed solution/);
    assert.match(body.agent_context.prompt_text, /Formula B computes subtotal/);
    assert.match(body.agent_context.prompt_text, /do_not_use/);
    assert.match(body.agent_context.prompt_text, /Formula A double-counted tax/);
    assert.ok(body.guide_packet.source_map.internal_surfaces_used.includes("execution_evidence_context"));
    assert.ok(body.guide_packet.guide_brief.expected_product_effects.reduces_repeated_discovery);
    assert.ok(body.guide_packet.guide_brief.expected_product_effects.controls_negative_transfer);
  } finally {
    await app.close();
  }
});

async function activateFromGuide(args: {
  app: ReturnType<typeof Fastify>;
  guide: Record<string, any>;
  memoryId: string;
  runId: string;
  outcome: "positive" | "negative";
  usedSurface?: "use_now" | "explicit_host_assertion";
  verifierStatus?: "passed" | "failed" | "not_run" | "unknown";
  toolStatus?: "succeeded" | "failed" | "not_run" | "unknown";
}) {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/forget",
    payload: {
      tenant_id: "default",
      scope: "default",
      operation: "activate",
      target: "memory",
      guide_trace_id: args.guide.guide_trace_id,
      used_memory_ids: [args.memoryId],
      run_id: args.runId,
      outcome: args.outcome,
      used_surface: args.usedSurface ?? "use_now",
      verifier_status: args.verifierStatus ?? (args.outcome === "positive" ? "passed" : "not_run"),
      tool_status: args.toolStatus ?? (args.outcome === "positive" ? "succeeded" : "unknown"),
      activate: true,
      reason: `Host attributed ${args.outcome} outcome to the memory used from this guide.`,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function measureTrace(args: {
  app: ReturnType<typeof Fastify>;
  beforeGuide: Record<string, any>;
  afterGuide: Record<string, any>;
  forgetResult: Record<string, any>;
  evidenceId: string;
}) {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/measure",
    payload: {
      tenant_id: "default",
      scope: "default",
      product_trace: {
        before_guide: args.beforeGuide,
        after_guide: args.afterGuide,
        forget_result: args.forgetResult,
        sufficient_evidence: true,
        evidence_ids: [args.evidenceId],
      },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function slotsForMemory(args: {
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  memoryId: string;
}) {
  const { rows } = await args.liteWriteStore.findNodes({
    scope: "default",
    id: args.memoryId,
    consumerAgentId: "local-user",
    consumerTeamId: null,
    limit: 1,
    offset: 0,
  });
  assert.ok(rows[0], `missing memory ${args.memoryId}`);
  return rows[0].slots;
}

test("product feedback closed loop surfaces positive attribution in effect report", async () => {
  const { app, liteWriteStore } = setupProductApp("positive-feedback");
  try {
    const marker = "AIONIS_CLOSED_LOOP_POSITIVE";
    const memoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-positive",
      title: "Closed loop positive memory",
      text: `${marker} use concise operator summaries for status updates.`,
    });
    const beforeGuide = await guideForMarker({ app, marker });
    assert.equal(beforeGuide.agent_context.use_now_memory_ids.includes(memoryId), true);

    const feedback = await activateFromGuide({
      app,
      guide: beforeGuide,
      memoryId,
      runId: "run:closed-loop-positive",
      outcome: "positive",
    });
    const slots = await slotsForMemory({ liteWriteStore, memoryId });
    assert.equal(slots.feedback_positive, 1);
    assert.equal(slots.last_feedback_outcome, "positive");

    const afterGuide = await guideForMarker({ app, marker });
    const measure = await measureTrace({
      app,
      beforeGuide,
      afterGuide,
      forgetResult: feedback,
      evidenceId: "product_trace:closed-loop-positive",
    });

    assert.deepEqual(measure.memory_decision_trace.feedback_attribution.attributed_memory_ids, [memoryId]);
    assert.deepEqual(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.positive_attributed_memory_ids,
      [memoryId],
    );
    assert.deepEqual(measure.effect_report.feedback_signal_summary.positive_attributed_memory_ids, [memoryId]);
    assert.equal(measure.effect_report.feedback_signal_summary.source, "memory_decision_audit");
    assert.equal(measure.effect_report.feedback_signal_summary.authority_mutation, false);
    assert.ok(measure.effect_report.feedback_signal_summary.read_only_signal_memory_ids.includes(memoryId));
  } finally {
    await app.close();
  }
});

test("product feedback closed loop keeps single weak negative below downgrade threshold", async () => {
  const { app, liteWriteStore } = setupProductApp("single-weak-negative");
  try {
    const marker = "AIONIS_CLOSED_LOOP_SINGLE_WEAK";
    const memoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-single-weak",
      title: "Closed loop single weak memory",
      text: `${marker} prefer compact release-note style status updates.`,
    });
    const beforeGuide = await guideForMarker({ app, marker });
    assert.equal(beforeGuide.agent_context.use_now_memory_ids.includes(memoryId), true);

    const feedback = await activateFromGuide({
      app,
      guide: beforeGuide,
      memoryId,
      runId: "run:closed-loop-single-weak",
      outcome: "negative",
      verifierStatus: "not_run",
      toolStatus: "unknown",
    });
    const slots = await slotsForMemory({ liteWriteStore, memoryId });
    assert.equal(slots.feedback_negative, 1);
    assert.equal(slots.weak_counter_signal_count, 1);
    assert.equal(slots.strong_counter_signal_count, 0);

    const afterGuide = await guideForMarker({ app, marker });
    assert.equal(afterGuide.agent_context.use_now_memory_ids.includes(memoryId), true);
    assert.equal(afterGuide.agent_context.inspect_before_use_memory_ids.includes(memoryId), false);

    const measure = await measureTrace({
      app,
      beforeGuide,
      afterGuide,
      forgetResult: feedback,
      evidenceId: "product_trace:closed-loop-single-weak",
    });
    const decision = measure.memory_decision_trace.memory_decisions.find((entry: Record<string, any>) =>
      entry.memory_id === memoryId
    );
    assert.equal(decision.agent_surface, "use_now");
    assert.equal(decision.feedback_detail.threshold_state, "weak_below_threshold");
    assert.equal(decision.feedback_detail.threshold_met, false);
    assert.deepEqual(measure.memory_decision_trace.feedback_attribution.threshold_met_memory_ids, []);
    assert.deepEqual(measure.effect_report.feedback_signal_summary.weak_counter_signal_memory_ids, [memoryId]);
    assert.equal(measure.effect_report.feedback_signal_summary.authority_mutation, false);
    assert.equal(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary.present,
      false,
    );
  } finally {
    await app.close();
  }
});

test("product feedback closed loop moves single aligned failure to inspect-before-use", async () => {
  const { app, liteWriteStore } = setupProductApp("single-strong-negative");
  try {
    const marker = "AIONIS_CLOSED_LOOP_SINGLE_STRONG";
    const memoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-single-strong",
      title: "Closed loop single strong memory",
      text: `${marker} prefer compact release-note style status updates.`,
    });
    const beforeGuide = await guideForMarker({ app, marker });
    assert.equal(beforeGuide.agent_context.use_now_memory_ids.includes(memoryId), true);

    const feedback = await activateFromGuide({
      app,
      guide: beforeGuide,
      memoryId,
      runId: "run:closed-loop-single-strong",
      outcome: "negative",
      verifierStatus: "failed",
      toolStatus: "failed",
    });
    const slots = await slotsForMemory({ liteWriteStore, memoryId });
    assert.equal(slots.feedback_negative, 1);
    assert.equal(slots.weak_counter_signal_count, 0);
    assert.equal(slots.strong_counter_signal_count, 1);
    assert.equal(slots.last_feedback_attribution_strength, "strong_counter_signal");

    const afterGuide = await guideForMarker({ app, marker });
    assert.equal(afterGuide.agent_context.use_now_memory_ids.includes(memoryId), false);
    assert.equal(afterGuide.agent_context.inspect_before_use_memory_ids.includes(memoryId), true);

    const measure = await measureTrace({
      app,
      beforeGuide,
      afterGuide,
      forgetResult: feedback,
      evidenceId: "product_trace:closed-loop-single-strong",
    });
    const decision = measure.memory_decision_trace.memory_decisions.find((entry: Record<string, any>) =>
      entry.memory_id === memoryId
    );
    assert.equal(decision.agent_surface, "inspect_before_use");
    assert.equal(decision.feedback_detail.attribution_strength, "strong_counter_signal");
    assert.equal(decision.feedback_detail.threshold_state, "strong_signal_threshold_met");
    assert.equal(decision.feedback_detail.threshold_met, true);
    assert.deepEqual(measure.memory_decision_trace.feedback_attribution.strong_counter_signal_memory_ids, [memoryId]);
    assert.deepEqual(measure.memory_decision_trace.feedback_attribution.threshold_met_memory_ids, [memoryId]);
    assert.deepEqual(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_from_threshold_met_memory_ids,
      [memoryId],
    );
    assert.deepEqual(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_inspect_before_use_memory_ids,
      [memoryId],
    );
    assert.equal(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .authority_mutation,
      false,
    );
    assert.deepEqual(measure.effect_report.feedback_signal_summary.strong_counter_signal_memory_ids, [memoryId]);
    assert.equal(measure.effect_report.feedback_signal_summary.authority_mutation, false);
  } finally {
    await app.close();
  }
});

test("product feedback closed loop rejects attribution to memory not exposed by the guide", async () => {
  const { app, liteWriteStore } = setupProductApp("reject-unexposed-attribution");
  try {
    const exposedMarker = "AIONIS_CLOSED_LOOP_EXPOSED";
    const unexposedMarker = "AIONIS_CLOSED_LOOP_UNEXPOSED";
    await observeMemory({
      app,
      clientId: "memory:closed-loop-exposed",
      title: "Closed loop exposed memory",
      text: `${exposedMarker} use concise operator summaries for status updates.`,
    });
    const guide = await guideForMarker({ app, marker: exposedMarker });
    const unexposedMemoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-unexposed",
      title: "Closed loop unexposed memory",
      text: `${unexposedMarker} use obsolete escalation owner names in status updates.`,
    });
    assert.equal(guide.agent_context.memory_ids.includes(unexposedMemoryId), false);

    const response = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        guide_trace_id: guide.guide_trace_id,
        used_memory_ids: [unexposedMemoryId],
        run_id: "run:closed-loop-unexposed-attribution",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "failed",
        tool_status: "failed",
        activate: true,
        reason: "Host attempted to attribute guide outcome to memory that was not exposed.",
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, "guide_trace_used_memory_not_exposed");

    const slots = await slotsForMemory({ liteWriteStore, memoryId: unexposedMemoryId });
    assert.equal(slots.feedback_negative, undefined);
    assert.equal(slots.strong_counter_signal_count, undefined);
  } finally {
    await app.close();
  }
});

test("product feedback closed loop moves repeated weak negative to inspect-before-use", async () => {
  const { app, liteWriteStore } = setupProductApp("repeated-weak-negative");
  try {
    const marker = "AIONIS_CLOSED_LOOP_REPEATED_WEAK";
    const memoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-repeated-weak",
      title: "Closed loop repeated weak memory",
      text: `${marker} prefer compact release-note style status updates.`,
    });
    const beforeGuide = await guideForMarker({ app, marker });
    assert.equal(beforeGuide.agent_context.use_now_memory_ids.includes(memoryId), true);

    const firstFeedback = await activateFromGuide({
      app,
      guide: beforeGuide,
      memoryId,
      runId: "run:closed-loop-repeated-weak-1",
      outcome: "negative",
      verifierStatus: "not_run",
      toolStatus: "unknown",
    });
    const afterFirstGuide = await guideForMarker({ app, marker });
    assert.equal(afterFirstGuide.agent_context.use_now_memory_ids.includes(memoryId), true);

    const secondFeedback = await activateFromGuide({
      app,
      guide: afterFirstGuide,
      memoryId,
      runId: "run:closed-loop-repeated-weak-2",
      outcome: "negative",
      verifierStatus: "not_run",
      toolStatus: "unknown",
    });
    assert.equal(firstFeedback.forget_effect.affected_memory_ids.includes(memoryId), true);
    const slots = await slotsForMemory({ liteWriteStore, memoryId });
    assert.equal(slots.feedback_negative, 2);
    assert.equal(slots.weak_counter_signal_count, 2);

    const afterSecondGuide = await guideForMarker({ app, marker });
    assert.equal(afterSecondGuide.agent_context.use_now_memory_ids.includes(memoryId), false);
    assert.equal(afterSecondGuide.agent_context.inspect_before_use_memory_ids.includes(memoryId), true);

    const measure = await measureTrace({
      app,
      beforeGuide,
      afterGuide: afterSecondGuide,
      forgetResult: secondFeedback,
      evidenceId: "product_trace:closed-loop-repeated-weak",
    });
    const decision = measure.memory_decision_trace.memory_decisions.find((entry: Record<string, any>) =>
      entry.memory_id === memoryId
    );
    assert.equal(decision.agent_surface, "inspect_before_use");
    assert.equal(decision.feedback_detail.threshold_state, "repeated_weak_threshold_met");
    assert.equal(decision.feedback_detail.threshold_met, true);
    assert.deepEqual(measure.memory_decision_trace.feedback_attribution.threshold_met_memory_ids, [memoryId]);
    assert.deepEqual(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_from_threshold_met_memory_ids,
      [memoryId],
    );
    assert.deepEqual(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_inspect_before_use_memory_ids,
      [memoryId],
    );
    assert.deepEqual(measure.effect_report.feedback_signal_summary.weak_counter_signal_memory_ids, [memoryId]);
    assert.equal(measure.effect_report.feedback_signal_summary.authority_mutation, false);
  } finally {
    await app.close();
  }
});

test("product feedback closed loop persists repeated unused exposure as inspect-before-use posture", async () => {
  const { app, liteWriteStore } = setupProductApp("repeated-unused-exposure");
  try {
    const marker = "AIONIS_CLOSED_LOOP_UNUSED";
    const usedMemoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-used",
      title: "Closed loop used memory",
      text: `${marker} use customer-facing severity labels in status updates.`,
      confidence: 0.88,
    });
    const unusedMemoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-unused",
      title: "Closed loop repeated unused memory",
      text: `${marker} include obsolete escalation owner names in status updates.`,
      confidence: 0.87,
    });

    const firstGuide = await guideForMarker({ app, marker });
    assert.equal(firstGuide.agent_context.memory_ids.includes(usedMemoryId), true);
    assert.equal(firstGuide.agent_context.memory_ids.includes(unusedMemoryId), true);

    const secondGuide = await guideForMarker({ app, marker });
    assert.equal(secondGuide.agent_context.memory_ids.includes(usedMemoryId), true);
    assert.equal(secondGuide.agent_context.memory_ids.includes(unusedMemoryId), true);

    const feedback = await activateFromGuide({
      app,
      guide: secondGuide,
      memoryId: usedMemoryId,
      runId: "run:closed-loop-unused-exposure",
      outcome: "positive",
    });
    const unusedObservation = feedback.forget_effect.guide_trace.unused_exposure_observation;
    assert.equal(unusedObservation.mode, "read_only_measure");
    assert.equal(unusedObservation.exposure_threshold, 2);
    assert.equal(unusedObservation.guide_trace_count, 2);
    assert.equal(unusedObservation.tracked_memory_count, 2);
    assert.ok(unusedObservation.repeated_unattributed_memory_ids.includes(unusedMemoryId));
    assert.ok(
      unusedObservation.repeated_unattributed_without_positive_memory_ids.includes(unusedMemoryId),
    );
    assert.equal(feedback.forget_effect.guide_trace.feedback_learning_control.contract_version, "aionis_feedback_learning_control_persistence_v1");
    assert.equal(feedback.forget_effect.guide_trace.feedback_learning_control.mode, "inspect_before_use_persistence");
    assert.deepEqual(feedback.forget_effect.guide_trace.feedback_learning_control.changed_memory_ids, [unusedMemoryId]);
    const unusedStats = unusedObservation.memory_stats.find((entry: Record<string, any>) =>
      entry.memory_id === unusedMemoryId
    );
    assert.equal(unusedStats.current_unattributed, true);
    assert.equal(unusedStats.exposure_count, 2);
    assert.equal(unusedStats.use_now_exposure_count, 2);
    assert.equal(unusedStats.positive_attributed_use_count, 0);
    assert.equal(unusedStats.repeated_without_positive_attribution, true);

    const unusedSlots = await slotsForMemory({ liteWriteStore, memoryId: unusedMemoryId });
    assert.equal(unusedSlots.feedback_negative, undefined);
    assert.equal(unusedSlots.weak_counter_signal_count, undefined);
    assert.equal(unusedSlots.feedback_learning_control_posture, "inspect_before_use");
    assert.equal(unusedSlots.feedback_learning_control_source, "repeated_unused_without_positive_attribution");
    assert.equal(unusedSlots.repeated_unused_without_positive_observation_count, 2);

    const afterGuide = await guideForMarker({ app, marker });
    assert.equal(afterGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), false);
    assert.equal(afterGuide.agent_context.inspect_before_use_memory_ids.includes(unusedMemoryId), true);
    const unusedAfterMemory = afterGuide.memory_packet.relevant_memories.find((entry: Record<string, any>) =>
      entry.memory_id === unusedMemoryId
    );
    assert.equal(unusedAfterMemory.lifecycle_state, "candidate");
    assert.equal(unusedAfterMemory.authority, "candidate");

    const measure = await measureTrace({
      app,
      beforeGuide: firstGuide,
      afterGuide,
      forgetResult: feedback,
      evidenceId: "product_trace:closed-loop-unused-exposure",
    });
    assert.ok(measure.memory_decision_trace.feedback_attribution.unattributed_recalled_memory_ids.includes(unusedMemoryId));
    assert.ok(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.repeated_unattributed_memory_ids.includes(
        unusedMemoryId,
      ),
    );
    assert.ok(measure.effect_report.feedback_signal_summary.repeated_unattributed_memory_ids.includes(unusedMemoryId));
    assert.ok(
      measure.effect_report.feedback_signal_summary.repeated_unattributed_without_positive_memory_ids.includes(unusedMemoryId),
    );
    assert.equal(measure.effect_report.feedback_signal_summary.authority_mutation, false);
    assert.ok(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_from_repeated_unused_without_positive_memory_ids.includes(unusedMemoryId),
    );
    assert.ok(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_inspect_before_use_memory_ids.includes(unusedMemoryId),
    );
    assert.equal(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .authority_mutation,
      false,
    );
    const unusedDecision = measure.memory_decision_trace.memory_decisions.find((entry: Record<string, any>) =>
      entry.memory_id === unusedMemoryId
    );
    assert.equal(unusedDecision.agent_surface, "inspect_before_use");
    assert.equal(unusedDecision.feedback_detail, null);

    await activateFromGuide({
      app,
      guide: afterGuide,
      memoryId: unusedMemoryId,
      runId: "run:closed-loop-unused-exposure-revalidated",
      outcome: "positive",
      usedSurface: "explicit_host_assertion",
    });
    const revalidatedSlots = await slotsForMemory({ liteWriteStore, memoryId: unusedMemoryId });
    assert.equal(revalidatedSlots.positive_attributed_use_count, 1);
    assert.equal(revalidatedSlots.feedback_learning_control_posture, undefined);
    assert.equal(revalidatedSlots.feedback_learning_control_cleared_reason, "positive_attribution");

    const revalidatedGuide = await guideForMarker({ app, marker });
    assert.equal(revalidatedGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);
    assert.equal(revalidatedGuide.agent_context.inspect_before_use_memory_ids.includes(unusedMemoryId), false);
  } finally {
    await app.close();
  }
});

test("product guide honors persisted repeated-unused inspect posture without active projection flag", async () => {
  const { app, liteWriteStore } = setupProductApp("persisted-repeated-unused-exposure");
  try {
    const marker = "AIONIS_ACTIVE_REPEATED_UNUSED";
    const usedMemoryId = await observeMemory({
      app,
      clientId: "memory:active-closed-loop-used",
      title: "Active closed loop used memory",
      text: `${marker} use customer-facing severity labels in status updates.`,
      confidence: 0.88,
    });
    const unusedMemoryId = await observeMemory({
      app,
      clientId: "memory:active-closed-loop-unused",
      title: "Active closed loop repeated unused memory",
      text: `${marker} include obsolete escalation owner names in status updates.`,
      confidence: 0.87,
    });

    const firstGuide = await guideForMarker({ app, marker });
    assert.equal(firstGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);
    assert.equal(firstGuide.source_map.internal_surfaces_used.includes("inspect_before_use_active_projection"), false);

    const secondGuide = await guideForMarker({ app, marker });
    assert.equal(secondGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);

    await activateFromGuide({
      app,
      guide: secondGuide,
      memoryId: usedMemoryId,
      runId: "run:active-closed-loop-unused-exposure",
      outcome: "positive",
    });

    const thirdGuide = await guideForMarker({ app, marker });
    assert.equal(thirdGuide.agent_context.use_now_memory_ids.includes(usedMemoryId), true);
    assert.equal(thirdGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), false);
    assert.equal(thirdGuide.agent_context.inspect_before_use_memory_ids.includes(unusedMemoryId), true);
    assert.equal(thirdGuide.agent_context.recommended_posture, "inspect_before_use");
    assert.equal(
      thirdGuide.source_map.internal_surfaces_used.includes("inspect_before_use_active_projection"),
      false,
    );
    assert.equal(thirdGuide.agent_context.prompt_text.includes("inspect_before_use_shadow_delta"), false);
    assert.equal(thirdGuide.agent_context.prompt_text.includes("confidence_decay"), false);

    const unusedSlots = await slotsForMemory({ liteWriteStore, memoryId: unusedMemoryId });
    assert.equal(unusedSlots.feedback_negative, undefined);
    assert.equal(unusedSlots.weak_counter_signal_count, undefined);
    assert.equal(unusedSlots.strong_counter_signal_count, undefined);
    assert.equal(unusedSlots.positive_attributed_use_count, undefined);
    assert.equal(unusedSlots.feedback_learning_control_posture, "inspect_before_use");
  } finally {
    await app.close();
  }
});

test("product guide persisted repeated-unused posture ignores negative attributed use", async () => {
  const { app, liteWriteStore } = setupProductApp("persisted-repeated-unused-negative-used-boundary");
  try {
    const marker = "AIONIS_ACTIVE_REPEATED_UNUSED_NEGATIVE_USED";
    const usedMemoryId = await observeMemory({
      app,
      clientId: "memory:active-negative-used-boundary",
      title: "Active negative attributed used memory",
      text: `${marker} use customer-facing severity labels in status updates.`,
      confidence: 0.88,
    });
    const unusedMemoryId = await observeMemory({
      app,
      clientId: "memory:active-negative-unused-boundary",
      title: "Active negative boundary repeated unused memory",
      text: `${marker} include obsolete escalation owner names in status updates.`,
      confidence: 0.87,
    });

    const firstGuide = await guideForMarker({ app, marker });
    assert.equal(firstGuide.agent_context.use_now_memory_ids.includes(usedMemoryId), true);
    assert.equal(firstGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);

    const secondGuide = await guideForMarker({ app, marker });
    assert.equal(secondGuide.agent_context.use_now_memory_ids.includes(usedMemoryId), true);
    assert.equal(secondGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);

    await activateFromGuide({
      app,
      guide: firstGuide,
      memoryId: usedMemoryId,
      runId: "run:active-repeated-unused-negative-used-boundary",
      outcome: "negative",
    });

    const thirdGuide = await guideForMarker({ app, marker });
    assert.equal(thirdGuide.agent_context.use_now_memory_ids.includes(usedMemoryId), true);
    assert.equal(thirdGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), false);
    assert.equal(thirdGuide.agent_context.inspect_before_use_memory_ids.includes(unusedMemoryId), true);
    assert.equal(
      thirdGuide.source_map.internal_surfaces_used.includes("inspect_before_use_active_projection"),
      false,
    );

    const usedSlots = await slotsForMemory({ liteWriteStore, memoryId: usedMemoryId });
    assert.equal(usedSlots.feedback_negative, 1);
    assert.equal(usedSlots.attributed_use_count, 1);
    assert.equal(usedSlots.positive_attributed_use_count, 0);

    const unusedSlots = await slotsForMemory({ liteWriteStore, memoryId: unusedMemoryId });
    assert.equal(unusedSlots.feedback_negative, undefined);
    assert.equal(unusedSlots.attributed_use_count, undefined);
    assert.equal(unusedSlots.feedback_learning_control_posture, "inspect_before_use");
  } finally {
    await app.close();
  }
});
