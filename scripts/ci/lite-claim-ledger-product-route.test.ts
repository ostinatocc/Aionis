import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { createRuntimeServices } from "../../src/app/runtime-services.ts";
import { loadEnv, type Env } from "../../src/config.ts";
import { registerHandoffRoutes } from "../../src/routes/handoff.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { registerMemoryFeedbackToolRoutes } from "../../src/routes/memory-feedback-tools.ts";
import { registerLiteMemoryLifecycleRoutes } from "../../src/routes/memory-lifecycle-lite.ts";
import { registerMemoryWriteRoutes } from "../../src/routes/memory-write.ts";
import { createHttpApp, registerBootstrapLifecycle } from "../../src/server/bootstrap.ts";
import { registerHealthRoute, registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claim-ledger-product-"));
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

async function liteEnv(writePath: string, replayPath: string): Promise<Env> {
  return withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      MEMORY_AUTH_MODE: "off",
      MEMORY_TENANT_ID: "claim-ledger-tenant",
      MEMORY_SCOPE: "claim-ledger/default",
      LITE_LOCAL_ACTOR_ID: "claim-ledger-local",
      LITE_WRITE_SQLITE_PATH: writePath,
      LITE_REPLAY_SQLITE_PATH: replayPath,
      SANDBOX_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: "false",
    },
    () => loadEnv(),
  );
}

