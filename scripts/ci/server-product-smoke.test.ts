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
import { createLiteExecutionStateStoreFromDatabase } from "../../src/execution/state-store.ts";
import { createLiteExecutionTreeStoreFromDatabase } from "../../src/execution/tree-store.ts";
import { createHandoffRouteService } from "../../src/routes/handoff.ts";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.ts";
import {
  createRuntimeProductServices,
  registerApplicationRoutes,
  registerRuntimeErrorHandler,
} from "../../src/server/http-server.ts";
import { LITE_ROUTE_CAPABILITY_MATRIX } from "../../src/server/lite-runtime-boundary.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteReplayStore } from "../../src/store/lite-replay-store.ts";
import { createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import { LiteTenantScopeAuthorityError } from "../../src/store/lite-tenant-scope-authority.ts";
import { buildAionisUri } from "../../src/memory/uri.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";
import { updateRuleState } from "../../src/memory/rules.ts";

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
        "tenant-a-attacker-key": {
          tenant_id: "tenant-a",
          agent_id: "agent-b",
          team_id: "team-b",
          role: "developer",
          default_scope: "tenant-a/default",
          allowed_scopes: ["tenant-a/default"],
        },
        "tenant-a-team-key": {
          tenant_id: "tenant-a",
          agent_id: null,
          team_id: "team-c",
          role: "developer",
          default_scope: "tenant-a/default",
          allowed_scopes: ["tenant-a/default"],
        },
        "tenant-b-key": {
          tenant_id: "tenant-b",
          agent_id: "agent-b",
          team_id: "team-b",
          role: "developer",
          default_scope: "tenant-b/default",
          allowed_scopes: ["tenant-b/default"],
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

async function liteEnv(writePath: string, replayPath: string): Promise<Env> {
  return withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      MEMORY_AUTH_MODE: "off",
      MEMORY_TENANT_ID: "default",
      MEMORY_SCOPE: "default",
      LITE_LOCAL_ACTOR_ID: "local-user",
      LITE_WRITE_SQLITE_PATH: writePath,
      LITE_REPLAY_SQLITE_PATH: replayPath,
      SANDBOX_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: "false",
    },
    () => loadEnv(),
  );
}

async function closeConstructedRuntimeServices(
  services: Awaited<ReturnType<typeof createRuntimeServices>>,
): Promise<void> {
  await services.executionTreeStore.close();
  await services.executionStateStore.close();
  await services.liteClaimLedgerStore.close();
  await services.liteRecallStore.close();
  await services.liteReplayStore.close();
  await services.liteWriteStore.close();
  services.sandboxExecutor.shutdown();
  await services.store.close();
}

async function tenantScopeAnchorRows(databasePath: string): Promise<Array<{
  tenant_id: string;
  policy_config_sha256: string;
}>> {
  const database = createLiteRuntimeDatabase(databasePath);
  try {
    return database.db.prepare(
      `SELECT tenant_id, policy_config_sha256
       FROM lite_learning_policy_versions
       WHERE policy_id = 'aionis.runtime.tenant_scope_encoding_anchor'
         AND policy_version = 'v1'
       ORDER BY tenant_id`,
    ).all() as Array<{ tenant_id: string; policy_config_sha256: string }>;
  } finally {
    await database.close();
  }
}

