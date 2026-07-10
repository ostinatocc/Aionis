import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "./support/create-request-guards-test-config.ts";
import { createRuntimeServices } from "../../src/app/runtime-services.ts";
import { loadEnv, type Env } from "../../src/config.ts";
import { createRuntimeConfig } from "../../src/config/runtime-config.ts";
import { createLiteExecutionStateStore } from "../../src/execution/state-store.ts";
import { createLiteExecutionTreeStore } from "../../src/execution/tree-store.ts";
import { createHandoffRouteService } from "../../src/routes/handoff.ts";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.ts";
import {
  createRuntimeProductServices,
  registerApplicationRoutes,
  registerRuntimeErrorHandler,
} from "../../src/server/http-server.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteReplayStore } from "../../src/store/lite-replay-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-server-product-smoke-"));
  return path.join(dir, `${name}.sqlite`);
}

async function withIsolatedEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env;
  const next: NodeJS.ProcessEnv = {
    PATH: previous.PATH ?? "",
    HOME: previous.HOME ?? "",
    TMPDIR: previous.TMPDIR ?? "",
    USER: previous.USER ?? "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) next[key] = value;
  }
  process.env = next;
  try {
    return await fn();
  } finally {
    process.env = previous;
  }
}

async function serverEnv(writePath: string, replayPath: string): Promise<Env> {
  return withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      APP_ENV: "ci",
      MEMORY_AUTH_MODE: "api_key",
      MEMORY_API_KEYS_JSON: JSON.stringify({
        "tenant-a-key": {
          tenant_id: "tenant-a",
          agent_id: "agent-a",
          team_id: "team-a",
          role: "developer",
          default_scope: "tenant-a/default",
          allowed_scopes: ["tenant-a/default"],
        },
      }),
      MEMORY_TENANT_ID: "tenant-a",
      MEMORY_SCOPE: "tenant-a/default",
      LITE_LOCAL_ACTOR_ID: "server-local",
      LITE_WRITE_SQLITE_PATH: writePath,
      LITE_REPLAY_SQLITE_PATH: replayPath,
      SANDBOX_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: "false",
    },
    () => loadEnv(),
  );
}

function registerServerProductApp(args: {
  app: ReturnType<typeof Fastify>;
  env: Env;
  writePath: string;
  replayPath: string;
}) {
  const liteWriteStore = createLiteWriteStore(args.writePath);
  const liteRecallStore = createLiteRecallStore(args.writePath);
  const liteReplayStore = createLiteReplayStore(args.replayPath);
  const executionStateStore = createLiteExecutionStateStore(args.writePath);
  const executionTreeStore = createLiteExecutionTreeStore(args.writePath);
  const embeddingSurfacePolicy = {
    provider_configured: true,
    enabled_surfaces: ["write_auto_embed", "recall_text"],
    isEnabled: () => true,
    providerFor: (_surface: unknown, provider: unknown) => provider,
  } as const;
  const guards = createRequestGuards({
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 1000 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 1000 }),
  });
  const memoryWriteService = createMemoryWriteRouteService({
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    embeddingSurfacePolicy: embeddingSurfacePolicy as any,
    liteWriteStore,
    executionStateStore,
    executionTreeStore,
  });
  const productServices = createRuntimeProductServices({
    env: args.env,
    liteWriteStore,
    executionTreeStore,
    memoryWriteService,
    handoffRouteService: createHandoffRouteService({
      env: args.env,
      embedder: DeterministicEmbeddingProvider,
      embeddingSurfacePolicy: embeddingSurfacePolicy as any,
      liteWriteStore,
      executionStateStore,
      executionTreeStore,
    }),
  });
  registerRuntimeErrorHandler(args.app);
  registerApplicationRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    queryEmbedder: DeterministicEmbeddingProvider,
    embeddingSurfacePolicy: embeddingSurfacePolicy as any,
    liteRecallAccess: liteRecallStore.createRecallAccess(),
    liteReplayAccess: liteReplayStore.createReplayAccess(),
    liteReplayStore,
    liteWriteStore,
    executionStateStore,
    executionTreeStore,
    productServices,
    recallTextEmbedBatcher: { stats: () => null },
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    enforceRecallTextEmbedQuota: guards.enforceRecallTextEmbedQuota,
    buildRecallAuth: guards.buildRecallAuth,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
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
    withReplayRepairReviewDefaults: (body) => ({ body: body as Record<string, unknown>, resolution: null }),
    buildReplayRepairReviewOptions: () => ({
      defaultScope: args.env.MEMORY_SCOPE,
      defaultTenantId: args.env.MEMORY_TENANT_ID,
      maxTextLen: args.env.MAX_TEXT_LEN,
      piiRedaction: args.env.PII_REDACTION,
      allowCrossScopeEdges: args.env.ALLOW_CROSS_SCOPE_EDGES,
      embedder: DeterministicEmbeddingProvider,
      replayAccess: liteReplayStore.createReplayAccess(),
      replayMirror: liteReplayStore,
      writeAccess: liteWriteStore,
      sandboxStore: null,
      sandboxExecutor: null,
      runtimeVerification: { enabled: false },
      learningControlReviewProviders: {},
    } as any),
    buildReplayPlaybookRunOptions: () => ({
      replayAccess: liteReplayStore.createReplayAccess(),
      sandboxStore: null,
      sandboxExecutor: null,
      defaultScope: args.env.MEMORY_SCOPE,
      defaultTenantId: args.env.MEMORY_TENANT_ID,
    } as any),
  });
  return {
    liteWriteStore,
    liteRecallStore,
    liteReplayStore,
    executionStateStore,
    executionTreeStore,
    productServices,
  };
}