async function setupClaimLedgerProductApp(args: {
  productGuardOverrides?: {
    enforceRateLimit?: (...args: any[]) => Promise<void>;
    enforceTenantQuota?: (...args: any[]) => Promise<void>;
    acquireInflightSlot?: (...args: any[]) => Promise<{ release: () => void }>;
  };
} = {}) {
  const writePath = tmpDbPath("product-write");
  const replayPath = tmpDbPath("product-replay");
  const env = await liteEnv(writePath, replayPath);
  const services = await createRuntimeServices(env);
  const app = createHttpApp(env);
  const guards = createRequestGuards({
    env,
    embedder: services.queryEmbedder,
    recallLimiter: services.recallLimiter,
    debugEmbedLimiter: services.debugEmbedLimiter,
    writeLimiter: services.writeLimiter,
    recallTextEmbedLimiter: services.recallTextEmbedLimiter,
    recallInflightGate: services.recallInflightGate,
    writeInflightGate: services.writeInflightGate,
  });
  registerRuntimeErrorHandler(app);
  registerMemoryWriteRoutes({
    app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: services.liteWriteStore,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    executionStateStore: services.executionStateStore,
  });
  registerHandoffRoutes({
    app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: services.liteWriteStore,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest as any,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    executionStateStore: services.executionStateStore,
  });
  registerMemoryAccessRoutes({
    app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: services.liteWriteStore,
    liteRecallAccess: services.liteRecallStore.createRecallAccess(),
    executionStateStore: services.executionStateStore,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest as any,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
  registerMemoryContextRuntimeRoutes({
    app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: services.liteWriteStore,
    liteRecallAccess: services.liteRecallStore.createRecallAccess(),
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
  });
  registerLiteMemoryLifecycleRoutes({
    app,
    env,
    liteWriteStore: services.liteWriteStore,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest as any,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
  registerMemoryFeedbackToolRoutes({
    app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: services.liteWriteStore,
    liteRecallAccess: services.liteRecallStore.createRecallAccess(),
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest as any,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
  registerProductFacadeRoutes({
    app,
    env,
    liteWriteStore: services.liteWriteStore,
    claimLedgerAccess: services.claimLedgerAccess,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: args.productGuardOverrides?.enforceRateLimit ?? guards.enforceRateLimit,
    enforceTenantQuota: args.productGuardOverrides?.enforceTenantQuota ?? guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: args.productGuardOverrides?.acquireInflightSlot ?? guards.acquireInflightSlot,
  });
  registerBootstrapLifecycle({
    app,
    store: services.store,
    sandboxExecutor: services.sandboxExecutor,
    liteRecallStore: services.liteRecallStore,
    liteReplayStore: services.liteReplayStore,
    liteWriteStore: services.liteWriteStore,
    liteClaimLedgerStore: services.liteClaimLedgerStore,
    executionStateStore: services.executionStateStore,
    executionTreeStore: services.executionTreeStore,
  });
  return { app, env, services };
}

test("claim ledger is wired into Runtime services and health", async () => {
  const writePath = tmpDbPath("write");
  const replayPath = tmpDbPath("replay");
  const env = await liteEnv(writePath, replayPath);
  const services = await createRuntimeServices(env);
  const app = createHttpApp(env);
  registerRuntimeErrorHandler(app);
  registerHealthRoute({
    app,
    env,
    liteReplayStore: services.liteReplayStore,
    liteRecallStore: services.liteRecallStore,
    liteWriteStore: services.liteWriteStore,
    liteClaimLedgerStore: services.liteClaimLedgerStore,
    executionStateStore: services.executionStateStore,
    executionTreeStore: services.executionTreeStore,
    sandboxExecutor: services.sandboxExecutor,
    sandboxTenantBudgetPolicy: services.sandboxTenantBudgetPolicy,
    sandboxRemoteAllowedCidrs: services.sandboxRemoteAllowedCidrs,
  });
  registerBootstrapLifecycle({
    app,
    store: services.store,
    sandboxExecutor: services.sandboxExecutor,
    liteRecallStore: services.liteRecallStore,
    liteReplayStore: services.liteReplayStore,
    liteWriteStore: services.liteWriteStore,
    liteClaimLedgerStore: services.liteClaimLedgerStore,
    executionStateStore: services.executionStateStore,
    executionTreeStore: services.executionTreeStore,
  });

  try {
    const claim = await services.claimLedgerAccess.writeClaim({
      scope: env.MEMORY_SCOPE,
      tenantId: env.MEMORY_TENANT_ID,
      now: "2026-06-17T01:00:00.000Z",
      claim: {
        contract_version: "aionis_claim_write_v1",
        client_id: "claim:runtime:wiring:status",
        subject_key: "project:aionis",
        predicate: "claim_ledger_runtime_status",
        slot_key: "project:aionis.claim_ledger_runtime_status",
        value: { status: "wired" },
        value_text: "wired",
        claim_kind: "ordinary_fact",
        conflict_policy: "singleton_latest",
        authority: "advisory",
        confidence: 0.9,
        evidence_refs: ["runtime://claim-ledger/wiring-test"],
      },
    });

    const live = await services.claimLedgerAccess.findLiveClaims({
      scope: env.MEMORY_SCOPE,
      slotKey: "project:aionis.claim_ledger_runtime_status",
      limit: 10,
    });
    assert.deepEqual(live.rows.map((row) => row.claim_id), [claim.claim_id]);

    const ready = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(ready.statusCode, 200, ready.body);
    const readyBody = ready.json() as Record<string, any>;
    assert.equal(readyBody.checks.claim_ledger_store, true);

    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200, health.body);
    const healthBody = health.json() as Record<string, any>;
    assert.equal(healthBody.lite.stores.claim_ledger.mode, "sqlite_claim_ledger_v1");
    assert.equal(healthBody.lite.stores.claim_ledger.path_configured, true);
  } finally {
    await app.close();
  }
});

test("product observe persists explicit claim ledger claims without requiring memory or handoff", async () => {
  const { app, env, services } = await setupClaimLedgerProductApp();
  try {
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        claims: [{
          contract_version: "aionis_claim_write_v1",
          client_id: "claim-location-current",
          subject_key: "user:self",
          predicate: "current_location",
          value: { city: "Shanghai" },
          value_text: "User current location is Shanghai.",
          slot_key: "user:self.current_location",
          conflict_policy: "singleton_latest",
          claim_kind: "ordinary_fact",
          authority: "advisory",
          confidence: 0.9,
          evidence_refs: ["observe://claim-location-current"],
        }],
      },
    });

    assert.equal(observe.statusCode, 200, observe.body);
    const body = observe.json() as Record<string, any>;
    assert.equal(body.contract_version, "aionis_observe_result_v1");
    assert.equal(body.tenant_id, env.MEMORY_TENANT_ID);
    assert.equal(body.scope, env.MEMORY_SCOPE);
    assert.equal(body.observed.memory_written, false);
    assert.equal(body.observed.handoff_stored, false);
    assert.equal(body.observed.claim_count, 1);
    assert.equal(body.claim_ledger.contract_version, "aionis_claim_observe_receipt_v1");
    assert.equal(body.claim_ledger.written_count, 1);
    assert.deepEqual(body.claim_ledger.superseded_claim_ids, []);
    assert.deepEqual(body.claim_ledger.contested_claim_ids, []);
    assert.equal(body.claim_ledger.agent_prompt_included, false);
    assert.equal(body.claim_ledger.runtime_mutation, true);
    assert.deepEqual(body.source_map.internal_surfaces_used, ["claim_ledger_write"]);

    const claim = await services.claimLedgerAccess.getClaim({
      scope: env.MEMORY_SCOPE,
      claimId: body.claim_ledger.claim_ids[0],
    });
    assert.equal(claim?.value_text, "User current location is Shanghai.");
    assert.equal(claim?.source_memory_id, null);
  } finally {
    await app.close();
  }
});

test("product observe claim-only writes use write limiter and inflight gate", async () => {
  const calls: string[] = [];
  const { app } = await setupClaimLedgerProductApp({
    productGuardOverrides: {
      enforceRateLimit: async (_req, _reply, kind) => {
        calls.push(`rate:${kind}`);
      },
      enforceTenantQuota: async (_req, _reply, kind) => {
        calls.push(`quota:${kind}`);
      },
      acquireInflightSlot: async (kind) => {
        calls.push(`gate:${kind}`);
        return {
          release: () => calls.push(`release:${kind}`),
        };
      },
    },
  });
  try {
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        claims: [{
          contract_version: "aionis_claim_write_v1",
          client_id: "claim-only-rate-gate",
          subject_key: "user:self",
          predicate: "timezone",
          value: { name: "Asia/Shanghai" },
          value_text: "User timezone is Asia/Shanghai.",
          slot_key: "user:self.timezone",
          conflict_policy: "singleton_latest",
          claim_kind: "ordinary_fact",
          authority: "advisory",
          confidence: 0.9,
          evidence_refs: ["observe://claim-only-rate-gate"],
        }],
      },
    });

    assert.equal(observe.statusCode, 200, observe.body);
    assert.deepEqual(calls, ["gate:write", "rate:write", "quota:write", "release:write"]);
  } finally {
    await app.close();
  }
});

