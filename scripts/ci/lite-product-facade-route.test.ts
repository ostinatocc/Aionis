import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

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
  } as any;
}

function requestGuards(env: ReturnType<typeof liteEnv>) {
  return createRequestGuards({
    env,
    embedder: null,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });
}

test("product measure facade returns a product effect report without external eval runners", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env);
  try {
    registerRuntimeErrorHandler(app);
    registerProductFacadeRoutes({
      app,
      env,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

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