function registerServerProductApp(args: {
  app: ReturnType<typeof Fastify>;
  env: Env;
  writePath: string;
  replayPath: string;
}) {
  const runtimeDatabase = createLiteRuntimeDatabase(args.writePath);
  const liteWriteStore = createLiteWriteStoreFromDatabase(runtimeDatabase, { closeDatabaseOnClose: true });
  const liteRecallStore = createLiteRecallStore(args.writePath);
  const liteReplayStore = createLiteReplayStore(args.replayPath);
  const executionStateStore = createLiteExecutionStateStoreFromDatabase(runtimeDatabase.db, {
    path: runtimeDatabase.path,
    transaction: runtimeDatabase.transaction,
  });
  const executionTreeStore = createLiteExecutionTreeStoreFromDatabase(runtimeDatabase.db, {
    path: runtimeDatabase.path,
    transaction: runtimeDatabase.transaction,
  });
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
    liteRecallAccess: liteRecallStore.createRecallAccess(),
    embedder: DeterministicEmbeddingProvider,
    queryEmbedder: DeterministicEmbeddingProvider,
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

test("Lite application registration exactly matches the governed route matrix", async () => {
  const app = Fastify();
  const registeredRoutes = new Set<string>();
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/v1/") || route.url.startsWith("/v1/admin/control")) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      registeredRoutes.add(`${method} ${route.url}`);
    }
  });
  const writePath = tmpDbPath("lite-route-inventory-write");
  const replayPath = tmpDbPath("lite-route-inventory-replay");
  const env = await liteEnv(writePath, replayPath);
  const stores = registerServerProductApp({ app, env, writePath, replayPath });
  try {
    await app.ready();
    const expectedRoutes = LITE_ROUTE_CAPABILITY_MATRIX
      .map((entry) => `${entry.method} ${entry.path}`)
      .sort();
    assert.deepEqual([...registeredRoutes].sort(), expectedRoutes);
    for (const url of [
      "/v1/operator/workspaces",
      "/v1/operator/runs",
      "/v1/operator/runs/:run_id",
      "/v1/operator/memories/:memory_id",
    ]) {
      assert.equal(app.hasRoute({ method: "GET", url }), false, `${url} must remain removed`);
    }
  } finally {
    await app.close();
    await stores.executionTreeStore.close();
    await stores.executionStateStore.close();
    await stores.liteRecallStore.close();
    await stores.liteReplayStore.close();
    await stores.liteWriteStore.close();
  }
});

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

