import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerMemoryRecallRoutes } from "../../src/routes/memory-recall.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { HttpError } from "../../src/util/http.ts";

test("memory recall enforces base rate limit before identity defaults and schema parse", async () => {
  const app = Fastify();
  const calls: string[] = [];
  registerRuntimeErrorHandler(app);
  registerMemoryRecallRoutes({
    app,
    env: {
      AIONIS_EDITION: "lite",
      MEMORY_SCOPE: "default",
      MEMORY_TENANT_ID: "default",
      MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: true,
      RECALL_ENGINE_MODE: "semantic_scan",
      MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
    } as any,
    liteRecallAccess: {} as any,
    liteWriteStore: {
      listRuleCandidates: async () => [],
    } as any,
    requireMemoryPrincipal: async () => {
      calls.push("principal");
      return null;
    },
    withIdentityFromRequest: () => {
      calls.push("identity");
      return {};
    },
    enforceRateLimit: async (_req, _reply, kind) => {
      calls.push(`rate:${kind}`);
      throw new HttpError(429, "rate_limited_recall", "recall rate limit exceeded");
    },
    enforceTenantQuota: async () => {
      calls.push("quota");
    },
    tenantFromBody: () => {
      calls.push("tenant");
      return "default";
    },
    acquireInflightSlot: async () => {
      calls.push("gate");
      return { wait_ms: 0, release: () => undefined };
    },
    hasExplicitRecallKnobs: () => {
      calls.push("knobs");
      return false;
    },
    resolveRecallProfile: () => {
      calls.push("profile");
      return { profile: "balanced", source: "test" };
    },
    resolveExplicitRecallMode: () => {
      calls.push("mode");
      return {
        mode: null,
        profile: "balanced",
        defaults: {},
        applied: false,
        reason: "test",
        source: "test",
      };
    },
    withRecallProfileDefaults: () => {
      calls.push("defaults");
      return {};
    },
    resolveRecallStrategy: () => {
      calls.push("strategy");
      return { strategy: "semantic", defaults: {}, applied: false };
    },
    resolveAdaptiveRecallProfile: () => {
      calls.push("adaptive");
      return { profile: "balanced", defaults: {}, applied: false, reason: "test" };
    },
    resolveAdaptiveRecallHardCap: () => {
      calls.push("hard_cap");
      return { defaults: {}, applied: false, reason: "test" };
    },
    inferRecallStrategyFromKnobs: () => "semantic",
    buildRecallTrajectory: () => ({}),
    buildRecallAuth: () => ({ allow_embeddings: false }),
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/recall",
      body: {
        limit: "invalid-limit-that-would-fail-zod",
        return_debug: true,
        include_embeddings: true,
      },
    });

    assert.equal(response.statusCode, 429);
    assert.deepEqual(calls, ["principal", "rate:recall"]);
    assert.equal(JSON.parse(response.body).error, "rate_limited_recall");
  } finally {
    await app.close();
  }
});