test("product observe claim receipt reports superseded and contested claim ids", async () => {
  const { app } = await setupClaimLedgerProductApp();
  try {
    const oldObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        claims: [{
          contract_version: "aionis_claim_write_v1",
          client_id: "claim-location-old",
          subject_key: "user:self",
          predicate: "current_location",
          value: { city: "Beijing" },
          value_text: "User current location is Beijing.",
          slot_key: "user:self.current_location",
          conflict_policy: "singleton_latest",
          claim_kind: "ordinary_fact",
          authority: "advisory",
          confidence: 0.8,
          evidence_refs: ["observe://claim-location-old"],
        }],
      },
    });
    assert.equal(oldObserve.statusCode, 200, oldObserve.body);
    const oldClaimId = oldObserve.json().claim_ledger.claim_ids[0];

    const currentObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        claims: [
          {
            contract_version: "aionis_claim_write_v1",
            client_id: "claim-location-new",
            subject_key: "user:self",
            predicate: "current_location",
            value: { city: "Shanghai" },
            value_text: "User current location is Shanghai.",
            slot_key: "user:self.current_location",
            conflict_policy: "singleton_latest",
            claim_kind: "ordinary_fact",
            authority: "advisory",
            confidence: 0.9,
            evidence_refs: ["observe://claim-location-new"],
          },
          {
            contract_version: "aionis_claim_write_v1",
            client_id: "claim-location-unverified",
            subject_key: "user:self",
            predicate: "possible_location",
            value: { city: "Suzhou" },
            value_text: "User may sometimes work from Suzhou.",
            slot_key: "user:self.possible_location",
            conflict_policy: "manual_or_inspect",
            claim_kind: "ordinary_fact",
            authority: "advisory",
            confidence: 0.4,
            evidence_refs: ["observe://claim-location-unverified"],
          },
        ],
      },
    });

    assert.equal(currentObserve.statusCode, 200, currentObserve.body);
    const receipt = currentObserve.json().claim_ledger;
    assert.equal(receipt.written_count, 2);
    assert.deepEqual(receipt.superseded_claim_ids, [oldClaimId]);
    assert.equal(receipt.contested_claim_ids.length, 1);
    assert.ok(receipt.claim_ids.includes(receipt.contested_claim_ids[0]));
  } finally {
    await app.close();
  }
});