test("server product evidence identity is bound to the authenticated principal", async () => {
  const app = Fastify();
  const writePath = tmpDbPath("evidence-identity-write");
  const replayPath = tmpDbPath("evidence-identity-replay");
  const env = await serverEnv(writePath, replayPath);
  const stores = registerServerProductApp({ app, env, writePath, replayPath });
  const victimHeaders = { "x-api-key": "tenant-a-key" };
  const attackerHeaders = { "x-api-key": "tenant-a-attacker-key" };
  const teamHeaders = { "x-api-key": "tenant-a-team-key" };
  try {
    const marker = "SERVER_PRINCIPAL_EVIDENCE_IDENTITY_MARKER";
    const observed = await app.inject({
      method: "POST",
      url: "/v1/observe",
      headers: victimHeaders,
      payload: {
        input_text: `${marker} Prefer audited status summaries and choose read first.`,
        auto_embed: true,
        memory_lane: "shared",
        nodes: [
          {
            client_id: "memory:server-principal-evidence-identity",
            type: "concept",
            tier: "warm",
            memory_lane: "shared",
            title: "Server principal evidence identity memory",
            text_summary: `${marker} Prefer audited status summaries.`,
            confidence: 0.9,
          },
          {
            client_id: "rule:server-principal-evidence-identity",
            type: "rule",
            tier: "warm",
            memory_lane: "shared",
            title: "Prefer read for server evidence identity",
            text_summary: "Use read for the server evidence identity task.",
            slots: {
              if: { task_kind: { $eq: "server_evidence_identity" } },
              then: { tool: { prefer: ["read"] } },
              exceptions: [],
              rule_scope: "global",
            },
          },
        ],
      },
    });
    assert.equal(observed.statusCode, 200, observed.body);
    const observedNodes = observed.json().memory_write.nodes as Array<Record<string, unknown>>;
    const memoryNodeId = String(observedNodes.find((entry) => entry.client_id === "memory:server-principal-evidence-identity")?.id ?? "");
    const ruleNodeId = String(observedNodes.find((entry) => entry.client_id === "rule:server-principal-evidence-identity")?.id ?? "");
    assert.ok(memoryNodeId);
    assert.ok(ruleNodeId);
    await stores.liteWriteStore.withTx(() => updateRuleState({
      tenant_id: "tenant-a",
      scope: "tenant-a/default",
      actor: "agent-a",
      rule_node_id: ruleNodeId,
      state: "active",
      input_text: "Activate the server principal evidence identity rule.",
    }, "tenant-a/default", "tenant-a", { liteWriteStore: stores.liteWriteStore }));

    const teamMarker = "SERVER_TEAM_PRINCIPAL_EVIDENCE_IDENTITY_MARKER";
    const teamObserved = await app.inject({
      method: "POST",
      url: "/v1/observe",
      headers: teamHeaders,
      payload: {
        input_text: `${teamMarker} Keep team-owned status summaries auditable and choose read first.`,
        auto_embed: true,
        memory_lane: "shared",
        nodes: [
          {
            client_id: "memory:server-team-principal-evidence-identity",
            type: "concept",
            tier: "warm",
            memory_lane: "shared",
            title: "Server team principal evidence identity memory",
            text_summary: `${teamMarker} Keep team-owned status summaries auditable.`,
            confidence: 0.9,
          },
          {
            client_id: "rule:server-team-principal-evidence-identity",
            type: "rule",
            tier: "warm",
            memory_lane: "shared",
            title: "Prefer read for server team evidence identity",
            text_summary: "Use read for the server team evidence identity task.",
            slots: {
              if: { task_kind: { $eq: "server_evidence_identity" } },
              then: { tool: { prefer: ["read"] } },
              exceptions: [],
              rule_scope: "global",
            },
          },
        ],
      },
    });
    assert.equal(teamObserved.statusCode, 200, teamObserved.body);
    const teamObservedNodes = teamObserved.json().memory_write.nodes as Array<Record<string, unknown>>;
    const teamMemoryNodeId = String(teamObservedNodes.find((entry) => entry.client_id === "memory:server-team-principal-evidence-identity")?.id ?? "");
    const teamRuleNodeId = String(teamObservedNodes.find((entry) => entry.client_id === "rule:server-team-principal-evidence-identity")?.id ?? "");
    assert.ok(teamMemoryNodeId);
    assert.ok(teamRuleNodeId);
    await stores.liteWriteStore.withTx(() => updateRuleState({
      tenant_id: "tenant-a",
      scope: "tenant-a/default",
      actor: "team-c",
      rule_node_id: teamRuleNodeId,
      state: "active",
      input_text: "Activate the server team principal evidence identity rule.",
    }, "tenant-a/default", "tenant-a", { liteWriteStore: stores.liteWriteStore }));

    const guidePayload = {
      query_text: `${marker} audited status summary`,
      run_id: "run:server-principal-evidence-identity",
      consumer_agent_id: "agent-a",
      consumer_team_id: "team-a",
      context: {
        agent_id: "agent-a",
        task_kind: "server_evidence_identity",
        task_signature: "server-evidence-identity",
        goal: "Continue with the authenticated principal's evidence.",
      },
      tool_candidates: ["read", "edit"],
      include_packets: true,
      limit: 8,
    };
    const victimGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      headers: victimHeaders,
      payload: guidePayload,
    });
    assert.equal(victimGuide.statusCode, 200, victimGuide.body);
    const victimGuideBody = victimGuide.json() as Record<string, any>;
    assert.equal(victimGuideBody.consumer_agent_id, "agent-a");
    assert.equal(victimGuideBody.consumer_team_id, "team-a");
    assert.ok(victimGuideBody.agent_context.memory_ids.includes(memoryNodeId));
    assert.ok(victimGuideBody.tool_selection);

    const spoofedGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      headers: attackerHeaders,
      payload: guidePayload,
    });
    assert.equal(spoofedGuide.statusCode, 200, spoofedGuide.body);
    assert.equal(spoofedGuide.json().consumer_agent_id, "agent-b");
    assert.equal(spoofedGuide.json().consumer_team_id, "team-b");

    const teamGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      headers: teamHeaders,
      payload: {
        ...guidePayload,
        query_text: `${teamMarker} audited status summary`,
      },
    });
    assert.equal(teamGuide.statusCode, 200, teamGuide.body);
    const teamGuideBody = teamGuide.json() as Record<string, any>;
    assert.equal(teamGuideBody.consumer_agent_id, "team-c");
    assert.equal(teamGuideBody.consumer_team_id, "team-c");
    assert.ok(teamGuideBody.agent_context.memory_ids.includes(teamMemoryNodeId));
    assert.ok(teamGuideBody.tool_selection);

    const attackerMemoryFeedback = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: attackerHeaders,
      payload: {
        feedback_kind: "memory",
        actor: "agent-a",
        guide_trace_id: victimGuideBody.guide_trace_id,
        used_memory_ids: [memoryNodeId],
        run_id: "run:server-principal-evidence-identity",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "passed",
        tool_status: "succeeded",
        reason: "An attacker must not reuse another principal's guide receipt.",
      },
    });
    assert.equal(attackerMemoryFeedback.statusCode, 400, attackerMemoryFeedback.body);
    assert.equal(attackerMemoryFeedback.json().error, "guide_trace_not_found");

    const attackerToolFeedback = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: attackerHeaders,
      payload: {
        feedback_kind: "tool_selection",
        actor: "agent-a",
        consumer_agent_id: "agent-a",
        consumer_team_id: "team-a",
        guide_trace_id: victimGuideBody.guide_trace_id,
        decision_id: victimGuideBody.tool_selection.decision_id,
        run_id: victimGuideBody.tool_selection.run_id,
        selected_tool: victimGuideBody.tool_selection.selected_tool,
        candidates: victimGuideBody.tool_selection.candidates,
        outcome: "positive",
        context: guidePayload.context,
        input_text: "An attacker must not attribute tool feedback to another principal.",
      },
    });
    assert.equal(attackerToolFeedback.statusCode, 404, attackerToolFeedback.body);
    assert.equal(attackerToolFeedback.json().error, "guide_trace_not_found");

    const victimMemoryFeedback = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: victimHeaders,
      payload: {
        feedback_kind: "memory",
        actor: "agent-b",
        guide_trace_id: victimGuideBody.guide_trace_id,
        used_memory_ids: [memoryNodeId],
        run_id: "run:server-principal-evidence-identity",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "passed",
        tool_status: "succeeded",
        reason: "The authenticated consumer used its own exposed memory.",
      },
    });
    assert.equal(victimMemoryFeedback.statusCode, 200, victimMemoryFeedback.body);

    const victimToolFeedback = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: victimHeaders,
      payload: {
        feedback_kind: "tool_selection",
        actor: "agent-b",
        consumer_agent_id: "agent-b",
        consumer_team_id: "team-b",
        guide_trace_id: victimGuideBody.guide_trace_id,
        decision_id: victimGuideBody.tool_selection.decision_id,
        run_id: victimGuideBody.tool_selection.run_id,
        selected_tool: victimGuideBody.tool_selection.selected_tool,
        candidates: victimGuideBody.tool_selection.candidates,
        outcome: "positive",
        context: guidePayload.context,
        input_text: "The authenticated consumer confirms its own tool selection.",
      },
    });
    assert.equal(victimToolFeedback.statusCode, 200, victimToolFeedback.body);

    const teamMemoryFeedback = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: teamHeaders,
      payload: {
        feedback_kind: "memory",
        actor: "agent-a",
        guide_trace_id: teamGuideBody.guide_trace_id,
        used_memory_ids: [teamMemoryNodeId],
        run_id: "run:server-principal-evidence-identity",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "passed",
        tool_status: "succeeded",
        reason: "A team-only principal can use its own bound guide receipt.",
      },
    });
    assert.equal(teamMemoryFeedback.statusCode, 200, teamMemoryFeedback.body);

    const teamToolFeedback = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: teamHeaders,
      payload: {
        feedback_kind: "tool_selection",
        actor: "agent-a",
        consumer_agent_id: "agent-a",
        consumer_team_id: "team-a",
        guide_trace_id: teamGuideBody.guide_trace_id,
        decision_id: teamGuideBody.tool_selection.decision_id,
        run_id: teamGuideBody.tool_selection.run_id,
        selected_tool: teamGuideBody.tool_selection.selected_tool,
        candidates: teamGuideBody.tool_selection.candidates,
        outcome: "positive",
        context: guidePayload.context,
        input_text: "The team-only principal confirms its own tool selection.",
      },
    });
    assert.equal(teamToolFeedback.statusCode, 200, teamToolFeedback.body);
  } finally {
    await app.close();
    await stores.executionTreeStore.close();
    await stores.executionStateStore.close();
    await stores.liteRecallStore.close();
    await stores.liteReplayStore.close();
    await stores.liteWriteStore.close();
  }
});