test("application registration exposes product routes but not replaced internal memory routes", async () => {
  const app = Fastify();
  const writePath = tmpDbPath("route-removal-write");
  const replayPath = tmpDbPath("route-removal-replay");
  const env = await serverEnv(writePath, replayPath);
  const stores = registerServerProductApp({ app, env, writePath, replayPath });
  const removedRoutes = [
    "/v1/memory/recall",
    "/v1/memory/recall_text",
    "/v1/memory/planning/context",
    "/v1/memory/context/assemble",
    "/v1/memory/tools/select",
    "/v1/memory/tools/decision",
    "/v1/memory/tools/run",
    "/v1/memory/tools/feedback",
    "/v1/memory/write",
    "/v1/memory/archive/rehydrate",
    "/v1/memory/nodes/activate",
    "/v1/execution/context/assemble",
    "/v1/memory/trajectory/compile",
    "/v1/memory/delegation/records",
    "/v1/memory/delegation/records/find",
    "/v1/memory/delegation/records/aggregate",
    "/v1/memory/find",
    "/v1/memory/continuity/review-pack",
    "/v1/memory/agent/inspect",
    "/v1/memory/agent/review-pack",
    "/v1/memory/agent/resume-pack",
    "/v1/memory/agent/handoff-pack",
    "/v1/memory/execution/introspect",
    "/v1/memory/evolution/review-pack",
    "/v1/memory/action/retrieval",
    "/v1/memory/experience/intelligence",
    "/v1/memory/anchors/rehydrate_payload",
    "/v1/memory/feedback",
    "/v1/memory/rules/state",
    "/v1/memory/rules/evaluate",
    "/v1/memory/tools/runs/list",
    "/v1/memory/learning-loop/run",
    "/v1/memory/runtime-maintenance/run",
    "/v1/memory/runtime-maintenance/immediate",
    "/v1/memory/runtime-maintenance/daily",
    "/v1/memory/runtime-maintenance/long-horizon",
    "/v1/memory/policies/learning-control/apply",
    "/v1/memory/anchors/suppress",
    "/v1/memory/anchors/unsuppress",
    "/v1/memory/patterns/suppress",
    "/v1/memory/patterns/unsuppress",
    "/v1/memory/tools/rehydrate_payload",
    "/v1/memory/replay/run/start",
    "/v1/memory/replay/step/before",
    "/v1/memory/replay/step/after",
    "/v1/memory/replay/run/end",
    "/v1/memory/replay/runs/get",
    "/v1/memory/replay/playbooks/compile_from_run",
    "/v1/memory/replay/playbooks/get",
    "/v1/memory/replay/playbooks/candidate",
    "/v1/memory/replay/playbooks/promote",
    "/v1/memory/replay/playbooks/repair",
    "/v1/memory/replay/playbooks/repair/review",
    "/v1/memory/replay/playbooks/run",
    "/v1/memory/replay/playbooks/dispatch",
  ];
  try {
    assert.equal(app.hasRoute({ method: "POST", url: "/v1/observe" }), true);
    assert.equal(app.hasRoute({ method: "POST", url: "/v1/operator/snapshot" }), true);
    assert.equal(app.hasRoute({ method: "POST", url: "/v1/memory/resolve" }), true);
    for (const url of removedRoutes) {
      assert.equal(app.hasRoute({ method: "POST", url }), false, `${url} must not be registered`);
    }

    for (const url of removedRoutes.slice(0, 8)) {
      const response = await app.inject({ method: "POST", url, payload: {} });
      assert.equal(response.statusCode, 404, `${url} must return 404`);
    }

    const unsupported = await app.inject({
      method: "POST",
      url: "/v1/memory/find",
      headers: { "x-api-key": "tenant-a-key" },
      payload: { tenant_id: "tenant-a", scope: "tenant-a/default", limit: 1 },
    });
    assert.equal(unsupported.statusCode, 404, unsupported.body);
    assert.equal(unsupported.json().error, "Not Found");

    const direct = await stores.productServices.observe.execute({
      tenant_id: "tenant-a",
      scope: "tenant-a/default",
      actor: "agent-a",
      input_text: "Direct product service remains callable after internal route removal.",
      auto_embed: false,
    }, { principal: null });
    assert.equal(direct.ok, true);
    assert.equal(direct.statusCode, 200);
  } finally {
    await app.close();
    await stores.executionTreeStore.close();
    await stores.executionStateStore.close();
    await stores.liteRecallStore.close();
    await stores.liteReplayStore.close();
    await stores.liteWriteStore.close();
  }
});

