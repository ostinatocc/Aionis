import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import Fastify from "fastify";

import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { updateRuleState } from "../../src/memory/rules.ts";
import { createRequestGuards } from "./support/create-request-guards-test-config.ts";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createHandoffRouteService, registerHandoffRoutes } from "../../src/routes/handoff.ts";
import { createMemoryPlanningContextService } from "../../src/routes/memory-context-runtime.ts";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { createRuntimeProductServices, registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

const MANIFEST_ROOT = "/Volumes/ziel/new.aionis/AionisManifest";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-manifest-product-resume-"));
  return path.join(dir, "runtime.sqlite");
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
    MAX_TEXT_LEN: 20_000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    MEMORY_WRITE_REQUIRE_NODES: false,
    MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT: 4096,
    MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: true,
    MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
    MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
  } as any;
}

function registerRealManifestProductRuntime(args: {
  app: ReturnType<typeof Fastify>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
}) {
  const env = liteEnv();
  const recallAccess = args.liteRecallStore.createRecallAccess();
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
  const memoryWriteService = createMemoryWriteRouteService({
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    executionStateStore: null,
  });
  const handoffService = createHandoffRouteService({
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    executionStateStore: null,
  });

  registerRuntimeErrorHandler(args.app);
  registerHandoffRoutes({
    app: args.app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest as any,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    executionStateStore: null,
  });
  const contextRuntime = createMemoryPlanningContextService({
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: recallAccess,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    enforceRecallTextEmbedQuota: guards.enforceRecallTextEmbedQuota,
    buildRecallAuth: guards.buildRecallAuth,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    hasExplicitRecallKnobs: () => false,
    resolveRecallProfile: () => ({ profile: "balanced", source: "manifest_product_resume_test" }),
    resolveExplicitRecallMode: () => ({
      mode: null,
      profile: "balanced",
      defaults: {},
      applied: false,
      reason: "test_default",
      source: "manifest_product_resume_test",
    }),
    resolveClassAwareRecallProfile: (_endpoint, _body, baseProfile) => ({
      profile: baseProfile,
      defaults: {},
      enabled: false,
      applied: false,
      reason: "test_default",
      source: "manifest_product_resume_test",
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
  registerProductFacadeRoutes({
    app: args.app,
    services: createRuntimeProductServices({
      env,
      liteWriteStore: args.liteWriteStore,
      liteRecallAccess: recallAccess,
      embedder: DeterministicEmbeddingProvider,
      queryEmbedder: DeterministicEmbeddingProvider,
      executionTreeStore: null,
      memoryWriteService,
      handoffRouteService: handoffService,
    }),
    planningContextService: contextRuntime,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
}

async function seedManifestToolRule(liteWriteStore: ReturnType<typeof createLiteWriteStore>) {
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    input_text: "Prefer read when resuming an Aionis Manifest workflow.",
    auto_embed: false,
    memory_lane: "shared",
    nodes: [{
      client_id: "rule:manifest-resume:prefer-read",
      type: "rule",
      title: "Prefer read for Manifest resume",
      text_summary: "Use read for doc_resume context.",
      slots: {
        if: { intent: { $eq: "doc_resume" } },
        then: { tool: { prefer: ["read"] } },
        exceptions: [],
        rule_scope: "global",
      },
    }],
    edges: [],
  }, "default", "default", {
    maxTextLen: 20_000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
  }, null);
  const written = await liteWriteStore.withTx(() => applyMemoryWrite(prepared, {
    maxTextLen: 20_000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
    associativeLinkOrigin: "memory_write",
    write_access: liteWriteStore,
  }));
  const ruleNodeId = written.nodes[0]?.id;
  assert.ok(ruleNodeId);
  await liteWriteStore.withTx(() => updateRuleState({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    rule_node_id: ruleNodeId,
    state: "active",
    input_text: "Activate the Manifest resume tool rule.",
  }, "default", "default", { liteWriteStore }));
}

test("Manifest resumes through real Runtime guide and attributed feedback product routes", async () => {
  const app = Fastify();
  const dbPath = tmpDbPath();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  registerRealManifestProductRuntime({ app, liteWriteStore, liteRecallStore });
  try {
    await seedManifestToolRule(liteWriteStore);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const manifestModule = await import(pathToFileURL(path.join(MANIFEST_ROOT, "dist", "resume.js")).href);
    const source = fs.readFileSync(path.join(MANIFEST_ROOT, "fixtures", "valid-minimal.aionis.md"), "utf8");
    const result = await manifestModule.resumeAionisManifestSource({
      source,
      inputPath: path.join(MANIFEST_ROOT, "fixtures", "valid-minimal.aionis.md"),
      baseUrl,
      scope: "default",
      tenantId: "default",
      candidates: ["read", "bash"],
      runId: "run:manifest-product-resume",
      feedbackOutcome: "positive",
      feedbackNote: "The selected Manifest resume tool completed the verified continuation.",
      feedbackActor: "local-user",
      allowCompileErrors: false,
    });

    assert.equal(result.resume_result_version, "aionis_manifest_resume_result_v2");
    assert.equal(result.guide_response.data.source_map.routes_used[0], "/v1/guide");
    assert.equal(result.tool_feedback_response.data.source_map.routes_used[0], "/v1/feedback");
    assert.equal(result.resume_summary.selected_tool, "read");
    assert.equal(result.resume_summary.run_id, "run:manifest-product-resume");
    assert.equal(result.resume_summary.feedback_written, true);
    assert.equal(result.resume_summary.feedback_updated_rules, 1);
    assert.equal(result.resume_summary.pre_feedback_run_status, "decision_recorded");
    assert.equal(result.resume_summary.post_feedback_run_status, "feedback_linked");
    assert.equal(result.resume_summary.lifecycle_transition, "decision_recorded -> feedback_linked");
    const internalRouteMatches = JSON.stringify(result).match(/\/v1\/memory\/[^"\\]+/g) ?? [];
    assert.deepEqual(internalRouteMatches, []);

    const decision = await liteWriteStore.getExecutionDecision({
      scope: "default",
      id: result.resume_summary.decision_id,
    });
    assert.ok(decision);
    assert.equal(decision.run_id, "run:manifest-product-resume");
    assert.equal(decision.selected_tool, "read");
    const feedback = await liteWriteStore.listRuleFeedbackByRun({
      scope: "default",
      runId: "run:manifest-product-resume",
      limit: 16,
    });
    assert.equal(feedback.total, 1);
    assert.equal(feedback.tools_feedback_count, 1);
  } finally {
    await app.close();
  }
});