test("server lifecycle payload identity cannot override the authenticated principal", async () => {
  const app = Fastify();
  const writePath = tmpDbPath("lifecycle-principal-payload-write");
  const replayPath = tmpDbPath("lifecycle-principal-payload-replay");
  const env = await serverEnv(writePath, replayPath);
  const stores = registerServerProductApp({ app, env, writePath, replayPath });
  const victimHeaders = { "x-api-key": "tenant-a-key" };
  const crossTenantHeaders = { "x-api-key": "tenant-b-key" };
  const victimIdentity = {
    tenant_id: "tenant-a",
    scope: "tenant-a/default",
    actor: "agent-a",
    consumer_agent_id: "agent-a",
    consumer_team_id: "team-a",
  };
  const crossTenantIdentity = {
    tenant_id: "tenant-b",
    scope: "tenant-b/default",
    actor: "agent-b",
    consumer_agent_id: "agent-b",
    consumer_team_id: "team-b",
  };
  try {
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      headers: victimHeaders,
      payload: {
        input_text: "Seed private lifecycle memories for authenticated principal isolation.",
        auto_embed: false,
        memory_lane: "private",
        nodes: [
          {
            client_id: "workflow:server-lifecycle-principal",
            type: "procedure",
            tier: "warm",
            memory_lane: "private",
            memory_kind: "execution_workflow",
            title: "Private authenticated workflow",
            text_summary: "Read the authenticated continuation before making a private change.",
            task_signature: "server-lifecycle-principal",
            workflow_signature: "authenticated-continuation-first",
            next_action: "Read the authenticated continuation.",
            tool_set: ["read", "edit", "test"],
            confidence: 0.9,
          },
          {
            client_id: "memory:server-lifecycle-principal-activate",
            type: "concept",
            tier: "warm",
            memory_lane: "private",
            memory_kind: "general_memory",
            title: "Private activation memory",
            text_summary: "Only the authenticated owner may activate this private memory.",
            confidence: 0.9,
          },
          {
            client_id: "archive:server-lifecycle-principal",
            type: "procedure",
            tier: "archive",
            memory_lane: "private",
            memory_kind: "execution_workflow",
            title: "Private archived workflow",
            text_summary: "Only the authenticated owner may rehydrate this private workflow.",
            confidence: 0.9,
          },
        ],
      },
    });
    assert.equal(observe.statusCode, 200, observe.body);
    const observedNodes = observe.json().memory_write.nodes as Array<Record<string, unknown>>;
    const workflowId = String(observedNodes.find((entry) => entry.client_id === "workflow:server-lifecycle-principal")?.id ?? "");
    const activationId = String(observedNodes.find((entry) => entry.client_id === "memory:server-lifecycle-principal-activate")?.id ?? "");
    const archiveId = String(observedNodes.find((entry) => entry.client_id === "archive:server-lifecycle-principal")?.id ?? "");
    assert.ok(workflowId);
    assert.ok(activationId);
    assert.ok(archiveId);

    const attackerSuppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      headers: crossTenantHeaders,
      payload: {
        operation: "suppress",
        target: "pattern",
        anchor_id: workflowId,
        reason: "A cross-tenant principal must not suppress the victim workflow.",
        payload: { ...victimIdentity, anchor_id: workflowId },
      },
    });
    assert.equal(attackerSuppress.statusCode, 404, attackerSuppress.body);

    const victimSuppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      headers: victimHeaders,
      payload: {
        operation: "suppress",
        target: "pattern",
        actor: "agent-b",
        consumer_agent_id: "agent-b",
        consumer_team_id: "team-b",
        anchor_id: workflowId,
        reason: "The authenticated owner suppresses its private workflow.",
        payload: { ...crossTenantIdentity, anchor_id: workflowId },
      },
    });
    assert.equal(victimSuppress.statusCode, 200, victimSuppress.body);
    assert.equal(victimSuppress.json().result.operator_override.updated_by, "agent-a");
    assert.equal(victimSuppress.json().result.tenant_id, "tenant-a");
    assert.equal(victimSuppress.json().result.scope, "tenant-a/default");

    const attackerUnsuppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      headers: crossTenantHeaders,
      payload: {
        operation: "unsuppress",
        target: "pattern",
        anchor_id: workflowId,
        reason: "A cross-tenant principal must not unsuppress the victim workflow.",
        payload: { ...victimIdentity, anchor_id: workflowId },
      },
    });
    assert.equal(attackerUnsuppress.statusCode, 404, attackerUnsuppress.body);

    const stillSuppressed = await stores.liteWriteStore.findNodes({
      scope: "tenant-a/default",
      id: workflowId,
      consumerAgentId: "agent-a",
      consumerTeamId: "team-a",
      limit: 1,
      offset: 0,
    });
    assert.equal(stillSuppressed.rows[0]?.slots.operator_override_v1.suppressed, true);

    const victimUnsuppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      headers: victimHeaders,
      payload: {
        operation: "unsuppress",
        target: "pattern",
        actor: "agent-b",
        consumer_agent_id: "agent-b",
        consumer_team_id: "team-b",
        anchor_id: workflowId,
        reason: "The authenticated owner restores its private workflow.",
        payload: { ...crossTenantIdentity, anchor_id: workflowId },
      },
    });
    assert.equal(victimUnsuppress.statusCode, 200, victimUnsuppress.body);
    assert.equal(victimUnsuppress.json().result.operator_override.updated_by, "agent-a");

    const attackerActivate = await app.inject({
      method: "POST",
      url: "/v1/forget",
      headers: crossTenantHeaders,
      payload: {
        operation: "activate",
        target: "memory",
        memory_ids: [activationId],
        run_id: "run:cross-tenant-activation",
        outcome: "positive",
        used_surface: "explicit_host_assertion",
        reason: "A cross-tenant principal must not activate the victim memory.",
        payload: { ...victimIdentity, node_ids: [activationId] },
      },
    });
    assert.equal(attackerActivate.statusCode, 200, attackerActivate.body);
    assert.equal(attackerActivate.json().result.activated.updated_nodes, 0);

    const victimActivate = await app.inject({
      method: "POST",
      url: "/v1/forget",
      headers: victimHeaders,
      payload: {
        operation: "activate",
        target: "memory",
        actor: "agent-b",
        consumer_agent_id: "agent-b",
        consumer_team_id: "team-b",
        memory_ids: [activationId],
        run_id: "run:victim-activation",
        outcome: "positive",
        used_surface: "explicit_host_assertion",
        reason: "The authenticated owner activates its private memory.",
        payload: { ...crossTenantIdentity, node_ids: [activationId] },
      },
    });
    assert.equal(victimActivate.statusCode, 200, victimActivate.body);
    assert.equal(victimActivate.json().result.activated.updated_nodes, 1);

    const attackerRehydrate = await app.inject({
      method: "POST",
      url: "/v1/forget",
      headers: crossTenantHeaders,
      payload: {
        operation: "rehydrate",
        target: "archive",
        memory_ids: [archiveId],
        target_tier: "hot",
        reason: "A cross-tenant principal must not rehydrate the victim archive.",
        payload: { ...victimIdentity, node_ids: [archiveId] },
      },
    });
    assert.equal(attackerRehydrate.statusCode, 200, attackerRehydrate.body);
    assert.equal(attackerRehydrate.json().result.rehydrated.moved_nodes, 0);

    const victimRehydrate = await app.inject({
      method: "POST",
      url: "/v1/forget",
      headers: victimHeaders,
      payload: {
        operation: "rehydrate",
        target: "archive",
        actor: "agent-b",
        consumer_agent_id: "agent-b",
        consumer_team_id: "team-b",
        memory_ids: [archiveId],
        target_tier: "hot",
        reason: "The authenticated owner rehydrates its private archive.",
        payload: { ...crossTenantIdentity, node_ids: [archiveId] },
      },
    });
    assert.equal(victimRehydrate.statusCode, 200, victimRehydrate.body);
    assert.equal(victimRehydrate.json().result.rehydrated.moved_nodes, 1);
  } finally {
    await app.close();
    await stores.executionTreeStore.close();
    await stores.executionStateStore.close();
    await stores.liteRecallStore.close();
    await stores.liteReplayStore.close();
    await stores.liteWriteStore.close();
  }
});

