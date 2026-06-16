import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { createRuntimeServices } from "../../src/app/runtime-services.ts";
import { loadEnv, type Env } from "../../src/config.ts";
import { createLiteExecutionStateStore } from "../../src/execution/state-store.ts";
import { createLiteExecutionTreeStore } from "../../src/execution/tree-store.ts";
import { registerApplicationRoutes, registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
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
      AUTO_TOPIC_CLUSTER_ON_WRITE: "false",
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
  registerRuntimeErrorHandler(args.app);
  registerApplicationRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    queryEmbedder: DeterministicEmbeddingProvider,
    embeddingSurfacePolicy: {
      provider_configured: true,
      enabled_surfaces: ["write_auto_embed", "recall_text_query", "topic_cluster"],
      isEnabled: () => true,
      providerFor: (_surface, provider) => provider,
    },
    liteRecallAccess: liteRecallStore.createRecallAccess(),
    liteReplayAccess: liteReplayStore.createReplayAccess(),
    liteReplayStore,
    liteWriteStore,
    executionStateStore,
    executionTreeStore,
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
  return { liteWriteStore, liteRecallStore, liteReplayStore, executionStateStore, executionTreeStore };
}

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

test("server edition can construct local-store Runtime services", async () => {
  const writePath = tmpDbPath("services-write");
  const replayPath = tmpDbPath("services-replay");
  const env = await serverEnv(writePath, replayPath);
  const services = await createRuntimeServices(env);
  try {
    assert.ok(services.liteWriteStore);
    assert.ok(services.liteRecallAccess);
    assert.ok(services.liteReplayAccess);
    assert.equal(services.embeddingSurfacePolicy.provider_configured, false);
  } finally {
    await services.executionTreeStore.close();
    await services.executionStateStore.close();
    await services.liteRecallStore.close();
    await services.liteReplayStore.close();
    await services.liteWriteStore.close();
    services.sandboxExecutor.shutdown();
    await services.store.close();
  }
});