test("claim ledger projection is compiled into guide context without polluting memory attribution ids", async () => {
  const { app } = await setupClaimLedgerProductApp();
  try {
    const oldObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        claims: [{
          contract_version: "aionis_claim_write_v1",
          client_id: "claim-checkout-old-target",
          subject_key: "project:checkout",
          predicate: "active_execution_target",
          value: { target: "src/legacyCheckout.ts" },
          value_text: "The old active checkout target was src/legacyCheckout.ts.",
          slot_key: "project:checkout.active_execution_target",
          conflict_policy: "singleton_latest",
          claim_kind: "execution_fact",
          authority: "advisory",
          confidence: 0.72,
          evidence_refs: ["run:checkout-001"],
        }],
      },
    });
    assert.equal(oldObserve.statusCode, 200, oldObserve.body);
    const oldClaimId = oldObserve.json().claim_ledger.claim_ids[0];

    const currentObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        claims: [{
          contract_version: "aionis_claim_write_v1",
          client_id: "claim-checkout-current-target",
          subject_key: "project:checkout",
          predicate: "active_execution_target",
          value: { target: "src/checkoutAdapter.ts" },
          value_text: "The current accepted checkout target is src/checkoutAdapter.ts.",
          slot_key: "project:checkout.active_execution_target",
          conflict_policy: "singleton_latest",
          claim_kind: "execution_fact",
          authority: "trusted",
          confidence: 0.94,
          evidence_refs: ["run:checkout-002", "review:accepted"],
        }],
      },
    });
    assert.equal(currentObserve.statusCode, 200, currentObserve.body);
    const currentBody = currentObserve.json() as Record<string, any>;
    const currentClaimId = currentBody.claim_ledger.claim_ids[0];
    assert.deepEqual(currentBody.claim_ledger.superseded_claim_ids, [oldClaimId]);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        query_text: "Continue the checkout adapter migration.",
        scope: "claim-ledger/default",
        context_char_budget: 4096,
      },
    });
    assert.equal(guide.statusCode, 200, guide.body);
    const body = guide.json() as Record<string, any>;
    assert.equal(body.claim_ledger_projection.contract_version, "aionis_claim_ledger_projection_v1");
    assert.equal(body.claim_ledger_projection.runtime_mutation, false);
    assert.equal(body.claim_ledger_projection.agent_prompt_included, false);
    assert.equal(body.claim_ledger_projection.use_now[0].claim_id, currentClaimId);
    assert.equal(body.claim_ledger_projection.do_not_use[0].claim_id, oldClaimId);
    assert.ok(body.agent_context.use_now.some((line: string) =>
      line.includes(currentClaimId) && line.includes("src/checkoutAdapter.ts"),
    ));
    assert.ok(body.agent_context.do_not_use.some((line: string) =>
      line.includes(oldClaimId) && line.includes("src/legacyCheckout.ts"),
    ));
    assert.ok(body.agent_context.prompt_text.includes("Claim ledger use_now"));
    assert.ok(body.agent_context.prompt_text.includes("Claim ledger do_not_use"));
    assert.equal(body.agent_context.memory_ids.includes(currentClaimId), false);
    assert.equal(body.agent_context.use_now_memory_ids.includes(currentClaimId), false);
    assert.equal(body.agent_context.do_not_use_memory_ids.includes(oldClaimId), false);
    assert.ok(body.source_map.internal_surfaces_used.includes("claim_ledger_projection"));
    assert.ok(body.source_map.internal_surfaces_used.includes("claim_ledger_agent_context_projection"));
  } finally {
    await app.close();
  }
});

test("product observe rejects invalid explicit claims with standard error shape", async () => {
  const { app } = await setupClaimLedgerProductApp();
  try {
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        claims: [{
          contract_version: "aionis_claim_write_v1",
          client_id: "claim-trusted-without-evidence",
          subject_key: "user:self",
          predicate: "current_location",
          value: { city: "Shanghai" },
          value_text: "User current location is Shanghai.",
          slot_key: "user:self.current_location",
          conflict_policy: "singleton_latest",
          claim_kind: "ordinary_fact",
          authority: "trusted",
          confidence: 0.9,
          evidence_refs: [],
        }],
      },
    });

    assert.equal(observe.statusCode, 400, observe.body);
    const body = observe.json() as Record<string, any>;
    assert.equal(body.status, 400);
    assert.equal(body.error, "invalid_request");
    assert.equal(body.details.contract, "error_v1");
    assert.ok(body.issues.some((issue: Record<string, unknown>) =>
      String(issue.path).includes("claims.0.evidence_refs")
      && issue.message === "trusted claims require evidence_refs",
    ));
  } finally {
    await app.close();
  }
});
