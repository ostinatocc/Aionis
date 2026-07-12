import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { z } from "zod";
import { createRequestGuards } from "./support/create-request-guards-test-config.ts";
import {
  ProductGuideRequest,
  ProductObserveRequest,
  parseGuideExposureLedger,
} from "../../src/product/product-services.ts";
import { createProductObserveService } from "../../src/product/observe-service.ts";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import {
  createRuntimeProductServices,
  registerRuntimeErrorHandler,
} from "../../src/server/http-server.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRODUCT_DIR = path.join(ROOT, "src", "product");

test("product services own product orchestration without Fastify coupling", () => {
  const serviceFiles = [
    "observe-service.ts",
    "guide-service.ts",
    "lifecycle-service.ts",
    "measure-service.ts",
    "tool-feedback-service.ts",
    "product-services.ts",
  ];
  for (const fileName of serviceFiles) {
    const sourcePath = path.join(PRODUCT_DIR, fileName);
    assert.equal(fs.existsSync(sourcePath), true, `${fileName} must exist`);
    const source = fs.readFileSync(sourcePath, "utf8");
    assert.doesNotMatch(source, /from ["']fastify["']/);
    assert.doesNotMatch(source, /\bFastify(?:Request|Reply|Instance)\b/);
    assert.doesNotMatch(source, /\bapp\.inject\b/);
  }
});

test("Product Facade is a narrow HTTP adapter", () => {
  const facadePath = path.join(ROOT, "src", "routes", "product-facade.ts");
  const facade = fs.readFileSync(facadePath, "utf8");
  assert.equal(
    facade.split(/\r?\n/).length <= 800,
    true,
    "product-facade.ts must remain a <=800-line HTTP adapter",
  );
  assert.doesNotMatch(facade, /\bapp\.inject\b/);
  for (const privateImplementation of [
    "buildProductGuideStructuredExecutionPacket",
    "mergeAionisMemoryPackets",
    "productMeasureInputs",
    "productForgetPayload",
    "writeProductObserveClaims",
  ]) {
    assert.doesNotMatch(facade, new RegExp(`\\bfunction\\s+${privateImplementation}\\b`));
  }
});

test("legacy guide exposure mirrors are untrusted while current internal ledgers remain parseable", () => {
  const legacy = {
    contract_version: "aionis_guide_exposure_v1",
    guide_trace_id: "guide_trace:legacy-ledger",
    tenant_id: "default",
    scope: "default",
    run_id: "run:legacy-ledger",
    consumer_agent_id: "local-user",
    consumer_team_id: null,
    query_sha256: "a".repeat(64),
    context_sha256: "b".repeat(64),
    memory_ids: [],
    use_now_memory_ids: [],
    inspect_before_use_memory_ids: [],
    do_not_use_memory_ids: [],
    rehydrate_memory_ids: [],
    prompt_char_count: 0,
    history_used: false,
    actionable_history_used: false,
    recommended_posture: "ignore_history",
    authority: "none",
  };

  assert.equal(parseGuideExposureLedger(legacy), null);
  const ledger = parseGuideExposureLedger({
    ...legacy,
    task_binding_sha256: "c".repeat(64),
    tool_selection: null,
    runtime_verification_v1: null,
    effect_observation_v1: null,
    effect_observation_sha256: null,
  });
  assert.ok(ledger);
  assert.equal(ledger.tool_selection, null);
});

test("observe preserves dependency payload validation as invalid_request", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-observe-zod-dependency-"));
  const writeStore = createLiteWriteStore(path.join(directory, "runtime.sqlite"));
  try {
    const observe = createProductObserveService({
      defaultTenantId: "default",
      defaultScope: "default",
      atomicWrite: writeStore,
      claimLedgerAccess: null,
      handoffStore: null,
      memoryWrite: {
        transactionRunner: () => writeStore.transactionRunner(),
        async prepare() {
          throw new z.ZodError([{
            code: "custom",
            path: ["nodes"],
            message: "invalid memory write payload",
          }]);
        },
      } as any,
    });
    const result = await observe.execute(ProductObserveRequest.parse({
      tenant_id: "default",
      scope: "default",
      input_text: "trigger dependency payload validation",
    }), { principal: null });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.equal((result.body as { error?: string }).error, "invalid_request");
  } finally {
    await writeStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("guide keeps semantic success when post-commit memory finalization fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-guide-post-commit-"));
  const store = createLiteWriteStore(path.join(directory, "runtime.sqlite"));
  const env = parityEnv();
  const memoryWriteService = createMemoryWriteRouteService({
    env,
    embedder: null,
    liteWriteStore: store,
    executionStateStore: null,
    executionTreeStore: null,
  });
  const services = createRuntimeProductServices({
    env,
    liteWriteStore: store,
    executionTreeStore: null,
    memoryWriteService,
    handoffRouteService: null,
  });
  let finalizeCalled = false;
  memoryWriteService.finalize = async () => {
    finalizeCalled = true;
    throw new Error("injected guide post-commit finalization failure");
  };
  try {
    const result = await services.guide.execute(ProductGuideRequest.parse({
      tenant_id: "default",
      scope: "default",
      query_text: "Return a guide while preserving its committed exposure ledger.",
      consumer_agent_id: "local-user",
    }), {
      async planningContext() {
        return { tenant_id: "default", scope: "default", recall: {} };
      },
      applyIdentity(input) {
        return input;
      },
    });
    assert.equal(finalizeCalled, true);
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    const receipts = await store.listProductGuideReceipts({
      tenantId: "default",
      scope: "default",
      limit: 10,
    });
    assert.equal(receipts.length, 1);
    const mirrored = await store.findNodes({
      scope: "default",
      type: "evidence",
      operatorView: true,
      limit: 10,
      offset: 0,
    });
    assert.equal(mirrored.rows.length, 1);
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function parityEnv() {
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
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
  } as any;
}

function normalizeObserveParity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeObserveParity);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["commit_id", "commit_uri", "commit_hash"].includes(key))
      .map(([key, child]) => [key, normalizeObserveParity(child)]),
  );
}