test("server edition product routes require auth and run observe to guide through application registration", async () => {
  const app = Fastify();
  const writePath = tmpDbPath("write");
  const replayPath = tmpDbPath("replay");
  const env = await serverEnv(writePath, replayPath);
  const stores = registerServerProductApp({ app, env, writePath, replayPath });
  try {
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: { input_text: "Server smoke should not accept unauthenticated writes." },
    });
    assert.equal(unauthorized.statusCode, 401);

    const memoryText = "Server smoke memory: prefer audited continuation notes with concise next steps.";
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      headers: { authorization: "Bearer tenant-a-key" },
      payload: {
        input_text: memoryText,
        auto_embed: true,
      },
    });
    assert.equal(observe.statusCode, 200, observe.body);
    const observeBody = observe.json() as Record<string, any>;
    assert.equal(observeBody.contract_version, "aionis_observe_result_v1");
    assert.equal(observeBody.tenant_id, "tenant-a");
    assert.equal(observeBody.scope, "tenant-a/default");
    assert.equal(observeBody.observed.memory_written, true);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      headers: { "x-api-key": "tenant-a-key" },
      payload: {
        query_text: "How should server smoke continuation notes be written?",
        include_packets: true,
        limit: 8,
      },
    });
    assert.equal(guide.statusCode, 200, guide.body);
    const guideBody = guide.json() as Record<string, any>;
    assert.equal(guideBody.contract_version, "aionis_guide_result_v1");
    assert.equal(guideBody.tenant_id, "tenant-a");
    assert.equal(guideBody.scope, "tenant-a/default");
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.domain === "general" && entry.summary === memoryText,
      ),
    );
  } finally {
    await app.close();
    await stores.executionTreeStore.close();
    await stores.executionStateStore.close();
    await stores.liteRecallStore.close();
    await stores.liteReplayStore.close();
    await stores.liteWriteStore.close();
  }
});

