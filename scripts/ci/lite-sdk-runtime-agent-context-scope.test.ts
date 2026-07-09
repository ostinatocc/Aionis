import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { createAionisClient } from "../../src/sdk.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-sdk-runtime-context-"));
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

function registerSdkRuntimeProductApp(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  guards: ReturnType<typeof requestGuards>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
}) {
  registerRuntimeErrorHandler(args.app);
  const contextRuntimeRoutes = registerMemoryContextRuntimeRoutes({
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

  registerProductFacadeRoutes({
    app: args.app,
    env: args.env,
    liteWriteStore: args.liteWriteStore,
    memoryWriteService: createMemoryWriteRouteService({
      env: args.env,
      embedder: DeterministicEmbeddingProvider,
      liteWriteStore: args.liteWriteStore,
      executionStateStore: null,
    }),
    planningContextService: contextRuntimeRoutes.planningContextService,
    handoffRouteService: null,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
}

async function listenLocal(app: ReturnType<typeof Fastify>): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("SDK guideAgentContext over real Runtime HTTP promotes accepted same-workflow execution memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env);
  const dbPath = tmpDbPath("sdk-runtime-agent-context-scope");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerSdkRuntimeProductApp({ app, env, guards, liteWriteStore, liteRecallStore });
    const baseUrl = await listenLocal(app);
    const client = createAionisClient({
      baseUrl,
      tenant_id: "default",
      scope: "default",
    });
    const workflowSignature = "sdk-shared-workflow";
    const currentTaskSignature = "sdk-current-task";
    const otherTaskSignature = "sdk-other-task";

    await client.execution.observeStep({
      agent_id: "sdk-agent",
      role: "worker",
      run_id: "run-sdk-current",
      task_id: "task-current",
      task_signature: currentTaskSignature,
      workflow_signature: workflowSignature,
      title: "SDK current task accepted path",
      summary: "SDK_CURRENT_TASK_ONLY accepted implementation path in src/current.ts.",
      outcome: "succeeded",
      target_files: ["src/current.ts"],
      tool_set: ["edit", "test"],
      continuation_hint: "Continue SDK_CURRENT_TASK_ONLY through src/current.ts.",
      auto_embed: false,
      memory_lane: "private",
      slots: {
        contract_trust: "advisory",
      },
    });

    await client.execution.observeStep({
      agent_id: "sdk-agent",
      role: "worker",
      run_id: "run-sdk-other",
      task_id: "task-other",
      task_signature: otherTaskSignature,
      workflow_signature: workflowSignature,
      title: "SDK other task accepted path",
      summary: "SDK_OTHER_TASK_SUCCESS accepted implementation path from another task in src/other.ts.",
      outcome: "succeeded",
      target_files: ["src/other.ts"],
      tool_set: ["edit", "test"],
      continuation_hint: "Continue SDK_OTHER_TASK_SUCCESS when the workflow signature matches.",
      auto_embed: false,
      memory_lane: "private",
      slots: {
        contract_trust: "advisory",
      },
    });

    const result = await client.execution.guideAgentContextForRole<Record<string, any>>({
      agent_id: "sdk-agent",
      role: "worker",
      run_id: "run-sdk-current-guide",
      task_id: "task-current",
      task_signature: currentTaskSignature,
      workflow_signature: workflowSignature,
      query_text: "Continue the SDK current task using exact task and accepted same-workflow execution memory.",
      context_mode: "compact_agent",
      include_packets: true,
      limit: 10,
    }, undefined, {
      max_prompt_chars: 20_000,
      include_inspect_before_use: false,
      include_rehydrate: false,
    });

    assert.equal(result.contract_version, "aionis_sdk_agent_context_with_evidence_v1");
    assert.match(result.agent_prompt, /AIONIS_EXECUTION_AGENT_CONTEXT v1/);
    assert.doesNotMatch(result.agent_prompt, /AIONIS_AGENT_CONTEXT v1/);
    assert.doesNotMatch(result.agent_prompt, /AIONIS_CTX v2/);
    assert.match(result.agent_prompt, /SDK_CURRENT_TASK_ONLY/);
    assert.match(result.agent_prompt, /SDK_OTHER_TASK_SUCCESS/);
    assert.equal(result.resolved_evidence.length, 0);

    const guide = result.guide as Record<string, any>;
    const packetMemories = guide.memory_packet?.relevant_memories ?? [];
    assert.equal(
      packetMemories.some((entry: Record<string, unknown>) => String(entry.summary).includes("SDK_OTHER_TASK_SUCCESS")),
      true,
    );
    assert.equal(
      packetMemories.some((entry: Record<string, unknown>) => String(entry.summary).includes("SDK_CURRENT_TASK_ONLY")),
      true,
    );

    const agentContext = result.agent_context as Record<string, any>;
    assert.equal(
      (agentContext.use_now ?? []).some((entry: string) => entry.includes("SDK_CURRENT_TASK_ONLY")),
      true,
    );
    assert.equal(
      (agentContext.use_now ?? []).some((entry: string) => entry.includes("SDK_OTHER_TASK_SUCCESS")),
      true,
    );
    assert.equal(
      (agentContext.inspect_before_use ?? []).some((entry: string) => entry.includes("SDK_OTHER_TASK_SUCCESS")),
      false,
    );
    assert.equal(
      (agentContext.command_posture ?? []).some((entry: Record<string, unknown>) =>
        entry.posture === "should_continue"
        && Array.isArray(entry.target_files)
        && entry.target_files.includes("src/other.ts")
      ),
      true,
    );
    assert.equal(
      (agentContext.route_contract?.active_targets ?? []).some((entry: Record<string, unknown>) =>
        entry.target === "src/other.ts"
      ),
      true,
    );
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});
