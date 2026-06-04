import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { registerMemoryWriteRoutes } from "../../src/routes/memory-write.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-product-facade-"));
  return path.join(dir, `${name}.sqlite`);
}

function liteEnv() {
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

function requestGuards(env: ReturnType<typeof liteEnv>, embedder: typeof DeterministicEmbeddingProvider | null = null) {
  return createRequestGuards({
    env,
    embedder,
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
}) {
  registerProductFacadeRoutes({
    app: args.app,
    env: args.env,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
}

function registerFullProductMemoryApp(args: {
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
  registerProductFacade(args);
}

test("product measure facade returns a product effect report without external eval runners", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env);
  try {
    registerRuntimeErrorHandler(app);
    registerProductFacade({ app, env, guards });

    const response = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        baseline: {
          continuity: {
            repeatedDiscoverySteps: 4,
            firstActionCorrect: false,
            recoveredStateFacts: 1,
            expectedStateFacts: 4,
          },
          learning: {
            workflowReused: false,
            provisionalMemoriesWritten: 1,
          },
          forgetting: {
            contextItems: 8,
            usefulContextItems: 2,
            staleMemorySurfaced: 3,
          },
          learning_control: {
            authorityRequiresEvidence: true,
            blockedAuthorityVisible: true,
            unverifiedAuthorityApplied: 0,
          },
        },
        aionis: {
          continuity: {
            repeatedDiscoverySteps: 1,
            firstActionCorrect: true,
            recoveredStateFacts: 4,
            expectedStateFacts: 4,
          },
          learning: {
            workflowReused: true,
            stableWorkflowReused: true,
            trustedPromotions: 1,
            weakEvidencePromoted: 0,
          },
          forgetting: {
            contextItems: 5,
            usefulContextItems: 4,
            staleMemorySurfaced: 0,
            staleMemorySuppressed: 3,
            archivedMemoryRehydratedOnDemand: 1,
          },
          learning_control: {
            weakEvidenceBlocked: 2,
            authorityRequiresEvidence: true,
            blockedAuthorityVisible: true,
            unverifiedAuthorityApplied: 0,
          },
        },
        comparison: {
          mode: "baseline_vs_aionis",
          sufficient_evidence: true,
        },
        evidence_ids: ["effect-run:facade-contract"],
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.contract_version, "aionis_measure_result_v1");
    assert.equal(body.effect_report.contract_version, "aionis_effect_report_v1");
    assert.equal(body.effect_report.history_impact.impact_direction, "positive");
    assert.equal(body.effect_report.history_impact.changed_future_behavior, true);
    assert.equal(body.effect_report.quality.negative_transfer_detected, false);
    assert.deepEqual(body.source_map.routes_used, ["/v1/measure"]);
  } finally {
    await app.close();
  }
});

test("product observe auto-structures user-level workflow input into execution memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-workflow");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        memory: {
          client_id: "workflow:continuity",
          type: "procedure",
          memory_kind: "execution_workflow",
          title: "Recover target file before broad discovery",
          text_summary: "Read the known target file first, verify it still matches the task, then avoid repeated broad search.",
          task_signature: "continuity-product-loop",
          workflow_signature: "recover-target-file-first",
          target_files: ["src/current-target.ts"],
          next_action: "Read src/current-target.ts before broad discovery.",
          tool_set: ["read", "edit", "test"],
          confidence: 0.9,
        },
      },
    });

    assert.equal(observe.statusCode, 200);
    const observeBody = observe.json();
    assert.equal(observeBody.structured_memory.execution_workflow_count, 1);
    assert.equal(observeBody.structured_memory.structured_nodes[0].source, "memory");
    assert.equal(observeBody.structured_memory.structured_nodes[0].execution_kind, "workflow_anchor");
    assert.ok(observeBody.memory_write.nodes[0].id);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
      },
    });

    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    assert.equal(guideBody.memory_packet.memory_family, "execution");
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.domain === "execution"
        && entry.memory_type === "execution_memory"
        && entry.summary === "Read the known target file first, verify it still matches the task, then avoid repeated broad search.",
      ),
    );
    assert.ok(Array.isArray(guideBody.guide_packet.guidance.workflow_candidates));
  } finally {
    await app.close();
  }
});

test("product observe does not auto-promote general memory into execution workflow", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-general");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        input_text: "The workspace owner prefers short product-facing reports.",
        auto_embed: true,
        nodes: [{
          client_id: "general:report-style",
          type: "concept",
          memory_kind: "general_memory",
          title: "Report style preference",
          text_summary: "The workspace owner prefers short product-facing reports.",
          confidence: 0.9,
        }],
      },
    });

    assert.equal(observe.statusCode, 200);
    const body = observe.json();
    assert.equal(body.structured_memory.execution_workflow_count, 0);
    assert.equal(body.structured_memory.general_memory_count, 1);
    assert.equal(body.structured_memory.structured_nodes[0].execution_kind, null);
  } finally {
    await app.close();
  }
});