test("server memory resolve binds private-memory consumer identity to the principal", async () => {
  const app = Fastify();
  const writePath = tmpDbPath("resolve-principal-identity-write");
  const replayPath = tmpDbPath("resolve-principal-identity-replay");
  const env = await serverEnv(writePath, replayPath);
  const stores = registerServerProductApp({ app, env, writePath, replayPath });
  const victimHeaders = { "x-api-key": "tenant-a-key" };
  const attackerHeaders = { "x-api-key": "tenant-a-attacker-key" };
  try {
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      headers: victimHeaders,
      payload: {
        input_text: "Seed a private memory for resolve principal isolation.",
        auto_embed: false,
        memory_lane: "private",
        memory: {
          client_id: "memory:server-resolve-principal",
          type: "concept",
          tier: "warm",
          memory_lane: "private",
          memory_kind: "general_memory",
          title: "Private resolve memory",
          text_summary: "Only the authenticated owner may resolve this private node.",
          confidence: 0.9,
        },
      },
    });
    assert.equal(observe.statusCode, 200, observe.body);
    const nodeId = String(observe.json().memory_write.nodes[0]?.id ?? "");
    assert.ok(nodeId);
    const uri = buildAionisUri({
      tenant_id: "tenant-a",
      scope: "tenant-a/default",
      type: "concept",
      id: nodeId,
    });

    const spoofed = await app.inject({
      method: "POST",
      url: "/v1/memory/resolve",
      headers: attackerHeaders,
      payload: {
        uri,
        consumer_agent_id: "agent-a",
        consumer_team_id: "team-a",
        include_slots: true,
      },
    });
    assert.equal(spoofed.statusCode, 404, spoofed.body);

    const resolved = await app.inject({
      method: "POST",
      url: "/v1/memory/resolve",
      headers: victimHeaders,
      payload: {
        uri,
        consumer_agent_id: "agent-b",
        consumer_team_id: "team-b",
        include_slots: true,
      },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json().node.id, nodeId);
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

test("Runtime services establish one tenant-scope anchor, replay it, and reject default-tenant drift", async () => {
  const writePath = tmpDbPath("tenant-anchor-services-write");
  const replayPath = tmpDbPath("tenant-anchor-services-replay");
  const tenantAEnv = await serverEnv(writePath, replayPath);
  const first = await createRuntimeServices(createRuntimeConfig(tenantAEnv));
  await closeConstructedRuntimeServices(first);
  const firstRows = await tenantScopeAnchorRows(writePath);
  assert.equal(firstRows.length, 1);
  assert.equal(firstRows[0]?.tenant_id, "tenant-a");

  const reopened = await createRuntimeServices(createRuntimeConfig(tenantAEnv));
  await closeConstructedRuntimeServices(reopened);
  assert.deepEqual(await tenantScopeAnchorRows(writePath), firstRows);

  const tenantBEnv: Env = {
    ...tenantAEnv,
    MEMORY_TENANT_ID: "tenant-b",
    MEMORY_SCOPE: "tenant-b/default",
  };
  await assert.rejects(
    createRuntimeServices(createRuntimeConfig(tenantBEnv)),
    (error: unknown) => {
      assert.ok(error instanceof LiteTenantScopeAuthorityError);
      assert.equal(error.code, "lite_tenant_scope_anchor_mismatch");
      return true;
    },
  );
  assert.deepEqual(await tenantScopeAnchorRows(writePath), firstRows);
});

test("Runtime services keep a legacy unanchored database available without claiming raw scopes", async () => {
  const writePath = tmpDbPath("tenant-anchor-legacy-write");
  const replayPath = tmpDbPath("tenant-anchor-legacy-replay");
  const legacyCommitId = "11111111-1111-4111-8111-111111111111";
  const database = createLiteRuntimeDatabase(writePath);
  try {
    const initializedStore = createLiteWriteStoreFromDatabase(database, {
      annProjectionEnabled: false,
    });
    await initializedStore.close();
    database.db.exec("BEGIN IMMEDIATE");
    try {
      database.db.exec("DROP TABLE lite_runtime_authority_adoption_bindings");
      database.db.exec("DROP TABLE lite_runtime_authority_adoption_manifests");
      const metadata = database.db.prepare(
        `UPDATE lite_runtime_schema_metadata
         SET version = 5, updated_at = ?
         WHERE component = 'write_projection'`,
      ).run("2026-07-18T00:00:00.000Z");
      assert.equal(Number(metadata.changes), 1);
      database.db.prepare(
        `INSERT INTO lite_memory_commits
          (id, scope, parent_commit_id, input_sha256, diff_json, actor,
           model_version, prompt_version, commit_hash, created_at,
           digest_version, revision, mutation_digest, legacy_anchor_commit_id)
         VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, 1, NULL, NULL, NULL)`,
      ).run(
        legacyCommitId,
        "legacy-unprefixed-scope",
        "1".repeat(64),
        "{}",
        "legacy-memory-writer",
        "2".repeat(64),
        "2026-07-18T00:00:01.000Z",
      );
      database.db.exec("COMMIT");
    } catch (error) {
      database.db.exec("ROLLBACK");
      throw error;
    }
    const historicalVersion = database.db.prepare(
      `SELECT version FROM lite_runtime_schema_metadata
       WHERE component = 'write_projection'`,
    ).get() as { version: number } | undefined;
    assert.equal(historicalVersion?.version, 5);
  } finally {
    await database.close();
  }

  const env = await serverEnv(writePath, replayPath);
  const services = await createRuntimeServices(createRuntimeConfig(env));
  try {
    assert.ok(services.liteWriteStore);
    const migrated = createLiteRuntimeDatabase(writePath);
    try {
      const migratedVersion = migrated.db.prepare(
        `SELECT version FROM lite_runtime_schema_metadata
         WHERE component = 'write_projection'`,
      ).get() as { version: number } | undefined;
      assert.equal(migratedVersion?.version, 6);
      const migratedLegacyCommit = migrated.db.prepare(
        `SELECT scope, digest_version FROM lite_memory_commits
         WHERE id = ?`,
      ).get(legacyCommitId) as { scope: string; digest_version: number } | undefined;
      assert.equal(migratedLegacyCommit?.scope, "legacy-unprefixed-scope");
      assert.equal(migratedLegacyCommit?.digest_version, 1);
    } finally {
      await migrated.close();
    }
    assert.deepEqual(await tenantScopeAnchorRows(writePath), []);
  } finally {
    await closeConstructedRuntimeServices(services);
  }
  assert.deepEqual(await tenantScopeAnchorRows(writePath), []);
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