test("server edition skill candidate list rejects cross-tenant query identity", async () => {
  const app = Fastify();
  const writePath = tmpDbPath("skill-candidates-write");
  const replayPath = tmpDbPath("skill-candidates-replay");
  const env = await serverEnv(writePath, replayPath);
  const stores = registerServerProductApp({ app, env, writePath, replayPath });
  try {
    const res = await app.inject({
      method: "GET",
      url: "/v1/skills/candidates?tenant_id=tenant-b&scope=tenant-b/default",
      headers: { "x-api-key": "tenant-a-key" },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().error, "tenant_forbidden");
  } finally {
    await app.close();
    await stores.executionTreeStore.close();
    await stores.executionStateStore.close();
    await stores.liteRecallStore.close();
    await stores.liteReplayStore.close();
    await stores.liteWriteStore.close();
  }
});

test("server edition can construct local-store Runtime services", async () => {
  const writePath = tmpDbPath("services-write");
  const replayPath = tmpDbPath("services-replay");
  const env = await serverEnv(writePath, replayPath);
  const services = await createRuntimeServices(createRuntimeConfig(env));
  try {
    assert.ok(services.liteWriteStore);
    assert.ok(services.liteRecallAccess);
    assert.ok(services.liteReplayAccess);
    assert.ok(services.claimLedgerAccess);
    assert.equal(services.embeddingSurfacePolicy.provider_configured, false);
  } finally {
    await services.executionTreeStore.close();
    await services.executionStateStore.close();
    await services.liteClaimLedgerStore.close();
    await services.liteRecallStore.close();
    await services.liteReplayStore.close();
    await services.liteWriteStore.close();
    services.sandboxExecutor.shutdown();
    await services.store.close();
  }
});

test("server edition serves product routes over a real HTTP listener", async () => {
  const app = Fastify();
  const writePath = tmpDbPath("http-write");
  const replayPath = tmpDbPath("http-replay");
  const env = await serverEnv(writePath, replayPath);
  const stores = registerServerProductApp({ app, env, writePath, replayPath });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const memoryText = "HTTP server smoke memory: keep managed server continuation notes auditable.";
    const observe = await fetch(`${baseUrl}/v1/observe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tenant-a-key",
      },
      body: JSON.stringify({
        input_text: memoryText,
        auto_embed: true,
      }),
    });
    const observeText = await observe.text();
    assert.equal(observe.status, 200, observeText);
    const observeBody = JSON.parse(observeText) as Record<string, any>;
    assert.equal(observeBody.contract_version, "aionis_observe_result_v1");
    assert.equal(observeBody.tenant_id, "tenant-a");
    assert.equal(observeBody.scope, "tenant-a/default");

    const guide = await fetch(`${baseUrl}/v1/guide`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "tenant-a-key",
      },
      body: JSON.stringify({
        query_text: "How should managed server continuation notes be written?",
        include_packets: true,
        limit: 8,
      }),
    });
    const guideText = await guide.text();
    assert.equal(guide.status, 200, guideText);
    const guideBody = JSON.parse(guideText) as Record<string, any>;
    assert.equal(guideBody.contract_version, "aionis_guide_result_v1");
    assert.equal(guideBody.tenant_id, "tenant-a");
    assert.equal(guideBody.scope, "tenant-a/default");
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.domain === "general" && entry.summary === memoryText,
      ),
    );
  } finally {
    await app.close();
    await stores.executionTreeStore.close();
    await stores.executionStateStore.close();
    await stores.liteRecallStore.close();
    await stores.liteReplayStore.close();
    await stores.liteWriteStore.close();
  }
});