test("direct observe service and HTTP facade are equivalent on the same SQLite store", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-product-services-"));
  const store = createLiteWriteStore(path.join(directory, "runtime.sqlite"));
  const env = parityEnv();
  const app = Fastify();
  const guards = createRequestGuards({
    env,
    embedder: null,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 4, maxQueue: 4, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 4, maxQueue: 4, queueTimeoutMs: 100 }),
  });
  const memoryWriteService = createMemoryWriteRouteService({
    env,
    embedder: null,
    liteWriteStore: store,
    executionStateStore: null,
    executionTreeStore: null,
  });
  const services = createRuntimeProductServices({
    env,
    liteWriteStore: store,
    executionTreeStore: null,
    memoryWriteService,
    handoffRouteService: null,
  });
  registerRuntimeErrorHandler(app);
  registerProductFacadeRoutes({
    app,
    services,
    planningContextService: null,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });

  const input = ProductObserveRequest.parse({
    operation_id: "product-services-http-parity",
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    memory_lane: "private",
    producer_agent_id: "local-user",
    owner_agent_id: "local-user",
    input_text: "Service and HTTP parity evidence",
    auto_embed: false,
    distill: { enabled: false },
    nodes: [{
      client_id: "product-services-parity-node",
      type: "evidence",
      title: "Product service parity",
      text_summary: "The direct service and HTTP adapter preserve one product contract.",
      slots: { parity: true },
    }],
  });

  try {
    const direct = await services.observe.execute(input, { principal: null });
    const http = await app.inject({ method: "POST", url: "/v1/observe", payload: input });
    assert.equal(direct.ok, true);
    assert.equal(direct.statusCode, 200);
    assert.equal(http.statusCode, 200, http.body);
    assert.deepEqual(normalizeObserveParity(http.json()), normalizeObserveParity(direct.body));
  } finally {
    await app.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
